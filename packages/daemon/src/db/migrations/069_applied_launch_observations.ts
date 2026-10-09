import type { Migration } from "../migrate.js";

// W3 permission-drift 可见性：已应用的启动观察是以代为键的独立事实。occupant-tenure 台账
// 保持只追加，绝不改作可变观察存储。
export const appliedLaunchObservationsSchema: Migration = {
  name: "069_applied_launch_observations.sql",
  sql: `
    CREATE TABLE applied_launch_observations (
      generation_uuid TEXT PRIMARY KEY REFERENCES occupant_tenures(generation_uuid) ON DELETE CASCADE,
      runtime         TEXT NOT NULL,
      axis            TEXT NOT NULL,
      observation_state TEXT NOT NULL CHECK (observation_state IN ('observed', 'unknown')),
      value           TEXT,
      reason          TEXT,
      observed_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
