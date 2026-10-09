import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function seedRigWithNodes(db: Database.Database, rigId: string, rigName: string, nodeIds: { id: string; logicalId: string }[]) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(rigId, rigName);
  for (const n of nodeIds) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(n.id, rigId, n.logicalId);
  }
}

describe("CheckpointStore", () => {
  let db: Database.Database;
  let store: CheckpointStore;

  beforeEach(() => {
    db = setupDb();
    store = new CheckpointStore(db);
    seedRigWithNodes(db, "rig-1", "r01", [
      { id: "node-1", logicalId: "worker-a" },
      { id: "node-2", logicalId: "worker-b" },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  it("createCheckpoint 持久化并返回带已解析 keyArtifacts 的类型化 Checkpoint", () => {
    const cp = store.createCheckpoint("node-1", {
      summary: "Implemented auth module",
      currentTask: "auth tests",
      nextStep: "write integration tests",
      blockedOn: null,
      keyArtifacts: ["src/auth.ts", "test/auth.test.ts"],
      confidence: "high",
    });

    expect(cp.id).toBeDefined();
    expect(cp.nodeId).toBe("node-1");
    expect(cp.summary).toBe("Implemented auth module");
    expect(cp.currentTask).toBe("auth tests");
    expect(cp.keyArtifacts).toEqual(["src/auth.ts", "test/auth.test.ts"]);
    expect(cp.confidence).toBe("high");
    expect(cp.createdAt).toBeDefined();
  });

  it("getLatestCheckpoint：按显式时间戳返回最新项", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-old", "node-1", "first", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-new", "node-1", "third", "[]", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-mid", "node-1", "second", "[]", "2026-03-23 02:00:00");

    const latest = store.getLatestCheckpoint("node-1");
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe("cp-new");
    expect(latest!.summary).toBe("third");
  });

  it("getLatestCheckpoint 无 checkpoint 时返回 null", () => {
    expect(store.getLatestCheckpoint("node-1")).toBeNull();
  });

  it("getCheckpointsForNode：全部按 created_at ASC 顺序返回", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-3", "node-1", "third", "[]", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1", "node-1", "first", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-2", "node-1", "second", "[]", "2026-03-23 02:00:00");

    const cps = store.getCheckpointsForNode("node-1");
    expect(cps.map((c) => c.id)).toEqual(["cp-1", "cp-2", "cp-3"]);
  });

  it("getCheckpointsForRig：返回以 node id 为 key 的 map，每个节点取最新项", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1a", "node-1", "node1 old", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1b", "node-1", "node1 new", "[]", "2026-03-23 02:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-2a", "node-2", "node2 only", "[]", "2026-03-23 01:00:00");

    const map = store.getCheckpointsForRig("rig-1");
    expect(Object.keys(map).sort()).toEqual(["node-1", "node-2"]);
    expect(map["node-1"]!.id).toBe("cp-1b"); // latest
    expect(map["node-2"]!.id).toBe("cp-2a");
  });

  it("getCheckpointsForRig：没有 checkpoint 的节点在 map 中为 null", () => {
    // node-1 有 checkpoint，node-2 没有。
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1", "node-1", "has checkpoint", "[]", "2026-03-23 01:00:00");

    const map = store.getCheckpointsForRig("rig-1");
    expect(map["node-1"]).not.toBeNull();
    expect(map["node-2"]).toBeNull();
  });

  it("getCheckpointsForRig：多个节点分别获得各自最新 checkpoint", () => {
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1old", "node-1", "n1 old", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1new", "node-1", "n1 new", "[]", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-2old", "node-2", "n2 old", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-2new", "node-2", "n2 new", "[]", "2026-03-23 02:00:00");

    const map = store.getCheckpointsForRig("rig-1");
    expect(map["node-1"]!.summary).toBe("n1 new");
    expect(map["node-2"]!.summary).toBe("n2 new");
  });

  it("getCheckpointsForRig：跨工作组隔离，只返回 rig-1 节点", () => {
    seedRigWithNodes(db, "rig-2", "r02", [
      { id: "node-3", logicalId: "worker-c" },
    ]);
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-1", "node-1", "rig1 checkpoint", "[]", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO checkpoints (id, node_id, summary, key_artifacts, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("cp-3", "node-3", "rig2 checkpoint", "[]", "2026-03-23 01:00:00");

    const map = store.getCheckpointsForRig("rig-1");

    // map 中只应包含 rig-1 节点。
    const nodeIds = Object.keys(map);
    expect(nodeIds).toContain("node-1");
    expect(nodeIds).toContain("node-2"); // null entry
    expect(nodeIds).not.toContain("node-3"); // rig-2 node excluded
  });
});
