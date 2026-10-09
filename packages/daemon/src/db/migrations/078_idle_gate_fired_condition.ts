import type { Migration } from "../migrate.js";

/**
 * OPR.0.5.8.1 S2——每个任务一个覆盖写入值：idle-gate 上次触发所对应的受控条件。
 *
 * idle-gate wake 过去会按定时器重复，而不是只在变化时触发，因为它唯一的冷却机制是引擎的
 * active-wake 窗口；每次 skip 都会清除 `actionable`，所以席位短暂繁忙就能完全绕过该窗口。
 * 记录上次为何触发后，策略可改为对受控集合的每个实质状态只触发一次。
 *
 * 有意设计为可空单值。它会被覆盖，绝不追加：逐 wake 台账正是本修复明确禁止增加的记账负担。
 * null 表示“尚未针对任何条件触发”，因此会触发一次。
 */
export const idleGateFiredConditionSchema: Migration = {
  name: "078_idle_gate_fired_condition.sql",
  sql: `
    ALTER TABLE watchdog_jobs ADD COLUMN last_fired_condition TEXT;
  `,
};
