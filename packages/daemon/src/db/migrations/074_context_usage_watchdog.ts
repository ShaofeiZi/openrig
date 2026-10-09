import type { Migration } from "../migrate.js";

/** transcript 字节数 watchdog 条件的持久状态。 */
export const contextUsageWatchdogSchema: Migration = {
  name: "074_context_usage_watchdog.sql",
  sql: `
    ALTER TABLE watchdog_jobs ADD COLUMN watched_file_path TEXT;
    ALTER TABLE watchdog_jobs ADD COLUMN threshold_bytes INTEGER;
    ALTER TABLE watchdog_jobs ADD COLUMN requires_job_id TEXT;
    ALTER TABLE watchdog_jobs ADD COLUMN last_fired_generation_uuid TEXT;
  `,
};
