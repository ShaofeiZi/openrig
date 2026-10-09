import type { Migration } from "../migrate.js";

/** 让 inventory fold 使用对应事件类型，而不是扫描活动历史。Fleet 和 rig restore 读取需要
 * 不同的前导键以保持各自顺序。 */
export const inventoryEventIndexesSchema: Migration = {
  name: "084_inventory_event_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_restore_seq ON events(seq DESC)
      WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled');
    CREATE INDEX IF NOT EXISTS idx_events_restore_rig_seq ON events(rig_id, seq DESC)
      WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled');
    CREATE INDEX IF NOT EXISTS idx_events_startup_node_seq ON events(node_id, seq DESC)
      WHERE type IN ('node.startup_challenged','node.startup_proof_skipped','node.startup_proof_verified','node.startup_proof_rejected');
  `,
};
