import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.3 热修复——events 逐节点/逐 rig+type 索引（解决后台服务 /healthz 卡死）。
 *
 * 根因（来自卡死后台服务的实时 CPU 样本，CPU 98–100%）：`GET /api/ps`（UI 每 3 秒轮询）
 * 执行两层嵌套映射（ps-projection 遍历 rigs → getNodeInventory → node-inventory 遍历 nodes），
 * 其逐节点派生会在没有支持索引的情况下反向扫描只追加 `events` 表。此前唯一索引是
 * `idx_events_rig_seq(rig_id, seq)`——没有以 `node_id` 开头的索引，也没有索引能提高 `type`
 * 过滤的选择性。因此：
 *   - `deriveOriented`（startup-proof.ts）：`WHERE node_id=? AND type IN (...) ORDER BY
 *     seq DESC` 没有可用索引 → 每个节点每 3 秒对整个 events 日志执行一次完整反向主键 B-tree
 *     遍历（样本中的 btreePrevious/pread 特征）。这是主要卡点。
 *   - `deriveRestoreOutcome`（node-inventory.ts）：`WHERE rig_id=? AND type IN
 *     ('restore.*') ORDER BY seq DESC` 使用 `idx_events_rig_seq`，但 `type` 无索引，所以为寻找
 *     最新 restore 事件会反向遍历该 rig 的所有事件，包括高频 `agent.activity`。
 *   - `getLatestForNode`（agent-activity-store.ts）与 `deriveHeldReason` 的 `node.held` 查询
 *     使用相同的 `node_id` 过滤反向模式。
 * `events` 表只追加且完全不清理（为审计在 rig/node 删除后仍保留），因此会无限增长；每次扫描
 * 越来越长，直到单线程 better-sqlite3 循环饿死 `/healthz`。
 *
 * 修复（增量、仅索引——不改数据）：添加覆盖索引，把主要卡点的反向遍历从扫描整个日志改为只在
 * 相关 (node_id, type) 分区做有界索引查找。
 *   - idx_events_node_type_seq (node_id, type, seq)——服务主要卡点 `deriveOriented`
 *     （按 node_id + type 过滤，ORDER BY seq DESC；此前无索引，因此 CPU 样本中出现全表反向
 *     扫描），以及 `getLatestForNode` 和 `deriveHeldReason` 的 node.held 查询（二者使用相同的
 *     node_id + type 反向模式）。
 * 此处不处理 `deriveRestoreOutcome`（按 rig_id + type 过滤）：它已经使用现有
 * `idx_events_rig_seq(rig_id, seq)`（SQLite 规划器偏好该索引，因为它无需排序即可满足
 * ORDER BY seq DESC；经 EXPLAIN QUERY PLAN 验证，(rig_id, type, seq) 索引不会被使用），
 * 因此它受限于单个 rig，并非全表卡点。这是二阶成本，由另一个受控后续项通过折叠逐节点 N+1
 *（每个 rig 一次窗口查询）解决。另一个受控后续项是 agent.activity 保留/清理。二者均不属于
 * 本次热修复。CREATE INDEX IF NOT EXISTS 幂等，可安全应用于已有数据的实时 events 表
 *（SQLite 一次遍历建立索引，不重写 schema/数据）。
 *
 * 编号使用 046_seat_identity_verdicts.ts 之后的下一个可用值。
 */
export const eventsNodeTypeIndexSchema: Migration = {
  name: "047_events_node_type_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_node_type_seq ON events(node_id, type, seq);
  `,
};
