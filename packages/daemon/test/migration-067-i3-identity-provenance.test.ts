import { describe, it, expect } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

// P21 I3——迁移 067 把 era-stamp 审计边界（mig-065 模式）扩展到 QUEUE-SPINE 中携带身份的
// store。其契约与 065 的 mission_control_actions 列相同：I3 chokepoint 会写入
// `transport:v1` 的可空 identity_provenance；缺失即代表 claimed-era，不做回填。
describe("迁移 067——队列主干 store 上的 I3 era-stamp identity_provenance", () => {
  it("向 queue_transitions、inbox_entries、outbox_entries 和 stream_items 添加可空 identity_provenance 列", () => {
    // 使用随附的迁移全集初始化，而不是省略 inbox/outbox 基础表的 createFullTestDb 精选子集；
    // 通过 migration-fixture 对等性证明真实 ALL_MIGRATIONS 路径。
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    for (const table of ["queue_transitions", "inbox_entries", "outbox_entries", "stream_items"]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
      const col = cols.find((c) => c.name === "identity_provenance");
      expect(col, `${table} 必须携带 identity_provenance era-stamp`).toBeTruthy();
      // 可空性是承重契约：字段缺失本身就是 claimed-era 标记，绝不能回填或重新标记。
      expect(col!.notnull, `${table}.identity_provenance 必须允许 null`).toBe(0);
    }
  });
});
