import type { Migration } from "../migrate.js";

/**
 * Slice 09 Rig Policy Primitive（OPR.0.3.2.9）——operator-context-mode 绑定表。
 *
 * 每个范围绑定一行：(scope, qualifier) 是唯一键；不同范围的多个 mode 可共存（例如
 * sleep@global_host + debug@qitem）。effective-mode 解析器为 (rig, workstream, qitem)
 * 读取上下文选择最具体的适用行。
 *
 * Schema 遵循 workspace-primitive 迁移模式：小表，以及保存 10 字段记录的 JSON 列
 *（写入时由验证器负责完整性）。这符合 slice IMPL-PRD 指定的 typed-primitive 先例
 *（HG-5：不设并行存储）。
 *
 * `scope = 'global_host'` 时 `qualifier` 为 NULL；其他三个范围保存相应 id。
 *
 * `set_at` 是后台服务写入的 UTC ISO 字符串。漂移机制读取它来计算长间隔重新确认提示
 *（v0 发布此字段；数值阈值属于约定 Q3 的后续工作）。
 *
 * v0 中 `set_by` 始终为 `'operator'`——没有智能体设置路径。保留此列使未来的操作员归属工作
 *（例如多操作员主机）无需 schema 迁移即可形成逐操作员视图；v0 的验证器与路由在边界强制
 * 执行仅限操作员的契约。
 */
export const rigPolicySchema: Migration = {
  name: "041_rig_policy.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS operator_context_mode_bindings (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global_host', 'rig', 'workstream', 'qitem')),
      qualifier TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('sleep', 'desk', 'mobile', 'away', 'focus', 'debug')),
      record_json TEXT NOT NULL,
      set_at TEXT NOT NULL,
      set_by TEXT NOT NULL CHECK (set_by = 'operator')
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_context_mode_bindings_scope_qualifier
      ON operator_context_mode_bindings(scope, qualifier);
  `,
};
