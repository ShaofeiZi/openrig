import type Database from "better-sqlite3";
import { NativePermissionStore } from "./native-permission-store.js";
import { permissionBindingOverride } from "./native-permission-selection.js";
import { ulid } from "ulid";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import { SeatStatusService, type SeatStatus, type SeatStatusResult } from "./seat-status-service.js";
import { SeatHandoverPlanner, parseHandoverSource, SEAT_HANDOVER_SOURCE_CAPABILITIES, type SeatHandoverPlan, type SeatHandoverSource } from "./seat-handover-planner.js";
import { discoverResumeToken } from "./agent-images/resume-token-discovery.js";
import { resolveRebuildArtifacts } from "./session-source-rebuild-resolver.js";
import { existsSync } from "node:fs";
import { SuccessorSessionLauncher } from "./successor-session-launcher.js";
import { deriveResumeToken, type ResumeTokenCaptureDeps } from "./resume-token-capture.js";
import { validateResumeToken } from "./resume-token-validation.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { OccupantInvalidator } from "./occupant-invalidator.js";
import type { JsonlExchange } from "./session-jsonl.js";
import type { PersistedEvent } from "./types.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";

/** 从前任的 provider 记录（claude transcript_path / codex rollout_path）解析出的有界回顾，
 *  包含带有“来自记录”标签的最后几轮交互及记录路径。它是 claude 运行时保留回滚内容的
 *  永久支路（备用屏幕中的 seat 不保留原生回滚）；也会在 codex seat 上渲染，后者的
 *  原生回滚是关键证明。 */
export interface PredecessorRecap {
  recap: JsonlExchange[];
  recordPath: string;
}
/** B16 — 每个无回顾结果都有明确名称：解析器返回回顾或其不可用原因，数据包会打印该原因
 *  （如实降级意味着带标签，而非静默处理）。 */
export type PredecessorRecapResolution = PredecessorRecap | { unavailableReason: string };

/** 为后继启动数据包解析前任的有界回顾，或返回具名的不可用结论
 *  （绝不静默返回 null——数据包会渲染原因）。 */
export type PredecessorRecapResolver = (args: {
  nodeId: string;
  runtime: string | null;
  sessionName: string;
}) => PredecessorRecapResolution;

export interface SeatHandoverMutationResult {
  ok: true;
  dryRun: false;
  mutated: true;
  continuityTransferred: false;
  seat: SeatHandoverPlan["seat"];
  // 向操作者报告的源是原始意图（fresh/rebuild/fork/discovered）。非 discovered 源
  // 在内部经由创建出的发现候选项路由，但来源信息始终如实保留。
  source: SeatHandoverSource;
  reason: string;
  operator: string | null;
  previousOccupant: string;
  currentOccupant: string;
  previousSessionIdsSuperseded: string[];
  newSessionId: string;
  discovery: {
    id: string;
    status: "claimed";
    tmuxSession: string;
    tmuxPane: string | null;
  };
  currentStatus: SeatHandoverPlan["currentStatus"];
  handoverAt: string;
  eventSeq: number;
  sideEffects: {
    departingSessionKilled: false;
    startupContextDelivered: boolean;
    provenanceRecordWritten: false;
  };
  /** OPR.0.5.5.5 — 逐源执行结果。fork：解析出的 fork 来源；rebuild：精确记录哪些
   *  持久工件初始化了后继、哪些声明地址存在缺口，以及（链为空时）具名原因——
   *  绝不静默丢弃。fresh/discovered 时不存在。 */
  sourceOutcome?:
    | { mode: "fork"; forkedFrom: string }
    | { mode: "rebuild"; primedArtifacts: Array<{ address: string; label: string }>; gaps: string[]; emptyChainReason?: string };
}

export type SeatHandoverResult =
  | { ok: true; plan: SeatHandoverPlan }
  | { ok: true; result: SeatHandoverMutationResult }
  | { ok: false; code: "missing_reason" | "invalid_source" | "successor_creation_not_implemented" | "source_not_supported" | "resume_token_unavailable" | "fork_source_not_found"; message: string; guidance: string }
  | { ok: false; code: "current_occupant_required" | "discovered_not_active" | "successor_tmux_absent" | "successor_already_managed" | "successor_is_current" | "runtime_mismatch"; message: string; guidance: string }
  | { ok: false; code: "discovered_not_found"; message: string; guidance: string }
  | { ok: false; code: "tmux_probe_failed" | "handover_commit_failed" | "successor_create_failed" | "context_delivery_failed"; message: string; guidance: string }
  | Extract<SeatStatusResult, { ok: false }>;

interface NodeRow {
  id: string;
  runtime: string | null;
  cwd: string | null;
  // 0.5.2-07：seat 在规范中固定的模型，会传递到后继绑定，避免 handover 将固定模型的
  // seat 静默恢复为运行时默认值（适配器会发出 -m/--model）。
  model: string | null;
  // 0.5.2-07 A4-profile：seat 在规范中固定的 codex 配置 profile
  //（nodes.codex_config_profile），出于与模型相同的原因传递到后继绑定——适配器发出 `-p <profile>`。
  codex_config_profile: string | null;
}

interface SessionRow {
  id: string;
  session_name: string;
  status: string;
}

interface BindingOwnerRow {
  node_id: string;
  logical_id: string;
  rig_name: string;
}

interface SeatHandoverServiceDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  discoveryRepo: DiscoveryRepository;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  now?: () => Date;
  /** 写入新建后继会话的 OpenRig 身份/活动环境变量，与启动身份环境一致。默认为 {}
   *  （三个核心身份变量始终在内部派生）。 */
  sessionEnv?: Record<string, string | undefined>;
  /** 后继会话名称的可注入 id 来源（用于测试）。 */
  newSuccessorId?: () => string;
  /** 以 runtime 为键的运行时适配器——提交前用于将全新后继启动为实时 agent（B1）。
   *  缺失 → 无法启动 fresh handover。 */
  runtimeAdapters?: Record<string, RuntimeAdapter>;
  /** 用于 discovered 模式恢复令牌捕获的 Claude sidecar 读取器（B2）。 */
  contextUsageStore?: ResumeTokenCaptureDeps["contextUsageStore"];
  /** 用于 discovered 模式恢复令牌捕获的 Codex 线程 id 捕获器（B2）。 */
  resumeTokenCapturer?: ResumeTokenCaptureDeps["resumeTokenCapturer"];
  /** OPR.0.4.6.PI1 FR-6 — 用于捕获 Pi 恢复令牌的 pi-runner sidecar 读取器。 */
  piRunnerStateStore?: ResumeTokenCaptureDeps["piRunnerStateStore"];
  /** 后继启动的就绪超时（测试中会缩短）。 */
  readinessTimeoutMs?: number;
  /** 后继就绪退避使用的可注入 sleep（用于测试）。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * OPR.0.4.6.02 S1 — 共享的 tmux 默认选项应用器，传入后继启动器，使 fresh handover
   * 后继获得与 NodeLauncher 所启动 seat 相同的鼠标、状态栏和剪贴板默认值。
   */
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
  /**
   * Ghost-stage (e) 接缝——逐 store 的退役 occupant 失效器，由 ghost-stage 切片实现，
   * 在 commit() 时调用一次，确保切换后的后继绝不继承前任以 seat 名称为键的状态。可选：
   * 在 ghost-stage 切片落地前若缺失，则跳过提交调用（绝不阻塞 handover）。参见 occupant-invalidator.ts。
   */
  occupantInvalidator?: OccupantInvalidator;
  /**
   * 为后继启动数据包解析前任有界的“来自记录”回顾（claude transcript_path / codex
   * rollout_path → parseJsonlExchanges）。可选：缺失时如实省略回顾章节。回顾是 claude
   * 运行时保留回滚内容的永久支路（备用屏幕中的 seat 不保留原生回滚）；在 codex seat 上，
   * 保留下来的原生回滚是关键证明。生产环境连接到 ContextUsageStore + parseJsonlExchanges。
   */
  predecessorRecapResolver?: PredecessorRecapResolver;
  /**
   * OPR.0.5.3.5 微需求 7——为后继数据包的指针支路解析人工编写的 seat 回顾（LEARNED
   * 旁的 RECAP.md，由离任 occupant 编写）。可选：缺失时省略人工编写支路（功能从未运行）；
   * 未找到内容的解析器返回带标签的缺失结果。生产环境连接到 seat-recap-store +
   * topology.root seat 布局。
   */
  authoredRecapResolver?: (seatRef: string) => { address: string; chainLength: number } | { absentReason: string };
  /**
   * S19（范围裁定 qitem-20260827001530，精确边界）：在完成/重新绑定的提交点仅调用一次
   * activity oracle，使以 seat 为键的活动状态把切换视为独立可见事件，并让后继的层级清单
   * 从未提升状态开始（绝不继承退役者的层级权限）。可选：缺失时跳过，绝不阻塞 handover。
   */
  activityOracle?: { declareOccupantSwap: (seatNodeId: string, generation: string) => void };
  /**
   * OPR.0.5.5.5 — 为 `--source rebuild` 按信任优先级解析 seat 的持久 rebuild 初始化链
   * （人工回顾链、LEARNED、恢复数据包记录）。可选：缺失时使用具名空链执行 rebuild。
   * 生产环境连接到 seat-recap-store（listRecapChain）+ topology.root seat 布局。
   */
  rebuildPrimingResolver?: (seatRef: string) => { artifacts: Array<{ address: string; label: string }> } | { emptyReason: string };
  /** OPR.0.5.5.5 — 检查声明的 rebuild 工件是否存在于文件系统
   *  （session-source-rebuild-resolver 接缝）。默认使用 node:fs existsSync；测试可注入。 */
  rebuildArtifactExists?: (path: string) => boolean;
}

export class SeatHandoverService {
  private db: Database.Database;
  private statusService: SeatStatusService;
  private planner: SeatHandoverPlanner;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private discoveryRepo: DiscoveryRepository;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private successorLauncher: SuccessorSessionLauncher;
  private captureDeps: ResumeTokenCaptureDeps;
  private occupantInvalidator: OccupantInvalidator | null;
  private predecessorRecapResolver: PredecessorRecapResolver | null;
  private authoredRecapResolver: SeatHandoverServiceDeps["authoredRecapResolver"] | null;
  private activityOracle: SeatHandoverServiceDeps["activityOracle"] | null;
  private rebuildPrimingResolver: SeatHandoverServiceDeps["rebuildPrimingResolver"] | null;
  private rebuildArtifactExists: (path: string) => boolean;
  /** 可注入的 sleep（用于测试）：也承载 deliverRestorePacket 中共享的粘贴后提交稳定等待。 */
  private sleep: (ms: number) => Promise<void>;
  private appliedLaunchObservations: AppliedLaunchObservationStore;
  private now: () => Date;

  constructor(deps: SeatHandoverServiceDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("SeatHandoverService：rigRepo 必须共享同一个数据库句柄");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("SeatHandoverService：sessionRegistry 必须共享同一个数据库句柄");
    if (deps.db !== deps.discoveryRepo.db) throw new Error("SeatHandoverService：discoveryRepo 必须共享同一个数据库句柄");
    if (deps.db !== deps.eventBus.db) throw new Error("SeatHandoverService：eventBus 必须共享同一个数据库句柄");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.discoveryRepo = deps.discoveryRepo;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.occupantInvalidator = deps.occupantInvalidator ?? null;
    this.activityOracle = deps.activityOracle ?? null;
    this.predecessorRecapResolver = deps.predecessorRecapResolver ?? null;
    this.authoredRecapResolver = deps.authoredRecapResolver ?? null;
    this.rebuildPrimingResolver = deps.rebuildPrimingResolver ?? null;
    this.rebuildArtifactExists = deps.rebuildArtifactExists ?? existsSync;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.appliedLaunchObservations = new AppliedLaunchObservationStore(deps.db);
    this.now = deps.now ?? (() => new Date());
    this.statusService = new SeatStatusService({ rigRepo: deps.rigRepo });
    this.planner = new SeatHandoverPlanner({ rigRepo: deps.rigRepo });
    this.successorLauncher = new SuccessorSessionLauncher(deps.tmuxAdapter, deps.discoveryRepo, {
      sessionEnv: deps.sessionEnv,
      newId: deps.newSuccessorId,
      runtimeAdapters: deps.runtimeAdapters,
      readinessTimeoutMs: deps.readinessTimeoutMs,
      sleep: deps.sleep,
      tmuxOptionDefaults: deps.tmuxOptionDefaults,
    });
    this.captureDeps = {
      contextUsageStore: deps.contextUsageStore ?? null,
      resumeTokenCapturer: deps.resumeTokenCapturer ?? null,
      piRunnerStateStore: deps.piRunnerStateStore ?? null,
    };
  }

  async handover(input: {
    seatRef: string;
    reason?: string | null;
    source?: string | null;
    operator?: string | null;
    dryRun?: boolean;
  }): Promise<SeatHandoverResult> {
    if (input.dryRun) {
      const planResult = this.planner.plan({ ...input, dryRun: true });
      if (planResult.ok) {
        return { ok: true, plan: planResult.plan };
      }
      switch (planResult.code) {
        case "mutation_disabled":
          return {
            ok: false,
            code: "successor_creation_not_implemented",
            message: "试运行计划不提供 seat handover 变更操作。",
            guidance: "请使用 --dry-run 重新运行，以便在不更改拓扑的情况下检查两阶段 handover 计划。",
          };
        case "missing_reason":
        case "invalid_source":
          return {
            ok: false,
            code: planResult.code,
            message: planResult.message,
            guidance: planResult.guidance,
          };
        case "seat_ref_required":
        case "seat_not_found":
        case "seat_ambiguous":
          return planResult;
      }
    }

    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      return {
        ok: false,
        code: "missing_reason",
        message: "缺少必填选项：--reason <reason>",
        guidance: "请提供明确的 handover 原因，例如：--reason context-wall",
      };
    }

    const parsed = parseHandoverSource(input.source);
    if (!parsed.ok) {
      return parsed;
    }
    // OPR.0.5.5.5 — 执行过程基于试运行计划所使用的同一能力表进行分派，因此计划绝不会
    // 承诺执行器拒绝的源。当前每种模式都可执行；未来不可执行的模式必须在表项中声明
    // `executes: false`，以便在此拒绝。
    if (!SEAT_HANDOVER_SOURCE_CAPABILITIES[parsed.source.mode].executes) {
      return {
        ok: false,
        code: "source_not_supported",
        message: `此 daemon 不执行 ${parsed.source.mode} handover。`,
        guidance: "请使用试运行计划标记为可执行的源。",
      };
    }

    const statusResult = this.statusService.getStatus(input.seatRef);
    if (!statusResult.ok) {
      return statusResult;
    }
    if (!statusResult.status.current_occupant) {
      return {
        ok: false,
        code: "current_occupant_required",
        message: `席位 "${input.seatRef}" 没有可供交接的当前占用者。`,
        guidance: "请先启动或认领当前 seat occupant，然后重试 handover。",
      };
    }

    const node = this.lookupNode(statusResult.status);
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) {
      return guard.lifecycle([node.id], () => this.handover(input));
    }
    const latestSession = this.lookupLatestSession(node.id);
    if (!latestSession) {
      return {
        ok: false,
        code: "current_occupant_required",
        message: `席位 "${input.seatRef}" 没有可替代的会话记录。`,
        guidance: "请使用以下命令检查 seat：zrig seat status <seat>",
      };
    }

    const operator = input.operator?.trim() || null;

    // OPR.0.5.5.5 fork：在任何变更（respawn）之前解析原生对话 id，使缺失或无法发现的
    // 令牌触发如实的变更前拒绝——绝不会把空白后继静默报告为 fork，也不会因预先可知的
    // 条件而在切换途中中止。
    let forkSource: { kind: "native_id"; value: string } | null = null;
    if (parsed.source.mode === "fork") {
      const forkRef = parsed.source.ref ?? latestSession.session_name;
      const discovery = discoverResumeToken(this.db, forkRef);
      if (!discovery.ok) {
        return {
          ok: false,
          code: discovery.failure.code === "session_not_found" ? "fork_source_not_found" : "resume_token_unavailable",
          message: discovery.failure.message,
          guidance: "Fork 需要可解析的原生对话 id。请使用以下命令检查源会话：zrig ps --nodes",
        };
      }
      if (!discovery.result.nativeId) {
        return {
          ok: false,
          code: "resume_token_unavailable",
          message: `无法发现 fork 源 "${forkRef}" 的原生恢复 id——该对话可能尚未产生输出。未创建后继，seat 保持不变。`,
          guidance: "请在源会话拥有原生对话 id 后重试，或使用 --source fresh。",
        };
      }
      if (node.runtime && discovery.result.runtime && node.runtime !== discovery.result.runtime) {
        return {
          ok: false,
          code: "runtime_mismatch",
          message: `Seat 要求运行时 "${node.runtime}"，但 fork 源 "${forkRef}" 使用 "${discovery.result.runtime}"。`,
          guidance: "请选择运行该 seat 所需运行时的源会话进行 fork。",
        };
      }
      forkSource = { kind: "native_id", value: discovery.result.nativeId };
    }

    // 已创建的后继：直接走 discovered->commit 路径，无需回滚任何内容
    //（与已发布行为逐字节一致）。
    if (parsed.source.mode === "discovered" && parsed.source.ref) {
      return this.finalizeWithDiscovered({
        seatRef: input.seatRef,
        status: statusResult.status,
        node,
        latestSession,
        discoveredRef: parsed.source.ref,
        reportedSource: parsed.source,
        reason,
        operator,
        contextDelivered: false,
        launchToken: null,
        occupantGeneration: null,
        appliedLaunch: null,
        cleanup: null,
      });
    }

    // fresh（切换）的完整周期编排：捕获 -> 在离任 pane 中原地 respawn 实时候继 -> 投递捕获的
    // 上下文 -> 验证连续性 -> 重新绑定。在 finalizeWithDiscovered 内提交（唯一且最后一次重新绑定）
    // 之前，注册表绑定不会改变；但退役进程会在原地 respawn 时被强制替换（它原地退出，其
    // provider 会话文件是持久唤醒目标）。（fork/rebuild 已在上方拒绝；discovered 已在上方完成。）

    // 1. 在 respawn 替换离任 seat 之前捕获其上下文。
    const capturedContext = await this.captureDepartingContext(latestSession.session_name);
    const predecessorGeneration = this.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid;

    // 1b. B16——在后继创建前立即解析前任的“来自记录”回顾：claude sidecar 以会话名称为键，
    // 而切换会复用规范名称，因此后继 harness 一旦启动，就会覆盖解析器要读取的 sidecar
    //（线上缺陷：解析器在启动后运行，读取到后继的新 sidecar，并且确实什么也没找到——但被
    // 静默处理）。解析是纯读取操作；其下游没有任何内容依赖启动。
    const rawRecapResolution = this.predecessorRecapResolver
      ? this.predecessorRecapResolver({ nodeId: node.id, runtime: node.runtime, sessionName: latestSession.session_name })
      : undefined;
    // 防御 B16 之前的解析器契约（null = 静默无回顾）：注入的旧解析器不得导致 handover
    // 崩溃——其 null 与其他情况一样转换为具名的不可用结果。
    const predecessorRecapResolution: PredecessorRecapResolution =
      rawRecapResolution ?? { unavailableReason: this.predecessorRecapResolver ? "回顾解析器未返回结果" : "此 daemon 未接入回顾解析器" };

    // 2. 在退役者 pane 中原地 respawn 后继，并将其启动为实时、就绪的 agent（§2.1b 接缝，B1）：
    //    解析离任 pane -> 原地 respawn-pane（保留名称）-> 真实运行时启动（launchHarness + 就绪）
    //    -> upsertDiscoveredSession。后继只有成为实时 agent，而非裸 shell 后，才能提交。
    // 接缝 B Guard-F1：自然形成的 seat 没有节点来源——继承的 rig 附着仍会传递给后继
    //（同一 seat 的连续性）。
    const successorPosture = this.rigRepo.getNodePolicyProvenance(node.id)?.launchPosture
      ?? this.rigRepo.getRigPolicyProvenance(statusResult.status.rig_id)?.launchPosture
      ?? "floor"; // R2 terminal：在连续性边上，缺失也等于锁定下限
    let permissionOverride: ReturnType<typeof permissionBindingOverride>;
    try {
      const selection = new NativePermissionStore(this.db).read(node.id);
      if (selection && selection.runtime !== node.runtime) throw new Error("自权限选择后 seat 运行时已变化；请重新显式选择或继承。");
      permissionOverride = permissionBindingOverride(selection);
    } catch (error) { return { ok: false, code: "successor_create_failed", message: `权限选择：${(error as Error).message}`,
      guidance: "未创建后继。请检查 seat 权限选择，再另行授权重试。" }; }
    // 后继必须从第一个字节起就携带自身 generation。该预留不会写入台账行；提交会消费它，
    // 而所有提交前失败分支都保持未注册。
    const occupantGeneration = this.sessionRegistry.reserveOccupantGeneration();
    const launch = await this.successorLauncher.createSuccessor({
      // 接缝 B：后继延续的是同一个 seat——持久化的策略姿态会继续传递。
      // 0.5.2-07 模型保真：携带 seat 在规范中固定的模型，使后继启动读取该规范
      //（否则运行中的拓扑会在每次 handover 时偏离创始人设计）。
      // A4-profile：同样携带 codex 配置 profile（适配器发出 -p）——恢复路径已传递该值；
      // handover 也必须如此，否则固定 profile 的 codex seat 会在 handover 时恢复默认值。
      node: { id: node.id, runtime: node.runtime, cwd: node.cwd, launchPosture: successorPosture, ...permissionOverride, model: node.model, codexConfigProfile: node.codex_config_profile ?? undefined },
      departingSessionName: latestSession.session_name,
      occupantGeneration,
      // OPR.0.5.5.5：fork 来源的后继会以已解析 id 的原生 fork 方式启动——
      // 从第一个字节起就携带现任上下文。
      ...(forkSource ? { forkSource } : {}),
      ...(predecessorGeneration
        ? { onReplacementStarted: () => { this.appliedLaunchObservations.invalidateGeneration(predecessorGeneration); } }
        : {}),
    });
    if (!launch.ok) {
      return {
        ok: false,
        code: "successor_create_failed",
        message: `Handover 在步骤 "${launch.step}" 失败：${launch.message}`,
        // 注册表绑定未改变（从未执行提交）。resolve_pane 失败会让实时退役者完全不受影响；
        // 原地 respawn 后失败时，seat 仍可从其 provider 会话文件重新唤醒（绝不会被销毁）。
        // 请检查 tmux/daemon 日志后重试。
        guidance: "Seat 的注册表绑定未改变。若故障发生在原地 respawn 之后，仍可从 provider 会话文件重新唤醒 seat。请检查 tmux/daemon 日志后重试。",
      };
    }

    // 3. fresh：在连续性验证之前，将捕获的恢复数据包投递给实时候继
    //    （空白 occupant 属于重新启动，而非 handover）。discovered 由操作者预先准备，无需投递。
    let contextDelivered = false;
    // OPR.0.5.3.5 微需求 7——通过注入的读取器解析人工回顾指针支路；每种结果都有标签
    //（存在时带链深度 / 具名缺失 / 解析器本身缺失时省略）。
    let authoredRecapInfo: { authoredRecap?: { address: string; chainLength: number }; authoredRecapAbsentReason?: string } | null = null;
    if (this.authoredRecapResolver) {
      const authored = this.authoredRecapResolver(input.seatRef);
      authoredRecapInfo = "address" in authored
        ? { authoredRecap: authored }
        : { authoredRecapAbsentReason: authored.absentReason };
    }
    if (parsed.source.mode === "fresh") {
      // B16——回顾已在步骤 1b（启动前）解析；不可用结论会作为具名行写入数据包，
      // 绝不静默省略。
      const resolved = "recap" in predecessorRecapResolution ? predecessorRecapResolution : null;
      const delivered = await this.deliverRestorePacket(launch.tmuxSession, {
        seatRef: input.seatRef,
        reason,
        departingSession: latestSession.session_name,
        capturedContext,
        recap: resolved?.recap,
        recordPath: resolved?.recordPath,
        recapUnavailableReason: resolved ? undefined : (predecessorRecapResolution as { unavailableReason: string }).unavailableReason,
        ...(authoredRecapInfo ?? {}),
      });
      if (!delivered.ok) {
        // 部分完成：后继已在保留的 pane 中运行，但上下文数据包未送达——回滚发现候选项
        //（cleanup 将其标记为 vanished；绝不会终止保留的 seat），并保持绑定不变
        //（不产生虚假成功）。seat 可从其会话文件重新唤醒。
        await this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId);
        return {
          ok: false,
          code: "context_delivery_failed",
          message: `Handover 在步骤 "deliver-restore-packet" 失败：${delivered.message}`,
          guidance: "已回滚后继候选项，seat 绑定保持不变；仍可从 provider 会话文件重新唤醒 seat。请在 tmux 投递恢复正常后重试。",
        };
      }
      contextDelivered = true;
    }

    // OPR.0.5.5.5 — 在结果中记录逐源执行结果，使操作者准确看到上下文由何者承载
    //（fork 来源 / 初始化集合）。
    let sourceOutcome: SeatHandoverMutationResult["sourceOutcome"];
    if (parsed.source.mode === "fork" && forkSource) {
      sourceOutcome = { mode: "fork", forkedFrom: parsed.source.ref ?? latestSession.session_name };
    }
    if (parsed.source.mode === "rebuild") {
      // rebuild：后继是从 seat 持久链初始化的全新对话——刻意不信任实时现任者的上下文。
      // 执行集合、其中的缺口和空链均会明确命名。
      const chain = this.rebuildPrimingResolver
        ? this.rebuildPrimingResolver(input.seatRef)
        : { emptyReason: "此 daemon 未接入 rebuild 初始化解析器" };
      let primedArtifacts: Array<{ address: string; label: string }> = [];
      let gaps: string[] = [];
      let emptyChainReason: string | undefined;
      if ("artifacts" in chain && chain.artifacts.length > 0) {
        const resolved = resolveRebuildArtifacts(
          { mode: "rebuild", ref: { kind: "artifact_set", value: chain.artifacts.map((artifact) => artifact.address) } },
          { exists: this.rebuildArtifactExists },
        );
        gaps = resolved.gaps;
        if (resolved.ok) {
          const present = new Set(resolved.files.map((file) => file.absolutePath));
          primedArtifacts = chain.artifacts.filter((artifact) => present.has(artifact.address));
        } else {
          emptyChainReason = resolved.error;
        }
      } else {
        emptyChainReason = "artifacts" in chain ? "持久链解析出的工件数量为零" : chain.emptyReason;
      }
      sourceOutcome = { mode: "rebuild", primedArtifacts, gaps, ...(emptyChainReason ? { emptyChainReason } : {}) };
      const delivered = await this.deliverRebuildPrimingPacket(launch.tmuxSession, {
        seatRef: input.seatRef,
        reason,
        departingSession: latestSession.session_name,
        primedArtifacts,
        gaps,
        emptyChainReason,
      });
      if (!delivered.ok) {
        // 与 fresh 数据包采用相同的部分状态契约：回滚候选项、保持绑定不变、seat 可重新唤醒——
        // 绝不产生虚假完成状态。
        await this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId);
        return {
          ok: false,
          code: "context_delivery_failed",
          message: `Handover 在步骤 "deliver-rebuild-priming" 失败：${delivered.message}`,
          guidance: "已回滚后继候选项，seat 绑定保持不变；仍可从 provider 会话文件重新唤醒 seat。请在 tmux 投递恢复正常后重试。",
        };
      }
      contextDelivered = true;
    }

    // 4. 通过现有的 discovered->commit 路径验证连续性并重新绑定。
    //    任何失败都会回滚已创建的后继（没有需要回滚的绑定）。
    return this.finalizeWithDiscovered({
      seatRef: input.seatRef,
      status: statusResult.status,
      node,
      latestSession,
      discoveredRef: launch.discoveredId,
      reportedSource: parsed.source,
      reason,
      operator,
      contextDelivered,
      // B2（launched/fresh）：由后继启动器在启动时抓取的恢复令牌会在提交时原子持久化
      //（来源为 scrape）。
      launchToken: launch.resumeToken ? { token: launch.resumeToken, resumeType: launch.resumeType } : null,
      occupantGeneration,
      appliedLaunch: launch.appliedLaunch ?? null,
      sourceOutcome,
      cleanup: () => this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId),
    });
  }

  /**
   * 共享的 discovered->commit 路径（校验 + 存在性验证 + 重新绑定）。返回任何失败前
   * 都会调用 `cleanup`，以回滚编排器创建的后继；discovered 源调用方传入 null
   * （无需回滚）。这里的 `hasSession` 探测是在提交释放原绑定之前执行的连续性/存在性验证。
   */
  private async finalizeWithDiscovered(input: {
    seatRef: string;
    status: SeatStatus;
    node: NodeRow;
    latestSession: SessionRow;
    discoveredRef: string;
    reportedSource: SeatHandoverSource;
    reason: string;
    operator: string | null;
    contextDelivered: boolean;
    /** 为 fresh 后继在启动时抓取的恢复令牌（提交时持久化）。 */
    launchToken: { token: string; resumeType?: string } | null;
    /** fresh 后继启动前预留的源绑定 generation；discovered seat 为 null。 */
    occupantGeneration: string | null;
    /** 启动适配器返回的精确执行值；adopted/discovered 后继不存在。 */
    appliedLaunch: AppliedLaunchObservation | null;
    /** OPR.0.5.5.5 — 传递到结果中的逐源执行结果。 */
    sourceOutcome?: SeatHandoverMutationResult["sourceOutcome"];
    cleanup: (() => Promise<void>) | null;
  }): Promise<SeatHandoverResult> {
    const fail = async (result: SeatHandoverResult): Promise<SeatHandoverResult> => {
      if (input.cleanup) await input.cleanup();
      return result;
    };

    const discovered = this.discoveryRepo.getDiscoveredSession(input.discoveredRef);
    if (!discovered) {
      return fail({
        ok: false,
        code: "discovered_not_found",
        message: `未找到发现记录 "${input.discoveredRef}"。`,
        guidance: "重试前请运行发现流程并列出活跃的已发现会话。",
      });
    }
    if (discovered.status !== "active") {
      return fail({
        ok: false,
        code: "discovered_not_active",
        message: `发现记录 "${discovered.id}" 的状态为 ${discovered.status}，并非 active。`,
        guidance: "请使用活跃且未被认领的已发现后继会话。",
      });
    }
    // 由编排器启动的后继（fresh/fork/rebuild——OPR.0.5.5.5 通过同一切换执行三者）
    // 会刻意复用离任会话的规范名称——它在退役者 pane 中原地 respawn，保留 seat 名称
    //（这正是目的所在）。只有 discovered 源后继必须使用不同会话；在那里把 seat 交给
    // 自己当前的会话属于空操作，因此该守卫只适用于 discovered。
    if (input.reportedSource.mode === "discovered" && discovered.tmuxSession === input.latestSession.session_name) {
      return fail({
        ok: false,
        code: "successor_is_current",
        message: "已发现的后继已经是此 seat 的当前 occupant。",
        guidance: "请使用不同的后继会话。",
      });
    }

    const runtimeMismatch = this.checkRuntimeMismatch(input.node.runtime, discovered.runtimeHint);
    if (runtimeMismatch) return fail(runtimeMismatch);

    const managedOwner = this.lookupManagedOwner(discovered.tmuxSession, input.node.id);
    if (managedOwner) {
      return fail({
        ok: false,
        code: "successor_already_managed",
        message: `后继 tmux 会话 "${discovered.tmuxSession}" 已由 ${managedOwner.logical_id}@${managedOwner.rig_name} 管理。`,
        guidance: "请使用未被认领的已发现后继会话。",
      });
    }

    let tmuxPresent: boolean;
    try {
      tmuxPresent = await this.tmuxAdapter.hasSession(discovered.tmuxSession);
    } catch (err) {
      return fail({
        ok: false,
        code: "tmux_probe_failed",
        message: `无法验证后继 tmux 会话 "${discovered.tmuxSession}"：${err instanceof Error ? err.message : String(err)}`,
        guidance: "请在确认 tmux 健康状态后重试；探测失败不会被视为会话不存在。",
      });
    }
    if (!tmuxPresent) {
      return fail({
        ok: false,
        code: "successor_tmux_absent",
        message: `后继 tmux 会话 "${discovered.tmuxSession}" 不存在。`,
        guidance: "请重新运行发现流程，或提供一个实时的已发现后继会话。",
      });
    }

    const committed = this.commit({
      seatRef: input.seatRef,
      status: input.status,
      node: input.node,
      latestSession: input.latestSession,
      reportedSource: input.reportedSource,
      reason: input.reason,
      operator: input.operator,
      discovered,
      contextDelivered: input.contextDelivered,
      launchToken: input.launchToken,
      occupantGeneration: input.occupantGeneration,
      appliedLaunch: input.appliedLaunch,
      sourceOutcome: input.sourceOutcome,
    });
    if (!committed.ok) return fail(committed);
    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(input.node.id);

    // B2（discovered）：后继是操作者预先准备、并非由我们启动的实时会话，因此未抓取启动令牌。
    // 在提交时尽力捕获其实时恢复令牌——复用 FR-3 纯派生辅助函数——使 handover 后立即崩溃
    // 仍可恢复（FR-3 在其他位置关闭该窗口）。提交后执行且不阻塞（与 FR-3 一致）：异步派生
    // 无法在 better-sqlite3 的同步事务内运行。绝不记录令牌。
    if (input.reportedSource.mode === "discovered" && "result" in committed) {
      await this.captureDiscoveredResumeToken({
        rigId: input.status.rig_id,
        nodeId: input.node.id,
        sessionId: committed.result.newSessionId,
        sessionName: discovered.tmuxSession,
        runtime: input.node.runtime,
      });
    }
    return committed;
  }

  /**
   * B2——提交时尽力捕获 discovered 模式恢复令牌。通过共享的 FR-3 派生辅助函数（纯读取）
   * 派生实时令牌，以来源 "adoption" 持久化（覆盖由等级守卫控制），并发出与 FR-3 相同的
   * captured/preserved/skipped 事件。如实失败 = 不持久化任何内容 + 一个已脱敏的跳过事件。
   * 绝不抛错，也绝不记录令牌。
   */
  private async captureDiscoveredResumeToken(input: {
    rigId: string; nodeId: string; sessionId: string; sessionName: string; runtime: string | null;
  }): Promise<void> {
    try {
      const derived = await deriveResumeToken(
        { runtime: input.runtime, sessionName: input.sessionName },
        this.captureDeps,
      );
      if (derived.outcome === "exempt" || derived.outcome === "noop") return;
      const runtime = input.runtime as string; // 经过 exempt 分支后必定非 null
      if (derived.outcome === "skipped") {
        this.emitCaptureSkip(input, runtime, derived.reason);
        return;
      }
      const wrote = this.sessionRegistry.updateResumeToken(input.sessionId, derived.resumeType, derived.token, "adoption");
      try {
        this.eventBus.emit(wrote
          ? {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "captured", resumeType: derived.resumeType, provenance: "adoption", redacted: true,
            }
          : {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "preserved", resumeType: derived.resumeType, reason: "higher_rank_present", redacted: true,
            });
      } catch { /* 尽力而为 */ }
    } catch {
      // 尽力而为——捕获绝不会导致 handover 失败或阻塞
    }
  }

  private emitCaptureSkip(
    input: { rigId: string; nodeId: string; sessionId: string; sessionName: string },
    runtime: string,
    reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "invalid_token",
  ): void {
    try {
      this.eventBus.emit({
        type: "session.resume_token_captured",
        rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
        runtime, outcome: "skipped", reason, redacted: true,
      });
    } catch { /* 尽力而为 */ }
  }

  /** 创建后继前尽力捕获离任 seat 的可见终端。绝不抛错；空捕获会在恢复数据包中
   *  如实记录为“没有可用的捕获内容”。 */
  private async captureDepartingContext(departingSession: string): Promise<string> {
    try {
      const screen = await this.tmuxAdapter.capturePaneScreen(departingSession);
      return screen ?? "";
    } catch {
      return "";
    }
  }

  /** OPR.0.5.5.5 — 通过与恢复数据包相同的已发布交互文本通道投递 rebuild 初始化数据包。
   *  数据包将后继指向持久工件（由后继自行读取），并明确列出每个缺口和空链——
   *  绝不静默地只完成部分初始化。 */
  private async deliverRebuildPrimingPacket(
    successorSession: string,
    info: {
      seatRef: string;
      reason: string;
      departingSession: string;
      primedArtifacts: Array<{ address: string; label: string }>;
      gaps: string[];
      emptyChainReason?: string;
    },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const lines = [
      `# Seat rebuild handover——${info.seatRef}`,
      `你是此 seat 的重建后继（原因：${info.reason}，时间：${this.now().toISOString()}）。你的前任会话是 ${info.departingSession}；它的实时上下文被刻意排除。请按最高信任优先的顺序，使用下列持久工件初始化自身。`,
    ];
    if (info.primedArtifacts.length > 0) {
      lines.push("", "初始化工件（请按顺序逐一读取）：");
      for (const artifact of info.primedArtifacts) lines.push(`- ${artifact.address} — ${artifact.label}`);
    }
    if (info.gaps.length > 0) {
      lines.push("", "已声明但磁盘上缺失的内容（已知缺口；明确列出以免静默丢弃）：");
      for (const gap of info.gaps) lines.push(`- ${gap}`);
    }
    if (info.emptyChainReason) {
      lines.push("", `持久链为空：${info.emptyChainReason}。你将仅从 seat 身份开始——请在第一份状态报告中明确说明。`);
    }
    const sent = await this.tmuxAdapter.sendText(successorSession, lines.join("\n"));
    if (!sent.ok) {
      return { ok: false, message: (sent as { message?: string }).message ?? "send_text 失败" };
    }
    // 与恢复数据包采用相同、经尖峰验证的 200ms 稳定等待（已暂存但未消费类别）。
    await this.sleep(200);
    const submit = await this.tmuxAdapter.sendKeys(successorSession, ["C-m"]);
    if (!submit.ok) {
      return { ok: false, message: (submit as { message?: string }).message ?? "提交失败" };
    }
    return { ok: true };
  }

  /** 通过已发布的交互文本通道（send_text + Enter）将捕获的恢复数据包投递给 fresh 后继，
   *  与启动编排器投递初始提示词的方式一致。 */
  private async deliverRestorePacket(
    successorSession: string,
    info: {
      seatRef: string;
      reason: string;
      departingSession: string;
      capturedContext: string;
      /** 前任有界的“来自记录”回顾 + 记录路径（无法解析时省略）。 */
      recap?: JsonlExchange[];
      recordPath?: string;
      /** B16 — 回顾无法解析时的具名原因（会渲染，绝不静默处理）。 */
      recapUnavailableReason?: string;
      authoredRecap?: { address: string; chainLength: number };
      authoredRecapAbsentReason?: string;
    },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const packet = buildRestorePacket({ ...info, handoverAt: this.now().toISOString() });
    const sent = await this.tmuxAdapter.sendText(successorSession, packet);
    if (!sent.ok) {
      return { ok: false, message: (sent as { message?: string }).message ?? "send_text 失败" };
    }
    // B16 重做（r2 线上入口发现）：共享的“粘贴后提交”顺序——在 send_text 与 C-m 之间采用
    // 经通道尖峰验证的 200ms 稳定等待（session-transport.ts，"Wait 200ms"）。若无此等待，
    // 数 KB 数据包会以折叠粘贴块形式停留在后继输入框中，处于已暂存但未发送状态
    //（r2 测得直到手动按 Enter 前持续 46 秒）——handover 已提交为完成，但数据包从未被消费：
    // 这是产品自身发布的“已暂存但未消费”类别。
    await this.sleep(200);
    const submit = await this.tmuxAdapter.sendKeys(successorSession, ["C-m"]);
    if (!submit.ok) {
      return { ok: false, message: (submit as { message?: string }).message ?? "提交失败" };
    }
    return { ok: true };
  }

  private checkRuntimeMismatch(nodeRuntime: string | null, discoveredRuntime: string): SeatHandoverResult | null {
    if (!nodeRuntime || discoveredRuntime === "unknown" || nodeRuntime === discoveredRuntime) {
      return null;
    }
    return {
      ok: false,
      code: "runtime_mismatch",
      message: `Seat 要求运行时 "${nodeRuntime}"，但已发现后继使用 "${discoveredRuntime}"。`,
      guidance: "请使用运行时提示匹配的已发现后继。",
    };
  }

  private lookupNode(status: SeatStatus): NodeRow {
    return this.db.prepare(
      "SELECT id, runtime, cwd, model, codex_config_profile FROM nodes WHERE rig_id = ? AND logical_id = ?"
    ).get(status.rig_id, status.logical_id) as NodeRow;
  }

  private lookupLatestSession(nodeId: string): SessionRow | null {
    return this.db.prepare(
      "SELECT id, session_name, status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1"
    ).get(nodeId) as SessionRow | undefined ?? null;
  }

  private lookupManagedOwner(tmuxSession: string, targetNodeId: string): BindingOwnerRow | null {
    const bindingOwner = this.db.prepare(`
      SELECT n.id AS node_id, n.logical_id, r.name AS rig_name
      FROM bindings b
      JOIN nodes n ON n.id = b.node_id
      JOIN rigs r ON r.id = n.rig_id
      WHERE b.tmux_session = ? AND n.id != ?
      LIMIT 1
    `).get(tmuxSession, targetNodeId) as BindingOwnerRow | undefined;
    if (bindingOwner) return bindingOwner;

    return this.db.prepare(`
      SELECT n.id AS node_id, n.logical_id, r.name AS rig_name
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      JOIN rigs r ON r.id = n.rig_id
      WHERE s.session_name = ? AND n.id != ? AND s.status NOT IN ('superseded', 'detached', 'exited')
      LIMIT 1
    `).get(tmuxSession, targetNodeId) as BindingOwnerRow | undefined ?? null;
  }

  private commit(input: {
    seatRef: string;
    status: SeatStatus;
    node: NodeRow;
    latestSession: SessionRow;
    reportedSource: SeatHandoverSource;
    reason: string;
    operator: string | null;
    discovered: ReturnType<DiscoveryRepository["getDiscoveredSession"]> & NonNullable<unknown>;
    contextDelivered: boolean;
    launchToken: { token: string; resumeType?: string } | null;
    occupantGeneration: string | null;
    appliedLaunch: AppliedLaunchObservation | null;
      sourceOutcome?: SeatHandoverMutationResult["sourceOutcome"];
  }): SeatHandoverResult {
    const handoverAt = this.now().toISOString();
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id FROM sessions WHERE node_id = ? AND status NOT IN ('superseded', 'detached', 'exited') ORDER BY id"
      ).all(input.node.id) as Array<{ id: string }>;
      const previousSessionIdsSuperseded = rows.map((row) => row.id);

      if (previousSessionIdsSuperseded.length > 0) {
        const placeholders = previousSessionIdsSuperseded.map(() => "?").join(",");
        this.db.prepare(
          `UPDATE sessions SET status = 'superseded', last_seen_at = datetime('now') WHERE id IN (${placeholders})`
        ).run(...previousSessionIdsSuperseded);
      }

      this.upsertBinding(input.node.id, {
        tmuxSession: input.discovered.tmuxSession,
        tmuxWindow: input.discovered.tmuxWindow,
        tmuxPane: input.discovered.tmuxPane,
      });
      // (e/Class-B)：在下方 registerClaimedSession 生成后继任期之前，捕获退役 occupant 的
      // generation——生成之后，节点的 "current" generation 就属于后继（名称会复用），
      // 因此这是唯一能解析退役者 generation 的时点。
      const retiringGeneration =
        this.sessionRegistry.currentOccupantGenerationForSession(input.latestSession.session_name) ?? undefined;
      // atom-B：seat handover 会生成 HANDOVER 类型的 occupant generation（而非默认的 'adopt'）。
      const newSession = this.sessionRegistry.registerClaimedSession(
        input.node.id,
        input.discovered.tmuxSession,
        "handover",
        input.occupantGeneration,
      );
      // W3：registerClaimedSession 生成后继 generation。只有此时，才能把适配器返回的
      // 精确启动效果附加到该任期。store 采用尽力而为策略，因此观察持久化绝不会让原本
      // 成功的 handover 失败。
      if (input.appliedLaunch) {
        const successorGeneration = this.sessionRegistry.currentOccupantTenure(input.node.id)?.generationUuid;
        if (successorGeneration) {
          this.appliedLaunchObservations.recordGeneration(successorGeneration, input.appliedLaunch);
        }
      }
      // B2（launched/fresh）：与认领操作原子地持久化启动时抓取的恢复令牌，来源为 "scrape"
      //（与 StartupOrchestrator 的启动令牌捕获一致）。受有效性守卫保护；格式错误的令牌会被
      // 丢弃，绝不会写入坏数据。令牌永远不会写入日志。
      if (input.launchToken) {
        const validated = validateResumeToken(input.node.runtime, input.launchToken.token);
        if (validated.ok) {
          this.sessionRegistry.updateResumeToken(newSession.id, validated.resumeType, validated.token, "scrape");
        }
      }
      this.discoveryRepo.markClaimed(input.discovered.id, input.node.id);
      // KI-14：连续性标签必须描述本次启动。这里若为 NULL，node-inventory 会从 restore_outcome
      // 派生 seat 连续性——那可能是数天前恢复留下的标记——因此 2026-08-22 批次的 seat 会报告
      // fresh/fresh-primed，而其 pane 实际运行恢复后的上下文。fresh 模式如今会在启动时验证为空
      //（由 successor_pane_not_blank 守卫），因此 'fresh' 名副其实；discovered 后继的连续性
      // 确实未知，保持 NULL。
      // OPR.0.5.5.5 — 已执行的源记录自己的连续性词汇（startup-orchestrator 集合）：
      // fresh->fresh、fork->forked、rebuild->rebuilt；discovered 保持 null（我们不知道连续性）。
      const continuityOutcome = input.reportedSource.mode === "fresh" ? "fresh"
        : input.reportedSource.mode === "fork" ? "forked"
        : input.reportedSource.mode === "rebuild" ? "rebuilt"
        : null;
      this.db.prepare(`
        UPDATE nodes SET
          occupant_lifecycle = 'active',
          continuity_outcome = ?,
          handover_result = 'complete',
          previous_occupant = ?,
          handover_at = ?
        WHERE id = ?
      `).run(continuityOutcome, input.latestSession.session_name, handoverAt, input.node.id);

      // Ghost-stage (e) 重键接缝——重新绑定已完成；此时让退役 occupant 以 seat 名称为键的 store
      // 失效，确保后继绝不继承幽灵状态（已排空的压缩阶段、冻结的遥测样本、发送给退役 generation
      // 的延迟生命周期消息）。ghost-stage 切片负责 OccupantInvalidator 背后的逐 store 实现；
      // 此 seat 只负责这一次调用。切换时后继复用 seat 名称，所以此处 retiring === successor——
      // Class-A 通过时序保证安全（在后继写入前运行），Class-B 则通过 retiringGeneration 限定
      // generation 范围（即上方生成前捕获的退役者 generation）。可选依赖：缺失时跳过，绝不阻塞。
      this.occupantInvalidator?.invalidateRetiringOccupant({
        retiringSessionName: input.latestSession.session_name,
        successorSessionName: input.discovered.tmuxSession,
        retiringGeneration,
      });

      const event = this.eventBus.persistWithinTransaction({
        type: "seat.handover_completed",
        rigId: input.status.rig_id,
        nodeId: input.node.id,
        logicalId: input.status.logical_id,
        previousOccupant: input.latestSession.session_name,
        currentOccupant: input.discovered.tmuxSession,
        source: input.reportedSource.raw,
        reason: input.reason,
        operator: input.operator,
        ...(input.sourceOutcome ? { sourceOutcome: input.sourceOutcome } : {}),
      });
      return { newSessionId: newSession.id, previousSessionIdsSuperseded, event };
    });

    let committed: { newSessionId: string; previousSessionIdsSuperseded: string[]; event: PersistedEvent };
    try {
      committed = tx();
      // S19 裁定 01530——唯一的窄调用：提交落地后，activity oracle 将切换视为独立事件，
      // 以持久节点 id 为键，并用后继任期标识（绝不使用退役者任期）。内存中、提交后、可选。
      this.activityOracle?.declareOccupantSwap(input.node.id, committed.newSessionId);
    } catch (err) {
      return {
        ok: false,
        code: "handover_commit_failed",
        message: `Seat handover 提交失败：${err instanceof Error ? err.message : String(err)}`,
        guidance: "请检查 daemon 日志，并在 seat 状态一致后重试。",
      };
    }

    this.eventBus.notifySubscribers(committed.event);
    const postStatus = this.statusService.getStatus(`${input.status.logical_id}@${input.status.rig_name}`);
    const currentStatus = postStatus.ok
      ? {
          sessionStatus: postStatus.status.session_status,
          startupStatus: postStatus.status.startup_status,
          occupantLifecycle: postStatus.status.occupant_lifecycle,
          continuityOutcome: postStatus.status.continuity_outcome,
          handoverResult: postStatus.status.handover_result,
          previousOccupant: postStatus.status.previous_occupant,
          handoverAt: postStatus.status.handover_at,
          restoreOutcome: postStatus.status.restore_outcome,
        }
      : {
          sessionStatus: "running",
          startupStatus: "ready" as const,
          occupantLifecycle: "active" as const,
          continuityOutcome: null,
          handoverResult: "complete" as const,
          previousOccupant: input.latestSession.session_name,
          handoverAt,
          restoreOutcome: input.status.restore_outcome,
        };

    return {
      ok: true,
      result: {
        ok: true,
        dryRun: false,
        mutated: true,
        continuityTransferred: false,
        seat: {
          ref: input.seatRef,
          rigId: input.status.rig_id,
          rigName: input.status.rig_name,
          logicalId: input.status.logical_id,
          podId: input.status.pod_id,
          podNamespace: input.status.pod_namespace,
          runtime: input.status.runtime,
        },
        source: input.reportedSource,
        reason: input.reason,
        operator: input.operator,
        previousOccupant: input.latestSession.session_name,
        currentOccupant: input.discovered.tmuxSession,
        previousSessionIdsSuperseded: committed.previousSessionIdsSuperseded,
        newSessionId: committed.newSessionId,
        discovery: {
          id: input.discovered.id,
          status: "claimed",
          tmuxSession: input.discovered.tmuxSession,
          tmuxPane: input.discovered.tmuxPane,
        },
        currentStatus,
        handoverAt,
        eventSeq: committed.event.seq,
        ...(input.sourceOutcome ? { sourceOutcome: input.sourceOutcome } : {}),
        sideEffects: {
          departingSessionKilled: false,
          startupContextDelivered: input.contextDelivered,
          provenanceRecordWritten: false,
        },
      },
    };
  }

  private upsertBinding(nodeId: string, fields: { tmuxSession: string; tmuxWindow: string | null; tmuxPane: string | null }): void {
    const existing = this.db.prepare("SELECT id FROM bindings WHERE node_id = ?").get(nodeId) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE bindings SET
          attachment_type = 'tmux',
          tmux_session = ?,
          tmux_window = ?,
          tmux_pane = ?,
          external_session_name = NULL,
          updated_at = datetime('now')
        WHERE node_id = ?
      `).run(fields.tmuxSession, fields.tmuxWindow, fields.tmuxPane, nodeId);
      return;
    }

    this.db.prepare(`
      INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_window, tmux_pane)
      VALUES (?, ?, 'tmux', ?, ?, ?)
    `).run(ulid(), nodeId, fields.tmuxSession, fields.tmuxWindow, fields.tmuxPane);
  }
}

/** 组装投递给 fresh 后继的恢复数据包：seat 身份 + handover 原因 + 前任会话 + 捕获的前任终端，
 *  再加上前任最后几轮交互的有界“来自记录”标签回顾，以及标明前任记录路径的回执行
 *  （如实降级）。回顾是 claude 运行时保留回滚内容的永久支路——claude-code seat 运行在
 *  tmux 备用屏幕中，该屏幕不保留回滚缓冲区，因此后继 pane 无法原生回滚到前任对话；
 *  而在 codex seat 上，切换使用的 respawn-pane 拥有原生回滚。绝不称其为 "scrollback"：
 *  标签必须清楚表明这是重放，因为把重放回顾冒充原生历史会彻底违背需求。导出供单元测试使用。 */
export function buildRestorePacket(info: {
  seatRef: string;
  reason: string;
  departingSession: string;
  handoverAt: string;
  capturedContext: string;
  /** 从 provider JSONL 读取的前任最后几轮交互，限制条数及单轮长度。 */
  recap?: Array<{ role: string; content: string }>;
  /** 前任 provider 记录路径（claude transcript_path / codex rollout_path）。 */
  recordPath?: string | null;
  /** B16 — 无法解析回顾时的具名原因；渲染为独立的带标签行，使缺失情况在 pane 中可见
   *  （如实降级意味着带标签，而非静默处理）。 */
  recapUnavailableReason?: string;
  /** OPR.0.5.3.5 微需求 7——人工编写的 seat 回顾（由离任 occupant 编写，记录决策及理由）：
   *  渲染为指向其地址的指针（无复制组合——数据包绝不内联字节；后继按地址拉取）。 */
  authoredRecap?: { address: string; chainLength: number };
  /** 人工编写支路的带标签缺失信息（B16 原则——绝不静默省略）。 */
  authoredRecapAbsentReason?: string;
}): string {
  const captured = info.capturedContext.trim();
  const lines = [
    "=== zrig seat handover——恢复上下文 ===",
    `Seat：${info.seatRef}`,
    `原因：${info.reason}`,
    `前任会话：${info.departingSession}`,
    `Handover 时间：${info.handoverAt}`,
    "",
    "--- 前任终端（已捕获）---",
    captured.length > 0 ? captured : "（没有可用的捕获内容）",
  ];
  // 仅在记录确实可用时添加“来自记录”回顾及回执（绝不伪造）。
  // B16——缺失回顾不再静默省略：数据包会说明原因，使后继（以及查看 pane 的操作者）
  // 能区分“因 X 未解析到任何内容”和“该功能从未运行”。
  if (info.recap && info.recap.length > 0 && info.recordPath) {
    lines.push(
      "",
      "--- 前任回顾（从记录重放，并非实时终端）---",
      ...info.recap.map((e) => `${e.role}: ${e.content}`),
      "",
      `前任记录：${info.recordPath}`,
      "  （如实降级：持久、真实且可用 grep 检索——但不便人工滚动查看；上方回顾由此记录重放）",
    );
  } else if (info.recapUnavailableReason) {
    lines.push(
      "",
      `--- 前任回顾不可用：${info.recapUnavailableReason} ---`,
    );
  }
  // 人工编写的回顾支路（微需求 7）：使用指针，绝不内联字节——后继按地址拉取，
  // 因而只有一份可信副本。
  if (info.authoredRecap) {
    const chainNote = info.authoredRecap.chainLength > 0
      ? `（seat 树上保留了 ${info.authoredRecap.chainLength} 个已被替代的前任）`
      : "";
    lines.push(
      "",
      `--- 人工编写的 seat 回顾：${info.authoredRecap.address}${chainNote} ---`,
      "它会自动组合到 handover/压缩后 profile 中（zrig context profile <pack> --situation handover --rig <rig> --seat <seat>）；也可直接从上方 seat 树地址读取。",
    );
  } else if (info.authoredRecapAbsentReason) {
    lines.push(
      "",
      `--- 人工编写的 seat 回顾：${info.authoredRecapAbsentReason} ---`,
    );
  }
  return lines.join("\n");
}
