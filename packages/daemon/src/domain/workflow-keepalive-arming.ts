// OPR.0.4.6.WF1 FR-3（G2）：自动启用已发布的 workflow-keepalive 策略。
// 策略虽在启动时注册，却没有任何逻辑创建携带 context.workflow_instance_id 的
// watchdog job，因此 keepalive 从未对任何实例触发。
//
// 启用过程随事务书记员执行：实例化与每次移交投影都在路由步骤的同一个
// db.transaction 内调用 ensureWorkflowKeepaliveArmed；watchdog 的 register/markTerminal
// 只是同一句柄上的普通 INSERT/UPDATE，已验证可组合。这样关闭了“提交后、推动前崩溃”的窗口：
// 已启用 job 与已路由前沿 packet 同时存在，即便后台服务在推动前退出，keepalive 也会重新发出
// 丢失的提交后推动（FR-3 AC；启动扫描 FR-4 是同一闭环中重启后立即执行的一环）。
//
// 对按 packet 寻址的依赖图，每个活动 packet 对应一个 job；旧版串行实例保留原来的
// 每实例一个 job 形状。策略每次评估都从 SQLite 实时解析被寻址 packet 的所有者，
// target_session 则保留为已注册回退。
//
// 自动启用的 job 受截止时间门控（context.deadline_gated: true）：实例健康时策略保持静默，
// 仅在 FR-2 评估器报告逾期时发送，从而保留 FR-2“正常路径零噪声”的验收要求。
// 操作员注册的 keepalive job（无该标志）仍保持已发布 POC 的始终发送行为。

import type {
  WatchdogJob,
  WatchdogJobsRepository,
} from "./watchdog-jobs-repository.js";

/**
 * 自动启用 keepalive job 的评估周期。截止时间门控的评估在逾期前都会静默跳过，
 * 因此正常路径上此周期没有记录开销；静默跳过甚至不会写入 watchdog 历史。
 */
export const WORKFLOW_KEEPALIVE_AUTO_INTERVAL_SECONDS = 15 * 60;

export function buildKeepaliveSpecYaml(instanceId: string, targetSession: string, packetId?: string): string {
  return [
    "policy: workflow-keepalive",
    "target:",
    `  session: ${targetSession}`,
    "context:",
    `  workflow_instance_id: ${instanceId}`,
    ...(packetId ? [`  workflow_packet_id: ${packetId}`] : []),
    "  deadline_gated: true",
    "",
  ].join("\n");
}

/**
 * 查找携带此实例 ID 的活动自动/手动 keepalive job。job 仅在 spec_yaml 中携带上下文
 *（没有 context 列）；ULID 是唯一的 26 字符值，因此包含检查在实践中精确可靠。
 */
export function findArmedKeepaliveJob(
  repo: WatchdogJobsRepository,
  instanceId: string,
  packetId?: string,
): WatchdogJob | null {
  return (
    repo
      .listActive()
      .find(
        (j) => {
          if (j.policy !== "workflow-keepalive") return false;
          if (!j.specYaml.includes(`workflow_instance_id: ${instanceId}`)) return false;
          const packetLine = /(?:^|\n)\s*workflow_packet_id:\s*(\S+)/.exec(j.specYaml)?.[1];
          return packetId ? packetLine === packetId : packetLine === undefined;
        },
      ) ?? null
  );
}

/**
 * 事务内幂等启用：不存在活动 job 时，注册被寻址 packet 的 keepalive
 *（或旧版实例 keepalive）。可在书记员事务中组合，因为 register 只是普通 INSERT。
 */
export function ensureWorkflowKeepaliveArmed(
  repo: WatchdogJobsRepository,
  input: {
    instanceId: string;
    targetSession: string;
    registeredBySession: string;
    packetId?: string;
  },
): { jobId: string; newlyArmed: boolean } {
  const existing = findArmedKeepaliveJob(repo, input.instanceId, input.packetId);
  if (existing) return { jobId: existing.jobId, newlyArmed: false };
  const job = repo.register({
    policy: "workflow-keepalive",
    specYaml: buildKeepaliveSpecYaml(input.instanceId, input.targetSession, input.packetId),
    targetSession: input.targetSession,
    intervalSeconds: WORKFLOW_KEEPALIVE_AUTO_INTERVAL_SECONDS,
    registeredBySession: input.registeredBySession,
  });
  return { jobId: job.jobId, newlyArmed: true };
}

/**
 * 实例进入终态（completed/failed）时在事务内停用：job 同步进入终态，避免实例结束后
 * 仍残留孤立 watchdog 噪声（FR-3 AC）。不存在已启用 job 时为空操作。
 */
export function disarmWorkflowKeepalive(
  repo: WatchdogJobsRepository,
  instanceId: string,
  reason: string,
  packetId?: string,
): string | null {
  const existing = findArmedKeepaliveJob(repo, instanceId, packetId);
  if (!existing) return null;
  repo.markTerminal(existing.jobId, reason);
  return existing.jobId;
}

export function disarmAllWorkflowKeepalives(
  repo: WatchdogJobsRepository,
  instanceId: string,
  reason: string,
): string[] {
  const jobs = repo.listActive().filter(
    (job) => job.policy === "workflow-keepalive" && job.specYaml.includes(`workflow_instance_id: ${instanceId}`),
  );
  for (const job of jobs) repo.markTerminal(job.jobId, reason);
  return jobs.map((job) => job.jobId);
}
