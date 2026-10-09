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

describe("P4-T00：软件包存储 schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  // 测试 1：packages 表包含全部指定列
  it("packages 表包含全部指定列", () => {
    const cols = db.pragma("table_info(packages)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("name");
    expect(names).toContain("version");
    expect(names).toContain("source_kind");
    expect(names).toContain("source_ref");
    expect(names).toContain("manifest_hash");
    expect(names).toContain("summary");
    expect(names).toContain("created_at");
  });

  // 测试 2：package_installs 表包含全部列
  it("package_installs 表包含生命周期时间戳在内的全部列", () => {
    const cols = db.pragma("table_info(package_installs)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("package_id");
    expect(names).toContain("target_root");
    expect(names).toContain("scope");
    expect(names).toContain("status");
    expect(names).toContain("risk_tier");
    expect(names).toContain("created_at");
    expect(names).toContain("applied_at");
    expect(names).toContain("rolled_back_at");
  });

  // 测试 3：install_journal 表包含全部列
  it("install_journal 表包含哈希在内的全部列", () => {
    const cols = db.pragma("table_info(install_journal)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("install_id");
    expect(names).toContain("action");
    expect(names).toContain("export_type");
    expect(names).toContain("classification");
    expect(names).toContain("target_path");
    expect(names).toContain("backup_path");
    expect(names).toContain("before_hash");
    expect(names).toContain("after_hash");
    expect(names).toContain("status");
    expect(names).toContain("created_at");
  });

  // 测试 4：插入软件包 → 按 name+version 查询
  it("插入软件包并按 name+version 查询", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");

    const row = db.prepare("SELECT * FROM packages WHERE name = ? AND version = ?")
      .get("test-pkg", "1.0.0") as { id: string; name: string; version: string };

    expect(row.id).toBe("pkg-1");
    expect(row.name).toBe("test-pkg");
    expect(row.version).toBe("1.0.0");
  });

  // 测试 5：插入安装记录 → 按 package_id 查询
  it("插入安装记录并按 package_id 查询", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");

    db.prepare(
      "INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)"
    ).run("inst-1", "pkg-1", "/tmp/repo", "project_shared");

    const rows = db.prepare("SELECT * FROM package_installs WHERE package_id = ?")
      .all("pkg-1") as Array<{ id: string; status: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("inst-1");
    expect(rows[0]!.status).toBe("planned");
  });

  // 测试 6：插入 journal 条目 → 按 install_id 查询
  it("插入 journal 条目并按 install_id 查询", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");
    db.prepare(
      "INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)"
    ).run("inst-1", "pkg-1", "/tmp/repo", "project_shared");

    db.prepare(
      "INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path, before_hash, after_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("j-1", "inst-1", 1, "copy", "skill", "safe_projection", ".claude/skills/foo/SKILL.md", null, "def456");

    const rows = db.prepare("SELECT * FROM install_journal WHERE install_id = ?")
      .all("inst-1") as Array<{ id: string; action: string; after_hash: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("copy");
    expect(rows[0]!.after_hash).toBe("def456");
  });

  // 测试 7：packages(name, version) 的 UNIQUE 约束
  it("packages(name, version) 的 UNIQUE 约束", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");

    expect(() => {
      db.prepare(
        "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("pkg-2", "test-pkg", "1.0.0", "local_path", "/tmp/pkg2", "def456");
    }).toThrow(/UNIQUE/);
  });

  // 测试 8：删除仍有安装记录的软件包 → 外键错误，安装行保留
  it("删除仍有安装记录的软件包会抛出外键错误，且安装行保留", () => {
    db.prepare(
      "INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("pkg-1", "test-pkg", "1.0.0", "local_path", "/tmp/pkg", "abc123");
    db.prepare(
      "INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)"
    ).run("inst-1", "pkg-1", "/tmp/repo", "project_shared");

    expect(() => {
      db.prepare("DELETE FROM packages WHERE id = ?").run("pkg-1");
    }).toThrow(/FOREIGN KEY/);

    // 安装行必须保留
    const install = db.prepare("SELECT * FROM package_installs WHERE id = ?").get("inst-1");
    expect(install).toBeDefined();
  });

  // 测试 9：idx_installs_package 索引存在
  it("package_installs 上存在 idx_installs_package 索引", () => {
    const indexes = db.pragma("index_list(package_installs)") as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_installs_package");
  });

  // 测试 10：idx_journal_install 索引存在
  it("install_journal 上存在 idx_journal_install 索引", () => {
    const indexes = db.pragma("index_list(install_journal)") as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_journal_install");
  });

  // 测试 11：外键——插入引用不存在 package_id 的安装记录会失败
  it("插入引用不存在 package_id 的安装记录会抛出外键错误", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)"
      ).run("inst-1", "nonexistent-pkg", "/tmp/repo", "project_shared");
    }).toThrow(/FOREIGN KEY/);
  });

  // 测试 12：外键——插入引用不存在 install_id 的 journal 会失败
  it("插入引用不存在 install_id 的 journal 会抛出外键错误", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("j-1", "nonexistent-inst", 1, "copy", "skill", "safe_projection", "/target");
    }).toThrow(/FOREIGN KEY/);
  });

  // 测试 13：启动接线——createDaemon 应用 008/009
  it("createDaemon 创建 packages、package_installs 和 install_journal 表", async () => {
    // 关闭测试数据库——接下来使用 createDaemon 自己的数据库
    db.close();

    const { createDaemon } = await import("../src/startup.js");
    const { db: daemonDb } = await createDaemon({ dbPath: ":memory:" });

    try {
      const tables = daemonDb.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      ).all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("packages");
      expect(tableNames).toContain("package_installs");
      expect(tableNames).toContain("install_journal");
    } finally {
      daemonDb.close();
    }
  });

  // 测试 14：应用 010 后 install_journal 包含 seq 列
  it("install_journal 包含 seq 列", () => {
    const cols = db.pragma("table_info(install_journal)") as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("seq");
  });

  // 测试 15：install_journal 上的 UNIQUE(install_id, seq) 约束
  it("强制执行 UNIQUE(install_id, seq) 约束", () => {
    db.prepare("INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)").run("p1", "pkg", "1.0.0", "local_path", "/p", "h");
    db.prepare("INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)").run("i1", "p1", "/repo", "project_shared");
    db.prepare("INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?, ?)").run("j1", "i1", 1, "copy", "skill", "safe_projection", "/t1");

    expect(() => {
      db.prepare("INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?, ?)").run("j2", "i1", 1, "copy", "skill", "safe_projection", "/t2");
    }).toThrow(/UNIQUE/);
  });

  // 测试 16：createDaemon 应用 010（启动后 install_journal 中存在 seq 列）
  it("createDaemon 应用 010 迁移（install_journal 中存在 seq 列）", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { db: daemonDb } = await createDaemon({ dbPath: ":memory:" });

    try {
      const cols = daemonDb.pragma("table_info(install_journal)") as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("seq");
    } finally {
      daemonDb.close();
    }
  });
});
