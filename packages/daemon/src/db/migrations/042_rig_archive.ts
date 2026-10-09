import type { Migration } from "../migrate.js";

/**
 * OPR.0.3.3.19——rig 归档能力。
 *
 * 向本地 `rigs` 行添加柔性、可逆的归档标志。活跃 rig 的 `archived_at` 为 NULL，归档后为
 * ISO 时间戳。这是可见性/保留标志，不是生命周期状态；生命周期仍是派生的 runtime/recovery
 * 投影。后台服务默认读取排除已归档 rig；显式 include/archived-only 模式可选择包含。镜像已发布的
 * stream-items `archived_at` 先例（023_stream_items）。
 *
 * 仅追加：只执行 ADD COLUMN + 索引。不重构、重建或删除 rigs 行；现有 rig 行保持不变
 *（STEERING：数据库迁移不销毁数据）。
 */
export const rigArchiveSchema: Migration = {
  name: "042_rig_archive.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN archived_at TEXT;
    CREATE INDEX IF NOT EXISTS idx_rigs_archived ON rigs(archived_at);
  `,
};
