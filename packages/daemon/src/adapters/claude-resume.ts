import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import { shellQuote } from "./shell-quote.js";
import { claudePostureFlag, claudeClassicRendererEnvPrefix } from "./yolo-mode.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { observeClaudePermission, type AppliedLaunchObservation } from "../domain/permission-drift.js";
import { unresolvedClaudePermissionModes } from "../domain/native-permission-selection.js";
import type { ClaudeManagedLaunch } from "../domain/claude-managed-launch.js";

export type ResumeResult =
  | { ok: true; appliedLaunch?: AppliedLaunchObservation }
  // L3：`attention_required` 是非终态失败——Claude 仍存活且可恢复，但 resume 选择提示正在
  // 阻塞。调用方映射为 restoreOutcome=attention_required（按决策 2 不得自动回答）。
  | { ok: false; code: "attention_required"; message: string; evidence?: string }
  | { ok: false; code: string; message: string };

const CLAUDE_TYPES = new Set(["claude_name", "claude_id"]);
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

interface ClaudeResumeOptions {
  claudeManagedLaunch?: ClaudeManagedLaunch;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ClaudeResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private options: ClaudeResumeOptions = {}
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    if (!resumeType || !CLAUDE_TYPES.has(resumeType)) return false;
    if (!resumeToken) return false;
    return true;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    // OPR.0.4.8.3 接缝 B：席位持久化的已解析姿态（restore 时重新派生）；缺失时沿用
    // 0.4.8.2 的环境决策。
    resolvedPosture?: "floor" | "full_bypass",
    // 0.5.2-07：席位由 spec 固定的 model。作为尾部参数，使把 resolvedPosture 作为第 5 个参数的
    // 现有位置调用保持正确；沿调用链传递，使 legacy（不感知 pod）restore 以 spec model 而非
    // runtime 默认值启动恢复后的席位；缺失时命令逐字节不变。
    model?: string | null,
    selectedPermissionMode?: string,
    nodeId?: string,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Claude resume 不可用" };
    }

    // OPR.0.4.8.2：每个席位的 restore 路径都使用与全新启动相同的启动姿态决策（关闭 YOLO
    // 时无条件采用 acceptEdits floor；开启时完全 bypass）。0.5.2-07：--model 与全新启动
    // adapter（claude-code-adapter）一致，放在 posture 之后。
    const modelArg = model ? ` --model ${shellQuote(model)}` : "";
    let managed: Awaited<ReturnType<ClaudeManagedLaunch["prepare"]>> | undefined;
    if (selectedPermissionMode !== undefined) {
      try {
        if (!nodeId || !this.options.claudeManagedLaunch) await unresolvedClaudePermissionModes();
        managed = await this.options.claudeManagedLaunch!.prepare({ nodeId: nodeId!, cwd, session: tmuxSessionName }, selectedPermissionMode);
      } catch (error) { return { ok: false, code: "permission_selection_refused", message: (error as Error).message }; }
    }
    const permissionMode = claudePostureFlag(process.env, resolvedPosture, selectedPermissionMode);
    const appliedLaunch = observeClaudePermission(permissionMode);
    const cmd = managed ? managed.command(["--permission-mode", selectedPermissionMode!, ...(model ? ["--model", model] : []), "--resume", resumeToken!])
      : `${claudeClassicRendererEnvPrefix(process.env)}claude ${permissionMode}${modelArg} --resume ${shellQuote(resumeToken!)}`;

    const textResult = managed ? await this.tmux.sendShellCommand(tmuxSessionName, cmd, managed.assertCurrent)
      : await this.tmux.sendText(tmuxSessionName, cmd);
    if (!textResult.ok) {
      // sendText 失败——缓冲区没有内容，无需清理。
      return { ok: false, code: "resume_failed", message: textResult.message };
    }

    const keyResult = managed ? { ok: true as const } : await this.tmux.sendKeys(tmuxSessionName, ["Enter"]);
    if (!keyResult.ok) {
      // 部分失败：命令文本已在缓冲区中，但 Enter 失败。尽力发送 C-c 清除已输入命令。
      await this.tmux.sendKeys(tmuxSessionName, ["C-c"]);
      return { ok: false, code: "resume_failed", message: keyResult.message };
    }

    const result = await this.verifyResume(tmuxSessionName);
    return result.ok ? { ...result, appliedLaunch } : result;
  }

  private async verifyResume(tmuxSessionName: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 200;
    const maxWaitMs = this.options.maxWaitMs ?? 5_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSessionName);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_conversation_found") {
        return {
          ok: false,
          code: "retry_fresh",
          message: "Claude resume 失败：找不到所请求 session 的会话",
        };
      }

      // L3：Claude resume 选择提示 → attention_required（不是 failed）。runtime 仍存活且可恢复，
      // 但被操作员选择阻塞。决策 2 禁止自动回答；应展示证据并让操作员/UI 处理，之后 pane 达到
      // 可用状态时，协调流程可升级为 operator_recovered。
      if (probe.status === "attention_required") {
        return {
          ok: false,
          code: "attention_required",
          message: probe.detail,
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (probe.status === "resumed") {
        return { ok: true };
      }

      if (attempt < attempts - 1) {
        await sleepFn(pollMs);
      }
    }

    const finalCommand = await this.tmux.getPaneCommand(tmuxSessionName);
    const finalContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
    const finalProbe = assessNativeResumeProbe({
      runtime: "claude-code",
      paneCommand: finalCommand,
      paneContent: finalContent,
    });

    if (finalProbe.status === "resumed") {
      return { ok: true };
    }

    if (finalCommand && SHELL_COMMANDS.has(finalCommand)) {
      return {
        ok: false,
        code: "retry_fresh",
        message: "Claude resume 失败：pane 返回 shell，而未进入 Claude",
      };
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "Claude resume 失败：等待 Claude 进入活跃状态超时",
    };
  }
}
