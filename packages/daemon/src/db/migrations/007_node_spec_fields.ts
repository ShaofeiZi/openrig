import type { Migration } from "../migrate.js";

export const nodeSpecFieldsSchema: Migration = {
  name: "007_node_spec_fields.sql",
  sql: `
    -- 为 RigSpec 可移植性扩展节点字段（第 3 阶段）。
    ALTER TABLE nodes ADD COLUMN surface_hint TEXT;
    ALTER TABLE nodes ADD COLUMN workspace TEXT;
    ALTER TABLE nodes ADD COLUMN restore_policy TEXT;
    ALTER TABLE nodes ADD COLUMN package_refs TEXT;  -- 字符串组成的 JSON 数组。
  `,
};
