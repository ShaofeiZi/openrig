import type { Migration } from "../migrate.js";

/** 用提供该路径的 occupant 代限定持久化 transcript 路径。 */
export const contextUsageWatchdogGenerationSchema: Migration = {
  name: "075_context_usage_watchdog_generation.sql",
  sql: `
    ALTER TABLE watchdog_jobs ADD COLUMN watched_file_generation_uuid TEXT;
  `,
};
