import { findQueueRecovery, recoveryId, recoveryTag } from "./queue-recovery.js";
import { queueWaitNotice } from "./queue-wait-backoff.js";
import { lastMeaningfulTransition, pendingSince } from "./queue-waiting.js";
import { resolvePickupThresholdMinutes } from "./queue-pickup.js";
// S02（OPR.0.5.5.2）——常驻卡住项扫描。`queue overdue` 与 `queue undelivered` 是“是否有内容
// 静默卡住”的两部分——此前需要有人记得运行这些 verb。本模块让扫描成为常驻 daemon loop 的 body：
// 两部分按 config 指定 cadence 扫描，finding 作为持久 row 路由到 owning seat；安静扫描成本低
//（一个可观测 heartbeat，不创建 row），失败显著（在 status surface 上点名）。
//
// verb 本身不变——findOverdue/findUndelivered 成为此 loop 的 library。selection 按 destination +
// obligation shape 跨所有 state 执行，绝不按 tag（0.5.3 custody-sweep 教训：tag 扫描会漏掉 founding
// row；terminal state 会读取而非跳过）。sweep-finding row 通过自身 stamp tag 自我排除——用于排除，
// 不用于选择。
//
// S01 接缝（spec Amendment A1，在两个 spec 中交叉引用）：undelivered 部分跳过携带 live S01
// wake-retry ladder 的 row——S01 将 ladder 记录在 row transition 上，正是为了让此 filter 可派生——
// 并继续兜底 S01 排除的内容：laddered-then-exhausted handback（恰好一个 finding，绝不重复报告）与
// created-with-destination obligation（S01 的 baton filter 排除它们；下方 unclaimed net 扫描它们）。
// S01 从此处 import marker vocabulary，使两个 slice 共享一份契约而非两次猜测。S03 拥有 park/wake
// 诚实性：state=blocked row 在合法等待，绝不成为 finding。

import { defaultResolveOrchestrator } from "./queue-owner.js";
import type Database from "better-sqlite3";
import { deriveCrossHostSuccessorId, type QueueItem, type QueueRepository } from "./queue-repository.js";
import { stalledPickupFinding } from "./queue-pickup.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import { loadHostRegistry } from "./hosts/hosts-registry-reader.js";

export const STUCK_SWEEP_INTERVAL_KEY = "queue.stuck_sweep_interval_seconds";
export const DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS = 300;
export const STUCK_SWEEP_UNCLAIMED_AGE_KEY = "queue.stuck_sweep_unclaimed_age_minutes";
export const DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES = 60;

/** 每个已路由 finding row 上的 stamp tag：sweep 的自我排除标记。 */
export const STUCK_SWEEP_FINDING_TAG = "stuck-sweep-finding";

// S01 ladder marker vocabulary（接缝契约）。S01 写入这些 transition-note prefix；sweep 从最新 marker
// 派生“live ladder”。attempt/rung 为 live，exhausted marker 将 row 交回，后续 attempt 再次开始 live
// cycle。
export const LADDER_ATTEMPT_PREFIX = "wake-attempt:";
export const LADDER_RUNG_PREFIX = "escalation-rung:";
export const LADDER_EXHAUSTED_PREFIX = "ladder-exhausted:";

export type StuckFindingKind =
  | "unconsumed-wait"
  | "overdue-claim"
  | "stalled-after-claim"
  | "undelivered-wake"
  | "unclaimed-obligation"
  | "dangling-closure";

/** 幂等 key：每个（stuck row、finding kind）只有一个 open finding row。 */
export function findingDedupTag(kind: StuckFindingKind, qitemId: string): string {
  return `stuck-sweep:${kind}:${qitemId}`;
}

export interface StuckSweepStatusSnapshot {
  lastSweepAt: string | null;
  lastOutcome: "clean" | "findings" | "failed" | null;
  lastError: string | null;
  consecutiveFailures: number;
  findingsRouted: number;
}

export interface StuckSweepStatus {
  record(outcome: "clean" | "findings" | "failed", detail?: { error?: string; findings?: number }): void;
  snapshot(): StuckSweepStatusSnapshot;
}

/** loop 的可观测 heartbeat——在 /healthz 呈现，使 quiet sweep 成本低但绝不不可见，且失败 sweep
 *  无需 row 也能显著报告。 */
export function createStuckSweepStatus(): StuckSweepStatus {
  const state: StuckSweepStatusSnapshot = {
    lastSweepAt: null,
    lastOutcome: null,
    lastError: null,
    consecutiveFailures: 0,
    findingsRouted: 0,
  };
  return {
    record(outcome, detail) {
      state.lastSweepAt = new Date().toISOString();
      state.lastOutcome = outcome;
      state.lastError = outcome === "failed" ? (detail?.error ?? "未知错误") : null;
      state.consecutiveFailures = outcome === "failed" ? state.consecutiveFailures + 1 : 0;
      if (detail?.findings) state.findingsRouted += detail.findings;
    },
    snapshot() {
      return { ...state };
    },
  };
}

/** cadence，每次 fresh read，出错时 fail-open 到默认值（遵循 queue-pickup 先例：config flip 在下一
 *  tick 生效，settings error 绝不会令 sweep 静默）。 */
export function resolveStuckSweepIntervalSeconds(): number {
  try {
    const v = new SettingsStore().resolveOne(STUCK_SWEEP_INTERVAL_KEY as never).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS;
  } catch {
    return DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS;
  }
}

export function resolveStuckSweepUnclaimedAgeMinutes(): number {
  try {
    const v = new SettingsStore().resolveOne(STUCK_SWEEP_UNCLAIMED_AGE_KEY as never).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES;
  } catch {
    return DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES;
  }
}

export interface StuckSweepDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  status?: StuckSweepStatus;
  /** 无人持有 obligation 的 route 解析：destination seat 的 orchestrator（delegates_to parentage）。
   *  null = 无已知 orchestrator → finding 留在 destination（即使 seat 已失效，row 仍在那里持久存在——
   *  S01 是 wake 层）。可为测试注入；默认从 topology 派生。 */
  resolveOrchestrator?: (session: string) => string | null;
  unclaimedAgeMinutes?: number;
  now?: Date;
  log?: (line: string) => void;
  /** 此 host id（或观测到的 self-id）是否存在于操作员的 hosts registry？这是 proof-at-write
   *  disposition 的两个合取条件之一；另一个条件是 successor id 可根据 row 自身字段，通过
   *  `deriveCrossHostSuccessorId` 重新计算，因为 cross-host close（routes/queue.ts）先在该 host 创建
   *  successor，成功后才记录派生 `<id>@<host>`，而通用 update 路径可存任意字符串。仅有 registry
   *  membership 永远不足以抑制。可为测试注入；默认每次 sweep pass 读取一次本地 hosts.yaml。registry
   *  不可用时诚实降级为 verification-required（更多 indeterminate finding，绝无错误 verdict）。 */
  isRegisteredHost?: (hostId: string) => boolean;
}

export interface StuckSweepFindingAction {
  kind: StuckFindingKind;
  qitemId: string;
  findingQitemId: string;
  action: "created" | "refreshed" | "closed";
}

export interface StuckSweepResult {
  outcome: "clean" | "findings" | "failed";
  findings: StuckSweepFindingAction[];
  error?: string;
}

export { resolveSessionNodeId, defaultResolveOrchestrator } from "./queue-owner.js";

interface TransitionNoteRow {
  transition_note: string | null;
}

/** 最新 ladder marker 具有权威性：exhaustion 后 retry 会让 ladder 再次 live。无关 transition 不会
 *  改变最新 marker。 */
/** 持久 custody-verification disposition：位于 closed source row 上的 transition note，由执行
 *  registered-host read 的主体写入（绝非本 detector），格式为
 *  `custody-verified: <exact-target> <free-form how/where>`。按 prefix 锚定解析；target 是 prefix 后第一
 *  个以 whitespace 分隔的 token，进行精确匹配。从 active table 与 retention archive 一起读取：每日
 *  archiver 会将 aged terminal qitem 的每个 transition 移入 `queue_transitions_archive`（custody row
 *  所属的准确类别），而 row 本身继续参与 sweep；若只读 active，会在 retention window 后忘记
 *  disposition，并重新生成 verifier 已回答的同一 finding。archive 永不删除，因此 union 是完整
 *  审计历史。 */
export const CUSTODY_VERIFIED_PREFIX = "custody-verified:";

function custodyVerifiedTargets(db: Database.Database, qitemId: string): Set<string> {
  const notes = db
    .prepare(
      `SELECT transition_note FROM queue_transitions WHERE qitem_id = ? AND transition_note LIKE ?
       UNION ALL
       SELECT transition_note FROM queue_transitions_archive WHERE qitem_id = ? AND transition_note LIKE ?`,
    )
    .all(qitemId, `${CUSTODY_VERIFIED_PREFIX}%`, qitemId, `${CUSTODY_VERIFIED_PREFIX}%`) as TransitionNoteRow[];
  const verified = new Set<string>();
  for (const { transition_note: note } of notes) {
    if (!note) continue;
    const token = note.slice(CUSTODY_VERIFIED_PREFIX.length).trim().split(/\s+/)[0];
    if (token) verified.add(token);
  }
  return verified;
}

/** proof-at-write 分支的默认 registry view：操作员的 hosts.yaml，每次 sweep pass 惰性读取一次。
 *  registry 不可用 → 没有 host 注册 → 每个 host 限定 target 保持 verification-required
 *  （诚实降级，只记录一次）。 */
function defaultIsRegisteredHost(log: (line: string) => void): (hostId: string) => boolean {
  let known: Set<string> | null | undefined;
  return (hostId: string) => {
    if (known === undefined) {
      const loaded = loadHostRegistry();
      if (loaded.ok) {
        known = new Set<string>();
        for (const host of loaded.registry.hosts) {
          known.add(host.id);
          if (host.hostId) known.add(host.hostId);
        }
      } else {
        known = null;
        log(`[stuck-sweep] host registry 不可用——host 限定 custody target 保持 verification-required（${loaded.error}）`);
      }
    }
    return known !== null && known.has(hostId);
  };
}

function hasLiveLadder(db: Database.Database, qitemId: string): boolean {
  const notes = db
    .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC")
    .all(qitemId) as TransitionNoteRow[];
  for (const { transition_note: note } of notes) {
    if (!note) continue;
    if (note.startsWith(LADDER_EXHAUSTED_PREFIX)) return false;
    if (note.startsWith(LADDER_ATTEMPT_PREFIX) || note.startsWith(LADDER_RUNG_PREFIX)) return true;
  }
  return false;
}

function minutesSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.round((now.getTime() - then) / 60_000));
}

function lastTransitionLine(db: Database.Database, qitemId: string): string {
  const row = db
    .prepare("SELECT ts, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts DESC LIMIT 1")
    .get(qitemId) as { ts: string; transition_note: string | null } | undefined;
  return row ? `${row.transition_note ?? "（无 note）"}，时间 ${row.ts}` : "（无 transition）";
}

interface Candidate {
  kind: StuckFindingKind;
  row: QueueItem;
  route: string;
  ageMinutes: number;
  /** 每种 kind 的 evidence watermark。closed finding 只抑制此 timestamp 或更早的 evidence；
   *  更新 evidence 会产生一条新 finding。 */
  evidenceAt: string;
  why: string;
  verificationTargets?: string[];
}

function isFindingRow(item: QueueItem): boolean {
  return (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG);
}

function latestIso(...values: Array<string | null | undefined>): string {
  let latest: { iso: string; time: number } | undefined;
  for (const iso of values) {
    if (!iso) continue;
    const time = Date.parse(iso);
    if (!Number.isNaN(time) && (!latest || time > latest.time)) latest = { iso, time };
  }
  return latest?.iso ?? new Date(0).toISOString();
}

function evidenceIsNewer(evidenceAt: string, closedAt: string): boolean {
  const evidence = Date.parse(evidenceAt);
  const closed = Date.parse(closedAt);
  return !Number.isNaN(evidence) && !Number.isNaN(closed) && evidence > closed;
}

function verificationCommand(target: string): string {
  const successorId = target.split("@", 1)[0] ?? target;
  return `OPENRIG_URL=<registered-host> zrig queue show ${successorId}`;
}

function evidenceBody(db: Database.Database, c: Candidate): string {
  if (c.verificationTargets?.length) {
    const checks = c.verificationTargets
      .map((target) => `- ${target}\n  ${verificationCommand(target)}`)
      .join("\n");
    return (
      `卡住项扫描发现（successor-verification-required）\n` +
      `row: ${c.row.qitemId}\n` +
      `destination: ${c.row.destinationSession}（source ${c.row.sourceSession}，state ${c.row.state}）\n` +
      `age: ${c.ageMinutes} 分钟\n` +
      `最近 transition：${lastTransitionLine(db, c.row.qitemId)}\n` +
      `原因：${c.why}\n` +
      `验证目标（在已注册 host 上检查前为 indeterminate）：\n${checks}\n` +
      `在 registered-host read 确认目标后，将结果持久记录在 closed row 上，使 sweep 不再询问：\n` +
      `  zrig queue update ${c.row.qitemId} --note "custody-verified: <target> <how verified>"\n` +
      `不要根据此本地 observation 重写历史 custody；请单独记录 verification result。`
    );
  }
  return (
    `卡住项扫描发现（${c.kind}）\n` +
    `row: ${c.row.qitemId}\n` +
    `destination: ${c.row.destinationSession}（source ${c.row.sourceSession}，state ${c.row.state}）\n` +
    `age: ${c.ageMinutes} 分钟\n` +
    `最近 transition：${lastTransitionLine(db, c.row.qitemId)}\n` +
    `原因：${c.why}\n` +
    `请解决底层 row；该 row 不再卡住后，sweep 会自行关闭此 finding。`
  );
}

/**
 * 一次 sweep pass。作用于整个 instance（无 rig scope——此 loop 兜底 daemon 承载的每个 rig）。
 * 永不抛错：无法运行的 sweep 会在 status surface 与 log 上显著报告 outcome=failed，因为静默 skip
 * 正是此 slice 要消除的类别。
 */
export async function runStuckSweep(deps: StuckSweepDeps): Promise<StuckSweepResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const status = deps.status;
  try {
    const now = deps.now ?? new Date();
    const ageMinutes = deps.unclaimedAgeMinutes ?? resolveStuckSweepUnclaimedAgeMinutes();
    const resolveOrch =
      deps.resolveOrchestrator ?? ((session: string) => defaultResolveOrchestrator(deps.db, session));
    const isRegisteredHost = deps.isRegisteredHost ?? defaultIsRegisteredHost(log);
    const candidates: Candidate[] = [];

    // 第 1 部分——claimed-never-closed。claimant 持有 obligation；finding 路由给它。
    for (const row of deps.queueRepo.findOverdue({ now: now.toISOString() })) {
      if (isFindingRow(row)) continue;
      candidates.push({
        kind: "overdue-claim",
        row,
        route: row.destinationSession,
        ageMinutes: minutesSince(row.closureRequiredAt ?? row.claimedAt, now),
        evidenceAt: latestIso(lastMeaningfulTransition(deps.db, row.qitemId)?.at, row.closureRequiredAt, row.claimedAt),
        why: "已领取并超过 closure_required_at，但尚未闭合",
      });
    }

    // S04 接缝——已 claim row 超过 pickup threshold 且此后无 motion。pickup module 仍是唯一派生规则；
    // 此 loop 只负责枚举与路由。
    const claimedRows = deps.db
      .prepare("SELECT qitem_id FROM queue_items WHERE state = 'in-progress' AND claimed_at IS NOT NULL")
      .all() as Array<{ qitem_id: string }>;
    for (const { qitem_id } of claimedRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      const stalled = stalledPickupFinding(row);
      if (!stalled) continue;
      candidates.push({
        kind: stalled.kind,
        row,
        route: resolveOrch(stalled.target) ?? stalled.target,
        ageMinutes: minutesSince(row.claimedAt, now),
        // 为知道 in-flight row 的 0.5.7 mechanized-pull turn-end hook 保留此 null 分支；
        // 它是首个诚实的 row-scoped writer，且只有该 slice 会重新开启接线。
        evidenceAt: latestIso(lastMeaningfulTransition(deps.db, row.qitemId)?.at, row.lastHeartbeat, row.claimedAt),
        why: stalled.evidence,
      });
    }

    // timer 已投递一条 transition-specific notice（或记录失败 attempt）。此已有 sweep 拥有其有界
    // recovery，而不是另一条完整 packet 或 parked-owner replay。真实 owner response 会结束该 occurrence。
    const waitJobs = deps.db.prepare("SELECT job_id, spec_yaml FROM watchdog_jobs WHERE state = 'active' AND policy = 'periodic-reminder'").all() as Array<{ job_id: string; spec_yaml: string }>;
    for (const job of waitJobs) {
      const notice = queueWaitNotice(job.spec_yaml);
      if (!notice || now.getTime() - Date.parse(notice.at) <= resolvePickupThresholdMinutes() * 60_000) continue;
      const binding = deps.db.prepare("SELECT qitem_id FROM queue_transition_wakes WHERE wake_ref = ? AND phase = 'armed' ORDER BY transition_id DESC LIMIT 1").get(job.job_id) as { qitem_id: string } | undefined;
      const row = binding ? deps.queueRepo.getById(binding.qitem_id) : null;
      if (!row || row.state !== "blocked" || deps.queueRepo.getParkWakeStatus(row.qitemId)?.ref !== job.job_id) continue;
      const response = lastMeaningfulTransition(deps.db, row.qitemId);
      if (response && Date.parse(response.at) > Date.parse(notice.at)) continue;
      const ownerActivity = deps.queueRepo.ownerActivity(row.destinationSession);
      if (ownerActivity?.activity === "working" && !ownerActivity.needsInput.count && notice.deliveryStatus === "ok") continue;
      candidates.push({ kind: "unconsumed-wait", row, route: resolveOrch(row.destinationSession) ?? row.sourceSession,
        ageMinutes: minutesSince(notice.at, now), evidenceAt: notice.at,
        why: `wait notice delivery=${notice.deliveryStatus}；此后没有 owner response；activity=${ownerActivity?.activity ?? "unknown"}；请检查准确 blocker ${row.blockedOn}` });
    }

    // 第 2 部分——sender-believed-delivered-never-woken。无人持有它（wake 失败），因此能解析时路由
    // 到 destination 的 orchestrator。带 live S01 ladder 的 row 属于 S01；exhausted ladder 是交回项，
    // 在此恰好落入一次（dedup tag 保证只有一条 finding）。
    for (const row of deps.queueRepo.findUndelivered()) {
      if (isFindingRow(row)) continue;
      if (hasLiveLadder(deps.db, row.qitemId)) continue;
      candidates.push({
        kind: "undelivered-wake",
        row,
        route: resolveOrch(row.destinationSession) ?? row.destinationSession,
        ageMinutes: minutesSince(row.tsCreated, now),
        evidenceAt: latestIso(row.tsUpdated, row.lastNudgeAttempt),
        why: `wake 失败（${row.lastNudgeResult ?? "failed"}），且没有任何机制重试`,
      });
    }

    // A1 兜底——带真实 obligation、创建时已有 destination，且超过 config 指定 age 仍未 claim 的 row。
    // park（state=blocked）在合法等待，绝不出现在这里；failed-nudge row 已由第 2 部分呈现；laddered
    // row 属于 S01。
    const cutoff = new Date(now.getTime() - ageMinutes * 60_000).toISOString();
    const unclaimedRows = deps.db
      .prepare(
        `SELECT qitem_id FROM queue_items
          WHERE state = 'pending'
            AND claimed_at IS NULL
            AND destination_session IS NOT NULL AND destination_session != ''
            AND ts_created <= ?
            AND (last_nudge_result IS NULL OR last_nudge_result NOT LIKE 'failed:%')`,
      )
      .all(cutoff) as Array<{ qitem_id: string }>;
    for (const { qitem_id } of unclaimedRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      const actionableAt = pendingSince(deps.db, row.qitemId) ?? row.tsCreated;
      if (actionableAt > cutoff) continue;
      if (hasLiveLadder(deps.db, row.qitemId)) continue;
      candidates.push({
        kind: "unclaimed-obligation",
        row,
        route: resolveOrch(row.destinationSession) ?? row.destinationSession,
        ageMinutes: minutesSince(actionableAt, now),
        evidenceAt: actionableAt,
        why: `已有 destination 且可执行，但 ${minutesSince(actionableAt, now)} 分钟未领取（threshold ${ageMinutes}）`,
      });
    }

    // custody 类——closure 点名一个或多个 successor qitem 的 terminal row。本地未命中绝不是缺失证明：
    // successor 可能位于另一已注册 host 的 database。逗号 fan-out 逐 member 检查，只报告未解析
    // member。两种 disposition 可在本地未命中时满足 member：(1) proof-at-write——已注册 host qualifier，
    // 且 successor id 可从此 row 自身的 (qitem_id, handed_off_to, host) 通过 cross-host close 使用的
    // 相同确定性派生重新计算。close 路径只在转发的 successor-create 成功后记录该 key；可接受任意
    // closure target 的通用 update 路径无法意外合成 sha256-derived id——绝不只信任 registered-host
    // syntax；(2) 执行 registered-host read 的主体在 source row 上写入持久 `custody-verified:`
    // transition note（从 active + archived transition 读取）。本 detector 绝不改变历史 source row——
    // disposition note 是 verifier 的动作，不是我们的动作。
    const custodyRows = deps.db
      .prepare(
        `SELECT q.qitem_id FROM queue_items q
          WHERE q.state IN ('done', 'canceled', 'handed-off')
            AND q.closure_target LIKE 'qitem-%'`,
      )
      .all() as Array<{ qitem_id: string }>;
    for (const { qitem_id } of custodyRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      const targets = (row.closureTarget ?? "").split(",").map((target) => target.trim()).filter(Boolean);
      const verified = custodyVerifiedTargets(deps.db, row.qitemId);
      const verificationTargets = targets.filter((target) => {
        if (verified.has(target)) return false;
        const at = target.indexOf("@");
        if (at !== -1) {
          const hostId = target.slice(at + 1);
          const successorId = target.slice(0, at);
          return !(
            isRegisteredHost(hostId) &&
            row.handedOffTo !== null &&
            successorId === deriveCrossHostSuccessorId(row.qitemId, row.handedOffTo, hostId)
          );
        }
        return !deps.queueRepo.getById(target);
      });
      if (verificationTargets.length === 0) continue;
      candidates.push({
        kind: "dangling-closure",
        row,
        route: row.destinationSession,
        ageMinutes: minutesSince(row.tsUpdated, now),
        evidenceAt: latestIso(row.tsUpdated),
        why: `已闭合（${row.closureReason ?? "?"}），但本地 store 无法完整验证 successor custody`,
        verificationTargets,
      });
    }

    // Route：按 (row, kind) 幂等。已有 open finding 刷新 age；新 finding 以 durable + waking 方式创建
    //（create 路径默认 nudge）。
    const findings: StuckSweepFindingAction[] = [];
    const liveDedupTags = new Set<string>();
    for (const c of [...new Map(candidates.map(c => [c.row.qitemId, c])).values()]) {
      const dedupTag = findingDedupTag(c.kind, c.row.qitemId);
      const shared = findQueueRecovery(deps.db, c.row.qitemId);
      if (shared) {
        const existingTags = deps.queueRepo.getById(shared.qitemId)?.tags ?? [];
        for (const tag of existingTags) if (tag.startsWith("stuck-sweep:")) liveDedupTags.add(tag);
        if (["pending", "in-progress", "blocked"].includes(shared.state)) findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: shared.qitemId, action: "refreshed" });
        continue;
      }
      liveDedupTags.add(dedupTag);
      const existing = deps.db
        .prepare(
          `SELECT qitem_id, source_session, state, ts_updated FROM queue_items
            WHERE tags LIKE ?
            ORDER BY CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END,
                     ts_updated DESC, ts_created DESC, qitem_id DESC
            LIMIT 1`,
        )
        .get(`%"${dedupTag}"%`) as
        | { qitem_id: string; source_session: string; state: string; ts_updated: string }
        | undefined;
      const existingIsOpen = existing && ["pending", "in-progress", "blocked"].includes(existing.state);
      if (existing && existingIsOpen) {
        // age 在读取时派生；无变化 scan 不是 transition。
        findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: existing.qitem_id, action: "refreshed" });
      } else if (!existing || evidenceIsNewer(c.evidenceAt, existing.ts_updated)) {
        const created = await deps.queueRepo.create({
          qitemId: recoveryId(deps.db, c.row.qitemId),
          // detector 是机制，不是 seat：obligation 自身 creator 是 finding source
          //（workflow-exception 先例）。
          sourceSession: c.row.sourceSession,
          destinationSession: c.route,
          body: evidenceBody(deps.db, c),
          summary: `卡住项扫描：${c.row.qitemId} 上的 ${c.verificationTargets ? "successor-verification-required" : c.kind}（${c.ageMinutes} 分钟）`,
          evidenceRef: `rig queue show ${c.row.qitemId}`,
          tags: [STUCK_SWEEP_FINDING_TAG, dedupTag, recoveryTag(c.row.qitemId)],
        });
        findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: created.qitemId, action: "created" });
      }
    }

    // Resolution：底层 condition 不再检测到时，以 reason 关闭 open finding——sweep 自行清理，
    // 无需 human unwind。
    const openFindings = deps.db
      .prepare(
        `SELECT qitem_id, source_session, tags FROM queue_items
          WHERE state IN ('pending', 'in-progress', 'blocked')
            AND tags LIKE ?`,
      )
      .all(`%"${STUCK_SWEEP_FINDING_TAG}"%`) as Array<{ qitem_id: string; source_session: string; tags: string }>;
    for (const f of openFindings) {
      let tags: string[] = [];
      try {
        tags = JSON.parse(f.tags) as string[];
      } catch {
        continue;
      }
      const dedupTag = tags.find((t) => t.startsWith("stuck-sweep:"));
      if (!dedupTag || liveDedupTags.has(dedupTag)) continue;
      const [, kind, stuckId] = dedupTag.match(/^stuck-sweep:([a-z-]+):(.+)$/) ?? [];
      await deps.queueRepo.update({
        qitemId: f.qitem_id,
        actorSession: f.source_session,
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: `stuck-sweep resolved: 不再检测到 ${stuckId ?? "row"} 上的 ${kind ?? "finding"}`,
      });
      if (kind && stuckId) {
        findings.push({
          kind: kind as StuckFindingKind,
          qitemId: stuckId,
          findingQitemId: f.qitem_id,
          action: "closed",
        });
      }
    }

    const outcome = findings.length > 0 ? "findings" : "clean";
    status?.record(outcome, { findings: findings.filter((f) => f.action !== "closed").length });
    return { outcome, findings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 显著而非静默：failure 同时写入 log 与 status surface（healthz）。
    log(`[stuck-sweep] 扫描失败（显著跳过本次 tick）：${message}`);
    status?.record("failed", { error: message });
    return { outcome: "failed", findings: [], error: message };
  }
}
