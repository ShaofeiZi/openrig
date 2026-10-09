import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.1.18——queue_items.summary 列。
 *
 * 向 queue_items 添加可空的 `summary TEXT`：一至两句面向人类的工作摘要，通过
 * `rig queue create`/`handoff` 的 `--summary` 编写。智能体语言的 `body`（TEXT NOT NULL）
 * 仍是事实源，保持不变；本变更仅做增量添加。
 *
 * 按契约可为空：18 之前的所有行（以及作者省略摘要的任何 qitem）保持 NULL，并在 Story
 * 消费方降级——slice-detail-projector.ts 构造
 * `summary: r.summary ?? <source→dest + body truncation>`——因此 StoryEvent.summary
 *（slice 19）始终为非空字符串，不会中断。不要改为 NOT NULL，也不要回填掩盖降级的默认值。
 *
 * 基表：024_queue_items.ts。编号说明：slice README 使用了“042”，但在构建基线 dbe6cce7 上
 * 已有 042_rig_archive + 043_resume_provenance，因此下一个可用编号是 044。
 */
export const queueItemSummarySchema: Migration = {
  name: "044_queue_item_summary.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN summary TEXT;
  `,
};
