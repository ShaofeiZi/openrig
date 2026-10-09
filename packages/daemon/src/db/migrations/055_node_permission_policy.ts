import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 接缝 B——nodes.permission_policy 列。
 *
 * 向 nodes 表添加 `permission_policy TEXT`。席位声明策略时，保存逐席位 permission_policy
 * REF（`builtin:<name>` 或相对于 spec 的自定义路径），由 createMemberNode → addNode 写入。
 * 席位未附加策略时为 NULL（即 floor）。镜像迁移 022（node codex_config_profile）；repository
 * 会探测该列，因此席位属性只在拥有该列的数据库中往返。
 */
export const nodePermissionPolicySchema: Migration = {
  name: "055_node_permission_policy.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN permission_policy TEXT;
  `,
};
