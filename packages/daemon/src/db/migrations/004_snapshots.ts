import type { Migration } from "../migrate.js";

export const snapshotsSchema: Migration = {
  name: "004_snapshots.sql",
  sql: `
    -- snapshots：混合 JSON blob 与用于查询的元数据。
    -- rig_id 是普通 TEXT（不是外键）——快照会在 rig 删除后保留。
    --（与事件采用相同的只追加历史策略。）
    CREATE TABLE snapshots (
      id          TEXT PRIMARY KEY,
      rig_id      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'complete',
      data        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_snapshots_rig ON snapshots(rig_id, created_at);
  `,
};
