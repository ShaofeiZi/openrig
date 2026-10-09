// PL-019 第 5 项：GET /api/rigs/:id/graph 使用的读侧联接辅助函数，用于按节点会话附加
// 进行中 qitem 的所有权。采用聚焦单元测试，以便无需启动依赖许多迁移/服务的完整路由栈，
// 即可验证 SQL 结构、数量上限和正文摘录行为。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { loadCurrentQitemsForSessions } from "../src/routes/rigs.js";

function insertQitem(db: Database.Database, opts: {
  qitemId: string;
  source: string;
  destination: string;
  state: string;
  body: string;
  tier?: string | null;
  tsUpdated?: string;
}): void {
  db.prepare(
    `INSERT INTO queue_items (
      qitem_id, ts_created, ts_updated, source_session, destination_session,
      state, priority, body, tier
    ) VALUES (?, ?, ?, ?, ?, ?, 'routine', ?, ?)`
  ).run(
    opts.qitemId,
    "2026-05-04T00:00:00.000Z",
    opts.tsUpdated ?? "2026-05-04T00:00:00.000Z",
    opts.source,
    opts.destination,
    opts.state,
    opts.body,
    opts.tier ?? null,
  );
}

describe("PL-019 loadCurrentQitemsForSessions 读侧联接", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  });

  afterEach(() => db.close());

  it("会话列表为空时返回空映射", () => {
    const result = loadCurrentQitemsForSessions(db, []);
    expect(result.size).toBe(0);
  });

  it("查询的会话不存在 qitem 时返回空映射", () => {
    insertQitem(db, { qitemId: "q1", source: "src@r", destination: "other@r", state: "in-progress", body: "x" });
    const result = loadCurrentQitemsForSessions(db, ["alpha@r", "beta@r"]);
    expect(result.size).toBe(0);
  });

  it("仅包含 state='in-progress' 的 qitem（排除 pending/closed/handed-off）", () => {
    insertQitem(db, { qitemId: "q-pending", source: "s@r", destination: "alpha@r", state: "pending", body: "p" });
    insertQitem(db, { qitemId: "q-inprog", source: "s@r", destination: "alpha@r", state: "in-progress", body: "wip" });
    insertQitem(db, { qitemId: "q-closed", source: "s@r", destination: "alpha@r", state: "closed", body: "done" });

    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    expect(result.get("alpha@r")).toHaveLength(1);
    expect(result.get("alpha@r")?.[0].qitemId).toBe("q-inprog");
  });

  it("按 destination_session 对 qitem 分组", () => {
    insertQitem(db, { qitemId: "q1", source: "s@r", destination: "alpha@r", state: "in-progress", body: "a" });
    insertQitem(db, { qitemId: "q2", source: "s@r", destination: "beta@r", state: "in-progress", body: "b" });
    insertQitem(db, { qitemId: "q3", source: "s@r", destination: "alpha@r", state: "in-progress", body: "c" });

    const result = loadCurrentQitemsForSessions(db, ["alpha@r", "beta@r"]);
    expect(result.get("alpha@r")).toHaveLength(2);
    expect(result.get("beta@r")).toHaveLength(1);
  });

  it("即使存在更多进行中行，每个节点也最多返回 3 个 qitem", () => {
    for (let i = 0; i < 6; i++) {
      insertQitem(db, {
        qitemId: `q-${i}`,
        source: "s@r",
        destination: "alpha@r",
        state: "in-progress",
        body: `row ${i}`,
        tsUpdated: `2026-05-04T00:00:0${i}.000Z`,
      });
    }
    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    expect(result.get("alpha@r")).toHaveLength(3);
  });

  it("正文超过 80 个字符时以省略号截取", () => {
    const longBody = "x".repeat(120);
    insertQitem(db, { qitemId: "q-long", source: "s@r", destination: "alpha@r", state: "in-progress", body: longBody });
    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    const entry = result.get("alpha@r")?.[0];
    expect(entry).toBeDefined();
    expect(entry!.bodyExcerpt.length).toBeLessThanOrEqual(81); // 80 + ellipsis
    expect(entry!.bodyExcerpt.endsWith("…")).toBe(true);
  });

  it("原样保留短正文", () => {
    insertQitem(db, { qitemId: "q-short", source: "s@r", destination: "alpha@r", state: "in-progress", body: "tiny" });
    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    expect(result.get("alpha@r")?.[0].bodyExcerpt).toBe("tiny");
  });

  it("按 ts_updated DESC 排序行（最近更新优先）", () => {
    insertQitem(db, { qitemId: "q-old", source: "s@r", destination: "alpha@r", state: "in-progress", body: "old", tsUpdated: "2026-05-04T00:00:00.000Z" });
    insertQitem(db, { qitemId: "q-mid", source: "s@r", destination: "alpha@r", state: "in-progress", body: "mid", tsUpdated: "2026-05-04T01:00:00.000Z" });
    insertQitem(db, { qitemId: "q-new", source: "s@r", destination: "alpha@r", state: "in-progress", body: "new", tsUpdated: "2026-05-04T02:00:00.000Z" });

    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    const list = result.get("alpha@r") ?? [];
    expect(list.map((q) => q.qitemId)).toEqual(["q-new", "q-mid", "q-old"]);
  });

  it("原样透传 tier（字符串或 null）", () => {
    insertQitem(db, { qitemId: "q-mode2", source: "s@r", destination: "alpha@r", state: "in-progress", body: "x", tier: "mode2" });
    insertQitem(db, { qitemId: "q-no-tier", source: "s@r", destination: "alpha@r", state: "in-progress", body: "y", tier: null, tsUpdated: "2026-05-04T01:00:00.000Z" });

    const result = loadCurrentQitemsForSessions(db, ["alpha@r"]);
    const list = result.get("alpha@r") ?? [];
    const tierMode2 = list.find((q) => q.qitemId === "q-mode2");
    const tierNull = list.find((q) => q.qitemId === "q-no-tier");
    expect(tierMode2?.tier).toBe("mode2");
    expect(tierNull?.tier).toBeNull();
  });
});
