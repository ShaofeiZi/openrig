import type { Migration } from "../migrate.js";

/**
 * 项目分类（PL-004 阶段 B；L2 Project/Classifier）。
 *
 * 根据 PRD § L2（`product-specs/coordination-primitive-system/README.md:113,118,136`）、
 * slice IMPL § Write Set:118 和 R1 守卫（BLOCKER 1）：由智能体支持的 stream item 分类。
 * 后台服务负责：
 *
 * - stream_item_id 的幂等性（UNIQUE）。
 * - 租约验证（委托给 classifier-lease-manager）。
 * - L1→L2 引用完整性（外键指向 stream_items.stream_item_id）。
 *
 * 分类字段属于智能体判断——后台服务不对其强制执行 taxonomy。
 *
 * 幂等契约：重复投影同一个 stream_item_id 必须以结构化 409 失败。首行胜出，第二次尝试的
 * 分类被拒绝。
 *
 * 存在性契约（R1）：对不存在的 stream_item_id 分类必须以结构化 400 类
 * `unknown_stream_item` 错误失败。领域层预先检查以清晰呈现错误；外键约束是纵深防御安全网
 *（connection.ts 中设置 PRAGMA foreign_keys = ON）。
 */
export const projectClassificationsSchema: Migration = {
  name: "028_project_classifications.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS project_classifications (
      project_id TEXT PRIMARY KEY,
      stream_item_id TEXT NOT NULL UNIQUE REFERENCES stream_items(stream_item_id),
      classification_type TEXT,
      classification_urgency TEXT,
      classification_maturity TEXT,
      classification_confidence TEXT,
      classification_destination TEXT,
      action TEXT,
      classifier_session TEXT NOT NULL,
      ts_projected TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_classifications_classifier_session ON project_classifications(classifier_session);
    CREATE INDEX IF NOT EXISTS idx_project_classifications_destination ON project_classifications(classification_destination);
    CREATE INDEX IF NOT EXISTS idx_project_classifications_ts_projected ON project_classifications(ts_projected);
  `,
};
