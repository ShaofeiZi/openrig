import { findQueueRecovery, recoveryId, recoveryTag } from "./queue-recovery.js";
// OPR.0.4.6.WF5 FR-2 类别 (b)：为 STUCK/OVERDUE instance 生成 detection-time exception item。
//
// 类别 (b) 没有可依附的 state-change transaction；item 在检测时由 sweep/keepalive evaluation
// 创建。其不丢失保证来自 WF-1 可跨崩溃存活的 sweep：重新检测会在下一轮重建遗漏 item
//（遵循 P2 cleanup：此处不声明也不实现 same-transaction 保证）。
//
// 既有 diagnostic 行携带底层 obligation tag。timer、ladder 与 sweep 收敛到同一 recovery。
// 未变化的重新检测既不发送，也不追加 transition；closed disposition 保持成立，直到新的 meaningful
// source transition 或真实投递失败创建新 episode。旧版 occurrence tag 仍可读取，无需重写历史行。
//
// policy shape 保持不变（X5 成立：PolicyEvaluation 仍为 send|skip|terminal）。keepalive 将此注入
// helper 作为既有 evaluation 的副作用调用，sweep 同理；按 validateRig 先例在启动时注入。

import type Database from "better-sqlite3";
import { QueueRepositoryError, type QueueRepository } from "./queue-repository.js";
import type { WorkflowDeadlineVerdict } from "./workflow-deadline.js";
import {
  classifyDeadlineVerdict,
  workflowExceptionTags,
  type WorkflowExceptionClass,
} from "./workflow-exception.js";
import type { ExceptionRoute } from "./workflow-exception-router.js";
import { workflowHumanDestination, type WorkflowHumanDestination } from "./workflow-human-destination.js";

export interface EnsureStuckExceptionInput {
  workflowName: string;
  workflowVersion: string;
  /** 记录为 item source 的会话，即 instance creator；它是真实且已校验的会话，detector 是机制，
   *  不是席位。 */
  createdBySession: string;
  verdict: WorkflowDeadlineVerdict;
}

export interface EnsureStuckExceptionResult {
  outcome: "skipped-healthy" | "deduped" | "created";
  qitemId?: string;
}

export type EnsureStuckExceptionItem = (
  input: EnsureStuckExceptionInput,
) => Promise<EnsureStuckExceptionResult>;

export interface StuckExceptionDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  /** cached spec 的 maturity-dial 解析，由 runtime 拥有；spec lookup 与已交付 role resolution
   *  均位于该处。null 表示 spec 未缓存，此时应用 registered-human selection。
   *  OPR.0.4.6.FAC1（arch Q3）：boundRig 是 stuck instance 绑定的工作组，在检测时从
   *  workflow_instances 读取，使 orchestrator-role dial position 能按 capability 解析。 */
  resolveRoute: (
    workflowName: string,
    workflowVersion: string,
    exceptionClass: WorkflowExceptionClass,
    boundRig?: string | null,
  ) => ExceptionRoute | null;
  humanFallbackSeat?: WorkflowHumanDestination;
  log?: (line: string) => void;
}

export function makeEnsureStuckExceptionItem(deps: StuckExceptionDeps): EnsureStuckExceptionItem {
  const log = deps.log ?? (() => {});
  return async (input: EnsureStuckExceptionInput): Promise<EnsureStuckExceptionResult> => {
    const exception = classifyDeadlineVerdict(input.workflowName, input.verdict);
    if (!exception) return { outcome: "skipped-healthy" };

    const previous = findQueueRecovery(deps.db, exception.deadlineEvidence!.packetId);
    if (previous) return { outcome: "deduped", qitemId: previous.qitemId };

    // 保留历史 occurrence 行及其 closed disposition。现代行已通过上方当前 source episode 解析。
    const open = deps.db
      .prepare(
        `SELECT qitem_id, destination_session FROM queue_items
         WHERE json_valid(tags)
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'exception:stuck_overdue')
           AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)` ,
      )
      .get(
        `occurrence:${exception.identity.occurrenceKey}`,
        `instance:${exception.identity.instanceId}`,
        `workflow:${exception.identity.workflowName}`,
        recoveryTag(exception.deadlineEvidence!.packetId),
      ) as { qitem_id: string; destination_session: string } | undefined;
    if (open) {
      // 同一 unresolved episode 被重新检测时，只重新 nudge 唯一 item；尽力而为，持久 item 才是保证。
      return { outcome: "deduped", qitemId: open.qitem_id };
    }

    // OPR.0.4.6.FAC1（arch Q3）：每个 exception item 都是在自身检测时刻作出的全新 routing decision，
    // 因此现在读取 stuck instance 的 bound rig。读取失败不能证明 instance 未绑定；在任何 routing
    // 或队列写入前传播错误。
    let detectionBoundRig: string | null = null;
    const stuckInstanceId = exception.deadlineEvidence?.instanceId;
    if (stuckInstanceId) {
      const row = deps.db
        .prepare(`SELECT bound_rig FROM workflow_instances WHERE instance_id = ?`)
        .get(stuckInstanceId) as { bound_rig: string | null } | undefined;
      detectionBoundRig = row?.bound_rig ?? null;
    }
    const route =
      deps.resolveRoute(input.workflowName, input.workflowVersion, "stuck_overdue", detectionBoundRig) ?? {
        position: "fallback" as const,
        destinationSession: workflowHumanDestination(deps.humanFallbackSeat),
        tier: "human-gate",
        humanRouted: true,
        resolvedVia: "engine-default" as const,
      };
    const e = exception.deadlineEvidence!;
    const evidenceRef = `zrig workflow trace ${e.instanceId}`;
    const body =
      `工作流异常（stuck_overdue）\n` +
      `workflow: ${input.workflowName} v${input.workflowVersion}\n` +
      `instance: ${e.instanceId}\n` +
      `step: ${e.stepId ?? "（未绑定）"}——packet ${e.packetId} 由 ${e.ownerSession} 持有（${e.packetState}）\n` +
      `deadline: 已超过 ${e.anchor} 锚点 ${e.overdueBySeconds}s（${e.anchorAt}）；packet age ${e.ageSeconds}s\n` +
      `reason: ${exception.reason}\n` +
      `evidence: ${evidenceRef}\n` +
      `resolve: 检查当前 owner 与 deadline；仅凭 packet age 不能证明 idle。instance 离开 exception 状态后，此 item 会清除。`;
    const createItem = (destination: string, tier: string) =>
      deps.queueRepo.create({
        qitemId: recoveryId(deps.db, e.packetId),
        sourceSession: input.createdBySession,
        destinationSession: destination,
        body,
        priority: "urgent",
        tier,
        tags: [...workflowExceptionTags(exception.identity), recoveryTag(e.packetId)],
        summary: exception.reason,
        evidenceRef,
      });
    let created;
    try {
      created = await createItem(route.destinationSession, route.tier);
    } catch (error) {
      if (!(error instanceof QueueRepositoryError) || error.code !== "unknown_destination_rig" || route.humanRouted) throw error;
      // 智能体工作组不可用时，可使用已注册人员 fallback。其他 admission/storage 失败保留原始诊断。
      created = await createItem(workflowHumanDestination(deps.humanFallbackSeat), "human-gate");
    }
    log(
      `工作流异常：已为 instance ${e.instanceId} 创建 stuck_overdue item ${created.qitemId}（step ${e.stepId ?? "?"}，${route.position}）`,
    );
    return { outcome: "created", qitemId: created.qitemId };
  };
}
