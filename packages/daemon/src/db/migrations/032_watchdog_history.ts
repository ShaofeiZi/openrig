import type { Migration } from "../migrate.js";

/**
 * Watchdog 历史（PL-004 阶段 C；只追加审计日志）。
 *
 * 根据 PRD § Watchdog 与 slice IMPL § Guard Checkpoint Focus 第 2 项：记录有意义的
 * watchdog 事件的只追加历史。纯 `not_due` 轮询不会记录（与 POC 一致并缩小表体积）。只记录
 * `sent`（已执行投递）、`skipped`（策略已运行但按自身逻辑跳过，例如
 * suppress_if_recent_success 或 no_actionable_artifacts）和 `terminal`（策略声明任务完成）。
 *
 * 只追加契约：写入方只能 INSERT。WatchdogHistoryLog API 不公开 UPDATE/DELETE；直接 SQL
 * UPDATE/DELETE 会在数据库层成功（SQLite 没有视图/角色层），但属于由领域层 API 边界强制
 * 执行的契约违规。
 *
 * 结果枚举：
 *   sent     ——policy.evaluate() 返回 action=send 且已执行投递
 *   skipped  ——policy.evaluate() 返回 action=skip（附原因）
 *   terminal ——policy.evaluate() 返回 action=terminal（任务已声明完成）
 *
 * 以指向 watchdog_jobs(job_id) 的外键保证引用完整性。在 (job_id, evaluated_at DESC) 上建立
 * 索引以查询“某一任务的近期历史”，在 (outcome, evaluated_at DESC) 上建立索引以跨任务查询结果。
 */
export const watchdogHistorySchema: Migration = {
  name: "032_watchdog_history.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS watchdog_history (
      history_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES watchdog_jobs(job_id),
      evaluated_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      skip_reason TEXT,
      delivery_target_session TEXT,
      delivery_status TEXT,
      delivery_message TEXT,
      evaluation_notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_watchdog_history_job_recent
      ON watchdog_history(job_id, evaluated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_watchdog_history_outcome_recent
      ON watchdog_history(outcome, evaluated_at DESC);
  `,
};
