import type { Migration } from "../migrate.js";

export const checkpointsSchema: Migration = {
  name: "005_checkpoints.sql",
  sql: `
    -- checkpoints：逐智能体恢复数据。
    -- 外键以 CASCADE 指向 nodes.id——checkpoint 是节点范围的恢复数据，而非审计轨迹。
    -- 节点删除后，其 checkpoint 不再有用。
    CREATE TABLE checkpoints (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      summary         TEXT NOT NULL,
      current_task    TEXT,
      next_step       TEXT,
      blocked_on      TEXT,
      key_artifacts   TEXT,
      confidence      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_checkpoints_node ON checkpoints(node_id, created_at);
  `,
};
