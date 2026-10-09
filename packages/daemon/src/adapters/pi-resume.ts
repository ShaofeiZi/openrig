// OPR.0.4.6.PI1 FR-6——Pi 席位 resume（镜像 codex-resume.ts）。
//
// Resume 是诚实的 session 文件续接：使用 `--session <persisted sessionFile>` 重新启动
// pi-runner（精确文件恢复——绝不使用会打开交互选择器且在托管路径中禁止的 `--resume`）。席位
// 绝不声称是热进程恢复（BR-6/架构规则 15 姿态）。session 文件缺失时返回 `retry_fresh`，
// restore orchestrator 将其映射为等待决策的停止询问，绝不静默全新启动。

import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { ResumeResult } from "./claude-resume.js";
import { piTrust } from "./yolo-mode.js";
import {
  piSeatPaths, parsePiRunnerState, buildPiRunnerCommand, buildPendingRunnerState,
} from "./pi-runner-protocol.js";
import { observePiResourceTrust } from "../domain/permission-drift.js";

export { type ResumeResult };

export interface PiResumeFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

interface PiResumeOptions {
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  trustPosture?: "approve" | "no-approve";
  /** 启动尝试 id 铸造（测试注入；默认为 randomUUID）。 */
  newLaunchId?: () => string;
}

export class PiResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private fs: PiResumeFsOps,
    private paths: { stateRoot: string; runnerEntryPath: string },
    private options: PiResumeOptions = {},
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "pi_session_file" && !!resumeToken;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    model?: string | null,
    // OPR.0.4.8.3 接缝 B：持久化的已解析姿态（Pi 使用 resource-trust 表述）。
    resolvedPosture?: "floor" | "full_bypass",
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Pi resume 不可用" };
    }
    const sessionFile = resumeToken!;

    if (!this.fs.exists(sessionFile)) {
      // 诚实的无 session 结果：调用方的 retry_fresh 映射实现等待决策的停止询问（BR-6）。
      return { ok: false, code: "retry_fresh", message: "Pi resume 失败：持久化 session 文件已不存在" };
    }

    const seat = piSeatPaths(this.paths.stateRoot, tmuxSessionName);
    this.fs.mkdirp(seat.agentDir);
    this.fs.mkdirp(seat.sessionsDir);

    // 启动尝试范围（守卫 fold）：输入命令前覆盖之前 runner 实例留下的所有陈旧 sidecar；
    // verifyResume 只信任带当前尝试 launchId 的状态。先读取旧记录，使持久追赶游标
    //（lastEntryId，FR-5）得以保留。
    const launchId = (this.options.newLaunchId ?? (() => randomUUID()))();
    const prior = this.fs.exists(seat.runnerStatePath) ? parsePiRunnerState(this.readSafe(seat.runnerStatePath)) : null;
    this.fs.writeFile(
      seat.runnerStatePath,
      JSON.stringify(buildPendingRunnerState(launchId, new Date().toISOString(), prior)),
    );

    const trust = piTrust(this.options.trustPosture, process.env, resolvedPosture);
    const appliedLaunch = observePiResourceTrust(trust);
    const cmd = buildPiRunnerCommand({
      runnerEntryPath: this.paths.runnerEntryPath,
      sessionName: tmuxSessionName,
      stateRoot: this.paths.stateRoot,
      cwd,
      // model 声明必须跨 resume 保留：runner 的 provider-key allowlist 以声明的 provider 为键
      //（VM 环节发现）。
      model: model ?? undefined,
      // OPR.0.4.8.2：Pi RESOURCE TRUST（不是 permission policy）。与启动路径采用相同决策：
      // YOLO 强制每个恢复席位使用 `approve`；否则使用已配置姿态。
      trust,
      sessionFile,
      launchId,
    });

    const textResult = await this.tmux.sendText(tmuxSessionName, cmd);
    if (!textResult.ok) {
      return { ok: false, code: "resume_failed", message: textResult.message };
    }
    const keyResult = await this.tmux.sendKeys(tmuxSessionName, ["Enter"]);
    if (!keyResult.ok) {
      // 部分失败：命令文本已在缓冲区中，但 Enter 失败。尽力发送 C-c 清除已输入命令。
      await this.tmux.sendKeys(tmuxSessionName, ["C-c"]);
      return { ok: false, code: "resume_failed", message: keyResult.message };
    }

    const result = await this.verifyResume(tmuxSessionName, sessionFile, launchId);
    return result.ok ? { ...result, appliedLaunch } : result;
  }

  // 只轮询 runner 的启动范围 sidecar，绝不读取陈旧 pane scrollback（上一实例的 READY/ERROR
  // 标记会留在 pane 中，甚至同一文件的先前 resume 也会匹配；守卫 fold，code-review
  // qitem-20260707011908）。Resumed = 当前尝试的 sidecar 已 ready 且准确指向请求的 session 文件。
  private async verifyResume(tmuxSessionName: string, sessionFile: string, launchId: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 250;
    const maxWaitMs = this.options.maxWaitMs ?? 15_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const { runnerStatePath } = piSeatPaths(this.paths.stateRoot, tmuxSessionName);
      const state = this.fs.exists(runnerStatePath) ? parsePiRunnerState(this.readSafe(runnerStatePath)) : null;

      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
          return {
            ok: false,
            code: "resume_failed",
            message: `Pi resume 失败：runner 已退出（退出码 ${state.exited.code ?? "未知"}）`,
            evidence: paneContent.split("\n").slice(-12).join("\n"),
          } as ResumeResult;
        }
        if (state.ready) {
          if (state.sessionFile !== sessionFile) {
            return {
              ok: false,
              code: "resume_failed",
              message: "Pi resume 失败：runner 已就绪，但未报告所请求的 session 文件",
            };
          }
          return { ok: true };
        }
      }

      if (attempt < attempts - 1) {
        await sleepFn(pollMs);
      }
    }

    return {
      ok: false,
      code: "resume_failed",
      message: "Pi resume 失败：等待 runner 证明所请求 session 时超时",
    };
  }

  private readSafe(path: string): string {
    try {
      return this.fs.readFile(path);
    } catch {
      return "";
    }
  }
}
