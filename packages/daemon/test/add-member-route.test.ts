import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { ExpansionRequest } from "../src/domain/types.js";

// OPR.0.3.3.24 第 3 块 — POST /api/rigs/:rigId/pods/:podNamespace/members。
// add_member 收敛操作的 HTTP 接口：状态码映射与扩展路由保持一致
//（404 未找到、409 冲突、400 校验失败、201 已创建）。
describe("POST /api/rigs/:rigId/pods/:podNamespace/members", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function terminalPodFragment(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
    return {
      id,
      label: "Infrastructure",
      members: [{ id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }],
      edges: [],
    };
  }

  async function seedRigWithPod() {
    const rig = setup.rigRepo.createRig("test-rig");
    const expanded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: terminalPodFragment() });
    expect(expanded.ok).toBe(true);
    return rig;
  }

  function addMember(rigId: string, podNamespace: string, member: Record<string, unknown>, rigRoot = ".") {
    return setup.app.request(`/api/rigs/${rigId}/pods/${podNamespace}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member, rigRoot }),
    });
  }

  const terminalMember = (id: string) => ({ id, runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" });

  it("有效添加时返回 201 和新增节点", async () => {
    const rig = await seedRigWithPod();
    const res = await addMember(rig.id, "infra", terminalMember("server2"));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.podNamespace).toBe("infra");
    expect(body.result.node.logicalId).toBe("infra.server2");
    expect(body.result.node.status).toBe("launched");

    // 新节点位于运行中工作组的现有 pod 下。
    const updatedRig = setup.rigRepo.getRig(rig.id)!;
    expect(updatedRig.nodes.some((n) => n.logicalId === "infra.server2")).toBe(true);
  });

  it("工作组不存在时返回 404", async () => {
    const res = await addMember("nonexistent", "infra", terminalMember("x"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("rig_not_found");
  });

  it("pod 命名空间不存在时返回 404", async () => {
    const rig = await seedRigWithPod();
    const res = await addMember(rig.id, "nope", terminalMember("x"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("pod_not_found");
    expect(body.message).toContain("infra");
  });

  it("成员 id 重复时返回 409（保留重复项防护）", async () => {
    const rig = await seedRigWithPod();
    const res = await addMember(rig.id, "infra", terminalMember("server"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("member_conflict");
  });

  it("请求体缺少 member 时返回 400", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("member 片段格式错误时返回 400（validation_failed）", async () => {
    const rig = await seedRigWithPod();
    // 缺少 agent_ref。
    const res = await addMember(rig.id, "infra", { id: "broken", runtime: "claude-code", profile: "default", cwd: "/tmp" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_failed");
  });

  it("为新增成员发出 node.added 事件", async () => {
    const rig = await seedRigWithPod();
    await addMember(rig.id, "infra", terminalMember("server2"));

    const added = db.prepare("SELECT payload FROM events WHERE type = 'node.added'").all() as Array<{ payload: string }>;
    const logicalIds = added.map((e) => JSON.parse(e.payload).logicalId);
    expect(logicalIds).toContain("infra.server2");
  });

  it("接受规范所用的 snake_case 成员字段", async () => {
    const rig = await seedRigWithPod();
    const res = await addMember(rig.id, "infra", {
      id: "reviewer",
      runtime: "terminal",
      agent_ref: "builtin:terminal",
      profile: "none",
      cwd: "/tmp",
      restore_policy: "checkpoint_only",
    });
    expect(res.status).toBe(201);
    const stored = db
      .prepare("SELECT agent_ref, restore_policy FROM nodes WHERE rig_id = ? AND logical_id = ?")
      .get(rig.id, "infra.reviewer") as { agent_ref: string; restore_policy: string } | undefined;
    expect(stored?.agent_ref).toBe("builtin:terminal");
    expect(stored?.restore_policy).toBe("checkpoint_only");
  });

  // 治理 FM2：请求体中的 pod 本地边会被端到端保留。
  it("持久化请求体声明的 pod 本地边（不会静默丢弃）", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member: terminalMember("server2"),
        edges: [{ from: "server2", to: "server", kind: "delegates_to" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.result.edges).toEqual([{ from: "infra.server2", to: "infra.server", kind: "delegates_to" }]);

    const rows = db.prepare("SELECT kind FROM edges WHERE rig_id = ?").all(rig.id) as Array<{ kind: string }>;
    expect(rows.some((r) => r.kind === "delegates_to")).toBe(true);
  });

  it("pod 本地边无法解析时返回 400（edge_unresolved）", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        member: terminalMember("server2"),
        edges: [{ from: "server2", to: "ghost", kind: "delegates_to" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("edge_unresolved");
  });

  it("edges 字段存在但不是数组时返回 400（不静默丢弃）", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: terminalMember("server2"), edges: { from: "server2", to: "server", kind: "delegates_to" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_failed");
    // 不得静默创建。
    expect(setup.rigRepo.getRig(rig.id)!.nodes.some((n) => n.logicalId === "infra.server2")).toBe(false);
  });

  it("边类型无效时返回 400（validation_failed）", async () => {
    const rig = await seedRigWithPod();
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/infra/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: terminalMember("server2"), edges: [{ from: "server2", to: "server", kind: "nonsense_kind" }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_failed");
  });
});
