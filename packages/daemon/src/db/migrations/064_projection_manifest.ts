import type { Migration } from "../migrate.js";

/**
 * P20——投影清单：记录 projector 最近向每个目标写入的内容，以便区分发生差异的目标是操作员
 * 修改（保护）还是陈旧投影（可安全覆盖）。沿用 P17（覆盖时明确告警，无 manifest 时的默认行为）：
 * P17 只能看到“target ≠ source”，无法区分操作员编辑与陈旧投影；此表增加第三个数据点——
 * last_hash = projector 最近写入 target_path 的内容哈希。
 *
 * 每个投影目标一行，以绝对路径为键。逐行 upsert 具有事务性（节点并发启动时，整文件 JSON
 * manifest 会产生竞态，数据库表不会）。只在写入时记录（幂等：重新投影相同内容为空操作，
 * 不更改行）。
 *
 *（编号 064：在 fold-64 基线上创作时的下一个空位；061 是 P7 单独合入的生命周期表，
 * 060/062/063 属于其他线路。restack 时由 desk 负责最终迁移编号并集；独立表语义才是裁定。）
 */
export const projectionManifestSchema: Migration = {
  name: "064_projection_manifest.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS projection_manifest (
      target_path TEXT PRIMARY KEY,
      last_hash   TEXT NOT NULL,
      written_at  TEXT NOT NULL,
      source_spec TEXT,
      category    TEXT
    );
  `,
};
