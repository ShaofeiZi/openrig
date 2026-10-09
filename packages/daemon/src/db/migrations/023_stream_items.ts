import type { Migration } from "../migrate.js";

/**
 * L1——Stream（PL-004 阶段 A）。
 *
 * 协调原语的只追加接收/审计根。条目发出后不可变，按 `(ts_emitted, stream_sort_key)` 排序。
 * hint 仅供参考；classifier（L2，未来阶段 B）是路由权威。
 *
 * 索引：
 *   - stream_item_id 上的 PRIMARY KEY（ULID；逐主机单调递增）
 *   - source-session 查询
 *   - hint-destination 查询
 *   - 用于按时间顺序游标分页的复合索引 (ts_emitted, stream_sort_key)
 */
export const streamItemsSchema: Migration = {
  name: "023_stream_items.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS stream_items (
      stream_item_id TEXT PRIMARY KEY,
      ts_emitted TEXT NOT NULL,
      stream_sort_key TEXT NOT NULL,
      source_session TEXT NOT NULL,
      body TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'text',
      hint_type TEXT,
      hint_urgency TEXT,
      hint_destination TEXT,
      hint_tags TEXT,
      interrupt INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stream_items_source ON stream_items(source_session);
    CREATE INDEX IF NOT EXISTS idx_stream_items_hint_destination ON stream_items(hint_destination);
    CREATE INDEX IF NOT EXISTS idx_stream_items_chronological ON stream_items(ts_emitted, stream_sort_key);
    CREATE INDEX IF NOT EXISTS idx_stream_items_archived ON stream_items(archived_at);
  `,
};
