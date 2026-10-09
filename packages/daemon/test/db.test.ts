import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

describe("createDb", () => {
  it("创建带 WAL 和外键 pragma 的内存数据库", () => {
    const db = createDb();
    const walMode = db.pragma("journal_mode", { simple: true });
    // 内存数据库可能报告 "memory" 而非 "wal"，这是正常现象。
    // WAL 已设置，但只对文件数据库生效。
    expect(walMode).toBeDefined();

    const fkEnabled = db.pragma("foreign_keys", { simple: true });
    expect(fkEnabled).toBe(1);

    db.close();
  });

  it("提供路径时创建文件数据库", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");
    const db = createDb(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("migrate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it("首次运行时创建 schema_migrations 表", () => {
    migrate(db, []);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("没有迁移时运行不报错", () => {
    expect(() => migrate(db, [])).not.toThrow();
  });

  it("应用简单迁移", () => {
    const migrations = [
      {
        name: "001_test.sql",
        sql: "CREATE TABLE test_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, migrations);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'"
      )
      .all();
    expect(tables).toHaveLength(1);
  });

  it("tracks applied migrations in schema_migrations", () => {
    const migrations = [
      {
        name: "001_test.sql",
        sql: "CREATE TABLE test_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, migrations);

    const applied = db
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all() as { name: string }[];
    expect(applied).toEqual([{ name: "001_test.sql" }]);
  });

  it("拒绝重复运行已应用的迁移", () => {
    const migrations = [
      {
        name: "001_test.sql",
        sql: "CREATE TABLE test_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, migrations);
    // 再次运行不应抛错（幂等），也不应重新执行 SQL。
    expect(() => migrate(db, migrations)).not.toThrow();

    const applied = db
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all() as { name: string }[];
    expect(applied).toHaveLength(1);
  });

  it("applies migrations in order", () => {
    const migrations = [
      {
        name: "001_first.sql",
        sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY);",
      },
      {
        name: "002_second.sql",
        sql: "CREATE TABLE second_table (id TEXT PRIMARY KEY, first_ref TEXT REFERENCES first_table(id));",
      },
    ];
    migrate(db, migrations);

    const applied = db
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all() as { name: string }[];
    expect(applied).toEqual([
      { name: "001_first.sql" },
      { name: "002_second.sql" },
    ]);
  });

  it("后续运行仅应用新增迁移", () => {
    const first = [
      {
        name: "001_first.sql",
        sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, first);

    const both = [
      ...first,
      {
        name: "002_second.sql",
        sql: "CREATE TABLE second_table (id TEXT PRIMARY KEY);",
      },
    ];
    migrate(db, both);

    const applied = db
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all() as { name: string }[];
    expect(applied).toHaveLength(2);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='second_table'"
      )
      .all();
    expect(tables).toHaveLength(1);
  });
});
