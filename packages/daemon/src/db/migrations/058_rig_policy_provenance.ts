import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 接缝 B（9e94c274 处 Guard NOT-CLEAR，发现 1）：为 rig 级已解析
 * permission-policy 附加项增量添加跨重启稳定的来源。对相对自定义策略而言，仅有原始 rig ref
 *（迁移 056）不足以完成重启恢复：自然 claim/自附加席位没有节点来源，结构化 add-member 在不同
 * 操作根下运行，而 restore/继任者绝不能相对于无关 cwd 解析持久化相对 ref。列镜像节点级 057：
 *   rig_policy_origin / rig_policy_resolved_target / rig_policy_declaring_dir /
 *   rig_policy_launch_posture
 * declaring_dir = 原始声明 RigSpec 目录（实体化时的 rigRoot）。
 * 仅做增量添加；NULL = 未附加 rig 级策略。
 */
export const rigPolicyProvenanceSchema: Migration = {
  name: "058_rig_policy_provenance.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN rig_policy_origin TEXT;
    ALTER TABLE rigs ADD COLUMN rig_policy_resolved_target TEXT;
    ALTER TABLE rigs ADD COLUMN rig_policy_declaring_dir TEXT;
    ALTER TABLE rigs ADD COLUMN rig_policy_launch_posture TEXT;
  `,
};
