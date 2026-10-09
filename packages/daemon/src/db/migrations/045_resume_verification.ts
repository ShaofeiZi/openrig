import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.3.20 FR-6——resume-token 验证新鲜度列。
 *
 * 向 `sessions` 增量添加两个可空列，使恢复计划能够展示逐席位 token 新鲜度
 *（present/missing/stale/unverified）：
 *
 * - `resume_last_verified`（TEXT，可空）——最近一次确认 token 当前有效的时间（写入 token、
 *   从实时状态重新派生 token，或实时 resume probe 返回 `resumable` 时标记）。NULL = 从未验证。
 * - `resume_last_probe_status`（TEXT，可空）——最近一次 resume probe 结果：
 *   `resumable | not_resumable | inconclusive`。NULL = 从未探测。
 *
 * 二者共同使“存在但陈旧”的 token 可表示（token 存在，但 probe 返回 `not_resumable`，或上次
 * 验证时间超过新鲜度阈值）——生存关键场景 FR-6 会显示为 `stale/unverified — re-verify`，
 * 而不是静默恢复失败。只有 last-verified 列无法区分“从未探测”与“探测失败”。
 *
 * 按契约可空并可降级：45 之前的所有行（以及每个旧快照中序列化的 session）读取为 NULL，
 * 渲染为 `unverified`——绝不崩溃，也绝不误报 `present`。不要改为 NOT NULL 或回填默认值。
 *
 * 基表：002_bindings_sessions.ts（sessions）；resume 列来自 006_resume_metadata.ts +
 * 043_resume_provenance.ts。编号使用 044_queue_item_summary.ts 之后的下一个可用值。
 */
export const resumeVerificationSchema: Migration = {
  name: "045_resume_verification.sql",
  sql: `
    ALTER TABLE sessions ADD COLUMN resume_last_verified TEXT;
    ALTER TABLE sessions ADD COLUMN resume_last_probe_status TEXT;
  `,
};
