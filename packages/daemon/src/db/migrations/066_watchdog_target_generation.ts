import type { Migration } from "../migrate.js";

/**
 * GHOST-STAGE（i-c）——watchdog_jobs 上可选启用的目标代标记。
 *
 * 注册侧 ghost（已退役注册者的任务在交接后触发）已由迁移 063 +
 * `dropArmedByRegisteringGeneration` 关闭。此列是触发时补充：绑定到代的 wake（可选）记录其
 * 目标 occupant-generation，使 wake 发行方（WatchdogPolicyEngine）能拒绝向之后已交接给不同
 * 实时代的目标触发（投递时执行 P12 `occupant_tenures` 代检查）。
 *
 * 可空且无默认值：NULL `target_generation_uuid` = 绑定角色（向任何占据该席位名称的人触发——
 * 合法常见情形，行为不变）。只有非 NULL 标记才让任务进入触发时代门禁。增量 ALTER；repository
 * 的防御性列检测使 066 之前的 fixture 干净降级（写入方留为 NULL，门禁为空操作 → 投递）。
 */
export const watchdogTargetGenerationSchema: Migration = {
  name: "066_watchdog_target_generation.sql",
  sql: `
    ALTER TABLE watchdog_jobs ADD COLUMN target_generation_uuid TEXT;
  `,
};
