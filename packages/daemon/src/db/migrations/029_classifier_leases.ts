import type { Migration } from "../migrate.js";

/**
 * Classifier 租约（PL-004 阶段 B；单写入者租约）。
 *
 * 根据 PRD § L2：由智能体支持的 classifier，使用后台服务强制执行的单写入者租约（基于 TTL）、
 * 死亡检测（通过 whoami-service/node-inventory）和操作员动词回收。单写入者通过
 * state='active' 上的部分 UNIQUE 索引强制执行（SQLite >= 3.8 支持部分索引；OpenRig 的
 * better-sqlite3 携带 SQLite 3.45+，因此安全）。
 *
 * 状态枚举：active | expired | reclaimed
 *   active    ——租约当前有效；classifier_session 可以投影
 *   expired   ——TTL 已过且心跳已陈旧；租约不再有效
 *   reclaimed ——操作员动词回收已从上一持有者手中收回租约
 *
 * 回收只能通过操作员动词：rig project --reclaim-classifier [--if-dead]。后台服务不会依据
 * 自身评估自动回收。expired→active 需要新的 classifier session 显式调用 acquire，后者会获得
 * 新的 lease_id 行。
 */
export const classifierLeasesSchema: Migration = {
  name: "029_classifier_leases.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS classifier_leases (
      lease_id TEXT PRIMARY KEY,
      classifier_session TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      reclaimed_by_session TEXT,
      reclaim_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_classifier_leases_active_singleton
      ON classifier_leases(state) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_classifier_leases_classifier_session
      ON classifier_leases(classifier_session);
    CREATE INDEX IF NOT EXISTS idx_classifier_leases_expires_at
      ON classifier_leases(expires_at) WHERE state = 'active';
  `,
};
