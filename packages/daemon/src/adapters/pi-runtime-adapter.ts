// OPR.0.4.6.PI1——Pi runtime adapter（RPC 优先，runner 位于 pane 中）。
//
// adapter 在席位常规 tmux pane 内启动 OpenRig 所有的 pi-runner；runner 承载
// `pi --mode rpc`（无头 JSONL——Pi 的一等集成界面）。send/capture 保持 tmux 原生，不是
// adapter 方法（runner 将 pane stdin 转发给 RPC prompt/steer，并把易读 transcript 镜像到
// pane stdout）；activity + session 身份来自 Pi 的类型化 RPC 事件与 get_state，经 runner
// sidecar 和 bus 发出，绝不抓取 pane（BR-1）。TUI 原生 Pi 是独立的未来契约，绝不是此处
// 隐藏模式（BR-2）。

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { piTrust } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { observePiResourceTrust } from "../domain/permission-drift.js";
import {
  piSeatPaths, parsePiRunnerState, buildPiRunnerCommand, buildPendingRunnerState,
  PI_RUNNER_READY_MARKER, PI_RUNNER_ERROR_MARKER, PI_RUNNER_EXIT_MARKER,
  type PiRunnerState,
} from "./pi-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface PiAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
}

export interface PiRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: PiAdapterFsOps;
  /** 每个 Pi 席位创建隔离状态目录所用的根（FR-7），通常为 <OPENRIG_HOME>/state/pi。 */
  stateRoot: string;
  /** daemon dist 中已编译 pi-runner 入口的绝对路径。 */
  runnerEntryPath: string;
  /** 托管启动的 trust 姿态（BR-5——始终显式；环境中的 `ask` 在 RPC 模式下会静默跳过）。
   * 默认 `no-approve`（保守 floor；席位级 guidance/skills 位于席位托管 agent 目录，
   * 不需要项目 trust）。 */
  trustPosture?: "approve" | "no-approve";
  sleep?: (ms: number) => Promise<void>;
  /** 启动尝试 id 铸造（测试注入；默认为 randomUUID）。 */
  newLaunchId?: () => string;
}

export class PiRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "pi";
  private tmux: TmuxAdapter;
  private fs: PiAdapterFsOps;
  private stateRoot: string;
  private runnerEntryPath: string;
  private trustPosture: "approve" | "no-approve";
  private sleep: (ms: number) => Promise<void>;
  private newLaunchId: () => string;

  constructor(deps: PiRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.runnerEntryPath = deps.runnerEntryPath;
    this.trustPosture = deps.trustPosture ?? "no-approve";
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  /** resume-token-capture 消费的 pi-runner sidecar 读取器结构
   *（deriveResumeToken 的 piRunnerStateStore 依赖）。 */
  readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string } {
    const state = this.readRunnerState(sessionName);
    if (state === null) {
      const { runnerStatePath } = piSeatPaths(this.stateRoot, sessionName);
      return this.fs.exists(runnerStatePath)
        ? { ok: false, reason: "parse_error" }
        : { ok: false, reason: "missing_sidecar" };
    }
    if (!state.sessionFile) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionFile: state.sessionFile };
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const sessionName = binding.tmuxSession;
    if (!sessionName) return results;
    const { agentDir } = piSeatPaths(this.stateRoot, sessionName);
    const skillsDir = nodePath.join(agentDir, "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding)) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            // 增量合并 context 文件（Omnigent 最佳实践：绝不替换 Pi 的默认 system prompt）。
            // Pi 从托管 cwd 读取 AGENTS.md 作为项目 context 文件。
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // 跳过 rig-role：不计为已投递。
            break;
          }
          case "skill_install": {
            if (!binding.tmuxSession) throw new Error("未绑定 tmux session——无法解析 Pi 席位状态目录");
            const { agentDir } = piSeatPaths(this.stateRoot, binding.tmuxSession);
            const targetDir = nodePath.join(agentDir, "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              // runner 读取 pane stdin，并作为 RPC prompt 转发（FR-3）。
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        }
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "未绑定 tmux session——无法启动 Pi harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken 与 forkSource 互斥——请选择一个" };
    }

    let forkRef: string | undefined;
    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `pi fork：v1 不支持 ref.kind="${opts.forkSource.kind}"；请使用 ref.kind="native_id" 并提供父 session 文件路径或 session id`,
        };
      }
      forkRef = opts.forkSource.value?.trim();
      if (!forkRef) {
        return { ok: false, error: "pi fork：必须提供 forkSource.value（父 session 文件路径或 session id）" };
      }
    }

    if (opts.resumeToken) {
      // 向 pane 输入任何内容之前的有效性底线。
      const validation = validateResumeToken("pi", opts.resumeToken);
      if (!validation.ok) {
        return { ok: false, error: `Pi 续接：${validation.error}` };
      }
      if (!this.fs.exists(opts.resumeToken)) {
        // Session 文件已消失——如实结果是调用方停止并询问（awaiting-decision），绝不静默
        // 全新启动（BR-6）。
        return { ok: false, error: "pi resume：持久化 session 文件已不存在", recovery: "retry_fresh" };
      }
    }

    const sessionName = binding.tmuxSession;
    const paths = piSeatPaths(this.stateRoot, sessionName);
    this.fs.mkdirp(paths.agentDir);
    this.fs.mkdirp(paths.sessionsDir);

    // 启动尝试范围（守卫 fold）：输入命令前用 pending 记录覆盖上一 runner 实例的所有陈旧
    // sidecar，且只信任带当前尝试 launchId 的 sidecar 状态。先读取旧记录，使持久追赶游标
    //（lastEntryId，FR-5）跨重置保留。
    const launchId = this.newLaunchId();
    const prior = this.readRunnerState(sessionName);
    this.fs.writeFile(
      paths.runnerStatePath,
      JSON.stringify(buildPendingRunnerState(launchId, new Date().toISOString(), prior)),
    );

    const trust = piTrust(this.trustPosture, process.env, binding.launchPosture);
    const appliedLaunch = observePiResourceTrust(trust);
    const cmd = buildPiRunnerCommand({
      runnerEntryPath: this.runnerEntryPath,
      sessionName,
      stateRoot: this.stateRoot,
      cwd: binding.cwd,
      model: binding.model,
      // OPR.0.4.8.2：Pi RESOURCE TRUST（不是 permission policy）。YOLO 强制每个席位使用
      // `approve`；否则使用已配置姿态。restore 路径（pi-resume）使用相同决策。
      trust,
      sessionFile: opts.resumeToken,
      forkRef,
      launchId,
    });

    const textResult = await this.tmux.sendText(sessionName, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `发送启动命令失败：${textResult.message}` };
    }
    const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `发送 Enter 失败：${enterResult.message}` };
    }

    // runner 在首次成功 get_state 后写入 sidecar；该 sidecar（不是 pane 内容）是 token 事实源
    //（FR-5）。
    const state = await this.waitForRunnerReady(sessionName, launchId);
    if (!state.ok) return state.failure;

    const sessionFile = state.value.sessionFile;
    if (!sessionFile) {
      return { ok: false, error: "pi launch：runner 已就绪，但未报告 session 文件" };
    }
    if (forkRef && sessionFile === forkRef) {
      // adapter 契约要求 fork 后的新 token，绝不能是父 token（runtime-adapter.ts fork 规则）。
      return { ok: false, error: "pi fork：runner 报告了父 session 文件，而不是 fork 后的子文件" };
    }
    const validation = validateResumeToken("pi", sessionFile);
    if (!validation.ok) {
      return { ok: false, error: `pi launch：runner 报告了格式错误的 session 文件（${validation.error}）` };
    }

    return { ok: true, resumeToken: validation.token, resumeType: "pi_session_file", appliedLaunch };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "未绑定 tmux session" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session 无响应" };
    }
    // 守卫 fold（陈旧产物）：sidecar 或 scrollback 标记可能比 runner 进程存活更久，因此只有
    // pane 前台进程尚未回到 shell 时，ready 信号才有效（runner 结束后 pane 停在 shell；
    // READY scrollback 和陈旧 ready sidecar 不会让已停止席位变为就绪）。
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    const atShell = SHELL_COMMANDS.has(paneCommand);
    const state = this.readRunnerState(binding.tmuxSession);
    if (state?.exited) {
      return { ready: false, reason: `pi-runner 已退出（退出码 ${state.exited.code ?? "未知"}）`, code: "runner_exited" };
    }
    if (state?.ready) {
      if (atShell) {
        return { ready: false, reason: "pi-runner sidecar 显示已就绪，但 pane 已返回 shell（runner 进程已消失）", code: "runner_exited" };
      }
      return { ready: true };
    }
    // runner 生成的 pane 标记作为次级信号（FR-2）；它仍是 runner 自身输出，绝不是 Pi TUI
    // 启发式判断，并采用相同前台守卫。
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    if (paneContent.includes(PI_RUNNER_ERROR_MARKER)) {
      return { ready: false, reason: "pi-runner 在 pane 中报告错误", code: "runner_error" };
    }
    if (paneContent.includes(PI_RUNNER_EXIT_MARKER)) {
      return { ready: false, reason: "pi-runner 已退出", code: "runner_exited" };
    }
    if (paneContent.includes(PI_RUNNER_READY_MARKER)) {
      if (atShell) {
        return { ready: false, reason: "READY 标记是陈旧 scrollback；pane 已返回 shell", code: "runner_exited" };
      }
      return { ready: true };
    }
    return { ready: false, reason: "pi-runner 尚未报告 ready", code: "awaiting_runtime" };
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────────

  private readRunnerState(sessionName: string): PiRunnerState | null {
    const { runnerStatePath } = piSeatPaths(this.stateRoot, sessionName);
    if (!this.fs.exists(runnerStatePath)) return null;
    try {
      return parsePiRunnerState(this.fs.readFile(runnerStatePath));
    } catch {
      return null;
    }
  }

  private async waitForRunnerReady(
    sessionName: string,
    launchId: string,
  ): Promise<{ ok: true; value: PiRunnerState } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    const attempts = 60; // 约 15 秒：runner 启动 + pi spawn + 首次 get_state。
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readRunnerState(sessionName);
      // 启动尝试范围：只认可当前尝试的 sidecar 状态。忽略旧实例的陈旧 ready/exited 记录，
      // 也绝不读取 scrollback 中的陈旧 pane 标记；启动范围 sidecar 才是权威
      //（runner 启动时立即写入 pending 记录，退出时写入 exited）。
      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
          return {
            ok: false,
            failure: {
              ok: false,
              error: `pi launch 失败：runner 已退出（退出码 ${state.exited.code ?? "未知"}）`,
              recovery: "attention_required",
              evidence: paneContent.split("\n").slice(-12).join("\n"),
            },
          };
        }
        if (state.ready) return { ok: true, value: state };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: {
        ok: false,
        error: "pi launch：等待 runner 报告 ready 超时",
        recovery: "attention_required",
      },
    };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    if (entry.category === "skill") {
      if (!binding.tmuxSession) return false;
      const { agentDir } = piSeatPaths(this.stateRoot, binding.tmuxSession);
      const targetDir = nodePath.join(agentDir, "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;
      if (isDir && this.fs.listFiles) {
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.fs.writeFile(
          nodePath.join(targetDir, nodePath.basename(entry.absolutePath)),
          this.fs.readFile(entry.absolutePath),
        );
      }
      return true;
    }

    // MVP 中插件/子智能体/runtime 资源没有 Pi 投影目标（PRD §7 范围外）；应如实跳过，绝不误投递。
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // 镜像 Claude/Codex adapter：逐席位 `rig-role` 内容合并到共享 cwd 文件时会在 pod 同伴间
    // 冲突，因此改由 send_text 投递。参见 ADR-0006。
    if (blockId === "rig-role") {
      console.log(
        `[openrig] 跳过：effectiveId 为 rig-role，需要通过 send_text 路径逐席位投递（目标=${targetPath}）`
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}
