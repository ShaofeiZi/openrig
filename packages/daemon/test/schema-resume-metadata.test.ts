import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";

function seedNode(db: Database.Database) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r01");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("node-1", "rig-1", "worker");
}

describe("006_resume_metadata", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it("迁移向 sessions 添加 resume_type 列", () => {
    migrate(db, [coreSchema, bindingsSessionsSchema, resumeMetadataSchema]);
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("resume_type");
  });

  it("迁移向 sessions 添加 resume_token 列", () => {
    migrate(db, [coreSchema, bindingsSessionsSchema, resumeMetadataSchema]);
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("resume_token");
  });

  it("迁移向 sessions 添加 restore_policy 列", () => {
    migrate(db, [coreSchema, bindingsSessionsSchema, resumeMetadataSchema]);
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("restore_policy");
  });

  it("迁移后已有 session 的 resume_type/resume_token 为 NULL", () => {
    // 应用基础 schema 并写入 session，然后再应用 resume 迁移。
    migrate(db, [coreSchema, bindingsSessionsSchema]);
    seedNode(db);
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)"
    ).run("sess-pre", "node-1", "r01-worker", "running");

    // 此时应用 resume 迁移。
    migrate(db, [coreSchema, bindingsSessionsSchema, resumeMetadataSchema]);

    const sess = db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get("sess-pre") as {
      resume_type: string | null;
      resume_token: string | null;
    };
    expect(sess.resume_type).toBeNull();
    expect(sess.resume_token).toBeNull();
  });

  it("迁移后已有 session 的 restore_policy 为 'resume_if_possible'", () => {
    migrate(db, [coreSchema, bindingsSessionsSchema]);
    seedNode(db);
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)"
    ).run("sess-pre", "node-1", "r01-worker", "running");

    migrate(db, [coreSchema, bindingsSessionsSchema, resumeMetadataSchema]);

    const sess = db.prepare("SELECT restore_policy FROM sessions WHERE id = ?").get("sess-pre") as {
      restore_policy: string;
    };
    expect(sess.restore_policy).toBe("resume_if_possible");
  });

  it("新插入记录的 restore_policy 默认为 'resume_if_possible'", () => {
    migrate(db, [coreSchema, bindingsSessionsSchema, resumeMetadataSchema]);
    seedNode(db);
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)"
    ).run("sess-1", "node-1", "r01-worker");

    const sess = db.prepare("SELECT restore_policy FROM sessions WHERE id = ?").get("sess-1") as {
      restore_policy: string;
    };
    expect(sess.restore_policy).toBe("resume_if_possible");
  });

  it("插入包含全部三个字段的 session 后，查询返回这些字段", () => {
    migrate(db, [coreSchema, bindingsSessionsSchema, resumeMetadataSchema]);
    seedNode(db);
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, resume_type, resume_token, restore_policy) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("sess-1", "node-1", "r01-worker", "claude_name", "my-session-token", "checkpoint_only");

    const sess = db.prepare("SELECT resume_type, resume_token, restore_policy FROM sessions WHERE id = ?").get("sess-1") as {
      resume_type: string;
      resume_token: string;
      restore_policy: string;
    };
    expect(sess.resume_type).toBe("claude_name");
    expect(sess.resume_token).toBe("my-session-token");
    expect(sess.restore_policy).toBe("checkpoint_only");
  });
});
