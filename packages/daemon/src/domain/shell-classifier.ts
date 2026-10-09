import * as nodePath from "node:path";

/**
 * KI-14 r2-B1——“此 pane 前台是否为裸 shell”的唯一共享答案。在本模块之前，仓库存在三套互相
 * 偏离的硬编码 shell 集合（session-fingerprinter SHELL_NAMES、seat-identity-reconciler
 * SHELL_COMMANDS、codex-resume SHELL_COMMANDS），blank-slate verifier 又增加了漏掉 tcsh/csh 的
 * 第四套；这会让 tmux default-shell 为 /bin/tcsh 的机器在破坏性切换后误报
 * successor_pane_not_blank。消费者应在此分类；legacy 集合属于已跟踪的后续整合，不在缺陷修复中
 * 静默重写。
 */
export const SHELL_FOREGROUND_BASENAMES: ReadonlySet<string> = new Set([
  "bash", "zsh", "sh", "fish", "nu", "dash", "ksh", "tcsh", "csh",
]);

/**
 * `paneCommand`（tmux `pane_current_command`）是否表示裸 shell？
 *
 * - 移除 login-shell 的 "-" 前缀（"-zsh" → "zsh"）。
 * - 接受上方常用 shell 集合。
 * - 提供 `expectedShellPath` 时接受其 basename；选择 respawn 命令的调用方有权定义空白状态，
 *   因此任意配置的默认 shell（r2 的泛化）不会仅因未列出而误报失败。
 */
export function isShellForeground(paneCommand: string, expectedShellPath?: string | null): boolean {
  const observed = paneCommand.startsWith("-") ? paneCommand.slice(1) : paneCommand;
  if (SHELL_FOREGROUND_BASENAMES.has(observed)) return true;
  if (expectedShellPath) {
    const expected = nodePath.basename(expectedShellPath.trim());
    if (expected && observed === expected) return true;
  }
  return false;
}
