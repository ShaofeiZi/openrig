import type { Migration } from "../migrate.js";

/**
 * Watchdog 任务（PL-004 阶段 C；后台服务原生 Watchdog 监督树）。
 *
 * 根据 PRD § Watchdog 与 slice IMPL § Write Set：加入后台服务监督树的 SQLite-canonical
 * watchdog 任务。阶段 C v1 发布三个策略枚举值：periodic-reminder、artifact-pool-ready、
 * edge-artifact-required。第四个 POC 策略 workflow-keepalive 在阶段 D 与 workflow_instances
 * 配套发布；后台服务注册必须以结构化 deferred-to-phase-d 错误拒绝它。
 *
 * 状态枚举：
 *   active   ——调度器按间隔评估此任务
 *   stopped  ——操作员已停止任务；调度器跳过它
 *   terminal ——策略声明任务完成（例如 workflow 已结束）
 *
 * 节奏列镜像 POC 引擎语义：
 *   - interval_seconds 是 legacy/回退节奏。
 *   - scan_interval_seconds 覆盖调度器的 isDue 节奏（策略整体多久运行一次）。
 *   - active_wake_interval_seconds 对重复投递限流：池持续可操作时，每 N 次扫描才触发一次。
 *
 * Active-wake 状态（R1 修复；与 POC 的 active-wake 限流保持一致）：
 *   - actionable：仅当最近一次扫描返回 action=send 时为 1。用于检测刚变为可操作的转换
 *     （转换时不限流；持续可操作时限流）。
 *   - last_actionable_at：当前可操作窗口内的首次尝试时间。策略返回 skip 时清除。
 *
 * spec_yaml 保留操作员提供的原始 YAML 以供审计。
 */
export const watchdogJobsSchema: Migration = {
  name: "031_watchdog_jobs.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS watchdog_jobs (
      job_id TEXT PRIMARY KEY,
      policy TEXT NOT NULL,
      spec_yaml TEXT NOT NULL,
      target_session TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      active_wake_interval_seconds INTEGER,
      scan_interval_seconds INTEGER,
      last_evaluation_at TEXT,
      last_fire_at TEXT,
      actionable INTEGER NOT NULL DEFAULT 0,
      last_actionable_at TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      registered_by_session TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      terminal_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_watchdog_jobs_state ON watchdog_jobs(state);
    CREATE INDEX IF NOT EXISTS idx_watchdog_jobs_policy ON watchdog_jobs(policy);
    CREATE INDEX IF NOT EXISTS idx_watchdog_jobs_target_session ON watchdog_jobs(target_session);
    CREATE INDEX IF NOT EXISTS idx_watchdog_jobs_active_next_eval
      ON watchdog_jobs(last_evaluation_at) WHERE state = 'active';
  `,
};
