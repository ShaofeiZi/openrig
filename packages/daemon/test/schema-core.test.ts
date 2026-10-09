import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";

describe("001_core_schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema]);
  });

  afterEach(() => {
    db.close();
  });

  it("创建 rigs、nodes 和 edges 表", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("rigs");
    expect(names).toContain("nodes");
    expect(names).toContain("edges");
  });

  it("可以插入工作组", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-1",
      "test-rig"
    );
    const rig = db.prepare("SELECT * FROM rigs WHERE id = ?").get("rig-1") as {
      id: string;
      name: string;
    };
    expect(rig.name).toBe("test-rig");
  });

  it("可以插入引用工作组的节点", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-1",
      "test-rig"
    );
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run("node-1", "rig-1", "orchestrator", "orchestrator", "claude-code");

    const node = db
      .prepare("SELECT * FROM nodes WHERE id = ?")
      .get("node-1") as { logical_id: string; role: string };
    expect(node.logical_id).toBe("orchestrator");
    expect(node.role).toBe("orchestrator");
  });

  it("强制执行外键：节点必须引用有效工作组", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
        )
        .run("node-1", "nonexistent-rig", "worker")
    ).toThrow();
  });

  it("强制 (rig_id, logical_id) 唯一", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-1",
      "test-rig"
    );
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "rig-1", "worker");

    expect(() =>
      db
        .prepare(
          "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
        )
        .run("node-2", "rig-1", "worker")
    ).toThrow();
  });

  it("可以插入引用有效节点的边", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-1",
      "test-rig"
    );
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "rig-1", "orchestrator");
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-2", "rig-1", "worker");

    db.prepare(
      "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
    ).run("edge-1", "rig-1", "node-1", "node-2", "delegates_to");

    const edge = db
      .prepare("SELECT * FROM edges WHERE id = ?")
      .get("edge-1") as { kind: string };
    expect(edge.kind).toBe("delegates_to");
  });

  it("强制执行外键：边必须引用有效节点", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-1",
      "test-rig"
    );
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "rig-1", "orchestrator");

    expect(() =>
      db
        .prepare(
          "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
        )
        .run("edge-1", "rig-1", "node-1", "nonexistent", "delegates_to")
    ).toThrow();
  });

  it("拒绝源节点和目标节点分属不同工作组的边", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-1",
      "rig-one"
    );
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-2",
      "rig-two"
    );
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "rig-1", "worker-a");
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-2", "rig-2", "worker-b");

    expect(() =>
      db
        .prepare(
          "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
        )
        .run("edge-1", "rig-1", "node-1", "node-2", "delegates_to")
    ).toThrow(/同一个 rig/);
  });

  it("拒绝 rig_id 与源节点 rig_id 不匹配的边", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-1",
      "rig-one"
    );
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-2",
      "rig-two"
    );
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "rig-1", "worker-a");
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-2", "rig-1", "worker-b");

    // 节点属于 rig-1，但边声明自己属于 rig-2。
    expect(() =>
      db
        .prepare(
          "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
        )
        .run("edge-1", "rig-2", "node-1", "node-2", "delegates_to")
    ).toThrow(/rig_id 必须与源节点的 rig_id 匹配/);
  });

  it("级联删除：删除工作组时移除其节点和边", () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
      "rig-1",
      "test-rig"
    );
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-1", "rig-1", "orchestrator");
    db.prepare(
      "INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)"
    ).run("node-2", "rig-1", "worker");
    db.prepare(
      "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
    ).run("edge-1", "rig-1", "node-1", "node-2", "delegates_to");

    db.prepare("DELETE FROM rigs WHERE id = ?").run("rig-1");

    const nodes = db.prepare("SELECT * FROM nodes").all();
    const edges = db.prepare("SELECT * FROM edges").all();
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });
});
