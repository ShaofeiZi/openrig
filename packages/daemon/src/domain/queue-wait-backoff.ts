import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { lastMeaningfulTransition, type WaitingView } from "./queue-waiting.js";
import type { PolicyEvaluation } from "./policies/types.js";
import { readSliceReadiness } from "./proof/judgments.js";
import type { WatchdogJob, WatchdogJobsRepository } from "./watchdog-jobs-repository.js";

interface WaitState {
  qitemId: string;
  blocker: string | null;
  blockerTransition: number | null;
  evidence: Record<string, unknown> | null;
  initialSeconds: number;
  maxSeconds: number;
  eventPending: boolean;
  attentionRevision?: string;
  notice?: { transition: number | null; attentionRevision?: string; at: string; deliveryStatus: string };
}

/** 选择使用 S01 的显式 {scope, revision} 输入。答案归 canonical reader 所有；event 只能
 * 请求重新读取，不能自行编写 acceptance。 */
function attentionRevision(evidence: Record<string, unknown> | null): string | undefined {
  const attention = evidence?.attention as { scope?: unknown; revision?: unknown } | undefined;
  return typeof attention?.scope === "string" && typeof attention.revision === "string"
    ? readSliceReadiness(attention.scope).attention.revision : undefined;
}

// 由队列的原子 park 拥有，并持久化在现有 watchdog job 上。普通 YAML watchdog 与一次性
// park timer 不携带这些 metadata。
function readWait(job: WatchdogJob): { message: string; context: { queue_wait: WaitState } } | null {
  try {
    const spec = JSON.parse(job.specYaml);
    return spec.context?.queue_wait?.qitemId ? spec : null;
  } catch { return null; }
}

export function isQueueWait(specYaml: string): boolean {
  try { return Boolean(JSON.parse(specYaml).context?.queue_wait?.qitemId); }
  catch { return false; }
}

/** 只有精确 blocker 才拥有进展信号。忽略 delivery receipt，也不解释其 note；本模块自己的
 * waiting acknowledgement 位于另一行。 */
function blockerTransition(db: Database.Database, blocker: string | null): number | null {
  if (!blocker?.startsWith("qitem-")) return null;
  return lastMeaningfulTransition(db, blocker)?.id ?? null;
}

export function armQueueWait(db: Database.Database, jobs: WatchdogJobsRepository, input: {
  previousJobId?: string;
  qitemId: string;
  blocker: string | null;
  evidence?: Record<string, unknown>;
  initialSeconds: number;
  maxSeconds: number;
  message: string;
  owner: string;
  actor: string;
}): WatchdogJob {
  const prior = input.previousJobId ? jobs.getById(input.previousJobId) : null;
  const old = prior?.state === "active" ? readWait(prior) : null;
  const state: WaitState = {
    qitemId: input.qitemId, blocker: input.blocker,
    blockerTransition: blockerTransition(db, input.blocker),
    evidence: input.evidence ?? old?.context.queue_wait.evidence ?? null,
    initialSeconds: input.initialSeconds, maxSeconds: input.maxSeconds, eventPending: false,
  };
  const revision = attentionRevision(state.evidence);
  if (revision !== undefined) state.attentionRevision = revision;
  const unchanged = old && isDeepStrictEqual({ ...old.context.queue_wait, eventPending: false, notice: undefined }, { ...state, notice: undefined });
  const specYaml = JSON.stringify({
    policy: "periodic-reminder", target: { session: input.owner }, message: input.message,
    context: { queue_wait: unchanged ? old.context.queue_wait : state },
  });
  if (prior && old && prior.targetSession === input.owner) {
    jobs.updateSchedule(prior.jobId, specYaml, unchanged ? prior.intervalSeconds : input.initialSeconds,
      unchanged ? prior.lastEvaluationAt : new Date().toISOString());
    return jobs.getByIdOrThrow(prior.jobId);
  }
  const job = jobs.register({ policy: "periodic-reminder", specYaml,
    targetSession: input.owner, intervalSeconds: input.initialSeconds, registeredBySession: input.actor });
  jobs.recordEvaluation(job.jobId, job.registeredAt, false);
  return job;
}

/** Event-first 调度更新；启动时也执行一次，用于桥接中断的 event delivery。replay 比较持久
 * transition identity，不执行写入。 */
export function refreshQueueWaits(db: Database.Database, jobs: WatchdogJobsRepository, changedQitem?: string, proofChanged = false): void {
  // ponytail：每个 queue event 扫描一次 active watchdog。若实测 job 数量让扫描成本显著，
  // 再为该 metadata 建索引；不要引入第二套 scheduler/store。
  for (const job of jobs.listActive()) {
    const spec = readWait(job);
    if (!spec) continue;
    const state = spec.context.queue_wait;
    if (changedQitem && state.blocker !== changedQitem) continue;
    const row = db.prepare("SELECT state, blocked_on FROM queue_items WHERE qitem_id = ?").get(state.qitemId) as { state: string; blocked_on: string | null } | undefined;
    if (!row || row.state !== "blocked" || row.blocked_on !== state.blocker) {
      const attached = db.prepare("SELECT 1 FROM queue_transition_wakes WHERE wake_ref = ? AND wake_kind = 'watchdog' LIMIT 1").get(job.jobId);
      if (!attached) jobs.markTerminal(job.jobId, "park_wait_ended");
      continue;
    }
    const current = blockerTransition(db, state.blocker);
    // 文件读取依附于 proof event 和已编写 timer 的现有到期点，绝不无条件每秒扫描文件系统。
    const due = !job.lastEvaluationAt || Date.now() - Date.parse(job.lastEvaluationAt) >= job.intervalSeconds * 1000;
    const revision = proofChanged || due ? attentionRevision(state.evidence) : state.attentionRevision;
    if (current === state.blockerTransition && revision === state.attentionRevision) continue;
    state.blockerTransition = current;
    state.attentionRevision = revision;
    state.eventPending = true;
    jobs.updateSchedule(job.jobId, JSON.stringify(spec), state.initialSeconds, null);
  }
}

/** 现有 watchdog delivery 后调用。event wake 会重置为初始间隔；未变化的 timer wake 将间隔
 * 翻倍。queue packet 永远不变。 */
export function backOffQueueWait(jobs: WatchdogJobsRepository, jobId: string, deliveryStatus?: string): boolean {
  const job = jobs.getById(jobId);
  const spec = job ? readWait(job) : null;
  if (!job || !spec) return false;
  const state = spec.context.queue_wait;
  const delay = state.eventPending ? state.initialSeconds : Math.min(job.intervalSeconds * 2, state.maxSeconds);
  if (deliveryStatus !== undefined) state.notice = { transition: state.blockerTransition, attentionRevision: state.attentionRevision, at: new Date().toISOString(), deliveryStatus };
  state.eventPending = false;
  jobs.updateSchedule(jobId, JSON.stringify(spec), delay, new Date().toISOString());
  return true;
}

/** 每次真实 blocker transition 只呈现一次。pickup grace 之后未消费或失败的 notice 归现有
 * stuck sweep 管理；timer 继续 reconciliation，但不重放 notice，也不重置 deadline。任何
 * receipt 都不代表任务进展。 */
export function evaluateQueueWait(jobs: WatchdogJobsRepository, jobId: string, view: WaitingView | null): PolicyEvaluation | null {
  const job = jobs.getById(jobId);
  const spec = job ? readWait(job) : null;
  if (!job || !spec) return null;
  const state = spec.context.queue_wait;
  if (!view || view.state !== "blocked" || (view.blocker?.ref ?? null) !== state.blocker) return { action: "terminal", reason: "park_wait_ended" };
  if (state.notice && state.notice.transition === state.blockerTransition && state.notice.attentionRevision === state.attentionRevision) {
    backOffQueueWait(jobs, jobId);
    return { action: "skip", reason: "queue_wait_already_presented" };
  }
  if (!state.eventPending && view.liveness.activity === "working" && view.liveness.needsInput.count === 0) {
    backOffQueueWait(jobs, jobId);
    return { action: "skip", reason: "queue_wait_owner_working" };
  }
  const reason = state.eventPending ? "等待源已变化" : "等待兜底提醒";
  return {
    action: "send", target: { session: view.owner },
    message: `${reason}：${view.obligation}；blocker ${view.blocker?.ref ?? "unknown"}（owner ${view.blocker?.owner ?? "unknown"}）。\nActivity：${view.liveness.activity}；confidence：${view.liveness.confidence}。完整 packet：zrig queue show ${view.obligation} --full。`,
    notes: { qitemId: view.obligation, blocker: state.blocker, transition: state.blockerTransition, attentionRevision: state.attentionRevision, cause: state.eventPending ? "waiting-source-change" : "wait-backstop", nextOwner: "queue-stuck-sweep" },
  };
}

export function queueWaitNotice(specYaml: string): WaitState["notice"] | undefined {
  try { return JSON.parse(specYaml).context?.queue_wait?.notice; } catch { return undefined; }
}

/** custody 移交给另一个 worker 时，重新绑定现有 authored timer。返回 waiting owner 的场景
 * 改由 auto-unpark 处理。 */
export function retargetQueueWait(db: Database.Database, jobs: WatchdogJobsRepository, jobId: string, blocker: string): boolean {
  const job = jobs.getById(jobId);
  const spec = job ? readWait(job) : null;
  if (!job || !spec) return false;
  Object.assign(spec.context.queue_wait, { blocker, blockerTransition: blockerTransition(db, blocker), eventPending: true, notice: undefined });
  jobs.updateSchedule(jobId, JSON.stringify(spec), spec.context.queue_wait.initialSeconds, null);
  return true;
}
