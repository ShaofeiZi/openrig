import type { Migration } from "../migrate.js";

// GHOST-STAGE atom-B（P12 裁定 3548d8eb）：occupant-generation TENURE 台账。
//
// `sessions` 行表示注册，而不是 tenure；把一行当成一代会铸造虚假的代。此只追加台账为节点上的
// 每一 OCCUPANT GENERATION 记录一行，由 registry 在 registerSession/registerClaimedSession 时铸造
//（调用方声明 `kind`）。`generation_uuid` 标识一次 occupant tenure：它在 tenure 内持续不变
//（同一原生 session 的重新启动是继续，而非新一代），但在新 occupant 到来时变化——handover/
// swap/repair 到不同原生 session 会铸造新的 generation_uuid（provider 原生 session id 是独立指针，
// 即 51-09 拆分）。消费者比较记录值与实时 generation_uuid，对陈旧代状态设门禁（ghost-stage
// 缺陷）：代发生变化就是旧 tenure 已结束的信号。node_id 是跨 handover/swap/repair 保持稳定的
// 身份，即跨交接键。
//
// 诚实边界：node_id 不会跨节点的 `rig` 销毁重建保留——这不属于本台账范围（重建节点确实是新身份）。
// 在此明确标注，避免消费者假定存在跨销毁连续性。
export const occupantTenuresSchema: Migration = {
  name: "060_occupant_tenures.sql",
  sql: `
    CREATE TABLE occupant_tenures (
      id                        TEXT PRIMARY KEY,
      node_id                   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      generation_ordinal        INTEGER NOT NULL,
      generation_uuid           TEXT NOT NULL UNIQUE,
      kind                      TEXT NOT NULL,
      native_session_id_at_boot TEXT,
      boot_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(node_id, generation_ordinal)
    );
    CREATE INDEX idx_occupant_tenures_node ON occupant_tenures(node_id);
  `,
};
