import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { describe, it, expect, vi } from "vitest";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";

const CODEX_FLOOR_EFFECT = {
  runtime: "codex",
  axis: "sandbox",
  state: "observed",
  value: "workspace-write",
  reason: "emitted_launch_arguments",
} as const;

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  getPaneCommand?: (target: string) => Promise<string | null>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
}) {
  const tmux = {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    // 就绪提示用于佐证前台进程；仅凭进程名不足以确认。
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "codex"),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
  return mockShellCommand(tmux);
}

describe("CodexResumeAdapter", () => {
  describe("canResume", () => {
    it("codex_id + token → true", () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      expect(adapter.canResume("codex_id", "uuid-123")).toBe(true);
    });

    it("codex_last 不带 token → true", () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      expect(adapter.canResume("codex_last", null)).toBe(true);
    });

    it("无 token 且不是 codex_last → false", () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      expect(adapter.canResume("codex_id", null)).toBe(false);
    });

    it("claude_name → false（跨 harness）", () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      expect(adapter.canResume("claude_name", "token")).toBe(false);
    });
  });

  describe("resume", () => {
    it("codex_id：先 sendText，再 sendKeys Enter", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText, sendKeys });
      const adapter = new CodexResumeAdapter(tmux);

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText.mock.calls[0]![0]).toBe("r99-demo1-impl");
      expect(sendText.mock.calls[0]![1]).toBe("codex -s workspace-write resume 'uuid-123'");
      expect(sendKeys).toHaveBeenCalledOnce();
      expect(sendKeys.mock.calls[0]![1]).toEqual(["Enter"]);
      expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(sendKeys.mock.invocationCallOrder[0]!);
    });

    it("0.5.2-07：SPEC 固定的 model 会把 -m 传入旧式 codex resume 命令", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText, sendKeys });
      const adapter = new CodexResumeAdapter(tmux);

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo", null, undefined, "gpt-5.4-cheap");

      expect(sendText.mock.calls[0]![1]).toBe("codex -s workspace-write -m 'gpt-5.4-cheap' resume 'uuid-123'");
    });

    it("codex_last：sendText 发送保留 posture 的 codex -s workspace-write resume --last", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText, sendKeys });
      const adapter = new CodexResumeAdapter(tmux);

      await adapter.resume("r99-demo1-impl", "codex_last", null, "/repo");

      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText.mock.calls[0]![1]).toBe("codex -s workspace-write resume --last");
      expect(sendKeys).toHaveBeenCalledOnce();
    });

    it("成功时返回 { ok: true }", async () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");
      expect(result).toEqual({ ok: true, appliedLaunch: CODEX_FLOOR_EFFECT });
    });

    it("失败时返回 { ok: false, code: 'resume_failed' }", async () => {
      const sendText = vi.fn(async () => ({ ok: false as const, code: "session_not_found", message: "err" }));
      const adapter = new CodexResumeAdapter(mockTmux({ sendText }));
      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_failed");
    });

    it("resume_type=none → { ok: false, code: 'no_resume' }", async () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-impl", "none", null, "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_resume");
    });

    it("无 token 且不是 codex_last → { ok: false, code: 'no_resume' }", async () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-impl", "codex_id", null, "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_resume");
    });

    it("命令会引用含 shell 特殊字符的 token", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }));

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid; rm -rf /", "/repo");

      expect(sendText.mock.calls[0]![1]).toBe("codex -s workspace-write resume 'uuid; rm -rf /'");
    });

    it("带 profile 的 resume 在预检通过后使用 -p 参数", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const exec = vi.fn(async () => "[my-profile]\n");
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }), { exec });

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo", "my-profile");

      expect(exec).toHaveBeenCalled();
      expect(sendText.mock.calls[0]![1]).toBe("codex -p 'my-profile' resume 'uuid-123'");
    });

    it("profile 预检失败会在 sendText 前阻止 resume", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const exec = vi.fn(async () => { throw new Error("codex not found"); });
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }), { exec });

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo", "bad-profile");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("resume_failed");
        expect(result.message).toContain("Profile 预检失败");
      }
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("sendText 后 sendKeys(Enter) 失败时发送 C-c 清空缓冲区", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn()
        .mockResolvedValueOnce({ ok: false as const, code: "session_not_found", message: "err" })
        .mockResolvedValueOnce({ ok: true as const });
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }));

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_failed");
      expect(sendKeys).toHaveBeenCalledTimes(2);
      expect(sendKeys.mock.calls[1]![1]).toEqual(["C-c"]);
    });

    it("sendText 失败时不尝试发送 C-c", async () => {
      const sendText = vi.fn(async () => ({ ok: false as const, code: "session_not_found", message: "err" }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }));

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(sendKeys).not.toHaveBeenCalled();
    });
  });

  // verifyResume——补上 fire-and-forget 留下的 `resumed` 假阳性缺口。镜像
  // ClaudeResumeAdapter.verifyResume，并复用 assessNativeResumeProbe 中现有 Codex 形状，
  // 不增加新的 probe pattern。
  describe("verifyResume", () => {
    const fastOptions = { pollMs: 1, maxWaitMs: 5, sleep: async () => {} };

    it("不会仅凭 Codex 进程名声称已就绪", async () => {
      const adapter = new CodexResumeAdapter(mockTmux({
        getPaneCommand: async () => "codex", capturePaneContent: async () => "",
      }), fastOptions);
      expect(await adapter.resume("pane", "codex_id", "same-id", "/repo")).toMatchObject({ ok: false, code: "resume_failed" });
    });

    it("probe 返回 resumed（codex 前台进程且出现就绪提示）→ { ok: true }", async () => {
      const getPaneCommand = vi.fn(async () => "codex");
      const capturePaneContent = vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything");
      const adapter = new CodexResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CODEX_FLOOR_EFFECT });
      expect(getPaneCommand).toHaveBeenCalled();
    });

    it("probe 在 paneContent 中看到 Codex TUI banner → { ok: true }", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "node",
          capturePaneContent: async () => "OpenAI Codex (v0.42.0)\n  ›  ready\n  gpt-5 · context",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CODEX_FLOOR_EFFECT });
    });

    it("probe 看到 `No saved session found` → { ok: false, code: 'retry_fresh' }", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "codex",
          capturePaneContent: async () => "Error: No saved session found for that token.\n",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("retry_fresh");
        expect(result.message).toContain("找不到所请求 token 对应的已保存 session");
      }
    });

    it("pane 超时后回到 shell → { ok: false, code: 'retry_fresh' }", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          // 轮询期间无法判定（未知命令、内容为空），最终评估时回到 shell。
          getPaneCommand: async () => "zsh",
          capturePaneContent: async () => "",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("retry_fresh");
        expect(result.message).toContain("返回 shell");
      }
    });

    it("probe 在超时后仍无法判定（未知 pane）→ { ok: false, code: 'resume_failed' }", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "unknown-binary",
          capturePaneContent: async () => "still booting...",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("resume_failed");
        expect(result.message).toContain("超时");
      }
    });

    it("轮询直至 resumed：首次无法判定，随后出现 Codex 就绪提示 → { ok: true }", async () => {
      let attempt = 0;
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => (attempt++ === 0 ? "node" : "codex"),
          capturePaneContent: async () => attempt > 1 ? "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything" : "",
        }),
        { pollMs: 1, maxWaitMs: 50, sleep: async () => {} },
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CODEX_FLOOR_EFFECT });
      expect(attempt).toBeGreaterThanOrEqual(2);
    });

    // Codex auth-refusal → 透传 attention_required。镜像 ClaudeResumeAdapter.verifyResume 的
    // evidence 形状（pane 最后 12 行），补齐生命周期场景矩阵中已记录的 Codex 延后项。
    it("probe 报告 attention_required（Codex auth-refusal）→ 返回失败与 evidence", async () => {
      const refusalPane = [
        "$ codex -s workspace-write resume 019d-token",
        "Error: Your access token could not be refreshed because you have since",
        "logged out or signed in to another account. Please sign in again.",
      ].join("\n");
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "zsh",
          capturePaneContent: async () => refusalPane,
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("attention_required");
        expect(result.message).toContain("重新登录");
        // evidence 应为 pane 内容最后 12 行，与 claude-resume.ts:97 的形状完全一致。
        expect((result as { evidence?: string }).evidence).toBeDefined();
        expect((result as { evidence?: string }).evidence).toContain("access token could not be refreshed");
        expect((result as { evidence?: string }).evidence).toContain("Please sign in again");
      }
    });

    it("只有 access-token 短语而无操作员指令时不触发 attention_required", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "codex",
          capturePaneContent: async () => "debug: access token could not be refreshed (retrying...)\nOpenAI Codex (v0.0.0)\n› Ask Codex to do anything",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      // 仍存在就绪提示；auth-refusal pattern 要求两个锚点同时出现。
      expect(result.ok).toBe(true);
    });
  });
});
