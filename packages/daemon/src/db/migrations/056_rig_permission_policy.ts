import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 接缝 B——rigs.permission_policy 列。
 *
 * 向 rigs 表添加 `permission_policy TEXT`。rig 声明策略时，保存 rig 级 permission_policy REF
 *（`builtin:<name>` 或相对于 spec 的自定义路径），实例化时由
 * RigRepository.setRigPermissionPolicy 填充，并通过 getRigPermissionPolicy（exporter/discovery）
 * 读回。未附加策略的 rig 为 NULL（即 floor）。镜像迁移 038（rigs.workspace_json）。
 */
export const rigPermissionPolicySchema: Migration = {
  name: "056_rig_permission_policy.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN permission_policy TEXT;
  `,
};
