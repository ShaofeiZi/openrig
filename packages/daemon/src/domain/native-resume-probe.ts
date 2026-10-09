import { shellQuote } from "../adapters/shell-quote.js";
import { codexPostureArg } from "../adapters/yolo-mode.js";

// L3 为 Claude 恢复选择提示代理新增 `attention_required`。它与 `inconclusive`
//（尚无法判断）和 `failed`（终态失败）不同：运行时仍存活且可恢复，但需要操作员处理。
export type NativeResumeProbeStatus = "resumed" | "failed" | "inconclusive" | "attention_required";

export interface NativeResumeProbeInput {
  runtime: string | null;
  paneCommand: string | null;
  paneContent: string | null;
}

export interface NativeResumeProbeResult {
  status: NativeResumeProbeStatus;
  code: string;
  detail: string;
}

export interface ProbeShellReadyInput {
  paneCommand: string | null;
  paneContent: string | null;
}

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export function buildNativeResumeCommand(
  runtime: string | null,
  resumeToken: string | null,
  sessionName?: string | null,
  codexConfigProfile?: string | null,
): string | null {
  if (!resumeToken) return null;
  if (runtime === "claude-code") {
    const nameSuffix = sessionName ? ` --name ${shellQuote(sessionName)}` : "";
    return `claude --resume ${shellQuote(resumeToken)}${nameSuffix}`;
  }
  if (runtime === "codex") {
    return buildCodexResumeCore(resumeToken, codexConfigProfile);
  }
  return null;
}

export function buildCodexResumeCore(
  resumeToken: string,
  codexConfigProfile?: string | null,
  useLast?: boolean,
  extraArgs?: string,
  // OPR.0.4.8.3 接缝 B：可选的已解析姿态——启动调用方传递席位已持久化/绑定的姿态；
  // 共享非启动消费者（node inventory、resume-metadata）省略它，并保持字节一致行为。
  resolvedPosture?: "floor" | "full_bypass",
  // 0.5.2-07：席位由 SPEC 固定的模型。启动调用方（旧版恢复）传递该值，使恢复席位使用
  // spec 模型启动，而不是运行时默认模型；非启动消费者（node inventory、resume-metadata）
  // 省略它并保持字节一致。
  model?: string | null,
  /** 启动调用方可传入已解析并将插入的精确片段，避免再次进行策略决策。 */
  precomputedPostureArg?: string,
  /** #69：已安装 Codex 支持 `--no-daemon` 时，启动调用方传 true；缺失时保持字节一致。 */
  daemonOptOut?: boolean,
): string {
  // OPR.0.4.8.2：恢复路径与 fresh/fork 使用同一个姿态决策 codexPostureArg。
  // YOLO 强制使用 -s danger-full-access（即使具名 profile 也会覆盖）；否则具名 profile
  // 自行管理，无 profile 时使用 OpenRig 显式的 -s workspace-write 最低标志。
  const profileArg = codexConfigProfile ? ` -p ${shellQuote(codexConfigProfile)}` : "";
  const profileOrPosture = precomputedPostureArg ?? codexPostureArg(profileArg, process.env, resolvedPosture);
  // 0.5.2-07：-m 是顶层 codex 标志（与全新启动适配器一致），在 resume 子命令前输出。
  const modelArg = model ? ` -m ${shellQuote(model)}` : "";
  const middle = extraArgs ? `${extraArgs} ` : "";
  const tokenArg = useLast ? "--last" : shellQuote(resumeToken);
  const daemonArg = daemonOptOut ? " --no-daemon" : "";
  return `codex${daemonArg}${profileOrPosture}${modelArg} resume ${middle}${tokenArg}`;
}

export function assessNativeResumeProbe(
  input: NativeResumeProbeInput
): NativeResumeProbeResult {
  const runtime = input.runtime ?? "";
  const paneCommand = input.paneCommand ?? "";
  const paneContent = input.paneContent ?? "";

  if (runtime === "claude-code") {
    if (paneContent.includes("No conversation found")) {
      return {
        status: "failed",
        code: "no_conversation_found",
        detail: "Claude 报告请求的会话已不存在。",
      };
    }
    if (looksLikeClaudeResumeSelectionPrompt(paneContent)) {
      return {
        status: "attention_required",
        code: "claude_resume_selection_prompt",
        detail: "Claude 正停在恢复选择提示；操作员必须选择要继续的对话。",
      };
    }
    if (looksLikeClaudeTrustPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "trust_gate",
        detail: "Claude 正等待工作区信任批准，批准后会话才能交互。",
      };
    }
    if (looksLikeClaudeMcpApprovalPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "mcp_gate",
        detail: "Claude 正等待项目 MCP server 批准，批准后会话才能交互。",
      };
    }
    if (looksLikeClaudeLoginPrompt(paneContent)) {
      return {
        status: "failed",
        code: "login_required",
        detail: "Claude 正在运行，但用户登录前无法继续。",
      };
    }
    if (looksLikeClaudeTui(paneContent)) {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Claude 正在探测窗格中运行活动的交互式 TUI。",
      };
    }
    if (paneCommand === "claude") {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Claude 是探测窗格中的活动前台进程。",
      };
    }
    if (SHELL_COMMANDS.has(paneCommand)) {
      return {
        status: "failed",
        code: "returned_to_shell",
        detail: "探测窗格已返回 shell，没有停留在运行时内部。",
      };
    }
    return {
      status: "inconclusive",
      code: "awaiting_runtime",
      detail: "Claude 未报告明确失败，但尚未成为窗格中的活动进程。",
    };
  }

  if (runtime === "codex") {
    if (/requires a newer version of Codex/i.test(paneContent.replace(/\s+/g, " "))) {
      return {
        status: "attention_required", code: "codex_client_incompatible",
        detail: "所选 Codex 客户端无法使用配置的模型。请改用兼容客户端并重试；替换历史记录或更改凭证无法修复此前提。",
      };
    }
    if (paneContent.includes("No saved session found")) {
      return {
        status: "failed",
        code: "no_saved_session",
        detail: "Codex 报告请求的已保存会话不存在。",
      };
    }
    if (looksLikeCodexAuthRefusal(paneContent)) {
      return {
        status: "attention_required",
        code: "codex_auth_refusal",
        detail: "Codex 无法刷新已存储的 access token；操作员必须重新登录才能恢复会话。",
      };
    }
    if (looksLikeCodexModelSelectionPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "model_selection_gate",
        detail: "Codex 正等待选择模型，选择后会话才能交互。",
      };
    }
    // 原生评审面板可能覆盖正常 Codex 标题。仅有标题不能证明提示符可接收启动上下文。
    if (looksLikeCodexHookReviewPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "hook_trust_gate",
        detail: "Codex 正等待 hook 信任批准，批准后会话才能交互。",
      };
    }
    if (looksLikeCodexTui(paneContent)) {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Codex 正在探测窗格中运行活动的交互式 TUI。",
      };
    }
    if (looksLikeCodexTrustPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "trust_gate",
        detail: "Codex 正等待工作区信任批准，批准后会话才能交互。",
      };
    }
    if (paneContent.includes("Update available!") || paneContent.includes("Updating Codex")) {
      return {
        status: "inconclusive",
        code: "update_gate",
        detail: "Codex 已进入更新流程，因此仅有进程存活不能证明对话已恢复。",
      };
    }
    if (SHELL_COMMANDS.has(paneCommand)) {
      return {
        status: "failed",
        code: "returned_to_shell",
        detail: "探测窗格已返回 shell，没有停留在运行时内部。",
      };
    }
    return {
      status: "inconclusive",
      code: "awaiting_runtime",
      detail: "Codex 未报告明确失败，但尚未观测到交互式对话。",
    };
  }

  return {
    status: "inconclusive",
    code: "unsupported_runtime",
    detail: "此运行时没有定义原生恢复探测。",
  };
}

export function isProbeShellReady(input: ProbeShellReadyInput): boolean {
  const paneCommand = input.paneCommand ?? "";
  const paneContent = input.paneContent?.trim() ?? "";
  return SHELL_COMMANDS.has(paneCommand) && paneContent.length > 0;
}

function looksLikeClaudeTui(paneContent: string): boolean {
  const hasPrompt = /(^|\n)\s*❯/.test(paneContent);
  if (!hasPrompt) return false;

  return (
    paneContent.includes("Claude Code v")
    || paneContent.includes("accept edits on")
  );
}

function looksLikeClaudeTrustPrompt(paneContent: string): boolean {
  return paneContent.includes("Accessing workspace:")
    && paneContent.includes("Yes, I trust this folder");
}

// `claude --resume` 找到多个候选对话时会出现 Claude 恢复选择提示；重启后重建对话索引时
// 也可能出现。提示会列出编号选项并要求操作员选择。
//
// L3 不变量：不得自动回答。应呈现为 `attention_required` 并让操作员选择；只有操作员到达
// 可用状态后，后续对账才升级为 `operator_recovered`。
function looksLikeClaudeResumeSelectionPrompt(paneContent: string): boolean {
  // 当前 Claude 选择器（2026-09-04 观测）会询问以何种保真度恢复。必须同时出现标题、
  // 两个选项行和选择光标；仅在散文中出现相同标签有意判定为不足。
  const recentLines = paneContent.split("\n").slice(-30);
  const currentChooserHeading = recentLines.some((line) => line.trim() === "How would you like to resume?");
  const currentChooserOptions = recentLines.filter((line) =>
    /^\s*(?:[❯›]\s+)?(?:Resume from summary|Resume full session as-is)\s*$/.test(line)
  );
  const currentChooserSelection = currentChooserOptions.some((line) => /^\s*[❯›]\s+/.test(line));
  if (
    currentChooserHeading
    && currentChooserSelection
    && currentChooserOptions.some((line) => line.includes("Resume from summary"))
    && currentChooserOptions.some((line) => line.includes("Resume full session as-is"))
  ) return true;

  // 稳定子串由明确的 "Choose ... conversation" 动词与 Claude 输出的编号/箭头选项标记组成。
  // 二者必须同时存在，避免对相似 TUI 字符串产生假阳性。
  const hasChooseVerb =
    paneContent.includes("Choose a conversation")
    || paneContent.includes("Choose the conversation")
    || paneContent.includes("Select a conversation");
  if (!hasChooseVerb) return false;

  // 在近期行中查找编号/箭头选项标记。
  const numberedOption = recentLines.some((line) => /^\s*(?:›\s*)?\d+\.\s+\S/.test(line));
  return numberedOption;
}

function looksLikeClaudeLoginPrompt(paneContent: string): boolean {
  return paneContent.includes("Not logged in")
    && paneContent.includes("Run /login");
}

function looksLikeClaudeMcpApprovalPrompt(paneContent: string): boolean {
  return paneContent.includes("new MCP servers found in .mcp.json")
    && paneContent.includes("Select any you wish to enable")
    && paneContent.includes("Enter to confirm");
}

function looksLikeCodexTui(paneContent: string): boolean {
  const current = paneContent.slice(Math.max(0, paneContent.lastIndexOf("OpenAI Codex (v")));
  if (/model:\s*loading\b/i.test(current)) return false;
  const recentLines = current.trimEnd().split("\n").slice(-20).join("\n");
  const hasPromptLine = recentLines.split("\n").some((line) => {
    const text = line.trimStart();
    return text.startsWith("›") && !/^\d+\.\s/.test(text.slice(1).trimStart());
  });
  const hasModelFooter = /(^|\n)\s{2,}gpt-[^\n]+ · [^\n]+(?:\n|$)/.test(recentLines);
  return hasPromptLine && (current.includes("OpenAI Codex (v") || hasModelFooter);
}

// 已存储 OAuth access token 无法刷新时，Codex 会输出这些消息，例如操作员在其他位置退出、
// 账号变更或设备密钥被撤销。操作员通过 `codex login` 恢复。必须同时命中两个锚点：
// access-token 短语用于区别普通错误，操作员指令短语用于区别偶然包含该短语的内部调试日志。
//
// 来源已在以下 codex-cli 0.125.0 二进制中验证：
// /opt/homebrew/Caskroom/codex/0.125.0/codex-aarch64-apple-darwin:
//   "Your access token could not be refreshed because you have since
//    logged out or signed in to another account. Please sign in again."
//   "Your access token could not be refreshed. Please log out and sign
//    in again."
function looksLikeCodexAuthRefusal(paneContent: string): boolean {
  if (!paneContent.includes("access token could not be refreshed")) return false;
  return (
    paneContent.includes("Please sign in again")
    || paneContent.includes("Please log out and sign in again")
  );
}

function looksLikeCodexTrustPrompt(paneContent: string): boolean {
  return paneContent.includes("Do you trust the contents of this directory?")
    && paneContent.includes("Yes, continue");
}

function looksLikeCodexHookReviewPrompt(paneContent: string): boolean {
  // 较新的标题会取代滚动缓冲区中保留的已关闭提示。
  const current = paneContent.slice(Math.max(0, paneContent.lastIndexOf("OpenAI Codex (v")));
  // 关闭评审面板时可能只重绘输入提示而不生成新标题；后续非菜单式对话提示会取代旧面板。
  const gateEnd = Math.max(current.lastIndexOf("Press t to trust"), current.lastIndexOf("Trust all and continue"));
  if (gateEnd >= 0 && current.slice(gateEnd).split("\n").some((line) => /^\s*›(?:\s|$)/.test(line) && !/^\s*›\s*\d+\.\s/.test(line))) return false;
  return (current.includes("Hooks need review") && current.includes("Trust all and continue"))
    || (/hooks? needs? review before (?:it|they) can run\./.test(current)
      && /Press t to trust(?: all)?;/.test(current));
}

function looksLikeCodexModelSelectionPrompt(paneContent: string): boolean {
  const recentLines = paneContent.split("\n").slice(-20);
  const numberedModelOptions = recentLines.filter((line) => (
    /^\s*(?:›\s*)?\d+\.\s+/.test(line)
    && /\bgpt-[\w.-]+\b/i.test(line)
  ));

  return numberedModelOptions.length >= 2;
}
