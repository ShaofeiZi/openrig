import type { Migration } from "../migrate.js";

/**
 * Slice 11（release-0.3.1 workflow-spec-folder-discovery）——workflow_specs 诊断列。
 *
 * SC-29 #10（原义，声明于提交正文）：Slice 11 要求 schema 迁移
 * 040_workflow_specs_diagnostic.ts 向 workflow_specs 缓存添加 status TEXT DEFAULT
 * 'valid' 和 error_message TEXT 列。不新增表；除默认值外不改约束；ALTER TABLE ADD COLUMN
 * 保留现有行（默认 'valid' 会回填已有缓存行）。这是只读诊断界面——缓存保存解析器/验证器错误，
 * 供 Library UI 渲染；后台服务不依据诊断状态执行操作。根据 IMPL-PRD §HG-8“若 provenance/
 * status 列需要迁移，须提前声明”：已在 slice 11 ACK 和提交正文中提前声明。
 *
 * 列：
 *   - status TEXT NOT NULL DEFAULT 'valid'——'valid' | 'error' 之一。ALTER TABLE ADD
 *     COLUMN 填充时，040 之前的现有行通过 DEFAULT 子句回填 'valid'。
 *   - error_message TEXT NULL——仅在 status='error' 时填充；携带供 UI 渲染的解析/验证诊断。
 *
 * Provenance 不是新列——扫描时根据 source_path 相对于后台服务内置 starter 目录的位置派生
 *（spec-library-workflow-scanner.ts 中的现有扫描逻辑已执行
 * isUnderDir(source_path, workflowBuiltinSpecsDir)）。
 */
export const workflowSpecsDiagnosticSchema: Migration = {
  name: "040_workflow_specs_diagnostic.sql",
  sql: `
    ALTER TABLE workflow_specs ADD COLUMN status TEXT NOT NULL DEFAULT 'valid';
    ALTER TABLE workflow_specs ADD COLUMN error_message TEXT;
  `,
};
