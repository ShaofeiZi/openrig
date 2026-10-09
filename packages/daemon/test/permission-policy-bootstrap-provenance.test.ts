import { describe, expect, it } from "vitest";
import {
  createFullTestDb,
  createTestApp,
} from "./helpers/test-app.js";
import type {
  NodeBinding,
  RuntimeAdapter,
} from "../src/domain/runtime-adapter.js";

const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`;

const RIG_YAML = `version: "0.2"
name: bootstrap-policy-probe
permission_policy: builtin:yolo
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        permission_policy: builtin:locked
        cwd: .
    edges: []
edges: []
`;

const TWO_MEMBER_RIG_YAML = `version: "0.2"
name: bootstrap-policy-probe-2
permission_policy: builtin:yolo
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        permission_policy: builtin:locked
        cwd: .
      - id: qa
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        permission_policy: builtin:locked
        cwd: .
    edges: []
edges: []
`;

describe("R2 bootstrap provenance fault probe", () => {
  it("双成员 bootstrap 中首个写入者选择性故障：同级可启动（部分成功语义），但失败成员不得作为可恢复节点残留，否则恢复姿态会扩大为工作组 full_bypass（16e853a7 多席位守卫探针）", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as unknown as RuntimeAdapter;
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: {
          exists: (path: string) => path.includes("agents/impl"),
          readFile: (path: string) => {
            if (path.includes("agents/impl")) return AGENT_YAML;
            throw new Error(`not found: ${path}`);
          },
        },
      });
      // 选择性故障：第一次出处写入抛错，后续写入正常委托。
      const original = setup.rigRepo.setNodePolicyProvenance.bind(setup.rigRepo);
      let calls = 0;
      setup.rigRepo.setNodePolicyProvenance = (nodeId, prov) => {
        calls += 1;
        if (calls === 1) throw new Error("injected selective provenance fault");
        return original(nodeId, prov);
      };

      const outcome = await setup.podInstantiator.instantiate(TWO_MEMBER_RIG_YAML, "/rig");

      // 部分成功语义：未受影响的同级可以启动，工作组可以报告 ok。
      expect(bindings.length, "exactly the unaffected sibling launches").toBe(1);
      void outcome; // ok may be true under partial-success — that is the preserved contract

      // 关键不变量：不得留下缺少必要出处的可恢复节点。
      const rows = db.prepare("SELECT logical_id FROM nodes WHERE logical_id LIKE 'dev.%'").all() as { logical_id: string }[];
      const survivors = rows.map((r) => r.logical_id).sort();
      expect(survivors, "the failed member must not survive as a half-created node").toHaveLength(1);
      // 存活同级携带自身成员出处（locked/floor），绝不扩大为工作组级。
      const survivor = db.prepare("SELECT id, rig_id FROM nodes WHERE logical_id = ?").get(survivors[0]!) as { id: string; rig_id: string };
      expect(setup.rigRepo.getNodePolicyProvenance(survivor.id)).toMatchObject({ origin: "builtin", launchPosture: "floor" });
    } finally {
      db.close();
    }
  });

  it("正常路径：bootstrap 同时持久化 MEMBER attachment（locked/floor）和工作组 attachment（yolo），优先级与重启后的事实一致", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as unknown as RuntimeAdapter;
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: {
          exists: (path: string) => path.includes("agents/impl"),
          readFile: (path: string) => {
            if (path.includes("agents/impl")) return AGENT_YAML;
            throw new Error(`not found: ${path}`);
          },
        },
      });
      const outcome = await setup.podInstantiator.instantiate(RIG_YAML, "/rig");
      expect(outcome.ok).toBe(true);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.launchPosture, "member override (locked) controls the live launch").toBe("floor");
      const node = db.prepare("SELECT id, rig_id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string; rig_id: string };
      expect(setup.rigRepo.getNodePolicyProvenance(node.id)).toMatchObject({ origin: "builtin", launchPosture: "floor" });
      expect(setup.rigRepo.getRigPolicyProvenance(node.rig_id)).toMatchObject({ origin: "builtin", launchPosture: "full_bypass" });
    } finally {
      db.close();
    }
  });

  it("成员 attachment 无法持久化时不会静默成功", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => {
        bindings.push(binding);
        return { ok: true };
      },
      checkReady: async () => ({ ready: true }),
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: {
          exists: (path) => path.includes("agents/impl"),
          readFile: (path) => {
            if (path.includes("agents/impl")) return AGENT_YAML;
            throw new Error(`not found: ${path}`);
          },
        },
      });
      setup.rigRepo.setNodePolicyProvenance = () => {
        throw new Error("injected provenance write failure");
      };

      const outcome = await setup.podInstantiator.instantiate(RIG_YAML, "/rig");

      // 修正后的契约（R2 终态 4c49c758）：成员出处是 bootstrap 路径上关键的重启事实；
      // 真实 setter 故障必须可见。
      expect(outcome.ok, "bootstrap must not report success after losing restart truth").toBe(false);
      if (!outcome.ok) expect(JSON.stringify(outcome), "the failure names the injected fault").toContain("injected provenance write failure");
      expect(bindings, "a rejected bootstrap must not launch at an unpersisted posture").toHaveLength(0);
      // 不臆造出处，也不留下 restore 可能误读的半提交节点：
      const node = db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string } | undefined;
      if (node) expect(setup.rigRepo.getNodePolicyProvenance(node.id)).toBeNull();
    } finally {
      db.close();
    }
  });
});
