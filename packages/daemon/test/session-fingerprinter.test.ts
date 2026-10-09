import { describe, it, expect, vi } from "vitest";
import { SessionFingerprinter } from "../src/domain/session-fingerprinter.js";
import type { CmuxAdapter } from "../src/adapters/cmux.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ScannedPane } from "../src/domain/tmux-discovery-scanner.js";

function makePane(overrides?: Partial<ScannedPane>): ScannedPane {
  return {
    tmuxSession: "sess",
    tmuxWindow: "0",
    tmuxPane: "%0",
    pid: 1234,
    cwd: "/tmp",
    activeCommand: null,
    ...overrides,
  };
}

function mockCmux(agents?: Array<{ pid: number; runtime: string }>): CmuxAdapter {
  return {
    queryAgentPIDs: vi.fn(async () => {
      if (!agents) return { ok: false as const, code: "unavailable" as const, message: "未连接" };
      const map = new Map(agents.map((a) => [a.pid, a]));
      return { ok: true as const, data: map };
    }),
    isAvailable: vi.fn(() => !!agents),
    getStatus: vi.fn(() => ({ available: !!agents, capabilities: {} })),
  } as unknown as CmuxAdapter;
}

function mockTmux(paneContent?: string): TmuxAdapter {
  return {
    capturePaneContent: vi.fn(async () => paneContent ?? null),
  } as unknown as TmuxAdapter;
}

describe("SessionFingerprinter", () => {
  // T1：cmux 报告 claude_code PID -> claude-code，最高置信度
  it("cmux claude_code PID -> claude-code，最高置信度", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux([{ pid: 1234, runtime: "claude_code" }]),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ pid: 1234 }));

    expect(result.runtimeHint).toBe("claude-code");
    expect(result.confidence).toBe("highest");
    expect(result.evidence.layerUsed).toBe(0);
    expect(result.evidence.cmuxSignal?.pid).toBe(1234);
  });

  // T2：cmux 报告 codex PID -> codex，最高置信度
  it("cmux codex PID -> codex，最高置信度", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux([{ pid: 5678, runtime: "codex" }]),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ pid: 5678 }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("highest");
  });

  // T3：cmux 不可用，'claude' 进程 -> claude-code，高置信度
  it("cmux 不可用 + claude 进程 -> claude-code，高置信度", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(), // 不可用
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "claude" }));

    expect(result.runtimeHint).toBe("claude-code");
    expect(result.confidence).toBe("high");
    expect(result.evidence.layerUsed).toBe(1);
  });

  // T4：cmux 不可用，'codex' 进程 -> codex，高置信度
  it("cmux 不可用 + codex 进程 -> codex，高置信度", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "codex" }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("high");
  });

  // T5：仅 shell（bash）-> terminal，高置信度
  it("shell 进程（bash）-> terminal，高置信度", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "bash" }));

    expect(result.runtimeHint).toBe("terminal");
    expect(result.confidence).toBe("high");
  });

  // T6：含糊进程 + pane 中的 Claude 横幅 -> claude-code，中等置信度
  it("含糊进程 + Claude 横幅 -> claude-code，中等置信度", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("一些输出\nClaude Code v1.0\n更多文本"),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "node" }));

    expect(result.runtimeHint).toBe("claude-code");
    expect(result.confidence).toBe("medium");
    expect(result.evidence.layerUsed).toBe(2);
  });

  // T7：含糊进程 + pane 中的 Codex 横幅 -> codex，中等置信度
  it("含糊进程 + Codex 横幅 -> codex，中等置信度", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("一些输出\nCodex CLI\n更多文本"),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "node" }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("medium");
  });

  // T8：无进程 + 无横幅 -> unknown，低置信度
  it("无进程 + 无横幅 -> unknown，低置信度", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("一些随机终端输出"),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: null }));

    expect(result.runtimeHint).toBe("unknown");
    expect(result.confidence).toBe("low");
  });

  // T9：CWD 中含 .claude/ 会提高置信度
  it("CWD 中含 .claude/ -> claude-code，低置信度（配置上下文）", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("随机输出"),
      fsExists: (p) => p === "/projects/.claude",
    });

    const result = await fp.fingerprint(makePane({ activeCommand: null, cwd: "/projects" }));

    expect(result.runtimeHint).toBe("claude-code");
    expect(result.confidence).toBe("low");
    expect(result.evidence.configSignal?.claudeDir).toBe(true);
  });

  // T10：CWD 中含 .agents/ 会提高置信度
  it("CWD 中含 .agents/ -> codex，低置信度（配置上下文）", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("随机输出"),
      fsExists: (p) => p === "/projects/.agents",
    });

    const result = await fp.fingerprint(makePane({ activeCommand: null, cwd: "/projects" }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("low");
    expect(result.evidence.configSignal?.agentsDir).toBe(true);
  });

  // T11：PID 匹配时 cmux 信号覆盖进程树
  it("PID 匹配时 cmux 信号覆盖进程树", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux([{ pid: 1234, runtime: "codex" }]),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    // 进程显示 "claude"，但 cmux 对 PID 1234 显示 "codex"
    const result = await fp.fingerprint(makePane({ pid: 1234, activeCommand: "claude" }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("highest");
    expect(result.evidence.layerUsed).toBe(0);
  });

  // T12：Evidence JSON 捕获包括 cmux 来源在内的全部信号
  it("evidence 捕获 cmux 信号来源", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux([{ pid: 42, runtime: "claude_code" }]),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ pid: 42 }));

    expect(result.evidence.cmuxSignal).toBeDefined();
    expect(result.evidence.cmuxSignal!.runtime).toBe("claude_code");
    expect(result.evidence.cmuxSignal!.pid).toBe(42);
    expect(result.evidence.layerUsed).toBe(0);
  });

  // T13：对话中提到 "Codex" 不会触发 codex 指纹识别
  it("不会把 pane 内容中任意提及 Codex 的情况分类为 codex", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("⏺ Codex 已合并相应章节。让我读取完整文档以验证所有内容"),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "2.1.84" }));

    expect(result.runtimeHint).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.evidence.layerUsed).toBe(-1);
  });
});
