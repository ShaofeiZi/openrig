// Spec Library 中的工作流 v0——扫描器测试。
//
// 验证 scanWorkflowSpecs 从 workflow_specs SQLite 缓存读取，通过 path.sep 边界区分
// built-in 与 user_file，并在 review payload 中投影拓扑图。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import {
  scanWorkflowSpecs,
  getWorkflowReview,
  workflowLibraryId,
  parseWorkflowLibraryId,
} from "../src/domain/spec-library-workflow-scanner.js";

const SAMPLE_SPEC = (id: string) => `workflow:
  id: ${id}
  version: 1
  objective: Sample workflow
  target:
    rig: sample-rig
  entry:
    role: alpha
  roles:
    alpha:
      preferred_targets:
        - alpha@sample-rig
    beta:
      preferred_targets:
        - beta@sample-rig
  steps:
    - id: step-1
      actor_role: alpha
      objective: Start the work.
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - beta
    - id: step-2
      actor_role: beta
      objective: Finish the work.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
`;

describe("scanWorkflowSpecs (Workflows in Spec Library v0)", () => {
  let db: Database.Database;
  let tmp: string;
  let builtinDir: string;
  let userDir: string;
  let cache: WorkflowSpecCache;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-lib-scanner-"));
    builtinDir = join(tmp, "builtins", "workflow-specs");
    userDir = join(tmp, "user-specs");
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("workflow_specs 表为空时返回空数组", () => {
    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    expect(entries).toEqual([]);
  });

  it("将 workflowBuiltinSpecsDir 下的 spec 归类为 builtin", () => {
    const path = join(builtinDir, "alpha.yaml");
    writeFileSync(path, SAMPLE_SPEC("alpha"));
    cache.readThrough(path);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.kind).toBe("workflow");
    expect(entry.name).toBe("alpha");
    expect(entry.sourceType).toBe("builtin");
    expect(entry.isBuiltIn).toBe(true);
    expect(entry.id).toBe("workflow:alpha:1");
    expect(entry.rolesCount).toBe(2);
    expect(entry.stepsCount).toBe(2);
    expect(entry.targetRig).toBe("sample-rig");
  });

  it("将 workflowBuiltinSpecsDir 外的 spec 归类为 user_file", () => {
    const path = join(userDir, "user.yaml");
    writeFileSync(path, SAMPLE_SPEC("user-spec"));
    cache.readThrough(path);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sourceType).toBe("user_file");
    expect(entries[0]!.isBuiltIn).toBe(false);
  });

  it("不将同级目录视为 builtin 子目录（path.sep 边界检查）", () => {
    // 在路径以 builtinDir 开头但实际不在其下的同级目录创建 spec（例如 builtinDir 为
    // /tmp/builtins，而路径为 /tmp/builtins-other/foo.yaml）。扫描器使用 path.sep 边界，
    // 因而必须将其归类为 user_file。
    const sibling = builtinDir + "-sibling";
    mkdirSync(sibling, { recursive: true });
    const path = join(sibling, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC("sibling"));
    cache.readThrough(path);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    const entry = entries.find((e) => e.name === "sibling")!;
    expect(entry.sourceType).toBe("user_file");
  });

  it("workflowBuiltinSpecsDir 为 null 时返回 null 的 isBuiltIn 分类", () => {
    const path = join(userDir, "user.yaml");
    writeFileSync(path, SAMPLE_SPEC("user-spec"));
    cache.readThrough(path);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: null });
    expect(entries[0]!.isBuiltIn).toBe(false);
    expect(entries[0]!.sourceType).toBe("user_file");
  });

  it("workflow_specs 表不存在时妥善返回空数组", () => {
    const bareDb = createDb();
    migrate(bareDb, [coreSchema]);
    try {
      const entries = scanWorkflowSpecs({ db: bareDb, workflowBuiltinSpecsDir: builtinDir });
      expect(entries).toEqual([]);
    } finally {
      bareDb.close();
    }
  });

  it("orders specs by name then version", () => {
    const pathB = join(userDir, "b.yaml");
    const pathA = join(userDir, "a.yaml");
    writeFileSync(pathB, SAMPLE_SPEC("b-spec"));
    writeFileSync(pathA, SAMPLE_SPEC("a-spec"));
    cache.readThrough(pathB);
    cache.readThrough(pathA);

    const entries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir });
    expect(entries.map((e) => e.name)).toEqual(["a-spec", "b-spec"]);
  });
});

describe("getWorkflowReview (Workflows in Spec Library v0)", () => {
  let db: Database.Database;
  let tmp: string;
  let cache: WorkflowSpecCache;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-lib-review-"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("从 next_hop.suggested_roles 投影带边的拓扑", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC("topo"));
    cache.readThrough(path);

    const review = getWorkflowReview({
      db,
      workflowBuiltinSpecsDir: null,
      name: "topo",
      version: "1",
    });
    expect(review).not.toBeNull();
    expect(review!.topology.nodes).toHaveLength(2);
    expect(review!.topology.edges).toHaveLength(1);
    expect(review!.topology.edges[0]).toEqual({
      fromStepId: "step-1",
      toStepId: "step-2",
      routingType: "direct",
    });
  });

  it("将入口角色步骤标记为 isEntry，并将无 next_hop 步骤标记为 isTerminal", () => {
    const path = join(tmp, "spec.yaml");
    writeFileSync(path, SAMPLE_SPEC("entry-terminal"));
    cache.readThrough(path);

    const review = getWorkflowReview({
      db,
      workflowBuiltinSpecsDir: null,
      name: "entry-terminal",
      version: "1",
    });
    const step1 = review!.topology.nodes.find((n) => n.stepId === "step-1")!;
    const step2 = review!.topology.nodes.find((n) => n.stepId === "step-2")!;
    expect(step1.isEntry).toBe(true);
    expect(step1.isTerminal).toBe(false);
    expect(step2.isEntry).toBe(false);
    expect(step2.isTerminal).toBe(true);
  });

  it("未知 name+version 返回 null", () => {
    const review = getWorkflowReview({
      db,
      workflowBuiltinSpecsDir: null,
      name: "missing",
      version: "1",
    });
    expect(review).toBeNull();
  });
});

// OPR.0.4.6.WF4 C1（架构 Q1）——扫描器投影现会从 next_hop.on 添加分支边，
// 修正错误终态缺陷，并投影可选 harness/host/gate 节点字段；缺失字段均通过省略保持字节一致。
describe("getWorkflowReview——WF-4 C1 分支、终态和可选字段投影", () => {
  let db: Database.Database;
  let tmp: string;
  let cache: WorkflowSpecCache;

  const BUILTINS_DIR = fileURLToPath(new URL("../src/builtins/workflow-specs/", import.meta.url));

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-c1-"));
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 通过缓存加载真实已交付 builtin 并投影。 */
  function reviewBuiltin(name: string) {
    const yaml = readFileSync(join(BUILTINS_DIR, `${name}.yaml`), "utf8");
    const p = join(tmp, `${name}.yaml`);
    writeFileSync(p, yaml);
    cache.readThrough(p);
    // builtin YAML 使用 `id: <name>`，版本为 1。
    const review = getWorkflowReview({ db, workflowBuiltinSpecsDir: null, name, version: "1" });
    expect(review, `builtin ${name} projected`).not.toBeNull();
    return review!;
  }

  it("合成分支：带 next_hop.on 的步骤不是终态，并发出标记为 branch 的边", () => {
    const spec = `workflow:
  id: c1-branch
  version: 1
  objective: branch fixture
  target: { rig: r }
  entry: { role: builder }
  roles:
    builder: { preferred_targets: [b@r] }
    fixer: { preferred_targets: [f@r] }
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [failed, done]
      next_hop:
        on: { failed: remediate }
    - id: remediate
      actor_role: fixer
      allowed_exits: [done]
  invariants:
    allowed_exits: [failed, done]
`;
    const p = join(tmp, "c1-branch.yaml");
    writeFileSync(p, spec);
    cache.readThrough(p);
    const review = getWorkflowReview({ db, workflowBuiltinSpecsDir: null, name: "c1-branch", version: "1" })!;

    const build = review.topology.nodes.find((n) => n.stepId === "build")!;
    expect(build.isTerminal).toBe(false); // the false-terminal defect, fixed
    const branchEdges = review.topology.edges.filter((e) => e.routingType === "branch");
    expect(branchEdges).toEqual([
      { fromStepId: "build", toStepId: "remediate", routingType: "branch", branchOn: "failed" },
    ]);
    // 缺失即省略：未声明 harness/host/gate 的步骤不携带对应 key。
    expect(Object.keys(build)).not.toContain("harness");
    expect(Object.keys(build)).not.toContain("host");
    expect(Object.keys(build)).not.toContain("gate");
    // 悬空的 `on` 目标（无匹配步骤）会被丢弃，绝不生成幽灵边。
  });

  it("仅使用 suggested_roles 的内置 spec（conveyor、basic-loop）：所有边均为 direct，分支边为零，可选节点 key 为零（字节一致类别）", () => {
    for (const name of ["conveyor", "basic-loop"]) {
      const review = reviewBuiltin(name);
      expect(review.topology.edges.length, `${name} has edges`).toBeGreaterThan(0);
      for (const e of review.topology.edges) {
        expect(e.routingType, `${name} edge ${e.fromStepId}→${e.toStepId}`).toBe("direct");
        expect(Object.keys(e)).not.toContain("branchOn");
      }
      for (const n of review.topology.nodes) {
        expect(Object.keys(n), `${name} node ${n.stepId}`).not.toContain("harness");
        expect(Object.keys(n)).not.toContain("host");
        expect(Object.keys(n)).not.toContain("gate");
      }
    }
  });

  it("BUILTIN linear-build (no next_hop): zero edges, unchanged", () => {
    const review = reviewBuiltin("linear-build");
    expect(review.topology.edges).toEqual([]);
  });

  it("内置 branched-remediation：获得带标签的分支边，build/verify 不再被误判为终态", () => {
    const review = reviewBuiltin("branched-remediation");
    const branchEdges = review.topology.edges.filter((e) => e.routingType === "branch");
    // build→remediate 和 verify→remediate 都位于 `failed` 出口。
    expect(branchEdges).toEqual(
      expect.arrayContaining([
        { fromStepId: "build", toStepId: "remediate", routingType: "branch", branchOn: "failed" },
        { fromStepId: "verify", toStepId: "remediate", routingType: "branch", branchOn: "failed" },
      ]),
    );
    const build = review.topology.nodes.find((n) => n.stepId === "build")!;
    const verify = review.topology.nodes.find((n) => n.stepId === "verify")!;
    expect(build.isTerminal).toBe(false);
    expect(verify.isTerminal).toBe(false);
  });

  it("内置 gated-release：投影 gate 和 harness 节点字段（声明时才出现）", () => {
    const review = reviewBuiltin("gated-release");
    const signoff = review.topology.nodes.find((n) => n.stepId === "ship-signoff")!;
    expect(signoff.gate).toBeDefined();
    const build = review.topology.nodes.find((n) => n.stepId === "build")!;
    expect(build.harness).toBe("claude-code");
    // 没有 gate 的节点仍完全省略该 key。
    expect(Object.keys(build)).not.toContain("gate");
  });
});

describe("workflowLibraryId / parseWorkflowLibraryId", () => {
  it("编码并解码 name:version 对", () => {
    expect(workflowLibraryId("foo", "1")).toBe("workflow:foo:1");
    expect(parseWorkflowLibraryId("workflow:foo:1")).toEqual({ name: "foo", version: "1" });
  });

  it("按最后一个冒号切分，使名称含冒号时仍可往返", () => {
    const id = workflowLibraryId("conveyor", "1.2.3");
    expect(parseWorkflowLibraryId(id)).toEqual({ name: "conveyor", version: "1.2.3" });
  });

  it("非 workflow id 返回 null", () => {
    expect(parseWorkflowLibraryId("rig:foo:1")).toBeNull();
    expect(parseWorkflowLibraryId("workflow:no-version")).toBeNull();
  });
});
