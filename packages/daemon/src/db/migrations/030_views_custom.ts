import type { Migration } from "../migrate.js";

/**
 * 自定义视图（PL-004 阶段 B；L5 View——自定义视图注册表）。
 *
 * 根据 PRD § L5：内置视图（`recently-active`、`founder`、`pod-load`、`escalations`、
 * `held`、`activity`）硬编码在 view-projector.ts 中。操作员定义的自定义视图存于此表，
 * 后台服务启动时从 `~/.openrig/views.yaml` 注册（或在运行时通过 API 注册）。
 *
 * 内置视图不会插入此表——view-projector.ts 无需查询数据库即可按名称公开它们。操作员查询
 * `rig view show <custom-name>` 时，在此处查找自定义视图。
 */
export const viewsCustomSchema: Migration = {
  name: "030_views_custom.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS views_custom (
      view_id TEXT PRIMARY KEY,
      view_name TEXT NOT NULL UNIQUE,
      definition TEXT NOT NULL,
      registered_by_session TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_evaluated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_views_custom_registered_by ON views_custom(registered_by_session);
  `,
};
