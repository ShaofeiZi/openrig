// OPR.0.4.6.WF1 FR-4（G5）：启动恢复扫描——既有工作组/会话启动对账的工作流对应物。
//
// 此切片之前，后台服务启动时不会重新检查进行中的工作流实例：在提交后崩溃窗口中丢失的
// nudge 会永久丢失；由上一个进程武装的 keepalive（或 WF-1 之前从未武装）会保持失效；
// 卡住的实例也不会显现。每次启动时，此扫描同时补齐三类缺口：
//
//   1. 重新武装——确保每个 active|waiting 实例都有自己的 keepalive；操作幂等，并能修复
//      WF-1 前从未配置 keepalive 的实例。
//   2. 恢复丢失的 nudge——last_nudge_attempt 为 NULL 的 PENDING 前沿包已路由却从未 nudge
//      （后台服务在 scribe 提交后、提交后 nudge 前崩溃，即 FR-3 窗口）。启动时立即重新
//      nudge，而不是等待阈值，由此可证明工作仍然存活。
//   3. 截止时间评估——在每个实例的前沿运行 FR-2 评估器；逾期实例会被显式暴露
//      （日志 + 携带卡住指导的重新 nudge），绝不静默暂存。
//
// 扫描可观测：用一条汇总日志列出计数。没有进行中实例时不执行任何操作，也不产生状态副作用。
//
// 保持 BR-2：扫描只武装、nudge 和记录日志，绝不推进实例；project() 仍是唯一推进写路径。

import type { QueueRepository } from "./queue-repository.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import type { WorkflowInstanceStore } from "./workflow-instance-store.js";
import { evaluateStepDeadline } from "./workflow-deadline.js";
import type { EnsureStuckExceptionItem } from "./workflow-exception-escalation.js";
import { ensureWorkflowKeepaliveArmed } from "./workflow-keepalive-arming.js";

export interface WorkflowBootSweepResult {
  instancesSwept: number;
  keepalivesArmed: number;
  lostNudgesReissued: number;
  stuckSurfaced: number;
  /** OPR.0.4.6.WF5 FR-2 类别 (b)：本轮扫描创建的卡住异常条目数；去重的重复检测不计入。 */
  exceptionItemsCreated: number;
}

export interface WorkflowBootSweepDeps {
  instanceStore: WorkflowInstanceStore;
  queueRepo: QueueRepository;
  watchdogJobsRepo: WatchdogJobsRepository;
  log?: (line: string) => void;
  now?: () => Date;
  /** OPR.0.4.6.WF5 FR-2 类别 (b)：提供后，非健康截止判决会在检测时确保持久异常条目存在。
   * 该分支可跨崩溃且不会永久丢失，重新检测会重建遗漏条目。保持可选以兼容 WF-5 前的
   * 嵌入方；启动流程会接入真实闭包。失败不会中止扫描。 */
  ensureStuckExceptionItem?: EnsureStuckExceptionItem;
  reconcileStuckExceptions?: () => number;
}

export async function runWorkflowBootSweep(
  deps: WorkflowBootSweepDeps,
): Promise<WorkflowBootSweepResult> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const exceptionsClosed = deps.reconcileStuckExceptions?.() ?? 0;
  if (exceptionsClosed) log(`工作流启动扫描：已关闭 ${exceptionsClosed} 个已解决的逾期异常条目`);
  const instances = [
    ...deps.instanceStore.listByStatus("active"),
    ...deps.instanceStore.listByStatus("waiting"),
  ];
  const result: WorkflowBootSweepResult = {
    instancesSwept: instances.length,
    keepalivesArmed: 0,
    lostNudgesReissued: 0,
    stuckSurfaced: 0,
    exceptionItemsCreated: 0,
  };
  if (instances.length === 0) {
    log("工作流启动扫描：0 个进行中实例（无操作）");
    return result;
  }

  for (const instance of instances) {
    const packets = instance.currentFrontier
      .map((id) => deps.queueRepo.getById(id))
      .filter((p): p is NonNullable<typeof p> => p != null);

    // 1. 重新武装存活性。按包寻址的图为每个实时前沿包建立一个任务；旧版串行实例保留
    // 一个实例级任务。
    const boundPackets = packets.filter((packet) =>
      deps.instanceStore.getFrontierBinding(instance.instanceId, packet.qitemId) !== null,
    );
    const keepaliveTargets = boundPackets.length > 0
      ? boundPackets.map((packet) => ({ owner: packet.destinationSession, packetId: packet.qitemId }))
      : [{ owner: packets[0]?.destinationSession ?? instance.createdBySession, packetId: undefined }];
    for (const target of keepaliveTargets) {
      if (!target.owner || !target.owner.includes("@")) continue;
      const armed = ensureWorkflowKeepaliveArmed(deps.watchdogJobsRepo, {
        instanceId: instance.instanceId,
        packetId: target.packetId,
        targetSession: target.owner,
        registeredBySession: instance.createdBySession,
      });
      if (armed.newlyArmed) result.keepalivesArmed += 1;
    }

    // 2. 恢复丢失的 nudge：已路由但从未 nudge 的 pending 包。
    for (const packet of packets) {
      if (packet.state === "pending" && packet.lastNudgeAttempt === null) {
        result.lostNudgesReissued += 1;
        await deps.queueRepo.maybeNudge(
          packet.qitemId,
          packet.destinationSession,
          undefined,
          instance.createdBySession,
        );
      }
    }

    // 3. 截止时间评估。未认领前沿在这里是一等场景，绝不能对只扫描 in-progress 的
    // findOverdue 等逻辑不可见。
    const verdicts = packets.length > 0
      ? packets.map((packet) => {
          const binding = deps.instanceStore.getFrontierBinding(instance.instanceId, packet.qitemId);
          return evaluateStepDeadline(
            { ...instance, currentFrontier: [packet.qitemId], currentStepId: binding?.stepId ?? instance.currentStepId },
            [packet],
            now,
          );
        })
      : [evaluateStepDeadline(instance, packets, now)];
    for (const verdict of verdicts) {
      if (verdict.state === "healthy" || !verdict.evidence) continue;
      result.stuckSurfaced += 1;
      log(
        `工作流启动扫描：实例 ${instance.instanceId} 卡住（${verdict.state}）——步骤 ${verdict.evidence.stepId ?? "?"}，包 ${verdict.evidence.packetId}，所有者 ${verdict.evidence.ownerSession}，锚点 ${verdict.evidence.anchor}@${verdict.evidence.anchorAt}，逾期 ${verdict.evidence.overdueBySeconds} 秒`,
      );
      // 重新 nudge 逾期所有者。keepalive 会按自己的节奏继续触发；启动扫描负责立即唤醒。
      await deps.queueRepo.maybeNudge(
        verdict.evidence.packetId,
        verdict.evidence.ownerSession,
        undefined,
        instance.createdBySession,
      );
      // OPR.0.4.6.WF5 FR-2 类别 (b)：检测时确保持久异常条目存在。条目失败不是致命错误，
      // 不能破坏扫描其他分支；下次扫描会重新检测，这正是保证所在。
      if (deps.ensureStuckExceptionItem) {
        try {
          const ensured = await deps.ensureStuckExceptionItem({
            workflowName: instance.workflowName,
            workflowVersion: instance.workflowVersion,
            createdBySession: instance.createdBySession,
            verdict,
          });
          if (ensured.outcome === "created") result.exceptionItemsCreated += 1;
        } catch (err) {
          log(
            `工作流启动扫描：为 ${instance.instanceId} 确保异常条目失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  log(
    `工作流启动扫描：${result.instancesSwept} 个进行中实例——已武装 ${result.keepalivesArmed} 个 keepalive，重新发出 ${result.lostNudgesReissued} 个丢失 nudge，显现 ${result.stuckSurfaced} 个卡住实例，创建 ${result.exceptionItemsCreated} 个异常条目`,
  );
  return result;
}
