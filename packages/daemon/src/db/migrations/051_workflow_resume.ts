import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6.WF5 FR-4——workflow_instances resume 列。
 *
 * `resume_count`：记录下来的 redrive 事实（AWS Step Functions 的 `redriveCount` 结构——
 * 一等记录字段，绝不从轨迹推断）。
 *
 * `hops_baseline`：活锁护栏（架构回退 R1）。max_hops 限制每次 DRIVE，而非实例整个生命周期：
 * 投影守卫比较最近一次 instantiate 或 resume 后累积的 hop，因此人工 resume 恰好批准一个新的
 * 有界窗口，不会在恢复后首次投影时立即再次触发。WF-1 的守卫注释明确留下此接缝
 *（“WF-5 FR-4 的 resume 稍后修正基线”）。
 *
 * 增量添加，NOT NULL DEFAULT 0：现有实例保持 v1 基线（0）和零次 resume——无需回填，
 * 第一次 resume 前行为逐字节一致。
 */
export const workflowResumeSchema: Migration = {
  name: "051_workflow_resume.sql",
  sql: `
    ALTER TABLE workflow_instances ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE workflow_instances ADD COLUMN hops_baseline INTEGER NOT NULL DEFAULT 0;
  `,
};
