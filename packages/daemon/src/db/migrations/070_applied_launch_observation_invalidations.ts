import type { Migration } from "../migrate.js";

// W3 切换事实：某一代的进程在物理上消失后，任何延迟的 startup/restore 完成都不得重建其
// applied-launch 观察。
export const appliedLaunchObservationInvalidationsSchema: Migration = {
  name: "070_applied_launch_observation_invalidations.sql",
  sql: `
    CREATE TABLE applied_launch_observation_invalidations (
      generation_uuid TEXT PRIMARY KEY REFERENCES occupant_tenures(generation_uuid) ON DELETE CASCADE,
      invalidated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
