import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { NativePermissionStore } from "./native-permission-store.js";
import { permissionBindingOverride } from "./native-permission-selection.js";
import type { RigRepository } from "./rig-repository.js";
import { resolvePermissionPolicyAttachment } from "./permission-policy/policy-ref.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../adapters/codex-resume.js";
import type { PiResumeAdapter } from "../adapters/pi-resume.js";
import type { TranscriptStore } from "./transcript-store.js";
import { assessNativeResumeProbe } from "./native-resume-probe.js";
import type {
  RestoreOutcome,
  RestoreRigResult,
  RestoreResult,
  RestoreValidationBlocker,
  RestoreNodeResult,
  SnapshotData,
  NodeWithBinding,
  Edge,
  Session,
  Checkpoint,
  RigServicesRecord,
  RestoreSnapshotSelection,
} from "./types.js";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";
import { rebindAndVerifyPaneIdentity } from "./seat-attention-reconciler.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { resolveSnapshotRestoreTopology } from "./restore-topology.js";

// L3：运行时事实协调结果结构。未满足全部四项证据前置条件的协调是带缺失原因的无操作，
// 而不是错误。决策 3：协调后的终态为 `operator_recovered`，禁止使用 `ready`。
export type ReconcileNodeResult =
  | {
      ok: true;
      attemptId: number;
      from: "failed" | "attention_required";
      to: "operator_recovered";
      evidence: { tmux: boolean; fgProcess: "claude" | "codex" | string; resumeTokenUsed: boolean; paneState: "usable" };
    }
  | {
      ok: false;
      code:
        | "node_not_found"
        | "no_attempt"
        | "outcome_not_upgradable"
        | "tmux_session_missing"
        | "binding_mismatch"
        | "process_lineage_mismatch"
        | "fg_process_not_runtime"
        | "resume_token_not_used"
        | "pane_not_usable";
      detail: string;
    };

// 只有这些边类型会约束启动顺序。
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

// OPR.0.5.7.1 消费者对齐：四分支活动使用者阶梯位于纯叶模块 active-occupant.ts，
// 由预览、快照可用性和生命周期投影共享。这里导入并重新导出，使现有导出界面和下方
// 执行调用点保持不变。
import { resolveActiveSnapshotSession, activeOccupantAmbiguityError } from "./active-occupant.js";
export { resolveActiveSnapshotSession } from "./active-occupant.js";
export type { ActiveSnapshotSessionResolution } from "./active-occupant.js";

export function rollupRestoreRigResult(nodes: RestoreNodeResult[]): RestoreRigResult {
  if (nodes.length === 0) return "failed";
  // L3：`attention_required` 是非终态失败，即会话存活但等待操作员处理；汇总为
  // `partially_restored`。`operator_recovered` 是协调后的正常结果，与 `resumed` 一样汇总。
  const allFailed = nodes.every((node) => node.status === "failed");
  if (allFailed) return "failed";
  if (nodes.some((node) => node.status === "fresh" || node.status === "fresh-primed" || node.status === "awaiting-decision" || node.status === "failed" || node.status === "attention_required")) {
    return "partially_restored";
  }
  return "fully_restored";
}

/** OPR.0.4.3.20 FR-7 —— 表示没有会话运行且操作员必须处理的恢复/启动状态。启动 API
 *  与 CLI 不得把它们报告为启动成功；子集或单节点启动落入 `awaiting-decision` 并不等于
 *  “已启动”。 */
export const NON_RUNNING_LAUNCH_STATUSES: ReadonlySet<string> = new Set([
  "awaiting-decision",
  "attention_required",
  "failed",
]);

/** 当恢复/启动状态表示会话确实在运行时返回 true，即真正启动成功：resumed / rebuilt /
 *  fresh / fresh-primed / operator_recovered。 */
export function launchStatusIsRunning(status: string): boolean {
  return !NON_RUNNING_LAUNCH_STATUSES.has(status);
}

export interface NarrowLaunchResult {
  ok: boolean;
  planOnly?: boolean;
  code?: string;
  message?: string;
  launched?: RestoreNodeResult[];
  held?: Array<{ nodeId: string; logicalId: string; reason: string }>;
  alreadyRunning?: Array<{ nodeId: string; logicalId: string }>;
  failedTargets?: Array<{ nodeId: string; logicalId: string; reason: string }>;
  targetNodes?: Array<{ nodeId: string; logicalId: string }>;
  unmatchedIds?: string[];
  warnings?: string[];
  snapshotSelection?: RestoreSnapshotSelection;
  nonTargetEffects?: {
    mode: "unchanged" | "detach_and_hold";
    reason: string | null;
    affected: Array<{ nodeId: string; logicalId: string; reason: string }>;
    condition?: string;
  };
}

interface RestoreOrchestratorDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  snapshotRepo: SnapshotRepository;
  snapshotCapture: SnapshotCapture;
  checkpointStore: CheckpointStore;
  nodeLauncher: NodeLauncher;
  tmuxAdapter: TmuxAdapter;
  claudeResume: ClaudeResumeAdapter;
  codexResume: CodexResumeAdapter;
  /** OPR.0.4.6.PI1 FR-6 —— 保持可选以兼容旧装配和测试；缺少适配器的 Pi 恢复会落入
   *  如实报告“无适配器”的错误。 */
  piResume?: PiResumeAdapter;
  transcriptStore?: TranscriptStore;
  serviceOrchestrator?: import("./service-orchestrator.js").ServiceOrchestrator;
  listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
}

export class RestoreOrchestrator {
  readonly db: Database.Database;
  private activeRestores = new Set<string>();
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private snapshotRepo: SnapshotRepository;
  private snapshotCapture: SnapshotCapture;
  private nodeLauncher: NodeLauncher;
  private tmuxAdapter: TmuxAdapter;
  private claudeResume: ClaudeResumeAdapter;
  private codexResume: CodexResumeAdapter;
  private piResume: PiResumeAdapter | null;
  private transcriptStore: TranscriptStore | null;
  private serviceOrchestrator: import("./service-orchestrator.js").ServiceOrchestrator | null;
  private listProcesses: (() => Promise<Array<{ pid: number; ppid: number; command: string }>>) | undefined;
  private appliedLaunchStore: AppliedLaunchObservationStore;

  constructor(deps: RestoreOrchestratorDeps) {
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("RestoreOrchestrator：rigRepo 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("RestoreOrchestrator：sessionRegistry 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("RestoreOrchestrator：eventBus 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.snapshotRepo.db) {
      throw new Error("RestoreOrchestrator：snapshotRepo 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.checkpointStore.db) {
      throw new Error("RestoreOrchestrator：checkpointStore 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.snapshotCapture.db) {
      throw new Error("RestoreOrchestrator：snapshotCapture 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.nodeLauncher.db) {
      throw new Error("RestoreOrchestrator：nodeLauncher 必须共享同一个数据库句柄");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.snapshotRepo = deps.snapshotRepo;
    this.snapshotCapture = deps.snapshotCapture;
    this.nodeLauncher = deps.nodeLauncher;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.claudeResume = deps.claudeResume;
    this.codexResume = deps.codexResume;
    this.piResume = deps.piResume ?? null;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.serviceOrchestrator = deps.serviceOrchestrator ?? null;
    this.listProcesses = deps.listProcesses;
    this.appliedLaunchStore = new AppliedLaunchObservationStore(deps.db);
  }

  async restore(snapshotId: string, opts?: {
    adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
    fsOps?: { exists(path: string): boolean };
    /**
     * OPR.0.3.4.2 —— 操作 B 的选择加入：操作员明确要求全新预热的逻辑 ID
     *（`zrig up --existing <rig> --fresh <seat...>`）。列出的席位跳过恢复尝试，主动启动
     * 空白会话并报告为 `fresh-primed`；未列出且无法恢复的恢复策略席位则停止为
     * `awaiting-decision`。
     */
    freshLogicalIds?: string[];
    /** 来自自动调用方的选择证据。直接恢复默认视为显式选择，因为公开入口指定了快照 ID。 */
    snapshotSelection?: RestoreSnapshotSelection;
    /**
     * L3：编排器一旦决定执行逐节点恢复，就以持久化 `restore.started` 事件序号触发。
     * 路由借此立即向客户端返回 `attemptId`，逐节点工作则在后台继续。
     */
    onAttemptStarted?: (attemptId: number) => void;
  }): Promise<RestoreOutcome> {
    // 1. 加载快照。
    const snapshot = this.snapshotRepo.getSnapshot(snapshotId);
    if (!snapshot) {
      return { ok: false, code: "snapshot_not_found", message: `未找到快照 ${snapshotId}` };
    }

    const rigId = snapshot.rigId;
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", message: `未找到工作组 ${rigId}` };
    }
    const guard = this.tmuxAdapter.deliveryGuard;
    const guardedIds = rig.nodes.map(node => node.id);
    if (guard && guardedIds.some(id => !guard.ownsLifecycle(id))) {
      return guard.lifecycle(guardedIds, () => this.restore(snapshotId, opts));
    }
    const selectionOutcome = opts?.snapshotSelection ? null : this.snapshotRepo.selectRestoreUsable(rigId, snapshotId);
    if (selectionOutcome && !selectionOutcome.ok) return selectionOutcome;
    const snapshotSelection = opts?.snapshotSelection ?? selectionOutcome?.selection;

    // 对照 tmux 事实分类数据库中标记为运行中的会话，且不修改数据库。这会在任何状态
    // 变化前判断工作组能否安全恢复，对 pre_restore 快照顺序至关重要：快照必须捕获原始
    // 数据库状态，而不是协调后的状态。
    const classification = await this.classifyRunningSessions(rigId);
    if (classification.live.length > 0 || classification.unknown.length > 0) {
      return { ok: false, code: "rig_not_stopped", message: `工作组 ${rigId} 仍有实时会话。恢复前请运行 'zrig down' 停止工作组，或使用最新的自动 pre-down 快照。` };
    }

    // 每个工作组独立的并发锁。
    if (this.activeRestores.has(rigId)) {
      return { ok: false, code: "restore_in_progress", message: `工作组 ${rigId} 的恢复已在进行中` };
    }
    this.activeRestores.add(rigId);

    try {
      const validation = this.validatePreRestore(snapshot.data, {
        fsOps: opts?.fsOps,
        servicesRecord: this.rigRepo.getServicesRecord(rigId),
        freshLogicalIds: opts?.freshLogicalIds,
      });
      const topology = resolveSnapshotRestoreTopology(snapshot.data);
      if (validation.blockers.length > 0) {
        const result: RestoreResult = {
          snapshotId,
          preRestoreSnapshotId: null,
          rigResult: "not_attempted",
          nodes: [],
          warnings: validation.warnings,
          blockers: validation.blockers,
          snapshotSelection,
          intendedRoster: topology.intendedRoster,
          excludedNodes: topology.excludedNodes,
        };
        return {
          ok: false,
          code: "pre_restore_validation_failed",
          message: "恢复预验证失败，未尝试任何恢复变更。",
          result,
        };
      }

      // 2. 在任何数据库变更前捕获恢复前快照；此时数据库仍反映原始会话状态，
      // 包括过期会话仍为 running。
      const preRestoreSnapshot = this.snapshotCapture.captureSnapshot(rigId, "pre_restore");

      // 2b. 现在把过期会话标记为 detached；恢复前快照已捕获，也已确认没有实时或
      // unknown 会话，因此操作安全。
      for (const sessionId of classification.stale) {
        this.sessionRegistry.markDetached(sessionId);
      }

      // 3. 发出 restore.started；持久化事件序号就是尝试 ID（决策 1：不设独立的
      // restore_attempts 表）。
      const restoreStartedEvent = this.eventBus.emit({
        type: "restore.started",
        rigId,
        snapshotId,
        snapshotSelection,
        intendedRoster: topology.intendedRoster,
        excludedNodes: topology.excludedNodes,
      });
      const attemptId = restoreStartedEvent.seq;
      try {
        opts?.onAttemptStarted?.(attemptId);
      } catch {
        // onAttemptStarted 是即发即弃回调；绝不能让路由响应逻辑导致恢复管线崩溃。
      }

      // 3b. 服务门禁：工作组包含服务时，先启动服务，再恢复智能体。
      if (this.serviceOrchestrator) {
        const svcRecord = this.rigRepo.getServicesRecord(rigId);
        if (svcRecord) {
          const bootResult = await this.serviceOrchestrator.boot(rigId);
          if (!bootResult.ok) {
            this.eventBus.emit({
              type: "restore.completed",
              rigId,
              snapshotId,
              result: {
                snapshotId,
                preRestoreSnapshotId: preRestoreSnapshot.id,
                rigResult: "failed",
                nodes: [],
                warnings: [`服务启动失败：${bootResult.error}`],
                snapshotSelection,
                intendedRoster: topology.intendedRoster,
                excludedNodes: topology.excludedNodes,
              },
            });
            return { ok: false, code: "service_boot_failed", message: `智能体恢复前服务启动失败：${bootResult.error}` };
          }
        }
      }

      // 4. 计算恢复计划。
      const plan = this.computeRestorePlan(snapshot.data);

      // 5. 按节点使用补偿模式执行恢复。
      const nodeResults: RestoreNodeResult[] = [];
      const restoreWarnings: string[] = [...validation.warnings];
      for (const entry of plan) {
        const result = await this.restoreNodeWithCompensation(entry, rigId, snapshotId, snapshot.data, opts, restoreWarnings);
        nodeResults.push(result);
      }

      const restoreResult: RestoreResult = {
        snapshotId,
        preRestoreSnapshotId: preRestoreSnapshot.id,
        rigResult: rollupRestoreRigResult(nodeResults),
        nodes: nodeResults,
        warnings: restoreWarnings,
        snapshotSelection,
        intendedRoster: topology.intendedRoster,
        excludedNodes: topology.excludedNodes,
      };

      // 7. 发出 restore.completed。
      this.eventBus.emit({ type: "restore.completed", rigId, snapshotId, result: restoreResult });

      return { ok: true, result: restoreResult };
    } catch (err) {
      return {
        ok: false,
        code: "restore_error",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.activeRestores.delete(rigId);
    }
  }

  async launchNodeSubset(rigId: string, logicalIds: string[], opts?: {
    adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
    fsOps?: { exists(path: string): boolean };
    holdReason?: string;
    snapshotId?: string;
  }): Promise<NarrowLaunchResult> {
    return this.launchNodeTargets(rigId, logicalIds, { ...opts, nonTargetMode: "detach_and_hold" });
  }

  planNodeSubset(rigId: string, logicalIds: string[], opts?: {
    holdReason?: string;
    snapshotId?: string;
  }): NarrowLaunchResult {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `未找到工作组 ${rigId}` };
    const selected = this.snapshotRepo.selectRestoreUsable(rigId, opts?.snapshotId);
    if (!selected.ok) return selected;
    const intendedNodes = resolveSnapshotRestoreTopology(selected.snapshot.data).intendedNodes;
    const targetIds = new Set(intendedNodes.filter((node) => logicalIds.includes(node.logicalId)).map((node) => node.logicalId));
    if (targetIds.size === 0) {
      return { ok: false, code: "no_matching_nodes", message: `没有节点匹配这些逻辑 ID：${logicalIds.join(", ")}` };
    }
    const reason = opts?.holdReason ?? "excluded_from_subset";
    return {
      ok: true,
      planOnly: true,
      snapshotSelection: selected.selection,
      targetNodes: intendedNodes
        .filter((node) => targetIds.has(node.logicalId))
        .map((node) => ({ nodeId: node.id, logicalId: node.logicalId })),
      unmatchedIds: logicalIds.filter((logicalId) => !targetIds.has(logicalId)),
      nonTargetEffects: {
        mode: "detach_and_hold",
        reason,
        affected: rig.nodes
          .filter((node) => !targetIds.has(node.logicalId))
          .map((node) => ({ nodeId: node.id, logicalId: node.logicalId, reason })),
        condition: "仅适用于执行时已证明不在线的非目标席位",
      },
    };
  }

  async launchSingleNode(rigId: string, logicalId: string, opts?: {
    adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
    fsOps?: { exists(path: string): boolean };
    snapshotId?: string;
  }): Promise<NarrowLaunchResult> {
    return this.launchNodeTargets(rigId, [logicalId], { ...opts, nonTargetMode: "unchanged" });
  }

  private async launchNodeTargets(rigId: string, logicalIds: string[], opts: {
    adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
    fsOps?: { exists(path: string): boolean };
    holdReason?: string;
    snapshotId?: string;
    nonTargetMode: "unchanged" | "detach_and_hold";
  }): Promise<NarrowLaunchResult> {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return { ok: false, code: "rig_not_found", message: `未找到工作组 ${rigId}` };

    const selected = this.snapshotRepo.selectRestoreUsable(rigId, opts.snapshotId);
    if (!selected.ok) return selected;
    const { snapshot, selection: snapshotSelection } = selected;

    const allNodes = rig.nodes;
    const targetNodes = resolveSnapshotRestoreTopology(snapshot.data).intendedNodes
      .filter((node) => logicalIds.includes(node.logicalId));
    const matchedIds = new Set(targetNodes.map((n) => n.logicalId));
    const unmatchedIds = logicalIds.filter((id) => !matchedIds.has(id));
    if (targetNodes.length === 0) return { ok: false, code: "no_matching_nodes", message: `没有节点匹配这些逻辑 ID：${logicalIds.join(", ")}` };

    const nonTargetNodes = opts.nonTargetMode === "detach_and_hold"
      ? allNodes.filter((node) => !targetNodes.some((target) => target.id === node.id))
      : [];

    const guard = this.tmuxAdapter.deliveryGuard;
    const guardedIds = [...targetNodes, ...nonTargetNodes].map(node => node.id);
    if (guard && guardedIds.some(id => !guard.ownsLifecycle(id))) {
      return guard.lifecycle(guardedIds, () => this.launchNodeTargets(rigId, logicalIds, opts));
    }

    // 逐目标进行 tmux 存活性分类（运行时事实，封闭失败）。
    const launched: RestoreNodeResult[] = [];
    const alreadyRunning: Array<{ nodeId: string; logicalId: string }> = [];
    const failedTargets: Array<{ nodeId: string; logicalId: string; reason: string }> = [];
    // 在子集层级汇总逐节点警告，包括 FR-5 派生名称回退的可观测性。此前它在循环内按节点
    // 创建后被丢弃，导致 restore.subset_completed 携带空 warnings。
    const subsetWarnings: string[] = [];

    for (const node of targetNodes) {
      const sessions = this.sessionRegistry.getSessionsForRig(rigId)
        .filter((s) => s.nodeId === node.id && s.status === "running");

      let isLive = false;
      let isUnknown = false;

      for (const session of sessions) {
        try {
          const alive = await this.tmuxAdapter.hasSession(session.sessionName);
          if (alive) { isLive = true; break; }
        } catch {
          isUnknown = true;
        }
      }

      if (isLive) {
        alreadyRunning.push({ nodeId: node.id, logicalId: node.logicalId });
        continue;
      }
      if (isUnknown) {
        // OPR.0.4.3.28 修正：翻转 unknown 时默认封闭失败的启动策略。tmux 存活探测失败
        // 并不能正向证明席位在线，只有上方 isLive 可以。此前默认拒绝会因短暂 tmux 抖动让
        // 所有恢复/启动直接返回 503。现在继续启动该节点，沿用下方过期/无会话路径，并将
        // 不确定性作为非阻塞警告展示，以便操作员或智能体确认没有占用实时席位。isLive
        // 继续充当防抢占保护。
        subsetWarnings.push(
          `liveness_probe_unknown：尽管 tmux 存活探测失败，仍启动了 '${node.logicalId}'；请确认没有占用实时席位`,
        );
      }

      // 过期、无会话或按上述翻转规则为 probe-unknown 时均可启动。把该节点的警告累积到
      // 子集层数组，使其能进入 restore.subset_completed 和 API 结果；这里不能丢失 FR-5
      // 回退可观测性。
      const planEntry = { node };
      const result = await this.restoreNodeWithCompensation(
        planEntry, rigId, snapshot.id, snapshot.data, { adapters: opts?.adapters, fsOps: opts?.fsOps }, subsetWarnings,
      );
      launched.push(result);
    }

    // 只为已启动目标发出 restore.subset_completed。
    if (launched.length > 0) {
      const subsetResult: RestoreResult = {
        snapshotId: snapshot.id,
        preRestoreSnapshotId: null as unknown as string,
        rigResult: rollupRestoreRigResult(launched),
        nodes: launched,
        warnings: subsetWarnings,
        snapshotSelection,
      };
      this.eventBus.emit({ type: "restore.subset_completed", rigId, snapshotId: snapshot.id, result: subsetResult });
    }

    // 为非运行且被保留的非目标节点发出 node.held（三态：running/unknown/held）。
    const held: Array<{ nodeId: string; logicalId: string; reason: string }> = [];
    const holdReasonText = opts?.holdReason ?? "excluded_from_subset";
    for (const node of nonTargetNodes) {
      const sessions = this.sessionRegistry.getSessionsForRig(rigId)
        .filter((s) => s.nodeId === node.id && s.status === "running");

      let running = false;
      let unknown = false;
      for (const session of sessions) {
        try {
          if (await this.tmuxAdapter.hasSession(session.sessionName)) { running = true; break; }
        } catch {
          unknown = true;
        }
      }

      if (running || unknown) continue;

      // 清理已证明 tmux 不存活的非目标节点中过期的数据库 running 行，使 inventory 能如实
      // 投影 heldReason，而不被过期 running 状态遮蔽。
      for (const session of sessions) {
        this.sessionRegistry.markDetached(session.id);
      }

      this.eventBus.emit({
        type: "node.held",
        rigId,
        nodeId: node.id,
        logicalId: node.logicalId,
        reason: holdReasonText,
      });
      held.push({ nodeId: node.id, logicalId: node.logicalId, reason: holdReasonText });
    }

    return {
      ok: true,
      launched,
      held,
      alreadyRunning,
      failedTargets,
      unmatchedIds: unmatchedIds.length > 0 ? unmatchedIds : undefined,
      warnings: subsetWarnings.length > 0 ? subsetWarnings : undefined,
      snapshotSelection,
      nonTargetEffects: {
        mode: opts.nonTargetMode,
        reason: opts.nonTargetMode === "detach_and_hold" ? holdReasonText : null,
        affected: held,
      },
    };
  }

  private validatePreRestore(
    data: SnapshotData,
    opts: {
      fsOps?: { exists(path: string): boolean };
      servicesRecord?: RigServicesRecord | null;
      freshLogicalIds?: string[];
    },
  ): { blockers: RestoreValidationBlocker[]; warnings: string[] } {
    const blockers: RestoreValidationBlocker[] = [];
    const warnings: string[] = [];
    const exists = opts.fsOps?.exists ?? (() => true);

    const add = (blocker: RestoreValidationBlocker) => blockers.push(blocker);
    const nodes = Array.isArray(data.nodes) ? data.nodes : null;
    const sessions = Array.isArray(data.sessions) ? data.sessions : null;
    const edges = Array.isArray(data.edges) ? data.edges : null;
    const checkpoints = data.checkpoints && typeof data.checkpoints === "object" ? data.checkpoints : null;

    if (!data.rig || typeof data.rig.id !== "string") {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.rig",
        message: "快照缺少恢复所需的工作组记录。",
        remediation: "请捕获新快照，或从结构有效的快照恢复。",
      });
    }
    if (!nodes) {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.nodes",
        message: "快照缺少恢复所需的节点列表。",
        remediation: "请捕获新快照，或从结构有效的快照恢复。",
      });
    }
    if (!sessions) {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.sessions",
        message: "快照缺少恢复所需的会话记录。",
        remediation: "请捕获新快照，或从结构有效的快照恢复。",
      });
    }
    if (!edges) {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.edges",
        message: "快照缺少恢复规划所需的拓扑边。",
        remediation: "请捕获新快照，或从结构有效的快照恢复。",
      });
    }
    if (!checkpoints) {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.checkpoints",
        message: "快照缺少恢复所需的检查点映射。",
        remediation: "请捕获新快照，或从结构有效的快照恢复。",
      });
    }

    if (!nodes || !checkpoints) {
      return { blockers, warnings };
    }

    const topology = resolveSnapshotRestoreTopology(data);
    for (const invalidNodeId of topology.invalidRosterIds) {
      add({
        code: "invalid_topology_roster",
        severity: "critical",
        nodeId: invalidNodeId,
        target: "snapshot.topologyRoster",
        message: `预期拓扑名单包含节点 ${invalidNodeId}，但 snapshot.nodes 中没有该节点。`,
        remediation: "请从权威的已物化拓扑捕获新快照。",
      });
    }

    for (const node of topology.intendedNodes) {
      const checkpoint = checkpoints[node.id] ?? null;
      if (checkpoint && !node.cwd) {
        add({
          code: "checkpoint_missing_node_cwd",
          severity: "critical",
          nodeId: node.id,
          logicalId: node.logicalId,
          target: "checkpoint",
          message: `${node.logicalId} 有检查点，但节点没有用于接收它的 cwd。`,
          remediation: "请更新工作组 spec，为该节点添加 cwd，然后捕获新快照或手动恢复。",
        });
      }

      const startupCtx = data.nodeStartupContext?.[node.id] ?? null;
      if (!startupCtx) continue;

      // OPR.0.5.7.1 D6a —— 仅当节点会消费重放内容时验证重放文件（desk 对 e42420990
      // 的静态裁定）：none → 全新路径，验证；歧义 → 节点醒目停止且不消费，跳过验证；
      // 显式 fresh 或非恢复策略 → 主动全新，验证；resume_if_possible 但无令牌 → 停止并询问，
      // 不消费，跳过验证；可用类型 + 令牌 → 精确恢复，跳过验证；有令牌但没有可用恢复类型
      // → 沿用当前全新路径，验证。
      const resolution = resolveActiveSnapshotSession(data, node.id);
      const freshListed = opts.freshLogicalIds?.includes(node.logicalId) ?? false;
      let consumesReplay: boolean;
      if (resolution.kind === "ambiguous") {
        consumesReplay = false;
      } else if (resolution.kind === "none") {
        consumesReplay = true;
      } else {
        const sess = resolution.session;
        const policy = sess.restorePolicy ?? "resume_if_possible";
        if (freshListed || policy !== "resume_if_possible") consumesReplay = true;
        else if (!sess.resumeToken) consumesReplay = false;
        else if (!!sess.resumeType && sess.resumeType !== "none") consumesReplay = false;
        else consumesReplay = true;
      }

      for (const file of consumesReplay ? startupCtx.resolvedStartupFiles ?? [] : []) {
        if (!file.required) {
          if (this.pathLike(file.absolutePath) && !exists(file.absolutePath)) {
            warnings.push(`恢复预验证：${node.logicalId} 缺少可选启动文件：${file.absolutePath}`);
          }
          continue;
        }
        if (this.pathLike(file.ownerRoot) && !exists(file.ownerRoot)) {
          add({
            code: "startup_owner_root_missing",
            severity: "critical",
            nodeId: node.id,
            logicalId: node.logicalId,
            target: file.path,
            path: file.ownerRoot,
            message: `${node.logicalId} 缺少必需启动文件的所有者根目录：${file.ownerRoot}`,
            remediation: "请恢复智能体/来源根目录，或使用可访问的启动上下文捕获新快照。",
          });
        }
        if (this.pathLike(file.absolutePath) && !exists(file.absolutePath)) {
          add({
            code: "required_startup_file_missing",
            severity: "critical",
            nodeId: node.id,
            logicalId: node.logicalId,
            target: file.path,
            path: file.absolutePath,
            message: `${node.logicalId} 缺少必需的启动文件：${file.absolutePath}`,
            remediation: "请恢复缺失的启动文件，或在重试恢复前捕获新快照。",
          });
        }
      }

      // OPR.0.3.4.5（行为 09）：投影有效性不等于会话连续性。投影的 Skill/制品过期或
      // 缺失时，不得中止具有有效原生恢复能力的恢复操作。它们从关键阻塞项降级为标记
      // projection_drift 的警告，沿用 compose slice-03 的漂移报告结构。现有启动后过滤器
      // 已会跳过缺失条目并产生“已跳过”警告；这里防止恢复前门禁完全阻塞尝试。缺少必需
      // 启动文件以及真正致命的阻塞项（快照格式错误、节点缺失）仍保持关键级别。
      for (const entry of startupCtx.projectionEntries ?? []) {
        if (this.pathLike(entry.sourcePath) && !exists(entry.sourcePath)) {
          warnings.push(`projection_drift：${node.logicalId} 缺少来源根目录：${entry.sourcePath}（启动时将跳过投影；会话连续性不受影响）`);
        }
        if (this.pathLike(entry.absolutePath) && !exists(entry.absolutePath)) {
          warnings.push(`projection_drift：${node.logicalId} 缺少条目：${entry.absolutePath}（启动时将跳过投影；会话连续性不受影响）`);
        }
      }
    }

    const servicesRecord = opts.servicesRecord ?? null;
    if (servicesRecord) {
      if (this.pathLike(servicesRecord.rigRoot) && !exists(servicesRecord.rigRoot)) {
        add({
          code: "service_rig_root_missing",
          severity: "critical",
          target: "services.rigRoot",
          path: servicesRecord.rigRoot,
          message: `缺少服务工作组根目录：${servicesRecord.rigRoot}`,
          remediation: "请恢复服务工作组根目录，或更新服务记录后再重试恢复。",
        });
      }
      if (this.pathLike(servicesRecord.composeFile) && !exists(servicesRecord.composeFile)) {
        add({
          code: "service_compose_file_missing",
          severity: "critical",
          target: "services.composeFile",
          path: servicesRecord.composeFile,
          message: `缺少服务 compose 文件：${servicesRecord.composeFile}`,
          remediation: "请恢复 compose 文件，或更新服务记录后再重试恢复。",
        });
      }
    }

    return { blockers, warnings };
  }

  private pathLike(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0 && (
      value.startsWith("/")
      || value.startsWith("./")
      || value.startsWith("../")
      || value.startsWith("~")
    );
  }

  private captureNodeState(nodeId: string, rigId: string): { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] } {
    const binding = this.sessionRegistry.getBindingForNode(nodeId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId)
      .filter((s) => s.nodeId === nodeId && s.status !== "superseded" && s.status !== "exited")
      .map((s) => ({ id: s.id, status: s.status }));
    return { binding, sessions };
  }

  /**
   * 对照 tmux 事实分类所有数据库中标记为 running 的会话，且不修改数据库。扫描每个会话
   * （而不只是每个节点的最新会话），以发现隐藏在较新 detached 行之后的旧实时会话。
   * 返回供调用方处理的结构化分类：实时会话阻塞恢复；过期会话在捕获 pre_restore 快照后
   * 标记为 detached；unknown 会话封闭失败。
   */
  private async classifyRunningSessions(rigId: string): Promise<{
    live: string[];
    stale: string[];
    unknown: string[];
  }> {
    const live: string[] = [];
    const stale: string[] = [];
    const unknown: string[] = [];

    for (const session of this.sessionRegistry.getSessionsForRig(rigId)) {
      if (session.status !== "running") continue;
      try {
        const alive = await this.tmuxAdapter.hasSession(session.sessionName);
        if (alive) {
          live.push(session.id);
        } else {
          stale.push(session.id);
        }
      } catch {
        // tmux 检查失败时封闭失败：分类为 unknown，使恢复受到阻塞。
        unknown.push(session.id);
      }
    }

    return { live, stale, unknown };
  }

  private clearStaleState(nodeId: string, rigId: string): void {
    this.sessionRegistry.clearBinding(nodeId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);
    for (const sess of sessions) {
      if (sess.nodeId === nodeId && sess.status !== "superseded" && sess.status !== "exited") {
        this.sessionRegistry.markSuperseded(sess.id);
      }
    }
  }

  private restoreNodeState(nodeId: string, priorState: { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] }): void {
    // 精确恢复原绑定，而不是进行部分合并。启动路径可能已由 NodeLauncher 为该节点创建绑定，
    // 而单独调用 updateBinding 会执行 upsert 合并：原绑定为 null 时会留下指向已终止会话的
    // 启动绑定，原字段为 null 时则会静默保留启动行的值。因此先清除，再根据原字段重建；
    // 原先没有绑定时则保持不存在。启动失败补偿与 rollbackToZeroSession 共享此逻辑，
    // 从而保持完全相同的语义。
    this.sessionRegistry.clearBinding(nodeId);
    if (priorState.binding) {
      this.sessionRegistry.updateBinding(nodeId, {
        attachmentType: priorState.binding.attachmentType ?? undefined,
        tmuxSession: priorState.binding.tmuxSession ?? undefined,
        tmuxWindow: priorState.binding.tmuxWindow ?? undefined,
        tmuxPane: priorState.binding.tmuxPane ?? undefined,
        externalSessionName: priorState.binding.externalSessionName ?? undefined,
        cmuxWorkspace: priorState.binding.cmuxWorkspace ?? undefined,
        cmuxSurface: priorState.binding.cmuxSurface ?? undefined,
      });
    }
    // 恢复之前的会话状态。
    for (const sess of priorState.sessions) {
      this.sessionRegistry.updateStatus(sess.id, sess.status);
    }
  }

  private computeRestorePlan(data: SnapshotData): PlanEntry[] {
    const nodes = resolveSnapshotRestoreTopology(data).intendedNodes;
    const edges = data.edges;

    // 只为启动依赖边构建邻接关系。
    // delegates_to：来源必须先于目标启动。
    // spawned_by：目标（父节点）必须先于来源（子节点）启动。
    const nodeIds = nodes.map((n) => n.id);
    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};

    for (const id of nodeIds) {
      inDegree[id] = 0;
      adjacency[id] = [];
    }

    for (const edge of edges) {
      if (!LAUNCH_DEPENDENCY_KINDS.has(edge.kind)) continue;

      let from: string;
      let to: string;

      if (edge.kind === "delegates_to") {
        from = edge.sourceId;
        to = edge.targetId;
      } else {
        // spawned_by：目标（父节点）必须先于来源（子节点）启动。
        from = edge.targetId;
        to = edge.sourceId;
      }

      if (adjacency[from] && inDegree[to] !== undefined) {
        adjacency[from]!.push(to);
        inDegree[to] = (inDegree[to] ?? 0) + 1;
      }
    }

    // 拓扑排序，并按 logical_id 字母顺序打破平局。
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const queue = nodeIds
      .filter((id) => (inDegree[id] ?? 0) === 0)
      .sort((a, b) => {
        const na = nodeById.get(a)!.logicalId;
        const nb = nodeById.get(b)!.logicalId;
        return na.localeCompare(nb);
      });

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      const neighbors = (adjacency[current] ?? []).slice().sort((a, b) => {
        const na = nodeById.get(a)!.logicalId;
        const nb = nodeById.get(b)!.logicalId;
        return na.localeCompare(nb);
      });

      for (const neighbor of neighbors) {
        inDegree[neighbor] = (inDegree[neighbor] ?? 1) - 1;
        if ((inDegree[neighbor] ?? 0) === 0) {
          // 插入到已排序位置。
          const logicalId = nodeById.get(neighbor)!.logicalId;
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (nodeById.get(queue[i]!)!.logicalId.localeCompare(logicalId) > 0) {
              queue.splice(i, 0, neighbor);
              inserted = true;
              break;
            }
          }
          if (!inserted) queue.push(neighbor);
        }
      }
    }

    return order.map((id) => ({
      node: nodeById.get(id)!,
    }));
  }

  private async restoreNodeWithCompensation(
    entry: PlanEntry,
    rigId: string,
    snapshotId: string,
    data: SnapshotData,
    opts?: { adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>; fsOps?: { exists(path: string): boolean }; freshLogicalIds?: string[] },
    warnings?: string[],
  ): Promise<RestoreNodeResult> {
    const node = entry.node;
    const nodeId = node.id;

    // OPR.0.5.7.1（已确认的排序阻塞项，baton 0efd154d）：必须在任何 continuity_state
    // 短路前检测 D1 present-map 歧义，否则处于 'restoring' 的 pod 节点会在使用者事实含糊时
    // 静默返回 "fresh"（下游分类为运行中），绕过 A1 的醒目失败语义。resolved/none/legacy
    // 状态继续落入原流程，保持 restoring/degraded 行为不变。
    const occupantResolution = resolveActiveSnapshotSession(data, nodeId);
    if (occupantResolution.kind === "ambiguous") {
      return {
        nodeId,
        logicalId: node.logicalId,
        status: "failed",
        error: activeOccupantAmbiguityError(occupantResolution.candidateIds, occupantResolution.detail),
      };
    }

    // 清理过期状态前查询实时连续性状态。
    if (node.podId) {
      const continuityRow = this.db.prepare(
        "SELECT status FROM continuity_state WHERE pod_id = ? AND node_id = ?"
      ).get(node.podId, nodeId) as { status: string } | undefined;
      if (continuityRow) {
        if (continuityRow.status === "restoring") {
          warnings?.push(`节点 ${node.logicalId}：连续性状态为 'restoring'，已跳过`);
          return { nodeId, logicalId: node.logicalId, status: "fresh" };
        }
        if (continuityRow.status === "degraded") {
          warnings?.push(`节点 ${node.logicalId}：连续性状态为 'degraded'，将谨慎继续`);
        }
      }
    }

    // OPR.0.3.4.2（A）+ OPR.0.4.3.20 FR-7 —— 在 clearStaleState / launchNode 前执行
    // 启动前停止并询问分类，使 `awaiting-decision` 确实表示启动了零个会话且原状态未变。
    //
    // FR-7（缺口 1）：采用 `resume_if_possible` 且曾有会话（快照中存在会话行）、但没有
    // 可用令牌的席位在此停止，无论是否记录过恢复来源。旧 scope 要求必须记录来源，导致崩溃
    // 席位即使有会话行却没有捕获令牌，也会静默 fresh-prime（身份被替换却看似健康）。完全
    // 没有会话行的节点从未运行、没有可恢复内容，因此可以合理 fresh-prime 并继续。现在默认
    // fresh-prime 的唯一情形是：没有旧会话、确实不恢复的策略（relaunch_fresh /
    // checkpoint_only），或显式 `--fresh`。
    {
      // OPR.0.5.7.1 D1 —— 活动使用者已在函数开头、连续性查询前解析一次；歧义已在那里
      // 返回，因此只有 resolved/none 能到达此处。
      const snapSession = occupantResolution.kind === "resolved" ? occupantResolution.session : null;
      const policy = snapSession?.restorePolicy ?? "resume_if_possible";
      const freshRequested = opts?.freshLogicalIds?.includes(node.logicalId) ?? false;
      const resumeSourceRecorded = !!snapSession?.resumeType && snapSession.resumeType !== "none";
      if (policy === "resume_if_possible" && snapSession && !snapSession.resumeToken && !freshRequested) {
        const sourceNote = resumeSourceRecorded
          ? `已记录恢复来源 '${snapSession?.resumeType}'，但没有可用令牌`
          : `没有为该席位捕获恢复令牌`;
        return {
          nodeId,
          logicalId: node.logicalId,
          status: "awaiting-decision",
          error: `原会话无法恢复：${sourceNote}。未启动任何会话。请使用 --fresh ${node.logicalId} 重新运行以主动启动 fresh-primed 席位，或手动恢复原会话。`,
        };
      }
    }

    // 捕获原状态，供补偿使用。
    const priorState = this.captureNodeState(nodeId, rigId);

    // 清理过期状态，避免 NodeLauncher 看到 already_bound。
    this.clearStaleState(nodeId, rigId);
    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(nodeId);

    // 为 pod 感知节点推导规范会话名称。
    const rig = this.rigRepo.getRig(rigId);
    let launchOpts: { sessionName?: string; cwd?: string } | undefined = node.cwd
      ? { cwd: node.cwd }
      : undefined;
    let expectedSessionName: string | undefined;

    // OPR.0.4.3.20 FR-5 —— 把恢复目标固定到持久绑定的会话。priorState.binding 在
    // clearStaleState 删除绑定行前已捕获，因此它是席位实际绑定名称唯一留存的副本。固定该值
    // 可防止绑定到崩溃之间发生重命名/重塑后，恢复被静默重定向到重新推导出的错误或不存在
    // 窗格，这正是 Class-1 脆弱点。必须设置 launchOpts.sessionName，而不只是
    // expectedSessionName；否则 launcher 会在 node-launcher.ts 中重新推导，并把派生名称写回
    // 绑定，令固定失效。此处只做选择，不重新分配身份，也不改 schema/derive helper。回退到
    // 下方现有推导时可观测，绝不静默偏离。
    const pinnedTarget = priorState.binding?.tmuxSession ?? null;
    let pinnedTargetUsed = false;
    if (pinnedTarget) {
      const { validateSessionName } = await import("./session-name.js");
      if (validateSessionName(pinnedTarget)) {
        expectedSessionName = pinnedTarget;
        launchOpts = { ...launchOpts, sessionName: expectedSessionName };
        pinnedTargetUsed = true;
      } else {
        // 绑定存在但绑定名称格式错误，执行可观测的回退。
        warnings?.push(`FR-5：${node.logicalId} 的持久绑定会话名称 "${pinnedTarget}" 无效；回退到派生名称。`);
      }
    } else {
      // 没有持久绑定的会话名称（旧数据、null 绑定或空 tmux_session），执行可观测的派生
      // 名称回退（PRD 向后兼容 AC）。
      warnings?.push(`FR-5：${node.logicalId} 没有持久绑定的会话名称；回退到派生会话名称。`);
    }

    // 派生名称回退仅在没有可用固定值时执行。保留现有推导方式不变，先 pod 感知、再旧式，
    // 从而兼容数据不完整的工作组。
    if (!pinnedTargetUsed) {
      if (node.podId && rig) {
        // pod 感知：从节点身份推导 {pod}-{member}@{rigName}。
        const parts = node.logicalId.split(".");
        if (parts.length >= 2) {
          const podPart = parts[0]!;
          const memberPart = parts.slice(1).join(".");
          const { deriveCanonicalSessionName, deriveSessionName } = await import("./session-name.js");
          expectedSessionName = deriveCanonicalSessionName(podPart, memberPart, rig.rig.name);
          launchOpts = { ...launchOpts, sessionName: expectedSessionName };
        }
      }
      if (!expectedSessionName && rig) {
        const { deriveSessionName } = await import("./session-name.js");
        expectedSessionName = deriveSessionName(rig.rig.name, node.logicalId);
      }
    }

    // 在启动前、pipe-pane 连接前写入转录边界标记，使其出现在所有恢复后终端输出之前。
    // 使用“恢复尝试”措辞，因此即使随后启动失败也仍然如实。
    if (this.transcriptStore?.enabled && rig && expectedSessionName) {
      const markerOk = this.transcriptStore.writeBoundaryMarker(
        rig.rig.name,
        expectedSessionName,
        `尝试从快照 ${snapshotId} 恢复`,
      );
      if (!markerOk) {
        warnings?.push(`无法为 ${expectedSessionName} 写入转录边界标记`);
      }
    }

    // 尝试启动；只有启动本身失败时才执行补偿。
    const launchResult = await this.nodeLauncher.launchNode(rigId, node.logicalId, launchOpts);
    if (!launchResult.ok) {
      // 启动失败，执行补偿操作恢复原状态。
      this.restoreNodeState(nodeId, priorState);
      return {
        nodeId,
        logicalId: node.logicalId,
        status: "failed",
        error: launchResult.message,
      };
    }

    // 启动成功后，不对启动后的失败执行补偿，因为新会话/绑定现已成为当前状态。

    // 传递启动警告，包括转录连接失败。
    if (launchResult.warnings?.length) {
      warnings?.push(...launchResult.warnings);
    }

    return this.postLaunchRestore(entry, rigId, data, launchResult.sessionName, launchResult, opts, warnings, priorState);
  }

  /** OPR.0.3.4.2（B）—— 对 awaiting-decision 结果，把刚启动的会话回退为零会话：
   *  终止实时空白会话，将其行标为 superseded，并恢复原绑定/会话状态，即复用现有启动失败
   *  补偿操作。调用方只在明确判定会话为 fresh/blank 时触发，绝不用于未知但可能有效的连续性。 */
  private async rollbackToZeroSession(
    nodeId: string,
    sessionName: string,
    launchedSessionId: string | undefined,
    priorState: { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] } | undefined,
  ): Promise<void> {
    try {
      await this.tmuxAdapter.killSession(sessionName);
    } catch { /* 尽力而为；下方行与投影回退才是事实源 */ }
    if (launchedSessionId) {
      try { this.sessionRegistry.updateStatus(launchedSessionId, "superseded"); } catch { /* 尽力而为 */ }
    }
    if (priorState) {
      this.restoreNodeState(nodeId, priorState);
    }
  }

  private async postLaunchRestore(
    entry: PlanEntry,
    rigId: string,
    data: SnapshotData,
    sessionName: string,
    launchResult?: { ok: true; sessionName: string; session: import("./types.js").Session; binding: import("./types.js").Binding },
    opts?: { adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>; fsOps?: { exists(path: string): boolean }; freshLogicalIds?: string[] },
    warnings?: string[],
    priorState?: { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] },
  ): Promise<RestoreNodeResult> {
    const node = entry.node;
    // OPR.0.5.7.1 D1 —— 活动使用者必须解析得出，绝不能根据行顺序推断（第 2 个引用点，
    // 共 2 个）；事故缺陷正是“latest = max id”，较新 ULID 的 superseded 行覆盖了真实使用者。
    const sessionResolution = resolveActiveSnapshotSession(data, node.id);
    if (sessionResolution.kind === "ambiguous") {
      return {
        nodeId: node.id,
        logicalId: node.logicalId,
        status: "failed",
        error: activeOccupantAmbiguityError(sessionResolution.candidateIds, sessionResolution.detail),
      };
    }
    const session = sessionResolution.kind === "resolved" ? sessionResolution.session : null;
    const checkpoint = data.checkpoints[node.id] ?? null;

    // 检查恢复策略。OPR.0.3.4.2：列入 --fresh 的席位（操作 B）会主动跳过恢复尝试，
    // 其启动结果报告为 `fresh-primed`。
    const restorePolicy = session?.restorePolicy ?? "resume_if_possible";
    const resumeType = session?.resumeType ?? null;
    const resumeToken = session?.resumeToken ?? null;
    const freshRequested = opts?.freshLogicalIds?.includes(node.logicalId) ?? false;
    const resumeRequested = restorePolicy === "resume_if_possible" && !!resumeType && resumeType !== "none" && !freshRequested;

    // OPR.0.3.4.2 —— 非恢复启动是由策略或 --fresh 驱动的主动空白启动，名称为
    // `fresh-primed`；旧有混淆的 `fresh` 不再从此管线产生。
    let baseStatus: RestoreNodeResult["status"] = "fresh-primed";

    // pod 感知节点通过 launchHarness 恢复，由启动编排器以 skipHarnessLaunch: false 处理。
    // 旧式节点通过原有 claude-resume/codex-resume 辅助逻辑恢复。
    const isPodAware = !!node.podId;

    if (resumeRequested && !isPodAware) {
      // 旧式恢复路径。
      if (!resumeToken) {
        // 纵深防御：启动前分类会在任何会话存在前捕获此情况。若它仍在启动后到达，刚创建的
        // 会话已确认是空白会话（无法恢复），因此回退为零会话并如实呈现决策。
        await this.rollbackToZeroSession(node.id, sessionName, launchResult?.session.id, priorState);
        return { nodeId: node.id, logicalId: node.logicalId, status: "awaiting-decision", error: `原会话无法恢复：已请求恢复，但没有可用令牌。当前没有会话运行。请使用 --fresh ${node.logicalId} 重新运行以主动启动 fresh-primed 席位，或手动恢复原会话。` };
      } else {
        const resumeOutcome = await this.attemptResume(node.id, sessionName, resumeType, resumeToken, node.cwd ?? "/", node.codexConfigProfile, node.model, this.resolveRestorePosture(node.id, rigId));
        if (resumeOutcome.kind === "resumed") {
          baseStatus = "resumed";
        } else if (resumeOutcome.kind === "attention_required") {
          // L3 决策 2：Claude 恢复选择提示 → attention_required。不要自动回答；待操作员
          // 让窗格进入可用状态后，再通过 reconcileNodeRuntimeTruth 协调。边界：实时但暂停的
          // 会话是 attention_required，绝不是 awaiting-decision。
          return {
            nodeId: node.id,
            logicalId: node.logicalId,
            status: "attention_required",
            error: resumeOutcome.message,
            attentionEvidence: resumeOutcome.evidence ?? null,
          };
        } else {
          // OPR.0.3.4.2（B）：恢复已明确失败，启动的会话是已确认空白的智能体（精确保护
          // 触发条件 i）。回退为零会话，并以 awaiting-decision 实现停止并询问。
          await this.rollbackToZeroSession(node.id, sessionName, launchResult?.session.id, priorState);
          return { nodeId: node.id, logicalId: node.logicalId, status: "awaiting-decision", error: `原会话无法恢复：已尝试恢复但失败。空白会话已回退，当前没有会话运行。请使用 --fresh ${node.logicalId} 重新运行以主动启动 fresh-primed 席位，或手动检查运行环境状态。` };
        }
      }
    } else if (resumeRequested && isPodAware) {
      // pod 感知恢复必须与旧式恢复遵守相同的如实契约：请求恢复但连续性状态不可用时，
      // 应醒目停止，而不是静默降级为丢失记忆的全新启动。
      if (!resumeToken) {
        // 纵深防御；启动前分类会先捕获此情况。
        await this.rollbackToZeroSession(node.id, sessionName, launchResult?.session.id, priorState);
        return {
          nodeId: node.id,
          logicalId: node.logicalId,
          status: "awaiting-decision",
          error: `原会话无法恢复：已请求恢复，但没有可用令牌。当前没有会话运行。请使用 --fresh ${node.logicalId} 重新运行以主动启动 fresh-primed 席位，或手动恢复原会话。`,
        };
      }
      // OPR.0.4.3.20 FR-7（缺口 2b）：pod 感知恢复需要运行时适配器验证连续性并重新启动
      // 运行环境，下方启动重放受 opts.adapters 门控。如果该席位的运行时适配器缺失，
      // 例如节点子集启动未传递 adapters，就无法恢复，也绝不能静默 fresh-prime；应封闭失败
      // 为 awaiting-decision。显式 --fresh 和非恢复策略仍是仅有的 fresh-prime 路径。
      const resumeAdapter = node.runtime ? opts?.adapters?.[node.runtime] : undefined;
      if (!resumeAdapter) {
        await this.rollbackToZeroSession(node.id, sessionName, launchResult?.session.id, priorState);
        return {
          nodeId: node.id,
          logicalId: node.logicalId,
          status: "awaiting-decision",
          error: `原会话无法恢复：已请求恢复，但无法验证运行时连续性（没有可用的 ${node.runtime ?? "runtime"} 适配器）。当前没有会话运行。请使用 --fresh ${node.logicalId} 重新运行以主动启动 fresh-primed 席位，或在提供运行时适配器后重试恢复。`,
        };
      }
    }

    // 尚未恢复时交付检查点。
    if (baseStatus !== "resumed" && checkpoint) {
      if (!node.cwd) {
        return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: "有可用检查点，但节点没有 cwd" };
      }
      const written = this.writeCheckpointFile(node.cwd, checkpoint);
      if (written) {
        baseStatus = "rebuilt";
      } else {
        return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: "检查点文件写入失败" };
      }
    }

    // OPR.0.5.7.1 D6a —— 无条件限制重放。精确恢复会返回已有历史；向其中重放启动/
    // 引导内容正是幽灵提示的来源，事故中的线上样本是恢复过程中重写受管 CLAUDE.md 区块。
    // 已恢复历史不重放任何内容，启动环节保持不变；D2 判别条件已证明，运行时正确且为空的
    // 计划可以正常恢复。这里有意不提供重放选择加入界面：D6b 会在拥有持久性原语的 D4
    // operation-id 阶段恢复显式、版本化、持久且幂等的契约。主动 fresh-primed 启动属于
    // 新历史，继续保留重放。
    const replayContained = resumeRequested && !!resumeToken;

    // 上下文可用时，尝试恢复安全的启动重放。
    if (data.nodeStartupContext && opts?.adapters && launchResult) {
      const startupCtx = data.nodeStartupContext[node.id];
      if (startupCtx) {
        const adapter = opts.adapters[startupCtx.runtime];
        if (adapter) {
          // 预过滤：检查仍然存在的文件和条目。
          const existsFn = opts.fsOps?.exists ?? (() => true);
          const sourceEntries = replayContained ? [] : startupCtx.projectionEntries;
          const sourceFiles = replayContained ? [] : startupCtx.resolvedStartupFiles;
          const sourceActions = replayContained ? [] : startupCtx.startupActions;
          const filteredEntries = sourceEntries.filter((e) => {
            if (!existsFn(e.absolutePath)) {
              warnings?.push(`恢复：缺少投影条目 ${e.absolutePath}（已跳过）`);
              return false;
            }
            return true;
          });
          const filteredFiles = sourceFiles.filter((f) => {
            if (!existsFn(f.absolutePath)) {
              if (f.required) {
                warnings?.push(`恢复：缺少必需启动文件 ${f.absolutePath}`);
                return false; // 会在下方导致失败
              }
              warnings?.push(`恢复：缺少可选启动文件 ${f.absolutePath}（已跳过）`);
              return false;
            }
            return true;
          });

          // 检查是否有必需文件被过滤掉。
          const missingRequired = sourceFiles.filter((f) => f.required && !existsFn(f.absolutePath));
          if (missingRequired.length > 0) {
            return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: `缺少必需启动文件：${missingRequired.map((f) => f.path).join(", ")}` };
          }

          // 构建全新投影计划，所有条目均为 safe_projection。
          const plan: import("./projection-planner.js").ProjectionPlan = {
            runtime: startupCtx.runtime,
            cwd: node.cwd ?? ".",
            entries: filteredEntries.map((e) => ({
              ...e,
              classification: "safe_projection" as const,
              category: e.category as import("./projection-planner.js").ProjectionEntry["category"],
              mergeStrategy: e.mergeStrategy as import("./projection-planner.js").ProjectionEntry["mergeStrategy"],
            })),
            startup: { files: filteredFiles as import("./types.js").StartupFile[], actions: sourceActions },
            conflicts: [],
            noOps: [],
            diagnostics: [],
          };

          const binding = {
            ...launchResult.binding,
            cwd: node.cwd ?? ".",
            codexConfigProfile: node.codexConfigProfile ?? undefined,
            // OPR.0.4.8.3 接缝 B：pod 感知恢复路径也绑定恢复后的姿态；两条恢复路径都
            // 消费持久化溯源，即预检界面 3。
            launchPosture: this.resolveRestorePosture(node.id, rigId),
            // OPR.0.4.6.PI1 VM 环节发现：恢复绑定曾丢弃节点的模型声明，导致恢复后的 Pi
            // 席位在没有 --model 的情况下重新启动；runner 按声明的 provider 索引密钥
            // allowlist，因而不传递任何密钥，每个恢复的 Pi 席位都报 "No API key found"。
            // Claude/Codex 在恢复时也会以同样方式静默丢失 -m/--model。
            model: node.model ?? undefined,
          };

          try {
            const { StartupOrchestrator } = await import("./startup-orchestrator.js");
            const startupOrch = new StartupOrchestrator({ db: this.db, sessionRegistry: this.sessionRegistry, eventBus: this.eventBus, tmuxAdapter: this.tmuxAdapter });
            const replayAsRestore = baseStatus !== "fresh-primed";
            const shouldLaunchHarness = isPodAware;
            const startupResult = await startupOrch.startNode({
              rigId,
              nodeId: node.id,
              sessionId: launchResult.session.id,
              binding: binding as import("./runtime-adapter.js").NodeBinding,
              adapter,
              plan,
              resolvedStartupFiles: filteredFiles,
              startupActions: sourceActions,
              isRestore: replayAsRestore,
              preserveStartupContext: replayContained,
              skipHarnessLaunch: !shouldLaunchHarness,
              resumeToken: (isPodAware && resumeRequested) ? resumeToken ?? undefined : undefined,
              resumeType: (isPodAware && resumeRequested) ? resumeType ?? undefined : undefined,
              sessionName: sessionName,
              allowFreshFallback: !(isPodAware && resumeRequested),
            });
            if (startupResult.ok) {
              const nativeContinuityProved = isPodAware
                && resumeRequested
                && this.launchedSessionMatchesSnapshotResume(launchResult.session.id, resumeType, resumeToken);
              if (isPodAware && resumeRequested && startupResult.continuityOutcome === "fresh" && !nativeContinuityProved) {
                // OPR.0.3.4.2（B）：运行时明确报告 fresh 连续性，而原生连续性未经证实；
                // 这是已确认的空白智能体（精确保护触发条件 ii）。回退为零会话并呈现决策。
                // 注意：仅在明确判定为 fresh 时触发；真正未知但可能有效的连续性不会到达这里，
                // 因为 continuityOutcome 不会是 "fresh"。
                await this.rollbackToZeroSession(node.id, sessionName, launchResult.session.id, priorState);
                return {
                  nodeId: node.id,
                  logicalId: node.logicalId,
                  status: "awaiting-decision",
                  error: `原会话无法恢复：已尝试恢复，但运行时报告了 fresh 连续性。空白会话已回退，当前没有会话运行。如果可以接受这种降级，请使用 --fresh ${node.logicalId} 重新运行。`,
                };
              }
              const finalStatus = (isPodAware && resumeRequested)
                ? ((startupResult.continuityOutcome === "resumed" || nativeContinuityProved) ? "resumed" : baseStatus)
                : baseStatus;
              if (finalStatus === "resumed") {
                return this.finishJoinedResume(node, sessionName, resumeToken, launchResult?.session.id);
              }
              return { nodeId: node.id, logicalId: node.logicalId, status: finalStatus };
            }
            // 将 pod 感知的 attention_required 提升到请求恢复和未请求恢复的失败分支之前，
            // 使 pod 感知 Codex 认证拒绝（verifyResumeLaunch → recovery:
            // "attention_required"）无论是否请求恢复都能如实显示。这与运行时无关的旧式映射
            // 一致。此分支必须位于后续 failed 分支之前，否则最常用的生产 pod-aware-resume
            // 路径会返回 `status: "failed"`，破坏切片的“attention_required 端到端”声明。
            if (isPodAware && startupResult.startupStatus === "attention_required") {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "attention_required",
                error: `恢复启动需要处理：${startupResult.errors.join("; ")}`,
                attentionEvidence: startupResult.evidence ?? null,
              };
            }
            if (isPodAware && resumeRequested) {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: startupResult.errors.join("; "),
              };
            }
            if (isPodAware) {
              const prefix = startupResult.startupStatus === "attention_required"
                ? "恢复启动需要处理"
                : "恢复启动失败";
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: `${prefix}: ${startupResult.errors.join("; ")}`,
              };
            }
            warnings?.push(`${node.logicalId} 的恢复启动失败：${startupResult.errors.join("; ")}`);
          } catch (err) {
            if (isPodAware && resumeRequested) {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: `恢复启动错误：${(err as Error).message}`,
              };
            }
            if (isPodAware) {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: `恢复启动错误：${(err as Error).message}`,
              };
            }
            warnings?.push(`${node.logicalId} 的恢复启动出错：${(err as Error).message}`);
          }
        }
      }
    }

    if (baseStatus === "resumed") {
      return this.finishJoinedResume(node, sessionName, resumeToken, launchResult?.session.id);
    }
    return { nodeId: node.id, logicalId: node.logicalId, status: baseStatus };
  }

  /** 只有恢复后的终端已重新绑定，且其进程身份与声明的席位运行时一致，原生恢复才算
   *  完全成功。 */
  private async finishJoinedResume(
    node: SnapshotData["nodes"][number],
    sessionName: string,
    resumeToken: string | null,
    sessionId?: string,
  ): Promise<RestoreNodeResult> {
    const identity = await rebindAndVerifyPaneIdentity({
      db: this.db,
      sessionRegistry: this.sessionRegistry,
      tmux: this.tmuxAdapter,
      nodeId: node.id,
      sessionName,
      runtime: node.runtime ?? null,
      expectedResumeToken: resumeToken,
      requireExactResumeLineage: true,
      ...(this.listProcesses ? { listProcesses: this.listProcesses } : {}),
    });
    if (!identity.ok) {
      return {
        nodeId: node.id,
        logicalId: node.logicalId,
        status: "attention_required",
        error: `原生会话已精确恢复，但联合恢复证明不完整：${identity.detail}。已保留恢复的会话，未启动替代会话。`,
      };
    }
    // 旧式恢复适配器不写入原生元数据。仅在完成证明后填充已启动行中的空令牌，绝不覆盖
    // hook/operator 来源。
    if (node.runtime === "codex" && sessionId && resumeToken) {
      const current = this.db.prepare("SELECT node_id, session_name, status, resume_token FROM sessions WHERE id = ?").get(sessionId) as
        { node_id: string; session_name: string; status: string; resume_token: string | null } | undefined;
      const sameSession = current?.node_id === node.id && current.session_name === sessionName && current.status === "running";
      const retained = sameSession && (current.resume_token === resumeToken
        || (!current.resume_token && this.sessionRegistry.updateResumeToken(sessionId, "codex_id", resumeToken, "scrape")));
      if (!retained) {
        const store = new SeatIdentityStore(this.db);
        const proof = store.getForNode(node.id);
        if (proof) store.upsert({ ...proof, verdict: "mismatch", reason: "process_identity_mismatch" });
        return { nodeId: node.id, logicalId: node.logicalId, status: "attention_required",
          error: "已观测到原生恢复，但当前会话元数据冲突或无法保留；会话已保留。" };
      }
    }
    return { nodeId: node.id, logicalId: node.logicalId, status: "resumed" };
  }

  private launchedSessionMatchesSnapshotResume(
    sessionId: string,
    resumeType: string | null,
    resumeToken: string | null,
  ): boolean {
    if (!resumeType || !resumeToken) return false;
    const row = this.db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(sessionId) as
      | { resume_type: string | null; resume_token: string | null }
      | undefined;
    if (!row?.resume_type || !row.resume_token) return false;
    return row.resume_type === resumeType && row.resume_token === resumeToken;
  }

  /**
   * OPR.0.4.8.3 接缝 B —— 缺少内存 RigSpec 时恢复席位的启动姿态
   *（dev-guard 重启溯源裁定）：
   *   1. 持久化节点溯源（迁移 057）是主要来源。自定义附件具有可读溯源
   *      （declaringDir + 节点原始 ref）时，重新打开并推导策略；自定义 surface:flag 策略
   *      会恢复为 full_bypass。文件不可读时降级为持久化姿态，仍保持重启稳定。
   *   2. 没有溯源（例如自然认领/自连接席位）时解析持久化工作组级 ref。builtin 引用无需
   *      目录即可解析；没有溯源的自定义工作组 ref 降级为解析器的建议 floor，如实反映
   *      缺少声明目录。
   *   3. 没有附件或解析出错时显式使用 "floor"，即锁定的最低姿态缺失契约；受管席位
   *      绝不使用 undefined 或委托给环境变量。
   */
  private resolveRestorePosture(nodeId: string, rigId: string): "floor" | "full_bypass" {
    try {
      const prov = this.rigRepo.getNodePolicyProvenance(nodeId);
      if (prov) {
        // Guard-F3：解析器会在内部吞掉读取错误并给出建议 floor，因此必须在重新解析前决定
        // 回退方式。先探测持久化 resolvedTarget 是否可读：可读则按裁定重新打开并推导；
        // 不可读或无效则沿用持久化姿态以保持重启稳定，绝不静默降到 floor。
        if (prov.origin === "custom" && prov.declaringDir && prov.resolvedTarget) {
          const ref = prov.nodeRef ?? this.rigRepo.getRigPermissionPolicy(rigId);
          if (ref) {
            let content: string | null = null;
            try { content = readFileSync(prov.resolvedTarget, "utf-8"); } catch { content = null; }
            if (content !== null) {
              const body = content;
              const rederived = resolvePermissionPolicyAttachment(ref, prov.declaringDir, {
                readFile: () => body,
              });
              // Guard 第二轮：只有内容解析真正成功并具有可用语义（解析成功 + flag 契约有效）
              // 时才信任重新推导。可读但格式错误或不可用时与不可读一样沿用持久化姿态。
              // 这里只提供建议，不执行强制。
              if (rederived.contentResolved) return rederived.launchPosture;
            }
          }
        }
        return prov.launchPosture;
      }
      // Guard-F1：没有节点溯源（自然认领/自连接席位）时，以持久化工作组级附件为权威。
      // 遵循相同的可读性探测纪律，绝不相对于当前进程 cwd 解析原始相对工作组 ref。
      const rigProv = this.rigRepo.getRigPolicyProvenance(rigId);
      if (rigProv) {
        if (rigProv.origin === "custom" && rigProv.declaringDir && rigProv.resolvedTarget && rigProv.rigRef) {
          let content: string | null = null;
          try { content = readFileSync(rigProv.resolvedTarget, "utf-8"); } catch { content = null; }
          if (content !== null) {
            const body = content;
            const rederived = resolvePermissionPolicyAttachment(rigProv.rigRef, rigProv.declaringDir, {
              readFile: () => body,
            });
            if (rederived.contentResolved) return rederived.launchPosture; // 与节点级规则相同
          }
        }
        return rigProv.launchPosture;
      }
    } catch { /* 姿态解析绝不能阻塞恢复 */ }
    // R2 终态（954d97a0）：任何位置都没有溯源（以及错误路径）时，显式使用锁定的最低
    // floor；绝不返回 undefined，否则会委托给环境 YOLO。
    return "floor";
  }

  private async attemptResume(
    nodeId: string,
    sessionName: string,
    resumeType: string,
    resumeToken: string | null,
    cwd: string,
    codexConfigProfile?: string | null,
    model?: string | null,
    // OPR.0.4.8.3 接缝 B：席位恢复后的启动姿态；来源为持久化溯源，可读时重新验证
    // 自定义策略。缺失表示由环境决定。
    resolvedPosture?: "floor" | "full_bypass",
  ): Promise<
    | { kind: "resumed" }
    | { kind: "retry_fresh" }
    | { kind: "failed"; message: string }
    | { kind: "attention_required"; message: string; evidence?: string }
  > {
    const launchGeneration = this.sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid;
    let permissionMode: string | undefined;
    try {
      const selection = new NativePermissionStore(this.db).read(nodeId);
      const runtime = this.claudeResume.canResume(resumeType, resumeToken) ? "claude-code"
        : this.codexResume.canResume(resumeType, resumeToken) ? "codex" : "pi";
      if (selection && selection.runtime !== runtime) throw new Error("权限选择后席位运行时已改变；请重新显式选择或继承。");
      const override = permissionBindingOverride(selection);
      resolvedPosture = override.launchPosture ?? resolvedPosture;
      permissionMode = override.permissionMode;
    } catch (error) { return { kind: "failed", message: `权限选择：${(error as Error).message}` }; }
    if (this.claudeResume.canResume(resumeType, resumeToken)) {
      const result = await this.claudeResume.resume(sessionName, resumeType, resumeToken, cwd, resolvedPosture, model, permissionMode, nodeId);
      if (result.ok) {
        if (result.appliedLaunch && launchGeneration) this.appliedLaunchStore.recordGeneration(launchGeneration, result.appliedLaunch);
        return { kind: "resumed" };
      }
      if (result.code === "retry_fresh") return { kind: "retry_fresh" };
      // L3：显示 Claude 探测返回的 attention_required（恢复选择提示）。
      if (result.code === "attention_required") {
        return {
          kind: "attention_required",
          message: result.message,
          evidence: (result as { evidence?: string }).evidence,
        };
      }
      return { kind: "failed", message: result.message };
    }

    if (this.codexResume.canResume(resumeType, resumeToken)) {
      const result = await this.codexResume.resume(sessionName, resumeType, resumeToken, cwd, codexConfigProfile, resolvedPosture, model);
      if (result.ok) {
        if (result.appliedLaunch && launchGeneration) this.appliedLaunchStore.recordGeneration(launchGeneration, result.appliedLaunch);
        return { kind: "resumed" };
      }
      if (result.code === "retry_fresh") return { kind: "retry_fresh" };
      // Codex 认证拒绝：已存储的 OAuth 令牌无法再刷新。该问题可恢复；操作员运行
      // `codex login` 后席位即可继续。逐节点映射会为两种运行时发出
      // `status: "attention_required"` 并附带 `attentionEvidence`，无需额外装配。
      if (result.code === "attention_required") {
        return {
          kind: "attention_required",
          message: result.message,
          evidence: (result as { evidence?: string }).evidence,
        };
      }
      return { kind: "failed", message: result.message };
    }

    // OPR.0.4.6.PI1 FR-6 —— 如实执行基于会话文件的继续。会话文件缺失时返回
    // retry_fresh，调用方把它映射为 awaiting-decision 的停止并询问；绝不静默全新启动
    //（BR-6）。
    if (this.piResume?.canResume(resumeType, resumeToken)) {
      const result = await this.piResume.resume(sessionName, resumeType, resumeToken, cwd, model, resolvedPosture);
      if (result.ok) {
        if (result.appliedLaunch && launchGeneration) this.appliedLaunchStore.recordGeneration(launchGeneration, result.appliedLaunch);
        return { kind: "resumed" };
      }
      if (result.code === "retry_fresh") return { kind: "retry_fresh" };
      if (result.code === "attention_required") {
        return {
          kind: "attention_required",
          message: result.message,
          evidence: (result as { evidence?: string }).evidence,
        };
      }
      return { kind: "failed", message: result.message };
    }

    return { kind: "failed", message: "没有适用于此运行时/令牌组合的恢复适配器。" };
  }

  /**
   * L3 决策 3：运行时事实协调。给定原始 `restoreOutcome` 为 `failed` 或
   * `attention_required` 的节点，检查其当前运行时状态。如果全部四项可见证据前置条件成立，
   * 追加 `restore.outcome_reconciled`，使节点协调后的有效结果变为 `operator_recovered`。
   * 绝不修改或删除原失败事件，也绝不产生 `ready`。
   *
   * 升级成功时返回 `{ ok: true, attemptId, from, to, evidence }`；否则返回
   * `{ ok: false, code, detail }`，准确说明哪个前置条件失败。没有可协调内容时返回
   * "no_attempt" 或 "outcome_not_upgradable"。
   */
  async reconcileNodeRuntimeTruth(
    rigId: string,
    nodeId: string,
  ): Promise<ReconcileNodeResult> {
    // 定位该工作组最近一次恢复尝试。
    const startedRow = this.db.prepare(
      "SELECT seq, payload FROM events WHERE rig_id = ? AND type = 'restore.started' ORDER BY seq DESC LIMIT 1"
    ).get(rigId) as { seq: number; payload: string } | undefined;
    if (!startedRow) {
      return { ok: false, code: "no_attempt", detail: "该工作组没有已记录的 restore.started 事件。" };
    }
    const attemptId = startedRow.seq;

    // 从该工作组最近的 restore.completed 事件中查找节点最近一次尝试后的结果。若最新结果
    // 不是 failed 或 attention_required，协调器就没有可升级的内容。
    const completedRow = this.db.prepare(
      "SELECT payload FROM events WHERE rig_id = ? AND type = 'restore.completed' AND seq > ? ORDER BY seq DESC LIMIT 1"
    ).get(rigId, attemptId) as { payload: string } | undefined;
    let nodeStatus: RestoreNodeResult["status"] | null = null;
    let nodeLogicalId: string | null = null;
    if (completedRow) {
      try {
        const parsed = JSON.parse(completedRow.payload) as { result: RestoreResult };
        const found = parsed.result?.nodes?.find((n) => n.nodeId === nodeId);
        if (found) {
          nodeStatus = found.status;
          nodeLogicalId = found.logicalId;
        }
      } catch {
        // payload 损坏，按未找到节点记录处理。
      }
    }
    if (!nodeStatus) {
      return { ok: false, code: "node_not_found", detail: `工作组 ${rigId} 最近的 restore.completed 事件中没有节点 ${nodeId} 的记录。` };
    }
    if (nodeStatus !== "failed" && nodeStatus !== "attention_required") {
      return { ok: false, code: "outcome_not_upgradable", detail: `协调只能升级 failed 或 attention_required；当前结果为 ${nodeStatus}。` };
    }
    const fromStatus: "failed" | "attention_required" = nodeStatus;

    const priorReconciliation = this.db.prepare(
      "SELECT payload FROM events WHERE rig_id = ? AND node_id = ? AND type = 'restore.outcome_reconciled' AND json_extract(payload, '$.attemptId') = ? ORDER BY seq DESC LIMIT 1",
    ).get(rigId, nodeId, attemptId) as { payload: string } | undefined;
    if (priorReconciliation) {
      try {
        const prior = JSON.parse(priorReconciliation.payload) as Extract<import("./types.js").RigEvent, { type: "restore.outcome_reconciled" }>;
        if ("tmux" in prior.evidence) {
          return { ok: true, attemptId, from: prior.from, to: "operator_recovered", evidence: prior.evidence };
        }
      } catch {
        // 格式错误的既有行不是正向证据，继续进行实时证明。
      }
    }

    // 解析节点的规范会话名称，以便探测 tmux/窗格。
    const bindingRow = this.db.prepare(
      "SELECT tmux_session FROM bindings WHERE node_id = ?"
    ).get(nodeId) as { tmux_session: string | null } | undefined;
    const sessionName = bindingRow?.tmux_session ?? null;
    if (!sessionName) {
      return { ok: false, code: "tmux_session_missing", detail: "该节点没有绑定 tmux 会话。" };
    }

    const sessRow = this.db.prepare(
      "SELECT session_name, resume_token FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    ).get(nodeId) as { session_name: string; resume_token: string | null } | undefined;
    if (!sessRow || sessRow.session_name !== sessionName) {
      return { ok: false, code: "binding_mismatch", detail: `规范绑定 ${sessionName} 与最新会话行不匹配。` };
    }
    const expectedResumeToken = sessRow.resume_token;
    if (!expectedResumeToken) {
      return { ok: false, code: "resume_token_not_used", detail: "最新会话行没有记录恢复令牌。" };
    }

    // 前置条件 #1：tmux 会话存在。
    let alive = false;
    try {
      alive = await this.tmuxAdapter.hasSession(sessionName);
    } catch {
      // L1 封闭失败：含糊的探测失败在协调器中保持为不存活，原失败事件不受影响。
      alive = false;
    }
    if (!alive) {
      return { ok: false, code: "tmux_session_missing", detail: `tmux 会话 ${sessionName} 当前不存活。` };
    }

    // 解析运行时并证明准确的原生令牌进程谱系。仅有可执行文件 basename 不足以支持无输入恢复。
    const nodeRow = this.db.prepare(
      "SELECT runtime FROM nodes WHERE id = ?"
    ).get(nodeId) as { runtime: string | null } | undefined;
    const runtime = nodeRow?.runtime ?? null;
    const identity = await rebindAndVerifyPaneIdentity({
      db: this.db,
      sessionRegistry: this.sessionRegistry,
      tmux: this.tmuxAdapter,
      nodeId,
      sessionName,
      runtime,
      expectedResumeToken,
      requireExactResumeLineage: true,
      ...(this.listProcesses ? { listProcesses: this.listProcesses } : {}),
    });
    if (!identity.ok) {
      return { ok: false, code: "process_lineage_mismatch", detail: identity.detail };
    }
    const paneCommand = await this.tmuxAdapter.getPaneCommand(identity.pane);
    const paneContent = (await this.tmuxAdapter.capturePaneContent(identity.pane, 40)) ?? "";
    const probe = assessNativeResumeProbe({ runtime, paneCommand, paneContent });
    const fgProcess = runtime === "claude-code" ? "claude" as const : runtime === "codex" ? "codex" as const : null;
    if (!fgProcess) {
      return { ok: false, code: "fg_process_not_runtime", detail: `节点运行时为 ${runtime ?? "unknown"}，不是 claude/codex。` };
    }

    // 前置条件 #4：窗格处于可用/空闲状态，明确不是恢复选择提示，也不是“返回 shell”失败模式。
    if (probe.status !== "resumed") {
      return { ok: false, code: "pane_not_usable", detail: `窗格状态为 ${probe.status}（${probe.code}）；协调要求状态为 resumed。` };
    }

    // 四项前置条件全部成立。追加审计事件，绝不修改既有事件。
    this.eventBus.emit({
      type: "restore.outcome_reconciled",
      rigId,
      nodeId,
      attemptId,
      from: fromStatus,
      to: "operator_recovered",
      evidence: { tmux: true, fgProcess, resumeTokenUsed: true, paneState: "usable" },
    });

    return {
      ok: true,
      attemptId,
      from: fromStatus,
      to: "operator_recovered",
      evidence: { tmux: true, fgProcess, resumeTokenUsed: true, paneState: "usable" },
    };
  }

  private writeCheckpointFile(cwd: string, checkpoint: Checkpoint): boolean {
    try {
      const filePath = join(cwd, ".rigged-checkpoint.md");
      const content = [
        "# zrig 检查点",
        "",
        `## 摘要`,
        checkpoint.summary,
        "",
        checkpoint.currentTask ? `## 当前任务\n${checkpoint.currentTask}\n` : "",
        checkpoint.nextStep ? `## 下一步\n${checkpoint.nextStep}\n` : "",
        checkpoint.blockedOn ? `## 阻塞项\n${checkpoint.blockedOn}\n` : "",
        checkpoint.keyArtifacts.length > 0
          ? `## 关键制品\n${checkpoint.keyArtifacts.map((a) => `- ${a}`).join("\n")}\n`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      writeFileSync(filePath, content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }
}

interface PlanEntry {
  node: NodeWithBinding;
}
