// Slice 11（workflow-spec-folder-discovery）——迁移 040 向 workflow_specs 添加 status 和
// error_message 列。WorkflowSpecCache 新增 writeDiagnostic / removeBySourcePath /
// queryDiagnostics 方法，使扫描器能把无效 YAML 记录为诊断行。
//
// SC-29 #10（提交正文中的逐字声明）：Slice 11 需要 schema 迁移
// 040_workflow_specs_diagnostic.ts，为 workflow_specs 缓存添加默认值为 'valid' 的 status TEXT
// 和 error_message TEXT 列。不新增表，除默认值外不改变约束；ALTER TABLE ADD COLUMN 保留
// 现有记录（默认 'valid' 会追溯填充已缓存记录）。这是只读诊断表面：缓存保存解析器/校验器错误，
// 供 Library UI 渲染，后台服务不会依据诊断状态采取行动。按照 IMPL-PRD §HG-8
// “除非出处或状态列需要迁移，如需则预先声明”，已在本 slice ACK 和提交正文中预先声明。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowSpecsDiagnosticSchema } from "../src/db/migrations/040_workflow_specs_diagnostic.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe("migration 040 — workflow_specs diagnostic columns", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });
  afterEach(() => {
    db.close();
  });

  it("向 workflow_specs 添加默认值为 'valid' 的 status TEXT 列", () => {
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    const cols = db.prepare("PRAGMA table_info(workflow_specs)").all() as ColumnRow[];
    const status = cols.find((c) => c.name === "status");
    expect(status).toBeDefined();
    expect(status?.type.toUpperCase()).toBe("TEXT");
    // SQLite 默认值转义：'valid' 存储为字符串字面量。
    expect(status?.dflt_value).toMatch(/'valid'|valid/);
  });

  it("向 workflow_specs 添加可空的 error_message TEXT 列", () => {
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    const cols = db.prepare("PRAGMA table_info(workflow_specs)").all() as ColumnRow[];
    const errorMessage = cols.find((c) => c.name === "error_message");
    expect(errorMessage).toBeDefined();
    expect(errorMessage?.type.toUpperCase()).toBe("TEXT");
    expect(errorMessage?.notnull).toBe(0);
  });

  it("迁移应用后，现有记录通过默认值保持 valid 状态", () => {
    // 应用 040 前 schema 并插入记录，再应用 040；由于既有 read-through 路径从未设置 status，
    // 该记录应默认为 'valid'。
    migrate(db, [coreSchema, workflowSpecsSchema]);
    db.prepare(
      `INSERT INTO workflow_specs (spec_id, name, version, purpose, target_rig, roles_json, steps_json, coordination_terminal_turn_rule, source_path, source_hash, cached_at)
       VALUES ('s1', 'pre-040', '1.0', null, null, '{}', '[]', 'hot_potato', '/x.yaml', 'h', '2026-05-11T00:00:00Z')`,
    ).run();
    migrate(db, [workflowSpecsDiagnosticSchema]);
    const row = db
      .prepare("SELECT status, error_message FROM workflow_specs WHERE spec_id = ?")
      .get("s1") as { status: string; error_message: string | null };
    expect(row.status).toBe("valid");
    expect(row.error_message).toBeNull();
  });

  it("迁移保持幂等（重复应用不报错）", () => {
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    // 重复应用应为空操作（ALTER TABLE ADD COLUMN IF NOT EXISTS）。
    expect(() => {
      migrate(db, [workflowSpecsDiagnosticSchema]);
    }).not.toThrow();
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";

const VALID_DIAG_SAMPLE = `workflow:
  id: valid-spec
  version: '1'
  objective: test fixture
  target:
    rig: rig-fix
  entry:
    role: a
  roles:
    a:
      preferred_targets:
        - a@rig-fix
  steps:
    - id: s1
      actor_role: a
      objective: x
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;

describe("WorkflowSpecCache diagnostic methods (slice 11)", () => {
  let db: Database.Database;
  let cache: WorkflowSpecCache;
  let tmp: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(joinPath(tmpdir(), "wf-diag-"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writeDiagnostic 按 source_path 存储错误记录", () => {
    cache.writeDiagnostic({
      sourcePath: "/x/broken.yaml",
      sourceHash: "h1",
      errorMessage: "YAML parse error at line 3",
    });
    const row = db
      .prepare(
        `SELECT name, status, error_message, source_path
         FROM workflow_specs WHERE source_path = ?`,
      )
      .get("/x/broken.yaml") as {
        name: string;
        status: string;
        error_message: string;
        source_path: string;
      };
    expect(row.status).toBe("error");
    expect(row.error_message).toBe("YAML parse error at line 3");
    expect(row.source_path).toBe("/x/broken.yaml");
    // 名称回退使用文件 basename，使 Library 即使无法解析 YAML 也能渲染记录标识。
    expect(row.name).toBe("broken.yaml");
  });

  it("writeDiagnostic 按 source_path 原地更新现有诊断记录", () => {
    cache.writeDiagnostic({
      sourcePath: "/x/broken.yaml",
      sourceHash: "h1",
      errorMessage: "first error",
    });
    cache.writeDiagnostic({
      sourcePath: "/x/broken.yaml",
      sourceHash: "h2",
      errorMessage: "second error after edit",
    });
    const rows = db
      .prepare(`SELECT * FROM workflow_specs WHERE source_path = ?`)
      .all("/x/broken.yaml") as Array<{ error_message: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error_message).toBe("second error after edit");
  });

  it("removeBySourcePath 同时移除合法记录和诊断记录", () => {
    cache.writeDiagnostic({
      sourcePath: "/x/gone.yaml",
      sourceHash: "h",
      errorMessage: "err",
    });
    const removed = cache.removeBySourcePath("/x/gone.yaml");
    expect(removed).toBe(1);
    const remaining = db
      .prepare(`SELECT COUNT(*) as n FROM workflow_specs WHERE source_path = ?`)
      .get("/x/gone.yaml") as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("记录不存在时 removeBySourcePath 返回 0", () => {
    expect(cache.removeBySourcePath("/never/exists.yaml")).toBe(0);
  });

  it("listAll 同时暴露合法记录和诊断记录", () => {
    const validPath = joinPath(tmp, "valid.yaml");
    writeFileSync(validPath, VALID_DIAG_SAMPLE);
    cache.readThrough(validPath);
    cache.writeDiagnostic({
      sourcePath: "/x/broken.yaml",
      sourceHash: "h",
      errorMessage: "err",
    });
    const all = cache.listAll();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((r) => r.name === "valid-spec")).toBe(true);
    expect(all.some((r) => r.name === "broken.yaml")).toBe(true);
  });
});
