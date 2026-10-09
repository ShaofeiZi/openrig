import type { Migration } from "../migrate.js";

/**
 * Workflow 步骤轨迹（PL-004 阶段 D；只追加历史）。
 *
 * 根据 PRD § L4 Workflow Runtime：每次 workflow 步骤转换都会记录一条轨迹。只追加：
 * 写入方只能 INSERT。WorkflowStepTrailLog API 不公开 UPDATE/DELETE；直接 SQL 会成功
 *（SQLite 没有视图/角色层），但属于由领域层 API 边界强制执行的契约违规。
 *
 * 列：
 *   - trail_id（ULID 主键）
 *   - instance_id（指向 workflow_instances 的外键）
 *   - step_id（来自 spec，例如 "produce"、"review-convergence"）
 *   - step_role（来自 spec，例如 "producer"、"orchestrator"）
 *   - closed_at（闭环/转换的 ISO 时间戳）
 *   - closure_reason（枚举："handoff"、"waiting"、"done"、"failed"）
 *   - closure_evidence_json（操作员提供的证据 + 系统派生的审计上下文；JSON 编码）
 *   - actor_session（关闭该包的 session——owner-as-author）
 *   - next_qitem_id（指向 queue_items 的外键；终态闭环时为 null）
 *   - prior_qitem_id（已关闭的包；指向 queue_items 的外键）
 *
 * 索引：
 *   - (instance_id, closed_at DESC)——快速查询“某个 workflow 实例的轨迹”
 *   - (closed_at DESC)——全局近期活动
 */
export const workflowStepTrailsSchema: Migration = {
  name: "035_workflow_step_trails.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_step_trails (
      trail_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES workflow_instances(instance_id),
      step_id TEXT NOT NULL,
      step_role TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      closure_reason TEXT NOT NULL,
      closure_evidence_json TEXT,
      actor_session TEXT NOT NULL,
      next_qitem_id TEXT REFERENCES queue_items(qitem_id),
      prior_qitem_id TEXT REFERENCES queue_items(qitem_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_step_trails_instance_recent
      ON workflow_step_trails(instance_id, closed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_step_trails_recent
      ON workflow_step_trails(closed_at DESC);
  `,
};
