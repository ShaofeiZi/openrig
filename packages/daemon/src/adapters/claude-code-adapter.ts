import nodePath from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { claudePostureFlag, claudeClassicRendererEnvPrefix } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { mergeManagedBlock, DEFAULT_CLAUDE_MANAGED_BLOCK_FILE, type ClaudeManagedBlockFile } from "../domain/managed-blocks.js";
import { shellQuote } from "./shell-quote.js";
import { validateClaudeActivityHookDelivery } from "../domain/claude-activity-hooks.js";
import { observeClaudePermission } from "../domain/permission-drift.js";
import { unresolvedClaudePermissionModes } from "../domain/native-permission-selection.js";
import type { ClaudeManagedLaunch } from "../domain/claude-managed-launch.js";
import { contextUsageDirectory, providerUsageDirectory } from "../domain/telemetry-state-paths.js";

export interface ClaudeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  copyFile(src: string, dest: string): void;
  listFiles?(dirPath: string): string[];
  /** 源文件权限位（用于保留 mode 的投影）。可选；缺失时不保留 mode。 */
  statMode?(path: string): number;
  /** 将权限位应用到文件（用于保留 mode 的投影）。可选；缺失时为空操作。 */
  chmod?(path: string, mode: number): void;
  /** 列出目录中的文件（用于捕获 session token）。 */
  readdir?(dirPath: string): string[];
  /** 用户主目录（用于查找 session 文件）。 */
  homedir?: string;
}

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

// 真实 Claude Code 二进制需要 1–3 秒才能在 ~/.claude/sessions/ 下写入新的 fork session-name
// 文件，因此使用轮询而非单次查询。12 × 500ms = 6 秒上限，明显高于观测到的冷启动 fork 文件
// 写入窗口，同时不会让错误 token 的反馈显得迟缓。
const FORK_POLL_ATTEMPTS = 12;
const FORK_POLL_DELAY_MS = 500;

/**
 * Claude Code runtime adapter。将资源投影到 .claude/ 目标，并通过 guidance 合并、skill 安装
 * 或 tmux send-text 投递启动文件。
 */
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly runtime = "claude-code";
  private tmux: TmuxAdapter;
  private fs: ClaudeAdapterFsOps;
  private sessionIdFactory: () => string;
  private sleep: (ms: number) => Promise<void>;
  private stateDir: string | null;
  private collectorAssetPath: string | null;
  private autoDriveProviderPrompts: boolean;
  readonly claudeManagedLaunch?: ClaudeManagedLaunch;
  private activityRelayPath: string | null;
  private claudeHooksManifestPath: string | null;
  /** P20——投影文件写入目标后调用，使 manifest 记录最近写入内容
   *（用于区分操作员修改与陈旧投影）。默认为空操作。 */
  private recordProjection: (targetPath: string, content: string) => void;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: ClaudeAdapterFsOps;
    sessionIdFactory?: () => string;
    sleep?: (ms: number) => Promise<void>;
    stateDir?: string;
    collectorAssetPath?: string;
    autoDriveProviderPrompts?: boolean;
    claudeManagedLaunch?: ClaudeManagedLaunch;
    /** activity-relay.cjs 资产的依赖注入来源（与 Codex adapter 一致）。 */
    activityRelayPath?: string;
    /** canonical claude.json hooks manifest 的依赖注入来源；事件词汇从中派生
     *（筛选 relay 事件），而不是另设平行常量。 */
    claudeHooksManifestPath?: string;
    /** P20——应用时记录钩子（startup 将其连接到投影 manifest 存储）。缺失时为空操作
     *（manifest 保持为空，判别能力安全降级到 P17）。 */
    recordProjection?: (targetPath: string, content: string) => void;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sessionIdFactory = deps.sessionIdFactory ?? randomUUID;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stateDir = deps.stateDir ?? null;
    this.collectorAssetPath = deps.collectorAssetPath ?? null;
    this.autoDriveProviderPrompts = deps.autoDriveProviderPrompts ?? false;
    this.claudeManagedLaunch = deps.claudeManagedLaunch;
    this.activityRelayPath = deps.activityRelayPath ?? null;
    this.claudeHooksManifestPath = deps.claudeHooksManifestPath ?? null;
    this.recordProjection = deps.recordProjection ?? (() => {});
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".claude", "skills");
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
        const didProject = this.projectEntry(entry, binding.cwd, binding.claudeManagedBlockFile ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE);
        if (didProject) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    // Activity hook 协调由这个始终运行的接缝驱动，而不是逐条目投影：移除资源的 profile 不会
    // 产生条目，因此 strip/disable 分支必须由计划中的缺失触发，而非由条目触发，才能让持久禁用
    // 在生产中可达。只调用一次。
    const activityEntries = plan.entries.filter(
      (e) => e.category === "runtime_resource" && e.resourceType === "claude_activity_hooks",
    );
    let activityOutcome: ActivityHookOutcome = { changed: false, delivered: false, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: false };
    try {
      activityOutcome = this.reconcileClaudeActivityHooks(binding.cwd, activityEntries.length > 0);
    } catch (err) {
      console.error(`[zrig] Claude activity hook 协调警告：${(err as Error).message}`);
      activityOutcome = { changed: false, delivered: false, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: false };
    }
    // 无法投递时（relay 源缺失，或 settings 文件格式错误并关闭失败）绝不能声称资源已投影；
    // 降级为 skipped，避免把虚假的投影声明和悬空 hook 报告为成功。
    if (activityEntries.length > 0 && !activityOutcome.delivered) {
      for (const e of activityEntries) {
        const idx = projected.indexOf(e.effectiveId);
        if (idx >= 0) projected.splice(idx, 1);
        if (!skipped.includes(e.effectiveId)) skipped.push(e.effectiveId);
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    try { this.ensureManagedBootstrap(binding); } catch (err) {
      console.error(`[zrig] Claude bootstrap 警告：${(err as Error).message}`);
    }

    // 尽力为托管 Claude session 配置 context collector。
    try { this.ensureContextCollector(binding); } catch (err) {
      // 记录但不失败——collector 配置是尽力而为。
      console.error(`[zrig] context collector 配置警告：${(err as Error).message}`);
    }

    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, binding.claudeManagedBlockFile ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE);
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // 跳过 rig-role：不计为已投递。
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".claude", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            const skillTarget = nodePath.join(targetDir, nodePath.basename(file.path));
            this.fs.writeFile(skillTarget, content);
            // P20——记录刚写入的内容，使下一次投影能区分陈旧重投影（可安全覆盖）与操作员编辑
            //（需要保护）。
            this.recordProjection(skillTarget, content);
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
    binding = { ...binding };
    opts = { ...opts, ...(opts.forkSource ? { forkSource: { ...opts.forkSource } } : {}) };
    if (!binding.tmuxSession) {
      return { ok: false, error: "未绑定 tmux session——无法启动 Claude Code harness" };
    }

    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken 与 forkSource 互斥——请选择一个" };
    }

    // OPR.0.4.8.2：默认使用 acceptEdits floor；选择启用 YOLO 后改为 full-bypass 标志。
    // restore 路径（claude-resume.ts）使用同一个 claudePostureFlag 决策。
    // OPR.0.4.8.3 接缝 B：逐席位解析的策略姿态（binding.launchPosture）覆盖环境变量。
    let managed: Awaited<ReturnType<ClaudeManagedLaunch["prepare"]>> | undefined;
    if (binding.permissionMode !== undefined) {
      try {
        if (!this.claudeManagedLaunch) await unresolvedClaudePermissionModes();
        managed = await this.claudeManagedLaunch!.prepare({ nodeId: binding.nodeId, cwd: binding.cwd,
          session: binding.tmuxSession, pane: binding.tmuxPane, generation: binding.launchGeneration }, binding.permissionMode);
      } catch (error) { return { ok: false, error: (error as Error).message }; }
    }
    const permissionMode = claudePostureFlag(process.env, binding.launchPosture, binding.permissionMode);
    const appliedLaunch = observeClaudePermission(permissionMode);
    // OPR.0.5.3.1：classic-renderer 环境前缀（默认开启）使所有托管启动路径
    //（fresh/resume/fork）获得原生 scrollback。覆盖为关闭时返回 ""，命令逐字节不变。
    const rendererPrefix = claudeClassicRendererEnvPrefix(process.env);

    // 51-07：spec 声明的逐智能体 model（member.model ?? profile ?? defaults，在实例化时解析到
    // binding.model）以 `--model <x>` 写入启动命令。缺失 → 空字符串 → 命令逐字节不变
    //（回归 pin）。仅做增量添加：它位于 permissionMode/posture 标志旁，但绝不修改后者
    //（D1 仅 model 边界）。镜像 Codex 的 modelArg（codex-runtime-adapter.ts）。注意：restore
    // 路径（claude-resume.ts）与原生 resume-cmd 构建器是具名 A2 restore-parity 后续项，
    // 不属于此 atom。
    const model = binding.model?.trim();
    const modelArg = model ? ` --model ${shellQuote(model)}` : "";

    // Fork 分支：构建 `claude --resume <parent> --fork-session --name <seat>` 并捕获 fork 后
    // 的新 session id。父 token 绝不持久化到新席位记录（身份诚实基石）。
    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `claude-code fork：v1 不支持 ref.kind="${opts.forkSource.kind}"；请使用 ref.kind="native_id" 并提供先前会话的 session id`,
        };
      }
      const parentId = opts.forkSource.value?.trim();
      if (!parentId) {
        return { ok: false, error: "claude-code fork：必须提供 forkSource.value（父 native_id）" };
      }
      const cmd = managed ? managed.command(["--permission-mode", binding.permissionMode!, ...(model ? ["--model", model] : []),
        "--resume", parentId, "--fork-session", "--name", opts.name])
        : `${rendererPrefix}claude ${permissionMode}${modelArg} --resume ${parentId} --fork-session --name ${opts.name}`;
      const textResult = managed ? await this.tmux.sendShellCommand(binding.tmuxSession, cmd, managed.assertCurrent)
        : await this.tmux.sendText(binding.tmuxSession, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `发送启动命令失败：${textResult.message}` };
      }
      const enterResult = managed ? { ok: true as const } : await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `发送 Enter 失败：${enterResult.message}` };
      }
      // claude 需要 1–3 秒才能在 ~/.claude/sessions/ 下写入新的 fork session-name 文件。
      // 原实现按下 Enter 后立即捕获 token，对真实二进制总是返回 undefined。改用
      // verifyResumeLaunch 的节奏轮询（12 × 500ms = 6 秒上限）。
      const newToken = await this.pollForResumeToken(opts.name, FORK_POLL_ATTEMPTS, FORK_POLL_DELAY_MS, managed?.configDir);
      if (!newToken) {
        return {
          ok: false,
          error: `claude-code fork：轮询 ${FORK_POLL_ATTEMPTS} 次后仍无法从 Claude session 存储捕获 fork 后的新 session id（上限 ${(FORK_POLL_ATTEMPTS * FORK_POLL_DELAY_MS) / 1000}s）`,
        };
      }
      return { ok: true, resumeToken: newToken, resumeType: "claude_id", appliedLaunch };
    }

    const generatedSessionId = opts.resumeToken ? null : this.sessionIdFactory();
    const cmd = managed ? managed.command(["--permission-mode", binding.permissionMode!, ...(model ? ["--model", model] : []),
      ...(opts.resumeToken ? ["--resume", opts.resumeToken] : ["--session-id", generatedSessionId!]), "--name", opts.name]) : opts.resumeToken
      ? `${rendererPrefix}claude ${permissionMode}${modelArg} --resume ${opts.resumeToken} --name ${opts.name}`
      : `${rendererPrefix}claude ${permissionMode}${modelArg} --session-id ${generatedSessionId} --name ${opts.name}`;

    const textResult = managed ? await this.tmux.sendShellCommand(binding.tmuxSession, cmd, managed.assertCurrent)
      : await this.tmux.sendText(binding.tmuxSession, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `发送启动命令失败：${textResult.message}` };
    }
    // 发送 Enter 执行。
    const enterResult = managed ? { ok: true as const } : await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `发送 Enter 失败：${enterResult.message}` };
    }

    if (opts.resumeToken) {
      const verification = await this.verifyResumeLaunch(binding.tmuxSession);
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "claude_id", appliedLaunch };
    }

    // 双重保障：优先使用立即可发现的持久 session，否则回退到启动时显式分配的 UUID。
    const token = this.captureResumeToken(opts.name, managed?.configDir);
    return { ok: true, resumeToken: token ?? generatedSessionId ?? undefined, resumeType: "claude_id", appliedLaunch };
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
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    const probe = assessNativeResumeProbe({
      runtime: "claude-code",
      paneCommand,
      paneContent,
    });

    if (probe.status === "resumed") return { ready: true };
    return { ready: false, reason: probe.detail, code: probe.code };
  }

  /** 为在启动路径之外接管的 tmux 绑定 Claude session 提供尽力而为的公开接缝。 */
  ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    this.provisionContextCollector(binding);
  }

  /** 为托管 session 使用的用户范围 Claude bootstrap 提供尽力而为的公开接缝。 */
  ensureManagedBootstrap(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    this.provisionManagedBootstrap(binding);
  }

  // -- 私有辅助函数 --

  private async verifyResumeLaunch(tmuxSession: string): Promise<HarnessLaunchResult> {
    const attempts = 16;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "claude-code",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_conversation_found") {
        return {
          ok: false,
          error: "Claude resume 失败：找不到所请求 session 的会话",
          recovery: "retry_fresh",
        };
      }

      if (probe.status === "resumed") {
        return { ok: true };
      }

      // OPR.0.3.4.5：Claude resume 选择提示 → attention_required，而非 timed-out。菜单仍存活
      // 且可恢复；自动选择会阻塞治理。展示证据并立即退出。
      if (probe.status === "attention_required") {
        return {
          ok: false,
          error: probe.detail,
          recovery: "attention_required",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (this.autoDriveProviderPrompts && probe.code === "trust_gate") {
        const enterResult = await this.tmux.sendKeys(tmuxSession, ["Enter"]);
        if (!enterResult.ok) {
          return { ok: false, error: `自动处理 Claude trust 提示失败：${enterResult.message}` };
        }
        await this.sleep(200);
        continue;
      }

      if (attempt < attempts - 1) {
        await this.sleep(200);
      }
    }

    const finalCommand = await this.tmux.getPaneCommand(tmuxSession);
    const finalContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
    const finalProbe = assessNativeResumeProbe({
      runtime: "claude-code",
      paneCommand: finalCommand,
      paneContent: finalContent,
    });

    if (finalProbe.status === "resumed") {
      return { ok: true };
    }

    if (finalProbe.status === "attention_required") {
      return {
        ok: false,
        error: finalProbe.detail,
        recovery: "attention_required",
        evidence: finalContent.split("\n").slice(-12).join("\n"),
      };
    }

    if (finalCommand && SHELL_COMMANDS.has(finalCommand)) {
      return {
        ok: false,
        error: "Claude resume 失败：pane 返回 shell，而未进入 Claude",
        recovery: "retry_fresh",
      };
    }

    return { ok: false, error: "Claude resume 失败：等待 Claude 进入活跃状态超时" };
  }

  private projectEntry(entry: ProjectionEntry, cwd: string, managedBlockFile: ClaudeManagedBlockFile): boolean {
    if (entry.category === "runtime_resource" && this.applyRuntimeResource(entry, cwd)) {
      return true;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, managedBlockFile);
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    // HG-1.3 插件 runtime 适用性筛选（依据 DESIGN.md §5.1）：
    // 显式 pluginType="codex" → 跳过 Claude 投影；
    // pluginType="auto"（或未设置）且没有 .claude-plugin/ manifest 目录 → 跳过；
    // 显式 pluginType="claude" → 无论 manifest 是否存在都投影。
    if (entry.category === "plugin" && !this.pluginAppliesToClaude(entry)) {
      return false;
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return true;

    this.fs.mkdirp(targetDir);
    const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;

    if (isDir && this.fs.listFiles) {
      // 目录形态：递归复制。
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
      // 文件形态：复制单个文件（subagent、作为 YAML 文件的 hook）。
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

  private pluginAppliesToClaude(entry: ProjectionEntry): boolean {
    const explicit = entry.pluginType ?? "auto";
    if (explicit === "claude") return true;
    if (explicit === "codex") return false;
    // auto：根据源树中是否存在 .claude-plugin/plugin.json 检测。
    return this.fs.exists(nodePath.join(entry.absolutePath, ".claude-plugin", "plugin.json"));
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(cwd, ".claude", "skills", entry.effectiveId);
      case "guidance": return null; // 通过 merge 处理。
      case "subagent": return nodePath.join(cwd, ".claude", "agents");
      case "plugin": return nodePath.join(cwd, ".claude", "plugins", entry.effectiveId);
      case "runtime_resource": return nodePath.join(cwd, ".claude", "extensions", entry.effectiveId);
      default: return null;
    }
  }

  private applyRuntimeResource(entry: ProjectionEntry, cwd: string): boolean {
    switch (entry.resourceType) {
      case "claude_settings_fragment":
        this.mergeJsonFragment(entry.absolutePath, nodePath.join(cwd, ".claude", "settings.local.json"));
        return true;
      case "claude_mcp_fragment":
        this.mergeJsonFragment(entry.absolutePath, nodePath.join(cwd, ".mcp.json"));
        return true;
      case "claude_activity_hooks":
        // 已处理（不做通用 .claude/extensions 复制）：relay 资产投递与 settings hook 协调由
        // 始终运行的 project() 接缝通过 reconcileClaudeActivityHooks 完成，而非逐条目投影。
        return true;
      default:
        return false;
    }
  }

  private mergeJsonFragment(sourcePath: string, targetPath: string): void {
    const fragment = this.readJsonObjectStrict(sourcePath);
    const existing = this.readJsonObject(targetPath);
    const merged = mergeJsonObjects(existing, fragment);
    this.fs.mkdirp(nodePath.dirname(targetPath));
    this.fs.writeFile(targetPath, JSON.stringify(merged, null, 2));
  }

  /**
   * 将托管块合并到目标 guidance 文件。完成合并时返回 `true`，有意跳过时返回 `false`
   *（目前只有 `rig-role` 情况，见注释）。调用方传播跳过信号，使 ProjectionResult 与
   * StartupDeliveryResult 报告真实计数，而不是声称完成了并未落地的合并。
   */
  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // `rig-role` 托管块按席位编写，但通过不关联席位的（目标文件 × spec）投影路径投递，因此多个
    // pod 同伴的角色正文会冲突到同一个 CLAUDE.md。修复方式是改由保留席位身份的 `send_text`
    // 启动路径路由逐席位内容。这里明确拒绝合并，避免冲突静默落地。参见 ADR-0006。
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

  /**
   * 尽力从 ~/.claude/sessions/*.json 捕获 token。查找名称与预期 session 名匹配的 session
   * 文件；找到时返回 sessionId，否则返回 undefined。
   */
  /**
   * PL-016 加固 v0+1——按 verifyResumeLaunch 节奏轮询 captureResumeToken。session 文件一出现
   * 就返回 token；超过 attempts × delayMs 上限后返回 undefined。用于 fork 分支：新
   * session-name 文件会在发送 Enter 后 1–3 秒出现（冷启动 fork 文件写入）。
   */
  private async pollForResumeToken(
    expectedName: string,
    attempts: number,
    delayMs: number,
    configDir?: string,
  ): Promise<string | undefined> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const token = this.captureResumeToken(expectedName, configDir);
      if (token) return token;
      if (attempt < attempts - 1) {
        await this.sleep(delayMs);
      }
    }
    return undefined;
  }

  private captureResumeToken(expectedName: string, configDir?: string): string | undefined {
    try {
      const home = this.fs.homedir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
      if ((!home && !configDir) || !this.fs.readdir) return undefined;
      const sessDir = nodePath.join(configDir ?? nodePath.join(home!, ".claude"), "sessions");
      if (!this.fs.exists(sessDir)) return undefined;
      const files = this.fs.readdir(sessDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const content = this.fs.readFile(nodePath.join(sessDir, file));
          const data = JSON.parse(content) as { sessionId?: string; name?: string };
          if (data.name === expectedName && data.sessionId) {
            return data.sessionId;
          }
        } catch { /* 跳过格式错误的文件。 */ }
      }
    } catch { /* 尽力而为。 */ }
    return undefined;
  }

  private detectDeliveryHint(path: string, content: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content);
  }

  private provisionManagedBootstrap(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    // OPR.0.4.8.2 无关性拆除：已移除 provisionRigPermissions（C2）；OpenRig 不再编写任何
    // 配置文件权限策略。Trust/onboarding（C3/C4）是中性管道，予以保留。
    this.provisionWorkspaceTrust(binding.cwd ?? null);
    this.provisionOnboardingState();
  }

  // OPR.0.4.8.2 无关性拆除：CONVENIENCE_BASELINE（全局允许 `Bash(rig:*)`）及其
  // provisionRigPermissions 写入器（评估第 C2 行——带 `_openrig_provenance` 标记写入
  // ~/.claude/settings.json）已删除。OpenRig 不再编写配置文件权限策略；harness 原生权限界面
  // 才是控制界面。不会追溯清理现有带来源标记的用户文件；新代码只是永远不触碰 settings.json。

  private provisionWorkspaceTrust(cwd: string | null): void {
    if (!cwd) return;
    const home = this.fs.homedir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
    if (!home) return;

    const statePath = nodePath.join(home, ".claude.json");
    const state = this.readJsonObject(statePath);
    const projects = this.readJsonObjectField(state, "projects");

    for (const trustKey of this.workspaceTrustKeys(cwd)) {
      const projectState = this.readJsonObjectField(projects, trustKey);
      projectState["hasTrustDialogAccepted"] = true;
      projects[trustKey] = projectState;
    }

    state["projects"] = projects;
    this.fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  private provisionOnboardingState(): void {
    const home = this.fs.homedir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
    if (!home) return;

    const statePath = nodePath.join(home, ".claude.json");
    const state = this.readJsonObject(statePath);
    state["hasCompletedOnboarding"] = true;
    this.fs.writeFile(statePath, JSON.stringify(state, null, 2));
  }

  private workspaceTrustKeys(cwd: string): string[] {
    const keys = new Set<string>([nodePath.resolve(cwd)]);
    try {
      keys.add(fs.realpathSync.native(cwd));
    } catch {
      // 仅尽力而为——不存在的测试路径仍可使用已解析输入。
    }
    return Array.from(keys);
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

  private readJsonObjectStrict(path: string): Record<string, unknown> {
    const parsed = JSON.parse(this.fs.readFile(path));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(`${path} 必须是 JSON 对象`);
  }

  private readJsonObjectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  // OPR.0.4.8.2 拆除：已移除 readStringArray；其唯一调用方是 provisionRigPermissions（C2）。

  /**
   * 尽力为托管 Claude session 配置 OpenRig context collector。写入 collector 脚本，并将
   * status line 配置合并到 .claude/settings.local.json。操作幂等，可安全多次调用
   *（合并会保留现有设置）。
   */
  private provisionContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void {
    if (!this.stateDir || !this.collectorAssetPath || !binding.cwd) return;
    const contextDir = contextUsageDirectory(this.stateDir);
    const providerUsageDir = providerUsageDirectory(this.stateDir);
    this.fs.mkdirp(contextDir);
    this.fs.mkdirp(providerUsageDir);

    // 1. 将 collector 脚本复制到项目。
    const collectorDest = nodePath.join(binding.cwd, ".openrig", "context-collector.cjs");
    this.fs.mkdirp(nodePath.dirname(collectorDest));
    this.fs.copyFile(this.collectorAssetPath, collectorDest);

    // 2. 将 status line 配置合并到 .claude/settings.local.json。
    const settingsPath = nodePath.join(binding.cwd, ".claude", "settings.local.json");
    this.fs.mkdirp(nodePath.dirname(settingsPath));

    const existing = this.readJsonObject(settingsPath);

    const collectorCmd = `node ${collectorDest} ${contextDir} ${providerUsageDir}`;
    existing["statusLine"] = {
      ...(typeof existing["statusLine"] === "object" && existing["statusLine"] !== null ? existing["statusLine"] as Record<string, unknown> : {}),
      type: "command",
      command: collectorCmd,
    };

    this.fs.writeFile(settingsPath, JSON.stringify(existing, null, 2));
  }

  /**
   * 将 `.claude/settings.local.json` 中由 OpenRig 管理的 activity-relay hook 协调到所需的
   * `enabled` 状态；由始终运行的 `project()` 接缝驱动一次。
   *
   * 启用（仅在 relay 源可读时）：将 `activity-relay.cjs` 投递到
   * `<cwd>/.openrig/hooks/scripts/`（保留 mode，源资产为 0755），并为从 canonical claude.json
   * manifest 派生的每个 relay 事件 upsert 所有命令（排除 compaction hook）。源缺失时不投递任何
   * 内容（无悬空命令），并报告 `sourceMissing`，使调用方展示警告且不声称已投影。禁用时删除
   * 所有条目，并清理空容器。
   *
   * 所有权由准确的 `node <quoted relay path>` 命令形态决定，因此陈旧/变化的绝对前缀会被替换
   *（绝不重复），而仅仅包含该路径的用户命令会保留。关闭失败：无法解析的 settings 文件保持
   * 逐字节不变。不使用 `mergeJsonFragment`，因为按 key 增量合并无法在禁用时删除。
   */
  private reconcileClaudeActivityHooks(cwd: string, enabled: boolean): ActivityHookOutcome {
    const relayDest = nodePath.join(cwd, ".openrig", "hooks", "scripts", "activity-relay.cjs");
    const ownedCmd = `node ${shellQuote(relayDest)}`;
    const settingsPath = nodePath.join(cwd, ".claude", "settings.local.json");

    // 任何变更前都使用共享投递验证预检（与 preflight 使用同一门禁与解析器，无漂移）。只有 relay
    // 源与非空 canonical 事件集都能解析时，启用才可投递。请求启用但不可投递时（relay 缺失，
    // 或 manifest 缺失/格式错误/无 relay 事件）不做任何操作：不删除、不复制、不写入，从而保留
    // 现有托管 hook 和 settings 字节，也不声称资源已投递/投影（即警告 + 跳过）。
    const delivery = validateClaudeActivityHookDelivery(this.fs, this.activityRelayPath, this.claudeHooksManifestPath);
    const derivedEvents = delivery.events;
    const deliverable = enabled && delivery.deliverable;
    if (enabled && !deliverable) {
      return {
        changed: false, delivered: false,
        sourceMissing: !delivery.relaySourceOk,
        manifestUnavailable: delivery.relaySourceOk && delivery.events.length === 0,
        settingsUnparseable: false,
      };
    }

    const settingsExisted = this.fs.exists(settingsPath);
    // 关闭失败：绝不覆盖无法解析的 settings 文件，保持其字节不变。
    let settings: Record<string, unknown>;
    if (settingsExisted) {
      try { settings = this.readJsonObjectStrict(settingsPath); }
      catch { return { changed: false, delivered: false, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: true }; }
    } else {
      settings = {};
    }

    const hooks = this.readJsonObjectField(settings, "hooks");

    // 1. 从所有事件中删除 OpenRig 所有的 relay 条目（准确 node 命令结构）；清理空 group 与事件。
    //    用户编写的 hook 保持不变。
    let changed = false;
    for (const event of Object.keys(hooks)) {
      const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : null;
      if (!groups) continue;
      const keptGroups: unknown[] = [];
      for (const group of groups) {
        if (!isPlainObject(group) || !Array.isArray(group["hooks"])) { keptGroups.push(group); continue; }
        const groupHooks = group["hooks"] as unknown[];
        const keptHooks = groupHooks.filter((h) => !isOwnedRelayCommand(hookCommand(h)));
        if (keptHooks.length !== groupHooks.length) changed = true;
        if (keptHooks.length === 0) continue; // 清理空 group。
        keptGroups.push({ ...group, hooks: keptHooks });
      }
      if (keptGroups.length === 0) delete hooks[event]; // 清理空事件。
      else hooks[event] = keptGroups;
    }

    // 2. 可投递的启用：复制 relay 资产，并为每个已预验证的 relay 事件（从上述 canonical
    //    manifest 派生）upsert 所有条目。
    if (deliverable) {
      this.fs.mkdirp(nodePath.dirname(relayDest));
      this.fs.copyFile(this.activityRelayPath!, relayDest);
      this.preserveMode(this.activityRelayPath!, relayDest);
      for (const { event, timeout } of derivedEvents) {
        const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
        const hook: Record<string, unknown> = { type: "command", command: ownedCmd };
        if (typeof timeout === "number") hook["timeout"] = timeout;
        groups.push({ hooks: [hook] });
        hooks[event] = groups;
        changed = true;
      }
    }

    // 3. 仅在发生变化时持久化（绝不触碰未变化/从未托管的文件）。
    if (!changed) return { changed: false, delivered: deliverable, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: false };
    if (Object.keys(hooks).length > 0) settings["hooks"] = hooks;
    else delete settings["hooks"];
    this.fs.mkdirp(nodePath.dirname(settingsPath));
    this.fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    return { changed: true, delivered: deliverable, sourceMissing: false, manifestUnavailable: false, settingsUnparseable: false };
  }

}

interface ActivityHookOutcome {
  /** 已发生写入（添加或删除所有条目）。 */
  changed: boolean;
  /** 启用成功——relay + hook 已实际投递（保持 PROJECTED）。 */
  delivered: boolean;
  /** 请求启用但 relay 源缺失——未投递任何内容（即警告 + 跳过）。 */
  sourceMissing: boolean;
  /** 请求启用且 relay 存在，但 canonical manifest 缺失、格式错误或没有 relay 事件——不投递任何
   * 内容，保留现有托管 hook（即警告 + 跳过）。 */
  manifestUnavailable: boolean;
  /** 关闭失败：无法解析的 settings 文件已原样保留。 */
  settingsUnparseable: boolean;
}

// OpenRig 所有的 relay 路径后缀。所有权由准确的 `node <arg>` 命令判断，其唯一参数以此路径
// 结尾；前缀变化仍匹配（替换而不重复），仅包含该路径的用户命令（echo 或带额外参数的 node）
// 不匹配。
const OWNED_RELAY_SUFFIX = "/.openrig/hooks/scripts/activity-relay.cjs";

function hookCommand(hook: unknown): string | undefined {
  return isPlainObject(hook) && typeof hook["command"] === "string" ? (hook["command"] as string) : undefined;
}

function isOwnedRelayCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  const m = /^node\s+(.+)$/.exec(cmd.trim());
  if (!m) return false;
  const arg = m[1]!;
  const decoded = unquoteSingleShellToken(arg);
  if (decoded === null) return false;
  // Canonical 单 token 往返：参数必须恰好是一个 shellQuote token；重新编码已解码路径必须逐字节
  // 还原参数。这是所有权测试的核心：命令是 `node ${shellQuote(relayDest)}`，因此所有条目都会
  // 重编码为自身，包括通过 '"'"' 转义含撇号的 cwd O'Brien。它会拒绝这样的用户命令：多个
  // 带引号参数只是拼接后以 relay 后缀结尾（如 `node 'x' '<relay>'`）；绝不能把它识别为所有项
  // 并删除。
  if (shellQuote(decoded) !== arg) return false;
  return decoded.endsWith(OWNED_RELAY_SUFFIX);
}

/** 解码 shellQuote 生成的一个 POSIX 单引号 shell token（外层 `'…'`，内部 `'` 转义为
 * `'"'"'`）。token 未用单引号包裹时返回 null。调用方会重新编码以确认 token 是 canonical
 * 单 token；仅解码不足以确认。 */
function unquoteSingleShellToken(token: string): string | null {
  if (token.length < 2 || !token.startsWith("'") || !token.endsWith("'")) return null;
  return token.slice(1, -1).split(`'"'"'`).join("'");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function mergeJsonObjects(base: Record<string, unknown>, fragment: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(fragment)) {
    merged[key] = mergeJsonValue(merged[key], value);
  }
  return merged;
}

function mergeJsonValue(base: unknown, fragment: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(fragment)) {
    return mergeJsonObjects(base, fragment);
  }
  if (Array.isArray(base) && Array.isArray(fragment)) {
    return mergeJsonArrays(base, fragment);
  }
  return fragment;
}

function mergeJsonArrays(base: unknown[], fragment: unknown[]): unknown[] {
  const result = [...base];
  const seen = new Set(base.map(stableJsonKey));
  for (const item of fragment) {
    const key = stableJsonKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJsonKey(value: unknown): string {
  if (!isPlainObject(value)) return JSON.stringify(value);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

// ── OPR.0.5.5.19 A5——Claude self-report 阶梯（r3）：sessions/<pid>.json ────────
// Claude Code 自身状态 registry（自 v2.1.139 起）：<configDir>/sessions/ 下每个实时进程一个
// JSON 文件，携带 {name: <canonical tmux session name>, status: busy|idle|shell|waiting,
// statusUpdatedAt, ...}。这是自报、自带时间的事实（statusUpdatedAt），也是研究文档的最高阶梯；
// 此处按 `name` 字段（OpenRig canonical session 名称）解析，本路径无需 pane-pid 管道。
// 未公开内部实现：任何读取/解析/结构失败都返回 null，使阶梯降到下一层，绝不报错
//（SPEC mini-req 2a）。

export interface ClaudeSelfReportRead {
  listFiles(dir: string): string[];
  readFile(path: string): string;
}

const defaultSelfReportRead: ClaudeSelfReportRead = {
  listFiles: (dir) => fs.readdirSync(dir),
  readFile: (p) => fs.readFileSync(p, "utf8"),
};

/** 读取 `sessionName` 最新的 self-report 作为阶梯证据；没有则返回 null。映射：
 * busy→working；idle→idle-at-prompt；shell→idle-at-prompt（轮次结束，后台 shell 存活——
 * 经 omnigent 验证的映射）；waiting→needs-input（对话框占有输入；Claude 内部的 `waiting`
 * 不等于 omnigent 的同名状态，这是两个代码库都警示的冲突，因此不放入 activity 枚举）。 */
export function readClaudeSelfReportEvidence(input: {
  sessionsDir: string;
  sessionName: string;
  seatNodeId: string;
  read?: ClaudeSelfReportRead;
}): import("../domain/activity-taxonomy.js").ActivityEvidence | null {
  const read = input.read ?? defaultSelfReportRead;
  try {
    let best: { status: string; statusUpdatedAt: number } | null = null;
    for (const file of read.listFiles(input.sessionsDir)) {
      if (!file.endsWith(".json")) continue;
      let record: { name?: unknown; status?: unknown; statusUpdatedAt?: unknown };
      try {
        record = JSON.parse(read.readFile(nodePath.join(input.sessionsDir, file))) as typeof record;
      } catch {
        continue; // 单个格式错误文件绝不会破坏整个阶梯。
      }
      if (record.name !== input.sessionName) continue;
      if (typeof record.status !== "string" || typeof record.statusUpdatedAt !== "number") continue;
      if (!best || record.statusUpdatedAt > best.statusUpdatedAt) {
        best = { status: record.status, statusUpdatedAt: record.statusUpdatedAt };
      }
    }
    if (!best) return null;
    const base = {
      seatNodeId: input.seatNodeId,
      sessionName: input.sessionName,
      rung: "self-report" as const,
      sourceId: "claude:pid-json",
      seq: best.statusUpdatedAt, // 自带时间且单调。
      observedAt: new Date(best.statusUpdatedAt).toISOString(),
    };
    switch (best.status) {
      case "busy":
        return { ...base, activity: "working" };
      case "idle":
      case "shell":
        return { ...base, activity: "idle-at-prompt" };
      case "waiting":
        return { ...base, needsInput: { count: 1, reason: "对话框正在等待输入" } };
      default:
        return null; // 未知词汇——未公开内部实现，绝不猜测。
    }
  } catch {
    return null; // 目录不可读 ⇒ 降到下一阶梯。
  }
}
