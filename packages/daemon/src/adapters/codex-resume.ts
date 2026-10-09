import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import type { ResumeResult } from "./claude-resume.js";
import { assessNativeResumeProbe, buildCodexResumeCore } from "../domain/native-resume-probe.js";
import { runSyncSite } from "../domain/sync-site-wrap.js";
import { shellQuote } from "./shell-quote.js";
import { codexPostureArg } from "./yolo-mode.js";
import { observeCodexSandbox } from "../domain/permission-drift.js";
import { unknownDaemonSupportMessage, type CodexDaemonSupportDetector } from "../domain/codex-daemon-support.js";

const CODEX_TYPES = new Set(["codex_id", "codex_last"]);
const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export { type ResumeResult };

interface CodexResumeOptions {
  launchPath?: string;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  exec?: (cmd: string) => Promise<string>;
  /** #69：已安装 Codex 是否支持 --no-daemon；缺失时保持现有调用。 */
  detectDaemonSupport?: CodexDaemonSupportDetector;
}

export class CodexResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private options: CodexResumeOptions = {}
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    if (!resumeType || !CODEX_TYPES.has(resumeType)) return false;
    // codex_last 不需要 token。
    if (resumeType === "codex_last") return true;
    // codex_id 需要 token。
    if (!resumeToken) return false;
    return true;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    codexConfigProfile?: string | null,
    // OPR.0.4.8.3 接缝 B：从 restore 贯穿传入的持久化已解析姿态。
    resolvedPosture?: "floor" | "full_bypass",
    // 0.5.2-07：席位由 spec 固定的 model。作为尾部参数，使把 resolvedPosture 作为第 6 个参数的
    // 现有位置调用保持正确；沿调用链传递，使 legacy（不感知 pod）restore 以 spec model 而非
    // runtime 默认值启动恢复后的席位；缺失时命令逐字节不变。
    model?: string | null,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Codex resume 不可用" };
    }

    if (codexConfigProfile?.trim()) {
      const { verifyCodexProfileLoads } = await import("../domain/codex-profile-preflight.js");
      const execFn = this.options.exec ?? (async (cmd: string) => {
        const { execSync } = await import("node:child_process");
        return runSyncSite("codex.resume.profile_preflight", () =>
          execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 })
        );
      });
      const probeResult = await verifyCodexProfileLoads(codexConfigProfile, execFn);
      if (!probeResult.ok) {
        return {
          ok: false,
          code: "resume_failed",
          message: `Profile 预检失败：${probeResult.error}${probeResult.migrationHint ? `\n  修复：${probeResult.migrationHint}` : ""}`,
        };
      }
    }

    // #69：针对恢复后 pane 实际运行的 Codex 进行检测（其 cwd 与启动 PATH）。
    const daemonSupport = this.options.detectDaemonSupport ? await this.options.detectDaemonSupport(cwd) : undefined;
    if (daemonSupport?.kind === "unknown") {
      return { ok: false, code: "resume_failed", message: unknownDaemonSupportMessage(daemonSupport.detail) };
    }

    const profileArg = codexConfigProfile ? ` -p ${shellQuote(codexConfigProfile)}` : "";
    const postureArg = codexPostureArg(profileArg, process.env, resolvedPosture);
    const appliedLaunch = observeCodexSandbox(postureArg);
    const cmd = buildCodexResumeCore(
      resumeToken ?? "",
      codexConfigProfile,
      resumeType === "codex_last",
      undefined,
      resolvedPosture,
      model,
      postureArg,
      daemonSupport?.kind === "supported",
    );

    const textResult = await this.tmux.sendShellCommand(tmuxSessionName, this.options.launchPath
      ? `env PATH=${shellQuote(this.options.launchPath)} ${cmd}` : cmd);
    if (!textResult.ok) {
      return { ok: false, code: "resume_failed", message: textResult.message };
    }

    const result = await this.verifyResume(tmuxSessionName);
    return result.ok ? { ...result, appliedLaunch } : result;
  }

  // 镜像 ClaudeResumeAdapter.verifyResume：轮询 pane，运行原生 probe，并根据可观察 runtime
  // 状态返回 resumed/retry_fresh/attention_required/resume_failed。`attention_required` 结果
  //（Codex 鉴权拒绝——已存 OAuth token 无法再刷新）关闭生命周期场景矩阵 slice 记录的延后项。
  private async verifyResume(tmuxSessionName: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 200;
    const maxWaitMs = this.options.maxWaitMs ?? 5_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSessionName);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_saved_session") {
        return {
          ok: false,
          code: "retry_fresh",
          message: "Codex resume 失败：找不到所请求 token 对应的已保存 session",
        };
      }

      // Codex 鉴权拒绝表示仍存活但可恢复：已存 access token 无法再刷新。展示证据（pane 最后
      // 12 行），让操作员/UI 决定执行 `codex login` 后继续，还是把席位标为永久重建。
      // 镜像 Claude 的证据结构。
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
      runtime: "codex",
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
        message: "Codex resume 失败：pane 返回 shell，而未进入 Codex",
      };
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "Codex resume 失败：等待 Codex 进入活跃状态超时",
    };
  }
}
