import type { Migration } from "../migrate.js";

/** rig 评审中近期 roster 和已完成 handoff 的访问路径。 */
export const reviewReadIndexesSchema: Migration = {
  name: "083_review_read_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_handoff_ts
      ON queue_transitions(ts DESC)
      WHERE closure_reason = 'handed_off_to';
    CREATE INDEX IF NOT EXISTS idx_queue_items_ts_updated
      ON queue_items(ts_updated);
  `,
};
