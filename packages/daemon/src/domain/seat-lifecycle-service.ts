import type { NativeProcessLister } from "./native-process-lineage.js";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter, SessionProbe } from "../adapters/tmux.js";
import type { NodeInventoryEntry, PersistedEvent } from "./types.js";
import { deriveCanonicalFromEntry, getNodeInventory } from "./node-inventory.js";
import { deriveSessionName, parseSessionName } from "./session-name.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { StartupOrchestrator } from "./startup-orchestrator.js";
import type { RuntimeAdapter, ResolvedStartupFile } from "./runtime-adapter.js";
import type { ProjectionEntry, ProjectionPlan } from "./projection-planner.js";
import type { StartupAction } from "./types.js";
import { resolveStartupProof } from "./startup-resolver.js";
import type { OccupantInvalidator } from "./occupant-invalidator.js";
import { rebindAndVerifyPaneIdentity } from "./seat-attention-reconciler.js";
import { observeSolePane } from "./pane-binding-observation.js";
import { createHash } from "node:crypto";
import { NativePermissionStore } from "./native-permission-store.js";
import { validateNativePermissionSelection, unresolvedClaudePermissionModes } from "./native-permission-selection.js";

/**
 * S5（OPR.0.5.4.7）——seat-lifecycle verb surface：set-model、单席位 stop、dead-session
 * clean。遵循一套统一设计（KI-5.3-9）：
 *
 *   - 三个 verb 共享唯一的席位解析路径，即 SeatStatusService findMatches 语义：
 *     parseSessionName 从第一个 @ 起贪婪解析 rig；按 canonical-name 或 logical-id 匹配；
 *     有歧义时返回 match 列表。绝不为每个 verb 各写一套 resolver。
 *   - 每次修改都在事务中执行，并在同一事务持久化 audit event：node.model_changed /
 *     session.stopped / session.cleaned。
 *   - 每次拒绝都点明确切检查内容；无法确定的 tmux probe 必须拒绝，绝不猜测（从一开始就应用
 *     S1 错误边界）。
 */

const SEAT_LOOKUP_GUIDANCE = "使用 zrig ps --nodes 列出席位";

/** Terminal session status——clean verb 绝不能触碰的 row，因为它们已经记录结束的 tenancy。
 *  该词表与 seat-handover-service 及 watchdog 的 TERMINAL_SESSION_STATUSES 共享。 */
const TERMINAL_SESSION_STATUSES = new Set(["superseded", "detached", "exited"]);

export interface SeatLifecycleDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  listProcesses?: NativeProcessLister;
  nodeLauncher?: NodeLauncher;
  startupOrchestrator?: StartupOrchestrator;
  runtimeAdapters?: Record<string, RuntimeAdapter>;
  occupantInvalidator?: OccupantInvalidator;
  activityOracle?: { declareOccupantSwap(nodeId: string, generation: string): void };
}

interface ResolvedSeat {
  entry: NodeInventoryEntry;
  nodeId: string;
}

export interface SeatRefusal {
  ok: false;
  code:
    | "seat_ref_required"
    | "seat_not_found"
    | "seat_ambiguous"
    | "missing_model"
    | "missing_reason"
    | "permission_selection_refused"
    | "no_session"
    | "claimed_session"
    | "session_not_live"
    | "session_live"
    | "tmux_probe_failed"
    | "nothing_to_clean"
    | "fresh_required"
    | "unmanaged_session_collision"
    | "startup_context_missing"
    | "startup_context_malformed"
    | "startup_context_runtime_mismatch"
    | "runtime_adapter_missing"
    | "launch_unavailable"
    | "launch_failed"
    | "startup_failed"
    | "attention_required"
    | "runtime_identity_unverified";
  message: string;
  guidance?: string;
  matches?: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }>;
}

export interface SeatDescriptor {
  rigId: string;
  rigName: string;
  logicalId: string;
  nodeId: string;
}

export type SetModelResult =
  | { ok: true; seat: SeatDescriptor; from: string | null; to: string; changed: boolean }
  | SeatRefusal;

export type StopSeatResult =
  | { ok: true; seat: SeatDescriptor; sessionName: string; sessionId: string }
  | SeatRefusal;

export type CleanSeatResult =
  | { ok: true; seat: SeatDescriptor; actions: { sessionsExited: string[]; bindingCleared: boolean } }
  | SeatRefusal;

export type LaunchFreshResult =
  | {
      ok: true;
      seat: SeatDescriptor;
      status: "ready";
      sessionName: string;
      sessionId: string;
      generation: string;
      model: string | null;
      startupPolicyHash: string;
      supersededSessionIds: string[];
    }
  | (SeatRefusal & {
      status?: "attention_required" | "failed";
      sessionName?: string;
      sessionId?: string;
      generation?: string;
    });

interface LatestSessionRow {
  id: string;
  session_name: string;
  status: string;
  origin: string;
}

interface PersistedStartupContextRow {
  projection_entries_json: string;
  resolved_files_json: string;
  startup_actions_json: string;
  runtime: string | null;
}

interface ParsedStartupContext {
  plan: ProjectionPlan;
  resolvedStartupFiles: ResolvedStartupFile[];
  startupActions: StartupAction[];
  runtime: string;
  hash: string;
}

export class SeatLifecycleService {
  private readonly db: Database.Database;
  private readonly rigRepo: RigRepository;
  private readonly sessionRegistry: SessionRegistry;
  private readonly eventBus: EventBus;
  private readonly tmuxAdapter: TmuxAdapter;
  private readonly listProcesses?: NativeProcessLister;
  private readonly nodeLauncher: NodeLauncher | null;
  private readonly startupOrchestrator: StartupOrchestrator | null;
  private readonly runtimeAdapters: Record<string, RuntimeAdapter>;
  private readonly occupantInvalidator: OccupantInvalidator | null;
  private readonly activityOracle: SeatLifecycleDeps["activityOracle"] | null;

  constructor(deps: SeatLifecycleDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("SeatLifecycleService：rigRepo 必须共享同一个数据库句柄");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("SeatLifecycleService：sessionRegistry 必须共享同一个数据库句柄");
    if (deps.db !== deps.eventBus.db) throw new Error("SeatLifecycleService：eventBus 必须共享同一个数据库句柄");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.listProcesses = deps.listProcesses;
    this.nodeLauncher = deps.nodeLauncher ?? null;
    this.startupOrchestrator = deps.startupOrchestrator ?? null;
    this.runtimeAdapters = deps.runtimeAdapters ?? {};
    this.occupantInvalidator = deps.occupantInvalidator ?? null;
    this.activityOracle = deps.activityOracle ?? null;
  }

  async setModel(input: { seatRef: string; model: string; reason: string; operator?: string | null }): Promise<SetModelResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    if (!input.model?.trim()) {
      return { ok: false, code: "missing_model", message: "必须提供目标 model id（--model）。" };
    }
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;

    const model = input.model.trim();
    const seat = this.describe(resolved);
    const from = resolved.entry.model ?? null;
    if (from === model) {
      // 真实 no-op：持久值已经是目标值，不生成 event。
      return { ok: true, seat, from, to: model, changed: false };
    }

    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      this.rigRepo.setNodeModel(resolved.nodeId, model);
      persisted = this.eventBus.persistWithinTransaction({
        type: "node.model_changed",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        logicalId: seat.logicalId,
        from,
        to: model,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);

    return { ok: true, seat, from, to: model, changed: true };
  }

  async setPermissions(input: { seatRef: string; mode: string; reason: string; actor: string }): Promise<
    | { ok: true; seat: SeatDescriptor; from: unknown; to: unknown; changed: boolean; effect: string }
    | SeatRefusal
  > {
    input = { ...input };
    const required = this.requireReason(input.reason);
    if (required) return required;
    if (!input.actor.trim()) return { ok: false, code: "permission_selection_refused", message: "权限审计必须提供发送方 identity。" };
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);
    const runtime = resolved.entry.runtime ?? "unknown";
    try {
      const dynamic = runtime === "claude-code" && !["floor", "full_bypass", "inherit"].includes(input.mode);
      const managed = this.runtimeAdapters["claude-code"]?.claudeManagedLaunch;
      if (dynamic && !managed) await unresolvedClaudePermissionModes();
      const launch = dynamic ? await managed!.prepare({ nodeId: seat.nodeId, cwd: resolved.entry.cwd ?? undefined }, input.mode) : null;
      const to = input.mode === "inherit" ? null : dynamic ? { runtime: "claude-code" as const, mode: input.mode }
        : validateNativePermissionSelection(runtime, input.mode);
      const store = new NativePermissionStore(this.db);
      let persisted: PersistedEvent | null = null;
      const result = this.db.transaction(() => {
        launch?.assertCurrent();
        const currentRuntime = this.db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(seat.nodeId) as { runtime: string } | undefined;
        if (currentRuntime?.runtime !== runtime) throw new Error("检查 native option 期间席位 runtime 已变化；未修改 selection。");
        const from = store.read(seat.nodeId);
        const changed = from?.runtime !== to?.runtime || from?.mode !== to?.mode;
        if (changed) {
          store.write(seat.nodeId, to, input.actor.trim(), input.reason.trim());
          persisted = this.eventBus.persistWithinTransaction({ type: "node.permissions_changed", rigId: seat.rigId,
            nodeId: seat.nodeId, from, to, actor: input.actor.trim(), reason: input.reason.trim(), source: "seat_selection", effect: "future_launches_only" });
        }
        return { ok: true as const, seat, from, to, changed,
          effect: "只影响后续托管 launch。当前 native process、history、permission rule 与 work posture 均未改变；未请求 relaunch。" };
      })();
      if (persisted) this.eventBus.notifySubscribers(persisted);
      return result;
    } catch (error) {
      return { ok: false, code: "permission_selection_refused", message: (error as Error).message };
    }
  }

  async stopSeat(input: { seatRef: string; reason: string; operator?: string | null }): Promise<StopSeatResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(resolved.nodeId)) {
      return guard.lifecycle([resolved.nodeId], () => this.stopSeat(input));
    }
    const seat = this.describe(resolved);

    const session = this.latestSession(resolved.nodeId);
    if (!session) {
      return { ok: false, code: "no_session", message: `席位 "${input.seatRef}" 没有可停止的会话（已检查节点 ${seat.logicalId} 的最新 sessions row）。` };
    }
    if (session.origin === "claimed") {
      return {
        ok: false,
        code: "claimed_session",
        message: `会话 "${session.session_name}" 是接管的（origin=claimed），并非由 zrig 启动；stop 拒绝终止它。`,
        guidance: "释放已接管会话：zrig unclaim",
      };
    }

    // Wave-2 fix round 1（r1 row 9baac99f）：消费 CLASSIFIED probe，绝不使用折叠后的
    // hasSession view。transport 短暂故障属于 INDETERMINATE，而不是 absence（KI-5.3-8
    // fabricated-absence 类别，破坏性方向）。
    const probed = await this.probeLiveness(session.session_name, "stop 会拒绝，而不是盲目终止");
    if ("code" in probed) return probed;
    if (probed.state === "absent") {
      return {
        ok: false,
        code: "session_not_live",
        message: `会话 "${session.session_name}" 在 tmux 中不存在（已检查 tmux has-session，这是正向 absence evidence），没有可停止的内容。`,
        guidance: "清理 stale record 并让已停止席位恢复可启动：zrig seat clean",
      };
    }

    return this.stopManagedTmuxSeat(resolved, session, input.reason, input.operator);
  }

  async cleanSeat(input: { seatRef: string; reason: string; operator?: string | null }): Promise<CleanSeatResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(resolved.nodeId)) {
      return guard.lifecycle([resolved.nodeId], () => this.cleanSeat(input));
    }
    const seat = this.describe(resolved);

    const binding = this.sessionRegistry.getBindingForNode(resolved.nodeId);
    const nonTerminal = (this.db.prepare(
      "SELECT id, session_name, status, origin FROM sessions WHERE node_id = ? ORDER BY id",
    ).all(resolved.nodeId) as LatestSessionRow[])
      .filter((s) => !TERMINAL_SESSION_STATUSES.has(s.status));

    // 修复 r2-F3（row 30045f39）：clean 会修改每个非 terminal session row，因此安全检查必须
    // 精确覆盖这个集合。只探测最新 row 会为其他 row 伪造安全性，例如 canonical-name churn 下
    // older-live/newer-dead。每个将被触碰的 row 都检查 adopted origin，并探测正向 absence
    //（r1 纪律）；binding 自身 tmux session 若未被任何 row 携带，也要探测。
    const mutationTargets = nonTerminal;
    for (const row of mutationTargets) {
      if (row.origin === "claimed") {
        return {
          ok: false,
          code: "claimed_session",
          message: `会话 "${row.session_name}" 是接管的（origin=claimed）；clean 拒绝触碰已接管状态。`,
          guidance: "释放已接管会话：zrig unclaim",
        };
      }
    }
    const probeNames = [...new Set([
      ...mutationTargets.map((s) => s.session_name),
      ...(binding?.tmuxSession ? [binding.tmuxSession] : []),
    ])];
    for (const name of probeNames) {
      const probed = await this.probeLiveness(name, "席位可能仍存活时，clean 会拒绝而不是清除状态");
      if ("code" in probed) return probed;
      if (probed.state === "present") {
        return {
          ok: false,
          code: "session_live",
          message: `会话 "${name}" 在 tmux 中仍存活（已对 clean 会修改的每个 session row 检查 tmux has-session）；clean 只处理已停止席位。`,
          guidance: "请先停止存活席位：zrig seat stop",
        };
      }
    }
    const session = this.latestSession(resolved.nodeId);

    if (!binding && nonTerminal.length === 0) {
      return {
        ok: false,
        code: "nothing_to_clean",
        message: `席位 "${input.seatRef}" 已是 clean 状态（已检查：节点没有 binding row，且没有 terminal status ${[...TERMINAL_SESSION_STATUSES].join("/")} 之外的 session row）。`,
      };
    }

    const sessionsExited: string[] = [];
    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      for (const row of nonTerminal) {
        this.sessionRegistry.updateStatus(row.id, "exited");
        sessionsExited.push(row.session_name);
      }
      this.sessionRegistry.clearBinding(resolved.nodeId);
      persisted = this.eventBus.persistWithinTransaction({
        type: "session.cleaned",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        sessionName: session?.session_name ?? null,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
        actions: { sessionsExited, bindingCleared: binding !== null },
      });
    });
    tx();
    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(resolved.nodeId);
    if (persisted) this.eventBus.notifySubscribers(persisted);

    return { ok: true, seat, actions: { sessionsExited, bindingCleared: binding !== null } };
  }

  /** native gate 后，向同一个 fresh occupant 完成 context delivery。绝不启动进程，也不重放
   *  不确定或已经结束的 delivery。 */
  async continueFreshStartup(seatRef: string) {
    const resolved = this.resolveSeat(seatRef);
    if ("code" in resolved) return resolved;
    const guard = this.tmuxAdapter.deliveryGuard;
    return guard
      ? guard.lifecycle([resolved.nodeId], () => this.continueFreshStartupUnchecked(seatRef))
      : this.continueFreshStartupUnchecked(seatRef);
  }

  private async continueFreshStartupUnchecked(seatRef: string) {
    const resolved = this.resolveSeat(seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);
    const node = this.rigRepo.getRig(seat.rigId)?.nodes.find((n) => n.id === seat.nodeId);
    const session = this.latestSession(seat.nodeId);
    const binding = this.sessionRegistry.getBindingForNode(seat.nodeId);
    if (!node || !session || !binding?.tmuxSession || !this.startupOrchestrator
      || !this.startupOrchestrator.canContinueFresh(node.id, session.id)) {
      return { ok: false as const, code: "continuation_unavailable", message: "该 occupant 没有经过验证的 pending fresh-context delivery。请刷新以检查实际状态。" };
    }
    const pane = await observeSolePane(this.tmuxAdapter, binding.tmuxSession);
    if (!pane.ok || pane.pane !== binding.tmuxPane) return { ok: false as const, code: "binding_changed", message: "托管 terminal binding 已变化；未投递 context。" };
    const adapter = node.runtime ? this.runtimeAdapters[node.runtime] : undefined;
    if (!adapter) return { ok: false as const, code: "runtime_adapter_missing", message: "已配置的 runtime adapter 不可用。" };
    const ready = await adapter.checkReady({ ...binding, cwd: node.cwd ?? "." });
    if (!ready.ready) return { ok: false as const, code: "attention_required", message: ready.reason ?? "请先解决 native prerequisite。" };
    const startup = this.readStartupContext(node.id, node.cwd ?? ".");
    if (!startup.ok) return startup.refusal;
    if (startup.context.runtime !== node.runtime) return { ok: false as const, code: "startup_context_runtime_mismatch", message: "已保存的 startup context 属于不同 runtime。" };
    // 异步 native observation 后重新检查；startNode 会在首次 await 前立即记录 pending，消费
    // 保留的权限。
    if (this.latestSession(node.id)?.id !== session.id || this.sessionRegistry.getBindingForNode(node.id)?.tmuxPane !== pane.pane
      || !this.startupOrchestrator.canContinueFresh(node.id, session.id)) return { ok: false as const, code: "continuation_unavailable", message: "readiness 检查期间 startup 已变化，请刷新。" };
    const result = await this.startupOrchestrator.startNode({
      rigId: seat.rigId, nodeId: node.id, sessionId: session.id,
      binding: { ...binding, cwd: node.cwd ?? ".", model: node.model ?? undefined, codexConfigProfile: node.codexConfigProfile ?? undefined },
      adapter, plan: startup.context.plan, resolvedStartupFiles: startup.context.resolvedStartupFiles,
      startupActions: startup.context.startupActions, isRestore: false,
      sessionName: session.session_name, skipHarnessLaunch: true, continueFreshStartup: true, includeDurableObligations: true, allowFreshFallback: false,
    });
    return { ...result, message: result.ok ? "已把配置的 context 投递到现有 fresh conversation。" : result.errors.join("; ") };
  }

  /** 有意把恰好一个托管席位替换为空白 native occupant。 */
  async launchFresh(input: {
    seatRef: string;
    fresh: boolean;
    reason: string;
    stop?: boolean;
    operator?: string | null;
  }): Promise<LaunchFreshResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    if (input.fresh !== true) {
      return {
        ok: false,
        code: "fresh_required",
        message: "显式 fresh launch 要求 fresh=true（--fresh）；不会推断 continuity mode。",
      };
    }
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(resolved.nodeId)) {
      return guard.lifecycle([resolved.nodeId], () => this.launchFresh(input));
    }
    const seat = this.describe(resolved);
    const rig = this.rigRepo.getRig(seat.rigId);
    const node = rig?.nodes.find((candidate) => candidate.id === seat.nodeId);
    if (!rig || !node) {
      return { ok: false, code: "seat_not_found", message: `席位 "${input.seatRef}" 已不存在。`, guidance: SEAT_LOOKUP_GUIDANCE };
    }
    if (!this.nodeLauncher || !this.startupOrchestrator) {
      return { ok: false, code: "launch_unavailable", message: "此后台服务中 fresh-launch service 不可用。" };
    }

    const startup = this.readStartupContext(node.id, node.cwd ?? ".");
    if (!startup.ok) return startup.refusal;
    if (!node.runtime || startup.context.runtime !== node.runtime) {
      return {
        ok: false,
        code: "startup_context_runtime_mismatch",
        message: `持久化 startup context runtime '${startup.context.runtime}' 与当前节点 runtime '${node.runtime ?? "missing"}' 不匹配。`,
      };
    }
    const adapter = this.runtimeAdapters[node.runtime];
    if (!adapter) {
      return {
        ok: false,
        code: "runtime_adapter_missing",
        message: `没有可用于 '${node.runtime}' 的 runtime adapter。`,
      };
    }

    const canonicalSessionName = deriveCanonicalFromEntry(resolved.entry)
      ?? deriveSessionName(seat.rigName, seat.logicalId);
    const retiringRows = this.nonTerminalSessions(node.id);
    if (retiringRows.some((row) => row.origin === "claimed")) {
      return {
        ok: false,
        code: "claimed_session",
        message: `席位 "${input.seatRef}" 有 adopted/operator-owned occupant；即使带 --stop，fresh launch 也会拒绝。`,
        guidance: "请自行停止已接管进程，然后在 fresh launch 前运行 zrig seat clean。",
      };
    }
    // detached 对进程清理而言是 terminal，但仍是 reboot candidate。有意 fresh launch 也必须
    // 退役这段既往 history。
    const supersededSessionIds = (this.db.prepare(
      "SELECT id FROM sessions WHERE node_id = ? AND status NOT IN ('superseded', 'exited')",
    ).all(node.id) as Array<{ id: string }>).map((row) => row.id);
    const retiringGeneration = this.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null;

    const canonicalProbe = await this.probeLiveness(
      canonicalSessionName,
      "可能存活的 canonical session 存在时，fresh launch 会拒绝而不是覆盖",
    );
    if ("code" in canonicalProbe) return canonicalProbe;
    if (canonicalProbe.state === "present") {
      const currentSession = this.latestSession(node.id);
      const currentBinding = this.sessionRegistry.getBindingForNode(node.id);
      const currentManaged = currentSession !== null
        && !TERMINAL_SESSION_STATUSES.has(currentSession.status)
        && currentSession.origin !== "claimed"
        && currentSession.session_name === canonicalSessionName
        && currentBinding?.tmuxSession === canonicalSessionName;
      if (!currentManaged) {
        return {
          ok: false,
          code: "unmanaged_session_collision",
          message: `Canonical tmux session "${canonicalSessionName}" 已存在，但不属于该席位当前托管 row；拒绝覆盖。`,
        };
      }
      if (!input.stop) {
        return {
          ok: false,
          code: "session_live",
          message: `席位 "${input.seatRef}" 仍存活；不带 --stop 时 fresh launch 会拒绝。`,
          guidance: "重新运行并添加 --stop，以准确结束该托管 occupant；或使用 zrig handover 携带 context。",
        };
      }
      const observedPane = await observeSolePane(this.tmuxAdapter, canonicalSessionName);
      if (!observedPane.ok && observedPane.code === "tmux_unavailable") {
        return {
          ok: false,
          code: "tmux_probe_failed",
          message: `${observedPane.detail}；无法确认 live occupant identity 时，fresh launch 会拒绝而不是终止。`,
        };
      }
      if (!observedPane.ok || observedPane.pane !== currentBinding?.tmuxPane) {
        return {
          ok: false,
          code: "unmanaged_session_collision",
          message: `Canonical tmux session "${canonicalSessionName}" 仍存活，但其 pane 与该席位当前托管 binding 不匹配；拒绝停止。`,
        };
      }
      const stopped = await this.stopManagedTmuxSeat(
        resolved,
        currentSession,
        input.reason,
        input.operator,
      );
      if (!stopped.ok) return stopped;
    }

    // 为 stale/history row 复用 clean 的穷尽式正向 absence gate。
    const remaining = this.nonTerminalSessions(node.id);
    const binding = this.sessionRegistry.getBindingForNode(node.id);
    if (remaining.length > 0 || binding !== null) {
      const cleaned = await this.cleanSeat({
        seatRef: canonicalSessionName,
        reason: input.reason,
        operator: input.operator,
      });
      if (!cleaned.ok) return cleaned;
    }

    // stop/clean 组合可能已经耗时；在 mutation boundary 再次确认 absence。NodeLauncher 同样会
    // 拒绝 duplicate_session，绝不会终止它。
    const finalProbe = await this.probeLiveness(
      canonicalSessionName,
      "fresh launch 会拒绝，而不是与 canonical-session 冲突竞争",
    );
    if ("code" in finalProbe) return finalProbe;
    if (finalProbe.state === "present") {
      return {
        ok: false,
        code: "unmanaged_session_collision",
        message: `Canonical tmux session "${canonicalSessionName}" 在 launch 前出现；拒绝覆盖。`,
      };
    }

    // 历史行继续仅追加保留，但不再表现为当前记录。
    for (const sessionId of supersededSessionIds) this.sessionRegistry.markSuperseded(sessionId);
    this.occupantInvalidator?.invalidateRetiringOccupant({
      retiringSessionName: canonicalSessionName,
      successorSessionName: canonicalSessionName,
      ...(retiringGeneration ? { retiringGeneration } : {}),
    });

    const launch = await this.nodeLauncher.launchNode(seat.rigId, seat.logicalId, {
      sessionName: canonicalSessionName,
      cwd: node.cwd ?? undefined,
      occupantKind: "fresh",
    });
    if (!launch.ok) {
      return { ok: false, code: "launch_failed", message: launch.message };
    }
    const observedGeneration = this.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null;
    const generation = observedGeneration && observedGeneration !== retiringGeneration
      ? observedGeneration
      : null;
    if (!generation) {
      const compensation = await this.compensateFailedFreshLaunch({
        seat,
        launch,
        supersededSessionIds,
        retiringGeneration,
        newGeneration: null,
        startupPolicyHash: startup.context.hash,
        model: node.model,
        reason: input.reason,
        operator: input.operator,
        errors: ["未持久化新的 occupant generation"],
      });
      return compensation === "zero"
        ? { ok: false, code: "startup_failed", status: "failed", message: "Fresh launch 无法持久化新的 occupant generation；已回滚新会话。" }
        : { ok: false, code: "attention_required", status: "attention_required", message: "Fresh launch 无法持久化新的 occupant generation，且无法确认新进程已停止；该席位需要关注。", sessionName: canonicalSessionName, sessionId: launch.session.id };
    }
    this.activityOracle?.declareOccupantSwap(node.id, generation);

    const launchPosture = this.rigRepo.getNodePolicyProvenance(node.id)?.launchPosture
      ?? this.rigRepo.getRigPolicyProvenance(seat.rigId)?.launchPosture
      ?? "floor";
    const startupResult = await this.startupOrchestrator.startNode({
      rigId: seat.rigId,
      nodeId: node.id,
      sessionId: launch.session.id,
      binding: {
        ...launch.binding,
        cwd: node.cwd ?? ".",
        model: node.model ?? undefined,
        codexConfigProfile: node.codexConfigProfile ?? undefined,
        launchPosture,
      },
      adapter,
      plan: startup.context.plan,
      resolvedStartupFiles: startup.context.resolvedStartupFiles,
      startupActions: startup.context.startupActions,
      isRestore: false,
      includeDurableObligations: true,
      sessionName: canonicalSessionName,
      allowFreshFallback: false,
    });

    if (!startupResult.ok && startupResult.startupStatus === "failed") {
      const compensation = await this.compensateFailedFreshLaunch({
        seat,
        launch,
        supersededSessionIds,
        retiringGeneration,
        newGeneration: generation,
        startupPolicyHash: startup.context.hash,
        model: node.model,
        reason: input.reason,
        operator: input.operator,
        errors: startupResult.errors,
      });
      return compensation === "zero"
        ? {
            ok: false,
            code: "startup_failed",
            status: "failed",
            message: `Fresh startup 失败，已回滚到零 live session/binding：${startupResult.errors.join("; ")}`,
          }
        : {
            ok: false,
            code: "attention_required",
            status: "attention_required",
            message: `Fresh startup 失败，且无法确认新进程已停止；该席位需要关注：${startupResult.errors.join("; ")}`,
            sessionName: canonicalSessionName,
            sessionId: launch.session.id,
            generation,
          };
    }

    const identity = await rebindAndVerifyPaneIdentity({
      db: this.db,
      sessionRegistry: this.sessionRegistry,
      tmux: this.tmuxAdapter,
      nodeId: node.id,
      sessionName: canonicalSessionName,
      runtime: node.runtime,
      expectedResumeToken: this.sessionResumeToken(launch.session.id),
      listProcesses: this.listProcesses,
    });
    const attentionRequired = !startupResult.ok || !identity.ok;
    if (!identity.ok) this.sessionRegistry.updateStartupStatus(launch.session.id, "attention_required");

    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE nodes SET
          occupant_lifecycle = 'active',
          continuity_outcome = 'fresh',
          handover_result = NULL,
          previous_occupant = ?,
          handover_at = ?
        WHERE id = ?
      `).run(retiringRows.at(-1)?.session_name ?? null, new Date().toISOString(), node.id);
      const nativeSessionId = this.sessionResumeToken(launch.session.id);
      persisted = this.eventBus.persistWithinTransaction({
        type: "seat.fresh_launched",
        rigId: seat.rigId,
        nodeId: node.id,
        logicalId: seat.logicalId,
        sessionName: canonicalSessionName,
        sessionId: launch.session.id,
        supersededSessionIds,
        retiringGeneration,
        newGeneration: generation,
        nativeSessionId,
        ...(nativeSessionId ? {} : { nativeSessionIdReason: "scrape_miss" }),
        model: node.model,
        startupPolicyHash: startup.context.hash,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
        status: attentionRequired ? "attention_required" : "ready",
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);

    if (attentionRequired) {
      return {
        ok: false,
        code: startupResult.ok ? "runtime_identity_unverified" : "attention_required",
        status: "attention_required",
        message: startupResult.ok
          ? `Fresh occupant 已启动，但 runtime identity 需要关注：${identity.ok ? "unknown" : identity.detail}`
          : `Fresh occupant 已启动，但 startup 需要关注：${startupResult.errors.join("; ")}`,
        sessionName: canonicalSessionName,
        sessionId: launch.session.id,
        generation,
      };
    }

    return {
      ok: true,
      seat,
      status: "ready",
      sessionName: canonicalSessionName,
      sessionId: launch.session.id,
      generation,
      model: node.model,
      startupPolicyHash: startup.context.hash,
      supersededSessionIds,
    };
  }

  // -- 共享内部实现 --

  private async stopManagedTmuxSeat(
    resolved: ResolvedSeat,
    session: LatestSessionRow,
    reason: string,
    operator?: string | null,
  ): Promise<StopSeatResult> {
    const seat = this.describe(resolved);
    const kill = await this.tmuxAdapter.killSession(session.session_name);
    if (kill && !kill.ok && kill.code !== "session_not_found") {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `对 "${session.session_name}" 执行 tmux kill-session 失败：${kill.message ?? kill.code}`,
      };
    }
    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      this.sessionRegistry.updateStatus(session.id, "exited");
      this.sessionRegistry.clearBinding(resolved.nodeId);
      persisted = this.eventBus.persistWithinTransaction({
        type: "session.stopped",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        sessionName: session.session_name,
        reason: reason.trim(),
        operator: operator ?? null,
      });
    });
    tx();
    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(resolved.nodeId);
    if (persisted) this.eventBus.notifySubscribers(persisted);
    return { ok: true, seat, sessionName: session.session_name, sessionId: session.id };
  }

  private nonTerminalSessions(nodeId: string): LatestSessionRow[] {
    return (this.db.prepare(
      "SELECT id, session_name, status, origin FROM sessions WHERE node_id = ? ORDER BY created_at, id",
    ).all(nodeId) as LatestSessionRow[]).filter((row) => !TERMINAL_SESSION_STATUSES.has(row.status));
  }

  private sessionResumeToken(sessionId: string): string | null {
    const row = this.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(sessionId) as
      | { resume_token: string | null }
      | undefined;
    return row?.resume_token?.trim() || null;
  }

  private readStartupContext(
    nodeId: string,
    cwd: string,
  ): { ok: true; context: ParsedStartupContext } | { ok: false; refusal: SeatRefusal } {
    const row = this.db.prepare(
      "SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime FROM node_startup_context WHERE node_id = ?",
    ).get(nodeId) as PersistedStartupContextRow | undefined;
    if (!row) {
      return {
        ok: false,
        refusal: {
          ok: false,
          code: "startup_context_missing",
          message: `节点 ${nodeId} 缺少持久化 startup context；fresh launch 拒绝编造空 startup policy。`,
        },
      };
    }

    let rawEntries: unknown;
    let rawFiles: unknown;
    let rawActions: unknown;
    try {
      rawEntries = JSON.parse(row.projection_entries_json);
      rawFiles = JSON.parse(row.resolved_files_json);
      rawActions = JSON.parse(row.startup_actions_json);
    } catch (error) {
      return this.malformedStartupContext(nodeId, `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(rawEntries) || !Array.isArray(rawFiles) || !Array.isArray(rawActions) || !row.runtime?.trim()) {
      return this.malformedStartupContext(nodeId, "projection entry、resolved file 和 startup action 必须是数组，runtime 必须非空");
    }

    const entries: ProjectionEntry[] = [];
    for (const raw of rawEntries) {
      if (!isRecord(raw)
        || !isProjectionCategory(raw["category"])
        || !hasStrings(raw, ["effectiveId", "sourceSpec", "sourcePath", "resourcePath", "absolutePath"])
        || !isOptionalString(raw["resourceType"])
        || !isOptionalString(raw["target"])
        || !isOptionalOneOf(raw["mergeStrategy"], ["managed_block", "append"] as const)
        || !isOptionalOneOf(raw["pluginType"], ["claude", "codex", "auto"] as const)) {
        return this.malformedStartupContext(nodeId, "projection_entries_json 包含无效 entry");
      }
      // S04 拥有 live ambient skill set。在这里重放旧 catalog selection 可能重新安装已由
      // work-install 移除的 skill。
      if (raw["category"] === "skill") continue;
      entries.push({
        category: raw["category"],
        effectiveId: raw["effectiveId"],
        sourceSpec: raw["sourceSpec"],
        sourcePath: raw["sourcePath"],
        resourcePath: raw["resourcePath"],
        absolutePath: raw["absolutePath"],
        classification: "safe_projection",
        ...(typeof raw["resourceType"] === "string" ? { resourceType: raw["resourceType"] } : {}),
        ...(typeof raw["mergeStrategy"] === "string" ? { mergeStrategy: raw["mergeStrategy"] as ProjectionEntry["mergeStrategy"] } : {}),
        ...(typeof raw["target"] === "string" ? { target: raw["target"] } : {}),
        ...(typeof raw["pluginType"] === "string" ? { pluginType: raw["pluginType"] as ProjectionEntry["pluginType"] } : {}),
      });
    }

    const resolvedStartupFiles: ResolvedStartupFile[] = [];
    for (const raw of rawFiles) {
      if (!isRecord(raw)
        || !hasStrings(raw, ["path", "absolutePath", "ownerRoot"])
        || !isOneOf(raw["deliveryHint"], ["auto", "guidance_merge", "skill_install", "send_text"] as const)
        || typeof raw["required"] !== "boolean"
        || !isStringArrayOf(raw["appliesOn"], ["fresh_start", "restore"] as const)
        || !isOptionalOneOf(raw["kind"], ["file"] as const)) {
        return this.malformedStartupContext(nodeId, "resolved_files_json 包含无效 entry");
      }
      resolvedStartupFiles.push({
        path: raw["path"],
        absolutePath: raw["absolutePath"],
        ownerRoot: raw["ownerRoot"],
        deliveryHint: raw["deliveryHint"],
        required: raw["required"],
        appliesOn: raw["appliesOn"],
        ...(raw["kind"] === "file" ? { kind: "file" as const } : {}),
      });
    }

    const startupActions: StartupAction[] = [];
    for (const raw of rawActions) {
      if (!isRecord(raw)
        || !isOneOf(raw["type"], ["slash_command", "send_text", "startup_proof"] as const)
        || typeof raw["value"] !== "string"
        || !isOneOf(raw["phase"], ["after_files", "after_ready"] as const)
        || !isStringArrayOf(raw["appliesOn"], ["fresh_start", "restore"] as const)
        || typeof raw["idempotent"] !== "boolean"
        || !isOptionalOneOf(raw["builtin"], ["session_identity"] as const)) {
        return this.malformedStartupContext(nodeId, "startup_actions_json 包含无效 entry");
      }
      startupActions.push({
        type: raw["type"],
        value: raw["value"],
        phase: raw["phase"],
        appliesOn: raw["appliesOn"],
        idempotent: raw["idempotent"],
        ...(raw["builtin"] === "session_identity" ? { builtin: "session_identity" as const } : {}),
      });
    }

    try {
      resolveStartupProof(startupActions, "fresh_start");
    } catch (err) {
      return this.malformedStartupContext(nodeId, (err as Error).message);
    }

    const startupFiles = resolvedStartupFiles.map((file) => ({
      kind: file.kind,
      path: file.path,
      deliveryHint: file.deliveryHint,
      required: file.required,
      appliesOn: file.appliesOn,
    }));
    const plan: ProjectionPlan = {
      runtime: row.runtime,
      cwd,
      entries,
      startup: { files: startupFiles, actions: startupActions },
      conflicts: [],
      noOps: [],
      diagnostics: [],
    };
    const hash = createHash("sha256")
      .update(JSON.stringify([row.projection_entries_json, row.resolved_files_json, row.startup_actions_json, row.runtime]))
      .digest("hex");
    return { ok: true, context: { plan, resolvedStartupFiles, startupActions, runtime: row.runtime, hash } };
  }

  private malformedStartupContext(
    nodeId: string,
    detail: string,
  ): { ok: false; refusal: SeatRefusal } {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: "startup_context_malformed",
        message: `节点 ${nodeId} 的持久化 startup context 格式错误：${detail}。`,
      },
    };
  }

  private async compensateFailedFreshLaunch(input: {
    seat: SeatDescriptor;
    launch: Extract<Awaited<ReturnType<NodeLauncher["launchNode"]>>, { ok: true }>;
    supersededSessionIds: string[];
    retiringGeneration: string | null;
    newGeneration: string | null;
    startupPolicyHash: string;
    model: string | null;
    reason: string;
    operator?: string | null;
    errors: string[];
  }): Promise<"zero" | "attention"> {
    const kill = await this.tmuxAdapter.killSession(input.launch.sessionName);
    const stopped = !kill || kill.ok || kill.code === "session_not_found";
    const errors = stopped
      ? input.errors
      : [...input.errors, `tmux kill-session 失败：${kill.message ?? kill.code}`];
    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      if (stopped) {
        this.sessionRegistry.updateStatus(input.launch.session.id, "exited");
        this.sessionRegistry.clearBinding(input.seat.nodeId);
        this.db.prepare(
          "UPDATE nodes SET occupant_lifecycle = 'unknown', continuity_outcome = 'failed' WHERE id = ?",
        ).run(input.seat.nodeId);
      } else {
        this.sessionRegistry.updateStartupStatus(input.launch.session.id, "attention_required");
        this.db.prepare(
          "UPDATE nodes SET occupant_lifecycle = 'active', continuity_outcome = 'fresh' WHERE id = ?",
        ).run(input.seat.nodeId);
      }
      persisted = this.eventBus.persistWithinTransaction({
        type: "seat.fresh_launch_failed",
        rigId: input.seat.rigId,
        nodeId: input.seat.nodeId,
        logicalId: input.seat.logicalId,
        sessionName: input.launch.sessionName,
        sessionId: input.launch.session.id,
        supersededSessionIds: input.supersededSessionIds,
        retiringGeneration: input.retiringGeneration,
        newGeneration: input.newGeneration,
        model: input.model,
        startupPolicyHash: input.startupPolicyHash,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
        errors,
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);
    return stopped ? "zero" : "attention";
  }

  /**
   * 两个修改 verb 共享的唯一 liveness 读取（修复 r1，row 9baac99f）：使用 CLASSIFIED
   * probeSession，绝不使用折叠后的 hasSession view。
   *   present / absent        → 返回给 verb 执行；按 OPR.0.5.4.2，absent 是正向 tmux evidence。
   *   transport_unavailable   → INDETERMINATE refusal：未确定 session 是否存在，所以两个 verb
   *                             都不能执行；该拒绝绝不把操作员引向破坏性 verb。
   *   unexpected probe throw  → 同样返回无法确定的拒绝（fail closed）。
   */
  private async probeLiveness(
    sessionName: string,
    refusalConsequence: string,
  ): Promise<{ state: "present" | "absent" } | SeatRefusal> {
    let probe: SessionProbe;
    try {
      probe = await this.tmuxAdapter.probeSession(sessionName);
    } catch (err) {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `对 "${sessionName}" 的 tmux liveness 探测失败（${err instanceof Error ? err.message : String(err)}）；liveness 为 INDETERMINATE，因此${refusalConsequence}。`,
      };
    }
    if (probe.state === "transport_unavailable") {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `探测 "${sessionName}" 时 tmux transport 不可用（${probe.cause}）；未能确定 session 是否存在（已检查 classified tmux probe），因此${refusalConsequence}。请在 tmux transport 恢复后重试。`,
      };
    }
    return { state: probe.state };
  }

  private requireReason(reason: string): SeatRefusal | null {
    if (!reason?.trim()) {
      return { ok: false, code: "missing_reason", message: "必须提供 audit reason（--reason）。" };
    }
    return null;
  }

  private describe(resolved: ResolvedSeat): SeatDescriptor {
    return {
      rigId: resolved.entry.rigId,
      rigName: resolved.entry.rigName,
      logicalId: resolved.entry.logicalId,
      nodeId: resolved.nodeId,
    };
  }

  private latestSession(nodeId: string): LatestSessionRow | null {
    const row = this.db.prepare(
      "SELECT id, session_name, status, origin FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1",
    ).get(nodeId) as LatestSessionRow | undefined;
    return row ?? null;
  }

  /** 唯一解析路径，镜像 SeatStatusService.findMatches（seat-status-service.ts）语义，使每个
   *  seat verb 的解析完全一致：canonical `name@rig` ref 限定到该工作组 inventory；裸 ref
   *  扫描全部工作组；按 canonicalSessionName 或 logicalId 匹配；超过一个 match 时列出歧义，
   *  绝不擅自选择。 */
  private resolveSeat(seatRef: string): ResolvedSeat | SeatRefusal {
    const ref = seatRef?.trim() ?? "";
    if (!ref) {
      return { ok: false, code: "seat_ref_required", message: "必须提供席位引用", guidance: SEAT_LOOKUP_GUIDANCE };
    }

    const matches = this.findMatches(ref);
    if (matches.length === 0) {
      return {
        ok: false,
        code: "seat_not_found",
        message: `未找到席位 "${ref}"（已在${parseSessionName(ref).kind === "canonical" ? "指定工作组" : "所有工作组"}中检查 canonical session name 与 logical id）。`,
        guidance: SEAT_LOOKUP_GUIDANCE,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: "seat_ambiguous",
        message: `席位 "${ref}" 匹配到多个节点`,
        guidance: SEAT_LOOKUP_GUIDANCE,
        matches: matches.map((entry) => ({
          rig_name: entry.rigName,
          logical_id: entry.logicalId,
          current_occupant: entry.canonicalSessionName,
        })),
      };
    }

    const entry = matches[0]!;
    const nodeRow = this.db.prepare(
      "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?",
    ).get(entry.rigId, entry.logicalId) as { id: string } | undefined;
    if (!nodeRow) {
      return { ok: false, code: "seat_not_found", message: `席位 "${ref}" 解析到一个已不存在的节点。`, guidance: SEAT_LOOKUP_GUIDANCE };
    }
    return { entry, nodeId: nodeRow.id };
  }

  private findMatches(ref: string): NodeInventoryEntry[] {
    const parsed = parseSessionName(ref);
    if (parsed.kind === "canonical") {
      const localRef = parsed.member;
      const rigs = this.rigRepo.findRigsByName(parsed.rig);
      return rigs.flatMap((rig) => getNodeInventory(this.db, rig.id).filter((entry) =>
        entry.canonicalSessionName === ref
        || deriveCanonicalFromEntry(entry) === ref
        || entry.logicalId === localRef,
      ));
    }
    return this.rigRepo.listRigs().flatMap((rig) =>
      getNodeInventory(this.db, rig.id).filter((entry) =>
        entry.canonicalSessionName === ref || entry.logicalId === ref,
      ),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings<T extends string>(value: Record<string, unknown>, keys: readonly T[]): value is Record<T, string> & Record<string, unknown> {
  return keys.every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

function isProjectionCategory(value: unknown): value is ProjectionEntry["category"] {
  return isOneOf(value, ["skill", "guidance", "subagent", "plugin", "runtime_resource"] as const);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isOptionalOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T | undefined {
  return value === undefined || isOneOf(value, allowed);
}

function isStringArrayOf<T extends string>(value: unknown, allowed: readonly T[]): value is T[] {
  return Array.isArray(value) && value.every((entry) => isOneOf(entry, allowed));
}
