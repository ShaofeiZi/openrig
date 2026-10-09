// OPR.0.3.4.10——席位待关注 reconciler：依据 evidence 清除卡住的
// startup_status=attention_required。使用托管 writer + append-only audit。

import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { AgentActivity, SeatIdentityVerdict } from "./types.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { classifyPaneRuntimeMatch } from "./seat-identity-reconciler.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { defaultListProcesses } from "./resume-metadata-refresher.js";
import { verifyCodexPaneProcess, type NativeProcessRow, type NativeProcessLister, findExactNativeResumeProcess } from "./native-process-lineage.js";

type PaneIdentityTmux = Pick<TmuxAdapter, "listPanes" | "getPanePid" | "getPaneCommand">;
type ProcessRow = NativeProcessRow;

export type PaneIdentityReconcileResult =
  | { ok: true; pane: string; pid: number; command: string | null }
  | { ok: false; detail: string };

/** 把一个托管席位重新绑定到其具名 tmux session 当前唯一的 pane，并正向识别其声明的
 * 智能体运行时。 */
export async function rebindAndVerifyPaneIdentity(input: {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  tmux: PaneIdentityTmux;
  nodeId: string;
  sessionName: string;
  runtime: string | null;
  expectedResumeToken?: string | null;
  requireExactResumeLineage?: boolean;
  listProcesses?: NativeProcessLister;
  now?: () => Date;
}): Promise<PaneIdentityReconcileResult> {
  const observedAt = (input.now ?? (() => new Date()))().toISOString();
  const identityStore = new SeatIdentityStore(input.db);
  let panes: Awaited<ReturnType<PaneIdentityTmux["listPanes"]>>;
  try {
    panes = await input.tmux.listPanes(input.sessionName);
  } catch (error) {
    return { ok: false, detail: `查询 tmux pane 失败：${(error as Error).message}` };
  }
  if (panes.length !== 1) {
    const registeredPane = input.sessionRegistry.getBindingForNode(input.nodeId)?.tmuxPane ?? null;
    identityStore.upsert({
      nodeId: input.nodeId,
      verdict: panes.length === 0 ? "pane_missing" : "mismatch",
      evidenceSource: "tmux_session",
      reason: panes.length === 0 ? "session_missing" : "pane_ambiguous",
      evidence: { registeredPane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: input.sessionName,
      observedAt,
    });
    return {
      ok: false,
      detail: panes.length === 0
        ? `tmux session '${input.sessionName}' 没有可 attach 的 pane`
        : `tmux session '${input.sessionName}' 有 ${panes.length} 个 pane；无法确定席位对应的准确 pane`,
    };
  }

  const pane = panes[0]!;
  let pid: number | null;
  let command: string | null;
  try {
    pid = await input.tmux.getPanePid(pane.id);
    command = await input.tmux.getPaneCommand(pane.id);
  } catch (error) {
    return { ok: false, detail: `查询 tmux pane identity 失败：${(error as Error).message}` };
  }
  let runtimeMatch = classifyPaneRuntimeMatch(command, input.runtime);
  const normalizedCommand = command?.trim().toLowerCase() ?? "";
  let lineageMatch: ProcessRow | null = null;
  const expectedResumeToken = input.expectedResumeToken ?? null;
  const strictNativeLineage = input.requireExactResumeLineage === true
    && expectedResumeToken !== null
    && (input.runtime === "claude-code" || input.runtime === "codex");
  if (input.runtime === "codex") {
    // shell/Node label 描述的是 wrapper，而不是 native occupant。
    runtimeMatch = "match";
    const native = await verifyCodexPaneProcess({ target: pane.id, tmux: input.tmux,
      listProcesses: input.listProcesses, expectedToken: expectedResumeToken,
      requireResume: input.requireExactResumeLineage === true });
    const currentPanes = await input.tmux.listPanes(input.sessionName).catch(() => []);
    if (native?.panePid === pid && currentPanes.length === 1 && currentPanes[0]?.id === pane.id) lineageMatch = native.process;
  } else if (pid !== null && runtimeMatch === "match" && strictNativeLineage) {
    try {
      lineageMatch = findExactNativeResumeProcess(
        await (input.listProcesses ?? defaultListProcesses)(),
        pid,
        input.runtime,
        expectedResumeToken!,
      );
    } catch {
      // 缺少 process evidence 表示歧义，绝不能当成正向 identity。
    }
  }
  const runtimeAmbiguous = input.runtime === "codex" ? lineageMatch === null : runtimeMatch === "match" && (strictNativeLineage
    ? lineageMatch === null
    : input.runtime === "claude-code" && !normalizedCommand.includes("claude"));
  const verdict: SeatIdentityVerdict = {
    nodeId: input.nodeId,
    verdict: pid === null
      ? "pane_missing"
      : runtimeMatch === "mismatch" || runtimeAmbiguous
        ? "mismatch"
        : "verified",
    evidenceSource: "pane_process",
    reason: pid === null
      ? "pane_pid_gone"
      : runtimeMatch === "mismatch"
        ? "process_identity_mismatch"
        : runtimeAmbiguous
          ? "process_identity_ambiguous"
        : null,
    evidence: {
      registeredPane: pane.id,
      observedPid: lineageMatch?.pid ?? pid,
      observedCommand: lineageMatch?.command ?? command,
      matchedLayer: pid === null || runtimeAmbiguous ? null : 1,
    },
    sessionName: input.sessionName,
    observedAt,
  };

  // 在 verdict 前持久化替换后的 pane，使两条 record 描述同一个当前 binding。非 green verdict
  // 仍然适用，因此公开 topology 保持 attention_required。
  input.sessionRegistry.updateBinding(input.nodeId, {
    tmuxSession: input.sessionName,
    tmuxPane: pane.id,
  });
  identityStore.upsert(verdict);

  if (verdict.verdict === "pane_missing") {
    return { ok: false, detail: `tmux pane '${pane.id}' 没有存活进程` };
  }
  if (verdict.verdict === "mismatch") {
    if (runtimeAmbiguous) {
      return {
        ok: false,
        detail: `tmux pane '${pane.id}' 的前台命令 '${command ?? "unknown"}' 无法正向识别 runtime '${input.runtime}'`,
      };
    }
    return {
      ok: false,
      detail: `tmux pane '${pane.id}' 的前台命令 '${command ?? "unknown"}' 与 runtime '${input.runtime ?? "unknown"}' 矛盾`,
    };
  }
  return { ok: true, pane: pane.id, pid: pid!, command };
}

export interface ClearAttentionResult {
  ok: boolean;
  code?: "not_in_attention" | "not_demonstrably_responsive" | "cleared";
  from?: string;
  to?: string;
  clearedBy?: "evidence" | "operator_attestation";
  evidence?: { kind: string; state?: string; reason?: string };
  reason?: string;
  detail?: string;
  previousError?: string | null;
  clearedClasses?: ("startup_status" | "restore_outcome" | "pane_identity")[];
  derivedEvidence?: {
    source: string;
    kind?: string;
    state?: string;
    reason?: string;
    runtimeCwdVerified?: boolean;
    attemptId?: number;
    tmux?: boolean;
    fgProcess?: string;
    resumeTokenUsed?: boolean;
    paneState?: "usable";
  };
}

export interface SendVerifyFn {
  (sessionName: string, text: string, opts?: { verify?: boolean }): Promise<{ ok: boolean; outcome?: string; verified?: boolean }>;
}

export interface CaptureFn {
  (sessionName: string, opts?: { lines?: number }): Promise<{ ok: boolean; sessionName: string; content?: string; error?: string }>;
}

interface ClearAttentionDeps {
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  agentActivityStore: AgentActivityStore;
  sendVerify?: SendVerifyFn;
  capture?: CaptureFn;
  db?: Database.Database;
  tmux?: PaneIdentityTmux;
  reconcileRestoreOutcome?: (rigId: string, nodeId: string) => Promise<
    | {
        ok: true;
        attemptId: number;
        from: "failed" | "attention_required";
        to: "operator_recovered";
        evidence: { tmux: boolean; fgProcess: string; resumeTokenUsed: boolean; paneState: "usable" };
      }
    | { ok: false; code: string; detail: string }
  >;
}

const POSITIVE_STATES = new Set(["running", "idle"]);
type DerivedAttentionOutcome = {
  status: "failed" | "attention_required";
  source: "restore.completed" | "restore.subset_completed";
};

export class SeatAttentionReconciler {
  private deps: ClearAttentionDeps;

  constructor(deps: ClearAttentionDeps) {
    this.deps = deps;
  }

  async clearAttention(
    sessionName: string,
    opts?: { reason?: string },
  ): Promise<ClearAttentionResult> {
    const { sessionRegistry, eventBus, agentActivityStore } = this.deps;

    // 解析 session → node + 当前 startup_status。
    const session = this.findLatestSessionByName(sessionName);
    if (!session) {
      return { ok: false, code: "not_in_attention", detail: `未找到会话 '${sessionName}'` };
    }

    const startupClassActive = session.startupStatus === "attention_required" || session.startupStatus === "failed";
    const derivedOutcome = this.getDerivedAttentionOutcome(session);
    const identityClassActive = this.getActiveIdentityVerdict(session, sessionName);

    if (!startupClassActive && !derivedOutcome && !identityClassActive) {
      return { ok: false, code: "not_in_attention", detail: `会话 startup_status 为 '${session.startupStatus}'，restoreOutcome 不是 attention/failed，pane identity 也不是 mismatched/missing，因此不在待关注状态` };
    }

    const previousError = session.latestError ?? null;

    // 完整恢复 outcome 属于一次不可变 attempt。通用 activity、send verification 与 operator
    // attestation 无法证明该 lineage；委托给 restore owner，由其检查精确 native resume token
    // 并追加 attempt-scoped reconciliation event。subset restore 没有 restore.started receipt，
    // 继续使用既有路径。
    if (derivedOutcome?.source === "restore.completed") {
      const reconcile = this.deps.reconcileRestoreOutcome;
      if (!reconcile) {
        return {
          ok: false,
          code: "not_demonstrably_responsive",
          detail: "未清除待关注类别 restore_outcome：strict restore reconciler 不可用",
        };
      }
      const restored = await reconcile(session.rigId, session.nodeId);
      if (!restored.ok) {
        return {
          ok: false,
          code: "not_demonstrably_responsive",
          detail: `未清除待关注类别 restore_outcome：${restored.code}：${restored.detail}`,
        };
      }

      const evidence = { kind: "strict_restore_runtime_truth", state: "operator_recovered" };
      const clearedClasses: ("startup_status" | "restore_outcome" | "pane_identity")[] = ["restore_outcome"];
      if (identityClassActive) clearedClasses.push("pane_identity");
      if (startupClassActive) {
        sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
        eventBus.emit({
          type: "seat.attention_cleared",
          rigId: session.rigId,
          nodeId: session.nodeId,
          sessionName,
          from: session.startupStatus,
          to: "ready",
          clearedBy: "evidence",
          evidence,
          previousError,
        });
        clearedClasses.push("startup_status");
      }
      return {
        ok: true,
        code: "cleared",
        from: session.startupStatus,
        to: "ready",
        clearedBy: "evidence",
        evidence,
        previousError,
        clearedClasses,
        derivedEvidence: {
          source: "restore_runtime_truth",
          attemptId: restored.attemptId,
          ...restored.evidence,
        },
      };
    }

    // 只有把当前 session 重新解析到一个具体存活 pane，才能清除 pane-identity 类别。同一份 proof
    // 足以清除并存的历史 startup/restore attention 类别。
    if (identityClassActive) {
      if (!this.deps.db || !this.deps.tmux) {
        return {
          ok: false,
          code: "not_demonstrably_responsive",
          detail: "未清除待关注类别 pane_identity：tmux identity verifier 不可用",
        };
      }
      const identity = await rebindAndVerifyPaneIdentity({
        db: this.deps.db,
        sessionRegistry,
        tmux: this.deps.tmux,
        nodeId: session.nodeId,
        sessionName,
        runtime: session.runtime,
      });
      if (!identity.ok) {
        return {
          ok: false,
          code: "not_demonstrably_responsive",
          detail: `未清除待关注类别 pane_identity：${identity.detail}`,
        };
      }
      return this.performEvidenceClear(
        session,
        sessionName,
        startupClassActive,
        derivedOutcome?.source === "restore.subset_completed" ? derivedOutcome.status : null,
        { kind: "pane_identity_reverified", state: identity.pane },
        previousError,
        true,
      );
    }

    // 操作员 attestation 覆盖（--reason）。
    if (opts?.reason) {
      const clearedClasses: ("startup_status" | "restore_outcome" | "pane_identity")[] = [];
      if (startupClassActive) {
        sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
        eventBus.emit({
          type: "seat.attention_cleared",
          rigId: session.rigId,
          nodeId: session.nodeId,
          sessionName,
          from: session.startupStatus,
          to: "ready",
          clearedBy: "operator_attestation",
          reason: opts.reason,
          previousError,
        });
        clearedClasses.push("startup_status");
      }
      if (derivedOutcome?.source === "restore.subset_completed") {
        eventBus.emit({
          type: "restore.outcome_reconciled",
          rigId: session.rigId,
          nodeId: session.nodeId,
          attemptId: 0,
          from: derivedOutcome.status,
          to: "operator_recovered",
          evidence: { source: "operator_attestation", reason: opts.reason, runtimeCwdVerified: false },
        });
        clearedClasses.push("restore_outcome");
      }
      return {
        ok: true,
        code: "cleared",
        from: session.startupStatus,
        to: "ready",
        clearedBy: "operator_attestation",
        reason: opts.reason,
        previousError,
        clearedClasses,
        derivedEvidence: derivedOutcome?.source === "restore.subset_completed"
          ? { source: "operator_attestation", reason: opts.reason, runtimeCwdVerified: false }
          : undefined,
      };
    }

    // 依据 evidence 执行清除。
    const activity = agentActivityStore.getLatestForNode({
      nodeId: session.nodeId,
      sessionName,
    });

    if (activity && activity.stale !== true && POSITIVE_STATES.has(activity.state)) {
      const evidence = { kind: "fresh_activity", state: activity.state, reason: activity.reason };
      return this.performEvidenceClear(
        session,
        sessionName,
        startupClassActive,
        derivedOutcome?.source === "restore.subset_completed" ? derivedOutcome.status : null,
        evidence,
        previousError,
      );
    }

    // 第二条 evidence 路径：主动 send-verify 往返。
    if (this.deps.sendVerify) {
      try {
        const probeText = `# OpenRig attention-clear liveness probe ${Date.now()}`;
        const sendResult = await this.deps.sendVerify(sessionName, probeText, { verify: true });
        if (sendResult.ok && (sendResult.outcome === "delivered" || sendResult.verified === true)) {
          const evidence = { kind: "send_verify_roundtrip", state: sendResult.outcome ?? "delivered" };
          return this.performEvidenceClear(
            session,
            sessionName,
            startupClassActive,
            derivedOutcome?.source === "restore.subset_completed" ? derivedOutcome.status : null,
            evidence,
            previousError,
          );
        }

        if (sendResult.ok && sendResult.outcome === "rendered-unconfirmed" && this.deps.capture) {
          try {
            const captureResult = await this.deps.capture(sessionName, { lines: 50 });
            if (captureResult.ok && captureResult.content && captureResult.content.includes(probeText)) {
              const evidence = { kind: "send_verify_capture_confirmed", state: "rendered-unconfirmed" };
              return this.performEvidenceClear(
                session,
                sessionName,
                startupClassActive,
                derivedOutcome?.source === "restore.subset_completed" ? derivedOutcome.status : null,
                evidence,
                previousError,
              );
            }
          } catch { /* Capture failed */ }
        }
      } catch { /* Send failed */ }
    }

    return {
      ok: false,
      code: "not_demonstrably_responsive",
      detail: activity
        ? `最近 activity：state='${activity.state}'，stale=${activity.stale ?? false}，reason='${activity.reason}'——不是正向 evidence；send-verify 也未确认`
        : "未找到近期智能体 activity；send-verify 也未确认",
    };
  }

  private performEvidenceClear(
    session: { id: string; nodeId: string; rigId: string; startupStatus: string },
    sessionName: string,
    startupClassActive: boolean,
    subsetOutcome: "failed" | "attention_required" | null,
    evidence: { kind: string; state?: string; reason?: string },
    previousError: string | null,
    identityClassCleared = false,
  ): ClearAttentionResult {
    const { sessionRegistry, eventBus } = this.deps;
    const clearedClasses: ("startup_status" | "restore_outcome" | "pane_identity")[] = [];

    if (identityClassCleared) clearedClasses.push("pane_identity");

    if (startupClassActive) {
      sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
      eventBus.emit({
        type: "seat.attention_cleared",
        rigId: session.rigId,
        nodeId: session.nodeId,
        sessionName,
        from: session.startupStatus,
        to: "ready",
        clearedBy: "evidence",
        evidence,
        previousError,
      });
      clearedClasses.push("startup_status");
    }

    if (subsetOutcome) {
      eventBus.emit({
        type: "restore.outcome_reconciled",
        rigId: session.rigId,
        nodeId: session.nodeId,
        attemptId: 0,
        from: subsetOutcome,
        to: "operator_recovered",
        evidence: { source: "clear_attention_evidence", kind: evidence.kind, state: evidence.state, runtimeCwdVerified: false },
      });
      clearedClasses.push("restore_outcome");
    }

    return {
      ok: true,
      code: "cleared",
      from: session.startupStatus,
      to: "ready",
      clearedBy: "evidence",
      evidence,
      previousError,
      clearedClasses,
      derivedEvidence: subsetOutcome
        ? { source: "clear_attention_evidence", kind: evidence.kind, state: evidence.state, runtimeCwdVerified: false }
        : undefined,
    };
  }

  private findLatestSessionByName(sessionName: string): {
    id: string;
    nodeId: string;
    rigId: string;
    startupStatus: string;
    sessionStatus: string;
    runtime: string | null;
    bindingPane: string | null;
    latestError: string | null;
  } | null {
    const row = this.deps.sessionRegistry.db.prepare(
      `SELECT s.id, s.node_id, n.rig_id, n.runtime, b.tmux_pane, s.startup_status, s.status,
              (SELECT e.payload FROM events e WHERE e.node_id = s.node_id AND e.type IN ('node.startup_attention_required','node.startup_failed') ORDER BY e.seq DESC LIMIT 1) as latest_error_payload
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
       LEFT JOIN bindings b ON b.node_id = s.node_id
       WHERE s.session_name = ?
       ORDER BY s.created_at DESC, s.id DESC LIMIT 1`
    ).get(sessionName) as {
      id: string;
      node_id: string;
      rig_id: string;
      startup_status: string;
      status: string;
      runtime: string | null;
      tmux_pane: string | null;
      latest_error_payload: string | null;
    } | undefined;

    if (!row) return null;

    let latestError: string | null = null;
    if (row.latest_error_payload) {
      try {
        const parsed = JSON.parse(row.latest_error_payload);
        latestError = parsed.error ?? parsed.message ?? row.latest_error_payload;
      } catch {
        latestError = row.latest_error_payload;
      }
    }

    return {
      id: row.id,
      nodeId: row.node_id,
      rigId: row.rig_id,
      startupStatus: row.startup_status ?? "pending",
      sessionStatus: row.status ?? "unknown",
      runtime: row.runtime,
      bindingPane: row.tmux_pane,
      latestError,
    };
  }

  private getActiveIdentityVerdict(session: {
    nodeId: string;
    sessionStatus: string;
    bindingPane: string | null;
  }, sessionName: string): SeatIdentityVerdict | null {
    if (!this.deps.db || session.sessionStatus !== "running") return null;
    const verdict = new SeatIdentityStore(this.deps.db).getForNode(session.nodeId);
    if (!verdict) return null;
    if (verdict.sessionName !== sessionName) return null;
    if (verdict.evidence.registeredPane !== session.bindingPane) return null;
    return verdict.verdict === "mismatch" || verdict.verdict === "pane_missing" ? verdict : null;
  }

  private getDerivedAttentionOutcome(session: { nodeId: string; rigId: string; sessionStatus: string }): DerivedAttentionOutcome | null {
    if (!this.deps.db) return null;

    const rows = this.deps.db.prepare(
      "SELECT type, payload FROM events WHERE rig_id = ? AND type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled') ORDER BY seq DESC"
    ).all(session.rigId) as { type: string; payload: string }[];

    let sawLegacyReconciliation = false;
    for (const row of rows) {
      try {
        if (row.type === "restore.outcome_reconciled") {
          const ev = JSON.parse(row.payload) as { nodeId: string; attemptId?: number; to: "operator_recovered" };
          if (ev.nodeId !== session.nodeId) continue;
          // restore receipt 引入前，whole/subset clear 都使用无 scope 的 attemptId 0。它对 subset
          // 仍是终态，但不能结算仍需证明精确 attempt 的 whole restore。
          if (ev.attemptId === 0) {
            sawLegacyReconciliation = true;
            continue;
          }
          return null;
        }
        const ev = JSON.parse(row.payload) as { result: { nodes: Array<{ nodeId: string; status: string }> } };
        const n = ev.result.nodes.find((nd) => nd.nodeId === session.nodeId);
        if (!n) continue;
        if (sawLegacyReconciliation && row.type === "restore.subset_completed") return null;
        // 镜像 deriveNodeLifecycleState：无论 sessionStatus 如何都保留 attention_required；
        // 只有 sessionStatus=running 时才保留 failed。
        const source = row.type as DerivedAttentionOutcome["source"];
        if (n.status === "attention_required") return { status: "attention_required", source };
        if (n.status === "failed" && session.sessionStatus === "running") return { status: "failed", source };
        return null;
      } catch { continue; }
    }
    return null;
  }
}
