import type { Migration } from "../migrate.js";

/**
 * Outbox 条目（PL-004 阶段 A；与 inbox 对称）。
 *
 * 对已派发条目的发送方侧审计。适用于发送方希望独立于接收方行为记录已发送条目的场景。
 * 由后台服务管理写入；以 outbox_id 保证幂等。
 *
 * delivery_state 枚举：pending | delivered | failed
 */
export const outboxEntriesSchema: Migration = {
  name: "027_outbox_entries.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS outbox_entries (
      outbox_id TEXT PRIMARY KEY,
      sender_session TEXT NOT NULL,
      destination_session TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      urgency TEXT NOT NULL DEFAULT 'routine',
      ts_dispatched TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      delivered_at TEXT,
      audit_pointer TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_entries_sender ON outbox_entries(sender_session);
    CREATE INDEX IF NOT EXISTS idx_outbox_entries_destination ON outbox_entries(destination_session);
    CREATE INDEX IF NOT EXISTS idx_outbox_entries_delivery_state ON outbox_entries(delivery_state);
  `,
};
