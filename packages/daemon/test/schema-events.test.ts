import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";

describe("003_events", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema]);
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-1",
      "test-rig"
    );
  });

  afterEach(() => {
    db.close();
  });

  it("创建 events 表", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("能插入带 type 和 JSON payload 的事件", () => {
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-1", "node.added", JSON.stringify({ logicalId: "worker" }));

    const event = db.prepare("SELECT * FROM events WHERE rig_id = ?").get(
      "rig-1"
    ) as { seq: number; type: string; payload: string };
    expect(event.type).toBe("node.added");
    expect(JSON.parse(event.payload)).toEqual({ logicalId: "worker" });
    expect(typeof event.seq).toBe("number");
  });

  it("seq 自增且单调", () => {
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-1", "event.a", "{}");
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-1", "event.b", "{}");
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-1", "event.c", "{}");

    const events = db
      .prepare("SELECT seq FROM events ORDER BY seq")
      .all() as { seq: number }[];
    expect(events).toHaveLength(3);
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
    expect(events[1]!.seq).toBeLessThan(events[2]!.seq);
  });

  it("主不变量：WHERE seq > N 查询返回正确 replay 集", () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(
        "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
      ).run("rig-1", `event.${i}`, JSON.stringify({ index: i }));
    }

    const allEvents = db
      .prepare("SELECT seq FROM events ORDER BY seq")
      .all() as { seq: number }[];
    const seq2 = allEvents[1]!.seq; // 第二个事件

    // 在 seq2 之后 replay：应得到事件 3、4、5（索引 2、3、4）
    const replay = db
      .prepare(
        "SELECT seq, type, payload FROM events WHERE rig_id = ? AND seq > ? ORDER BY seq"
      )
      .all("rig-1", seq2) as { seq: number; type: string; payload: string }[];

    expect(replay).toHaveLength(3);
    expect(JSON.parse(replay[0]!.payload)).toEqual({ index: 2 });
    expect(JSON.parse(replay[1]!.payload)).toEqual({ index: 3 });
    expect(JSON.parse(replay[2]!.payload)).toEqual({ index: 4 });

    // 单调顺序
    expect(replay[0]!.seq).toBeLessThan(replay[1]!.seq);
    expect(replay[1]!.seq).toBeLessThan(replay[2]!.seq);
  });

  it("按 rig_id 查询正确过滤", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-2",
      "other-rig"
    );
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-1", "event.a", "{}");
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-2", "event.b", "{}");
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-1", "event.c", "{}");

    const rig1Events = db
      .prepare("SELECT * FROM events WHERE rig_id = ? ORDER BY seq")
      .all("rig-1") as { type: string }[];
    expect(rig1Events).toHaveLength(2);
    expect(rig1Events[0]!.type).toBe("event.a");
    expect(rig1Events[1]!.type).toBe("event.c");
  });

  it("node_id 可空——rig 级事件可工作", () => {
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-1", "rig.created", "{}");

    const event = db.prepare("SELECT node_id FROM events WHERE seq = 1").get() as {
      node_id: string | null;
    };
    expect(event.node_id).toBeNull();
  });

  // -- 显式契约：events.node_id 刻意不是外键。
  // -- events 是 append-only 日志。它们必须在节点删除后存活。
  // -- 设计理由见 003_events.ts。

  it("允许 node_id 引用不存在节点的事件（孤儿引用是刻意的）", () => {
    // node_id 是普通 TEXT，不是外键——孤儿引用是设计允许的，因为事件日志记录历史而非当前状态
    expect(() =>
      db
        .prepare(
          "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
        )
        .run("rig-1", "nonexistent-node", "node.added", "{}")
    ).not.toThrow();

    const event = db
      .prepare("SELECT node_id FROM events WHERE node_id = ?")
      .get("nonexistent-node") as { node_id: string };
    expect(event.node_id).toBe("nonexistent-node");
  });

  it("事件在节点删除后存活（append-only 历史保留）", () => {
    // 创建节点，为它发事件，删除节点——事件必须保留
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "rig-1", "worker");

    db.prepare(
      "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
    ).run("rig-1", "node-1", "node.added", '{"logicalId":"worker"}');
    db.prepare(
      "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
    ).run("rig-1", "node-1", "session.status_changed", '{"status":"running"}');

    // 删除节点
    db.prepare("DELETE FROM nodes WHERE id = ?").run("node-1");

    // 事件必须仍存在且原始 node_id 完整
    const events = db
      .prepare("SELECT node_id, type FROM events WHERE node_id = ? ORDER BY seq")
      .all("node-1") as { node_id: string; type: string }[];
    expect(events).toHaveLength(2);
    expect(events[0]!.node_id).toBe("node-1");
    expect(events[0]!.type).toBe("node.added");
    expect(events[1]!.node_id).toBe("node-1");
    expect(events[1]!.type).toBe("session.status_changed");
  });

  it("事件在 rig 删除后存活（审计轨迹保留）", () => {
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-1", "event.a", "{}");
    db.prepare(
      "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
    ).run("rig-1", "event.b", "{}");

    db.prepare("DELETE FROM rigs WHERE id = ?").run("rig-1");

    // 事件必须仍存在且原始 rig_id 完整
    const events = db
      .prepare("SELECT rig_id, type FROM events ORDER BY seq")
      .all() as { rig_id: string; type: string }[];
    expect(events).toHaveLength(2);
    expect(events[0]!.rig_id).toBe("rig-1");
    expect(events[1]!.rig_id).toBe("rig-1");
  });

  it("允许 rig_id 引用不存在 rig 的事件（孤儿引用）", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)"
        )
        .run("nonexistent-rig", "rig.created", "{}")
    ).not.toThrow();

    const event = db
      .prepare("SELECT rig_id FROM events WHERE rig_id = ?")
      .get("nonexistent-rig") as { rig_id: string };
    expect(event.rig_id).toBe("nonexistent-rig");
  });
});
