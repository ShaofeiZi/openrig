// OPR.0.4.6.WF5 FR-1：封闭的 exception taxonomy。
//
// EXCEPTION 只能属于以下三个 class 之一，每个 class 都是 recorded state 上的纯谓词。BR-1：
// 不做环境探测，engine 中不做判断；智能体判断只存在于 RESOLVING，而不是 detecting。扩展此
// taxonomy 属于约定变更，不由 driver 自行决定。
//
//   (a) unmapped_failed——未处理的 failed occurrence，包括串行 failed instance 或一个失败的
//       dependency branch。已映射的 `failed` exit 在同一事务中路由到 WF-2 remediation branch
//      （instance 保持 active），不属于 exception；只有未路由的 failed close 才是 exception，
//       包括 engine 编写的 max_hops 转换。即使其他独立 branch 仍存活，该 occurrence 仍需 owner。
//   (b) stuck_overdue——由 WF-1 FR-2 evaluator（workflow-deadline.ts，唯一 threshold 归属点）
//       判定超过 deadline 的 frontier packet。本模块逐字消费 verdict，不重新计算 anchor/threshold。
//   (c) human_gate_trip——到达 HUMAN target 的 WF-2 gate。WF-2 编译出的 park 本身就是
//       attention item，FR-2 不再生成第二项；此 class 让 item 携带 exception identity。
//
// HANDLER-ROLE 分界（spec-guard blocker 2，已批准）：handler-role gate-trip 不是 exception，
// 而是按设计确定的智能体 handoff。escalation 分支是 handler 后方的兜底：handler 自身 step
// 失败或卡住时，class (a)/(b) 会在该 step 上触发。
//
// v1.3：CLASSIFICATION ≠ ROUTING。maturity dial（workflow-exception-router.ts）负责把
// class 映射到 target；本模块完全不知道 destination。

import type { WorkflowDeadlineVerdict, WorkflowStepDeadlineEvidence } from "./workflow-deadline.js";
import type { WorkflowInstance } from "./workflow-types.js";

export const WORKFLOW_EXCEPTION_CLASSES = [
  "unmapped_failed",
  "stuck_overdue",
  "human_gate_trip",
] as const;
export type WorkflowExceptionClass = (typeof WORKFLOW_EXCEPTION_CLASSES)[number];

/**
 * OCCURRENCE 定义（唯一归属点；所有 dedup 与 new-occurrence 规则都以此为准）：一个
 * occurrence 是一次 (instance, step, class) failure EPISODE，以体现该 episode 的 packet 所记录
 * qitem id 为 key。同一未解决 episode 被重复检测时共享 key，并去重为一个 item；
 * resolve+resume 会关闭 occurrence，同一 step 之后的新 episode 携带新 packet id，因此是新的
 * occurrence，绝不会被已解决的历史吸收。
 *
 * key 是 recorded fact（架构 cell-2 裁定：identity = structured tags；额外列保留为 delivery
 * 可选方案，本次不采用）：
 *   (a) failed close 导致 instance 失败的 frontier packet
 *   (b) deadline evaluator evidence 点名的 overdue packet
 *   (c) park 到人类的已编译 gate packet
 */
export interface WorkflowExceptionIdentity {
  workflowName: string;
  instanceId: string;
  /** 只有 R2 之前、缺少 trail context 的 class (a) row 才可为 null。 */
  stepId: string | null;
  exceptionClass: WorkflowExceptionClass;
  /** 该 episode 记录的 packet id；参见 occurrence JSDoc。 */
  occurrenceKey: string;
}

export interface WorkflowException {
  identity: WorkflowExceptionIdentity;
  /** 携带证据的自然语言原因，随 item summary 传递。 */
  reason: string;
  /** class (b) 逐字携带 evaluator evidence；(a)/(c) 为 null。 */
  deadlineEvidence: WorkflowStepDeadlineEvidence | null;
}

/** class (a) 分类所需的最小 recorded-state view。调用方传入 failed close 的 recorded fact
 *（trail row / lastContinuationDecision）；本模块绝不查询。 */
export interface FailedInstanceView {
  instance: Pick<
    WorkflowInstance,
    "instanceId" | "workflowName" | "status" | "currentStepId" | "lastContinuationDecision"
  >;
  /** 以 failed 关闭的 step（失败 close 的 trail.step_id）。 */
  failedStepId: string | null;
  /** failed close 导致 instance 失败的 packet（trail.prior_qitem_id）。 */
  failedPacketId: string;
  /** 已记录的 failure note（如有），来自 resultNote / event reason。 */
  failureReason: string | null;
}

/**
 * class (a)：unmapped_failed。纯函数保证相同 view 重放 N 次仍得到相同分类。非 failed instance
 * 绝不分类；这是 mapped-failed 的负向保证：已路由到 branch 的 failure 保持 status=active，属于
 * 确定性 remediation，而不是 exception。
 */
export function classifyFailedInstance(view: FailedInstanceView): WorkflowException | null {
  if (view.instance.status !== "failed") return null;
  return classifyFailureOccurrence(view);
}

/** 从记录的未处理 failed close 构建 class (a)。dependency 调用方已经分类 exit/route；另一个
 * branch 可能让 instance 保持 active。已映射 remediation 的 exit 绝不能调用此 occurrence 构造器。 */
export function classifyFailureOccurrence(view: Omit<FailedInstanceView, "instance"> & {
  instance: Pick<WorkflowInstance, "instanceId" | "workflowName">;
}): WorkflowException {
  return {
    identity: {
      workflowName: view.instance.workflowName,
      instanceId: view.instance.instanceId,
      stepId: view.failedStepId,
      exceptionClass: "unmapped_failed",
      occurrenceKey: view.failedPacketId,
    },
    reason: view.failureReason
      ? `工作流步骤失败且没有补救分支：${view.failureReason}`
      : "工作流步骤失败且没有补救分支",
    deadlineEvidence: null,
  };
}

/**
 * class (b)：stuck_overdue。逐字消费 WF-1 evaluator verdict；唯一 threshold 归属点负责分类，
 * 本函数只把非 healthy verdict 提升为 exception 结构。healthy → null。
 */
export function classifyDeadlineVerdict(
  workflowName: string,
  verdict: WorkflowDeadlineVerdict,
): WorkflowException | null {
  if (verdict.state === "healthy" || !verdict.evidence) return null;
  const e = verdict.evidence;
  return {
    identity: {
      workflowName,
      instanceId: e.instanceId,
      stepId: e.stepId,
      exceptionClass: "stuck_overdue",
      occurrenceKey: e.packetId,
    },
    reason:
      `工作流步骤 ${e.stepId ?? "(未绑定)"} 处于 ${verdict.state}——packet ${e.packetId} ` +
      `由 ${e.ownerSession} 持有，已超过 ${e.anchor} anchor ${e.overdueBySeconds}s`,
    deadlineEvidence: e,
  };
}

/** 到达 gate 时的 recorded fact；compiled kind 是 WF-2 的 recorded output，不重新派生。 */
export interface GateTripView {
  workflowName: string;
  instanceId: string;
  gatedStepId: string;
  /** GateCompileResult.kind——"human" | "handler-role"。 */
  gateKind: "human" | "handler-role";
  /** 已编译 gate packet 的 qitem id。 */
  gatePacketId: string;
  /** packet 所 park 的人类席位；handler-role 时为 null。 */
  parkOn: string | null;
}

/**
 * class (c)：human_gate_trip，只处理 HUMAN target gate。HANDLER-ROLE 负向规则位于此处：
 * handler-role gate 返回 null，因为它是确定性 handoff 而非 exception；(a)/(b) 兜底覆盖 handler
 * 自身 step。class (c) 在 dial 上天然只面向人类。
 */
export function classifyGateTrip(view: GateTripView): WorkflowException | null {
  if (view.gateKind !== "human") return null;
  return {
    identity: {
      workflowName: view.workflowName,
      instanceId: view.instanceId,
      stepId: view.gatedStepId,
      exceptionClass: "human_gate_trip",
      occurrenceKey: view.gatePacketId,
    },
    reason: `受 gate 控制的步骤 ${view.gatedStepId} 需要人类决策` +
      (view.parkOn ? `（已停放在 ${view.parkOn}）` : ""),
    deadlineEvidence: null,
  };
}

/** tag prefix：`workflow:`/`instance:` 扩展正式 stamp，workflow-runtime.ts 与
 * workflow-projector.ts 已经发出它们；`step:`/`exception:`/`occurrence:` 是 WF-5 新增项
 *（架构 cell 2）。FR-2 dedup 与 FR-3 跨 channel one-count 通过查询这些 tag 进行 JOIN，
 * 绝不解析 summary。 */
export function workflowExceptionTags(identity: WorkflowExceptionIdentity): string[] {
  const tags = [
    "workflow-exception",
    `workflow:${identity.workflowName}`,
    `instance:${identity.instanceId}`,
    `exception:${identity.exceptionClass}`,
    `occurrence:${identity.occurrenceKey}`,
  ];
  if (identity.stepId) tags.splice(3, 0, `step:${identity.stepId}`);
  return tags;
}

/** occurrence 内 dedup 的查询 key：每个 tuple 对应一个 item。 */
export function occurrenceDedupKey(identity: WorkflowExceptionIdentity): string {
  return `${identity.instanceId}|${identity.stepId ?? ""}|${identity.exceptionClass}|${identity.occurrenceKey}`;
}
