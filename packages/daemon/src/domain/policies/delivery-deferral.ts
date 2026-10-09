// OPR.0.5.6.1 AM-F1——在既有 watchdog 基础设施上，将 30 分钟离开升级延迟实现为
// DEFERRED DELIVERY。SQLite 就是调度表；此处没有第三套 timer engine，也不使用 setInterval。
// 延迟作为 TRANSITION 记录在行上（S01 transitions-are-the-state 模式），job 为 ONE-SHOT，
// 触发一次后进入终态，有意区别于重复的 periodic-reminder。窗口中途重启后台服务也不会改变结果：
// 新 repository 读取同一数据库时，仍会看到同一 armed job 和同一 fire-at 计算
//（AM-F1 约束：在 T+30 恰好一次，不能为零，也不能为两次）。

import type { QueueRepository } from "../queue-repository.js";
import type { WatchdogJobsRepository } from "../watchdog-jobs-repository.js";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";

export const DELIVERY_DEFERRAL_POLICY = "delivery-deferral";
export const DELIVERY_DEFERRAL_ARMED_PREFIX = "delivery-deferral-armed";
export const DELIVERY_DEFERRAL_FIRED_PREFIX = "delivery-deferral-fired";

export interface ArmDeliveryDeferralInput {
  jobsRepo: WatchdogJobsRepository;
  queueRepo: QueueRepository;
  qitemId: string;
  entityId: string;
  minutes: number;
  notificationKey?: string;
  now?: Date;
}

interface DeferralContext {
  qitemId: string;
  entityId: string;
  minutes: number;
  armedAt: string;
  notificationKey: string;
}

/** 设置 one-shot deferral。按 notification key 幂等：同一 episode 已设置且仍有效的 deferral
 *  会直接返回，绝不重复创建。这是 AM-F3 exactly-once 的一半：在 T 时投递一次，
 *  绝不会立即投递后再延迟投递。 */
export function armDeliveryDeferral(input: ArmDeliveryDeferralInput): { jobId: string } {
  const key = input.notificationKey ?? input.qitemId;
  const existing = input.jobsRepo.listActive().find(
    (j) => j.policy === DELIVERY_DEFERRAL_POLICY && j.specYaml.includes(`notificationKey: "${key}"`),
  );
  if (existing) return { jobId: existing.jobId };

  const armedAt = (input.now ?? new Date()).toISOString();
  const specYaml = [
    "context:",
    `  qitemId: "${input.qitemId}"`,
    `  entityId: "${input.entityId}"`,
    `  minutes: ${input.minutes}`,
    `  armedAt: "${armedAt}"`,
    `  notificationKey: "${key}"`,
  ].join("\n");
  const job = input.jobsRepo.register({
    policy: DELIVERY_DEFERRAL_POLICY,
    specYaml,
    targetSession: `${input.entityId}@external`,
    intervalSeconds: Math.max(60, input.minutes * 60),
    registeredBySession: "daemon@kernel",
  });
  // Transition 就是状态：任意重启后都能从行上读取 deferral。
  input.queueRepo.update({
    qitemId: input.qitemId,
    actorSession: "daemon@kernel",
    transitionNote: [
      DELIVERY_DEFERRAL_ARMED_PREFIX,
      `job_id=${job.jobId}`,
      `fire_at=${new Date(Date.parse(armedAt) + input.minutes * 60_000).toISOString()}`,
      `notification_key=${key}`,
      `who=${input.entityId}`,
    ].join(" "),
  });
  return { jobId: job.jobId };
}

export interface FireDeliveryDeferralInput {
  jobsRepo: WatchdogJobsRepository;
  queueRepo: QueueRepository;
  jobId: string;
  /** R1 B-3：触发时携带 EPISODE key，使 Slice 14 receipt 精确落在当前 episode，
   *  绝不回退到裸 qitemId。 */
  deliverInterrupt: (qitemId: string, notificationKey: string) => Promise<{ ok: boolean }>;
  now?: Date;
}

function parseContext(specYaml: string): DeferralContext | null {
  const grab = (k: string): string | null => {
    const m = specYaml.match(new RegExp(`${k}:\\s*"?([^"\\n]+)"?`));
    return m ? m[1]! : null;
  };
  const qitemId = grab("qitemId");
  const entityId = grab("entityId");
  const minutes = grab("minutes");
  const armedAt = grab("armedAt");
  const notificationKey = grab("notificationKey");
  if (!qitemId || !entityId || !minutes || !armedAt || !notificationKey) return null;
  return { qitemId, entityId, minutes: Number(minutes), armedAt, notificationKey };
}

/** 仅在到期时触发 deferral——v3（dual-rebind 修复，R1 76a8cfd1 + R2 003f4786）。锁定契约是
 *  在 T+30 exactly-once，不能为零，也不能为两次。job 会保持 ACTIVE 以便重新驱动，直到在行上
 *  观察到 episode 自身的 posted receipt；只有该观察结果会写入 fired transition 和终态。投递使用
 *  持久且 episode 稳定的 decision ID（`deferral:<key>`），因此重放 pending decision 与重新 dispatch
 *  会收敛到同一次 post。receipt 前任意位置发生故障，都会留下 ACTIVE job，供重建后重新驱动。 */
export async function fireDeliveryDeferralIfDue(input: FireDeliveryDeferralInput): Promise<{ fired: boolean }> {
  const job = input.jobsRepo.getById(input.jobId);
  if (!job || job.state !== "active") return { fired: false };
  const ctx = parseContext(job.specYaml);
  if (!ctx) {
    input.jobsRepo.markTerminal(input.jobId, "delivery-deferral spec unparseable (fail closed, loudly terminal)");
    return { fired: false };
  }
  const now = input.now ?? new Date();
  const fireAt = Date.parse(ctx.armedAt) + ctx.minutes * 60_000;
  if (now.getTime() < fireAt) return { fired: false };

  const notes = input.queueRepo.listTransitions(ctx.qitemId).map((t) => t.transitionNote ?? "");
  // episode receipt 是唯一完成证据：observe -> fired -> terminal。
  const receipted = notes.some((n) =>
    n.startsWith("slack-owner-notification-posted ") && n.split(/\s+/).includes(`notification_key=${ctx.notificationKey}`));
  if (receipted) {
    if (!notes.some((n) => n.startsWith(DELIVERY_DEFERRAL_FIRED_PREFIX))) {
      input.queueRepo.update({
        qitemId: ctx.qitemId,
        actorSession: "daemon@kernel",
        transitionNote: [
          DELIVERY_DEFERRAL_FIRED_PREFIX,
          `job_id=${input.jobId}`,
          `notification_key=${ctx.notificationKey}`,
          `who=${ctx.entityId}`,
        ].join(" "),
      });
    }
    input.jobsRepo.markTerminal(input.jobId, "delivery-deferral fired (receipt observed)");
    return { fired: true };
  }

  // 独立 PENDING 状态（既非 terminal，也非 posted）：job 重新驱动期间，dispatch attempt 会保留记录。
  if (!notes.some((n) => n.startsWith("delivery-deferral-dispatching"))) {
    input.queueRepo.update({
      qitemId: ctx.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: `delivery-deferral-dispatching job_id=${input.jobId} notification_key=${ctx.notificationKey}`,
    });
  }
  try {
    const delivery = await input.deliverInterrupt(ctx.qitemId, ctx.notificationKey);
    if (!delivery.ok) {
      input.queueRepo.update({
        qitemId: ctx.qitemId,
        actorSession: "daemon@kernel",
        transitionNote: `delivery-deferral-attempt-failed job_id=${input.jobId} notification_key=${ctx.notificationKey}`,
      });
    }
  } catch (e) {
    // 投递中途故障或抛错时，job 保持 ACTIVE，由重建流程重新驱动。
    input.queueRepo.update({
      qitemId: ctx.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: `delivery-deferral-attempt-failed job_id=${input.jobId} notification_key=${ctx.notificationKey} error=${(e as Error).message.slice(0, 120)}`,
    });
  }
  return { fired: false };
}

/** Watchdog engine policy wrapper（additionalPolicies 注入，沿用 parked-owner-consumer
 *  接线先例）。engine scheduler cadence 驱动 evaluation，具体到期时间由上方计算负责。 */
export function makeDeliveryDeferralPolicy(deps: {
  jobsRepo: WatchdogJobsRepository;
  queueRepo: QueueRepository;
  deliverInterrupt: (qitemId: string, notificationKey: string) => Promise<{ ok: boolean }>;
}): Policy {
  return {
    name: DELIVERY_DEFERRAL_POLICY,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const { fired } = await fireDeliveryDeferralIfDue({
        jobsRepo: deps.jobsRepo,
        queueRepo: deps.queueRepo,
        jobId: job.jobId,
        deliverInterrupt: deps.deliverInterrupt,
      });
      if (fired) return { action: "terminal", reason: "delivery-deferral fired" };
      return { action: "skip", reason: "not due" };
    },
  } as Policy;
}
