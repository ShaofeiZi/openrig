import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { EventBus } from "./event-bus.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "./policies/types.js";
import { artifactPoolReadyPolicy } from "./policies/artifact-pool-ready.js";
import { edgeArtifactRequiredPolicy } from "./policies/edge-artifact-required.js";
import { periodicReminderPolicy } from "./policies/periodic-reminder.js";
import { contextUsageThresholdPolicy } from "./policies/context-usage-threshold.js";
import {
  WatchdogJobsError,
  type WatchdogJob,
  type WatchdogJobsRepository,
} from "./watchdog-jobs-repository.js";
import type { WatchdogHistoryEntry, WatchdogHistoryLog } from "./watchdog-history-log.js";

/**
 * Watchdog 策略引擎（PL-004 阶段 C R1）。
 *
 * 负责逐次评估状态机，与 POC 引擎
 * `lib/engine.mjs`:
 *   1. 按名称从注册表解析策略。未知策略 → terminal。
 *   2. 将 spec_yaml 解析为顶层 `target:`、顶层 `message?:` 和嵌套的 `context:` 块，
 *      再使用解析后的目标对象构建 PolicyJob（规范未显式提供 `target:` 时，
 *      回退到已注册的 targetSession）。
 *   3. 分派 policy.evaluate(policyJob)。
 *   4. 操作处理：
 *      - skip：清除 actionable=false；仅当原因“响亮”（不在 QUIET_SKIP_REASONS 中）时，
 *        才记录历史并发出事件。
 *      - send：执行活跃唤醒节流。若 state.actionable 已为 true，且已设置
 *        active_wake_interval_seconds，并且自 last_fire_at 起尚未经过该时长 →
 *        发出/记录 `active_wake_not_due`（按 POC 静默跳过）。否则调用投递，
 *        以 sent 结果记录历史，发出 evaluation_fired，并设置 actionable=true。
 *      - terminal：将任务标记为终止，记录历史，并发出 terminal。
 *
 * `not_due` 轮询由上游调度器过滤，绝不会进入此引擎。
 */

export interface DeliveryRequest {
  targetSession: string;
  message: string;
  continuityAction?: {
    type: "create-cutover-baton";
    jobId: string;
    occupantGeneration: string;
    sourceSession: string;
    destination: string;
    body: string;
  };
}

export interface DeliveryOutcome {
  status: "ok" | "failed" | "retained";
  outboxIds?: string[];
  error?: string;
  /** 已持久创建或识别结构化连续性托管。 */
  continuityActionCompleted?: boolean;
}

export interface WatchdogDeliverySource {
  occurrenceId?: string;
  jobId: string;
  policy: string;
}

export type DeliveryFn = (
  req: DeliveryRequest,
  source: WatchdogDeliverySource,
) => Promise<DeliveryOutcome>;

export function formatWatchdogDeliveryMessage(
  source: WatchdogDeliverySource,
  message: string,
): string {
  return `[zrig watchdog 调度器 · 策略：${source.policy} · 任务：${source.jobId}]\n${message}`;
}

export interface PolicyContextParser {
  /**
   * 将操作者提供的 spec_yaml 解析为引擎所需的结构化字段。返回顶层 `target`（对象）、
   * 顶层 `message`（字符串）以及 `context:` 块（Record）。
   */
  (specYaml: string): {
    target: { session: string } | null;
    message: string | null;
    context: Record<string, unknown>;
  };
}

interface WatchdogPolicyEngineDeps {
  jobsRepo: WatchdogJobsRepository;
  historyLog: WatchdogHistoryLog;
  eventBus: EventBus;
  deliver: DeliveryFn;
  parseSpec?: PolicyContextParser;
  now?: () => Date;
  /**
   * PL-004 阶段 D 扩展点（根据切片 IMPL 经编排批准）：与阶段 C 内置策略一同注册的
   * 附加策略。用于注册 `workflow-keepalive`（它依赖阶段 D 的 workflow_instances
   * 数据库，因此必须在 daemon 启动时注入数据库句柄来构造）。
   */
  additionalPolicies?: Policy[];
  /**
   * (i-c) 触发时 target-generation 门禁。解析目标会话的实时 occupant-generation
   * （P12 `occupant_tenures`），当任务布防后目标已 handover 到另一 generation 时，拒绝
   * 绑定 generation 的唤醒（已设置 job.targetGeneration）。缺失 → 关闭门禁（任务照常触发）。
   * 返回 null = 未知 → 开放失败（投递）：保护动作是跳过，因此未知 target-generation
   * 绝不能跳过合法唤醒（note-2 反转）。
   */
  resolveTargetGeneration?: (sessionName: string) => string | null;
  /** 对持久化任务执行传输前的最后一道防线，其所属域可证明它们已不可操作。返回原因时
   *  终止任务且不投递；返回 null 时保留现有发送路径。 */
  resolvePreDeliveryTerminalReason?: (input: { jobId: string }) => string | null;
  /** 唤醒尝试的队列侧观察器。它会向为该任务布防的每个 HELD 行追加恢复证据；
   *  投递结果保持不变。 */
  resolveQueueWait?: (input: { jobId: string }) => PolicyEvaluation | null | undefined;
  onWakeAttempt?: (attempt: { jobId: string; deliveryStatus: string }) => void;
}

const PHASE_C_BUILTIN_POLICIES: ReadonlyArray<Policy> = [
  periodicReminderPolicy,
  artifactPoolReadyPolicy,
  edgeArtifactRequiredPolicy,
  contextUsageThresholdPolicy,
];

/**
 * 静默跳过原因——POC 的 `shouldAppendHistory`（engine.mjs:99-112）会从历史中抑制这些原因。
 * 为与 POC SSE 行为保持一致，同一集合也不得发出 watchdog.* 事件；agent 不应仅因池为空
 * 或唤醒节流生效就看到调度器轮询。
 */
const QUIET_SKIP_REASONS = new Set<string>([
  "not_due",
  "queue_wait_already_presented",
  "queue_wait_owner_working",
  "workflow_healthy_deadline_gated",
  "workflow_recovery_owns_notice",
  "workflow_deadline_already_presented",
  "no_actionable_artifacts",
  "no_missing_edge_artifacts",
  "active_wake_not_due",
  "context_usage_below_threshold",
  "threshold_receipt_stable",
  // OPR.0.4.3.16 idle-gate-qitem 常规空操作——类似 no_actionable_artifacts。
  // 从历史/SSE 中抑制，避免在无事可唤醒时每秒扫描刷屏。受审计的信号是 WAKE（fired）路径。
  "no_pending_gate",
  "seat_active",
  // OPR.0.5.8.1 S2 — 自已为受门控条件投递唤醒后，该条件没有实质变化。与同类原因一样
  // 保持静默：60 秒扫描不应每分钟写一行历史。即使没有历史行，仍可推导抑制状态——
  // 该行本身仍显示在 held/escalations 视图中（这里只抑制 WAKE，绝不抑制记录），
  // 且任务携带 `last_fired_condition`，即其触发时的精确条件。添加此字符串不会改变任何
  // 节流语义，也没有其他策略会发出它。
  "gate_condition_unchanged",
  // OPR.0.5.6.24 — parked-owner 消费者清洁扫描时的空操作：没有停放、关闭或延迟的内容。
  // 对其进行抑制，使常规 rig 扫描不写历史（响亮且受审计的信号是 SENT 唤醒、
  // episode-ended 和 all-parked-owners-deferred）。
  "no-parked-owner",
  // OPR.0.4.3.16 rev1-r1 回修（顾问裁定 2026-07-03）：seat_needs_input 和
  // activity_stale_unknown 是此策略目标场景的常见重复状态——某个 gate qitem 等待已陈旧/
  // 需要输入的 seat。此类 seat 永远不会变成 fresh-idle，因此从不触发发送节流；若保持响亮，
  // gate 持续待处理期间每次扫描都会无界地产生一行历史和一个 SSE，与切片的有界/不刷屏
  // 验收条件（BR6/AC2）相矛盾。在此静默处理可抑制这些常规不可唤醒状态的逐次扫描历史+SSE，
  // 同时保持操作者真正需要的 WAKE（send）路径响亮且受审计。卡住 seat 的可见性按需提供
  //（将待处理 gate qitem 映射到不可唤醒 seat），而非通过逐次扫描日志提供。
  "seat_needs_input",
  "activity_stale_unknown",
]);

export interface EvaluationResult {
  job: WatchdogJob;
  outcome: PolicyEvaluation | { action: "skip"; reason: "active_wake_not_due" };
  history: WatchdogHistoryEntry | null;
  delivery: DeliveryOutcome | null;
  /** 若本次评估生成了历史记录和事件，则为 true。 */
  meaningful: boolean;
}

export class WatchdogPolicyEngine {
  private readonly jobsRepo: WatchdogJobsRepository;
  private readonly historyLog: WatchdogHistoryLog;
  private readonly eventBus: EventBus;
  private readonly deliver: DeliveryFn;
  private readonly parseSpec: PolicyContextParser;
  private readonly now: () => Date;
  private readonly policies: Map<string, Policy>;
  private readonly resolveTargetGeneration?: (sessionName: string) => string | null;
  private readonly resolvePreDeliveryTerminalReason?: (input: { jobId: string }) => string | null;
  private readonly resolveQueueWait?: WatchdogPolicyEngineDeps["resolveQueueWait"];
  private readonly onWakeAttempt?: (attempt: { jobId: string; deliveryStatus: string }) => void;

  constructor(deps: WatchdogPolicyEngineDeps) {
    this.jobsRepo = deps.jobsRepo;
    this.historyLog = deps.historyLog;
    this.eventBus = deps.eventBus;
    this.deliver = deps.deliver;
    this.resolveTargetGeneration = deps.resolveTargetGeneration;
    this.resolvePreDeliveryTerminalReason = deps.resolvePreDeliveryTerminalReason;
    this.onWakeAttempt = deps.onWakeAttempt;
    this.resolveQueueWait = deps.resolveQueueWait;
    this.parseSpec = deps.parseSpec ?? parseWatchdogSpec;
    this.now = deps.now ?? (() => new Date());
    this.policies = new Map();
    for (const p of PHASE_C_BUILTIN_POLICIES) this.policies.set(p.name, p);
    if (deps.additionalPolicies) {
      for (const p of deps.additionalPolicies) this.policies.set(p.name, p);
    }
  }

  resolvePolicy(name: string): Policy | undefined {
    return this.policies.get(name);
  }

  async evaluate(job: WatchdogJob, evaluationPassStartedAt?: string): Promise<EvaluationResult> {
    const policy = this.resolvePolicy(job.policy);
    const evaluatedAt = this.now().toISOString();
    const receiptCutoffAt = evaluationPassStartedAt ?? evaluatedAt;

    if (!policy) {
      const reason = `unknown_policy:${job.policy}`;
      this.jobsRepo.markTerminal(job.jobId, reason);
      const history = this.historyLog.record({
        jobId: job.jobId,
        evaluatedAt,
        outcome: "terminal",
        skipReason: reason,
      });
      this.eventBus.emit({
        type: "watchdog.evaluation_terminal",
        jobId: job.jobId,
        policy: job.policy,
        terminalReason: reason,
      });
      return {
        job: this.jobsRepo.getByIdOrThrow(job.jobId),
        outcome: { action: "terminal", reason },
        history,
        delivery: null,
        meaningful: true,
      };
    }

    const parsed = this.parseSpec(job.specYaml);
    const isContextUsageThreshold = job.policy === "context-usage-threshold";
    const target = isContextUsageThreshold
      ? { session: job.targetSession }
      : (parsed.target ?? { session: job.targetSession });
    const occupantGeneration = isContextUsageThreshold
      ? (this.resolveTargetGeneration?.(job.targetSession) ?? null)
      : null;
    let watchedFilePath = job.watchedFilePath;
    let currentGenerationTranscriptPending = false;
    if (
      isContextUsageThreshold &&
      occupantGeneration &&
      job.watchedFileGeneration !== occupantGeneration
    ) {
      watchedFilePath = this.jobsRepo.findTranscriptPath(job.targetSession, occupantGeneration);
      if (watchedFilePath) {
        this.jobsRepo.recordWatchedFileBinding(job.jobId, watchedFilePath, occupantGeneration);
        this.historyLog.record({
          jobId: job.jobId,
          evaluatedAt,
          outcome: "skipped",
          skipReason: "watched_file_bound",
          evaluationNotes: {
            boundAt: evaluatedAt,
            occupantGeneration,
            watchedFilePath,
          },
        });
      } else {
        currentGenerationTranscriptPending = true;
      }
    }
    const requiredJob = job.requiresJobId ? this.jobsRepo.getById(job.requiresJobId) : null;
    const requiredReceiptGenerationMatched = occupantGeneration !== null &&
      requiredJob?.lastFiredGeneration === occupantGeneration;
    const requiredFireMs = Date.parse(requiredJob?.lastFireAt ?? "");
    const receiptCutoffMs = Date.parse(receiptCutoffAt);
    const receiptPredatesBoundary = evaluationPassStartedAt === undefined
      ? requiredFireMs <= receiptCutoffMs
      : requiredFireMs < receiptCutoffMs;
    const requiredReceiptSatisfied = !job.requiresJobId || (
      requiredReceiptGenerationMatched &&
      Number.isFinite(requiredFireMs) &&
      Number.isFinite(receiptCutoffMs) &&
      receiptPredatesBoundary
    );
    const requiredReceiptDeferred = Boolean(
      job.requiresJobId &&
      requiredReceiptGenerationMatched &&
      Number.isFinite(requiredFireMs) &&
      Number.isFinite(receiptCutoffMs) &&
      !receiptPredatesBoundary,
    );
    const policyJob: PolicyJob = {
      jobId: job.jobId,
      policy: job.policy,
      target,
      message: parsed.message ?? undefined,
      intervalSeconds: job.intervalSeconds,
      activeWakeIntervalSeconds: job.activeWakeIntervalSeconds,
      scanIntervalSeconds: job.scanIntervalSeconds,
      context: parsed.context,
      lastEvaluationAt: job.lastEvaluationAt,
      lastFireAt: job.lastFireAt,
      registeredBySession: job.registeredBySession,
      registeredAt: job.registeredAt,
      watchedFilePath,
      thresholdBytes: job.thresholdBytes,
      requiresJobId: job.requiresJobId,
      lastFiredGeneration: job.lastFiredGeneration,
      occupantGeneration,
      currentGenerationTranscriptPending,
      requiredReceiptSatisfied,
      requiredReceiptDeferred,
    };

    const outcome = this.resolveQueueWait?.({ jobId: job.jobId }) ?? await policy.evaluate(policyJob);

    if (outcome.action === "skip") {
      // 与 POC 保持一致：skip 会清除 actionable。是否记录并发出事件由响亮/静默决定。
      this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, false);
      this.jobsRepo.setActionable(job.jobId, false, evaluatedAt);
      const isQuiet = QUIET_SKIP_REASONS.has(outcome.reason);
      if (isQuiet) {
        return {
          job: this.jobsRepo.getByIdOrThrow(job.jobId),
          outcome,
          history: null,
          delivery: null,
          meaningful: false,
        };
      }
      const history = this.historyLog.record({
        jobId: job.jobId,
        evaluatedAt,
        outcome: "skipped",
        skipReason: outcome.reason,
        evaluationNotes: outcome.notes ?? null,
      });
      this.eventBus.emit({
        type: "watchdog.evaluation_skipped",
        jobId: job.jobId,
        policy: job.policy,
        skipReason: outcome.reason,
      });
      return {
        job: this.jobsRepo.getByIdOrThrow(job.jobId),
        outcome,
        history,
        delivery: null,
        meaningful: true,
      };
    }

    if (outcome.action === "terminal") {
      this.jobsRepo.markTerminal(job.jobId, outcome.reason);
      const history = this.historyLog.record({
        jobId: job.jobId,
        evaluatedAt,
        outcome: "terminal",
        skipReason: outcome.reason,
        evaluationNotes: outcome.notes ?? null,
      });
      this.eventBus.emit({
        type: "watchdog.evaluation_terminal",
        jobId: job.jobId,
        policy: job.policy,
        terminalReason: outcome.reason,
      });
      return {
        job: this.jobsRepo.getByIdOrThrow(job.jobId),
        outcome,
        history,
        delivery: null,
        meaningful: true,
      };
    }

    // outcome.action === "send"。
    // POC 活跃唤醒节流（engine.mjs:49-64, :243-263）：
    //   - 若 state.actionable 已为 true，且已设置 active_wake_interval，并且唤醒窗口尚未经过
    //     → 静默跳过。保留现有 last_fire_at 和 last_actionable_at。
    //   - 否则：投递，设置 actionable=true，写入 last_fire_at + last_actionable_at
    //     （保留现有的首次可操作时间戳）。
    if (
      job.actionable &&
      job.activeWakeIntervalSeconds !== null &&
      job.lastFireAt !== null
    ) {
      const lastFireMs = Date.parse(job.lastFireAt);
      const nowMs = Date.parse(evaluatedAt);
      const intervalMs = job.activeWakeIntervalSeconds * 1000;
      if (Number.isFinite(lastFireMs) && nowMs - lastFireMs < intervalMs) {
        // 静默跳过：已完成扫描，池仍可操作，但唤醒窗口尚未开放。更新 last_evaluation_at，
        // 不触碰 last_fire_at，保持 actionable=true 并保留 last_actionable_at。
        this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, false);
        this.jobsRepo.setActionable(job.jobId, true, evaluatedAt, job.lastActionableAt);
        return {
          job: this.jobsRepo.getByIdOrThrow(job.jobId),
          outcome: { action: "skip", reason: "active_wake_not_due" },
          history: null,
          delivery: null,
          meaningful: false,
        };
      }
    }

    // (i-c) 触发时 target-generation 门禁。绑定 generation 的唤醒（已设置 job.targetGeneration）
    // 不得发往任务布防后已 handover 到另一实时 generation 的目标。绑定 role 的任务（null）
    // 跳过门禁 → 保持原样触发。实时 generation 未知（null）时开放失败 → 投递
    //（保护动作是跳过，因此未知值绝不能跳过——note-2）。只有已解析的不匹配会响亮地跳过
    //（响亮原因 → 记录并发出事件），并通过结构化审计列出两个 generation。
    if (job.targetGeneration !== null && this.resolveTargetGeneration) {
      const liveGeneration = this.resolveTargetGeneration(outcome.target.session);
      if (liveGeneration !== null && liveGeneration !== job.targetGeneration) {
        const reason = "target_generation_mismatch";
        this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, false);
        this.jobsRepo.setActionable(job.jobId, false, evaluatedAt);
        const history = this.historyLog.record({
          jobId: job.jobId,
          evaluatedAt,
          outcome: "skipped",
          skipReason: reason,
          evaluationNotes: {
            armedForGeneration: job.targetGeneration,
            liveGeneration,
            targetSession: outcome.target.session,
          },
        });
        this.eventBus.emit({
          type: "watchdog.evaluation_skipped",
          jobId: job.jobId,
          policy: job.policy,
          skipReason: reason,
        });
        return {
          job: this.jobsRepo.getByIdOrThrow(job.jobId),
          outcome: { action: "skip", reason },
          history,
          delivery: null,
          meaningful: true,
        };
      }
    }

    // OPR.0.5.8.1 S1c — 当前队列转换会在每个出口退役 park 定时器。此窄范围的传输前守卫
    // 只处理旧版持久化残留：该行已经 terminal，且已无可拦截的转换。它在常规策略、节流和
    // generation 决策之后运行，但早于任何托管或消息投递副作用。
    const preDeliveryTerminalReason = this.resolvePreDeliveryTerminalReason?.({ jobId: job.jobId });
    if (preDeliveryTerminalReason) {
      this.jobsRepo.markTerminal(job.jobId, preDeliveryTerminalReason);
      const history = this.historyLog.record({
        jobId: job.jobId,
        evaluatedAt,
        outcome: "terminal",
        skipReason: preDeliveryTerminalReason,
      });
      this.eventBus.emit({
        type: "watchdog.evaluation_terminal",
        jobId: job.jobId,
        policy: job.policy,
        terminalReason: preDeliveryTerminalReason,
      });
      return {
        job: this.jobsRepo.getByIdOrThrow(job.jobId),
        outcome: { action: "terminal", reason: preDeliveryTerminalReason },
        history,
        delivery: null,
        meaningful: true,
      };
    }

    const continuityAction = parseContinuityAction(
      parsed.context["continuity_action"],
      job,
      occupantGeneration,
    );

    // 普通唤醒保留已验证的至多一次顺序。结构化连续性托管凭借确定性 qitem id 可安全重试，
    // 因此其回执要等持久操作完成后再写入。
    if (isContextUsageThreshold && occupantGeneration && !continuityAction) {
      this.jobsRepo.recordThresholdFire(job.jobId, occupantGeneration, evaluatedAt);
    }
    const delivery = await this.deliver(
      {
        targetSession: outcome.target.session,
        message: outcome.message,
        ...(continuityAction ? { continuityAction } : {}),
      },
      { jobId: job.jobId, policy: job.policy, occurrenceId: createHash("sha256").update(JSON.stringify([job.jobId, occupantGeneration, outcome.conditionReceipt ?? (job.policy === "periodic-reminder" ? job.lastFireAt : outcome.message)])).digest("hex") },
    );
    if (
      isContextUsageThreshold &&
      occupantGeneration &&
      continuityAction &&
      delivery.continuityActionCompleted === true
    ) {
      this.jobsRepo.recordThresholdFire(job.jobId, occupantGeneration, evaluatedAt);
    }
    const history = this.historyLog.record({
      jobId: job.jobId,
      evaluatedAt,
      outcome: delivery.status === "retained" ? "skipped" : "sent",
      skipReason: delivery.status === "retained" ? "typing_guard_retained" : null,
      deliveryTargetSession: outcome.target.session,
      deliveryStatus: delivery.status,
      deliveryMessage: outcome.message,
      // OPR.0.5.6.24 — 投递错误/原因字符串会保留到持久记录中，使策略能够区分交互式
      // 提示拒绝和一般故障（仅凭 status 会丢失该身份）。
      evaluationNotes:
        delivery.error !== undefined
          ? { ...(outcome.notes ?? {}), deliveryReason: delivery.error }
          : delivery.status === "retained" ? { ...(outcome.notes ?? {}), outboxIds: delivery.outboxIds ?? [], retainedNotDelivered: true } : outcome.notes ?? null,
    });
    if (!isContextUsageThreshold) {
      this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, true);
    }
    // OPR.0.5.8.1 S2 — 只有明确投递成功后才保存策略的条件回执。`status` 为 "ok" |
    // "failed"；凡非明确 ok 的结果都不触碰回执，以便下次扫描重试。未提出回执的策略
    // 不受此逻辑影响，因此其他策略的行为不会改变。
    if (outcome.conditionReceipt !== undefined && delivery.status === "ok") {
      this.jobsRepo.recordConditionReceipt(job.jobId, outcome.conditionReceipt);
    }
    this.jobsRepo.setActionable(job.jobId, true, evaluatedAt, job.lastActionableAt);
    this.eventBus.emit({
      type: "watchdog.evaluation_fired",
      jobId: job.jobId,
      policy: job.policy,
      targetSession: outcome.target.session,
      deliveryStatus: delivery.status,
    });
    this.onWakeAttempt?.({ jobId: job.jobId, deliveryStatus: delivery.status });
    return {
      job: this.jobsRepo.getByIdOrThrow(job.jobId),
      outcome,
      history,
      delivery,
      meaningful: true,
    };
  }
}

function parseContinuityAction(
  raw: unknown,
  job: WatchdogJob,
  occupantGeneration: string | null,
): DeliveryRequest["continuityAction"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value["type"] !== "create-cutover-baton") return undefined;
  if (
    !occupantGeneration ||
    typeof value["destination"] !== "string" ||
    typeof value["body"] !== "string"
  ) {
    throw new Error(`continuity_action_invalid: ${job.jobId}`);
  }
  return {
    type: "create-cutover-baton",
    jobId: job.jobId,
    occupantGeneration,
    sourceSession: job.targetSession,
    destination: value["destination"],
    body: value["body"],
  };
}

/** 在操作者编写的 watchdog YAML 进入持久化层之前解析它。 */
export function parseWatchdogSpec(specYaml: string): {
  target: { session: string } | null;
  message: string | null;
  context: Record<string, unknown>;
} {
  let parsed: unknown;
  try {
    parsed = parseYaml(specYaml);
  } catch (err) {
    throw new WatchdogJobsError(
      "spec_invalid",
      `watchdog 规范包含无效 YAML：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new WatchdogJobsError("spec_invalid", "watchdog 规范必须是 YAML 映射");
  }

  const rawMessage = parsed["message"];
  if (rawMessage !== undefined && rawMessage !== null && typeof rawMessage !== "string") {
    throw new WatchdogJobsError("spec_invalid", "watchdog 规范字段 'message' 必须是字符串");
  }

  const rawContext = parsed["context"];
  if (rawContext !== undefined && rawContext !== null && !isRecord(rawContext)) {
    throw new WatchdogJobsError("spec_invalid", "watchdog 规范字段 'context' 必须是映射");
  }
  const context = isRecord(rawContext) ? rawContext : {};
  if (
    context["message"] !== undefined &&
    context["message"] !== null &&
    typeof context["message"] !== "string"
  ) {
    throw new WatchdogJobsError("spec_invalid", "watchdog 规范字段 'context.message' 必须是字符串");
  }

  const rawTarget = parsed["target"];
  let target: { session: string } | null = null;
  if (typeof rawTarget === "string") {
    target = { session: rawTarget };
  } else if (rawTarget !== undefined && rawTarget !== null) {
    if (!isRecord(rawTarget) || typeof rawTarget["session"] !== "string") {
      throw new WatchdogJobsError(
        "spec_invalid",
        "watchdog 规范字段 'target' 必须是会话字符串，或带字符串 'session' 的映射",
      );
    }
    target = { session: rawTarget["session"] };
  }

  return {
    target,
    message: typeof rawMessage === "string" ? rawMessage : null,
    context,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
