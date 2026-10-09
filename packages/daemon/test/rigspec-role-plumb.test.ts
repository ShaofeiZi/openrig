import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { RigSpec } from "../src/domain/types.js";

// OPR.0.4.6.FAC1 commit 1——role 维度端到端存在
//（AC-4 substrate；BR-4；P2-1 sibling-layer sweep）。
//
// 一次 schema 变更覆盖全部三条节点创建路径（initial pod materialize、rig expand、add_member），
// 因为它们都经过 PodRigSpecSchema → createMemberNode → rigRepo.addNode，后者已写入
// nodes.role。这些测试分别固定每条路径，避免未来逐路径 field map（本次 build 捕获的
// buildExpansionSpecObject 类 remap）再次静默丢字段。
//
// 此处固定的规则（planner1 §2 C1 / planner2 §3.8）：
//   - role 按席位 opt-in：没有 role 的 member 在所有位置都合法，并投影为 role=null；绝不
//     进行 role resolution，只能显式指定目标。
//   - 已提供 role 绝不静默丢弃：每条路径都会校验它、写入 nodes.role，并投影到 inventory entry。
//   - terminal member 拒绝 role，因为 terminal node 不是智能体席位。

const RIG_ROOT = "/project/rigs/role-rig";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function rawMember(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    agent_ref: "local:agents/impl",
    profile: "default",
    runtime: "claude-code",
    cwd: ".",
    ...over,
  };
}

function rawSpec(members: Record<string, unknown>[], name = "role-rig"): Record<string, unknown> {
  return {
    version: "0.2",
    name,
    pods: [{ id: "dev", label: "Dev", members, edges: [] }],
    edges: [],
  };
}

describe("FAC-1 C1：member role——schema 校验 + 规范化", () => {
  it("接受可选 role 并将其规范化到 pod member", () => {
    const spec = rawSpec([rawMember("impl", { role: "driver" })]);
    const validation = RigSpecSchema.validate(spec);
    expect(validation.valid).toBe(true);
    const normalized = RigSpecSchema.normalize(spec);
    expect(normalized.pods[0]!.members[0]!.role).toBe("driver");
  });

  it("没有 role 的 member 仍完全合法，并规范化为 role=undefined（逐席位 opt-in）", () => {
    const spec = rawSpec([rawMember("impl")]);
    const validation = RigSpecSchema.validate(spec);
    expect(validation.valid).toBe(true);
    expect(RigSpecSchema.normalize(spec).pods[0]!.members[0]!.role).toBeUndefined();
  });

  it("拒绝空字符串 role；已提供 role 必须校验，不能丢弃", () => {
    const validation = RigSpecSchema.validate(rawSpec([rawMember("impl", { role: "  " })]));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/role：必须是非空字符串/);
  });

  it("拒绝超出相邻字段字符集的 role", () => {
    const validation = RigSpecSchema.validate(rawSpec([rawMember("impl", { role: "qa reviewer!" })]));
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/role：只能包含/);
  });

  it("拒绝 terminal member 上的 role，因为 terminal node 不是智能体席位", () => {
    const validation = RigSpecSchema.validate(
      rawSpec([
        { id: "server", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp", role: "driver" },
      ]),
    );
    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toMatch(/role：对 terminal member 无效/);
  });
});

describe("FAC-1 C1：role 贯穿全部三条节点创建路径（P2-1）", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, {
      podInstantiatorFsOps: {
        readFile: (p: string) => {
          if (p.includes("agents/impl")) return agentYaml("impl");
          throw new Error(`Not found: ${p}`);
        },
        exists: (p: string) => p.includes("agents/impl"),
      },
    });
  });

  afterEach(() => { db.close(); });

  function nodeRole(logicalId: string): string | null {
    const row = db
      .prepare("SELECT role FROM nodes WHERE logical_id = ?")
      .get(logicalId) as { role: string | null } | undefined;
    expect(row, `node ${logicalId} should exist`).toBeDefined();
    return row!.role;
  }

  it("PATH 1——initial pod materialize：spec role → nodes.role → inventory entry，无 role → null", async () => {
    const spec = rawSpec([
      rawMember("impl", { role: "driver" }),
      rawMember("helper"), // role-less pod-mate stays legal
    ]);
    const outcome = await setup.podInstantiator.materializeStructured(spec, RIG_ROOT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(nodeRole("dev.impl")).toBe("driver");
    expect(nodeRole("dev.helper")).toBeNull();

    const entries = getNodeInventory(db, outcome.result.rigId);
    const impl = entries.find((e) => e.logicalId === "dev.impl");
    const helper = entries.find((e) => e.logicalId === "dev.helper");
    expect(impl?.role).toBe("driver");
    expect(helper?.role).toBeNull();
  });

  it("PATH 2——rig expand（结构化 fragment）：role 经 buildExpansionSpecObject 到达 nodes.role", async () => {
    const rig = setup.rigRepo.createRig("role-rig");
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      rigRoot: RIG_ROOT,
      pod: {
        id: "qa",
        label: "QA",
        members: [
          { id: "reviewer", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default", cwd: ".", role: "qa" },
        ],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);
    expect(nodeRole("qa.reviewer")).toBe("qa");
    const entry = getNodeInventory(db, rig.id).find((e) => e.logicalId === "qa.reviewer");
    expect(entry?.role).toBe("qa");
  });

  it("PATH 3——add_member：fragment role → nodes.role；向带 role 的 pod 添加无 role member 仍合法", async () => {
    const spec = rawSpec([rawMember("impl", { role: "driver" })]);
    const outcome = await setup.podInstantiator.materializeStructured(spec, RIG_ROOT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const rigId = outcome.result.rigId;

    const withRole = await setup.podInstantiator.addMemberToPod(
      rigId,
      "dev",
      rawMember("driver2", { role: "driver" }),
      RIG_ROOT,
    );
    expect(withRole.ok).toBe(true);
    expect(nodeRole("dev.driver2")).toBe("driver");

    const roleLess = await setup.podInstantiator.addMemberToPod(
      rigId,
      "dev",
      rawMember("floater"),
      RIG_ROOT,
    );
    expect(roleLess.ok).toBe(true);
    expect(nodeRole("dev.floater")).toBeNull();

    const entries = getNodeInventory(db, rigId);
    expect(entries.find((e) => e.logicalId === "dev.driver2")?.role).toBe("driver");
    expect(entries.find((e) => e.logicalId === "dev.floater")?.role).toBeNull();
  });

  it("往返保真：带 role 的规范化 spec 序列化回 YAML 后仍携带 role", () => {
    const spec = rawSpec([rawMember("impl", { role: "driver" })]);
    expect(RigSpecSchema.validate(spec).valid).toBe(true);
    const normalized = RigSpecSchema.normalize(spec) as unknown as RigSpec;
    const yaml = RigSpecCodec.serialize(normalized);
    expect(yaml).toMatch(/role: driver/);
  });

  it("PATH 4——bootstrap instantiate-from-YAML（`zrig up <spec>` 路径）：role → nodes.role；此路径不经过 createMemberNode", async () => {
    // Pod-aware PodRigInstantiator.instantiate(yaml, rigRoot) 通过自身内联 addNode 创建 agent node，
    // 与 materialize/expand/add_member 使用的 createMemberNode 是不同站点。原 C1 sweep 测了前三条
    // 路径却漏掉这一条，因此每个由 `zrig up` 创建的工作组都以 role=NULL 交付，直到 VM proof 在
    // 完整运行的工作组上捕获 bound_rig_role_uncovered。本测试固定第四条路径。
    const spec = rawSpec([
      rawMember("planner1", { role: "planner" }),
      rawMember("helper"), // role-less pod-mate stays null on THIS path too
    ]);
    const yaml = RigSpecCodec.serialize(RigSpecSchema.normalize(spec) as unknown as RigSpec);
    const outcome = await setup.podInstantiator.instantiate(yaml, RIG_ROOT);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(nodeRole("dev.planner1")).toBe("planner");
    expect(nodeRole("dev.helper")).toBeNull();
    if (outcome.ok) {
      const entries = getNodeInventory(db, outcome.result.rigId);
      expect(entries.find((e) => e.logicalId === "dev.planner1")?.role).toBe("planner");
    }
  });
});
