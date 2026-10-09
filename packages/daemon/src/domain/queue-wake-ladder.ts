import { findQueueRecovery, recoveryTag } from "./queue-recovery.js";
import { lastMeaningfulTransition, type WaitingView } from "./queue-waiting.js";
// S01（OPR.0.5.5.1）——唤醒或升级 baton。wake 失败的 handoff 绝不能静默停放：此前只记录一次
// failed nudge，之后再无动作（实测 0.5.3 主要 failure class——packet 完好保留，recipient 却从未唤醒）。
// 本模块为每个 wake 失败的 baton（handed-off row）提供有界 retry ladder，随后是具名 escalation rung——
// destination 的 orchestrator（按 destination 聚合，绝不每个 baton 重复一行），再到 operator surface——
// 每一步都记录 transition，无一步静默。
//
// 具名不变量（mini-req 7）：ROW 恰好一次地承载 obligation；WAKE 至少一次。ladder 重试的是 NUDGE——
// 指向 row 的 envelope pointer——绝不是 content，因此再次尝试绝不会重复投递 obligation。
//
// AM-P3-F6：transition 就是 ladder state。attempt、rung、suspension 与 exhaustion 全是 row
// transition log 上的 marker，每次 tick 都从中派生位置——daemon restart 既不能忘记 ladder（静默 park
// 再现），也不能重置计数（重复导致超出 cap）。Marker vocabulary 从 queue-stuck-sweep import
//（AM-P3-F5）：S02 的 undelivered 部分跳过 ladder 为 live 的 row，并继续兜底 exhausted handback；
// created-with-destination obligation 仍属于 S02（这里的 baton filter 是 handed_off_from——明确指出
// 该空缺）。
//
// AM-P3-F1：`rendered-unconfirmed` 类 outcome（queue grammar：delivered-ack-pending、
// indeterminate:*、gateway-owned:*）绝不重试——这是实测 false-negative 类别——但它们会通过
// confirmation path 进入 ladder：unconfirmed + config 指定 window 内零 pickup evidence 时直接
// escalate，完全跳过 retry rung（escalation 不是重发，不能重复投递）。
//
// AM-P3-F2：suspension 是派生而非声明——destination 的 post-swap state（nodes.handover_at 位于
// 有界 grace 内；handover transaction 本身原子且不可观测）暂停 wake attempt，并记录 suspend/resume。
// 手工声明 window 只作为 operator override 保留（OPENRIG_WAKE_SUSPEND，每次 fresh read）。
//
// AM-P3-F4 + AM-R25：rung 会投递，而非只记录。orchestrator rung 在聚合 escalation row 上尝试真实
// wake；自身 wake 失败的 rung 在一个有界 cycle 后推进。OPR.0.5.6.1（A1.2/AM-F3）：operator rung
// 的 delivery leg 就是 delivery rules engine——rung 经注入 engine port dispatch，记录带 decision 的
// dispatched-to-engine；在 engine outcome resolve（posted receipt 或 delivery-termination record）前，
// ladder 不会越过该 rung；每个 episode 恰好一次 delivery，绝不 immediate-plus-deferred。未接入 engine
// port（fixture、接线前 boot）时，rung 如实保留 pre-engine floor（escalation view + daemon-health），
// 并像以前一样 exhaust。

import type Database from "better-sqlite3";
import type { QueueItem, QueueRepository } from "./queue-repository.js";
import { deriveUsageLimitPools, type UsageLimitPool } from "./provider/provider-signals.js";
import type { FourBlockReadModel } from "./provider/provider-types.js";
import {
  USAGE_LIMIT_BLOCKER_TAG,
  USAGE_LIMIT_POOL_TAG_PREFIX,
} from "./queue-wake-repository.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import {
  LADDER_ATTEMPT_PREFIX,
  LADDER_RUNG_PREFIX,
  LADDER_EXHAUSTED_PREFIX,
  defaultResolveOrchestrator,
  resolveSessionNodeId,
} from "./queue-stuck-sweep.js";

export const WAKE_RETRY_INTERVAL_KEY = "queue.wake_retry_interval_seconds";
export const DEFAULT_WAKE_RETRY_INTERVAL_SECONDS = 300;
export const WAKE_RETRY_CAP_KEY = "queue.wake_retry_cap";
export const DEFAULT_WAKE_RETRY_CAP = 3;
export const WAKE_UNCONFIRMED_WINDOW_KEY = "queue.wake_unconfirmed_window_minutes";
export const DEFAULT_WAKE_UNCONFIRMED_WINDOW_MINUTES = 30;
export const WAKE_SWAP_GRACE_KEY = "queue.wake_swap_grace_seconds";
export const DEFAULT_WAKE_SWAP_GRACE_SECONDS = 180;

// S16：此 margin 吸收 provider reset 粒度与 host/provider clock skew。Fleet dedup 已防止
// thundering herd；将其缩小到接近零会重现 seat 仍受 usage limit 时就投递 wake 的问题。
export const USAGE_LIMIT_JITTER_FLOOR_SECONDS = 30;
export const USAGE_LIMIT_JITTER_CEILING_SECONDS = 90;
export function drawUsageLimitJitterSeconds(random: () => number = Math.random): number {
  return USAGE_LIMIT_JITTER_FLOOR_SECONDS + Math.floor(
    random() * (USAGE_LIMIT_JITTER_CEILING_SECONDS - USAGE_LIMIT_JITTER_FLOOR_SECONDS + 1),
  );
}

/** operator 声明的 suspension override（F2：override，绝不是机制）。格式：逗号分隔的
 *  `<session>:<untilIso>` pair；每个 tick fresh read。 */
export const WAKE_SUSPEND_OVERRIDE_ENV = "OPENRIG_WAKE_SUSPEND";

/** 每个 destination 聚合 escalation row 上的 stamp tag。 */
export const WAKE_ESCALATION_TAG = "wake-escalation";
export function escalationDedupTag(destination: string): string {
  return `wake-escalation:${destination}`;
}

// Suspension marker（attempt/rung/exhausted 来自 S02 接缝 vocabulary）。
export const LADDER_SUSPEND_PREFIX = "ladder-suspend:";
export const LADDER_RESUME_PREFIX = "ladder-resume:";

const LADDER_ACTOR = "wake-ladder@system";

export interface WakeLadderStatusSnapshot {
  lastTickAt: string | null;
  lastOutcome: "clean" | "actions" | "failed" | null;
  lastError: string | null;
  consecutiveFailures: number;
  activeLadders: number;
  escalationsOpen: number;
  exhaustedTotal: number;
}

export interface WakeLadderStatus {
  record(outcome: "clean" | "actions" | "failed", detail?: { error?: string; active?: number; escalations?: number; exhausted?: number }): void;
  snapshot(): WakeLadderStatusSnapshot;
}

/** loop 的可观测 heartbeat——与 S02 sweep 一起进入 /healthz。 */
export function createWakeLadderStatus(): WakeLadderStatus {
  const state: WakeLadderStatusSnapshot = {
    lastTickAt: null,
    lastOutcome: null,
    lastError: null,
    consecutiveFailures: 0,
    activeLadders: 0,
    escalationsOpen: 0,
    exhaustedTotal: 0,
  };
  return {
    record(outcome, detail) {
      state.lastTickAt = new Date().toISOString();
      state.lastOutcome = outcome;
      state.lastError = outcome === "failed" ? (detail?.error ?? "未知错误") : null;
      state.consecutiveFailures = outcome === "failed" ? state.consecutiveFailures + 1 : 0;
      if (detail?.active !== undefined) state.activeLadders = detail.active;
      if (detail?.escalations !== undefined) state.escalationsOpen = detail.escalations;
      if (detail?.exhausted) state.exhaustedTotal += detail.exhausted;
    },
    snapshot() {
      return { ...state };
    },
  };
}

/** self-skip floor 的 operator seat（workspace.operator_seat_name——约定的
 *  `operator-${USER}@kernel`）；settings 解析失败时为 null。 */
function resolveOperatorSeat(): string | null {
  try {
    const v = new SettingsStore().resolveOne("workspace.operator_seat_name" as never).value;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function resolveNumber(key: string, fallback: number): number {
  try {
    const v = new SettingsStore().resolveOne(key as never).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export const resolveWakeRetryIntervalSeconds = (): number =>
  resolveNumber(WAKE_RETRY_INTERVAL_KEY, DEFAULT_WAKE_RETRY_INTERVAL_SECONDS);
export const resolveWakeRetryCap = (): number => resolveNumber(WAKE_RETRY_CAP_KEY, DEFAULT_WAKE_RETRY_CAP);
export const resolveWakeUnconfirmedWindowMinutes = (): number =>
  resolveNumber(WAKE_UNCONFIRMED_WINDOW_KEY, DEFAULT_WAKE_UNCONFIRMED_WINDOW_MINUTES);
export const resolveWakeSwapGraceSeconds = (): number =>
  resolveNumber(WAKE_SWAP_GRACE_KEY, DEFAULT_WAKE_SWAP_GRACE_SECONDS);

export interface WakeLadderDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  status?: WakeLadderStatus;
  /** 尝试为 `qitemId` wake `target`；以 queue nudge grammar 返回 outcome
   *  （verified | delivered-ack-pending | indeterminate:* | failed:*）。默认走 maybeNudge——wake
   *  是 envelope pointer，绝不是 content。 */
  attemptWake?: (qitemId: string, target: string) => Promise<string>;
  resolveOrchestrator?: (session: string) => string | null;
  retryIntervalSeconds?: number;
  retryCap?: number;
  unconfirmedWindowMinutes?: number;
  swapGraceSeconds?: number;
  /** 由 daemon 注入的已发布 provider telemetry。缺失/读取失败时，每条 pre-S16 ladder 路径保持
   *  字节级一致。 */
  getProviderReadModel?: () => Promise<Pick<FourBlockReadModel, "signals" | "bindings">>;
  usageLimitJitterSeconds?: number;
  now?: Date;
  log?: (line: string) => void;
  /** OPR.0.5.6.1——operator rung 的 delivery leg。dispatchEscalation 通过 rules engine 投递
   *  （或 defer），并报告 outcome 是否同步 resolve；缺失 = pre-engine floor 行为。 */
  deliveryEngine?: {
    dispatchEscalation: (row: QueueItem, reason: string) => Promise<{ decision: string; resolved: boolean; notificationKey?: string }>;
  };
}

export interface WakeLadderAction {
  qitemId: string;
  action: "retry" | "escalate-orchestrator" | "escalate-operator" | "suspend" | "resume" | "exhaust" | "park-usage-limit";
  target?: string;
}

export interface WakeLadderTickResult {
  outcome: "clean" | "actions" | "failed";
  actions: WakeLadderAction[];
  error?: string;
}

interface MarkerRow {
  ts: string;
  transition_note: string | null;
}

interface LadderView {
  attempts: number;
  lastMarkerTs: number | null;
  orchRung: boolean;
  orchRungFailed: boolean;
  opRung: boolean;
  opEngineDispatched: boolean;
  opEngineKey: string | null;
  opOutcomeResolved: boolean;
  exhausted: boolean;
  suspendEpisodeOpen: boolean;
  firstMarkerTs: number | null;
}

function readLadder(db: Database.Database, qitemId: string): LadderView {
  const rows = db
    .prepare("SELECT ts, transition_note FROM queue_transitions WHERE qitem_id = ? AND transition_id > ? ORDER BY transition_id")
    .all(qitemId, lastMeaningfulTransition(db, qitemId)?.id ?? 0) as MarkerRow[];
  const view: LadderView = {
    attempts: 0,
    lastMarkerTs: null,
    orchRung: false,
    orchRungFailed: false,
    opRung: false,
    opEngineDispatched: false,
    opEngineKey: null,
    opOutcomeResolved: false,
    exhausted: false,
    suspendEpisodeOpen: false,
    firstMarkerTs: null,
  };
  let suspends = 0;
  let resumes = 0;
  for (const r of rows) {
    const note = r.transition_note ?? "";
    const isAttempt = note.startsWith(LADDER_ATTEMPT_PREFIX);
    const isRung = note.startsWith(LADDER_RUNG_PREFIX);
    if (isAttempt) view.attempts += 1;
    if (isRung && /^escalation-rung:\s*orchestrator/.test(note)) {
      view.orchRung = true;
      view.orchRungFailed = /outcome=failed:/.test(note);
    }
    if (isRung && /^escalation-rung:\s*operator/.test(note)) view.opRung = true;
    if (isRung && /^escalation-rung:\s*operator dispatched-to-engine/.test(note)) {
      view.opEngineDispatched = true;
      const keyMatch = note.match(/notification_key=(\S+)/);
      if (keyMatch) view.opEngineKey = keyMatch[1]!;
      // R2 003f4786：key 在任何 resolution note 生效前派生——早于此次 dispatch 的 receipt 属于旧
      // episode，因此在此丢弃此前看到的任何 provisional resolution。
      view.opOutcomeResolved = false;
    }
    // Outcome resolution（AM-F3、R1 B-3、R2 pre-marker discriminator）：S14 posted receipt 或
    // termination record 只有在以下条件下才关闭 episode：(a) 时间上晚于 dispatch marker（此 loop 在每次
    // dispatch 时重置 flag，因此 marker 前 note 不会残留）；(b) marker 带 key 时，它也携带已 dispatch key。
    // 无 key dispatch（注入的 legacy port）保持“任意后续 note”形态。
    if (note.startsWith("slack-owner-notification-posted ") || note.startsWith("delivery-termination:")) {
      if (view.opEngineKey === null || note.split(/\s+/).includes(`notification_key=${view.opEngineKey}`)) {
        view.opOutcomeResolved = true;
      }
    }
    if (note.startsWith(LADDER_EXHAUSTED_PREFIX)) view.exhausted = true;
    if (note.startsWith(LADDER_SUSPEND_PREFIX)) suspends += 1;
    if (note.startsWith(LADDER_RESUME_PREFIX)) resumes += 1;
    if (isAttempt || isRung) {
      const t = Date.parse(r.ts);
      if (!Number.isNaN(t)) {
        view.lastMarkerTs = Math.max(view.lastMarkerTs ?? t, t);
        view.firstMarkerTs = view.firstMarkerTs === null ? t : Math.min(view.firstMarkerTs, t);
      }
    }
  }
  view.suspendEpisodeOpen = suspends > resumes;
  return view;
}

/** Pickup evidence（S04 receipt join，F1）：claim、heartbeat，或任何既非 founding record 也非
 *  ladder machinery 的 transition——有真实主体采取了行动。 */
function hasPickupEvidence(db: Database.Database, row: Pick<QueueItem, "qitemId" | "claimedAt" | "lastHeartbeat">): boolean {
  if (row.claimedAt) return true;
  // 为知道 in-flight row 的 0.5.7 mechanized-pull turn-end hook 保留此 null 分支；
  // 它是首个诚实的 row-scoped writer，且只有该 slice 会重新开启接线。
  if (row.lastHeartbeat) return true;
  const rows = db
    .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?")
    .all(row.qitemId) as Array<{ transition_note: string | null }>;
  for (const r of rows) {
    const note = r.transition_note ?? "";
    if (note === "created") continue;
    if (note.startsWith("handoff")) continue;
    if (
      note.startsWith(LADDER_ATTEMPT_PREFIX) ||
      note.startsWith(LADDER_RUNG_PREFIX) ||
      note.startsWith(LADDER_EXHAUSTED_PREFIX) ||
      note.startsWith(LADDER_SUSPEND_PREFIX) ||
      note.startsWith(LADDER_RESUME_PREFIX) ||
      // OPR.0.5.6.1：delivery-leg record 是 ladder machinery，而非 pickup——receipt/termination/
      // deferral stamp 不得在 resolution pass 读取前将 row 移出 ladder。
      note.startsWith("slack-owner-notification-") ||
      note.startsWith("delivery-termination:") ||
      note.startsWith("delivery-deferral-")
    )
      continue;
    return true;
  }
  return false;
}

type WakeMode = "failed" | "unconfirmed";

function classifyWakeResult(lastNudgeResult: string | null): WakeMode | null {
  if (!lastNudgeResult) return null;
  if (lastNudgeResult.startsWith("failed:")) return "failed";
  if (
    lastNudgeResult === "delivered-ack-pending" ||
    lastNudgeResult.startsWith("indeterminate:") ||
    lastNudgeResult.startsWith("gateway-owned:")
  )
    return "unconfirmed";
  return null; // verified（或未知 vocabulary）——永不进入 ladder。
}

/** 另一 consumer 可能诊断同一 parked seat，但已有 delivery ladder/disposition 已拥有这些 obligation
 *  的下一次 wake。Diagnosis 保持可见；只抑制重复投递。 */
export function queueRecoveryOwnsWake(db: Database.Database, row: QueueItem | null): boolean {
  if (!row || !["pending", "in-progress", "blocked"].includes(row.state)) return false;
  if (findQueueRecovery(db, row.qitemId)) return true;
  const mode = classifyWakeResult(row.lastNudgeResult);
  if (!mode) return false;
  if (row.state === "pending" && !row.claimedAt && row.handedOffFrom) {
    return mode === "failed" || !hasPickupEvidence(db, row);
  }
  return row.state === "in-progress" && mode === "failed" && Boolean(db.prepare(
    "SELECT 1 FROM queue_transitions WHERE qitem_id = ? AND transition_note LIKE 'parked-owner wake delivery failed:%' LIMIT 1",
  ).get(row.qitemId));
}

/** F2——派生 suspension：destination 的 post-swap grace（nodes.handover_at 位于 bound 内），
 *  或 operator 声明的 override。返回 reason 或 null。 */
function readSuspension(
  db: Database.Database,
  destination: string,
  graceSeconds: number,
  now: Date,
): { reason: string; until: string } | null {
  const override = process.env[WAKE_SUSPEND_OVERRIDE_ENV];
  if (override) {
    for (const entry of override.split(",")) {
      const idx = entry.lastIndexOf(":");
      const session = entry.slice(0, entry.indexOf(":"));
      const untilIso = entry.slice(entry.indexOf(":") + 1);
      void idx;
      if (session === destination) {
        const until = Date.parse(untilIso);
        if (!Number.isNaN(until) && now.getTime() < until) {
          return { reason: `operator override（${WAKE_SUSPEND_OVERRIDE_ENV}）持续到 ${untilIso}`, until: untilIso };
        }
      }
    }
  }
  // 持久 session→node binding——绝不是 session name 的字符串转换（canonical dash-form session 与
  // dotted logical id 是独立 identity）。
  const nodeId = resolveSessionNodeId(db, destination);
  if (!nodeId) return null;
  const row = db
    .prepare("SELECT handover_at AS handoverAt FROM nodes WHERE id = ? LIMIT 1")
    .get(nodeId) as { handoverAt: string | null } | undefined;
  if (!row?.handoverAt) return null;
  const swapAt = Date.parse(row.handoverAt);
  if (Number.isNaN(swapAt)) return null;
  const ageS = (now.getTime() - swapAt) / 1000;
  if (ageS >= 0 && ageS < graceSeconds) {
    return { reason: `destination 处于 post-swap grace（${Math.round(ageS)} 秒前 handover，grace ${graceSeconds} 秒）`, until: new Date(swapAt + graceSeconds * 1000).toISOString() };
  }
  return null;
}

function suspensionReason(db: Database.Database, destination: string, graceSeconds: number, now: Date): string | null {
  return readSuspension(db, destination, graceSeconds, now)?.reason ?? null;
}

/** 读取已有 ladder 的下一 eligible action；绝不创建 intent、预留 retry、消费 provider state 或
 * 改变其 policy。scheduler 仍在 delivery 时做最终 live-state 决策。 */
export function readWakeLadderBackstop(db: Database.Database, qitemId: string): WaitingView["nextBackstop"] | null {
  const row = db.prepare(`SELECT qitem_id AS qitemId, state, source_session AS sourceSession,
    destination_session AS destinationSession, claimed_at AS claimedAt, handed_off_from AS handedOffFrom,
    last_heartbeat AS lastHeartbeat, last_nudge_result AS lastNudgeResult,
    last_nudge_attempt AS lastNudgeAttempt, ts_created AS tsCreated FROM queue_items WHERE qitem_id = ?`)
    .get(qitemId) as Pick<QueueItem, "qitemId" | "state" | "sourceSession" | "destinationSession" | "claimedAt" | "handedOffFrom" | "lastHeartbeat" | "lastNudgeResult" | "lastNudgeAttempt" | "tsCreated"> | undefined;
  if (!row || !["pending", "in-progress"].includes(row.state)) return null;
  const recovery = findQueueRecovery(db, qitemId);
  const disposition = recovery ? db.prepare("SELECT destination_session, tags FROM queue_items WHERE qitem_id = ?")
    .get(recovery.qitemId) as { destination_session: string; tags: string | null } : null;
  const recoveryBackstop = (): WaitingView["nextBackstop"] => ({
    owner: disposition!.destination_session, mechanism: `queue-recovery:${["pending", "in-progress", "blocked"].includes(recovery!.state) ? "delegated" : "resolved"}`,
    dueAt: null, intervalSeconds: null, recovery: { qitemId: recovery!.qitemId, state: recovery!.state },
    note: "当前 recovery disposition 拥有 continuation；请检查该 row。新的 source evidence 会重新评估。",
  });
  if (recovery && !["pending", "in-progress", "blocked"].includes(recovery.state)) return recoveryBackstop();
  const mode = classifyWakeResult(row.lastNudgeResult);
  const eligible = (row.state === "pending" && !row.claimedAt && row.handedOffFrom)
    || (row.state === "in-progress" && row.claimedAt && mode === "failed" && db.prepare(
      "SELECT 1 FROM queue_transitions WHERE qitem_id = ? AND transition_note LIKE 'parked-owner wake delivery failed:%' LIMIT 1",
    ).get(qitemId));
  if (!eligible || !mode || (mode === "unconfirmed" && hasPickupEvidence(db, row))) return recovery ? recoveryBackstop() : null;
  const ladder = readLadder(db, qitemId);
  if (ladder.exhausted) return recovery ? recoveryBackstop() : {
    owner: defaultResolveOrchestrator(db, row.destinationSession) ?? row.destinationSession,
    mechanism: "queue-wake-ladder:exhausted; queue-stuck-sweep:undelivered", dueAt: null, intervalSeconds: null,
    note: "不再进行 ladder retry。请检查保留的 exhaustion 与 delivery evidence；stuck sweep 是安全网。",
  };
  const interval = resolveWakeRetryIntervalSeconds(), cap = resolveWakeRetryCap(), now = new Date();
  const retry = mode === "failed" && ladder.attempts < cap;
  if (!retry && recovery && !JSON.parse(disposition!.tags ?? "[]").includes(WAKE_ESCALATION_TAG)) return recoveryBackstop();
  const last = ladder.lastMarkerTs ?? (row.lastNudgeAttempt ? Date.parse(row.lastNudgeAttempt) : null);
  let due = last === null || Number.isNaN(last) ? now.getTime() : last + interval * 1000;
  if (mode === "unconfirmed") {
    // 现有 gate 比较四舍五入后的 age minute；显示其实际最早 eligibility，不为适配界面而改变 policy。
    due = Math.max(due, Date.parse(row.tsCreated) + Math.max(0, resolveWakeUnconfirmedWindowMinutes() - 0.5) * 60_000);
  }
  if (retry) {
    // 使用与执行 ladder 相同的 per-destination attempt budget。正好位于下界的 attempt 仍计数，
    // 因此存在一毫秒边界。
    const attempts = db.prepare(`SELECT t.ts FROM queue_transitions t JOIN queue_items q ON q.qitem_id = t.qitem_id
      WHERE q.destination_session = ? AND t.transition_note LIKE ? AND t.ts >= ? ORDER BY t.ts DESC LIMIT ?`)
      .all(row.destinationSession, `${LADDER_ATTEMPT_PREFIX}%`, new Date(now.getTime() - interval * 1000).toISOString(), cap) as Array<{ ts: string }>;
    if (attempts.length >= cap) due = Math.max(due, Date.parse(attempts[cap - 1]!.ts) + interval * 1000 + 1);
  }
  const suspension = readSuspension(db, row.destinationSession, resolveWakeSwapGraceSeconds(), now);
  if (suspension) due = Math.max(due, Date.parse(suspension.until));
  const orch = defaultResolveOrchestrator(db, row.destinationSession);
  const operator = ladder.orchRung || orch === null || orch === row.destinationSession;
  return {
    owner: retry ? row.destinationSession : operator ? resolveOperatorSeat() ?? row.sourceSession : orch!,
    mechanism: retry ? "queue-wake-ladder:retry" : ladder.opEngineDispatched ? "queue-wake-ladder:operator-outcome" : operator ? "queue-wake-ladder:operator" : "queue-wake-ladder:orchestrator",
    dueAt: ladder.opEngineDispatched ? null : new Date(due).toISOString(), intervalSeconds: interval,
    ...(suspension ? { suspendedUntil: suspension.until, note: suspension.reason } : { note: "最早 eligibility；下一次 scheduler pass 会重新检查 provider state、custody 与共享 destination budget。" }),
  };
}

function appendMarker(repo: QueueRepository, row: QueueItem, note: string): void {
  repo.transitionLog.append({
    qitemId: row.qitemId,
    state: row.state,
    actorSession: LADDER_ACTOR,
    transitionNote: note,
  });
}

function minutesSince(ts: number | string | null | undefined, now: Date): number {
  if (ts === null || ts === undefined) return 0;
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}

function usageLimitPoolTag(poolKey: string): string {
  return `${USAGE_LIMIT_POOL_TAG_PREFIX}${poolKey}`;
}

function rigOf(session: string): string {
  return session.slice(session.lastIndexOf("@") + 1);
}

async function ensureUsageLimitBlocker(
  deps: Pick<WakeLadderDeps, "db" | "queueRepo">,
  pool: UsageLimitPool,
  now: Date,
  jitterSeconds: number,
): Promise<QueueItem> {
  const poolTag = usageLimitPoolTag(pool.poolKey);
  const existing = deps.db.prepare(
    `SELECT qitem_id FROM queue_items
      WHERE state IN ('pending', 'in-progress', 'blocked')
        AND EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?)
        AND EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?)
      LIMIT 1`,
  ).get(USAGE_LIMIT_BLOCKER_TAG, poolTag) as { qitem_id: string } | undefined;

  let blocker = existing ? deps.queueRepo.getById(existing.qitem_id) : null;
  if (blocker) {
    const wake = deps.queueRepo.getParkWakeStatus(blocker.qitemId);
    if (wake?.kind === "timer" && wake.live) return blocker;
    if (wake) throw new Error(`usage-limit blocker ${blocker.qitemId} 的 timer 不处于 live 状态`);
  } else {
    const rig = rigOf(pool.seatSessions[0]!);
    blocker = await deps.queueRepo.create({
      sourceSession: LADDER_ACTOR,
      destinationSession: `wake-ladder@${rig}`,
      body: `Provider usage limit：${pool.poolKey}；在 ${pool.expiresAt} 一次性释放每个 dependent。`,
      tags: [USAGE_LIMIT_BLOCKER_TAG, poolTag],
      expiresAt: new Date(Date.parse(pool.expiresAt) + jitterSeconds * 1000).toISOString(),
      nudge: false,
    });
  }

  const wakeAtMs = Date.parse(pool.expiresAt) + jitterSeconds * 1000;
  const wakeAfterSeconds = Math.max(1, Math.ceil((wakeAtMs - now.getTime()) / 1000));
  deps.queueRepo.update({
    qitemId: blocker.qitemId,
    actorSession: LADDER_ACTOR,
    state: "blocked",
    blockedOn: `external:provider-limit:${pool.poolKey}`,
    transitionNote: `usage-limit cause=${pool.source} pool=${pool.poolKey} reset=${pool.expiresAt} wake=${new Date(wakeAtMs).toISOString()}`,
    wakeAfterSeconds,
  });
  return deps.queueRepo.getById(blocker.qitemId)!;
}

/**
 * 一次 ladder tick。所有内容均从 row + transition log 派生——tick 不保存 memory（F6）。永不抛错：
 * 无法运行的 tick 会在 status surface 与 log 上显著报告，因为静默 skip 正是此 slice 要消除的类别。
 */
export async function runWakeLadderTick(deps: WakeLadderDeps): Promise<WakeLadderTickResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const status = deps.status;
  try {
    const now = deps.now ?? new Date();
    // 只退役底层显式标记 member 全部 resolved 的 aggregate。不根据 body 解释 legacy untagged history。
    const aggregates = deps.db.prepare("SELECT qitem_id, source_session, tags, ts_created FROM queue_items WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ?").all(`%"${WAKE_ESCALATION_TAG}"%`) as Array<{ qitem_id: string; source_session: string; tags: string; ts_created: string }>;
    for (const aggregate of aggregates) {
      const ids = (JSON.parse(aggregate.tags) as string[]).filter(t => t.startsWith("recovery-for:")).map(t => t.slice("recovery-for:".length));
      if (ids.length && ids.every(id => {
        const row = deps.queueRepo.getById(id);
        return row && (!["pending", "in-progress", "blocked"].includes(row.state) || row.lastNudgeResult === "verified" || Boolean(row.claimedAt && row.claimedAt > aggregate.ts_created));
      })) await deps.queueRepo.update({ qitemId: aggregate.qitem_id, actorSession: aggregate.source_session, state: "done", closureReason: "no-follow-on", transitionNote: "wake recovery resolved: tagged obligation 不再需要 delivery recovery" });
    }
    const intervalS = deps.retryIntervalSeconds ?? resolveWakeRetryIntervalSeconds();
    const cap = deps.retryCap ?? resolveWakeRetryCap();
    const windowMin = deps.unconfirmedWindowMinutes ?? resolveWakeUnconfirmedWindowMinutes();
    const graceS = deps.swapGraceSeconds ?? resolveWakeSwapGraceSeconds();
    const resolveOrch =
      deps.resolveOrchestrator ?? ((session: string) => defaultResolveOrchestrator(deps.db, session));
    const attemptWake =
      deps.attemptWake ??
      (async (qitemId: string, target: string): Promise<string> => {
        await deps.queueRepo.maybeNudge(qitemId, target, true);
        return deps.queueRepo.getById(qitemId)?.lastNudgeResult ?? "indeterminate:无可用 transport";
      });

    const actions: WakeLadderAction[] = [];
    let exhaustedThisTick = 0;
    const usagePoolBySeat = new Map<string, UsageLimitPool>();
    if (deps.getProviderReadModel) {
      try {
        const model = await deps.getProviderReadModel();
        const pools = deriveUsageLimitPools({
          ...model,
          now,
          fallbackSeconds: intervalS,
        });
        for (const pool of pools) {
          for (const seat of pool.seatSessions) usagePoolBySeat.set(seat, pool);
        }
      } catch (err) {
        log(`[wake-ladder] provider signal 读取不可用；保留已发布 ladder：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const blockerByPool = new Map<string, QueueItem>();

    // Baton：仍 pending 且未 claim 的 handed-off row。created-with-destination row 明确不在这里——
    // 该缺口由 S02 兜底（F5）。
    const batonRows = deps.db
      .prepare(
        `SELECT qitem_id FROM queue_items
          WHERE state = 'pending' AND claimed_at IS NULL AND handed_off_from IS NOT NULL`,
      )
      .all() as Array<{ qitem_id: string }>;

    // OPR.0.5.6.24 B2（advisor 裁定的 one-engine 分支）：parked-owner consumer wake 失败后形成的
    // claimed in-progress row 加入同一 ladder 流程。Consumer ORIGIN 是 row 上的持久 FAILED
    // transition note（ladder 自身 retry 会用通用 transport detail 覆盖 last_nudge_result，因此该列只
    // 携带 failed 类 eligibility，绝不携带 origin——R2 的 one-shot-entry finding）。retry cap 与
    // exhaustion 继续受 ladder 自己的派生 marker 限制；consumer 永不重试。
    const parkedOwnerFailureRows = deps.db
      .prepare(
        `SELECT q.qitem_id FROM queue_items q
          WHERE q.state = 'in-progress' AND q.claimed_at IS NOT NULL
            AND q.last_nudge_result LIKE 'failed:%'
            AND EXISTS (
              SELECT 1 FROM queue_transitions t
               WHERE t.qitem_id = q.qitem_id
                 AND t.transition_note LIKE 'parked-owner wake delivery failed:%'
            )`,
      )
      .all() as Array<{ qitem_id: string }>;

    interface Member {
      row: QueueItem;
      view: LadderView;
      mode: WakeMode;
      reason: string;
      /** action（wake、rung advance）受到期 gate 与 suspension gate 控制；aggregate REFRESH 只受
       *  detection gate 控制（S02 形态——F3）。 */
      due: boolean;
      suspended: string | null;
    }
    /** 按 destination 分组的 escalation-phase member（F3 聚合）。 */
    const escalating = new Map<string, Member[]>();
    /** 当前 window 内跨所有 ladder 的 per-destination wake attempt（F3 rate bound）。从已记录 marker
     *  seed，使 restart 也保持该 bound。 */
    const windowBudget = new Map<string, number>();
    let activeLadders = 0;

    const budgetFor = (dest: string): number => {
      if (!windowBudget.has(dest)) {
        const since = new Date(now.getTime() - intervalS * 1000).toISOString();
        const counted = deps.db
          .prepare(
            `SELECT COUNT(*) AS n FROM queue_transitions t JOIN queue_items q ON q.qitem_id = t.qitem_id
              WHERE q.destination_session = ? AND t.transition_note LIKE ? AND t.ts >= ?`,
          )
          .get(dest, `${LADDER_ATTEMPT_PREFIX}%`, since) as { n: number };
        windowBudget.set(dest, counted.n);
      }
      return windowBudget.get(dest)!;
    };

    for (const { qitem_id } of [...batonRows, ...parkedOwnerFailureRows]) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row) continue;
      const usagePool = usagePoolBySeat.get(row.destinationSession);
      // OPR.0.5.6.24：usage-limit PARK mutation 只适用于 pending baton——claimed in-progress row
      // 是某人的 live work，这里绝不改变其 state；它会落入普通 mode classification。
      if (usagePool && row.state === "pending") {
        let blocker = blockerByPool.get(usagePool.poolKey);
        if (!blocker) {
          blocker = await ensureUsageLimitBlocker(
            deps,
            usagePool,
            now,
            deps.usageLimitJitterSeconds ?? drawUsageLimitJitterSeconds(),
          );
          blockerByPool.set(usagePool.poolKey, blocker);
        }
        deps.queueRepo.update({
          qitemId: row.qitemId,
          actorSession: LADDER_ACTOR,
          state: "blocked",
          blockedOn: blocker.qitemId,
          transitionNote: `usage-limit suppressed: pool=${usagePool.poolKey} reset=${usagePool.expiresAt}; 等待共享 blocker ${blocker.qitemId}`,
        });
        actions.push({ qitemId: row.qitemId, action: "park-usage-limit" });
        continue;
      }
      const mode = classifyWakeResult(row.lastNudgeResult);
      if (!mode) continue;
      const disposition = findQueueRecovery(deps.db, row.qitemId);
      if (disposition && !["pending", "in-progress", "blocked"].includes(disposition.state)) continue;
      const view = readLadder(deps.db, row.qitemId);
      if (view.exhausted) continue; // 有限：已 exhausted ladder 永不再次触发。

      // unconfirmed 类的 F1 gate：绝不再次 nudge；只有超过 window 且零 pickup evidence 时才进入。
      if (mode === "unconfirmed") {
        if (minutesSince(row.tsCreated, now) < windowMin) continue;
        if (hasPickupEvidence(deps.db, row)) continue;
      }
      activeLadders += 1;

      // 到期性：最新 ladder marker（或原始 nudge attempt）早于 retry interval。无 marker + 无已记录
      // attempt = 现在到期。它只控制 action——detection（以及 aggregate refresh）不受其节流。
      const lastActivity =
        view.lastMarkerTs ?? (row.lastNudgeAttempt ? Date.parse(row.lastNudgeAttempt) : null);
      const due =
        lastActivity === null || Number.isNaN(lastActivity) || now.getTime() - lastActivity >= intervalS * 1000;
      const suspended = due ? suspensionReason(deps.db, row.destinationSession, graceS, now) : null;

      // Retry rung——只处理 failed outcome，低于 cap 且处于 destination budget 内。
      if (mode === "failed" && view.attempts < cap) {
        if (!due) continue;
        // F2——派生 suspension，只在 ladder 本应采取行动时检查。
        if (suspended) {
          if (!view.suspendEpisodeOpen) {
            appendMarker(deps.queueRepo, row, `${LADDER_SUSPEND_PREFIX} ${suspended}`);
            actions.push({ qitemId: row.qitemId, action: "suspend" });
          }
          continue;
        }
        if (view.suspendEpisodeOpen) {
          appendMarker(deps.queueRepo, row, `${LADDER_RESUME_PREFIX} suspension 已结束；ladder 恢复`);
          actions.push({ qitemId: row.qitemId, action: "resume" });
        }
        if (budgetFor(row.destinationSession) >= cap) continue; // destination-bounded (F3)
        windowBudget.set(row.destinationSession, budgetFor(row.destinationSession) + 1);
        const outcome = await attemptWake(row.qitemId, row.destinationSession);
        appendMarker(
          deps.queueRepo,
          row,
          `${LADDER_ATTEMPT_PREFIX} ${view.attempts + 1}/${cap} outcome=${outcome}`,
        );
        actions.push({ qitemId: row.qitemId, action: "retry", target: row.destinationSession });
        continue;
      }

      const recovery = findQueueRecovery(deps.db, row.qitemId);
      if (recovery && !deps.queueRepo.getById(recovery.qitemId)?.tags?.includes(WAKE_ESCALATION_TAG)) {
        appendExhausted(deps.queueRepo, row, `recovery disposition 已由 ${recovery.qitemId}（${recovery.state}）持有`);
        continue;
      }

      // Escalation phase（超过 cap，或 F1 direct path）。无论是否到期，都按 destination 分组，使
      // aggregate refresh 随每次 detection pass 执行。
      const reason =
        mode === "failed"
          ? `wake 失败 ${view.attempts} 次，历时 ${minutesSince(view.firstMarkerTs ?? row.tsCreated, now)} 分钟`
          : `unconfirmed delivery 在 ${minutesSince(row.tsCreated, now)} 分钟内没有 pickup evidence`;
      const dest = row.destinationSession;
      if (!escalating.has(dest)) escalating.set(dest, []);
      escalating.get(dest)!.push({ row, view, mode, reason, due, suspended });
    }

    // F3——per-destination 聚合：一个 escalation 携带 row list，只 refresh 不重复（S02 幂等形态），
    // 且每个 member baton 都带 rung marker。
    for (const [dest, members] of escalating) {
      const orch = resolveOrch(dest);

      // F3——aggregate refresh 只受 detection gate 控制（S02 幂等形态）：live escalation group 每次
      // pass 都 refresh 其唯一 open row，不附带 wake。
      await refreshEscalationRowIfExists(deps, dest, members);

      const actionable = members.filter((m) => m.due && !m.suspended);
      const needsOrchRung = actionable.filter((m) => !m.view.orchRung);
      const reason = needsOrchRung[0]?.reason ?? members[0]!.reason;

      if (needsOrchRung.length > 0) {
        if (orch === null || orch === dest) {
          // F4：rung 1 解析到 destination 自身（或无结果）时自行跳过——绝不向 dead seat escalate；
          // 立即落入 operator rung。operator floor 必须是可见 object，不能只有 marker：确保
          // per-destination escalation row 存在（发给 operator seat，否则发给 obligation 自身 creator），
          // 使 escalations view 与 health count 呈现它——baton exhausted 后仍保持 open。
          const floorDest = resolveOperatorSeat() ?? needsOrchRung[0]!.row.sourceSession;
          await ensureEscalationRow(deps, dest, floorDest, needsOrchRung, reason);
          for (const m of needsOrchRung) {
            appendMarker(
              deps.queueRepo,
              m.row,
              `${LADDER_RUNG_PREFIX} orchestrator self-skip (resolves to ${orch === null ? "no orchestrator" : "destination"}) reason=${m.reason}`,
            );
            if (await operatorRung(deps, m.row, m.reason, actions, m.view)) {
              appendExhausted(deps.queueRepo, m.row, "operator rung resolved");
              exhaustedThisTick += 1;
            }
          }
        } else {
          const escRow = await ensureEscalationRow(deps, dest, orch, members, reason);
          const outcome = await attemptWake(escRow.qitemId, orch);
          for (const m of needsOrchRung) {
            appendMarker(
              deps.queueRepo,
              m.row,
              `${LADDER_RUNG_PREFIX} orchestrator -> ${orch} outcome=${outcome} reason=${m.reason}`,
            );
            actions.push({ qitemId: m.row.qitemId, action: "escalate-orchestrator", target: orch });
            if (!outcome.startsWith("failed:")) {
              // 已 delivered（或 durable-unconfirmed——aggregate row 本身现在是 orchestrator 的持久
              // obligation；若它一直 unclaimed，S02 会兜底）。
              appendExhausted(
                deps.queueRepo,
                m.row,
                `escalated to orchestrator (${outcome === "verified" ? "delivered" : outcome})`,
              );
              exhaustedThisTick += 1;
            }
          }
        }
        continue; // one rung per destination per tick — bounded advance (F4)
      }

      // orchestrator rung 已记录且失败 → 推进到 operator rung。
      for (const m of actionable) {
        if (m.view.orchRung && m.view.orchRungFailed && !m.view.opRung) {
          if (await operatorRung(deps, m.row, m.reason, actions, m.view)) {
            appendExhausted(deps.queueRepo, m.row, "operator rung resolved");
            exhaustedThisTick += 1;
          }
        }
      }

      // AM-F3 resolution pass：engine outcome 曾为 pending 的 rung，只有 row 携带其 resolution
      //（posted receipt 或 termination）后才 exhaust——绝不提前，绝不静默。
      for (const m of members) {
        if (m.view.opEngineDispatched && !m.view.exhausted && m.view.opOutcomeResolved) {
          appendExhausted(deps.queueRepo, m.row, "engine outcome resolved");
          exhaustedThisTick += 1;
        }
      }
    }

    const escalationsOpen = (
      deps.db
        .prepare(
          `SELECT COUNT(*) AS n FROM queue_items
            WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ?`,
        )
        .get(`%"${WAKE_ESCALATION_TAG}"%`) as { n: number }
    ).n;
    const outcome = actions.length > 0 ? "actions" : "clean";
    status?.record(outcome, { active: activeLadders, escalations: escalationsOpen, exhausted: exhaustedThisTick });
    return { outcome, actions };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[wake-ladder] tick 失败（显著跳过）：${message}`);
    status?.record("failed", { error: message });
    return { outcome: "failed", actions: [], error: message };
  }
}

/** operator rung（OPR.0.5.6.1 A1.2/AM-F3）：delivery rules engine 就是 rung 的 delivery leg。
 *  接入 engine port 时，每个 episode 只 dispatch 一次并记录 decision；只有 outcome resolve 后
 *  才 exhaust（同步完成，或稍后由 resolution pass 读取 posted receipt / termination record）。
 *  无 port 时，如实保留 pre-engine floor 并像以前一样 exhaust。ladder 现在可追加 exhausted marker
 *  时返回 true。 */
async function operatorRung(
  deps: WakeLadderDeps,
  row: QueueItem,
  reason: string,
  actions: WakeLadderAction[],
  view: LadderView,
): Promise<boolean> {
  const repo = deps.queueRepo;
  if (!deps.deliveryEngine) {
    appendMarker(
      repo,
      row,
      `${LADDER_RUNG_PREFIX} operator floor=escalation view + daemon-health (delivery engine not wired) reason=${reason}`,
    );
    actions.push({ qitemId: row.qitemId, action: "escalate-operator" });
    return true;
  }
  if (view.opEngineDispatched) {
    // 每个 episode 恰好一次：绝不重新 dispatch；由 resolution pass 决定推进。
    return view.opOutcomeResolved;
  }
  const outcome = await deps.deliveryEngine.dispatchEscalation(row, reason);
  appendMarker(
    repo,
    row,
    `${LADDER_RUNG_PREFIX} operator dispatched-to-engine decision=${outcome.decision} resolved=${outcome.resolved}${outcome.notificationKey ? ` notification_key=${outcome.notificationKey}` : ""} reason=${reason}`,
  );
  actions.push({ qitemId: row.qitemId, action: "escalate-operator" });
  return outcome.resolved;
}

function appendExhausted(repo: QueueRepository, row: QueueItem, why: string): void {
  appendMarker(repo, row, `${LADDER_EXHAUSTED_PREFIX} ${why}`);
}

/** 确保 per-destination aggregate escalation row（F3）：一个 open row，按 tag 去重，重新检测时
 *  refresh——绝不每个 baton 一行。该 row 是发给 orchestrator 的新持久 obligation；baton 本身永不重复。 */
/** F3 aggregate 的仅 refresh 环节：已有 open escalation row 获得一条点名当前 member list 的
 *  detection-pass note；creation 仍属于 rung action，确保首次 delivery attempt 前绝不存在 row。 */
async function refreshEscalationRowIfExists(
  deps: WakeLadderDeps,
  dest: string,
  members: Array<{ row: QueueItem }>,
): Promise<void> {
  const existing = deps.db
    .prepare(
      `SELECT qitem_id FROM queue_items
        WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ? LIMIT 1`,
    )
    .get(`%"${escalationDedupTag(dest)}"%`) as { qitem_id: string } | undefined;
  if (!existing) return;
  const row = deps.queueRepo.getById(existing.qitem_id)!;
  const tags = row.tags ?? [];
  const added = members.map(m => recoveryTag(m.row.qitemId)).filter(tag => !tags.includes(tag));
  if (!added.length) return;
  deps.db.transaction(() => {
    deps.db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify([...tags, ...added]), existing.qitem_id);
    deps.queueRepo.transitionLog.append({ qitemId: existing.qitem_id, state: row.state, actorSession: LADDER_ACTOR,
      transitionNote: `wake-escalation members added: ${added.join(", ")}` });
  })();
}

async function ensureEscalationRow(
  deps: WakeLadderDeps,
  dest: string,
  orch: string,
  members: Array<{ row: QueueItem; reason: string }>,
  reason: string,
): Promise<{ qitemId: string }> {
  const dedupTag = escalationDedupTag(dest);
  const existing = deps.db
    .prepare(
      `SELECT qitem_id FROM queue_items
        WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ? LIMIT 1`,
    )
    .get(`%"${dedupTag}"%`) as { qitem_id: string } | undefined;
  if (existing) {
    await refreshEscalationRowIfExists(deps, dest, members);
    return { qitemId: existing.qitem_id };
  }
  const body =
    `WAKE ESCALATION（按 destination 聚合）\n` +
    `destination: ${dest}\n` +
    `reason: ${reason}\n` +
    `卡住的 baton（${members.length}）：\n` +
    members.map((m) => `- ${m.row.qitemId} (${m.reason})`).join("\n") +
    `\n以上 row 仍恰好一次地承载其 obligation；此 escalation 是 wake，而非 content。`;
  const created = await deps.queueRepo.create({
    sourceSession: members[0]!.row.sourceSession,
    destinationSession: orch,
    body,
    summary: `Wake escalation：${members.length} 个 baton 卡在 ${dest}——${reason}`,
    tags: [WAKE_ESCALATION_TAG, dedupTag, ...members.map(m => recoveryTag(m.row.qitemId))],
    nudge: false, // delivery 是 ladder 自身的 rung attempt，会连同 outcome 一起记录。
  });
  return { qitemId: created.qitemId };
}

export interface WakeLadderSchedulerDeps {
  runTick: () => Promise<WakeLadderTickResult>;
  tickIntervalMs?: number;
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  onTickError?: (err: unknown) => void;
}

/** 常驻 loop——watchdog-scheduler 模式（注入 seam、runTickNow、无重叠 tick），使 ladder 无需 timer
 *  即可由单元测试驱动。 */
export class WakeLadderScheduler {
  private readonly deps: Required<Pick<WakeLadderSchedulerDeps, "runTick">> & WakeLadderSchedulerDeps;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<unknown> | null = null;
  private shuttingDown = false;
  private started = false;

  constructor(deps: WakeLadderSchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.shuttingDown = false;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      (this.deps.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight.catch(() => {});
    this.started = false;
  }

  async runTickNow(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.deps.runTick().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private scheduleNext(): void {
    if (this.shuttingDown) return;
    const ms = this.deps.tickIntervalMs ?? DEFAULT_WAKE_RETRY_INTERVAL_SECONDS * 1000;
    this.timer = (this.deps.setTimer ?? setTimeout)(() => {
      void this.runTickNow()
        .catch((err) => (this.deps.onTickError ?? console.error)(err))
        .finally(() => this.scheduleNext());
    }, ms);
  }
}
