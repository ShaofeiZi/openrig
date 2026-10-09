import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 接缝 B（R2——dev-guard 重启来源裁定）：为节点已解析的 permission-policy
 * 附加项增量添加跨重启稳定的来源列。仅有原始 ref（迁移 055）并不足以完成重启恢复——恢复必须
 * 能在没有原始内存 RigSpec 的情况下重新派生界面和启动姿态：
 *   - policy_origin           'builtin' | 'custom'（来源诚实，绝不重新分类）
 *   - policy_resolved_target  custom：已解析策略的绝对路径。
 *                             builtin：打包环节裁定后的 canonical 发布包副本路径
 *                             （PM lane c76c7153）；此前为 NULL，绝不是原始 ref 的
 *                             `builtin:<name>` 回显。
 *   - policy_declaring_dir    custom：声明该策略的 canonical RigSpec 目录。
 *   - policy_launch_posture   'floor' | 'full_bypass'——实体化时解析出的姿态；restore 会重新
 *                             解析并协调（自定义 flag 策略必须恢复为 full_bypass，这是裁定核心）。
 * 仅做增量添加：不返工 055/056。NULL = 未附加策略（诚实缺失）。
 */
export const nodePolicyProvenanceSchema: Migration = {
  name: "057_node_policy_provenance.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN policy_origin TEXT;
    ALTER TABLE nodes ADD COLUMN policy_resolved_target TEXT;
    ALTER TABLE nodes ADD COLUMN policy_declaring_dir TEXT;
    ALTER TABLE nodes ADD COLUMN policy_launch_posture TEXT;
  `,
};
