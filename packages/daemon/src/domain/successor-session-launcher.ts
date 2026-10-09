import { ulid } from "ulid";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { RuntimeHint } from "./discovery-types.js";
import type { RuntimeAdapter, NodeBinding, ReadinessResult, ForkSource } from "./runtime-adapter.js";
import { isAttentionRequiredReadinessCode } from "./runtime-adapter.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import { isShellForeground } from "./shell-classifier.js";

/**
 * OPR.0.4.3.04——seat-handover 全周期 composer 的显式 successor 创建接缝
 *（IMPL-SPEC §2.1b；解决 rev1-dual BLOCKING B1）。
 *
 * 它为非 discovered handover source（fresh）创建一个未受管、可发现的 tmux successor，经真实
 * runtime startup 启动，使其成为 live、ready 的 agent（而非裸 shell），将其记录为 active
 * discovery candidate，并返回该 candidate 与捕获的启动 resume token，使 composer 可将其送入
 * 现有 discovered->commit rebind 路径。它刻意不调用 `registerClaimedSession`/`upsertBinding`——
 * session 在 handover `commit` 认领前保持未受管，因此 successor ready 前不会触碰离任 seat binding。
 *
 * B1（rev1-dual 修复）：通过 runtime adapter 的 `launchHarness` + readiness poll 启动 successor——
 * 与 `StartupOrchestrator` 驱动的 startup/readiness primitive 相同——但不执行其
 * `StartupOrchestrator.startNode` bookkeeping 步骤所需的提前 managed-session 注册
 *（updateStartupStatus / node_startup_context / 按 sessionId updateResumeToken 都需要已注册
 * session 行）。直接驱动 adapter primitive 可在 successor 成为 live agent 的同时，让其在 commit
 * 前保持未受管。任何 launch/readiness 失败都会展开已创建 session，并保持原 binding 完整
 *（commit 从不执行）。
 *
 * 不使用 `NodeLauncher.launchNode` 的原因：它拒绝已绑定 node，并在成功时于同一事务注册受管
 * session + binding，会在 commit 路径触发 `successor_already_managed`。本接缝改为创建独立的
 * 未受管 session。
 */
export interface SuccessorNode {
  id: string;
  runtime: string | null;
  cwd: string | null;
  /** OPR.0.4.8.3 接缝 B：离任 seat 已持久化的解析后 launch posture——successor 是同一 seat 的
   * continuity edge，因此沿用其 policy posture（调用方从 node provenance 填充；缺席 = env 决策）。 */
  launchPosture?: "floor" | "full_bypass";
  permissionMode?: string;
  /** 0.5.2-07 model fidelity：seat 在 SPEC 中锁定的 model（nodes.model）。successor 是同一 seat 的
   * continuity edge，因此启动时必须读取 SPEC；丢弃它的启动路径会使运行拓扑偏离 founder 设计。
   * 调用方从 node provenance 填充；缺席时 adapter 不生成 model flag（旧版/未锁定 seat 行为不变）。 */
  model?: string | null;
  /** 0.5.2-07 A4-profile：seat 在 SPEC 中锁定的 codex config profile
   *（nodes.codex_config_profile）。与 model 使用相同 continuity 理由；调用方从 node provenance
   * 填充；缺席时 adapter 不生成 -p flag（旧版/未锁定 seat 行为不变）。 */
  codexConfigProfile?: string | null;
}

export type SuccessorLaunchResult =
  | {
      ok: true;
      discoveredId: string;
      tmuxSession: string;
      tmuxPane: string;
      resumeToken?: string;
      resumeType?: string;
      appliedLaunch?: AppliedLaunchObservation;
      /**
       * OPR.0.4.6.02 S1——fresh successor 启动时产生的非致命 tmux option-default 警告
       *（mouse/status/clipboard）。仅在 option 设置降级时存在；干净路径省略（undefined），使结构
       * 与 02 前的 successor 保持字节兼容。
       */
      warnings?: string[];
    }
  | {
      ok: false;
      code: string;
      step: "create_successor" | "resolve_pane" | "start_agent";
      message: string;
      /** predecessor 进程在其 pane 中被替换后为 true。 */
      replacementStarted: boolean;
    };

export class SuccessorSessionLauncher {
  private tmuxAdapter: TmuxAdapter;
  private discoveryRepo: DiscoveryRepository;
  private sessionEnv: Record<string, string | undefined>;
  private newId: () => string;
  private runtimeAdapters: Record<string, RuntimeAdapter>;
  private readinessTimeoutMs: number;
  private sleep: (ms: number) => Promise<void>;
  private tmuxOptionDefaults: TmuxOptionDefaultsApplier | null;
  private exitPollMs: number;
  private exitTimeoutMs: number;

  constructor(
    tmuxAdapter: TmuxAdapter,
    discoveryRepo: DiscoveryRepository,
    opts: {
      sessionEnv?: Record<string, string | undefined>;
      newId?: () => string;
      /** 按运行时定键的运行时适配器，用于启动并就绪探测继任智能体。缺席时无法启动
       * 全新继任者。 */
      runtimeAdapters?: Record<string, RuntimeAdapter>;
      /** Readiness 超时（毫秒；默认 30000，与 StartupOrchestrator 一致）。 */
      readinessTimeoutMs?: number;
      /** 可注入的 sleep（测试用）。 */
      sleep?: (ms: number) => Promise<void>;
      /**
       * OPR.0.4.6.02 S1——共享 tmux option-default applier。fresh successor 是新的
       * operator/agent seat（与 NodeLauncher 同属仅启动类别），因此在新建 session 上获得相同的
       * mouse/status/clipboard 默认值。省略时跳过 option 应用。
       */
      tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
      /** Cutover 离任退出轮询间隔 + 总有界超时（每个 graceful/forced 阶段）。 */
      exitPollMs?: number;
      exitTimeoutMs?: number;
    } = {},
  ) {
    this.tmuxAdapter = tmuxAdapter;
    this.discoveryRepo = discoveryRepo;
    this.sessionEnv = opts.sessionEnv ?? {};
    this.newId = opts.newId ?? ulid;
    this.runtimeAdapters = opts.runtimeAdapters ?? {};
    this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tmuxOptionDefaults = opts.tmuxOptionDefaults ?? null;
    this.exitPollMs = opts.exitPollMs ?? 100;
    this.exitTimeoutMs = opts.exitTimeoutMs ?? 3_000;
  }

  /**
   * 创建未受管 successor tmux session，将其启动为 live agent，并记录为 active discovery
   * candidate。该 candidate 满足 discovered->commit 守卫：active（upsert 设置 status='active'）、
   * 名称不同、runtime hint 匹配、未受管（无 binding/session 认领）、tmux-present（刚创建）。返回的
   * resume token（若有）是 composer 在 commit 时持久化的启动抓取 token（fresh 的 B2）。
   */
  async createSuccessor(input: {
    node: SuccessorNode;
    departingSessionName: string;
    occupantGeneration?: string | null;
    /** 同步 physical-cutover observer；确认 retiree 已退出后、respawn 前运行。 */
    onReplacementStarted?: () => void;
    /** OPR.0.5.5.5 fork source：successor 作为此已解析 id 的原生 fork 启动（adapter forkSource
     * 接缝）；从第一个字节起就携带 incumbent 对话；返回的 resume token 是新的 fork 后 token，绝不是
     * parent token。缺席 → 普通 fresh 启动。 */
    forkSource?: ForkSource;
  }): Promise<SuccessorLaunchResult> {
    // CUTOVER 模型（plan 411c43de）：一个 SEAT = 一个持久 tmux session；successor 通过
    // respawn-pane 接管 retiree 的同一 pane，因此保留 canonical session 名（无 -h 调换）和原生
    // scrollback——predecessor 历史位于 successor 启动内容上方（关键 proof）。retiree 原地退出；其
    // provider session 文件是持久 wake target，因此新的 unwind 不变量是：失败的 successor 绝不破坏
    // 该可恢复状态。
    const departingSession = input.departingSessionName;

    // OpenRig identity env 与 NodeLauncher.launchNode 的模式一致，使 successor 能自我识别并像已启动
    // seat 一样报告活动。OPENRIG_SESSION_NAME 是保留的 canonical 名称。
    const env = compactEnv({
      OPENRIG_NODE_ID: input.node.id,
      OPENRIG_SESSION_NAME: departingSession,
      OPENRIG_RUNTIME: input.node.runtime ?? undefined,
      ...this.sessionEnv,
      OPENRIG_OCCUPANT_GENERATION: input.occupantGeneration ?? undefined,
    });
    const cwd = input.node.cwd ?? undefined;

    // 1. 解析离任 session 的 active pane，即将接管的 retiree pane。probe 抛错或结果为空会在任何
    //    respawn 前产生结构化 resolve_pane 失败，因此 seat 完全未触碰（仍是 live retiree，无需恢复）。
    let pane: { id: string } | undefined;
    try {
      const panes = await this.tmuxAdapter.listPanes(departingSession);
      pane = panes.find((p) => p.active) ?? panes[0];
    } catch (err) {
      return {
        ok: false,
        code: "pane_probe_failed",
        step: "resolve_pane",
        replacementStarted: false,
        message: `无法探测离任 session "${departingSession}" 的 tmux pane：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!pane) {
      return {
        ok: false,
        code: "pane_unresolved",
        step: "resolve_pane",
        replacementStarted: false,
        message: `无法为离任 session "${departingSession}" 解析 tmux pane。`,
      };
    }

    // 2. 原地终止 retiree，再不带 -k 地 respawn 已死亡 pane，使原生 scrollback 得以保留
    //    （tmux 3.6a 已验证 respawn-pane -k 会清空 pane 历史，会破坏关键 proof）。交换流程：设置
    //    remain-on-exit，使 pane 在退出后保留 → 优雅 SIGTERM（“原地退出”，也保护 successor resume
    //    所依赖的 provider session 状态）→ 有界超时 SIGKILL fallback（锁定的 degraded 路径）→
    //    在死亡 pane 上执行不带 -k 的 respawn-pane。
    const terminated = await this.terminateRetiree(pane.id);
    if (!terminated.ok) {
      return { ok: false, code: "retiree_not_terminated", step: "create_successor", message: terminated.message, replacementStarted: false };
    }
    input.onReplacementStarted?.();
    // KI-14：respawn 命令必须显式。无命令的 `respawn-pane` 会重新运行 pane 的创建命令或上次
    // respawn 命令；只有 createSession pane 才默认运行 shell。adopted/手工恢复的 pane 会携带完整
    // harness 调用（`codex … resume <old-token>`），这正是 2026-08-22 那批“fresh” successor 启动
    // 14 天旧上下文的原因。显式 shell 也会重置 pane 的 respawn 默认值，从而自修复 pane。
    const blankShell = (await this.tmuxAdapter.getDefaultShell()) ?? "/bin/sh";
    const respawned = await this.tmuxAdapter.respawnPane(pane.id, blankShell, { cwd, env });
    if (!respawned.ok) {
      return {
        ok: false,
        code: (respawned as { code?: string }).code ?? "respawn_failed",
        step: "create_successor",
        replacementStarted: true,
        message: `无法将 successor respawn 到 "${departingSession}" 的 pane "${pane.id}"：${(respawned as { message?: string }).message ?? "respawn-pane 失败"}`,
      };
    }

    // KI-14：任何启动前都要验证空白状态。fresh 契约要求经过验证的空白 shell，否则显著拒绝；绝不
    // 向 resumed harness 发起启动后再将其提交为 fresh successor。一次有界重试吸收 shell 启动延迟。
    // 失败时保留 seat（unwind 不变量：绝不 killSession），此时尚不存在 discovery candidate。
    const blank = await this.verifyPaneIsBlankShell(pane.id, blankShell);
    if (!blank.ok) {
      return {
        ok: false,
        code: "successor_pane_not_blank",
        step: "create_successor",
        replacementStarted: true,
        message: `"${departingSession}" 的 fresh successor pane "${pane.id}" 正在运行 "${blank.observed ?? "unknown"}"，而不是空白 shell——拒绝向非空 pane 启动。该 pane 的启动命令可能内嵌了 harness 调用；请重新创建 pane（或使用 --source discovered:<id> handover）后重试。`,
      };
    }

    // Ghost-stage (e) re-key：使 retiree occupant 的 seat-name-keyed store 失效，避免 successor 继承
    // ghost。按 ghost-stage 契约，该调用在 SeatHandoverService.commit() 中原子执行（位于 rebind
    // transaction 内，其中 retiree + successor 名称都在作用域中），而非在此 swap 时执行，使其与
    // rebind 一同提交。见 occupant-invalidator.ts。

    // 3. 让 successor 经真实 runtime startup（launchHarness send-keys + readiness）启动，在可 commit
    //    前先于复用 pane 中成为 live、ready agent。UNWIND 不变量：任何 launch/readiness 失败都不对
    //    已保留 seat 执行 killSession，否则会破坏 retiree 的可恢复状态。返回结构化失败，并将可再次
    //    wake 的 shell 留在 pane 中；commit 不执行，因此 binding 不会改指。
    const started = await this.startAgent(input.node, departingSession, pane.id, cwd, input.forkSource, input.occupantGeneration);
    if (!started.ok) {
      return { ok: false, code: started.code, step: "start_agent", message: started.message, replacementStarted: true };
    }

    const discovered = this.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: departingSession,
      tmuxPane: pane.id,
      // hint 等于 node 自身 runtime，因此 commit-path runtime 检查始终匹配；null runtime 记录为
      // "unknown"（检查会跳过）。
      runtimeHint: (input.node.runtime ?? "unknown") as RuntimeHint,
      confidence: "high",
      cwd: input.node.cwd ?? undefined,
    });

    return {
      ok: true,
      discoveredId: discovered.id,
      tmuxSession: departingSession,
      tmuxPane: pane.id,
      resumeToken: started.resumeToken,
      resumeType: started.resumeType,
      appliedLaunch: started.appliedLaunch,
    };
  }

  /**
   * B1——通过 runtime adapter 的 `launchHarness` + readiness probe（与 StartupOrchestrator 驱动
   * 的 primitive 相同）将 successor 启动为 live、ready agent，并捕获启动 resume token。不注册
   * session/binding，successor 在 commit 前保持未受管。绝不记录 token，也不将其放入返回消息。
   */
  private async startAgent(
    node: SuccessorNode,
    tmuxSession: string,
    tmuxPane: string,
    cwd: string | undefined,
    forkSource?: ForkSource,
    launchGeneration?: string | null,
  ): Promise<{ ok: true; resumeToken?: string; resumeType?: string; appliedLaunch?: AppliedLaunchObservation } | { ok: false; code: string; message: string }> {
    const adapter = node.runtime ? this.runtimeAdapters[node.runtime] : undefined;
    if (!adapter) {
      return {
        ok: false,
        code: "successor_runtime_unsupported",
        message: `没有适用于 "${node.runtime ?? "unknown"}" 的 runtime adapter；无法为此 seat 启动 live successor。`,
      };
    }

    // adapter launch/readiness probe 的临时 binding——successor 未受管，因此没有持久 binding 行
    //（id/updatedAt 对 adapter 无作用；它读取 tmuxSession/tmuxPane/cwd/model）。0.5.2-07
    //（model fidelity）：现在会携带 SPEC 锁定的 model——successor 是同一 seat 的 continuity edge，
    // 启动必须读取 seat spec，否则运行拓扑会在每次 handover 时静默偏离 founder 设计。
    //（config profile 仍是已跟踪的后续项。）
    const binding: NodeBinding = {
      id: "",
      nodeId: node.id,
      attachmentType: "tmux",
      tmuxSession,
      tmuxWindow: null,
      tmuxPane,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: cwd ?? "",
      launchGeneration: launchGeneration ?? undefined,
      // 接缝 B：continuity——successor 使用离任 seat 的 posture 启动。
      ...(node.launchPosture ? { launchPosture: node.launchPosture } : {}),
      ...(node.permissionMode ? { permissionMode: node.permissionMode } : {}),
      // 0.5.2-07：successor 读取 seat 在 SPEC 中锁定的 model（adapter 生成 -m/--model）。
      model: node.model ?? undefined,
      // 0.5.2-07 A4-profile：successor 读取 seat 在 SPEC 中锁定的 codex config profile
      //（adapter 生成 -p）。
      codexConfigProfile: node.codexConfigProfile ?? undefined,
    };

    let launch: Awaited<ReturnType<RuntimeAdapter["launchHarness"]>>;
    try {
      launch = await adapter.launchHarness(binding, { name: tmuxSession, ...(forkSource ? { forkSource } : {}) });
    } catch (err) {
      return { ok: false, code: "successor_launch_failed", message: `Successor harness 启动抛错：${err instanceof Error ? err.message : String(err)}` };
    }
    if (!launch.ok) {
      return { ok: false, code: "successor_launch_failed", message: `Successor harness 启动失败：${launch.error}` };
    }

    // 捕获启动时抓取的 resume token（绝不记录）。由 composer 在 commit 时以 provenance "scrape"
    // 持久化（B2，launched mode）。
    let resumeToken: string | undefined;
    let resumeType: string | undefined;
    const trimmed = launch.resumeToken?.trim();
    if (trimmed) {
      resumeToken = trimmed;
      resumeType = launch.resumeType;
    }

    // OPR.0.4.3.04 rev2 code-review 修复——createSession 已成功后，checkReady/waitForReady 仍可能
    // 抛错（adapter/socket/permission 错误会重新抛出）。异常不得在 kill/unwind 运行前拒绝
    // createSuccessor，否则会泄漏未受管 successor 并显示非结构化 500。此处捕获并返回结构化
    // ok:false，使调用方清理刚创建的 session（killBestEffort），并在 step=start_agent 显著失败，
    // 与返回的 readiness 失败完全一致。
    let readiness: ReadinessResult;
    try {
      readiness = await this.waitForReady(adapter, binding);
    } catch (err) {
      return {
        ok: false,
        code: "successor_readiness_failed",
        message: `Successor readiness probe 抛错：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!readiness.ready) {
      return {
        ok: false,
        code: isAttentionRequiredReadinessCode(readiness.code) ? "successor_attention_required" : "successor_not_ready",
        message: `Successor 未成为 ready agent：${readiness.reason ?? "readiness 超时"}`,
      };
    }

    return { ok: true, resumeToken, resumeType, appliedLaunch: launch.appliedLaunch };
  }

  /**
   * 使用指数退避等待 harness ready（1s→2s→…→16s 上限，默认超时 30s）——与
   * StartupOrchestrator.waitForReady 一致。
   */
  private async waitForReady(adapter: RuntimeAdapter, binding: NodeBinding): Promise<ReadinessResult> {
    const startTime = Date.now();
    let delay = 1000;
    const maxDelay = 16_000;

    while (true) {
      const result = await adapter.checkReady(binding);
      if (result.ready) return result;
      if (isAttentionRequiredReadinessCode(result.code)) return result;

      const elapsed = Date.now() - startTime;
      if (elapsed + delay > this.readinessTimeoutMs) {
        const finalResult = await adapter.checkReady(binding);
        if (finalResult.ready) return finalResult;
        return { ready: false, reason: result.reason ?? "readiness 超时" };
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  /**
   * Cutover：终止 pane 中的 retiree occupant，使 successor 可 respawn 进去，同时保留 scrollback。
   * 先执行 `setRemainOnExit(true)`（使 pane 在退出后保留而非销毁）；再优雅 SIGTERM（“原地退出”；
   * 干净退出也保护 successor resume 所依赖的 provider session 状态）；有界超时 SIGKILL 是锁定的
   * degraded fallback。返回终止 retiree 的路径；若其始终未死亡则返回失败（commit 不运行）。
   *（Graceful signal = SIGTERM，作为 build-ahead 下 desk-provisional 默认值；dev-planner 恢复时
   * 决定确切 graceful 机制——SIGTERM 或 runtime-specific quit。）
   */
  private async terminateRetiree(
    paneId: string,
  ): Promise<{ ok: true; path: "graceful" | "forced" } | { ok: false; message: string }> {
    const failures: string[] = [];
    const remain = await this.tmuxAdapter.setRemainOnExit(paneId, true);
    if (!remain.ok) failures.push(`remain-on-exit: ${remain.message}`);
    const term = await this.tmuxAdapter.signalPaneProcess(paneId, "TERM");
    if (!term.ok) failures.push(`TERM: ${term.message}`);
    if (await this.waitPaneDead(paneId)) return { ok: true, path: "graceful" };
    // Graceful 窗口耗尽——强制 kill（锁定的 degraded 路径）。
    const kill = await this.tmuxAdapter.signalPaneProcess(paneId, "KILL");
    if (!kill.ok) failures.push(`KILL: ${kill.message}`);
    if (await this.waitPaneDead(paneId)) return { ok: true, path: "forced" };
    const detail = failures.length > 0 ? ` Tmux 失败：${failures.join("; ")}。` : "";
    return { ok: false, message: `pane "${paneId}" 中的 retiree 在优雅 TERM + 强制 KILL 后仍未退出。${detail}` };
  }

  /** KI-14：respawn 后 pane 的 foreground 是否为裸 shell？非 shell 表示 pane 启动了内嵌命令
   *（恢复旧上下文缺陷），或 respawn 被忽略。分类使用共享 shell-classifier，再加本 launcher 自己选择
   * 的 shell basename（r2-B1：已配置 tcsh/csh 或任何已配置默认 shell 都是有效空白；此处硬编码集合
   * 会在破坏性 cutover 后误拒绝）。一次有界重试吸收 shell 启动延迟；null probe 视为未验证
   *（拒绝，绝不假定）。 */
  private async verifyPaneIsBlankShell(paneId: string, expectedShell: string): Promise<{ ok: true } | { ok: false; observed: string | null }> {
    let observed = await this.tmuxAdapter.getPaneCommand(paneId);
    if (observed && isShellForeground(observed, expectedShell)) return { ok: true };
    await this.sleep(this.exitPollMs);
    observed = await this.tmuxAdapter.getPaneCommand(paneId);
    if (observed && isShellForeground(observed, expectedShell)) return { ok: true };
    return { ok: false, observed };
  }

  /** 轮询 `isPaneDead` 直至有界退出超时（按次数限制，使注入的 no-op sleep 保持快速）。 */
  private async waitPaneDead(paneId: string): Promise<boolean> {
    const maxPolls = Math.max(1, Math.ceil(this.exitTimeoutMs / this.exitPollMs));
    for (let i = 0; i < maxPolls; i++) {
      if (await this.tmuxAdapter.isPaneDead(paneId)) return true;
      await this.sleep(this.exitPollMs);
    }
    return this.tmuxAdapter.isPaneDead(paneId);
  }

  /**
   * 已启动但下游失败（上下文投递或 continuity 校验）的 successor 所用 composer unwind。CUTOVER
   * 不变量：successor 占用 retiree 保留的 pane，因此 cleanup 绝不终止 session，否则会破坏 seat 的
   * 可恢复状态。这里只将 discovery candidate 标记为 vanished；可再次 wake 的 shell 留在 pane 中，
   * seat 可从 provider session 文件恢复。（保留 `tmuxSession` 以维持签名稳定及调用点日志。）
   */
  async cleanup(_tmuxSession: string, discoveredId: string | null): Promise<void> {
    if (discoveredId) this.discoveryRepo.markVanished([discoveredId]);
  }
}

function compactEnv(input: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}
