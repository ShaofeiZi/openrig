// PL-004 阶段 C：periodic-reminder 策略（POC
// `lib/policies/periodic-reminder.mjs` 的 TypeScript 移植版）。
//
// POC 契约：target.session 必填（spec_yaml 顶层 `target:`）。消息来自顶层
// `job.message` 或 `context.message`。调用时无条件返回 action=send
//（调度器按 interval 控制触发，本策略本身无状态）。

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

interface PeriodicReminderContext {
  message?: string;
}

export const periodicReminderPolicy: Policy = {
  name: "periodic-reminder",
  async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
    if (!job.target?.session) {
      throw Object.assign(new Error("periodic-reminder：必须提供 target.session"), {
        code: "policy_spec_invalid",
        policy: "periodic-reminder",
        field: "target.session",
      });
    }
    const context = job.context as PeriodicReminderContext;
    const message = job.message ?? context.message;
    if (!message) {
      throw Object.assign(new Error("periodic-reminder：必须提供 message（顶层 message 或 context.message）"), {
        code: "policy_spec_invalid",
        policy: "periodic-reminder",
        field: "message",
      });
    }
    return { action: "send", target: job.target, message };
  },
};
