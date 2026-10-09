// Slice 11（release-0.3.1 workflow-spec-folder-discovery）——scanWorkflowSpecFolder 的 TDD。
// 遍历 workspace.specs_root/workflows/，解析并验证每个 YAML，再填充 cache。无效 YAML 通过
// cache.writeDiagnostic 生成 diagnostic row；删除文件时通过 cache.removeBySourcePath 移除
// cache row。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowSpecsDiagnosticSchema } from "../src/db/migrations/040_workflow_specs_diagnostic.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { scanWorkflowSpecFolder } from "../src/domain/spec-library-workflow-scanner.js";
import { EventBus } from "../src/domain/event-bus.js";

const VALID_YAML = `workflow:
  id: folder-test
  version: '1'
  objective: A folder-scan fixture
  target:
    rig: folder-fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@folder-fixture
  steps:
    - id: produce
      actor_role: producer
      objective: Draft.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;

const INVALID_YAML = `workflow:
  id: bad-spec
  # missing required 'version', 'roles', 'steps'
  objective: This will not parse cleanly
`;

const VALID_YAML_TWO = `workflow:
  id: folder-test-2
  version: '1'
  objective: second fixture
  target:
    rig: folder-fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@folder-fixture
  steps:
    - id: produce
      actor_role: producer
      objective: Draft.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;

describe("scanWorkflowSpecFolder (slice 11)", () => {
  let db: Database.Database;
  let cache: WorkflowSpecCache;
  let folder: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    cache = new WorkflowSpecCache(db);
    folder = mkdtempSync(join(tmpdir(), "wf-folder-"));
  });
  afterEach(() => {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("文件夹不存在时返回空数组", () => {
    rmSync(folder, { recursive: true, force: true });
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result).toEqual({ scanned: 0, valid: 0, errors: 0, removed: 0, skipped: 0 });
  });

  it("扫描有效 YAML 文件 → cache row + 扫描摘要 1/1/0/0", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result).toEqual({ scanned: 1, valid: 1, errors: 0, removed: 0, skipped: 0 });
    const all = cache.listAll();
    const row = all.find((r) => r.name === "folder-test");
    expect(row).toBeDefined();
    expect(row?.sourcePath).toBe(join(folder, "wf.yaml"));
  });

  it("扫描无效 YAML → diagnostic row + 扫描摘要 1/0/1/0", () => {
    writeFileSync(join(folder, "bad.yaml"), INVALID_YAML);
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result).toEqual({ scanned: 1, valid: 0, errors: 1, removed: 0, skipped: 0 });
    const row = db
      .prepare(
        `SELECT name, status, error_message FROM workflow_specs WHERE source_path = ?`,
      )
      .get(join(folder, "bad.yaml")) as {
        name: string;
        status: string;
        error_message: string;
      };
    expect(row.status).toBe("error");
    expect(row.error_message).toBeTruthy();
    expect(row.name).toBe("bad.yaml");
  });

  it("第二次扫描通过 mtime 检查跳过未变化文件（OQ-3）", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    // 记录原始 cached_at 后再次扫描；cached_at 不应变化。
    const before = db
      .prepare(`SELECT cached_at FROM workflow_specs WHERE name = ?`)
      .get("folder-test") as { cached_at: string };
    // 第二次扫描对未变化文件应为 no-op。
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.scanned).toBe(1);
    // skipped 文件不计入 valid（重新 parse）或 errors，而是由单独的 `skipped` 字段计数，
    // 便于观测。
    expect(result.skipped).toBe(1);
    expect(result.valid).toBe(0);
    const after = db
      .prepare(`SELECT cached_at FROM workflow_specs WHERE name = ?`)
      .get("folder-test") as { cached_at: string };
    expect(after.cached_at).toBe(before.cached_at);
  });

  it("文件 mtime 晚于 cached_at 时重新解析", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    // 推进 mtime，使文件看起来比 cache 更新。
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(folder, "wf.yaml"), future, future);
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.scanned).toBe(1);
    expect(result.valid).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("文件消失时移除 cache row（OQ-4）", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    writeFileSync(join(folder, "wf2.yaml"), VALID_YAML_TWO);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(cache.listAll().filter((r) => r.sourcePath.startsWith(folder))).toHaveLength(2);
    // 删除 wf.yaml，保留 wf2.yaml。
    rmSync(join(folder, "wf.yaml"));
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.removed).toBe(1);
    const remaining = cache.listAll().filter((r) => r.sourcePath.startsWith(folder));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe("folder-test-2");
  });

  it("不移除 source_path 位于扫描文件夹外的 cache row", () => {
    // 从不同 source root（例如 built-in starter）预填种 row，确认 scanner 只操作自身文件夹边界。
    const externalPath = join(tmpdir(), "external-wf.yaml");
    writeFileSync(externalPath, VALID_YAML.replace("folder-test", "external-spec"));
    cache.readThrough(externalPath);
    // 现在扫描空文件夹，不应触碰外部 row。
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.removed).toBe(0);
    expect(cache.listAll().some((r) => r.name === "external-spec")).toBe(true);
    rmSync(externalPath);
  });

  it("为每个已删除文件发出 workflow_spec.removed audit event（HG-3）", () => {
    // OQ-4 acceptance criterion：删除必须同时产生 cache row removal 与 audit-log entry。
    // 没有 event emission 时，Library 虽显示 clean 状态，操作员却无法追踪哪个 spec 何时消失。
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    writeFileSync(join(folder, "wf2.yaml"), VALID_YAML_TWO);
    const eventBus = new EventBus(db);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null, eventBus });

    rmSync(join(folder, "wf.yaml"));
    const removedFilePath = join(folder, "wf.yaml");
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null, eventBus });
    expect(result.removed).toBe(1);

    const events = db
      .prepare(`SELECT type, payload FROM events WHERE type = 'workflow_spec.removed'`)
      .all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as { type: string; sourcePath: string; reason: string };
    expect(payload.type).toBe("workflow_spec.removed");
    expect(payload.sourcePath).toBe(removedFilePath);
    expect(payload.reason).toBe("file_disappeared");
  });

  it("多个文件消失时，每个文件各发出一个 workflow_spec.removed event", () => {
    // emission loop 的漂移判别器：两个不同删除必须产生两个 sourcePath 各异的 event，不能合并
    // 成一个 batch event，也不能重复同一 event。
    writeFileSync(join(folder, "a.yaml"), VALID_YAML);
    writeFileSync(join(folder, "b.yaml"), VALID_YAML_TWO);
    const eventBus = new EventBus(db);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null, eventBus });

    rmSync(join(folder, "a.yaml"));
    rmSync(join(folder, "b.yaml"));
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null, eventBus });
    expect(result.removed).toBe(2);

    const events = db
      .prepare(`SELECT payload FROM events WHERE type = 'workflow_spec.removed' ORDER BY seq`)
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(2);
    const paths = events.map((e) => (JSON.parse(e.payload) as { sourcePath: string }).sourcePath).sort();
    expect(paths).toEqual([join(folder, "a.yaml"), join(folder, "b.yaml")]);
  });

  it("省略 eventBus 时不发出 workflow_spec.removed，以保持向后兼容", () => {
    writeFileSync(join(folder, "wf.yaml"), VALID_YAML);
    scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    rmSync(join(folder, "wf.yaml"));
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.removed).toBe(1);
    const events = db
      .prepare(`SELECT COUNT(*) as n FROM events WHERE type = 'workflow_spec.removed'`)
      .get() as { n: number };
    expect(events.n).toBe(0);
  });

  it("漂移判别器：同次扫描为 3 个不同文件产生 3 种不同 outcome", () => {
    // 按已记录 feedback_poc_regression_must_discriminate，fixture 必须足够不同，使 scanner
    // 的逐文件决策分支可观测。
    writeFileSync(join(folder, "valid.yaml"), VALID_YAML);
    writeFileSync(join(folder, "bad.yaml"), INVALID_YAML);
    // 预缓存一条不同名称的 row，模拟“之前扫描过但现在已删除”，使 removal 分支也触发。
    cache.writeDiagnostic({
      sourcePath: join(folder, "previously-here.yaml"),
      sourceHash: "h",
      errorMessage: "stale",
    });
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    expect(result.scanned).toBe(2);
    expect(result.valid).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.removed).toBe(1);
  });
});
