import type { Migration } from "../migrate.js";

export const eventsSchema: Migration = {
  name: "003_events.sql",
  sql: `
    CREATE TABLE events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 有意不设为指向 rigs(id) 的外键。
      -- 事件是只追加的历史日志，必须在 rig 删除后仍然保留，以便保存完整时间线用于重放和审计。
      rig_id      TEXT,
      -- 有意不设为指向 nodes(id) 的外键。
      -- 理由相同：事件必须在节点删除后仍然保留。
      node_id     TEXT,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 主要查询模式：“rig X 在序号 N 之后的所有事件”（SSE 重放）。
    CREATE INDEX idx_events_rig_seq ON events(rig_id, seq);
  `,
};
