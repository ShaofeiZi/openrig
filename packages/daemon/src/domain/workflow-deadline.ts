// OPR.0.4.6.WF1 FR-2：步骤截止时间评估器（纯函数）。
//
// 关闭 G1——0.4.3 的失效席位问题：在此切片之前，失效或已压缩的席位会让工作流步骤永久停驻，
// 因为工作流 domain 中没有任何截止时间。本评估器根据系统已记录的队列机制，为实例派生
// stuck/overdue 判定；不引入新时钟、新存储状态或队列层变更。
//
// STUCK 是派生状态，绝不存储（ACK 计划提交 2）：每个调用方（keepalive 策略、启动 sweep、
// list/show/trace 表面）都根据（instance、frontier packets、now）重新计算判定；因此正常重新投影
// 会自行清除 stuck 标记（FR-2 AC），不会产生陈旧状态。BR-1 保持成立：本评估器仅由可观测性
// 与 nudge 路径消费，绝不参与路由决策。
//
// 锚点分类（架构 gate-leg 裁定与第三状态说明，Rev-1；由 mode2-tier 来源发现扩展，
// 2026-07-06 已向架构方标记）：
//
//   1. 已认领且有截止时间：state=in-progress，并设置 closure_required_at
//      （仅在认领时计算，queue-repository.ts:858-870）。锚点 = closure_required_at。
//      注意：工作流步骤 packet 使用 tier "mode2"，它没有 TIER_SLA_SECONDS 条目，
//      因此当前工作流 packet 中此子状态为空；仍保留它，因为 tier 一旦变化，这就是如实锚点，
//      评估器绝不能静默忽略真实 closure_required_at。
//   2. 已认领但无截止时间：state=in-progress，closure_required_at 为 NULL（mode2 现状）。
//      锚点 = claimed_at + WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS。
//   3. 从未认领：state=pending，且从未被认领（认领前席位失效/丢失 nudge 的场景：
//      projector 在事务内以 PENDING 创建下一个 packet，提交后才 nudge，因此失效 owner
//      会使它永久未认领）。锚点 = created_at + threshold。
//   4. 认领后取消认领（架构第三状态）：取消认领后 state=pending，同时把 claimed_at 与
//      closure_required_at 置为 NULL（queue-repository.ts:908-917），使该行无法与从未认领区分。
//      锚点 = created_at + threshold，并刻意包含已认领期间经过的时间，因此 packet 可能在取消认领后
//      立即显示 overdue。这个方向是安全的（早期 nudge 噪声优于静默停驻；BR-4 不阻塞任何内容）。
//      认领历史仍可从 queue_transitions 恢复；渲染证据的调用方可从中补充。
//
// `blocked` frontier packet（等待中的 park）在此视为 HEALTHY：park 是如实记录的状态，
// waiting 实例已经符合 keepalive 条件；park 时长策略属于 WF-5。

// 结构化视图：评估器只需要这些字段，因此调用方可按结构满足要求，无需伪造完整对象；
// projector 相邻表面传入完整 WorkflowInstance/QueueItem，keepalive 策略传入自己的最小行映射。
export interface DeadlineInstanceView {
  instanceId: string;
  status: string;
  currentFrontier: string[];
  currentStepId: string | null;
}

export interface DeadlinePacketView {
  qitemId: string;
  state: string;
  destinationSession: string;
  tsCreated: string;
  claimedAt: string | null;
  closureRequiredAt: string | null;
}

/**
 * 唯一阈值归属位置（架构 gate-leg 裁定：导出，并记录为此数值唯一存放处；
 * WF-5 的 class-(b) stuck/overdue 阈值按裁定绑定此常量，绝不另行定义）。
 *
 * 派生依据：已交付的 routine-tier SLA（hot-potato-enforcer.ts 中
 * TIER_SLA_SECONDS.routine = 4h；该值在模块内私有，因此在此重述而不导入，本句即派生说明）。
 * 工作流步骤 packet 使用没有 SLA 条目的 tier "mode2"，因此此常量是未认领锚点和
 * 已认领但截止时间为空锚点的有效截止时间。
 */
export const WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS = 4 * 60 * 60;

export type WorkflowStepDeadlineState =
  | "healthy"
  | "overdue-claimed"
  | "overdue-unclaimed";

export interface WorkflowStepDeadlineEvidence {
  instanceId: string;
  /** 实例持久的当前步骤绑定（R2 之前可为 null）。 */
  stepId: string | null;
  packetId: string;
  ownerSession: string;
  packetState: string;
  /** 用于分类此 packet 的锚点（见 JSDoc 分类）。 */
  anchor: "closure_required_at" | "claimed_at" | "created_at";
  /** 锚点指向的 ISO 时间戳（截止时间或锚点起点）。 */
  anchorAt: string;
  /** 超出有效截止时间的秒数（overdue 时 >= 0）。 */
  overdueBySeconds: number;
  /** packet 自创建起的年龄，单位秒。 */
  ageSeconds: number;
  /** 行仍携带 claimed_at 时的值（子状态 1/2）。 */
  claimedAt: string | null;
}

export interface WorkflowDeadlineVerdict {
  state: WorkflowStepDeadlineState;
  /** 当且仅当 state != healthy 时存在。 */
  evidence: WorkflowStepDeadlineEvidence | null;
}

/**
 * 根据截止时间模型评估一个实例的 frontier。纯函数：
 * (instance, packets, now) -> verdict。`packets` 是 instance.currentFrontier 对应的队列行；
 * 缺失行会被忽略，因为无法再解析的 frontier id 属于另一类损坏，由其他位置守卫。
 *
 * 只有 `active` 与 `waiting` 实例可能 overdue；终态实例始终健康，因为没有可 nudge 的内容。
 */
export function evaluateStepDeadline(
  instance: DeadlineInstanceView,
  packets: Array<DeadlinePacketView | null | undefined>,
  now: Date,
): WorkflowDeadlineVerdict {
  if (instance.status !== "active" && instance.status !== "waiting") {
    return { state: "healthy", evidence: null };
  }
  const nowMs = now.getTime();
  const thresholdMs = WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS * 1000;

  for (const packet of packets) {
    if (!packet) continue;
    if (!instance.currentFrontier.includes(packet.qitemId)) continue;

    if (packet.state === "in-progress") {
      // 子状态 1 + 2：已认领。
      const deadlineMs = packet.closureRequiredAt
        ? new Date(packet.closureRequiredAt).getTime()
        : packet.claimedAt
          ? new Date(packet.claimedAt).getTime() + thresholdMs
          : new Date(packet.tsCreated).getTime() + thresholdMs;
      if (nowMs >= deadlineMs) {
        return {
          state: "overdue-claimed",
          evidence: buildEvidence(instance, packet, nowMs, {
            anchor: packet.closureRequiredAt
              ? "closure_required_at"
              : packet.claimedAt
                ? "claimed_at"
                : "created_at",
            anchorAt:
              packet.closureRequiredAt ??
              packet.claimedAt ??
              packet.tsCreated,
            deadlineMs,
          }),
        };
      }
    } else if (packet.state === "pending") {
      // 子状态 3 + 4：从未认领或认领后取消。取消认领把 claimed_at 置为 NULL 后，
      // 两者在行层面不可区分，因此都有意以 created_at 为锚点。
      const deadlineMs = new Date(packet.tsCreated).getTime() + thresholdMs;
      if (nowMs >= deadlineMs) {
        return {
          state: "overdue-unclaimed",
          evidence: buildEvidence(instance, packet, nowMs, {
            anchor: "created_at",
            anchorAt: packet.tsCreated,
            deadlineMs,
          }),
        };
      }
    }
    // `blocked`（等待 park）以及 frontier 上任何已关闭状态，按分类均视为健康。
  }
  return { state: "healthy", evidence: null };
}

function buildEvidence(
  instance: DeadlineInstanceView,
  packet: DeadlinePacketView,
  nowMs: number,
  input: {
    anchor: WorkflowStepDeadlineEvidence["anchor"];
    anchorAt: string;
    deadlineMs: number;
  },
): WorkflowStepDeadlineEvidence {
  return {
    instanceId: instance.instanceId,
    stepId: instance.currentStepId,
    packetId: packet.qitemId,
    ownerSession: packet.destinationSession,
    packetState: packet.state,
    anchor: input.anchor,
    anchorAt: input.anchorAt,
    overdueBySeconds: Math.max(0, Math.floor((nowMs - input.deadlineMs) / 1000)),
    ageSeconds: Math.max(
      0,
      Math.floor((nowMs - new Date(packet.tsCreated).getTime()) / 1000),
    ),
    claimedAt: packet.claimedAt,
  };
}

/**
 * FR-6（G4）辅助函数：以有效基线（架构 N1 裁定）为依据比较 max_hops。
 * v1 固定 baseline = 0（MAX_HOPS_BASELINE_V1）；WF-5 FR-4 的 resume 随后会调整基线，
 * 使每次 redrive 获得一个有界窗口。本辅助函数就是该接缝，绝不硬绑定到生命周期总数。
 *
 * 再执行一次 hop 将超过守卫时返回 true。
 */
export const MAX_HOPS_BASELINE_V1 = 0;

export function exceedsMaxHops(
  hopCount: number,
  baseline: number,
  maxHops: number | undefined,
): boolean {
  // Guard blocker 2 加固：只比较可执行的守卫。解析器今后会拒绝畸形值；此检查用于保护修复前
  // 缓存的 spec_json blob（string 会静默地永不触发，null 会转换为 0 并始终触发）。
  if (typeof maxHops !== "number" || !Number.isInteger(maxHops) || maxHops < 1) {
    return false;
  }
  return hopCount + 1 - baseline > maxHops;
}
