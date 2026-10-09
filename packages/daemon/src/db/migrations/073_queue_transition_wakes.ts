import type { Migration } from "../migrate.js";

// OPR.0.5.5.03——wake 证据属于只追加的 park transition，而不是可变队列行。旁表使
// queue_transitions 本身保持不可变，并在 active→archive 生命周期中保留且不重写历史。
export const queueTransitionWakesSchema: Migration = {
  name: "073_queue_transition_wakes.sql",
  sql: `
    CREATE TABLE queue_transition_wakes (
      transition_id  INTEGER PRIMARY KEY,
      qitem_id       TEXT NOT NULL,
      phase          TEXT NOT NULL CHECK (phase IN ('armed', 'fired')),
      wake_kind      TEXT NOT NULL CHECK (wake_kind IN ('watchdog', 'timer', 'blocker')),
      wake_ref       TEXT NOT NULL,
      delivery_status TEXT
    );
    CREATE INDEX idx_queue_transition_wakes_qitem
      ON queue_transition_wakes (qitem_id, transition_id);
    CREATE INDEX idx_queue_transition_wakes_ref
      ON queue_transition_wakes (wake_ref, phase);
  `,
};
