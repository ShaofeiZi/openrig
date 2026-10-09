import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";

import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { TerminalAdapter } from "../src/adapters/terminal-adapter.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import type { RuntimeAdapter, NodeBinding, ForkSource } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { RigSpec, SessionSourceSpec } from "../src/domain/types.js";

// ============================================================================
// 测试夹具
// ============================================================================

function baseValidSpec(): Record<string, unknown> {
  return {
    version: "0.2",
    name: "fork-test-rig",
    pods: [
      {
        id: "dev",
        label: "Dev pod",
        members: [
          {
            id: "impl",
            agent_ref: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
          },
        ],
        edges: [],
      },
    ],
    edges: [],
  };
}

function withMember(spec: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(spec));
  const pods = next.pods as Array<Record<string, unknown>>;
  const members = pods[0]!.members as Array<Record<string, unknown>>;
  members[0] = { ...members[0], ...override };
  return next;
}

// ============================================================================
// Schema 验证——诚实拒绝矩阵
// ============================================================================

describe("session_source schema 验证", () => {
  it("接受 claude-code + fork + native_id + 非空 value", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: {
        mode: "fork",
        ref: { kind: "native_id", value: "0b0165d7-cb4d-4650-90de-15c0a1ede9e6" },
      },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("接受 codex + fork + native_id + 非空 value", () => {
    const spec = withMember(baseValidSpec(), {
      runtime: "codex",
      session_source: { mode: "fork", ref: { kind: "native_id", value: "thread-id-abc" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(true);
  });

  it("拒绝带 session_source 的 terminal runtime", () => {
    const spec = withMember(baseValidSpec(), {
      runtime: "terminal",
      agent_ref: "builtin:terminal",
      profile: "none",
      session_source: { mode: "fork", ref: { kind: "native_id", value: "x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal 运行时没有原生 fork 原语"))).toBe(true);
  });

  it("拒绝 mode != fork", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "snapshot", ref: { kind: "native_id", value: "x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    // PL-016 第 4 项：错误消息点明当前三种有效 mode。
    expect(result.errors.some((e) => e.includes('支持 "fork"、"rebuild" 或 "agent_image"'))).toBe(true);
  });

  it("拒绝 ref.kind=artifact_path（按 dossier 延后）", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "artifact_path", value: "/some/path" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"artifact_path" 延后到后续切片'))).toBe(true);
  });

  it("拒绝 ref.kind=name", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "name", value: "x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('弱于 "native_id"'))).toBe(true);
  });

  it("拒绝 ref.kind=last", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "last" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('弱于 "native_id"'))).toBe(true);
  });

  it("kind=native_id 时拒绝缺失的 ref.value", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "native_id" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ref.value") && e.includes("必须提供非空字符串"))).toBe(true);
  });

  it("拒绝空 ref.value", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "native_id", value: "   " } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ref.value") && e.includes("必须提供非空字符串"))).toBe(true);
  });

  it("拒绝完全缺失的 ref", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork" },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes(".ref："))).toBe(true);
  });

  it("拒绝未知 kind 值", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "magic" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('v1 fork 模式仅支持 "native_id"'))).toBe(true);
  });
});

// ============================================================================
// normalizePod——schema 侧类型化转换
// ============================================================================

describe("session_source 规范化", () => {
  it("把有效 session_source 规范化到 RigSpecPodMember.sessionSource", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "fork", ref: { kind: "native_id", value: "abc" } },
    });
    const normalized = RigSpecSchema.normalize(spec) as RigSpec;
    const member = normalized.pods[0]!.members[0]!;
    expect(member.sessionSource).toEqual({ mode: "fork", ref: { kind: "native_id", value: "abc" } });
  });

  it("把缺失的 session_source 规范化为 undefined", () => {
    const spec = baseValidSpec();
    const normalized = RigSpecSchema.normalize(spec) as RigSpec;
    expect(normalized.pods[0]!.members[0]!.sessionSource).toBeUndefined();
  });
});

// ============================================================================
// Codec 往返——serialize → parse → normalize
// ============================================================================

describe("session_source codec 往返", () => {
  it("经过 serialize → parse → normalize 后保留 session_source", () => {
    const seed: RigSpec = {
      version: "0.2",
      name: "fork-test-rig",
      pods: [{
        id: "dev",
        label: "Dev pod",
        members: [{
          id: "impl",
          agentRef: "local:agents/impl",
          profile: "default",
          runtime: "claude-code",
          cwd: ".",
          sessionSource: { mode: "fork", ref: { kind: "native_id", value: "0b0165d7-cb4d-4650-90de-15c0a1ede9e6" } },
        }],
        edges: [],
      }],
      edges: [],
    };
    const yaml = RigSpecCodec.serialize(seed);
    expect(yaml).toContain("session_source:");
    expect(yaml).toContain("mode: fork");
    expect(yaml).toContain("kind: native_id");
    expect(yaml).toContain("0b0165d7-cb4d-4650-90de-15c0a1ede9e6");

    const parsed = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);

    const normalized = RigSpecSchema.normalize(parsed as Record<string, unknown>) as RigSpec;
    expect(normalized.pods[0]!.members[0]!.sessionSource).toEqual(seed.pods[0]!.members[0]!.sessionSource);
  });
});

// ============================================================================
// Claude 适配器 fork 分支
// ============================================================================

function mockTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockClaudeFs(captured?: string): ClaudeAdapterFsOps {
  const store: Record<string, string> = {};
  return {
    readFile: (p: string) => {
      if (captured && p.includes(`12345.json`)) {
        return JSON.stringify({ pid: 12345, sessionId: captured, name: "dev-impl@test-rig" });
      }
      if (p in store) return store[p]!;
      throw new Error(`Not found: ${p}`);
    },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store || (captured ? p.includes("sessions") : false),
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: () => [],
    readdir: () => (captured ? ["12345.json"] : []),
    homedir: "/mock-home",
  } as ClaudeAdapterFsOps;
}

function makeBinding(): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project",
  };
}

describe("ClaudeCodeAdapter.launchHarness fork 分支", () => {
  it("为 forkSource.kind=native_id 构建 claude --resume <parent> --fork-session 并捕获新 token", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockClaudeFs("NEW-POST-FORK-TOKEN-XYZ") });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-TOKEN-ABC" },
    });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith(
      "r01-impl",
      "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --resume PARENT-TOKEN-ABC --fork-session --name dev-impl@test-rig",
    );
    if (result.ok) {
      // 捕获的 token 必须是 fork 后的新 token，而不是父 token。
      expect(result.resumeToken).toBe("NEW-POST-FORK-TOKEN-XYZ");
      expect(result.resumeToken).not.toBe("PARENT-TOKEN-ABC");
      expect(result.resumeType).toBe("claude_id");
    }
  });

  it("拒绝 forkSource.kind=artifact_path（防御性检查，schema 也会拒绝）", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockClaudeFs() });
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "artifact_path", value: "/some/path" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('v1 不支持 ref.kind="artifact_path"');
    }
  });

  it("拒绝同时提供 resumeToken 与 forkSource", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockClaudeFs() });
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      resumeToken: "abc",
      forkSource: { kind: "native_id", value: "xyz" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("resumeToken 与 forkSource 互斥");
    }
  });

  it("拒绝 value 为空的 forkSource", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockClaudeFs() });
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "  " },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("必须提供 forkSource.value");
    }
  });

  it("不破坏现有 fresh 与 resume 路径", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockClaudeFs(),
      sessionIdFactory: () => "fresh-uuid-aaa",
    });
    const fresh = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });
    expect(fresh.ok).toBe(true);

    const resume = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "resume-abc" });
    expect(resume.ok).toBe(true);
  });
});

// OPR.0.3.4.5——pod-aware consumer guard：ClaudeCodeAdapter.launchHarness 遇到
// resume-selection 菜单时返回带 evidence 的 attention_required，并且不发送任何数字选择
// 按键（治理层 BLOCKING 安全线）。
describe("ClaudeCodeAdapter.launchHarness resume-selection 菜单（OPR.0.3.4.5）", () => {
  it("返回带 evidence 的 attention_required，且不发送数字选择按键", async () => {
    const menuContent = [
      "Choose a conversation to resume:",
      "",
      "  1. project-foo",
      "  2. project-bar",
      "",
      "Enter your choice (1-2):",
    ].join("\n");
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const tmux = {
      ...mockTmux(),
      sendText,
      sendKeys,
      getPaneCommand: vi.fn(async () => "claude"),
      capturePaneContent: vi.fn(async () => menuContent),
    } as unknown as TmuxAdapter;
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockClaudeFs(),
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      resumeToken: "resume-tok",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.evidence).toBeTruthy();
      expect(result.evidence).toContain("Choose a conversation");
    }
    // 核心 guard：没有发送数字选择按键。
    const allSendKeysArgs = sendKeys.mock.calls.flatMap((c) => {
      const arg = c[1];
      return Array.isArray(arg) ? arg : [String(arg ?? "")];
    });
    const allSendTextArgs = sendText.mock.calls.map((c) => String(c[1] ?? ""));
    for (const s of [...allSendKeysArgs, ...allSendTextArgs]) {
      expect(s).not.toMatch(/^[0-9]+$/);
    }
  });
});

// ============================================================================
// Codex 适配器 fork 分支
// ============================================================================

describe("CodexRuntimeAdapter.launchHarness fork 分支", () => {
  function makeMinimalCodexFs() {
    return {
      readFile: () => "",
      writeFile: () => {},
      exists: () => false,
      mkdirp: () => {},
      listFiles: () => [],
    } as unknown as Parameters<typeof CodexRuntimeAdapter>[0]["fsOps"];
  }

  function makeCodexAdapter(captureThreadId?: string) {
    const tmux = {
      sendText: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)"),
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPanePid: vi.fn(async () => 900),
    } as unknown as TmuxAdapter;
    const adapter = new CodexRuntimeAdapter({
      tmux: mockShellCommand(tmux),
      fsOps: makeMinimalCodexFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readThreadIdByPid: (pid) => (pid === 901 && captureThreadId ? captureThreadId : undefined),
      sleep: async () => {},
    });
    return { tmux, adapter };
  }

  it("为 forkSource.kind=native_id 构建 codex fork <parent> 并捕获新 thread ID", async () => {
    const { tmux, adapter } = makeCodexAdapter("NEW-CODEX-THREAD-XYZ");
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-THREAD-ABC" },
    });
    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    const sentCmd = sendText.mock.calls[0]?.[1] as string;
    // R2 LOW-4 校准（如实更新 floor，断言意图不变）：无 profile 的 floor 现在会在可执行文件
    // 与 fork 子命令之间显式发出 ` -s workspace-write` sandbox 参数
    //（OPR.0.4.8.2 posture helper）。
    expect(sentCmd).toMatch(/^codex( -p [^ ]+| -s [a-z-]+)* fork/);
    expect(sentCmd).toContain("PARENT-THREAD-ABC");
    if (result.ok) {
      expect(result.resumeToken).toBe("NEW-CODEX-THREAD-XYZ");
      expect(result.resumeToken).not.toBe("PARENT-THREAD-ABC");
      expect(result.resumeType).toBe("codex_id");
    }
  });

  it("拒绝 forkSource.kind=artifact_path", async () => {
    const { adapter } = makeCodexAdapter();
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "artifact_path", value: "/x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('v1 不支持 ref.kind="artifact_path"');
    }
  });

  it("拒绝同时提供 resumeToken 与 forkSource", async () => {
    const { adapter } = makeCodexAdapter();
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      resumeToken: "r",
      forkSource: { kind: "native_id", value: "p" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("resumeToken 与 forkSource 互斥");
    }
  });

  it("捕获失败时拒绝 fork（身份诚实性：无 token 就没有可信 seat）", async () => {
    const { adapter } = makeCodexAdapter(); // 未捕获 thread ID。
    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-X" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("无法捕获 fork 后的新 thread id");
    }
  });

  it("fork 期间保留 Codex hook review consent", async () => {
    const hookReviewContent = [
      "Hooks need review",
      "3 hooks are new or changed.",
      "1. Review hooks",
      "2. Trust all and continue",
      "3. Continue without trusting (hooks won't run)",
    ].join("\n");

    let callCount = 0;
    const tmux = {
      sendText: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => {
        callCount++;
        if (callCount <= 3) return hookReviewContent;
        return "OpenAI Codex (v0.0.0)";
      }),
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPanePid: vi.fn(async () => 900),
    } as unknown as TmuxAdapter;

    const adapter = new CodexRuntimeAdapter({
      tmux: mockShellCommand(tmux),
      fsOps: makeMinimalCodexFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readThreadIdByPid: (pid) => (pid === 901 ? "NEW-THREAD-AFTER-TRUST" : undefined),
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-THREAD-ABC" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe("NEW-THREAD-AFTER-TRUST");
      expect(result.resumeType).toBe("codex_id");
    }

    const sendTextCalls = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls;
    const trustDismissal = sendTextCalls.find((c) => c[1] === "2");
    expect(trustDismissal).toBeUndefined();
  });

  it("等待新 fork identity 时保留延迟出现的 hook-trust consent", async () => {
    const hookReviewContent = [
      "Hooks need review",
      "3 hooks are new or changed.",
      "1. Review hooks",
      "2. Trust all and continue",
      "3. Continue without trusting (hooks won't run)",
    ].join("\n");

    let captureCount = 0;
    let threadIdAvailable = false;
    const tmux = {
      sendText: vi.fn(async (_sess: string, text: string) => {
        if (text === "2") threadIdAvailable = true;
        return { ok: true as const };
      }),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => {
        captureCount++;
        if (captureCount <= 2) return "OpenAI Codex (v0.0.0)";
        if (!threadIdAvailable) return hookReviewContent;
        return "OpenAI Codex (v0.0.0)";
      }),
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      getPanePid: vi.fn(async () => 900),
    } as unknown as TmuxAdapter;

    const adapter = new CodexRuntimeAdapter({
      tmux: mockShellCommand(tmux),
      fsOps: makeMinimalCodexFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readThreadIdByPid: (pid) => (pid === 901 && threadIdAvailable ? "DELAYED-TRUST-THREAD" : undefined),
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-DELAYED" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("无法捕获 fork 后的新 thread id");
    expect(threadIdAvailable).toBe(false);

    const sendTextCalls = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls;
    const trustDismissal = sendTextCalls.find((c) => c[1] === "2");
    expect(trustDismissal).toBeUndefined();
  });
});

// ============================================================================
// Terminal 适配器——防御性拒绝
// ============================================================================

describe("TerminalAdapter.launchHarness 拒绝 fork", () => {
  it("拒绝 forkSource（terminal 没有原生 fork 原语）", async () => {
    const adapter = new TerminalAdapter();
    const result = await adapter.launchHarness(makeBinding(), {
      name: "term@rig",
      forkSource: { kind: "native_id", value: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("terminal runtime 没有原生 fork 原语");
    }
  });

  it("无 fork 路径仍然成功", async () => {
    const adapter = new TerminalAdapter();
    const result = await adapter.launchHarness(makeBinding(), { name: "term@rig" });
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// 启动编排器——forkSource → continuityOutcome="forked" 并持久化新 token；不重放
// identity prompt（fork 后的 seat 已携带父上下文）
// ============================================================================

function mockOrchTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function makeStubAdapter(forkResumeToken: string): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async (_binding, opts) => {
      // 身份诚实规则：捕获的 token 必须是 fork 后的新 token。
      if (opts.forkSource) {
        return { ok: true, resumeToken: forkResumeToken, resumeType: "claude_id" };
      }
      return { ok: true };
    }),
  };
}

function emptyPlan(): ProjectionPlan {
  return { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

describe("StartupOrchestrator forkSource 集成", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
  });
  afterEach(() => { db.close(); });

  function seed(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("fork-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function makeInput(s: { rigId: string; nodeId: string; sessionId: string }, overrides?: Partial<StartupInput>): StartupInput {
    return {
      rigId: s.rigId,
      nodeId: s.nodeId,
      sessionId: s.sessionId,
      binding: { id: "b1", nodeId: s.nodeId, tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." },
      adapter: makeStubAdapter("NEW-POST-FORK-TOKEN-aaa"),
      plan: emptyPlan(),
      resolvedStartupFiles: [],
      startupActions: [],
      isRestore: false,
      ...overrides,
    };
  }

  function createOrch(): StartupOrchestrator {
    return new StartupOrchestrator({
      db, sessionRegistry, eventBus,
      tmuxAdapter: mockOrchTmux(),
      sleep: async () => {},
    });
  }

  it("提供 forkSource 且启动成功时设置 continuityOutcome=forked", async () => {
    const s = seed();
    const orch = createOrch();
    const forkSource: ForkSource = { kind: "native_id", value: "PARENT-TOKEN-ABC" };
    const result = await orch.startNode(makeInput(s, { forkSource }));
    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "forked",
    });
  });

  it("在 seat 上持久化 fork 后的新 token，而不是父 token", async () => {
    const s = seed();
    const orch = createOrch();
    const forkSource: ForkSource = { kind: "native_id", value: "PARENT-TOKEN-ABC" };
    await orch.startNode(makeInput(s, { forkSource }));

    const row = db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(s.sessionId) as { resume_token: string };
    expect(row.resume_token).toBe("NEW-POST-FORK-TOKEN-aaa");
    expect(row.resume_token).not.toBe("PARENT-TOKEN-ABC");
  });

  it("把 forkSource 传给 adapter.launchHarness 选项，而不是 resumeToken", async () => {
    const s = seed();
    const orch = createOrch();
    const adapter = makeStubAdapter("any-token");
    const launchSpy = adapter.launchHarness as ReturnType<typeof vi.fn>;
    const forkSource: ForkSource = { kind: "native_id", value: "PARENT-TOKEN" };

    await orch.startNode(makeInput(s, { adapter, forkSource }));

    expect(launchSpy).toHaveBeenCalledTimes(1);
    const opts = launchSpy.mock.calls[0]![1];
    expect(opts.forkSource).toEqual(forkSource);
    expect(opts.resumeToken).toBeUndefined();
  });

  it("fresh 路径（无 resumeToken、无 forkSource）保持不变：continuityOutcome=fresh", async () => {
    const s = seed();
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s));
    expect(result).toEqual({ ok: true, startupStatus: "ready", continuityOutcome: "fresh" });
  });

  it("resume 路径（已设置 resumeToken）保持不变：continuityOutcome=resumed", async () => {
    const s = seed();
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s, {
      resumeToken: "stored-token-xyz",
      isRestore: true,
    }));
    expect(result).toEqual({ ok: true, startupStatus: "ready", continuityOutcome: "resumed" });
  });
});

// ============================================================================
// rig-expansion-service session_source 透传（结构化规范）
// ============================================================================

// OPR.0.3.3.24：expand 通过 materializeStructured + launchValidatedSpec 传递结构化规范
// 对象，不做合成 YAML 往返。这是重新对齐的 starterRef 透传测试对应的 session_source
// 用例：断言结构化规范成员上的 snake_case session_source，而不是 YAML 字符串。
describe("rig-expansion session_source 透传（结构化规范）", () => {
  it("设置 member.sessionSource 时在结构化规范成员上输出 session_source", async () => {
    const { RigExpansionService } = await import("../src/domain/rig-expansion-service.js");
    const fakeRigRepo = { getRig: () => ({ rig: { name: "rig-x" }, nodes: [] }) } as never;
    const fakeEventBus = { emit: () => {} } as never;
    const capturedSpecs: Array<Record<string, unknown>> = [];
    const fakePodInstantiator = {
      materializeStructured: async (raw: Record<string, unknown>) => {
        capturedSpecs.push(raw);
        return { ok: true as const, result: { nodes: [] } };
      },
      launchValidatedSpec: async () => ({ ok: true as const, result: { nodes: [], warnings: [] } }),
    } as never;

    const svc = new RigExpansionService({
      db: {} as never,
      rigRepo: fakeRigRepo,
      eventBus: fakeEventBus,
      nodeLauncher: {} as never,
      podInstantiator: fakePodInstantiator,
      sessionRegistry: {} as never,
    });
    const result = await svc.expand({
      rigId: "rig-x",
      pod: {
        id: "dev",
        label: "Dev",
        members: [{
          id: "impl",
          runtime: "claude-code",
          agentRef: "local:impl",
          profile: "default",
          cwd: ".",
          sessionSource: { mode: "fork", ref: { kind: "native_id", value: "fork-source-id" } },
        }],
        edges: [],
      },
    });
    expect(result.ok).toBe(true);
    expect(capturedSpecs).toHaveLength(1);
    const spec = capturedSpecs[0]! as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = spec.pods[0]!.members[0]!;
    const ss = member["session_source"] as { mode: string; ref: { kind: string; value: string } } | undefined;
    expect(ss).toBeDefined();
    expect(ss!.mode).toBe("fork");
    expect(ss!.ref.kind).toBe("native_id");
    expect(ss!.ref.value).toBe("fork-source-id");
  });
});

// ============================================================================
// 诚实的 UX 字面契约——continuityOutcome union 包含 "forked"
// ============================================================================

describe("身份诚实性字面契约", () => {
  it('continuityOutcome union 同时接受 "forked"、"resumed" 与 "fresh"', () => {
    const r1 = { ok: true as const, startupStatus: "ready" as const, continuityOutcome: "forked" as const };
    const r2 = { ok: true as const, startupStatus: "ready" as const, continuityOutcome: "resumed" as const };
    const r3 = { ok: true as const, startupStatus: "ready" as const, continuityOutcome: "fresh" as const };
    expect(r1.continuityOutcome).toBe("forked");
    expect(r2.continuityOutcome).toBe("resumed");
    expect(r3.continuityOutcome).toBe("fresh");
  });

  it("fork 路径不复用 'restored'、'resumed' 或 'snapshot' 措辞", () => {
    const fork: SessionSourceSpec = { mode: "fork", ref: { kind: "native_id", value: "x" } };
    expect(fork.mode).toBe("fork");
    expect(["restored", "resumed", "snapshot", "snapshot_copy"]).not.toContain(fork.mode as string);
  });
});

// ============================================================================
// OPR.0.4.6.PI1——Pi 行：runtime "pi" + session_source fork，经 runner 生成启动命令
// 形状（CLI --fork 整体 session fork，使用新 child token 的规则）
// ============================================================================

describe("session_source Pi 行（OPR.0.4.6.PI1）", () => {
  const PI_STATE_ROOT = "/openrig-home/state/pi";
  const PI_RUNNER = "/daemon-dist/adapters/pi-runner.js";
  const PI_SESSION = "dev-impl@fork-test-rig";
  const PI_PARENT = "/prior-seat/sessions/parent_0196.jsonl";
  const PI_CHILD = `${PI_STATE_ROOT}/${PI_SESSION}/sessions/child_0197.jsonl`;

  it("接受 runtime pi + fork + native_id（schema）", () => {
    const spec = withMember(baseValidSpec(), {
      runtime: "pi",
      session_source: { mode: "fork", ref: { kind: "native_id", value: PI_PARENT } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("构建包含 --fork <parent> 的 runner 命令并持久化新的 child token", async () => {
    const { PiRuntimeAdapter } = await import("../src/adapters/pi-runtime-adapter.js");
    const { piSeatPaths } = await import("../src/adapters/pi-runner-protocol.js");

    const files: Record<string, string> = {};
    const dirs = new Set<string>();
    let typedCommand = "";
    const tmux = {
      sendText: vi.fn(async (_t: string, text: string) => {
        typedCommand = text;
        const launchId = /--launch-id '([^']+)'/.exec(text)![1];
        // runner “启动”并通过带 launch 标记的 sidecar 报告 CHILD session 文件。
        files[piSeatPaths(PI_STATE_ROOT, PI_SESSION).runnerStatePath] = JSON.stringify({
          ready: true, launchId, sessionFile: PI_CHILD, sessionId: "0197c", updatedAt: "t",
        });
        return { ok: true as const };
      }),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      capturePaneContent: vi.fn(async () => ""),
      hasSession: vi.fn(async () => true),
    } as unknown as TmuxAdapter;

    const adapter = new PiRuntimeAdapter({
      tmux,
      fsOps: {
        readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
        writeFile: (p: string, c: string) => { files[p] = c; },
        exists: (p: string) => p in files || dirs.has(p),
        mkdirp: (p: string) => { dirs.add(p); },
      },
      stateRoot: PI_STATE_ROOT,
      runnerEntryPath: PI_RUNNER,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(
      { tmuxSession: PI_SESSION, cwd: "/work" } as NodeBinding,
      { name: PI_SESSION, forkSource: { kind: "native_id", value: PI_PARENT } },
    );

    // 启动命令形状：在 pane 中输入带 --fork 的 runner。
    expect(typedCommand).toContain("pi-runner.js");
    expect(typedCommand).toContain(`--fork '${PI_PARENT}'`);
    expect(typedCommand).not.toContain("--session '");
    expect(typedCommand).toMatch(/--(no-)?approve/); // 始终显式指定 trust。

    // fork 后 token 规则：持久化新的 child 文件，绝不使用 parent。
    expect(result).toEqual({
      ok: true,
      resumeToken: PI_CHILD,
      resumeType: "pi_session_file",
      appliedLaunch: {
        runtime: "pi",
        axis: "resource_trust",
        state: "observed",
        value: "no-approve",
      },
    });
  });
});
