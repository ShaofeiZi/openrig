import type { Migration } from "../migrate.js";

/**
 * Inbox 条目（PL-004 阶段 A；邮箱式异步投递）。
 *
 * Inbox 是 canonical 异步/批量路径，不是争用回退。任何通过认证的发送方都可以带归属和审计信息
 * 投递到 inbox。接收方选择 absorb（提升到主队列）或 deny（附原因拒绝）。以 inbox_id 保证幂等。
 *
 * 状态枚举：pending | absorbed | denied
 * `absorbed_qitem_id` 记录被吸收条目转化成的 queue_item。
 */
export const inboxEntriesSchema: Migration = {
  name: "026_inbox_entries.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS inbox_entries (
      inbox_id TEXT PRIMARY KEY,
      destination_session TEXT NOT NULL,
      sender_session TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      urgency TEXT NOT NULL DEFAULT 'routine',
      ts_dropped TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      absorbed_at TEXT,
      absorbed_qitem_id TEXT,
      denied_at TEXT,
      denied_reason TEXT,
      audit_pointer TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_entries_destination_state ON inbox_entries(destination_session, state);
    CREATE INDEX IF NOT EXISTS idx_inbox_entries_sender ON inbox_entries(sender_session);
    CREATE INDEX IF NOT EXISTS idx_inbox_entries_state ON inbox_entries(state);
  `,
};
