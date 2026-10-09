import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";

describe("004_snapshots", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, snapshotsSchema]);
    // 为需要工作组的测试预置一个工作组
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
  });

  afterEach(() => {
    db.close();
  });

  it("创建 snapshots table", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("可以插入带 JSON blob + metadata column 的 snapshot", () => {
    const data = JSON.stringify({ rig: {}, nodes: [], edges: [], sessions: [], checkpoints: {} });
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data) VALUES (?, ?, ?, ?, ?)"
    ).run("snap-1", "rig-1", "manual", "complete", data);

    const snap = db.prepare("SELECT * FROM snapshots WHERE id = ?").get("snap-1") as {
      id: string; rig_id: string; kind: string; status: string; data: string; created_at: string;
    };
    expect(snap.rig_id).toBe("rig-1");
    expect(snap.kind).toBe("manual");
    expect(snap.status).toBe("complete");
    expect(JSON.parse(snap.data)).toHaveProperty("rig");
    expect(snap.created_at).toBeDefined();
  });

  it("插入时未提供 status 则默认为 'complete'", () => {
    const data = JSON.stringify({ rig: {} });
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)"
    ).run("snap-1", "rig-1", "manual", data);

    const snap = db.prepare("SELECT status FROM snapshots WHERE id = ?").get("snap-1") as {
      status: string;
    };
    expect(snap.status).toBe("complete");
  });

  it("按 rig_id 查询会返回匹配的 snapshot", () => {
    const data = "{}";
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-2", "other-rig");
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-1", "rig-1", "manual", data);
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-2", "rig-2", "manual", data);
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-3", "rig-1", "pre_restore", data);

    const rig1Snaps = db
      .prepare("SELECT id FROM snapshots WHERE rig_id = ?")
      .all("rig-1") as { id: string }[];
    expect(rig1Snaps).toHaveLength(2);
    expect(rig1Snaps.map((s) => s.id).sort()).toEqual(["snap-1", "snap-3"]);
  });

  it("按 kind 查询可正确过滤", () => {
    const data = "{}";
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-1", "rig-1", "manual", data);
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-2", "rig-1", "pre_restore", data);
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-3", "rig-1", "manual", data);

    const manualSnaps = db
      .prepare("SELECT id FROM snapshots WHERE rig_id = ? AND kind = ?")
      .all("rig-1", "manual") as { id: string }[];
    expect(manualSnaps).toHaveLength(2);

    const preRestoreSnaps = db
      .prepare("SELECT id FROM snapshots WHERE rig_id = ? AND kind = ?")
      .all("rig-1", "pre_restore") as { id: string }[];
    expect(preRestoreSnaps).toHaveLength(1);
    expect(preRestoreSnaps[0]!.id).toBe("snap-2");
  });

  it("查询按 created_at 排序（最新项在最后）", () => {
    const data = "{}";
    // 使用显式 timestamp 插入以控制顺序
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)").run("snap-old", "rig-1", "manual", data, "2026-03-23 01:00:00");
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)").run("snap-new", "rig-1", "manual", data, "2026-03-23 02:00:00");
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)").run("snap-mid", "rig-1", "manual", data, "2026-03-23 01:30:00");

    const snaps = db
      .prepare("SELECT id FROM snapshots WHERE rig_id = ? ORDER BY created_at")
      .all("rig-1") as { id: string }[];
    expect(snaps.map((s) => s.id)).toEqual(["snap-old", "snap-mid", "snap-new"]);
  });

  it("删除工作组不会删除 snapshot（普通 TEXT，并非 FK）", () => {
    const data = "{}";
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-1", "rig-1", "manual", data);

    db.prepare("DELETE FROM rigs WHERE id = ?").run("rig-1");

    const snaps = db.prepare("SELECT * FROM snapshots WHERE id = ?").get("snap-1");
    expect(snaps).toBeDefined();
  });

  it("允许 snapshot 使用不存在的 rig_id（orphan ref）", () => {
    const data = "{}";
    expect(() =>
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)").run("snap-1", "nonexistent-rig", "manual", data)
    ).not.toThrow();

    const snap = db.prepare("SELECT rig_id FROM snapshots WHERE id = ?").get("snap-1") as { rig_id: string };
    expect(snap.rig_id).toBe("nonexistent-rig");
  });
});
