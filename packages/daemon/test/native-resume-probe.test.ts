import { describe, expect, it } from "vitest";
import {
  assessNativeResumeProbe,
  buildNativeResumeCommand,
  buildCodexResumeCore,
  isProbeShellReady,
} from "../src/domain/native-resume-probe.js";

describe("原生恢复探针", () => {
  it("关闭 hook 评审后接受新输入提示，无需另一条标题", () => {
    const paneContent = "OpenAI Codex (v0.153.4)\n1 hook needs review before it can run.\nPress t to trust; esc to go back\n› Ask Codex to do anything\n  gpt-6-astra xhigh · /work";
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "node", paneContent }).status).toBe("resumed");
  });
  it.each(["", "OpenAI Codex (v0.153.4)", "OpenAI Codex (v0.153.4)\nmodel: loading\n› Ask Codex to do anything"])("不把进程/标题启动视为交互式对话：%s", (paneContent) => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "codex", paneContent }).status).toBe("inconclusive");
  });
  it.each([
    "Hooks need review\n2 hooks are new or changed.\n2. Trust all and continue",
    "Hooks\nLifecycle hooks from config and enabled plugins.\n2 hooks need review before they can run.\nPress t to trust all; enter to review hooks; esc to close",
    "PostCompact hooks\n1 hook needs review before it can run.\nTrust     New hook - review required\nPress t to trust; esc to go back",
  ])("即使存在原生标题，hook 评审仍保持不可用：%s", (panel) => {
    const result = assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: `OpenAI Codex (v0.153.4)\nmodel: gpt-6-astra\n${panel}` });
    expect(result).toMatchObject({ status: "inconclusive", code: "hook_trust_gate" });
  });

  it("不把更新原生标题之前的 hook 评审视为当前门禁", () => {
    const result = assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: "Hooks need review\n2. Trust all and continue\nOpenAI Codex (v0.153.4)\n› Ready" });
    expect(result.status).toBe("resumed");
  });

  it("将可见的客户端/模型兼容失败与可用 TUI 区分开", () => {
    const result = assessNativeResumeProbe({ runtime: "codex", paneCommand: "node",
      paneContent: "OpenAI Codex\n■ The configured model requires a\nnewer version of Codex. Please upgrade.\n› Write tests for @filename" });
    expect(result).toMatchObject({ status: "attention_required", code: "codex_client_incompatible" });
    expect(result.detail).toContain("更改凭证无法修复");
  });
  it("提供标准会话名时构建 Claude 恢复命令", () => {
    expect(
      buildNativeResumeCommand("claude-code", "abc-123", "dev-impl@demo-rig")
    ).toBe("claude --resume 'abc-123' --name 'dev-impl@demo-rig'");
  });

  it("使用显式 -s workspace-write 最低标志构建无 profile 的 Codex 恢复命令", () => {
    expect(buildNativeResumeCommand("codex", "019d-token")).toBe(
      "codex -s workspace-write resume '019d-token'"
    );
  });

  it("使用 -p 标志构建带 profile 的 Codex 恢复命令", () => {
    expect(buildNativeResumeCommand("codex", "019d-token", null, "my-profile")).toBe(
      "codex -p 'my-profile' resume '019d-token'"
    );
  });

  it("缺少运行时或令牌时返回 null", () => {
    expect(buildNativeResumeCommand("terminal", "x")).toBeNull();
    expect(buildNativeResumeCommand("claude-code", null)).toBeNull();
  });

  describe("buildCodexResumeCore（共享构建器）", () => {
    it("无 profile 时输出与全新启动一致的显式 -s workspace-write 最低标志", () => {
      expect(buildCodexResumeCore("tok-123")).toBe(
        "codex -s workspace-write resume 'tok-123'"
      );
    });

    it("profile 输出 -p 标志，不输出姿态标志", () => {
      expect(buildCodexResumeCore("tok-123", "dev-profile")).toBe(
        "codex -p 'dev-profile' resume 'tok-123'"
      );
    });

    it("useLast 输出 --last 而非令牌", () => {
      expect(buildCodexResumeCore("", null, true)).toBe(
        "codex -s workspace-write resume --last"
      );
    });

    it("profile + useLast 输出 -p + --last", () => {
      expect(buildCodexResumeCore("", "my-prof", true)).toBe(
        "codex -p 'my-prof' resume --last"
      );
    });

    it("0.5.2-07：SPEC 固定的模型在 resume 子命令前输出 -m（旧版恢复携带模型）", () => {
      expect(buildCodexResumeCore("tok-123", null, false, undefined, undefined, "gpt-5.4-cheap")).toBe(
        "codex -s workspace-write -m 'gpt-5.4-cheap' resume 'tok-123'"
      );
    });
  });

  it("将 Claude 无对话输出分类为失败", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "zsh",
        paneContent: "No conversation found with session ID: abc123\nuser@example.test %",
      })
    ).toEqual({
      status: "failed",
      code: "no_conversation_found",
      detail: "Claude 报告请求的会话已不存在。",
    });
  });

  it("将含活跃 claude 窗格的 Claude 分类为已恢复", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent: "Working on it…",
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Claude 是探测窗格中的活动前台进程。",
    });
  });

  it("将 Claude 工作区信任提示分类为受阻，而非已恢复", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent: [
          "Accessing workspace:",
          "/some/workspace",
          "",
          "Quick safety check: Is this a project you created or one you trust?",
          "1. Yes, I trust this folder",
          "2. No, exit",
        ].join("\n"),
      })
    ).toEqual({
      status: "inconclusive",
      code: "trust_gate",
      detail: "Claude 正等待工作区信任批准，批准后会话才能交互。",
    });
  });

  it("将 Claude MCP 项目服务器批准界面分类为受阻，而非失败", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude.exe",
        paneContent: [
          "────────────────────────────────────────────────────────────────────────────────",
          "  2 new MCP servers found in .mcp.json",
          "  Select any you wish to enable.",
          "",
          "  MCP servers may execute code or access system resources. All tool calls",
          "  require approval. Learn more in the MCP documentation.",
          "",
          "  ❯ [✔] exa",
          "    [✔] context7",
          " Space to select · Enter to confirm · Esc to reject all",
        ].join("\n"),
      })
    ).toEqual({
      status: "inconclusive",
      code: "mcp_gate",
      detail: "Claude 正等待项目 MCP server 批准，批准后会话才能交互。",
    });
  });

  it("即使 tmux 报告版本字符串进程，也将实时 Claude TUI 分类为已恢复", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.x",
        paneContent: [
          "Claude Code vX.Y.Z",
          "❯ Working on a task.",
          "────────────────────────────────────────────────────────────────────────────────",
          "  ? for shortcuts                                             ● high · /effort",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Claude 正在探测窗格中运行活动的交互式 TUI。",
    });
  });

  it("即使快捷键页脚尚未渲染，也将当前 Claude 欢迎 TUI 分类为已恢复", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.x",
        paneContent: [
          " ▐▛███▜▌   Claude Code vX.Y.Z",
          "▝▜█████▛▘  Model details here",
          "  ▘▘ ▝▝    /some/workspace",
          "",
          "────────────────────────────────────────────────────────────────────────────────",
          "❯ ",
          "────────────────────────────────────────────────────────────────────────────────",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Claude 正在探测窗格中运行活动的交互式 TUI。",
    });
  });

  it("将当前 Claude 编辑批准页脚分类为已恢复", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.x",
        paneContent: [
          "Loading startup skills and recovering identity.",
          "",
          "────────────────────────────────────────────────────────────────────────────────",
          "❯ ",
          "────────────────────────────────────────────────────────────────────────────────",
          "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Claude 正在探测窗格中运行活动的交互式 TUI。",
    });
  });

  it("将 Claude 要求登录界面分类为失败，而非已恢复", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.x",
        paneContent: [
          " ▐▛███▜▌   Claude Code v2.1.101",
          "▝▜█████▛▘  Sonnet 4.6 · API Usage Billing",
          "  ▘▘ ▝▝    /workspace",
          "",
          "────────────────────────────────────────────────────────────────────────────────",
          "❯ ",
          "────────────────────────────────────────────────────────────────────────────────",
          "                                                    Not logged in · Run /login",
          "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
        ].join("\n"),
      })
    ).toEqual({
      status: "failed",
      code: "login_required",
      detail: "Claude 正在运行，但用户登录前无法继续。",
    });
  });

  it("将 Codex 会话缺失输出分类为失败", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent: "ERROR: No saved session found with ID 019d...",
      })
    ).toEqual({
      status: "failed",
      code: "no_saved_session",
      detail: "Codex 报告请求的已保存会话不存在。",
    });
  });

  it("将 Codex 工作区信任提示分类为受阻，而非已恢复", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: [
          "> You are in /some/workspace",
          "",
          "  Do you trust the contents of this directory? Working with untrusted contents",
          "  comes with higher risk of prompt injection.",
          "",
          "› 1. Yes, continue",
          "  2. No, quit",
          "",
          "  Press enter to continue",
        ].join("\n"),
      })
    ).toEqual({
      status: "inconclusive",
      code: "trust_gate",
      detail: "Codex 正等待工作区信任批准，批准后会话才能交互。",
    });
  });

  it("当前 TUI 出现在滚动缓冲区的旧信任提示下方时，将 Codex 分类为活跃", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: [
          "> You are in /some/workspace",
          "",
          "  Do you trust the contents of this directory? Working with untrusted contents",
          "",
          "› 1. Yes, continue",
          "  2. No, quit",
          "",
          "╭────────────────────────────────────────────────────╮",
          "│ >_ OpenAI Codex (v0.130.0)                         │",
          "╰────────────────────────────────────────────────────╯",
          "",
          "› Write tests for @filename",
          "",
          "  gpt-5.5 xhigh fast · Context 0% used · Fast on",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Codex 正在探测窗格中运行活动的交互式 TUI。",
    });
  });

  it("将 Codex 更新提示分类为无法判断", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: "✨ Update available! 0.117.0 -> 0.118.0\nPress enter to continue",
      })
    ).toEqual({
      status: "inconclusive",
      code: "update_gate",
      detail: "Codex 已进入更新流程，因此仅有进程存活不能证明对话已恢复。",
    });
  });

  it("在运行时活跃前将 Codex 编号模型选择提示分类为受阻", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: [
          "╭───────────────────────────────────────╮",
          "│ >_ OpenAI Codex (v0.124.0)            │",
          "╰───────────────────────────────────────╯",
          "",
          "› 1. Switch to gpt-5.1-codex-mini Optimized for codex. Cheaper,",
          "  2. Switch to gpt-5.4-codex Stronger for complex tasks.",
          "  3. Keep current model",
          "",
          "  gpt-5.4 default · ~/code/openrig",
        ].join("\n"),
      })
    ).toEqual({
      status: "inconclusive",
      code: "model_selection_gate",
      detail: "Codex 正等待选择模型，选择后会话才能交互。",
    });
  });

  it("不依赖采样提示措辞，按结构识别 Codex 编号模型选项", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: [
          "› 1. gpt-5.1-codex-mini",
          "  2. gpt-5.4-codex",
          "",
          "  gpt-5.4 default · ~/code/openrig",
        ].join("\n"),
      }).code
    ).toBe("model_selection_gate");
  });

  it("旧更新横幅仍留在滚动缓冲区但实时 TUI 已出现时，将 Codex 分类为已恢复", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: [
          "✨ Update available! 0.120.0 -> 0.121.0",
          "Run npm install -g @openai/codex to update.",
          "",
          "╭───────────────────────────────────────╮",
          "│ >_ OpenAI Codex (v0.120.0)            │",
          "│                                       │",
          "│ model:     gpt-5.4   /model to change │",
          "│ directory: ~/code/openrig             │",
          "╰───────────────────────────────────────╯",
          "",
          "› Improve documentation in @filename",
          "",
          "  gpt-5.4 default · ~/code/openrig",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Codex 正在探测窗格中运行活动的交互式 TUI。",
    });
  });

  it("tmux 报告 node、标题已滚出但实时提示页脚仍存在时，将 Codex 分类为已恢复", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "node",
        paneContent: [
          "› Without using tools or reading files, reply in exactly one line: CONFIRM",
          "  CODEX2_B_20260418T1431 crimson-delta-pulse. Remember both exact lines for",
          "  later continuity verification.",
          "",
          "",
          "• CONFIRM CODEX2_B_20260418T1431 crimson-delta-pulse",
          "",
          "",
          "› Use /skills to list available skills",
          "",
          "  gpt-5.4 default · ~/code/openrig",
          "",
          "",
        ].join("\n"),
      })
    ).toEqual({
      status: "resumed",
      code: "active_runtime",
      detail: "Codex 正在探测窗格中运行活动的交互式 TUI。",
    });
  });

  it("没有原生提示符的前台 Codex 进程保持未验证", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex-aarch64-a",
        paneContent: "Ready.",
      })
    ).toEqual({
      status: "inconclusive",
      code: "awaiting_runtime",
      detail: "Codex 未报告明确失败，但尚未观测到交互式对话。",
    });
  });

  it("将已知交互式运行时回退到 shell 分类为失败", () => {
    expect(
      assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent: "user@example.test %",
      })
    ).toEqual({
      status: "failed",
      code: "returned_to_shell",
      detail: "探测窗格已返回 shell，没有停留在运行时内部。",
    });
  });

  it("仅在探测 shell 已渲染提示内容后才报告就绪", () => {
    expect(
      isProbeShellReady({
        paneCommand: "zsh",
        paneContent: "",
      })
    ).toBe(false);

    expect(
      isProbeShellReady({
        paneCommand: "zsh",
        paneContent: "user@example.test rigged % ",
      })
    ).toBe(true);

    expect(
      isProbeShellReady({
        paneCommand: "claude",
        paneContent: "Claude Code v2.1.89",
      })
    ).toBe(false);
  });

  // L3：Claude 恢复选择提示 → attention_required。
  describe("Claude 恢复选择提示（L3）", () => {
    it("将带编号的 Claude 恢复选择提示分类为 attention_required", () => {
      const paneContent = [
        "Claude Code v2.1.89",
        "",
        "Choose a conversation to resume:",
        "",
        "  1. project-foo (modified 2h ago)",
        "  2. project-bar (modified yesterday)",
        "  3. project-baz (modified last week)",
        "",
        "Enter a number, or press q to cancel.",
      ].join("\n");

      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent,
      });

      expect(result.status).toBe("attention_required");
      expect(result.code).toBe("claude_resume_selection_prompt");
    });

    it("将带 › 箭头的恢复选择提示变体分类为 attention_required", () => {
      const paneContent = [
        "Choose the conversation to resume:",
        "",
        "› 1. recent project",
        "  2. older project",
      ].join("\n");

      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent,
      });

      expect(result.status).toBe("attention_required");
    });

    it("将当前双选项恢复模式提示分类为 attention_required", () => {
      const paneContent = [
        "How would you like to resume?",
        "",
        "❯ Resume from summary",
        "  Resume full session as-is",
      ].join("\n");

      const result = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent });

      expect(result).toMatchObject({ status: "attention_required", code: "claude_resume_selection_prompt" });
    });

    it("仅在散文中提及一个当前选择器选项时不进行分类", () => {
      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent: "The recovery notes recommend Resume from summary when context is stale.",
      });

      expect(result.status).not.toBe("attention_required");
    });

    it("活动 TUI 散文中同时出现两个当前选择器标签时不误分类", () => {
      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "2.1.89",
        paneContent: [
          "Claude Code v2.1.89",
          "❯ Compare Resume from summary with Resume full session as-is in the recovery notes.",
          "────────────────────────────────────────────────────────────────────────────────",
          "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
        ].join("\n"),
      });

      expect(result).toMatchObject({ status: "resumed", code: "active_runtime" });
    });

    it("不将 Claude 活动 TUI 分类为恢复选择提示（回归）", () => {
      const paneContent = [
        "Claude Code v2.1.89",
        "",
        " ❯ accept edits on",
        "",
        "[work in progress]",
      ].join("\n");

      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent,
      });

      // 不应为 attention_required——这是活动 TUI 情况。
      expect(result.status).toBe("resumed");
      expect(result.code).toBe("active_runtime");
    });

    it("仅提及 'Choose a conversation' 且无编号选项时不进行分类", () => {
      const paneContent = "The docs say: 'Choose a conversation to focus on.'";
      const result = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand: "claude",
        paneContent,
      });

      // 没有编号选项列表，就不是真实提示。
      expect(result.status).not.toBe("attention_required");
    });
  });

  // Codex 认证拒绝 -> attention_required。关闭生命周期场景矩阵 slice 中记录的延期项。
  // 窗格模式逐字取自 codex-cli 0.125.0 二进制字符串（令牌刷新失败路径）。
  describe("Codex 认证拒绝识别", () => {
    it("将 Codex 退出后的令牌刷新失败分类为 attention_required", () => {
      const paneContent = [
        "$ codex -s workspace-write resume 019d-token",
        "Error: Your access token could not be refreshed because you have since",
        "logged out or signed in to another account. Please sign in again.",
      ].join("\n");
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent,
      });
      expect(result).toEqual({
        status: "attention_required",
        code: "codex_auth_refusal",
        detail: "Codex 无法刷新已存储的 access token；操作员必须重新登录才能恢复会话。",
      });
    });

    it("将带有 `log out and sign in` 指引的 Codex 令牌刷新失败分类为 attention_required", () => {
      const paneContent = [
        "$ codex -s workspace-write resume 019d-token",
        "Your access token could not be refreshed.",
        "Please log out and sign in again.",
      ].join("\n");
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent,
      });
      expect(result.status).toBe("attention_required");
      expect(result.code).toBe("codex_auth_refusal");
    });

    it("同时要求 access-token 短语和操作员指令短语（反例）", () => {
      // 仅有 access-token 短语（没有操作员指令）不符合条件——它可能偶然出现在调试输出中。
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: "debug: access token could not be refreshed (retrying...)",
      });
      expect(result.status).not.toBe("attention_required");
    });

    it("不与 no_saved_session 冲突（不同代码路径）", () => {
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "zsh",
        paneContent: "ERROR: No saved session found with ID 019d...",
      });
      expect(result.code).toBe("no_saved_session");
      expect(result.status).toBe("failed");
    });

    it("不与 trust_gate 冲突", () => {
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: [
          "Do you trust the contents of this directory?",
          "› 1. Yes, continue",
          "  2. No, quit",
        ].join("\n"),
      });
      expect(result.code).toBe("trust_gate");
    });

    it("将 Codex hook 评审提示分类为 hook_trust_gate", () => {
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: [
          "Hooks need review",
          "3 hooks are new or changed.",
          "1. Review hooks",
          "2. Trust all and continue",
          "3. Continue without trusting (hooks won't run)",
        ].join("\n"),
      });
      expect(result.code).toBe("hook_trust_gate");
      expect(result.status).toBe("inconclusive");
    });

    it("codex 位于前台且没有认证拒绝文本时，不与 active_runtime 冲突", () => {
      const result = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand: "codex",
        paneContent: "OpenAI Codex (v0.125.0)\n  ›  ready\n  gpt-5 · context",
      });
      expect(result.status).toBe("resumed");
      expect(result.code).toBe("active_runtime");
    });
  });
});
