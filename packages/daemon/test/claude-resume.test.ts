import { describe, it, expect, vi } from "vitest";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";

const CLAUDE_FLOOR_EFFECT = {
  runtime: "claude-code",
  axis: "permission",
  state: "observed",
  value: "acceptEdits",
  reason: "emitted_launch_arguments",
} as const;

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  getPaneCommand?: (target: string) => Promise<string | null>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
}) {
  return {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "claude"),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => ""),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

describe("ClaudeResumeAdapter 恢复适配器", () => {
  describe("canResume 能力判断", () => {
    it("claude_name + token -> true", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("claude_name", "my-session")).toBe(true);
    });

    it("claude_id + token -> true", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("claude_id", "abc-123")).toBe(true);
    });

    it("无 token -> false", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("claude_name", null)).toBe(false);
    });

    it("resume_type=none -> false", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("none", "token")).toBe(false);
    });

    it("codex_id -> false（cross-harness）", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("codex_id", "token")).toBe(false);
    });
  });

  describe("resume 恢复", () => {
    it("先发送 sendText，再发送 Enter key", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText, sendKeys });
      const adapter = new ClaudeResumeAdapter(tmux);

      await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText.mock.calls[0]![0]).toBe("r99-demo1-lead");
      // OPR.0.4.8.2：restore 现在与 fresh 一样携带 launch-posture floor（acceptEdits）。
      expect(sendText.mock.calls[0]![1]).toBe("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --resume 'my-session'");
      expect(sendKeys).toHaveBeenCalledOnce();
      expect(sendKeys.mock.calls[0]![0]).toBe("r99-demo1-lead");
      expect(sendKeys.mock.calls[0]![1]).toEqual(["Enter"]);
      // sendText 在 sendKeys 前调用
      expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(sendKeys.mock.invocationCallOrder[0]!);
    });

    it("0.5.2-07：SPEC 固定的 model 会在 legacy resume command 中输出 --model", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText });
      const adapter = new ClaudeResumeAdapter(tmux);

      await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo", undefined, "gpt-5.4-cheap");

      expect(sendText.mock.calls[0]![1]).toBe(
        "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --model 'gpt-5.4-cheap' --resume 'my-session'"
      );
    });

    it("成功时返回 { ok: true }", async () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");
      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT });
    });

    it("sendText 失败时返回 { ok: false, code: 'resume_failed' }", async () => {
      const sendText = vi.fn(async () => ({ ok: false as const, code: "session_not_found", message: "err" }));
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText }));
      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_failed");
    });

    it("resume_type=none -> { ok: false, code: 'no_resume' }", async () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-lead", "none", "token", "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_resume");
    });

    it("无 token -> { ok: false, code: 'no_resume' }", async () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-lead", "claude_name", null, "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_resume");
    });

    it("command 中正确引用 shell-sensitive token", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText, sendKeys }));

      await adapter.resume("r99-demo1-lead", "claude_name", "tok; rm -rf /", "/repo");

      expect(sendText.mock.calls[0]![1]).toBe("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --resume 'tok; rm -rf /'");
    });

    it("sendText 后 sendKeys(Enter) 失败 -> 发送 C-c 清除 buffer", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn()
        .mockResolvedValueOnce({ ok: false as const, code: "session_not_found", message: "err" }) // Enter fails
        .mockResolvedValueOnce({ ok: true as const }); // C-c succeeds
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText, sendKeys }));

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_failed");
      // 已尝试 C-c cleanup
      expect(sendKeys).toHaveBeenCalledTimes(2);
      expect(sendKeys.mock.calls[1]![1]).toEqual(["C-c"]);
    });

    it("sendText 失败 -> 不尝试 C-c", async () => {
      const sendText = vi.fn(async () => ({ ok: false as const, code: "session_not_found", message: "err" }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText, sendKeys }));

      await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      // 完全不应调用 sendKeys（无 Enter、无 C-c）
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("Claude 显示未找到 conversation 并退回 shell 时返回 retry_fresh", async () => {
      const getPaneCommand = vi.fn(async () => "zsh");
      const capturePaneContent = vi.fn(async () => "No conversation found with session ID: abc123\nuser@example.test %");
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 0, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "missing-session", "/repo");

      expect(result).toEqual({
        ok: false,
        code: "retry_fresh",
        message: "Claude resume 失败：找不到所请求 session 的会话",
      });
    });

    it("等待 Claude 成为 foreground command 后才成功", async () => {
      const getPaneCommand = vi
        .fn<(_: string) => Promise<string | null>>()
        .mockResolvedValueOnce("zsh")
        .mockResolvedValueOnce("claude");
      const capturePaneContent = vi.fn(async () => "");
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 1, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT });
      expect(getPaneCommand).toHaveBeenCalledTimes(2);
    });

    it("即使 tmux 报告 version-string foreground command，也将 live Claude TUI 视为成功", async () => {
      const getPaneCommand = vi
        .fn<(_: string) => Promise<string | null>>()
        .mockResolvedValueOnce("zsh")
        .mockResolvedValueOnce("2.1.89");
      const capturePaneContent = vi
        .fn<(_: string, __?: number) => Promise<string | null>>()
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce(
          [
            "Claude Code v2.1.89",
            "❯ Baseline warmup 4/6 for dev.impl.",
            "────────────────────────────────────────────────────────────────────────────────",
            "  ? for shortcuts                                             ● high · /effort",
          ].join("\n")
        );
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 1, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT });
    });

    // OPR.0.3.4.5——regression guard 行为 05：CONSUMER human gate。在 Claude resume-selection
    // menu 上，真实 consumer 不发送任何 selection keystroke，并返回 attention_required。这是
    // safety-critical：自动按键选择 menu 是 governance BLOCKING。
    it("OPR.0.3.4.5 guard（05）：resume-selection menu -> attention_required，且不发送 selection keystroke", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const getPaneCommand = vi.fn(async () => "claude");
      const capturePaneContent = vi.fn(async () => [
        "Choose a conversation to resume:",
        "",
        "  1. project-foo",
        "  2. project-bar",
        "  3. project-baz",
        "",
        "Enter your choice (1-3):",
      ].join("\n"));
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ sendText, sendKeys, getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 0, sleep: async () => {} },
      );

      const result = await adapter.resume("r99-worker", "claude_name", "my-session", "/repo");

      // attention_required，而非 failed
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("attention_required");
        expect(result.message).toBeTruthy();
      }
      // 关键 GUARD：不发送数字 selection keystroke。sendText 只有初始 `claude --resume ...`
      // command；sendKeys 只有初始 Enter。没有其他内容——没有 "1"、没有 "2"。
      const allSendTextArgs = sendText.mock.calls.map((c) => String(c[1] ?? ""));
      const allSendKeysArgs = sendKeys.mock.calls.flatMap((c) => {
        const arg = c[1];
        return Array.isArray(arg) ? arg : [String(arg ?? "")];
      });
      for (const s of [...allSendTextArgs, ...allSendKeysArgs]) {
        expect(s).not.toMatch(/^[0-9]+$/);
      }
      // 明确验证：只发送 launch command + Enter。
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText.mock.calls[0]![1]).toContain("claude --permission-mode acceptEdits --resume");
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(sendKeys.mock.calls[0]![1]).toEqual(["Enter"]);
    });

    it("当前 resume-mode chooser 不输入 selection，立即返回 attention", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const sleep = vi.fn(async () => {});
      const adapter = new ClaudeResumeAdapter(
        mockTmux({
          sendText,
          sendKeys,
          getPaneCommand: vi.fn(async () => "claude"),
          capturePaneContent: vi.fn(async () => [
            "How would you like to resume?",
            "❯ Resume from summary",
            "  Resume full session as-is",
          ].join("\n")),
        }),
        { pollMs: 200, maxWaitMs: 5_000, sleep },
      );

      const result = await adapter.resume("r99-worker", "claude_name", "my-session", "/repo");

      expect(result).toMatchObject({ ok: false, code: "attention_required" });
      expect(sleep).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(sendKeys).toHaveBeenCalledWith("r99-worker", ["Enter"]);
    });

    it("将普通 active-TUI prose 中的两个 chooser label 都视为已恢复", async () => {
      const adapter = new ClaudeResumeAdapter(
        mockTmux({
          getPaneCommand: vi.fn(async () => "2.1.89"),
          capturePaneContent: vi.fn(async () => [
            "Claude Code v2.1.89",
            "❯ Compare Resume from summary with Resume full session as-is in the recovery notes.",
            "────────────────────────────────────────────────────────────────────────────────",
            "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
          ].join("\n")),
        }),
        { pollMs: 0, maxWaitMs: 0, sleep: async () => {} },
      );

      const result = await adapter.resume("r99-worker", "claude_name", "my-session", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT });
    });

    it("resume verification 期间将 edit-approval footer 视为 live Claude TUI", async () => {
      const getPaneCommand = vi
        .fn<(_: string) => Promise<string | null>>()
        .mockResolvedValueOnce("2.1.89");
      const capturePaneContent = vi
        .fn<(_: string, __?: number) => Promise<string | null>>()
        .mockResolvedValueOnce(
          [
            "Loading startup skills and recovering identity.",
            "",
            "────────────────────────────────────────────────────────────────────────────────",
            "❯ ",
            "────────────────────────────────────────────────────────────────────────────────",
            "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
          ].join("\n")
        );
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 1, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT });
    });
  });
});
