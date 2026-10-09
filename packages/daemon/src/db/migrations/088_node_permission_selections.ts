import type { Migration } from "../migrate.js";

// 显式记录未来启动选择；策略来源与原生规则保持分离。
export const nodePermissionSelectionsSchema: Migration = {
  name: "088_node_permission_selections.sql",
  sql: `
    CREATE TABLE node_permission_selections (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'claude-code')),
      mode TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ALTER TABLE applied_launch_observations ADD COLUMN approval_policy TEXT;
  `,
};
