import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6.FAC1——workflow_instances.bound_rig 列。
 *
 * 绑定层的 A1 基底：workflow 实例在实例化时指向某个 rig（`--rig`/路由 `targetRig`，默认为
 * spec 的 `target.rig`），绑定持久保存在实例上，因此所有 owner 解析位置（投影、门禁编译、
 * 入口、resume、异常路由）都根据该 rig 的盘点解析角色。
 *
 * 持久化 rig 名称而非 id（ARCH Q4）：名称是持久的操作员空间坐标，与 seat-name 原则一致；
 * 被销毁并重建的 rig 仍保留绑定。每个解析位置都会重新解析名称→id（存在性检查类读取）；
 * rig 消失时会在该处明确失败，绝不静默。
 *
 * 可空且无默认值：NULL = unbound = 所有既有行及未指定 rig 的 instantiate 都保持与 FAC-1
 * 之前逐字节一致的行为。不回填。
 *
 * 编号（绑定，架构取代 2026-07-07）：FAC-1 固定占用 052；无论合并顺序如何，FS-1 都在
 * 自身 rebase 时将进行中的 051/052 相邻迁移重编号为 053+。
 */
export const workflowInstanceBoundRigSchema: Migration = {
  name: "052_workflow_instance_bound_rig.sql",
  sql: `
    ALTER TABLE workflow_instances ADD COLUMN bound_rig TEXT;
  `,
};
