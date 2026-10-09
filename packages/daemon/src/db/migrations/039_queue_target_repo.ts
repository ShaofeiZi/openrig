import type { Migration } from "../migrate.js";

/**
 * PL-007 Workspace Primitive v0——queue_items.target_repo 列。
 *
 * 向 queue_items 表添加 `target_repo TEXT`。操作员传入
 * `rigx queue create --target-repo <name>` 等参数时，保存逐条目的类型化 repo 范围；路由层会
 * 根据源 rig 的 RigSpec.workspace.repos[] 验证。qitem 相对于 rig 的 default_repo 无歧义，
 * 或未声明 workspace 时为 NULL。Mission Control 视图公开此字段，以明确跨 rig 交接。
 *
 * 与添加 rigs.workspace_json 的迁移 038 配套。
 */
export const queueTargetRepoSchema: Migration = {
  name: "039_queue_target_repo.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN target_repo TEXT;
    CREATE INDEX IF NOT EXISTS idx_queue_items_target_repo ON queue_items(target_repo);
  `,
};
