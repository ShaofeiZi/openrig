import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6 FS-1（后台服务读取路径加固，W1.1）——sessions 逐节点新近度索引。
 *
 * 根因（架构落地 ARCH-DESIGN-GROUNDING-fs1-2026-07-06，F1；在 384e60f1 一手复验）：
 * `sessions` 表（002_bindings_sessions.ts）创建时在 `node_id` 上没有任何索引，唯一索引是
 * `id` PRIMARY KEY 自动索引。因此“每个节点的最新 session”子查询
 * `(SELECT s2.id FROM sessions s2 WHERE s2.node_id = ? ORDER BY … LIMIT 1)`
 * 会全表扫描 `sessions`；它在高频 `/api/ps` 路径的三个位置逐节点出现，再乘以 rig 层 N+1
 *（getEntries 遍历 rigs），一次轮询会多次扫描 `sessions`（该主机形态下卡顿 0.6–0.9 秒）。
 * 三个位置及其 ORDER BY（也是使用三列索引的原因）：
 *   - ps-projection.ts:157      ORDER BY created_at DESC, id DESC   ← 承重形态
 *   - node-inventory.ts:442     ORDER BY id DESC
 *   - ps-projection.ts:256      ORDER BY id DESC
 *
 * 索引形态 = (node_id, created_at DESC, id DESC)——架构裁定（B），由 fixture 实测证据而非偏好决定。
 * 在真实事故 fixture（24 rigs/175 nodes/445 sessions）上测量前后差异——证据：
 *   missions/release-0.4.6/slices/01-fs1-daemon-read-path-hardening/proof/
 *   perf-hardening-evidence/W1.1-sessions-index-measure-2026-07-06-dev44-driver2.md
 *   - id-DESC 位置（:442、:256）：全扫描 → 覆盖查找，约 63 倍
 *     （0.677s→0.011s/52.5k 次评估）。
 *   - created_at 位置（:157）：使用两列 (node_id, id DESC) 索引时会查询 node_id，但仍保留
 *     TEMP B-TREE 排序（约 18.6 倍）；使用本三列索引时变为无排序的
 *     `SEARCH … USING COVERING INDEX`（约 95 倍，0.856s→0.009s）——实测约 5 倍差距决定了形态。
 *   - 在 10 倍规模（4450 sessions）证明边界：全扫描 8.4s（随数据增长），查找 0.024s
 *     （近似恒定），约 350 倍。CREATE INDEX 用时 0.013s，可安全用于已有数据。
 * 三列索引以 `node_id` 开头（等值查找），因此两个 id-DESC 位置仍可用 node_id 查找并消除全扫描；
 * 剩余成本只是每节点约 2–3 行的排序（445 sessions/175 nodes），架构裁定为噪声。裁定只建一个
 * 索引：此迁移扩展为三列形态，绝不新增同级索引（第二个索引只会增加写放大和空间，且无实测需求）。
 *
 * CREATE INDEX IF NOT EXISTS 幂等，可安全用于已有数据的实时表（SQLite 一次遍历建立索引，
 * 不更改 schema/数据）。
 *
 * 同级审计（架构 D1.1）：rigs 投影中的 snapshots(rig_id, created_at) 子查询属于 W1 的另一项
 * 索引审计，不属于本迁移。
 *
 * 编号 053：主线已发布 051_workflow_resume，FAC-1 预留 052_workflow_instance_bound_rig，
 * 因此 FS-1 的索引迁移从 051 重编号为 053（编排去冲突 2026-07-06；rebase/验证时需根据最终
 * 合并树复核空位）。索引名称和形态不变。
 */
export const sessionsNodeIdIndexSchema: Migration = {
  name: "053_sessions_node_id_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_sessions_node_created_id
      ON sessions(node_id, created_at DESC, id DESC);
  `,
};
