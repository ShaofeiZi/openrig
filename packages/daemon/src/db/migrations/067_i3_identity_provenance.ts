import type { Migration } from "../migrate.js";

/**
 * P21 I3——把 CLAIMED 时代与 DERIVED 时代的审计边界（计划 §4，迁移 065）扩展到
 * QUEUE-SPINE 中携带身份的存储。向 `queue_transitions`、`inbox_entries`、`outbox_entries` 和
 * `stream_items` 添加同样可空的 `identity_provenance` 列。I3 路由的传输阻塞点写入
 * `transport:v1`；缺失本身就是 claimed 时代标记——不回填、不重新标注（本项目“缺失绝不捏造”
 * 原则）。边界是逐行事实而非时间戳：I3 各界面在不同 fold 切换时，每个存储中的行仍分别保持
 * 诚实。增量且可空——契约与 065 的 `mission_control_actions` 列完全相同。
 */
export const i3IdentityProvenanceSchema: Migration = {
  name: "067_i3_identity_provenance.sql",
  sql: `
    ALTER TABLE queue_transitions ADD COLUMN identity_provenance TEXT;
    ALTER TABLE inbox_entries ADD COLUMN identity_provenance TEXT;
    ALTER TABLE outbox_entries ADD COLUMN identity_provenance TEXT;
    ALTER TABLE stream_items ADD COLUMN identity_provenance TEXT;
  `,
};
