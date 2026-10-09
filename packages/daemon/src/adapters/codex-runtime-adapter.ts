import nodePath from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import Database from "better-sqlite3";
import { parse as parseToml } from "smol-toml";
import type { TmuxAdapter } from "./tmux.js";
import { codexPostureArg } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
// 仅类型导入——使 profile-preflight 模块在生产中保持动态延迟导入（此行不产生 runtime 导入开销）。
import type { CodexProfileProbeResult } from "../domain/codex-profile-preflight.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { observeCodexSandbox } from "../domain/permission-drift.js";
import {
  defaultResolveHomeDirByPid,
  readCodexThreadIdFromCandidateHomes,
  type ResolveHomeDirByPid,
} from "../domain/codex-thread-id.js";
import { assessNativeResumeProbe, buildCodexResumeCore, type NativeResumeProbeResult } from "../domain/native-resume-probe.js";
import { unknownDaemonSupportMessage, type CodexDaemonSupportDetector } from "../domain/codex-daemon-support.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { parseSessionName } from "../domain/session-name.js";
import { shellQuote } from "./shell-quote.js";
import { runSyncSite } from "../domain/sync-site-wrap.js";

import { listNativeProcesses, observeCodexPaneProcess, type NativeProcessRow } from "../domain/native-process-lineage.js";

// 一次启动的所有 probe 共享此状态，绝不因延迟屏幕或含糊的 transport 结果而重置。
// 单独请求的启动会获得新的 attempt。
interface UpdatePromptAttempt {
  handled: boolean;
  failure?: Extract<HarnessLaunchResult, { ok: false }>;
}

type CodexProcess = NativeProcessRow;

export interface CodexAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  /** 源文件权限位（用于保留 mode 的投影）。可选；缺失时不保留 mode。 */
  statMode?(path: string): number;
  /** 将权限位应用到文件（用于保留 mode 的投影）。可选；缺失时为空操作。 */
  chmod?(path: string, mode: number): void;
  homedir?: string;
}

/**
 * Codex runtime adapter。将资源投影到 .agents/ 目标（保留现有 Codex 文件系统契约），
 * 并投递启动文件。
 */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "codex";
  private tmux: TmuxAdapter;
  private fs: CodexAdapterFsOps;
  private listProcesses: () => CodexProcess[] | Promise<CodexProcess[]>;
  private readThreadIdByPid: (pid: number) => Promise<string | undefined> | string | undefined;
  private sleep: (ms: number) => Promise<void>;
  private resolveHomeDirByPid: ResolveHomeDirByPid;
  private codexHome?: string;
  private launchPath?: string;
  // Housekeeping B1 修正（阻塞 guard，架构 HK-AR-1 = 整体 probe DI）：Codex profile 加载探针
  // 是 adapter 既有可选依赖结构中的可注入依赖。默认使用真实探针（模块私有的
  // defaultProfilePreflight）；测试注入受控探针，不运行真实 codex 子进程。契约未削弱——生产默认
  // 使用真实探针。
  private verifyProfilePreflight: (profile: string) => Promise<CodexProfileProbeResult>;
  // #69：已安装 Codex 是否支持 --no-daemon。Startup 接入真实探针；缺失时（单元测试、其他
  // 嵌入方）保持现有调用不变。
  private detectDaemonSupport?: CodexDaemonSupportDetector;
  // OPR.0.4.1.10 FR-B——后台服务自身发布的 activity-relay.cjs 绝对路径，由 startup 从
  // import.meta.dirname 解析。ensureCodexActivityHooks（FR-A）用它写入配置层 [hooks] 命令条目；
  // 这些条目不依赖 cwd，且版本与运行中的后台服务匹配（不是 ${PLUGIN_ROOT}，也不是逐 cwd 副本）。
  private activityRelayPath?: string;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: CodexAdapterFsOps;
    listProcesses?: () => CodexProcess[] | Promise<CodexProcess[]>;
    readThreadIdByPid?: (pid: number) => Promise<string | undefined> | string | undefined;
    resolveHomeDirByPid?: ResolveHomeDirByPid;
    sleep?: (ms: number) => Promise<void>;
    activityRelayPath?: string;
    codexHome?: string;
    /** 即使 pane 的登录 shell 重写 PATH，也要与后台服务的前置探针保持一致。 */
    launchPath?: string;
    verifyProfilePreflight?: (profile: string) => Promise<CodexProfileProbeResult>;
    detectDaemonSupport?: CodexDaemonSupportDetector;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.codexHome = deps.codexHome;
    this.launchPath = deps.launchPath;
    this.detectDaemonSupport = deps.detectDaemonSupport;
    this.activityRelayPath = deps.activityRelayPath;
    this.listProcesses = deps.listProcesses ?? defaultListProcesses;
    this.readThreadIdByPid = deps.readThreadIdByPid ?? ((pid) => this.readThreadIdFromLogs(pid));
    this.resolveHomeDirByPid = deps.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.verifyProfilePreflight = deps.verifyProfilePreflight ?? defaultProfilePreflight;
  }

  /**
   * plugin-primitive 阶段 3a slice 3.5——确保 Codex feature flag。
   *
   * `enabled` 为 true 时，幂等地把 `codex_hooks = true` 写入 `~/.codex/config.toml` 的
   * `[features]` 下；文件缺失时创建。`enabled` 为 false 时不做任何修改——操作员独立管理
   * Codex 配置，后台服务不触碰它。
   *
   * 取代拆除前位于自动注入 activity hook 配置路径中、与 activity-hook 注入耦合的 feature-flag
   * 设置调用（plugin-primitive 阶段 3a slice 3.1）。
   */
  ensureCodexFeatureFlag(enabled: boolean, opts?: { codexVersion?: string }): void {
    if (!enabled) return;
    if (!opts?.codexVersion) return;
    if (isCodex013xOrLater(opts.codexVersion)) return;
    const configPath = this.resolveCodexConfigPath();
    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const updated = upsertCodexHooksFeature(existing);
    if (updated !== existing) {
      this.fs.mkdirp(nodePath.dirname(configPath));
      this.fs.writeFile(configPath, updated);
    }
  }

  /**
   * OPR.0.4.1.10 FR-A——将 OpenRig activity hook 写入 Codex 配置层
   *（`~/.codex/config.toml` 内联 `[hooks]`），使 OpenRig 启动的 Codex 席位从干净发布配置起就以
   * hook 为主。对 SessionStart/UserPromptSubmit/Stop/PermissionRequest 四个事件幂等 upsert
   * 托管块；每个命令为 `node "<activityRelayPath>"`（后台服务自身发布的 relay，FR-B——不依赖
   * cwd、与运行版本匹配，不使用 `${PLUGIN_ROOT}` 或逐 cwd 副本）。同时固定
   * `[features].hooks = true`（canonical key；有意不使用已弃用别名 `codex_hooks`）。Trust 仅限
   * 下方准确的已编写 hook 哈希；剩余原生评审提示需要操作员决策。relay 从 tmux session 继承
   * 席位的 OPENRIG_* 环境。
   *
   * 故障安全：relay 资产缺失时跳过并警告，绝不写入指向不存在脚本的 hook。已一手验证
   *（Codex 0.139，dev1-qa AC-2 证据）：在 OpenRig 托管启动路径上，托管内联 hook + trusted +
   * 投递进席位的 relay 环境（OPENRIG_URL + OPENRIG_ACTIVITY_HOOK_TOKEN + session/node/runtime）
   * 会使包括 SessionStart 在内的四个事件都作为 runtime_hook activity 投递。没有 relay 环境时，
   * hook 仍可信/可见，但不会落 activity 行。（裸启动/手工启动的 codex TUI 缺少该上下文，可能不
   * 投递 SessionStart；OpenRig 并不这样启动席位。）
   */
  ensureCodexActivityHooks(): void {
    const relay = this.activityRelayPath;
    if (!relay || !this.fs.exists(relay)) {
      if (relay) {
        console.error(`[zrig] 已跳过 Codex activity hook：${relay} 中未找到 relay 资产`);
      }
      return;
    }
    const configPath = this.resolveCodexConfigPath();
    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const withHooks = upsertCodexActivityHooks(existing, relay);
    if (withHooks !== existing) {
      this.fs.mkdirp(nodePath.dirname(configPath));
      this.fs.writeFile(configPath, withHooks);
    }
    // OPR.0.4.3.33 hook-trust-autoclear——在配置 hook 的同一接缝上，为我们编写的四个 hook
    // 预写 Codex 自身 hook trust 记录（[hooks.state."<key>"] trusted_hash），使后台服务未托管的
    // 内联 hook 在全新 Codex 进程读取配置的每条路径（launch/adopt/reconcile）上从干净配置起就
    // 被信任，而无需笼统的原生 trust 按键。若原生身份/哈希语义变化，则展示剩余评审供决策。
    // 幂等且不覆盖；只触碰我们的四个 key。RTFM 见 applyCodexActivityHookTrust。
    const trusted = this.applyCodexActivityHookTrust(withHooks, configPath, relay);
    if (trusted !== withHooks) {
      this.fs.mkdirp(nodePath.dirname(configPath));
      this.fs.writeFile(configPath, trusted);
    }
  }

  /**
   * OPR.0.4.3.33——计算 Codex 为我们四个 activity hook 使用的
   * `[hooks.state."<key>"] trusted_hash` 并拼入 `content`。`key_source` 是 canonical 化配置
   * 路径（Codex 按 `std::fs::canonicalize(config.toml).display()` 为 trust 定键）；我们尽力
   * `realpathSync` 配置路径以匹配。失败时（文件尚未真实落盘，或测试中的 mock fs）回退到普通
   * 绝对路径，由此产生的 key 不匹配只会降级到启动时 trust gate（第 2 层 floor），绝不导致运行
   * 损坏。命令字符串是 Codex 从 TOML 字面量 `'node "<relay>"'` 反序列化出的值，即不含外层
   * TOML 引号的 `node "<relay>"`。timeout=5，matcher/status 为 None。
   */
  private applyCodexActivityHookTrust(content: string, configPath: string, relay: string): string {
    let keySource = configPath;
    try {
      keySource = fs.realpathSync(configPath);
    } catch {
      // config.toml 不在真实文件系统中（首次写入/单元测试 mock fs）；普通绝对路径是诚实的最佳
      // 猜测，canonical 化差异会故障安全（gate 重新出现）。
    }
    const command = `node "${relay}"`;
    let next = content;
    for (const event of OPENRIG_ACTIVITY_HOOK_EVENTS) {
      const { key, hash } = computeCodexHookTrust(event, { keySource, command, timeoutSec: 5 });
      next = upsertCodexHookTrust(next, key, hash);
    }
    return next;
  }

  /**
   * OPR.0.4.1.10 B3——持久禁用。runtime.codex.hooks_enabled 为 false 时，从
   * ~/.codex/config.toml 删除 OpenRig 托管的 activity-hooks 哨兵块，使之前配置过 hook 的席位
   * 在操作员禁用后不再触发。只删除托管块，保留所有用户 hook，并保持 [features].hooks
   *（Codex 0.139 默认值）不变。操作幂等；配置或块缺失时为空操作。
   */
  removeCodexActivityHooks(): void {
    const configPath = this.resolveCodexConfigPath();
    if (!this.fs.exists(configPath)) return;
    const existing = this.fs.readFile(configPath);
    const updated = stripCodexActivityHooks(existing);
    if (updated !== existing) {
      this.fs.writeFile(configPath, updated);
    }
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".agents", "skills");
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
        const didProject = this.projectEntry(entry, binding.cwd);
        if (didProject) {
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
    try { this.ensureManagedBootstrap(binding); } catch (err) {
      console.error(`[zrig] Codex bootstrap 警告：${(err as Error).message}`);
    }

    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // 跳过 rig-role 时不计为已投递。
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".agents", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
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
    opts: { name: string; resumeToken?: string; forkSource?: import("../domain/runtime-adapter.js").ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "未绑定 tmux session——无法启动 Codex harness" };
    }

    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken 与 forkSource 互斥——请选择一个" };
    }

    const updatePrompt: UpdatePromptAttempt = { handled: false };
    const model = binding.model?.trim();
    const modelArg = model ? ` -m ${shellQuote(model)}` : "";
    const profile = binding.codexConfigProfile?.trim();
    const profileArg = profile ? ` -p ${shellQuote(profile)}` : "";
    const postureArg = codexPostureArg(profileArg, process.env, binding.launchPosture);
    const appliedLaunch = observeCodexSandbox(postureArg);

    // OPR.0.3.4.7——launch/resume 前的 profile 加载探针。legacy [profiles.<name>] 表或无效
    // TOML 必须先于不透明的 `codex -p <profile> resume` 失败。缺少 .config.toml 时通过
    //（Codex 会应用默认层；顾问方案 B）。
    if (profile) {
      const probeResult = await this.verifyProfilePreflight(profile);
      if (!probeResult.ok) {
        return {
          ok: false,
          error: `${probeResult.error}${probeResult.migrationHint ? `\n  修复：${probeResult.migrationHint}` : ""}`,
        };
      }
    }
    const gitDirArg = ` --add-dir ${shellQuote(nodePath.join(binding.cwd, ".git"))}`;
    const queueStateDirArg = this.buildQueueStateAddDirArg(opts.name);
    // #69：为本次启动及席位 pane 实际运行的 Codex（其 cwd 与启动 PATH）做一次 daemon-support
    // 决策，并应用于 fresh、fork 和 resume。
    const daemonSupport = this.detectDaemonSupport ? await this.detectDaemonSupport(binding.cwd) : undefined;
    if (daemonSupport?.kind === "unknown") {
      return { ok: false, error: unknownDaemonSupportMessage(daemonSupport.detail) };
    }
    const daemonOptOut = daemonSupport?.kind === "supported";
    const daemonArg = daemonOptOut ? " --no-daemon" : "";

    // Fork 分支：`codex fork <parent_thread_id>`。捕获 fork 后的新 thread id；父 thread id
    // 不会持久化到新席位记录（身份诚实基石）。
    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `codex fork：v1 不支持 ref.kind="${opts.forkSource.kind}"；请使用 ref.kind="native_id" 并提供先前会话的 thread id`,
        };
      }
      const parentId = opts.forkSource.value?.trim();
      if (!parentId) {
        return { ok: false, error: "codex fork：必须提供 forkSource.value（父 native_id）" };
      }
      // OPR.0.4.8.2：FORK 路径使用同一姿态决策 codexPostureArg；YOLO 强制每个席位使用
      // -s danger-full-access，否则使用具名 profile 或 OpenRig 显式 -s workspace-write floor。
      // 0.5.2-07 A2-3：FORK 路径也传递 spec model（此前 fork-instantiate 会将其还原）。
      const cmd = `codex${daemonArg}${postureArg}${modelArg} fork${queueStateDirArg} ${shellQuote(parentId)}`;
      const textResult = await this.tmux.sendShellCommand(binding.tmuxSession, this.launchPath ? `env PATH=${shellQuote(this.launchPath)} ${cmd}` : cmd);
      if (!textResult.ok) {
        return { ok: false, error: `发送启动命令失败：${textResult.message}` };
      }
      await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession, updatePrompt, 8);
      if (updatePrompt.failure) return updatePrompt.failure;
      const threadId = await this.captureFreshThreadId(binding, updatePrompt);
      if (updatePrompt.failure) return updatePrompt.failure;
      if (!threadId) {
        return {
          ok: false,
          error: "codex fork：无法捕获 fork 后的新 thread id",
        };
      }
      return { ok: true, resumeToken: threadId, resumeType: "codex_id", appliedLaunch };
    }

    // OPR.0.4.8.2：fresh 启动也使用唯一姿态决策 codexPostureArg；YOLO 强制
    // -s danger-full-access（即使有具名 profile 也覆盖），否则使用具名 profile 或 OpenRig
    // 显式 -s workspace-write floor。
    const cmd = opts.resumeToken
      // 0.5.2-07 A2-3：感知 pod 的 RESUME 路径也传递 spec model（此前被还原；grounding map
      // 假定 Codex 与 Claude adapter 一致，但只有 fresh 会输出 -m）。
      ? buildCodexResumeCore(opts.resumeToken, profile, false, queueStateDirArg.trim() || undefined, binding.launchPosture, model, postureArg, daemonOptOut)
      : `codex${daemonArg}${postureArg} -C ${shellQuote(binding.cwd)}${gitDirArg}${queueStateDirArg}${modelArg}`;

    const textResult = await this.tmux.sendShellCommand(binding.tmuxSession, this.launchPath ? `env PATH=${shellQuote(this.launchPath)} ${cmd}` : cmd);
    if (!textResult.ok) {
      return { ok: false, error: `发送启动命令失败：${textResult.message}` };
    }

    await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession, updatePrompt);
    if (updatePrompt.failure) return updatePrompt.failure;

    if (opts.resumeToken) {
      const verification = await this.verifyResumeLaunch(binding.tmuxSession, updatePrompt, { resumeToken: opts.resumeToken });
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "codex_id", appliedLaunch };
    }

    const threadId = await this.captureFreshThreadId(binding, updatePrompt);
    if (updatePrompt.failure) return updatePrompt.failure;
    if (threadId) {
      return { ok: true, resumeToken: threadId, resumeType: "codex_id", appliedLaunch };
    }

    return { ok: true, appliedLaunch };
  }

  private buildQueueStateAddDirArg(sessionName: string): string {
    const identity = parseCanonicalSessionName(sessionName);
    if (!identity) return "";

    const sharedDocsRoot = process.env.OPENRIG_SHARED_DOCS_ROOT?.trim()
      // OPR.0.3.2.14——子路径已清理（内部团队布局 → 通用占位符）。
      || nodePath.join(this.fs.homedir ?? os.homedir(), ".openrig", "shared-docs");
    const queueStateRoot = nodePath.join(sharedDocsRoot, "rigs", identity.rig, "state", identity.pod);
    return ` --add-dir ${shellQuote(queueStateRoot)}`;
  }

  private async captureProbeScreen(target: string): Promise<string> {
    // 当前 readiness 属于已渲染屏幕。Scrollback 可能保留已关闭提示、加载标题或早先尝试的拒绝。
    if (this.tmux.capturePaneScreen) return await this.tmux.capturePaneScreen(target) ?? "";
    return await this.tmux.capturePaneContent(target, 40) ?? "";
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "未绑定 tmux session" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session 无响应" };
    }

    const paneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
    const paneContent = await this.captureProbeScreen(binding.tmuxSession);
    const probe = assessNativeResumeProbe({
      runtime: "codex",
      paneCommand,
      paneContent,
    });

    if (probe.status === "resumed") return { ready: true };
    return { ready: false, reason: probe.detail, code: probe.code };
  }

  private async dismissSkippableCodexUpdatePrompt(
    tmuxSession: string, updatePrompt: UpdatePromptAttempt, attempts = 6,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = await this.captureProbeScreen(tmuxSession);
      const probe = assessNativeResumeProbe({ runtime: "codex", paneCommand, paneContent });

      if (probe.code === "update_gate") {
        if (updatePrompt.handled || !isSkippableCodexUpdatePrompt(paneContent)) return false;
        const identity = await this.observeMenuProcess(tmuxSession, paneCommand);
        if (!identity) return false;
        // npm launcher 可能是带原生 Codex 子进程的前台 Node。采样后重新检查身份与当前屏幕，
        // 绝不读取 scrollback。
        const currentCommand = await this.tmux.getPaneCommand(tmuxSession);
        if (await this.observeMenuProcess(tmuxSession, currentCommand) !== identity) {
          updatePrompt.handled = true;
          return false;
        }
        const currentScreen = await this.tmux.capturePaneScreen?.(tmuxSession);
        if (!currentScreen || !isSkippableCodexUpdatePrompt(currentScreen)
          || assessNativeResumeProbe({ runtime: "codex", paneCommand: currentCommand, paneContent: currentScreen }).code !== "update_gate") {
          updatePrompt.handled = true;
          return false;
        }

        // Codex 0.155.1 忽略 Paste；Key3 会选择并提交 DontRemind（包括其版本缓存写入）。
        // Enter 会命中下一屏。即使投递失败，也要在发送前消耗本次尝试。
        updatePrompt.handled = true;
        const result = await this.tmux.sendKeys(tmuxSession, ["3"]);
        if (!result.ok) {
          updatePrompt.failure = {
            ok: false, recovery: "attention_required",
            error: `无法跳过 Codex 更新提示：${result.message}。请检查 session 后再重试。`,
            evidence: paneContent.split("\n").slice(-12).join("\n"),
          };
          return false;
        }
        await this.sleep(500);
        continue; // 观察状态转换；本次启动绝不发送第二次选择。
      }

      // readiness 或其他原生决策会关闭 update 自动化；后续陈旧捕获不得重新打开它。
      // Trust/auth 决策仍留在 pane 中。
      if (probe.status === "resumed" || probe.status === "attention_required"
        || probe.code === "trust_gate" || probe.code === "hook_trust_gate") {
        updatePrompt.handled = true;
        return probe.status === "resumed";
      }
      if (attempt < attempts - 1) await this.sleep(200);
    }
    return false;
  }

  private async observeMenuProcess(target: string, paneCommand: string | null): Promise<string | null> {
    // tmux 可能报告 shell wrapper 名称；身份由原生祖先进程与前台进程组共同决定。
    if (!paneCommand) return null;
    const observation = await observeCodexPaneProcess({ target, tmux: this.tmux, listProcesses: this.listProcesses });
    return observation ? JSON.stringify([paneCommand, observation.fingerprint]) : null;
  }

  ensureManagedBootstrap(binding: { cwd?: string | null }): void {
    this.provisionWorkspaceTrust(binding.cwd ?? null);
  }

  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "runtime_resource" && this.applyRuntimeResource(entry)) {
      return true;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    // HG-1.3 插件 runtime 适用性筛选（依据 DESIGN.md §5.1）：
    // - 显式 pluginType="claude" → 跳过 Codex 投影
    // - pluginType="auto"（或未设置）且没有 .codex-plugin/ manifest 目录 → 跳过
    // - 显式 pluginType="codex" → 无论 manifest 是否存在都投影
    if (entry.category === "plugin" && !this.pluginAppliesToCodex(entry)) {
      return false;
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return true;

    this.fs.mkdirp(targetDir);
    const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;

    if (isDir && this.fs.listFiles) {
      for (const file of this.fs.listFiles(entry.absolutePath)) {
        const src = nodePath.join(entry.absolutePath, file);
        const dest = nodePath.join(targetDir, file);
        const content = this.fs.readFile(src);
        // 即使跳过内容写入也要协调 mode：先前投影的逐字节相同目标仍可能带有错误的默认 mode。
        if (this.fs.exists(dest) && hashContent(content) === hashContent(this.fs.readFile(dest))) {
          this.preserveMode(src, dest);
          continue;
        }
        this.fs.mkdirp(nodePath.dirname(dest));
        this.fs.writeFile(dest, content);
        this.preserveMode(src, dest);
      }
    } else {
      const content = this.fs.readFile(entry.absolutePath);
      const destFile = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
      if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) {
        this.preserveMode(entry.absolutePath, destFile);
        return true;
      }
      this.fs.writeFile(destFile, content);
      this.preserveMode(entry.absolutePath, destFile);
    }
    return true;
  }

  /**
   * 将源文件权限位重新应用到投影目标。普通 readFile+writeFile（writeFileSync）使用进程默认
   * mode 创建目标，会丢失嵌套插件辅助程序的可执行位（例如
   * claude-compaction-restore/scripts/*.mjs 的 0755 hook）。fs adapter 未公开 mode 原语时
   * 为空操作，使现有 mock-fs 调用方不受影响。
   */
  private preserveMode(src: string, dest: string): void {
    if (!this.fs.statMode || !this.fs.chmod) return;
    const srcMode = this.fs.statMode(src) & 0o777;
    if ((this.fs.statMode(dest) & 0o777) !== srcMode) this.fs.chmod(dest, srcMode);
  }

  private pluginAppliesToCodex(entry: ProjectionEntry): boolean {
    const explicit = entry.pluginType ?? "auto";
    if (explicit === "codex") return true;
    if (explicit === "claude") return false;
    // auto：根据源树中是否存在 .codex-plugin/plugin.json 检测。
    return this.fs.exists(nodePath.join(entry.absolutePath, ".codex-plugin", "plugin.json"));
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(cwd, ".agents", "skills", entry.effectiveId);
      case "guidance": return null; // handled via merge
      case "subagent": return nodePath.join(cwd, ".agents"); // .agents/{id}.yaml per preserved contract
      case "plugin": return nodePath.join(cwd, ".codex", "plugins", entry.effectiveId);
      case "runtime_resource": return nodePath.join(cwd, ".agents", "extensions", entry.effectiveId);
      default: return null;
    }
  }

  private applyRuntimeResource(entry: ProjectionEntry): boolean {
    if (entry.resourceType !== "codex_config_fragment") {
      return false;
    }

    const configPath = this.resolveCodexConfigPath();
    this.fs.mkdirp(nodePath.dirname(configPath));

    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const fragment = this.fs.readFile(entry.absolutePath);
    // 在丢弃任何内容前：本身无效的 fragment 必须明确失败，绝不能由冲突筛选器通过删除内容来
    // “解决”。
    assertFragmentParsesStandalone(fragment, entry.absolutePath, entry.effectiveId);
    // 此检查位于解析之后：无法解析的 fragment 应收到指出行列的 TOML 错误，而不是关于残片的
    // 根范围投诉。
    assertFragmentOpensWithTable(fragment, entry.absolutePath, entry.effectiveId);
    const rendered = upsertManagedCodexConfigFragment(existing, entry.effectiveId, fragment);
    assertRendersAsLoadableToml(rendered, configPath, entry.effectiveId);
    this.fs.writeFile(configPath, rendered);
    return true;
  }

  /**
   * 将托管块合并到目标 guidance 文件。完成合并时返回 `true`，有意跳过 rig-role 时返回
   * `false`。调用方传播跳过信号，使 ProjectionResult 与 StartupDeliveryResult 报告真实计数。
   */
  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // 镜像 Claude Code adapter：`rig-role` 托管块会在 pod 同伴间冲突，因为 regenerator
    // 以（目标文件 × spec）配对而不关联席位。逐席位角色内容改由 `send_text` 启动路径投递。
    // 明确拒绝合并；静默跳过会掩盖冲突。参见 ADR-0006。
    if (blockId === "rig-role") {
      console.log(
        `[zrig] 跳过：effectiveId 为 rig-role，需要通过 send_text 路径逐席位投递（目标=${targetPath}）`
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }

  private detectDeliveryHint(path: string, content: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content);
  }

  private provisionWorkspaceTrust(cwd: string | null): void {
    if (!cwd) return;
    const configPath = this.resolveCodexConfigPath();
    this.fs.mkdirp(nodePath.dirname(configPath));

    let content = "";
    try {
      if (this.fs.exists(configPath)) content = this.fs.readFile(configPath);
    } catch {
      content = "";
    }

    for (const trustKey of this.workspaceTrustKeys(cwd)) {
      content = upsertCodexProjectTrust(content, trustKey);
    }

    this.fs.writeFile(configPath, content);
  }

  private resolveCodexConfigPath(): string {
    const root = this.codexHome
      ?? nodePath.join(this.fs.homedir ?? os.homedir(), ".codex");
    return nodePath.join(root, "config.toml");
  }

  private readJsonObject(path: string): Record<string, unknown> {
    try {
      if (!this.fs.exists(path)) return {};
      const parsed = JSON.parse(this.fs.readFile(path));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private readJsonObjectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private workspaceTrustKeys(cwd: string): string[] {
    const keys = new Set<string>([nodePath.resolve(cwd)]);
    try {
      keys.add(fs.realpathSync.native(cwd));
    } catch {
      // 仅尽力而为。
    }
    return Array.from(keys);
  }

  private async captureFreshThreadId(binding: NodeBinding, updatePrompt: UpdatePromptAttempt): Promise<string | undefined> {
    const target = binding.tmuxPane ?? binding.tmuxSession;
    if (!target || !this.tmux.getPanePid) return undefined;

    for (let attempt = 0; attempt < 20; attempt++) {
      const shellPid = await this.tmux.getPanePid(target);
      if (shellPid) {
        const codexPids = await this.findCodexDescendantPids(shellPid);
        for (const codexPid of codexPids) {
          const threadId = await this.readThreadIdByPid(codexPid);
          if (threadId) return threadId;
        }
      }
      if (binding.tmuxSession) {
        await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession, updatePrompt, 1);
        if (updatePrompt.failure) return undefined;
      }
      await this.sleep(250);
    }

    return undefined;
  }

  private async verifyResumeLaunch(tmuxSession: string, updatePrompt: UpdatePromptAttempt, opts?: { resumeToken?: string }): Promise<HarnessLaunchResult> {
    const quickAttempts = 6;
    const extendedAttempts = 24;
    const quickSleepMs = 200;
    const extendedSleepMs = 500;

    // OPR.0.3.3.21（FR-2）：进程存活不能证明会话已恢复。除非 probe 证明 `resumed`，
    // verifyResumeLaunch 不得返回 ok:true。未解决的操作员行动 gate（update/trust/model）以及
    // 在有界轮询内始终未达到 `resumed` 的情况都属于 `attention_required`，不是启动成功。
    //
    // OPR.0.3.4.13：缓慢但有效的 Codex resume（原 thread 正在启动，没有真实 gate）在快速
    // 1.2 秒窗口后获得约 15 秒的扩展轮询。真实 gate（auth/trust/model/update）仍在快速窗口内
    // 分类；只有 awaiting_runtime 启动情形会扩展。
    let lastUnresolved: NativeResumeProbeResult | null = null;
    let lastPaneContent = "";
    let sawRealGate = false;

    const totalAttempts = quickAttempts + extendedAttempts;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      // 快速阶段之后，只有处于启动中情形（awaiting_runtime，无真实 gate）才继续。真实 gate
      // 不会自行解决。
      if (attempt >= quickAttempts && (sawRealGate || lastUnresolved?.code !== "awaiting_runtime")) {
        break;
      }

      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = await this.captureProbeScreen(tmuxSession);
      lastPaneContent = paneContent;
      let probe = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_saved_session") {
        return {
          ok: false,
          error: "Codex resume 失败：找不到所请求 session 对应的已保存会话",
          recovery: "retry_fresh",
        };
      }

      if (probe.code === "returned_to_shell") {
        // sendShellCommand 异步启动；Codex 加载期间 shell 可能仍是 pane wrapper。使用现有有界
        // 启动等待；这个标签既不能证明启动失败，也不能证明已就绪。此处仍需可用屏幕，随后 restore
        // 中还需联合原生身份凭证，才能把席位报告为 resumed。
        probe = {
          status: "inconclusive", code: "awaiting_runtime",
          detail: "Codex resume 尚未在启动 pane 中进入可交互会话。",
        };
      }

      if (probe.status === "attention_required") {
        return {
          ok: false,
          error: probe.detail,
          recovery: "attention_required",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (probe.status === "resumed") {
        return {
          ok: true,
          resumeToken: opts?.resumeToken,
          resumeType: opts?.resumeToken ? "codex_id" : undefined,
        };
      }

      if (probe.code === "update_gate") {
        const dismissed = await this.dismissSkippableCodexUpdatePrompt(tmuxSession, updatePrompt, 1);
        if (updatePrompt.failure) return updatePrompt.failure;
        if (dismissed) {
          lastUnresolved = null;
          sawRealGate = false;
          const sleepMs = attempt < quickAttempts ? quickSleepMs : extendedSleepMs;
          if (attempt < totalAttempts - 1) await this.sleep(sleepMs);
          continue;
        }
        lastUnresolved = probe;
        sawRealGate = true;
      } else if (probe.status === "inconclusive") {
        lastUnresolved = probe;
        if (probe.code !== "awaiting_runtime") {
          sawRealGate = true;
        }
      }

      const sleepMs = attempt < quickAttempts ? quickSleepMs : extendedSleepMs;
      if (attempt < totalAttempts - 1) await this.sleep(sleepMs);
    }

    return {
      ok: false,
      error: lastUnresolved?.detail
        ?? "无法确认 Codex resume：进程仍存活，但始终未证明会话已恢复。",
      recovery: "attention_required",
      evidence: lastPaneContent.split("\n").slice(-12).join("\n"),
    };
  }

  private async findCodexDescendantPids(parentPid: number): Promise<number[]> {
    const processes = await this.listProcesses();
    return findCodexDescendantPids(processes, parentPid);
  }

  private async readThreadIdFromLogs(pid: number): Promise<string | undefined> {
    return readCodexThreadIdFromCandidateHomes(
      pid,
      [await this.resolveHomeDirByPid(pid), this.fs.homedir, os.homedir()],
      (path) => this.fs.exists(path)
    );
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function upsertCodexProjectTrust(content: string, projectPath: string): string {
  const header = `[projects.${JSON.stringify(projectPath)}]`;
  const lines = content.length > 0 ? content.split("\n") : [];
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const trimmed = content.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return `${prefix}${header}\ntrust_level = "trusted"\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const trustIndex = lines.findIndex((line, index) => index > headerIndex && index < nextSectionIndex && line.trim().startsWith("trust_level"));
  if (trustIndex >= 0) {
    lines[trustIndex] = 'trust_level = "trusted"';
  } else {
    lines.splice(headerIndex + 1, 0, 'trust_level = "trusted"');
  }

  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

// ── OPR.0.4.3.33 hook-trust-autoclear ────────────────────────────────────────────────────
// 预写 Codex 自身 hook trust 记录，使后台服务配置的未托管内联 activity hook 在所有路径
//（launch/adopt/reconcile）上无需手动 `/hooks`“Trust all”按键即可受信任。Codex 是私有实现；
// 下方 key + hash 从开源代码复现（已阅读并引用），在真实 Codex 执行 `/hooks`→“Trust all”后对
// `[hooks.state]` 逐字节读回固定前仍属临时结论（QA VM 证据，见标为 PIN-TO-VM 的单元测试
// fixture）。不匹配时故障安全：Codex 重新显示 gate，启动时评审继续对操作员可见，绝不发送
// 笼统 trust 按键。
//
// RTFM 来源（引用）：
//   - https://developers.openai.com/codex/hooks
//   - openai/codex PR #20321 "hook trust metadata and enforcement" (merge commit 0452dca;
//     typed-identity commit ffcc9cc) — key file codex-rs/hooks/src/engine/discovery.rs.
//   - openai/codex issue #21615 (the `[hooks.state]` pre-write workaround for exactly this
//     local-wrapper-installer case) + #23259 (positional path-keying fragility).
//
// KEY——codex-rs/hooks/src/lib.rs `hook_key`：
//   `{key_source}:{event_label}:{group_index}:{handler_index}`
//   - key_source：`std::fs::canonicalize(~/.codex/config.toml).display()`（配置源层身份；
//     经 codex-rs/app-server/tests/suite/v2/hooks_list.rs 确认，其 key
//     `{canonicalize(config.toml).display()}:pre_tool_use:0:0`).
//   - event_label：`hook_event_key_label()`——SessionStart→session_start，
//     UserPromptSubmit→user_prompt_submit, Stop→stop, PermissionRequest→permission_request.
//   - group_index/handler_index：按位置。我们的托管块为每个事件恰好写一个
//     `[[hooks.<Ev>]]` group（0）和一个 `[[hooks.<Ev>.hooks]]` handler（0）⇒ 0:0。
//     （位置定键是已知上游脆弱点 #23259；若用户在同一层为同一事件预先编写 hook，我们的索引
//     会偏移 → gate 重现 → 故障安全。）
//
// HASH——codex-rs/hooks/src/engine/discovery.rs `command_hook_hash`
//        → codex-rs/config/src/fingerprint.rs `version_for_toml`:
//   hash = "sha256:" + hex( sha256( canonical_json( toml_value( NormalizedHookIdentity ) ) ) )
//   NormalizedHookIdentity { event_name: <label>, #[serde(flatten)] group: MatcherGroup }
//   MatcherGroup { matcher: Option<String>, hooks: Vec<HookHandlerConfig> }
//   HookHandlerConfig::Command (codex-rs/config/src/hook_config.rs, `#[serde(tag="type")]`,
//     rename "command"): { command: String, commandWindows: Option, timeout(=timeout_sec):
//     Option<u64>, async: bool, statusMessage: Option }
//   承重序列化事实：
//     * `TomlValue::try_from` 丢弃 None 字段（TOML 没有 null）→ 我们的 hook 省略 matcher/
//       commandWindows/statusMessage；`async` 是普通 bool（不是 Option），因此存在
//       `async = false`。
//     * event_name 使用 snake_case 标签（session_start 等），不是 CamelCase 事件。
//     * `version_for_toml` 将 TomlValue 转为 serde_json Value，`canonical_json` 递归排序
//       每个对象的 key，再对紧凑 JSON 字节做 sha256。serde_json 的紧凑输出（无空格、`/` 不转义、
//       `"`/`\` 做 JSON 转义）与 JSON.stringify 一致。
//   置信度：HASH 完全可从开源代码确定性推出（JSON+sha256），为高。KEY 的准确 key_source
//   canonical 形式及位置索引仍需 VM 读回确认，在此之前为临时结论。

/** 递归排序对象 key（镜像 codex-rs fingerprint.rs 的 `canonical_json`）。 */
function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalizeJsonValue(src[key]);
    return out;
  }
  return value;
}

const CODEX_HOOK_EVENT_KEY_LABEL: Record<(typeof OPENRIG_ACTIVITY_HOOK_EVENTS)[number], string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
  PermissionRequest: "permission_request",
};

export interface CodexHookTrustInput {
  /** Codex hook_key 来源身份：canonical 化的 `~/.codex/config.toml` 路径。 */
  keySource: string;
  /** Codex 反序列化得到的命令——`node "<relay>"`（不含外层 TOML 引号）。 */
  command: string;
  /** 我们编写的 hook 超时（秒）。 */
  timeoutSec: number;
  /** 我们的 hook 为 None；存在时纳入哈希（为忠实复现而保留）。 */
  matcher?: string | null;
  /** 我们的 hook 为 None；存在时纳入哈希。 */
  statusMessage?: string | null;
  /** 事件 matcher-group 列表中的位置 group 索引（我们的 hook 为 0）。 */
  groupIndex?: number;
  /** group 的 handler 列表中的位置 handler 索引（我们的 hook 为 0）。 */
  handlerIndex?: number;
}

/**
 * 为一个已编写 activity hook 复现 Codex 持久 hook trust `{ key, trusted_hash }`。纯且确定性。
 * 完整 RTFM 推导与“VM 读回前为临时结论”的警示见上方块注释。
 */
export function computeCodexHookTrust(
  event: (typeof OPENRIG_ACTIVITY_HOOK_EVENTS)[number],
  input: CodexHookTrustInput,
): { key: string; hash: string } {
  const label = CODEX_HOOK_EVENT_KEY_LABEL[event];
  const groupIndex = input.groupIndex ?? 0;
  const handlerIndex = input.handlerIndex ?? 0;
  const key = `${input.keySource}:${label}:${groupIndex}:${handlerIndex}`;

  // 严格按 `TomlValue::try_from` 构建 NormalizedHookIdentity：丢弃 None 字段。
  const handler: Record<string, unknown> = {
    type: "command",
    command: input.command,
    timeout: input.timeoutSec,
    async: false,
  };
  if (input.statusMessage != null) handler.statusMessage = input.statusMessage;
  const identity: Record<string, unknown> = { event_name: label, hooks: [handler] };
  if (input.matcher != null) identity.matcher = input.matcher;

  const serialized = JSON.stringify(canonicalizeJsonValue(identity));
  const hex = createHash("sha256").update(serialized, "utf8").digest("hex");
  return { key, hash: `sha256:${hex}` };
}

/**
 * OPR.0.4.3.33——单条 `[hooks.state."<key>"] trusted_hash = "<hash>"` 记录的幂等、
 * 非覆盖、section 范围写入器。镜像 upsertCodexProjectTrust：查找/创建准确表头，只拼接其
 * `trusted_hash` 行，其他所有 `[hooks.state]`/`[projects]` 条目与托管 hook 块保持逐字节不变。
 * 相同 key+hash 时为空操作。只为我们编写的四个 hook key 调用，绝不做笼统/通配 trust。
 */
export function upsertCodexHookTrust(content: string, key: string, hash: string): string {
  const header = `[hooks.state.${JSON.stringify(key)}]`;
  const trustLine = `trusted_hash = ${JSON.stringify(hash)}`;
  const lines = content.length > 0 ? content.split("\n") : [];
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const trimmed = content.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return `${prefix}${header}\n${trustLine}\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const hashIndex = lines.findIndex(
    (line, index) => index > headerIndex && index < nextSectionIndex && line.trim().startsWith("trusted_hash"),
  );
  if (hashIndex >= 0) {
    lines[hashIndex] = trustLine;
  } else {
    lines.splice(headerIndex + 1, 0, trustLine);
  }

  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

function parseCanonicalSessionName(sessionName: string): { pod: string; member: string; rig: string } | null {
  // OPR.0.4.6.MH1 FR-8：member/rig 拆分使用共享解析契约。含多个 @ 的名称现在以贪婪方式
  // 解析 rig（"rig@x"），随后被 isSafeQueueSegment 拒绝（"@" 不安全）；与此处旧版单 @
  // 检查返回的 null 相同。
  const trimmed = sessionName.trim();
  const parsed = parseSessionName(trimmed);
  if (parsed.kind !== "canonical") return null;

  const rig = parsed.rig;
  const separatorIndex = parsed.member.indexOf("-");
  if (separatorIndex <= 0 || separatorIndex === parsed.member.length - 1) return null;

  const pod = parsed.member.slice(0, separatorIndex);
  const member = parsed.member.slice(separatorIndex + 1);
  if (!isSafeQueueSegment(pod) || !isSafeQueueSegment(member) || !isSafeQueueSegment(rig)) return null;

  return { pod, member, rig };
}

function isSafeQueueSegment(segment: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);
}

export function isCodex013xOrLater(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = parseInt(match[1]!, 10);
  const minor = parseInt(match[2]!, 10);
  if (major > 0) return true;
  return minor >= 130;
}

// OPR.0.4.1.10 B2——对 TOML `[features]` 表头的任何合法写法都返回 true。规范化后比较，
// 而不是叠加正则：表头为 `[ <key> ]`，后面可带注释。根据 TOML v1.0.0 规范
//（toml.io/en/v1.0.0，Keys/Table），方括号内 key 周围的空白会被忽略
//（`[ features ]` == `[features]`），key 可以是裸值（`features`）或 basic/literal 引号字符串
//（`"features"`/`'features'`），都表示同一个 `features` 表。以 `#` 开头的行是注释，绝不是
// section。`[^[\]]*` 正文排除 array-of-tables 的 `[[...]]` 形式。两个 feature upsert 都使用
// 此函数（DRY），避免漏掉任何表头写法；漏掉表头会追加重复表，被 Codex 0.139
// --strict-config 拒绝（config-could-not-be-loaded）。
function isCodexFeaturesHeader(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) return false;
  const match = /^\[([^[\]]*)\]\s*(#.*)?$/.exec(trimmed);
  if (!match) return false;
  let key = match[1]!.trim();
  if (
    key.length >= 2 &&
    ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))
  ) {
    key = key.slice(1, -1);
  }
  return key === "features";
}

function upsertCodexHooksFeature(content: string): string {
  const lines = content.length > 0 ? content.replace(/\n*$/, "").split("\n") : [];
  const featuresIndex = lines.findIndex(isCodexFeaturesHeader);

  if (featuresIndex === -1) {
    const prefix = lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
    return `${prefix}[features]\ncodex_hooks = true\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = featuresIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const flagIndex = lines.findIndex((line, index) =>
    index > featuresIndex &&
    index < nextSectionIndex &&
    line.trim().startsWith("codex_hooks")
  );
  if (flagIndex >= 0) {
    lines[flagIndex] = "codex_hooks = true";
  } else {
    lines.splice(featuresIndex + 1, 0, "codex_hooks = true");
  }

  return `${lines.join("\n")}\n`;
}

// OPR.0.4.1.10 FR-A——配置层 activity-hook 投影。
const OPENRIG_ACTIVITY_HOOKS_BEGIN = "# BEGIN OPENRIG MANAGED ACTIVITY HOOKS";
const OPENRIG_ACTIVITY_HOOKS_END = "# END OPENRIG MANAGED ACTIVITY HOOKS";
const OPENRIG_ACTIVITY_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;

/**
 * 幂等地将 OpenRig activity hook 写入 Codex config.toml：固定 `[features].hooks = true`
 *（canonical key），并添加由哨兵包裹的内联 `[[hooks.<Event>]]` stanza 托管块（每层一种表示，
 * 绝不另建同级 hooks.json）。以相同 relay 路径重复运行为空操作；后台服务路径变化时替换该块。
 * `command` 是 TOML literal 字符串，因此绝对 relay 路径无需转义；内层双引号为 Codex 运行 hook
 * 的 shell 引用路径参数。不设 matcher（已在 0.139 验证：无 matcher 会对每个轮次范围事件触发）。
 */
function upsertCodexActivityHooks(content: string, relayPath: string): string {
  const command = `'node "${relayPath}"'`;
  const stanzas = OPENRIG_ACTIVITY_HOOK_EVENTS
    .map((ev) => `[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = ${command}\ntimeout = 5`)
    .join("\n\n");
  const block = `${OPENRIG_ACTIVITY_HOOKS_BEGIN}\n${stanzas}\n${OPENRIG_ACTIVITY_HOOKS_END}\n`;

  let next = upsertCodexFeaturesHooksEnabled(content);

  const pattern = new RegExp(
    `${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_BEGIN)}[\\s\\S]*?${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_END)}\\n?`,
    "m"
  );
  if (pattern.test(next)) {
    return next.replace(pattern, block);
  }
  const prefix = next.replace(/\n*$/, "");
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

/**
 * OPR.0.4.1.10 B3——移除 OpenRig 托管的 activity-hooks 哨兵块（持久禁用）。只删除
 * BEGIN..END 块及追加时附带的前导空行分隔符；其他内容——用户 hook、[features]、项目 trust——
 * 保持不变。块不存在时原样返回输入。
 */
function stripCodexActivityHooks(content: string): string {
  const pattern = new RegExp(
    `\\n*${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_BEGIN)}[\\s\\S]*?${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_END)}[ \\t]*\\n?`,
    "m"
  );
  if (!pattern.test(content)) return content;
  return content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

/** 确保 `[features].hooks = true`（canonical key，而非已弃用的 codex_hooks 别名）。 */
function upsertCodexFeaturesHooksEnabled(content: string): string {
  const lines = content.length > 0 ? content.replace(/\n*$/, "").split("\n") : [];
  const featuresIndex = lines.findIndex(isCodexFeaturesHeader);
  if (featuresIndex === -1) {
    const prefix = lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
    return `${prefix}[features]\nhooks = true\n`;
  }
  let nextSectionIndex = lines.length;
  for (let i = featuresIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) { nextSectionIndex = i; break; }
  }
  const flagIndex = lines.findIndex(
    (line, index) => index > featuresIndex && index < nextSectionIndex && /^\s*hooks\s*=/.test(line)
  );
  if (flagIndex >= 0) {
    lines[flagIndex] = "hooks = true";
  } else {
    lines.splice(featuresIndex + 1, 0, "hooks = true");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * 对每一行，判断它是否从文档层开始，即位于所有字符串、数组和内联表之外。在文档层，TOML
 * 语法只允许表头以 `[` 开始，因此这一个 bit 就足以完成整个表头判断；其他位置的 `[` 都是值语法。
 *
 * 两部分都是从静默错误答案中得到的教训：
 *  - 字符串：多行 basic 字符串内的 `\"""` 被误读为字符串结束符，使下一行被提升为表头
 *    （review50-r2，2026-09-01）。
 *  - 嵌套：多行数组的续行（`  [1, 2],`）被误读为表头，导致有效 fragment 被拆开并拒绝
 *    （review50-r2，2026-09-01）。区分二者的是深度，而不是该行自身文本。
 */
function lineStartsAtDocumentLevel(content: string): boolean[] {
  const out: boolean[] = [true];
  let multiline: '"""' | "'''" | null = null;
  let depth = 0;
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (multiline) {
      // 多行 BASIC 字符串遵循反斜杠转义，因此 `\"""` 是一个已转义引号再加两个引号，
      // 不是结束分隔符。相比之下，多行 LITERAL 字符串（'''）完全没有转义。忽略此点会把
      // `\"""` 读作字符串结束，并把下一行提升为表头（review50-r2，2026-09-01）。
      if (multiline === '"""' && ch === "\\") {
        // 计入已转义换行，使行索引保持对齐。
        if (content[i + 1] === "\n") out.push(false);
        i += 2;
        continue;
      }
      if (content.startsWith(multiline, i)) { multiline = null; i += 3; continue; }
      if (ch === "\n") out.push(false);
      i += 1;
      continue;
    }
    if (content.startsWith('"""', i)) { multiline = '"""'; i += 3; continue; }
    if (content.startsWith("'''", i)) { multiline = "'''"; i += 3; continue; }
    if (ch === "#") { while (i < content.length && content[i] !== "\n") i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      // 单行字符串不能跨换行；在换行处停止，使格式错误输入的行索引保持真实，而不是吞掉余下内容。
      while (i < content.length && content[i] !== quote && content[i] !== "\n") {
        if (quote === '"' && content[i] === "\\") i += 1;
        i += 1;
      }
      if (content[i] === quote) i += 1;
      continue;
    }
    // 表头自身方括号在同一行打开并关闭，因此换行时 depth 会回到 0；多行数组则在整个正文中
    // 保持 depth 增加。
    if (ch === "[" || ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (ch === "\n") { out.push(depth === 0); i += 1; continue; }
    i += 1;
  }
  return out;
}

/** 按表头拆分的 fragment：先是前言，随后每个表各一个条目。 */
function splitAtTableHeaders(fragment: string): Array<{ header: string | null; text: string }> {
  const structural = lineStartsAtDocumentLevel(fragment);
  const blocks: Array<{ header: string | null; lines: string[] }> = [{ header: null, lines: [] }];
  fragment.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (structural[index] === true && trimmed.startsWith("[")) {
      blocks.push({ header: trimmed, lines: [line] });
      return;
    }
    blocks[blocks.length - 1]!.lines.push(line);
  });
  return blocks.map((b) => ({ header: b.header, text: b.lines.join("\n") }));
}

function parsesAsToml(candidate: string): boolean {
  try { parseToml(candidate); return true; } catch { return false; }
}

/**
 * 拒绝在第一个表头之前声明 key 的 fragment。
 *
 * TOML 没有重新打开根级作用域的语法。托管块追加在用户文档末尾，因此用户文件一旦打开任何表，
 * 追加文本便无法把 key 绑定到文档根级；key 会静默加入用户最后所在的表。此接缝内部无法规避
 * 该限制：把块前置只会把同一问题反转到托管内容，重新序列化整份文档又会破坏用户注释和格式。
 * 因此诚实契约是拒绝。
 *
 * 拒绝是确定性的，不查询用户文件。fragment 作者看不到用户状态，因此依赖用户状态的规则会在
 * 测试中通过，却在现场因作者无法复现的原因失败。
 *
 * 从 fragment 的前言（首个文档级表头之前的所有内容）检测，而不是从解析后对象的值结构检测。
 * 裁定原先建议后者；前言方案意图相同但边界更严，因为保存内联表的已解析根 key
 *（`x = [{a=1}]`）在解析后与 array-of-tables 无法区分，会漏过检查，却会像其他根 key 一样
 * 绑定到用户的表。
 */
function assertFragmentOpensWithTable(fragment: string, sourcePath: string, id: string): void {
  const preamble = splitAtTableHeaders(fragment)[0];
  const declaresSomething = (preamble?.text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#"));
  if (!declaresSomething) return;
  throw new Error(
    `Codex 配置 fragment '${id}' 在首个表头之前声明了根级 key（${sourcePath}）；` +
    `追加的 TOML 无法绑定到文档根级——请先打开一个表。未投影任何内容，现有配置保持不变。`,
  );
}

/**
 * 托管 fragment 本身必须是有效 TOML 文档，并在任何冲突筛选之前检查。否则 fragment 中的创作
 * 错误无法与用户冲突区分，会被静默丢弃；写入随后恰恰因为错误输入被删除而成功，这与渲染守卫
 * 的目的相反。
 */
function assertFragmentParsesStandalone(fragment: string, sourcePath: string, id: string): void {
  try {
    parseToml(fragment);
  } catch (err) {
    throw new Error(
      `Codex 配置 fragment '${id}' 本身不是有效 TOML（${sourcePath}）；` +
      `未投影任何内容，现有配置保持不变。${(err as Error).message}`,
    );
  }
}

/**
 * 丢弃会与用户表冲突的 fragment 表。
 *
 * 冲突判断属于解析器，不属于我们。对 fragment 声明的每个表，我们让 smol-toml 判断把该表追加
 * 到用户文档后是否仍可解析。重复声明正是 TOML 会拒绝的内容，因此解析器回答的恰好就是我们
 * 需要的问题，且面对的是词法猜测最不可靠的任意输入——用户文件。
 *
 * 旧版本扫描用户文档中的表头行并比较路径。该扫描器错误处理了多行 basic 字符串中的反斜杠
 * 转义分隔符，把 `\"""` 读作字符串结束符、把下一行读作已声明表，并在投影报告成功时丢弃
 * 实际不冲突的托管表（review50-r2，2026-09-01，已复现）。对用户输入做词法扫描可能以这种
 * 静默方式出错，解析器则不会。
 *
 * 用户值绝不合并、重写或覆盖；冲突的托管表只会退出。
 *
 * 调用方必须先独立验证 fragment。“追加此块会使文档无法解析”有两个原因：用户拥有冲突路径，
 * 或块本身格式错误；此谓词无法区分二者。若无守卫，它会把两者都判断为“冲突”并删除无效的已编写
 * fragment，把资源错误变成看似干净的空托管块，同时回执仍称已投影
 *（review50-r2，2026-09-01，已复现）。`assertFragmentParsesStandalone` 在抵达此处前消除
 * 第二种原因，因此仍存在的失败是真实冲突。
 *
 * fragment 第一个表头之前的 key 永远不会到达此处：OPR.0.5.8.15 在上游
 * `assertFragmentOpensWithTable` 中拒绝该结构，因为追加的根 key 无法绑定到文档根级，会静默
 * 加入用户最后一个表。因此此函数看到的每个块都是表。
 */
function dropCollidingFragmentTables(
  fragment: string,
  userOwned: string,
): { kept: string; dropped: string[] } {
  const userParses = parsesAsToml(userOwned);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const block of splitAtTableHeaders(fragment)) {
    const collides =
      block.header !== null &&
      userParses &&
      !parsesAsToml(`${userOwned}\n${block.text}`);
    if (collides) dropped.push(block.header!);
    else kept.push(block.text);
  }
  return {
    kept: kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, ""),
    dropped,
  };
}

function upsertManagedCodexConfigFragment(content: string, id: string, fragment: string): string {
  const start = `# BEGIN OPENRIG MANAGED CODEX CONFIG FRAGMENT: ${id}`;
  const end = `# END OPENRIG MANAGED CODEX CONFIG FRAGMENT: ${id}`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");

  // 当前块之外的一切都是 fragment 不得冲突的内容。排除我们自己的旧块，因为重新投影会整体替换
  // 它；若把它计入，第二次投影会丢弃第一次合法落地的全部内容。
  const userOwned = content.replace(pattern, "");
  const { kept } = dropCollidingFragmentTables(fragment, userOwned);
  const block = `${start}\n${kept}\n${end}\n`;

  if (pattern.test(content)) {
    return content.replace(pattern, block);
  }

  const prefix = content.replace(/\n*$/, "");
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

/**
 * 拒绝把 Codex 无法加载的配置交给它。在此抛错（而不是先写入再碰运气）可使格式错误的渲染完全
 * 不落盘；`project()` 将条目记录为 failed，现有文件保持不变。
 */
function assertRendersAsLoadableToml(rendered: string, configPath: string, id: string): void {
  try {
    parseToml(rendered);
  } catch (err) {
    throw new Error(
      `Codex 配置投影 '${id}' 会写入 Codex 无法解析的配置；` +
      `${configPath} 保持不变。${(err as Error).message}`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 模块私有（P1 pin——绝不导出）。真实 Codex profile 加载探针从 launchHarness 原样抽出：
// 动态 import 使生产环境保持延迟加载；execFn 通过 execSync 运行真实
// `codex -p <profile> mcp list`（UTF-8、管道 stdio、10 秒超时）。作为 adapter 默认
// verifyProfilePreflight 注入；测试替换为受控 stub。
async function defaultProfilePreflight(profile: string): Promise<CodexProfileProbeResult> {
  const { verifyCodexProfileLoads } = await import("../domain/codex-profile-preflight.js");
  const { execSync } = await import("node:child_process");
  const execFn = async (cmd: string) =>
    runSyncSite("codex.runtime.profile_preflight", () =>
      execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 })
    );
  return verifyCodexProfileLoads(profile, execFn);
}

// 导出供单元测试（B12-T）使用：真实异步采样路径。反空洞测试直接驱动此默认实现
//（其他测试套件都注入同步 stub），并断言 B12 前同步实现违反的非阻塞属性。
export async function defaultListProcesses(): Promise<CodexProcess[]> {
  return listNativeProcesses();
}

function findCodexDescendantPids(
  processes: Array<{ pid: number; ppid: number; command: string }>,
  parentPid: number
): number[] {
  const childrenByParent = new Map<number, Array<{ pid: number; command: string }>>();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ppid) ?? [];
    siblings.push({ pid: proc.pid, command: proc.command });
    childrenByParent.set(proc.ppid, siblings);
  }

  const matches: number[] = [];
  const visit = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      visit(child.pid);
      if (commandLooksLikeCodex(child.command)) {
        matches.push(child.pid);
      }
    }
  };

  visit(parentPid);
  return matches;
}

function commandLooksLikeCodex(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    const base = nodePath.basename(unquoted);
    return base === "codex";
  });
}

function isSkippableCodexUpdatePrompt(paneContent: string): boolean {
  return paneContent.includes("Update available!")
    && /^\s*[›>]?\s*3\. Skip until next version\s*$/m.test(paneContent);
}
