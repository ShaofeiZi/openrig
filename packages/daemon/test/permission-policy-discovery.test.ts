import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SystemPreflight } from "../../cli/src/system-preflight.js";

const RIG_ROOT = "/project/rigs/policy-discovery";
const ORIGINAL_RIG_ROOT = "/original/rig";
const OTHER_OPERATION_ROOT = "/different/operation-root";
const CUSTOM_POLICY_REF = "policies/operator-full.md";
const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`;
const COLLIDING_AGENT_YAML = `name: impl
version: "1.0.0"
imports:
  - ref: local:../lib
resources:
  skills:
    - id: shared
      path: skills/shared
profiles:
  default:
    uses:
      skills: [shared]
`;
const COLLIDING_IMPORT_YAML = `name: lib
version: "1.0.0"
resources:
  skills:
    - id: shared
      path: skills/shared
profiles: {}
`;
const CUSTOM_POLICY = `---
policy_schema_version: 1
name: operator-full
source: custom
description: full-bypass flag policy
surface: flag
launch_posture: full_bypass
---
# Operator full
`;

function fsOps(): AgentResolverFsOps {
  return {
    exists: (path) => path.includes("agents/impl") || path.endsWith("policies/operator-full.md"),
    readFile: (path) => {
      if (path.includes("agents/impl")) return AGENT_YAML;
      if (path.endsWith("policies/operator-full.md")) return CUSTOM_POLICY;
      throw new Error(`Not found: ${path}`);
    },
  };
}

function collisionFsOps(): AgentResolverFsOps {
  return {
    exists: (path) => path.includes("agents/impl") || path.includes("agents/lib"),
    readFile: (path) => {
      if (path.includes("agents/impl")) return COLLIDING_AGENT_YAML;
      if (path.includes("agents/lib")) return COLLIDING_IMPORT_YAML;
      throw new Error(`Not found: ${path}`);
    },
  };
}

function rigYaml(opts: { name?: string; rigPolicy?: string; memberPolicy?: string } = {}): string {
  const rigPolicy = opts.rigPolicy ? `permission_policy: ${opts.rigPolicy}\n` : "";
  const memberPolicy = opts.memberPolicy ? `        permission_policy: ${opts.memberPolicy}\n` : "";
  return `version: "0.2"
name: ${opts.name ?? "policy-discovery"}
${rigPolicy}pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
${memberPolicy}        cwd: .
    edges: []
edges: []
`;
}

const policyLines = (warnings: string[]) => warnings.filter((warning) => warning.includes("permission_policy"));

describe("接缝 C permission-policy 发现", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("如实呈现已附加内置 ref 的 origin 与绑定 posture", async () => {
    const result = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:yolo" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(policyLines(result.warnings)).toEqual([
      'dev.impl：permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
    ]);
  });

  it("呈现每个 member 的自定义 override，而非 rig 级 policy", async () => {
    const result = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:standard", memberPolicy: "policies/operator-full.md" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });

    expect(result.ready).toBe(true);
    expect(policyLines(result.warnings)).toEqual([
      'dev.impl：permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
    ]);
    expect(result.warnings.join("\n")).not.toContain("builtin:standard");
  });

  it("将真实缺失呈现为 floor，且不报错、不阻塞", async () => {
    const result = await rigPreflight({ rigSpecYaml: rigYaml(), rigRoot: RIG_ROOT, fsOps: fsOps() });

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(policyLines(result.warnings)).toEqual([
      "dev.impl：缺少 permission_policy；launch_posture=floor",
    ]);
  });

  it("按顺序通过 materialize 传递 policy 发现与现有 preflight 提示", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: collisionFsOps() });
      const outcome = await setup.podInstantiator.materialize(
        rigYaml({ name: "policy-materialize-warnings", rigPolicy: "builtin:yolo" }),
        RIG_ROOT,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.warnings).toEqual([
        // §6 对账（PM 裁定 2026-08-05，fold-wave qitem 79159e6f）：main 已折叠的 preflight 提示
        //（collision）是 FLOOR（排在最前）；restack 后的 permission-policy 发现 warning 追加在后。
        // 此顺序取代 4.8 lineage 原有的 policy-first 顺序。
        'dev.impl：skills 中的 "shared" 存在 base/import 冲突',
        'dev.impl：permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
      ]);
    } finally {
      db.close();
    }
  });

  it("按顺序通过 instantiate 传递 policy 发现与现有 preflight 提示", async () => {
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true }),
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: collisionFsOps(),
      });
      const outcome = await setup.podInstantiator.instantiate(
        rigYaml({ name: "policy-instantiate-warnings", rigPolicy: "builtin:yolo" }),
        RIG_ROOT,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.result.warnings).toEqual([
        // §6 对账（PM 裁定 2026-08-05，fold-wave qitem 79159e6f）：main 已折叠的 preflight 提示
        //（collision）是 FLOOR（排在最前）；restack 后的 permission-policy 发现 warning 追加在后。
        // 此顺序取代 4.8 lineage 原有的 policy-first 顺序。
        'dev.impl：skills 中的 "shared" 存在 base/import 冲突',
        'dev.impl：permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
      ]);
    } finally {
      db.close();
    }
  });

  it("按顺序通过公开 expansion 响应传递结构化 materialize warning", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: collisionFsOps() });
      const rig = setup.rigRepo.createRig("policy-expand-warnings");
      const response = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rigRoot: RIG_ROOT,
          pod: {
            id: "dev",
            label: "Dev",
            members: [{
              id: "impl",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              permission_policy: "builtin:yolo",
              cwd: ".",
            }],
            edges: [],
          },
        }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { warnings: string[] };
      expect(body.warnings).toEqual([
        // §6 对账（PM 裁定 2026-08-05，fold-wave qitem 79159e6f）：main 已折叠的 preflight 提示
        //（collision）是 FLOOR（排在最前）；restack 后的 permission-policy 发现 warning 追加在后。
        // 此顺序取代 4.8 lineage 原有的 policy-first 顺序。
        'dev.impl：skills 中的 "shared" 存在 base/import 冲突',
        'dev.impl：permission_policy ref="builtin:yolo" origin=builtin launch_posture=full_bypass',
      ]);
    } finally {
      db.close();
    }
  });

  it("发现已持久化的目标 rig policy provenance，并与 launch binding 匹配", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const agentOnlyFsOps: AgentResolverFsOps = {
      exists: (path) => path.includes("agents/impl"),
      readFile: (path) => {
        if (path.includes("agents/impl")) return AGENT_YAML;
        throw new Error(`Not found: ${path}`);
      },
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: agentOnlyFsOps,
      });
      const rig = setup.rigRepo.createRig("persisted-policy-target");
      setup.rigRepo.setRigPermissionPolicy(rig.id, "policies/operator-full.md");
      setup.rigRepo.setRigPolicyProvenance(rig.id, {
        origin: "custom",
        resolvedTarget: "/original/rig/policies/operator-full.md",
        declaringDir: "/original/rig",
        launchPosture: "full_bypass",
      });
      const specObject = {
        version: "0.2",
        name: rig.name,
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            cwd: ".",
          }, {
            id: "override",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            permission_policy: "builtin:standard",
            cwd: ".",
          }],
          edges: [],
        }],
        edges: [],
      };

      const materialized = await setup.podInstantiator.materializeStructured(
        specObject,
        "/different/operation-root",
        { targetRigId: rig.id },
      );
      expect(materialized.ok).toBe(true);
      if (!materialized.ok) return;
      expect(materialized.result.warnings).toEqual([
        'dev.impl：permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
        'dev.override：permission_policy ref="builtin:standard" origin=builtin launch_posture=floor',
      ]);

      const launched = await setup.podInstantiator.launchValidatedSpec(
        PodRigSpecSchema.normalize(specObject),
        "/different/operation-root",
        rig.id,
      );
      expect(launched.ok).toBe(true);
      expect(bindings.map((binding) => binding.launchPosture)).toEqual(["full_bypass", "floor"]);
    } finally {
      db.close();
    }
  });

  it("通过公开 YAML materialize 路由传递已持久化的目标 policy 发现结果", async () => {
    const policyReads: string[] = [];
    const agentOnlyFsOps: AgentResolverFsOps = {
      exists: (path) => path.includes("agents/impl"),
      readFile: (path) => {
        if (path.includes("agents/impl")) return AGENT_YAML;
        policyReads.push(path);
        throw new Error(`Not found: ${path}`);
      },
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: agentOnlyFsOps });
      const rig = setup.rigRepo.createRig("persisted-yaml-target");
      setup.rigRepo.setRigPermissionPolicy(rig.id, CUSTOM_POLICY_REF);
      setup.rigRepo.setRigPolicyProvenance(rig.id, {
        origin: "custom",
        resolvedTarget: `${ORIGINAL_RIG_ROOT}/${CUSTOM_POLICY_REF}`,
        declaringDir: ORIGINAL_RIG_ROOT,
        launchPosture: "full_bypass",
      });

      const response = await setup.app.request("/api/rigs/import/materialize", {
        method: "POST",
        headers: {
          "Content-Type": "text/yaml",
          "X-Rig-Root": OTHER_OPERATION_ROOT,
          "X-Target-Rig-Id": rig.id,
        },
        body: rigYaml({ name: rig.name }),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { warnings?: string[] };
      const node = setup.rigRepo.getRig(rig.id)!.nodes.find((candidate) => candidate.logicalId === "dev.impl")!;
      expect(setup.rigRepo.getNodePolicyProvenance(node.id)).toEqual({
        origin: "custom",
        resolvedTarget: `${ORIGINAL_RIG_ROOT}/${CUSTOM_POLICY_REF}`,
        declaringDir: ORIGINAL_RIG_ROOT,
        launchPosture: "full_bypass",
        nodeRef: null,
      });
      expect(body.warnings).toEqual([
        'dev.impl：permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
      ]);
      expect(body.warnings?.join("\n")).not.toContain("缺少 permission_policy");
      expect(policyReads).not.toContain(`${OTHER_OPERATION_ROOT}/${CUSTOM_POLICY_REF}`);
    } finally {
      db.close();
    }
  });

  it("通过公开 add-member 路由，在 launch warning 之前传递继承的发现结果", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const agentOnlyFsOps: AgentResolverFsOps = {
      exists: (path) => path.includes("agents/impl"),
      readFile: (path) => {
        if (path.includes("agents/impl")) return AGENT_YAML;
        throw new Error(`Not found: ${path}`);
      },
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: agentOnlyFsOps,
      });
      const seeded = await setup.podInstantiator.materializeStructured({
        version: "0.2",
        name: "persisted-add-member-target",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "existing",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            cwd: ".",
          }],
          edges: [],
        }],
        edges: [],
      }, ORIGINAL_RIG_ROOT);
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) return;
      setup.rigRepo.setRigPermissionPolicy(seeded.result.rigId, CUSTOM_POLICY_REF);
      setup.rigRepo.setRigPolicyProvenance(seeded.result.rigId, {
        origin: "custom",
        resolvedTarget: `${ORIGINAL_RIG_ROOT}/${CUSTOM_POLICY_REF}`,
        declaringDir: ORIGINAL_RIG_ROOT,
        launchPosture: "full_bypass",
      });
      const originalLaunch = setup.nodeLauncher.launchNode.bind(setup.nodeLauncher);
      vi.spyOn(setup.nodeLauncher, "launchNode").mockImplementation(async (...args) => {
        const outcome = await originalLaunch(...args);
        return outcome.ok
          ? { ...outcome, warnings: [...(outcome.warnings ?? []), "later launch warning"] }
          : outcome;
      });

      const inheritedResponse = await setup.app.request(`/api/rigs/${seeded.result.rigId}/pods/dev/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rigRoot: OTHER_OPERATION_ROOT,
          member: {
            id: "late",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            cwd: ".",
          },
        }),
      });
      const inheritedBody = await inheritedResponse.json() as { ok: boolean; result: { warnings?: string[] } };

      expect(inheritedResponse.status).toBe(201);
      expect(inheritedBody.result.warnings).toEqual([
        'dev.late：permission_policy ref="policies/operator-full.md" origin=custom launch_posture=full_bypass',
        "later launch warning",
      ]);
      expect(bindings[0]?.launchPosture).toBe("full_bypass");

      const overrideResponse = await setup.app.request(`/api/rigs/${seeded.result.rigId}/pods/dev/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rigRoot: OTHER_OPERATION_ROOT,
          member: {
            id: "override",
            runtime: "claude-code",
            agent_ref: "local:agents/impl",
            profile: "default",
            permission_policy: "builtin:standard",
            cwd: ".",
          },
        }),
      });
      const overrideBody = await overrideResponse.json() as { ok: boolean; result: { warnings?: string[] } };

      expect(overrideResponse.status).toBe(201);
      expect(overrideBody.result.warnings).toEqual([
        'dev.override：permission_policy ref="builtin:standard" origin=builtin launch_posture=floor',
        "later launch warning",
      ]);
      expect(bindings[1]?.launchPosture).toBe("floor");
    } finally {
      db.close();
    }
  });

  it("在 rig-up 结果中传递发现信息，同时保持 launch 结果一致", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as RuntimeAdapter;
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: fsOps(),
      });
      const absent = await setup.podInstantiator.instantiate(rigYaml({ name: "policy-absent" }), RIG_ROOT);
      const attached = await setup.podInstantiator.instantiate(
        rigYaml({ name: "policy-attached", rigPolicy: "builtin:locked" }),
        RIG_ROOT,
      );

      expect(absent.ok).toBe(true);
      expect(attached.ok).toBe(true);
      if (!absent.ok || !attached.ok) return;
      expect(absent.result.nodes.map(({ logicalId, status }) => ({ logicalId, status })))
        .toEqual(attached.result.nodes.map(({ logicalId, status }) => ({ logicalId, status })));
      expect(bindings).toHaveLength(2);
      expect(policyLines(absent.result.warnings ?? [])).toEqual([
        "dev.impl：缺少 permission_policy；launch_posture=floor",
      ]);
      expect(policyLines(attached.result.warnings ?? [])).toEqual([
        'dev.impl：permission_policy ref="builtin:locked" origin=builtin launch_posture=floor',
      ]);
    } finally {
      db.close();
    }
  });

  it("SYSTEM setup preflight 保持不感知 policy，而 rig 生命周期 preflight 会发现 policy", async () => {
    const home = mkdtempSync(join(tmpdir(), "seam-c-system-preflight-"));
    tempDirs.push(home);
    const system = new SystemPreflight({
      exec: async (cmd) => cmd === "tmux -V" ? "tmux 3.6" : "",
      configStore: {
        resolve: () => ({
          daemon: { host: "127.0.0.1", port: 0 },
          db: { path: join(home, "openrig.db") },
          transcripts: { path: join(home, "transcripts") },
        }),
      } as never,
      getDaemonStatus: async () => ({ state: "stopped" }),
      openrigHome: home,
    });

    const systemResult = await system.run({ port: 0 });
    expect(JSON.stringify(systemResult)).not.toContain("permission_policy");

    const lifecycleResult = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:standard" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });
    expect(policyLines(lifecycleResult.warnings)).toHaveLength(1);
  });

  it("在上游拒绝无效 ref，绝不将其误报为 floor 发现结果", async () => {
    const invalid = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:missing" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });

    expect(invalid.ready).toBe(false);
    expect(invalid.errors.join("\n")).toContain("未知内置策略 'missing'");
    expect(policyLines(invalid.warnings)).toEqual([]);

    const valid = await rigPreflight({
      rigSpecYaml: rigYaml({ rigPolicy: "builtin:standard" }),
      rigRoot: RIG_ROOT,
      fsOps: fsOps(),
    });
    expect(valid.ready).toBe(true);
    expect(policyLines(valid.warnings)).toEqual([
      'dev.impl：permission_policy ref="builtin:standard" origin=builtin launch_posture=floor',
    ]);
  });
});
