import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { ExpansionRequest } from "../src/domain/types.js";

// OPR.0.3.3.24 Chunk 2——add_member converge op。
// 针对 PodRigInstantiator.addMemberToPod 的后台服务覆盖：happy path（在现有 pod 中创建并启动
// member）、保留的逐 member 重复 guard（AC-3）、pod/rig not-found 真实性、校验，以及关键的
// identity-migration-free 属性（AC-2：pod-mate 前后不受影响）。
describe("PodRigInstantiator.addMemberToPod", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function terminalMember(id: string) {
    return { id, runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" };
  }

  function terminalPodFragment(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // 填种一个 live 工作组，其中现有 pod infra 包含一个 member infra.server。
  async function seedRigWithPod() {
    const rig = setup.rigRepo.createRig("test-rig");
    const expanded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: terminalPodFragment() });
    expect(expanded.ok).toBe(true);
    return rig;
  }

  it("向现有 pod 添加 member 并启动它", async () => {
    const rig = await seedRigWithPod();

    const result = await setup.podInstantiator.addMemberToPod(
      rig.id,
      "infra",
      terminalMember("server2"),
      ".",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.podNamespace).toBe("infra");
    expect(result.result.node.logicalId).toBe("infra.server2");
    expect(result.result.node.status).toBe("launched");
    expect(result.result.node.sessionName).toBeTruthy();

    // 新节点位于 live 工作组中，归属同一个现有 pod。
    const updatedRig = setup.rigRepo.getRig(rig.id)!;
    const newNode = updatedRig.nodes.find((n) => n.logicalId === "infra.server2");
    expect(newNode).toBeDefined();
    expect(newNode!.podId).toBe(result.result.podId);
  });

  function podRowsForRig(rigId: string) {
    return db.prepare("SELECT id, namespace FROM pods WHERE rig_id = ?").all(rigId) as Array<{ id: string; namespace: string }>;
  }

  it("在现有 pod 下创建 member，不创建新 pod", async () => {
    const rig = await seedRigWithPod();
    const podsBefore = podRowsForRig(rig.id);
    expect(podsBefore).toHaveLength(1);
    const existingPodId = podsBefore[0]!.id;

    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Pod 数量不变；新节点的 pod_id 指向预先存在的 pod。
    const podsAfter = podRowsForRig(rig.id);
    expect(podsAfter).toHaveLength(1);
    expect(result.result.podId).toBe(existingPodId);
    const newNode = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === "infra.server2");
    expect(newNode!.podId).toBe(existingPodId);

    // 为新增 member 恰好产生一个 node.added event。
    const added = db.prepare("SELECT payload FROM events WHERE type = 'node.added'").all() as Array<{ payload: string }>;
    const addedLogicalIds = added.map((e) => JSON.parse(e.payload).logicalId);
    expect(addedLogicalIds).toContain("infra.server2");
  });

  it("无 identity 迁移：pod-mate 前后不受影响（AC-2）", async () => {
    const rig = await seedRigWithPod();
    const mateBefore = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === "infra.server")!;
    const mateNodeIdBefore = mateBefore.id;
    const matePodIdBefore = mateBefore.podId;
    const mateSessionBefore = setup.sessionRegistry.getSessionsForRig(rig.id).find((s) => s.nodeId === mateNodeIdBefore);

    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mateAfter = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === "infra.server")!;
    // 现有席位 identity 不变：node id、logical id 与 pod 均相同；新节点使用不同的全新 node id。
    expect(mateAfter.id).toBe(mateNodeIdBefore);
    expect(mateAfter.logicalId).toBe("infra.server");
    expect(mateAfter.podId).toBe(matePodIdBefore);
    expect(result.result.node.nodeId).not.toBe(mateNodeIdBefore);

    // pod-mate 的 session 不重新设 key，session id + name 保持相同。
    const mateSessionAfter = setup.sessionRegistry.getSessionsForRig(rig.id).find((s) => s.nodeId === mateNodeIdBefore);
    expect(mateSessionAfter?.id).toBe(mateSessionBefore?.id);
    expect(mateSessionAfter?.sessionName).toBe(mateSessionBefore?.sessionName);
    // LIVE-RIG QA 还会证明 continuity_state + queue routing 未被触碰。
  });

  it("拒绝目标 pod 中重复的 member id（AC-3，保留 dup guard）", async () => {
    const rig = await seedRigWithPod();

    // "server" 已存在于 pod "infra"。
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server"), ".");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("member_conflict");
    expect(result.message).toContain("infra.server");
  });

  it("未知 pod namespace 返回 pod_not_found", async () => {
    const rig = await seedRigWithPod();

    const result = await setup.podInstantiator.addMemberToPod(rig.id, "nope", terminalMember("x"), ".");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pod_not_found");
    // 真实说明缺失 namespace，并列出可用项。
    expect(result.message).toContain("nope");
    expect(result.message).toContain("infra");
  });

  it("未知工作组返回 rig_not_found", async () => {
    const result = await setup.podInstantiator.addMemberToPod("nonexistent", "infra", terminalMember("x"), ".");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rig_not_found");
  });

  it("malformed member fragment 返回 validation_failed", async () => {
    const rig = await seedRigWithPod();

    // 缺少 schema 必需的 agent_ref。
    const result = await setup.podInstantiator.addMemberToPod(
      rig.id,
      "infra",
      { id: "broken", runtime: "claude-code", profile: "default", cwd: "/tmp" },
      ".",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("新席位可通过 ${pod}-${member}@${rig} 在 queue 中寻址（AC-1 派生 session）", async () => {
    const rig = await seedRigWithPod();

    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.node.sessionName).toBe("infra-server2@test-rig");
  });

  // Governance FM2：保留可选 pod-local edge，绝不静默丢弃。
  function edgeRows(rigId: string) {
    return db.prepare("SELECT source_id, target_id, kind FROM edges WHERE rig_id = ?").all(rigId) as Array<{ source_id: string; target_id: string; kind: string }>;
  }

  it("未声明 edge 时默认为无 edge", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.edges).toEqual([]);
  });

  it("持久化从新 member 到现有 pod-mate 的已声明 pod-local edge", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: [{ from: "server2", to: "server", kind: "delegates_to" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 使用限定 endpoint 报告。
    expect(result.result.edges).toEqual([{ from: "infra.server2", to: "infra.server", kind: "delegates_to" }]);

    // 作为两个 node id 之间的真实 graph edge 持久化。
    const nodes = setup.rigRepo.getRig(rig.id)!.nodes;
    const newId = nodes.find((n) => n.logicalId === "infra.server2")!.id;
    const mateId = nodes.find((n) => n.logicalId === "infra.server")!.id;
    const rows = edgeRows(rig.id);
    expect(rows).toContainEqual({ source_id: newId, target_id: mateId, kind: "delegates_to" });
  });

  it("拒绝指向无法解析 endpoint 的 pod-local edge（edge_unresolved），且不创建节点", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: [{ from: "server2", to: "ghost", kind: "delegates_to" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("edge_unresolved");
    expect(result.message).toContain("infra.ghost");

    // Fail-fast：不产生 orphan node 或 edge。
    expect(setup.rigRepo.getRig(rig.id)!.nodes.some((n) => n.logicalId === "infra.server2")).toBe(false);
    expect(edgeRows(rig.id)).toHaveLength(0);
  });

  it("以 validation_failed 拒绝 malformed edge（空 kind）", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: [{ from: "server2", to: "server", kind: "" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
    // 被拒绝的声明不产生 orphan node。
    expect(setup.rigRepo.getRig(rig.id)!.nodes.some((n) => n.logicalId === "infra.server2")).toBe(false);
  });

  it("拒绝 canonical set 外的 edge kind（validation_failed，共享 VALID_EDGE_KINDS）", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: [{ from: "server2", to: "server", kind: "nonsense_kind" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
    expect(result.errors.join(" ")).toContain("delegates_to");
    expect(edgeRows(rig.id)).toHaveLength(0);
  });

  it("以 validation_failed 拒绝存在但非数组的 edges 字段，不静默丢弃", async () => {
    const rig = await seedRigWithPod();
    const result = await setup.podInstantiator.addMemberToPod(rig.id, "infra", terminalMember("server2"), ".", {
      edges: { from: "server2", to: "server", kind: "delegates_to" } as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
    expect(setup.rigRepo.getRig(rig.id)!.nodes.some((n) => n.logicalId === "infra.server2")).toBe(false);
  });
});
