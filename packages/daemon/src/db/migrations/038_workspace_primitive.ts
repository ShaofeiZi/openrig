import type { Migration } from "../migrate.js";

/**
 * PL-007 Workspace Primitive v0——rigs.workspace_json 列。
 *
 * 向 rigs 表添加 `workspace_json TEXT`。rig 声明 RigSpec.workspace 块时，以 JSON 保存其类型化
 * 内容。实例化时由 RigRepository.setRigWorkspace 填充。Whoami/node-inventory 读取此列，
 * 将 workspace 字段与 cwd 一起公开。没有 workspace 块的 rig 为 NULL。
 *
 * 配套的 queue_items.target_repo 列在迁移 039 中发布，使只测试 rigs 而无 queue_items
 *（反之亦然）的 fixture 可以只应用所需的一半。
 */
export const workspacePrimitiveSchema: Migration = {
  name: "038_workspace_primitive.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN workspace_json TEXT;
  `,
};
