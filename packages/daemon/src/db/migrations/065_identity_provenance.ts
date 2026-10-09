import type { Migration } from "../migrate.js";

/**
 * P21——CLAIMED 时代与 DERIVED 时代的审计边界（计划 §4）。向携带身份的审计存储添加可空的
 * `identity_provenance` 列，使消费者能够区分由传输阻塞点验证的 actor 和 P21 之前 claimed
 * 时代的行。阻塞点写入 `transport:v1`；缺失本身就是 claimed 时代标记——不回填、不重新标注
 *（本项目“缺失绝不捏造”原则）。边界是逐行事实而非时间戳：各界面在不同 fold 切换，每行分别
 * 保持诚实。消费者将 NULL 行渲染为“已记录（验证前时代）”，绝不渲染为“已验证”。
 *
 * 此迁移将该列加入 `mission_control_actions`（I1 scope-approve 与 I2 mission-control 都会写入）。
 * 后续增量把同一时代标记扩展到各自存储（queue_transitions、inbox/outbox、stream_items、
 * chat_messages）——同样可空、增量且遵循相同契约。
 */
export const identityProvenanceSchema: Migration = {
  name: "065_identity_provenance.sql",
  sql: `
    ALTER TABLE mission_control_actions ADD COLUMN identity_provenance TEXT;
  `,
};
