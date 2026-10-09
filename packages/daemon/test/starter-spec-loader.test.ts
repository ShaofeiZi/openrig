// 内置 workflow spec loader 测试。
//
// 使用临时 builtin directory + in-memory workflow_specs cache 驱动 loader，使测试保持确定性且
// parallel-safe。固定关键行为：
//
//   - 带 N 个 spec 的 cold start：全部 N 个 seed
//   - 对已缓存 spec 重跑：SKIPPED（workspace-surface reconciliation 下不覆盖 operator override）
//   - workspace path 中的 operator override：SKIPPED + cache 中 source_path 保持 operator path
//   - malformed spec 文件：收集 error 而不抛出；同目录其他 spec 仍加载
//   - builtin dir 缺失：空 result，不抛错（graceful）
//   - 目录中的非 YAML 文件：静默忽略

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { loadStarterWorkflowSpecs, defaultBuiltinSpecsDir } from "../src/domain/workflow/starter-spec-loader.js";
import { projectSpecGraph } from "../src/domain/workflow/slice-workflow-projection.js";

const ALPHA_SPEC = `workflow:
  id: alpha-spec
  version: 1
  objective: alpha test
  roles:
    a:
      preferred_targets: [a@r]
  steps:
    - id: only
      actor_role: a
      allowed_exits: [handoff]
`;

const BETA_SPEC = `workflow:
  id: beta-spec
  version: 1
  objective: beta test
  roles:
    b:
      preferred_targets: [b@r]
  steps:
    - id: only
      actor_role: b
      allowed_exits: [handoff]
`;

describe("内置 workflow spec loader", () => {
  let db: Database.Database;
  let cache: WorkflowSpecCache;
  let builtinDir: string;
  let cleanupRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    cleanupRoot = mkdtempSync(join(tmpdir(), "starter-loader-"));
    builtinDir = join(cleanupRoot, "workflow-specs");
    require("node:fs").mkdirSync(builtinDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  it("builtinDir 不存在时返回空 result 且不抛错", () => {
    const missing = join(cleanupRoot, "definitely-missing");
    const result = loadStarterWorkflowSpecs({ cache, builtinDir: missing });
    expect(result).toEqual({ loaded: [], skipped: [], errors: [] });
  });

  it("cold start：seed 目录中的每个 .yaml spec", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    writeFileSync(join(builtinDir, "beta.yaml"), BETA_SPEC);
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(result.loaded).toHaveLength(2);
    expect(result.loaded.map((r) => r.name).sort()).toEqual(["alpha-spec", "beta-spec"]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
    // 确认 cache 确实包含这些项。
    expect(cache.getByNameVersion("alpha-spec", "1")).not.toBeNull();
    expect(cache.getByNameVersion("beta-spec", "1")).not.toBeNull();
  });

  it("幂等：第二次调用跳过已缓存 spec（不覆盖）", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    const first = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(first.loaded).toHaveLength(1);
    const second = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(second.loaded).toEqual([]);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]?.name).toBe("alpha-spec");
  });

  it("operator override（workspace-surface reconciliation）：非 builtin source_path 的现有 cache row 胜出；loader 不覆盖", () => {
    // Operator 在“workspace”path 编写具有相同（name、version）的 spec，并先通过 cache 读取它
    //（模拟 operator workflow）。
    const operatorPath = join(cleanupRoot, "operator-override-alpha.yaml");
    writeFileSync(operatorPath, ALPHA_SPEC);
    cache.readThrough(operatorPath);
    const beforeRow = cache.getByNameVersion("alpha-spec", "1");
    expect(beforeRow?.sourcePath).toBe(operatorPath);

    // 随后 daemon 启动，并对包含相同（name、version）的 bundled builtin dir 运行 starter loader。
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });

    // Loader 跳过（operator 胜出）。
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.sourcePathInCache).toBe(operatorPath);

    // Cache row 的 source_path 仍是 operator path，而非 bundled built-in path
    //（保留 workspace-surface reconciliation）。
    const afterRow = cache.getByNameVersion("alpha-spec", "1");
    expect(afterRow?.sourcePath).toBe(operatorPath);
  });

  it("malformed spec 文件：收集 error，同目录其他 spec 仍加载", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    writeFileSync(join(builtinDir, "broken.yaml"), "this is: not [a valid spec");
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(result.loaded.map((r) => r.name)).toEqual(["alpha-spec"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourcePath).toContain("broken.yaml");
    // Cache 有 alpha，但没有 broken（后者本就没有 name）。
    expect(cache.getByNameVersion("alpha-spec", "1")).not.toBeNull();
  });

  it("静默忽略目录中的非 YAML 文件（.md、.txt、.json）", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    writeFileSync(join(builtinDir, "README.md"), "# notes about the bundled specs");
    writeFileSync(join(builtinDir, "scratch.txt"), "ignore me");
    writeFileSync(join(builtinDir, "metadata.json"), `{"hint":"ignored"}`);
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]?.name).toBe("alpha-spec");
    expect(result.errors).toEqual([]);
  });

  it("同时支持 .yaml 与 .yml 扩展名", () => {
    writeFileSync(join(builtinDir, "alpha.yaml"), ALPHA_SPEC);
    writeFileSync(join(builtinDir, "beta.yml"), BETA_SPEC);
    const result = loadStarterWorkflowSpecs({ cache, builtinDir });
    expect(result.loaded.map((r) => r.name).sort()).toEqual(["alpha-spec", "beta-spec"]);
  });
});
