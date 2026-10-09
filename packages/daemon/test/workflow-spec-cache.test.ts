import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { WorkflowSpecCache, WorkflowSpecError, parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const SAMPLE_SPEC = `workflow:
  id: test-three-step
  version: 1
  objective: A 3-step test fixture
  target:
    rig: workflow-fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@workflow-fixture
    reviewer:
      preferred_targets:
        - reviewer@workflow-fixture
    finalizer:
      preferred_targets:
        - finalizer@workflow-fixture
  steps:
    - id: produce
      actor_role: producer
      objective: Draft the artifact.
      allowed_exits:
        - handoff
    - id: review
      actor_role: reviewer
      objective: Review the artifact.
      allowed_exits:
        - handoff
    - id: finalize
      actor_role: finalizer
      objective: Sign off.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
`;

describe("WorkflowSpecCache（PL-004 阶段 D）", () => {
  let db: Database.Database;
  let tmp: string;
  let cache: WorkflowSpecCache;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-spec-"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("readThrough 从 YAML spec 文件创建 cache 行", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC);
    const row = cache.readThrough(path);
    expect(row.specId).toMatch(/^[0-9A-Z]{26}$/);
    expect(row.name).toBe("test-three-step");
    expect(row.version).toBe("1");
    expect(row.spec.steps).toHaveLength(3);
    expect(row.spec.roles.producer).toBeDefined();
    expect(row.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("内容未变时 readThrough 返回相同 spec_id（hash 命中）", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC);
    const first = cache.readThrough(path);
    const second = cache.readThrough(path);
    expect(second.specId).toBe(first.specId);
    expect(second.cachedAt).toBe(first.cachedAt);
  });

  it("内容变化时 readThrough 就地重新缓存（hash 未命中；spec_id 相同；cached_at 前进）", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC);
    const first = cache.readThrough(path);
    writeFileSync(path, SAMPLE_SPEC + "\n# trailing comment\n");
    const second = cache.readThrough(path);
    // 相同 name+version → 相同 spec_id（就地 UPDATE）。
    expect(second.specId).toBe(first.specId);
    // 但该行已更新。
    expect(second.sourceHash).not.toBe(first.sourceHash);
  });

  it("路径不存在时 readThrough 抛出 spec_file_missing", () => {
    try {
      cache.readThrough(join(tmp, "nonexistent.yaml"));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_file_missing");
    }
  });

  // OPR.0.3.3.04.1（AC-3）：按名称将发现的 built-in 解析为其已存储、已解析的 sourcePath——
  // 这条接缝使 `workflow instantiate <name>` 无需隐藏文件路径即可工作。
  it("resolveSourcePathByName 返回已缓存 spec 的 sourcePath；未知名称返回 null", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC); // caches `test-three-step` with source_path=path
    cache.readThrough(path);
    expect(cache.resolveSourcePathByName("test-three-step")).toBe(path);
    expect(cache.resolveSourcePathByName("no-such-spec")).toBeNull();
  });

  it("resolveSourcePathByName 排除 version 为空的行（slice-11 诊断结构）", () => {
    // Slice-11 诊断行按文件 basename 定键，version 为空。这里直接插入（基础 workflow_specs schema，
    // 无 status 列），使测试无需 slice-11 诊断 migration 即可证明 `version != ''` 守卫。按名称解析
    // 不得返回此类行的路径。
    db.prepare(
      `INSERT INTO workflow_specs
         (spec_id, name, version, purpose, target_rig, roles_json, steps_json,
          coordination_terminal_turn_rule, source_path, source_hash, cached_at)
       VALUES (?, ?, '', NULL, NULL, '{}', '[]', 'hot_potato', ?, ?, ?)`,
    ).run("diag-1", "broken.yaml", join(tmp, "broken.yaml"), "deadbeef", new Date().toISOString());
    expect(cache.resolveSourcePathByName("broken.yaml")).toBeNull();
  });

  it("YAML 损坏时 parseWorkflowSpec 抛出 spec_yaml_invalid", () => {
    try {
      parseWorkflowSpec("workflow:\n  id: x\n  bad: : :", "/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_yaml_invalid");
    }
  });

  it("workflow.id 缺席时 parseWorkflowSpec 抛出 spec_field_missing", () => {
    try {
      parseWorkflowSpec("workflow:\n  version: 1\n  steps:\n    - id: a\n      actor_role: r\n  roles:\n    r: {}\n", "/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_field_missing");
    }
  });

  it("steps[] 为空时 parseWorkflowSpec 抛出 spec_field_missing", () => {
    try {
      parseWorkflowSpec("workflow:\n  id: x\n  version: 1\n  steps: []\n  roles:\n    r: {}\n", "/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_field_missing");
    }
  });

  it("roles 缺失时 parseWorkflowSpec 抛出 spec_field_missing", () => {
    try {
      parseWorkflowSpec("workflow:\n  id: x\n  version: 1\n  steps:\n    - id: a\n      actor_role: r\n", "/x");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowSpecError);
      expect((err as WorkflowSpecError).code).toBe("spec_field_missing");
    }
  });

  it("getByNameVersion 对未知 spec 返回 null，对已缓存 spec 返回行", () => {
    expect(cache.getByNameVersion("none", "1")).toBeNull();
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC);
    const cached = cache.readThrough(path);
    const found = cache.getByNameVersion("test-three-step", "1");
    expect(found?.specId).toBe(cached.specId);
  });

  // OPR.0.3.2.22 Bug 4——startup prune 删除 source_path 位于噪声目录的旧 cache 行；
  // walkYamlFiles 新增的 SKIP_DIRS 守卫已拒绝扫描这些目录。若无此 prune，SKIP_DIRS 发布前的 stale
  // 行会永久保留，并持续出现在 `rig specs show` / `rig specs preview` 候选项中。
  it("pruneNoiseDirRows 删除 .worktrees/node_modules 路径中的 cache 行，并保留 canonical-path 行", () => {
    const fixtures: Array<{ path: string; specName: string; noise: boolean }> = [
      { path: join(tmp, "workflows", "canon.yaml"), specName: "canonical-spec", noise: false },
      { path: join(tmp, ".worktrees", "feature-branch", "workflows", "stale.yaml"), specName: "stale-worktree-spec", noise: true },
      { path: join(tmp, "node_modules", "@vendor", "spec", "stale.yaml"), specName: "stale-node-modules-spec", noise: true },
      { path: join(tmp, "dist", "stale.yaml"), specName: "stale-dist-spec", noise: true },
    ];
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    for (const f of fixtures) {
      mkdirSync(join(f.path, ".."), { recursive: true });
      writeFileSync(f.path, SAMPLE_SPEC.replace("test-three-step", f.specName));
      cache.readThrough(f.path);
    }

    expect(cache.listAll()).toHaveLength(4);

    const removed = cache.pruneNoiseDirRows();
    expect(removed, "expected 3 noise rows removed (.worktrees + node_modules + dist)").toBe(3);

    const remaining = cache.listAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sourcePath).toBe(fixtures[0]!.path);
  });

  it("没有噪声行时 pruneNoiseDirRows 返回 0", () => {
    const canonicalPath = join(tmp, "workflows", "canon.yaml");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(canonicalPath, ".."), { recursive: true });
    writeFileSync(canonicalPath, SAMPLE_SPEC);
    cache.readThrough(canonicalPath);

    expect(cache.pruneNoiseDirRows()).toBe(0);
    expect(cache.listAll()).toHaveLength(1);
  });

  // OPR.0.3.2.22 Bug 4 后续（guard 在 79d06f8d 上 BLOCKING）——生产环境中，已发布 built-in
  // workflow spec 位于 npm 发布后台服务的 `<pkg>/dist/builtins/workflow-specs/`。前一提交的
  // 无范围 prune 会匹配 `%/dist/%`，并在每次启动时删掉所有 built-in。installRoot 守卫保留
  // source_path 以 install root 开头的行。
  it("带 installRoot 的 pruneNoiseDirRows 保留 <installRoot>/dist 下的 built-in 行，同时删除用户噪声", () => {
    const installRoot = join(tmp, "install", "@openrig", "daemon");
    const builtinPath = join(installRoot, "dist", "builtins", "workflow-specs", "shipped.yaml");
    const userNoisePath = join(tmp, "user-workspace", "some-project", "dist", "stale.yaml");

    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    for (const p of [builtinPath, userNoisePath]) {
      mkdirSync(join(p, ".."), { recursive: true });
    }
    writeFileSync(builtinPath, SAMPLE_SPEC.replace("test-three-step", "shipped-builtin-spec"));
    writeFileSync(userNoisePath, SAMPLE_SPEC.replace("test-three-step", "user-noise-spec"));
    cache.readThrough(builtinPath);
    cache.readThrough(userNoisePath);

    expect(cache.listAll()).toHaveLength(2);

    const removed = cache.pruneNoiseDirRows(installRoot);
    expect(removed, "expected only the user-noise row removed; built-in must survive").toBe(1);

    const remaining = cache.listAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.sourcePath).toBe(builtinPath);
  });
});
