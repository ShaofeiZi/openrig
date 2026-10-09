import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  return db;
}

describe("P5-T00：Bootstrap schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  // T1：bootstrap_runs 表具备所有列
  it("bootstrap_runs 表具备所有列", () => {
    const cols = db.pragma("table_info(bootstrap_runs)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("source_kind");
    expect(names).toContain("source_ref");
    expect(names).toContain("status");
    expect(names).toContain("rig_id");
    expect(names).toContain("created_at");
    expect(names).toContain("applied_at");
  });

  // T2：bootstrap_actions 外键到 bootstrap_runs
  it("bootstrap_actions 外键强制——不存在的 bootstrap_id 抛错", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO bootstrap_actions (id, bootstrap_id, seq, action_kind, status) VALUES (?, ?, ?, ?, ?)"
      ).run("a-1", "nonexistent", 1, "runtime_check", "planned");
    }).toThrow(/FOREIGN KEY/);
  });

  // T3：runtime_verifications 表具备所有列
  it("runtime_verifications 表具备所有列", () => {
    const cols = db.pragma("table_info(runtime_verifications)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("runtime");
    expect(names).toContain("version");
    expect(names).toContain("capabilities_json");
    expect(names).toContain("verified_at");
    expect(names).toContain("status");
    expect(names).toContain("error");
  });

  // T4：package_installs 有 bootstrap_id 列
  it("package_installs 有 bootstrap_id 列", () => {
    const cols = db.pragma("table_info(package_installs)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("bootstrap_id");
  });

  // T5：插入 bootstrap run，按 status 查询
  it("插入 bootstrap run 并按 status 查询", () => {
    db.prepare(
      "INSERT INTO bootstrap_runs (id, source_kind, source_ref) VALUES (?, ?, ?)"
    ).run("bs-1", "rig_spec", "/tmp/rig.yaml");

    const row = db.prepare("SELECT * FROM bootstrap_runs WHERE status = ?")
      .get("planned") as { id: string; source_kind: string; source_ref: string; status: string };

    expect(row.id).toBe("bs-1");
    expect(row.source_kind).toBe("rig_spec");
    expect(row.source_ref).toBe("/tmp/rig.yaml");
    expect(row.status).toBe("planned");
  });

  // T6：按 seq 顺序插入 bootstrap actions
  it("按 seq 顺序插入 actions 并按序取回", () => {
    db.prepare(
      "INSERT INTO bootstrap_runs (id, source_kind, source_ref) VALUES (?, ?, ?)"
    ).run("bs-1", "rig_spec", "/tmp/rig.yaml");

    db.prepare(
      "INSERT INTO bootstrap_actions (id, bootstrap_id, seq, action_kind, subject_name, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("a-2", "bs-1", 2, "package_install", "acme-tools", "planned");
    db.prepare(
      "INSERT INTO bootstrap_actions (id, bootstrap_id, seq, action_kind, subject_name, status) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("a-1", "bs-1", 1, "runtime_check", "tmux", "planned");

    const rows = db.prepare(
      "SELECT * FROM bootstrap_actions WHERE bootstrap_id = ? ORDER BY seq ASC"
    ).all("bs-1") as Array<{ id: string; seq: number; action_kind: string; subject_name: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]!.seq).toBe(1);
    expect(rows[0]!.action_kind).toBe("runtime_check");
    expect(rows[0]!.subject_name).toBe("tmux");
    expect(rows[1]!.seq).toBe(2);
    expect(rows[1]!.action_kind).toBe("package_install");
  });

  // T7：runtime verification 往返
  it("runtime verification 插入并读回往返", () => {
    db.prepare(
      "INSERT INTO runtime_verifications (id, runtime, version, capabilities_json, status) VALUES (?, ?, ?, ?, ?)"
    ).run("rv-1", "tmux", "3.4", '{"utf8":true}', "verified");

    const row = db.prepare("SELECT * FROM runtime_verifications WHERE id = ?")
      .get("rv-1") as { id: string; runtime: string; version: string; capabilities_json: string; status: string };

    expect(row.runtime).toBe("tmux");
    expect(row.version).toBe("3.4");
    expect(row.capabilities_json).toBe('{"utf8":true}');
    expect(row.status).toBe("verified");
  });

  // T8：删除带关联 install 的 bootstrap_run → 成功，install 保留且 bootstrap_id = NULL
  it("删除带关联 install 的 bootstrap_run 经 ON DELETE SET NULL 成功", () => {
    // 创建 package（install 外键所需）
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "hash");

    // 创建 bootstrap run
    db.prepare(
      "INSERT INTO bootstrap_runs (id, source_kind, source_ref) VALUES (?, ?, ?)"
    ).run("bs-1", "rig_spec", "/tmp/rig.yaml");

    // 创建关联到 bootstrap run 的 install
    db.prepare(
      "INSERT INTO package_installs (id, package_id, target_root, scope, bootstrap_id) VALUES (?, ?, ?, ?, ?)"
    ).run("inst-1", "pkg-1", "/tmp/repo", "project_shared", "bs-1");

    // 删除 bootstrap run——因 ON DELETE SET NULL 应成功
    db.prepare("DELETE FROM bootstrap_runs WHERE id = ?").run("bs-1");

    // install 行必须保留且 bootstrap_id 被置空
    const install = db.prepare("SELECT * FROM package_installs WHERE id = ?")
      .get("inst-1") as { id: string; bootstrap_id: string | null };

    expect(install).toBeDefined();
    expect(install.id).toBe("inst-1");
    expect(install.bootstrap_id).toBeNull();
  });

  // T9：createDaemon 应用 migration 011
  it("createDaemon 应用 migration 011（bootstrap 表 + package_installs.bootstrap_id）", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { db: daemonDb } = await createDaemon({ dbPath: ":memory:" });

    try {
      const tables = daemonDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      ).all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("bootstrap_runs");
      expect(tableNames).toContain("bootstrap_actions");
      expect(tableNames).toContain("runtime_verifications");

      // package_installs 有 bootstrap_id 列
      const cols = daemonDb.pragma("table_info(package_installs)") as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("bootstrap_id");
    } finally {
      daemonDb.close();
    }
  });
});
