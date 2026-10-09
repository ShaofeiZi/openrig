import type { Migration } from "../migrate.js";

/**
 * S14——持久 queue transition 上的结构化 owner-notification 元数据。
 * 有意允许为空：历史和未分类 transition 保持为记录；不重写任何现有审计行，也不从正文推断。
 */
export const ownerNotificationLevelsSchema: Migration = {
  name: "076_owner_notification_levels.sql",
  sql: `
    ALTER TABLE queue_transitions ADD COLUMN owner_notification_kind TEXT;
    ALTER TABLE queue_transitions ADD COLUMN owner_notification_level TEXT;
    ALTER TABLE queue_transitions_archive ADD COLUMN owner_notification_kind TEXT;
    ALTER TABLE queue_transitions_archive ADD COLUMN owner_notification_level TEXT;
  `,
};
