import { ClassifierLeaseError, type ClassifierLeaseManager, type ClassifierLease } from "./classifier-lease-manager.js";
import { ClassificationAttemptError, MAX_ELIGIBLE_PAGE, type ClassificationAttemptLedger, type ClassificationAttempt } from "./classification-attempts.js";
import { ProjectClassifierError, type ProjectClassifier, type ProjectClassifyInput } from "./project-classifier.js";
import type { EventBus } from "./event-bus.js";
import type { StreamStore, StreamItem } from "./stream-store.js";
import type { RegisterWatchdogJobInput } from "./watchdog-jobs-repository.js";

export const LABEL_FIELDS = ["classificationType", "classificationUrgency", "classificationMaturity", "classificationConfidence",
  "classificationDestination", "area", "scopeRef"] as const;
type LabelField = typeof LABEL_FIELDS[number];
export type WorkerLabels = Partial<Record<LabelField, string | null>> & {
  needsHuman?: boolean | null;
  duplicateOfStreamItemId?: string | null;
  /** 从给定重复候选中选择的正向证据；绝不把检索未命中当成反向证据。 */
  duplicateEvidenceRef?: string | null;
};
export interface ClassificationCandidates {
  /** 将分类值、名册和已验证工作范围 ID 绑定在一起；不做隐式实时查找。 */
  version: string;
  values: Record<LabelField, readonly string[]>;
  duplicateCandidates: readonly { streamItemId: string; evidenceRef: string }[];
  /** 证据引用（qitem/PR/KI 等）不是可选工作范围 ID。 */
  relatedRefs: readonly string[];
}
export interface ClassificationRequest {
  readonly item: Readonly<StreamItem>;
  readonly attempt: Readonly<ClassificationAttempt>;
  readonly candidates: Readonly<ClassificationCandidates>;
}
export type ClassificationDecision = { kind: "abstain"; reason: string } | { kind: "classify"; labels: WorkerLabels };
type AsyncPort<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never };
export interface WorkerOptions {
  session: string;
  classifierVersion: string;
  taxonomyVersion: string;
  /** 所有者授权的 epoch；只有新证据允许再次处理时才显式更改。 */
  evidenceEpoch: string;
  candidates: ClassificationCandidates;
  classify: (request: ClassificationRequest, signal: AbortSignal) => Promise<ClassificationDecision>;
  leases: AsyncPort<Pick<ClassifierLeaseManager, "evaluateDeadness" | "acquire" | "requireActiveHolder" | "heartbeat">>;
  attempts: AsyncPort<Pick<ClassificationAttemptLedger, "eligible" | "begin" | "abstain" | "fail">>;
  classifier: AsyncPort<Pick<ProjectClassifier, "classify">>;
  stream: AsyncPort<Pick<StreamStore, "getById">>;
  now?: () => Date;
  pageSize?: number;
  requestTimeoutMs?: number;
  leaseBackoffMs?: number;
  signal?: AbortSignal;
  /** 由占用者控制的实验开关；绝不是后台服务的分类法/策略决策。 */
  shouldStop?: () => boolean;
}
export interface WakeResult {
  state: "processed" | "busy" | "classifier_pending" | "lease_backoff" | "lease_lost" | "unavailable" | "stopped";
  nextWakeAt: string;
  reason?: string;
  moreEligible: boolean;
  outcomes: { streamItemId: string; status: string; reason?: string }[];
}

/**
 * 离线、由智能体拥有的 worker 核心。后台服务启动时不会实例化它。被选中的占用者会按
 * 既有 watchdog/唤醒节奏调用 wake()。本类没有轮询循环、调度器注册、provider 或逐条队列。
 * 通知丢失或溢出无害：每次唤醒都从头读取一页有界的合格条目；排除已完成工作的依据是
 * 持久台账，而不是高水位游标。
 */
export class StreamClassificationWorker {
  private readonly options: WorkerOptions;
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private lease: ClassifierLease | null = null;
  private heartbeatAt = 0;
  private acquireAfter = 0;
  private busy = false;
  // 只保留一个合并提示，不缓冲条目 ID，也不自动创建逐条工作。
  private hinted = false;
  // deadline 约束 wake()，而非注入操作本身。分类器忽略 AbortSignal 时绝不堆积调用；
  // 延迟完成的结果会被丢弃，并清除此槽位。
  private pending = false;

  constructor(options: WorkerOptions) {
    for (const key of ["session", "classifierVersion", "taxonomyVersion", "evidenceEpoch"] as const) nonblank(options[key], key);
    nonblank(options.candidates.version, "candidateSetVersion");
    for (const field of LABEL_FIELDS) {
      if (!Array.isArray(options.candidates.values[field])) throw Error(`缺少候选列表：${field}`);
      for (const value of options.candidates.values[field]) nonblank(value, field);
    }
    if (!Array.isArray(options.candidates.duplicateCandidates) || !Array.isArray(options.candidates.relatedRefs)) throw Error("候选证据列表必须是数组");
    for (const c of options.candidates.duplicateCandidates) {
      nonblank(c.streamItemId, "duplicate candidate"); nonblank(c.evidenceRef, "duplicate evidence");
    }
    for (const ref of options.candidates.relatedRefs) nonblank(ref, "relatedRef");
    this.options = { ...options, candidates: freeze(structuredClone(options.candidates)) };
    this.now = options.now ?? (() => new Date());
    this.pageSize = bounded(options.pageSize ?? 20, 1, MAX_ELIGIBLE_PAGE, "pageSize");
    this.timeoutMs = bounded(options.requestTimeoutMs ?? 30_000, 1, 60_000, "requestTimeoutMs");
    this.backoffMs = bounded(options.leaseBackoffMs ?? 60_000, 1_000, 300_000, "leaseBackoffMs");
  }

  /** 可选的实时/重连提示；即使调用百万次，也只存储一个布尔值。 */
  notify(): void { this.hinted = true; }

  /** 在首次追赶前订阅；事件只合并为一个提示，绝不自行启动工作。 */
  subscribe(bus: Pick<EventBus, "subscribe">): () => void {
    const unsubscribe = bus.subscribe(event => { if (event.type === "stream.emitted") this.notify(); });
    this.notify(); // 即使没有新事件，重连后也需要基于持久数据追赶。
    return unsubscribe;
  }

  /** 既有策略的描述符；返回该对象不会注册任何内容。 */
  wakeRegistration(registeredBySession: string, targetGenerationUuid?: string): RegisterWatchdogJobInput {
    nonblank(registeredBySession, "registeredBySession");
    if (!this.lease) throw Error("选择唤醒节奏前必须先获取租约");
    const intervalSeconds = Math.floor(this.leasePeriod() / 1000);
    if (intervalSeconds < 1) throw Error("租约 TTL 太短，无法用于既有的秒级调度器");
    return {
      policy: "periodic-reminder", targetSession: this.options.session, registeredBySession, targetGenerationUuid,
      intervalSeconds,
      specYaml: JSON.stringify({ target: { session: this.options.session }, message: "执行一次有界流分类唤醒；保留租约和执行围栏。" }),
    };
  }

  async wake(): Promise<WakeResult> {
    const result: WakeResult = { state: "processed", nextWakeAt: this.now().toISOString(), moreEligible: false, outcomes: [] };
    if (this.busy) return { ...result, state: "busy" };
    if (this.pending) return { ...result, state: "classifier_pending", nextWakeAt: new Date(this.now().getTime() + this.backoffMs).toISOString() };
    if (this.now().getTime() < this.acquireAfter) return { ...result, state: "lease_backoff", nextWakeAt: new Date(this.acquireAfter).toISOString() };
    this.busy = true;
    this.hinted = false;
    const o = this.options;
    try {
      if (this.stopped()) return { ...result, state: "stopped" };
      if (!this.lease) {
        await o.leases.evaluateDeadness();
        this.lease = await o.leases.acquire(o.session);
        this.heartbeatAt = Date.parse(this.lease.lastHeartbeat) + this.leasePeriod();
      }
      await this.maintainLease();
      const page = await o.attempts.eligible({ classifierVersion: o.classifierVersion, taxonomyVersion: o.taxonomyVersion,
        evidenceEpoch: o.evidenceEpoch, limit: this.pageSize });
      result.moreEligible = page.nextAfterSortKey !== null;
      for (const item of page.items) {
        if (this.stopped()) { result.state = "stopped"; result.moreEligible = true; break; }
        await this.maintainLease();
        let attempt: ClassificationAttempt;
        try {
          attempt = await o.attempts.begin({ streamItemId: item.streamItemId, classifierVersion: o.classifierVersion,
            taxonomyVersion: o.taxonomyVersion, evidenceEpoch: o.evidenceEpoch, leaseId: this.lease!.leaseId, classifierSession: o.session });
        } catch (error) {
          if (!(error instanceof ClassificationAttemptError)) throw error;
          result.outcomes.push({ streamItemId: item.streamItemId, status: error.code });
          continue;
        }
        // 绝不允许注入的分类器改写完成阶段的执行身份。
        const finish = Object.freeze({ attemptId: attempt.attemptId, executionId: attempt.executionId,
          leaseId: attempt.leaseId, classifierSession: o.session });
        try {
          const source = await o.stream.getById(item.streamItemId);
          if (!source) throw Error("流条目不可用");
          const decision = await this.decide(freeze({ item: structuredClone(source), attempt: { ...attempt }, candidates: o.candidates }));
          await this.maintainLease(); // 心跳前拒绝已到期/被替换的租约；事务内还会再次检查。
          if (this.stopped()) {
            await o.attempts.abstain({ ...finish, reason: "实验已停止；结果未应用" });
            result.outcomes.push({ streamItemId: item.streamItemId, status: "abstained", reason: "stopped" });
            result.state = "stopped"; result.moreEligible = true; break;
          }
          if (decision.kind === "abstain") {
            nonblank(decision.reason, "abstention reason");
            await o.attempts.abstain({ ...finish, reason: decision.reason });
            result.outcomes.push({ streamItemId: item.streamItemId, status: "abstained" });
          } else if (decision.kind === "classify") {
            const labels = this.labels(decision.labels);
            await o.classifier.classify({ ...labels, ...finish, streamItemId: item.streamItemId,
              classifierVersion: o.classifierVersion, taxonomyVersion: o.taxonomyVersion, candidateSetVersion: o.candidates.version,
              identityProvenance: "claimed:v1" }); // direct offline caller; no transport claim invented.
            result.outcomes.push({ streamItemId: item.streamItemId, status: "written" });
          } else throw Error("未知分类器决策");
        } catch (error) {
          if (error instanceof ClassifierLeaseError) throw error;
          const code = error instanceof ProjectClassifierError || error instanceof ClassificationAttemptError ? error.code : null;
          if (code === "idempotency_violation" || code === "already_classified" || code === "attempt_superseded" || code === "attempt_mismatch") {
            result.outcomes.push({ streamItemId: item.streamItemId, status: code });
          } else {
            try {
              const failed = await o.attempts.fail({ ...finish, reason: error instanceof Error ? error.message : "分类器失败" });
              result.outcomes.push({ streamItemId: item.streamItemId, status: failed.status, reason: failed.reason ?? undefined });
            } catch (finishError) {
              if (finishError instanceof ClassifierLeaseError) throw finishError;
              if (!(finishError instanceof ClassificationAttemptError)) throw finishError;
              result.outcomes.push({ streamItemId: item.streamItemId, status: finishError.code });
            }
          }
        }
        if (this.pending) { result.moreEligible = true; break; } // 取消尚未确认；不启动第二个操作。
      }
      result.moreEligible ||= this.hinted;
      result.nextWakeAt = new Date(this.heartbeatAt).toISOString();
      return result;
    } catch (error) {
      if (!(error instanceof ClassifierLeaseError)) {
        this.acquireAfter = this.now().getTime() + this.backoffMs;
        return { ...result, state: "unavailable", reason: error instanceof Error ? error.message : "worker 源不可用", nextWakeAt: new Date(this.acquireAfter).toISOString() };
      }
      this.lease = null;
      this.acquireAfter = this.now().getTime() + this.backoffMs;
      return { ...result, state: "lease_lost", reason: error.code, nextWakeAt: new Date(this.acquireAfter).toISOString() };
    } finally { this.busy = false; }
  }

  private leasePeriod(): number {
    return Math.max(1, Math.floor((Date.parse(this.lease!.expiresAt) - Date.parse(this.lease!.lastHeartbeat)) / 3));
  }
  private async maintainLease(): Promise<void> {
    const o = this.options;
    await o.leases.requireActiveHolder(o.session, this.lease!.leaseId);
    if (this.now().getTime() >= this.heartbeatAt) {
      this.lease = await o.leases.heartbeat(this.lease!.leaseId, o.session);
      this.heartbeatAt = Date.parse(this.lease.lastHeartbeat) + this.leasePeriod();
    }
  }
  private async decide(request: ClassificationRequest): Promise<ClassificationDecision> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.options.signal?.addEventListener("abort", abort, { once: true });
    if (this.options.signal?.aborted) abort();
    this.pending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 只有当前调用方消费此 Promise；settled 处理器绝不写入结果。
    const operation = Promise.resolve().then(() => this.options.classify(request, controller.signal))
      .finally(() => { this.pending = false; });
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(Error("分类器超过截止时间")); controller.abort(); }, Math.max(1, Math.min(this.timeoutMs, this.heartbeatAt - this.now().getTime())));
      })]);
    } finally { if (timer) clearTimeout(timer); this.options.signal?.removeEventListener("abort", abort); }
  }
  private stopped(): boolean { return !!this.options.signal?.aborted || !!this.options.shouldStop?.(); }
  private labels(labels: WorkerLabels): Partial<ProjectClassifyInput> {
    if (!labels || typeof labels !== "object") throw Error("分类标签必须是对象");
    const out: Partial<ProjectClassifyInput> = {};
    for (const field of LABEL_FIELDS) {
      const value = labels[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || !this.options.candidates.values[field].includes(value)) throw Error(`候选值不可用：${field}`);
      out[field] = value;
    }
    if (labels.needsHuman != null && typeof labels.needsHuman !== "boolean") throw Error("needsHuman 必须是布尔值或 unknown");
    out.needsHuman = labels.needsHuman ?? null;
    if (labels.duplicateOfStreamItemId != null) {
      if (!this.options.candidates.duplicateCandidates.some(c => c.streamItemId === labels.duplicateOfStreamItemId && c.evidenceRef === labels.duplicateEvidenceRef && c.evidenceRef.trim())) {
        throw Error("标记重复项必须提供正向候选及其证据引用");
      }
      out.duplicateOfStreamItemId = labels.duplicateOfStreamItemId;
    }
    return out;
  }
}
function nonblank(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw Error(`${name} 必须是非空字符串`);
}
function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`${name} 必须是 ${min}..${max} 范围内的整数`);
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
