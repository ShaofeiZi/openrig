import type { Migration } from "../migrate.js";

/**
 * 51-09 增量 1——持久化的后台服务 SELF-HOST 身份记录。
 *
 * 架构裁定 cb19867f（Q1）：canonical self-host 身份是全新内容——当前没有权威自记录，只有
 * 仅供展示的 `host.name`（settings）、位置型 `"local"` 哨兵（fanout-contract），以及主机注册表
 * 中他人分配给本机的标签。此表保存后台服务自身权威、持久、跨重启稳定的 self-host id，并在启动时
 * 与席位身份基底一起协调（slice-13 协调谱系）。
 *
 * 单例：恰好一行（`singleton = 1` CHECK）。`host_id` 在首次启动时只铸造一次，之后只协调
 *（绝不重新铸造），因此重启后 id 相同。`minted_at` 永不移动；`reconciled_at` 每次启动推进。
 * id 绝不会落入 `"local"`/`"kernel"`/`"host"` 保留集合，也不会是 `"localhost"` 展示
 * 默认值（由 reconciler 断言）。编号使用 058_rig_policy_provenance.ts 之后的下一个可用值。
 */
export const selfHostIdentitySchema: Migration = {
  name: "059_self_host_identity.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS self_host_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      host_id TEXT NOT NULL,
      minted_at TEXT NOT NULL,
      reconciled_at TEXT NOT NULL
    );
  `,
};
