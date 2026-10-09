import type { Migration } from "../migrate.js";

/**
 * 51-08 A1（plan-lock rev-1，PM 2026-08-07）——token-telemetry-over-time 背后的逐席位
 * 只追加用量序列。
 *
 * 此处绑定 PM 裁定：使用专用时间序列表（events 表的末行读取形态不适合范围查询；events 保持
 * 精简）；行只追加且只在推进时写入（与席位上一行相同的样本绝不写入，空闲席位不新增行）；
 * 保留策略依据 queue_transitions_archive 先例由后台服务强制执行（A2）。
 *
 * 两条 lane 共享此表：
 *   'context'          ——30 秒 context-monitor tick 已掌握的上下文窗口样本（输入/输出 token、
 *                        使用百分比）；它是 context_usage 破坏性 upsert（018）的历史孪生，
 *                        后者作为时点 lane 保持不变。
 *   'provider_window'  ——来自 statusline provider-usage sidecar 的逐席位速率限制窗口
 *                        （five_hour | weekly）；在此表出现前完全没有持久化。
 *
 * 方案 A 边界（provider-types.ts:106，host-usage-rollup.ts:12-16）：仅允许 seat/node 身份——
 * 不存在且不得添加账户身份列；statusline 未公开可信账户身份，此 lane 绝不捏造。
 *
 * 编号顺序（desk 固定于 2026-08-07）：060 = tenure 台账，061 = P7 生命周期——均为进行中
 * 线路；062 是本 slice 自有编号。
 */
export const usageSamplesSchema: Migration = {
  name: "062_usage_samples.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lane TEXT NOT NULL CHECK (lane IN ('context', 'provider_window')),
      seat_session TEXT NOT NULL,
      node_id TEXT,
      source TEXT,
      sampled_at TEXT,
      captured_at TEXT NOT NULL,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      used_percentage REAL,
      window TEXT CHECK (window IN ('five_hour', 'weekly') OR window IS NULL),
      window_used_percent REAL,
      resets_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_samples_seat_time
      ON usage_samples(seat_session, lane, captured_at);
    CREATE INDEX IF NOT EXISTS idx_usage_samples_node_time
      ON usage_samples(node_id, captured_at);
  `,
};
