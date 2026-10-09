import type { Migration } from "../migrate.js";

/** 经精确验证的 RigSpec member session_source 声明，用于确保导出/重建保真。 */
export const nodeSessionSourceSchema: Migration = {
  name: "077_node_session_source.sql",
  sql: `ALTER TABLE nodes ADD COLUMN session_source_json TEXT;`,
};
