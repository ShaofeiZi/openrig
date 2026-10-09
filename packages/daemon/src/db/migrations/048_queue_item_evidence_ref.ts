import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.4.19 FR-5——queue_items.evidence_ref 列。
 *
 * 向 queue_items 添加可空的 `evidence_ref TEXT`：条目路由给人工时，指向供人工判断的持久产物
 *（约定 C3）。通过 `rig queue create`/`handoff` 的 `--evidence-ref` 编写，并可在 park 时
 *（`rig queue block`，FR-6）持久化。严格遵循 044 summary 列模式：增量、可空，并通过防御性
 * detectQueueColumn 读取使 048 之前的 fixture 能够降级。
 *
 * 按契约可空：仅人工路由条目需要（§5 谓词，在领域写入路径强制执行——FR-4/FR-5），因此普通
 * 智能体间条目始终保持 NULL（BR-1 零摩擦）。不要改为 NOT NULL，也不要添加默认值。
 */
export const queueItemEvidenceRefSchema: Migration = {
  name: "048_queue_item_evidence_ref.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN evidence_ref TEXT;
  `,
};
