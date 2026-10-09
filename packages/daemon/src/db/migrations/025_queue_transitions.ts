import type { Migration } from "../migrate.js";

/**
 * L3——Queue transition 只追加日志（PL-004 阶段 A）。
 *
 * queue_item 的每次状态变更都会追加到此处；queue_items.state 列保存最新 transition 的值。
 * 此日志是 hot-potato 闭环推理、watchdog 评估和未来 workflow-runtime 事务记录语义
 *（阶段 D）的权威审计轨迹。
 *
 * 只追加：领域代码不得对此表执行 UPDATE/DELETE。
 */
export const queueTransitionsSchema: Migration = {
  name: "025_queue_transitions.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_transitions (
      transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
      qitem_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      state TEXT NOT NULL,
      transition_note TEXT,
      actor_session TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_qitem ON queue_transitions(qitem_id, ts);
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_actor ON queue_transitions(actor_session);
  `,
};
