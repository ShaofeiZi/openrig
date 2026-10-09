import type { Migration } from "../migrate.js";

/**
 * GHOST-STAGE（e/Class-B）——持久 seat-ROLE 存储上的 occupant-generation 标记。
 *
 * Class-B 存储（queue_items、watchdog_jobs）以跨 handover 延续的席位名称（member@rig）为键，
 * 因此按名称范围丢弃会使继任者自身合法的角色条目失效。只有绑定到退役代特定在途工作的条目才是
 * ghost。这些列保存 CONTEXT-BINDING 操作的 occupant-generation（atom-B `generation_uuid`），
 * 使 invalidator 能按代而非名称区分退役者与继任者的条目。
 *
 * 标记绑定操作，而非仅标记 INSERT（编排裁定）：由 seat-A gen-X 铸造、但被 seat-B gen-Y CLAIM
 * 的条目需要 CLAIMANT 的代来做 ghost 检查；只有 minting-gen 会重现误报。
 *   - queue_items.minting_generation_uuid——INSERT 时设置（创建 occupant 的代）。
 *   - queue_items.claimed_by_generation_uuid——CLAIM 时设置，release 时清除（CLAIMANT 的代；
 *                                              这是 queue-item ghost 判别项）。
 *   - watchdog_jobs.registered_by_generation_uuid——arm 时设置（注册 occupant 的代）。
 *
 * 全部可空且无默认值：063 之前的行和未标记写入方保持 NULL；NULL 代表示 UNKNOWN，因此
 * invalidator 的代谓词绝不会匹配（未知时绝不 drop/release——note-2）。使用增量 ALTER；防御性
 * 列检测读取使 063 之前的 fixture 能干净降级。
 */
export const occupantGenerationStampsSchema: Migration = {
  name: "063_occupant_generation_stamps.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN minting_generation_uuid TEXT;
    ALTER TABLE queue_items ADD COLUMN claimed_by_generation_uuid TEXT;
    ALTER TABLE watchdog_jobs ADD COLUMN registered_by_generation_uuid TEXT;
  `,
};
