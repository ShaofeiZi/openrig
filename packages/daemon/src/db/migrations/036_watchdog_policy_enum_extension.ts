import type { Migration } from "../migrate.js";

/**
 * Watchdog 策略枚举扩展（PL-004 阶段 D）。
 *
 * 记录型空操作迁移。
 *
 * 阶段 C 在应用层实现 watchdog_jobs.policy 枚举（WatchdogJobsRepository.register() 中通过
 * PHASE_C_POLICIES 数组 + WORKFLOW_KEEPALIVE_DEFERRED_POLICY 常量）。SQLite 列本身是没有
 * CHECK 约束的普通 TEXT，因此将枚举扩展为包含 "workflow-keepalive" 无需更改 schema。
 *
 * 实际执行扩展位于：
 *   packages/daemon/src/domain/watchdog-jobs-repository.ts
 *     - PHASE_C_POLICIES → 改名为 PHASE_D_POLICIES（或扩展），以包含
 *       "workflow-keepalive"
 *     - 移除 WORKFLOW_KEEPALIVE_DEFERRED_POLICY 拒绝逻辑
 *
 * 此迁移存在两个原因：
 *   1. 审计轨迹：记录阶段 D 扩展了策略枚举接口，即使不需要 DDL。
 *   2. 迁移序列完整性：让阶段 D 的迁移数量与三个新 workflow 表（033、034、035）一起在
 *      后台服务启动日志中可见。Slice IMPL 第 17 行明确要求扩展迁移“干净落地且不触碰阶段 C
 *      的现有迁移文件”——此空操作满足该约束。
 *
 * 根据 slice IMPL § Write Set：若执行逻辑位于应用层 `watchdog-policy-engine.ts`，迁移应为
 * 空操作 SQL，但需记录策略枚举意图。
 */
export const watchdogPolicyEnumExtensionSchema: Migration = {
  name: "036_watchdog_policy_enum_extension.sql",
  sql: `
    -- 无 DDL：阶段 C 策略枚举由 watchdog-jobs-repository.ts 中的 PHASE_D_POLICIES 在应用层
    -- 强制执行。watchdog_jobs.policy 列仍为普通 TEXT。此迁移作为阶段 D 枚举扩展的审计标记。
    SELECT 1 WHERE 0;
  `,
};
