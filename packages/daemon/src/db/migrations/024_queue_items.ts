import type { Migration } from "../migrate.js";

/**
 * L3——Queue（PL-004 阶段 A）。
 *
 * 特定席位拥有的工作。携带状态、来源、闭环义务及后台服务跟踪的提醒结果。实时 runtime 状态以
 * SQLite 为 canonical；Markdown 队列镜像仅用于只读调试/导出。
 *
 * 状态枚举（在领域层验证）：
 *   pending | in-progress | done | blocked | failed | denied | canceled | handed-off
 *
 * 闭环原因枚举（`done` 转换时必需；hot-potato 严格拒绝）：
 *   handed_off_to | blocked_on | denied | canceled | no-follow-on | escalation
 *
 * `chain_of_record` 和 `tags` 保存以 TEXT 编码的 JSON 数组，以便向前兼容结构化查询层。
 */
export const queueItemsSchema: Migration = {
  name: "024_queue_items.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_items (
      qitem_id TEXT PRIMARY KEY,
      ts_created TEXT NOT NULL,
      ts_updated TEXT NOT NULL,
      source_session TEXT NOT NULL,
      destination_session TEXT NOT NULL,
      state TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'routine',
      tier TEXT,
      tags TEXT,
      blocked_on TEXT,
      handed_off_to TEXT,
      handed_off_from TEXT,
      expires_at TEXT,
      chain_of_record TEXT,
      body TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT,
      closure_required_at TEXT,
      claimed_at TEXT,
      last_nudge_attempt TEXT,
      last_nudge_result TEXT,
      last_heartbeat TEXT,
      resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_items_destination_state ON queue_items(destination_session, state);
    CREATE INDEX IF NOT EXISTS idx_queue_items_source ON queue_items(source_session);
    CREATE INDEX IF NOT EXISTS idx_queue_items_state ON queue_items(state);
    CREATE INDEX IF NOT EXISTS idx_queue_items_handed_off_to ON queue_items(handed_off_to);
    CREATE INDEX IF NOT EXISTS idx_queue_items_closure_overdue ON queue_items(state, closure_required_at) WHERE state = 'in-progress';
  `,
};
