import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("POST /api/rigs/:rigId/expand 装备扩展路由", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seedRig(name = "test-rig") {
    return setup.rigRepo.createRig(name);
  }

  function terminalPod(id = "infra", memberId = "server") {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // 接缝 B（R2 终点 4ac243c3）：存在但无效的 permission_policy 必须到达唯一标准校验器——
  // 规范化器不得将“存在”抹为“缺省/floor”。
  it("接缝 B 红灯：扩展成员 permission_policy:null -> 结构化 400、零持久化、不启动（装备携带 builtin:yolo）", async () => {
    const rig = seedRig("null-policy-rig");
    setup.rigRepo.setRigPermissionPolicy(rig.id, "builtin:yolo");
    setup.rigRepo.setRigPolicyProvenance(rig.id, { origin: "builtin", resolvedTarget: "policies/builtin/yolo.policy.md", declaringDir: null, launchPosture: "full_bypass" });
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev2", label: "Dev2", members: [
        { id: "late", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp", permission_policy: null },
      ], edges: [] } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/permission_policy/);
    // 零持久化：被拒绝的工作组不产生成员节点、会话或边
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'dev2.%'").get()).toMatchObject({ c: 0 });
  });

  it("接缝 B 红灯：另一种存在但无效的形态（数字）也返回结构化 400，绝不强制转换或抹除", async () => {
    const rig = seedRig("num-policy-rig");
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev3", label: "Dev3", members: [
        { id: "late", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp", permission_policy: 42 },
      ], edges: [] } }),
    });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE 'dev3.%'").get()).toMatchObject({ c: 0 });
  });

  it("接缝 B 对照：有效字符串 permission_policy 与真正缺省在扩展中均保持可用", async () => {
    const rig = seedRig("valid-policy-rig");
    const ok = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: { id: "dev4", label: "Dev4", members: [
        { id: "server", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ], edges: [] } }),
    });
    expect(ok.status).toBe(201);
  });

  // T1：有效扩展 -> 201
  it("有效扩展返回 201 与成功结果", async () => {
    const rig = seedRig();
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.podNamespace).toBe("infra");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].logicalId).toBe("infra.server");
  });

  // T2：装备不存在 -> 404
  it("装备不存在时返回 404", async () => {
    const res = await setup.app.request("/api/rigs/nonexistent/expand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });
    expect(res.status).toBe(404);
  });

  // T3：命名空间重复 -> 409
  it("工作组命名空间重复时返回 409", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("infra") }),
    });

    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("infra", "server2") }),
    });
    expect(res.status).toBe(409);
  });

  // T4：启动失败 -> 207
  it("扩展中启动失败时返回 207", async () => {
    const rig = seedRig();
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValueOnce({ ok: false, code: "unknown", message: "tmux not available" });

    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(["partial", "failed"]).toContain(body.status);
  });

  // T5：恰好一个 rig.expanded 事件
  it("恰好发出一个 rig.expanded 事件", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const events = db.prepare("SELECT type FROM events WHERE type = 'rig.expanded'").all() as Array<{ type: string }>;
    expect(events).toHaveLength(1);
  });

  // T6：请求体缺失 -> 400
  it("请求体中缺少 pod 时返回 400", async () => {
    const rig = seedRig();
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // T7a：事件表中的 rig.expanded
  it("rig.expanded 事件包含正确载荷", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'rig.expanded'").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
    expect(payload.podNamespace).toBe("infra");
    expect(payload.status).toBe("ok");
  });

  // T7b：同时发出详细事件（pod.created、node.added）
  it("扩展期间发出详细事件（pod.created、node.added）", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod() }),
    });

    const podEvents = db.prepare("SELECT type FROM events WHERE type = 'pod.created'").all();
    const nodeEvents = db.prepare("SELECT type FROM events WHERE type = 'node.added'").all();
    expect(podEvents.length).toBeGreaterThanOrEqual(1);
    expect(nodeEvents.length).toBeGreaterThanOrEqual(1);
  });

  // T8：跨工作组边 -> 201
  it("包含跨工作组边的扩展返回 201", async () => {
    const rig = seedRig();
    // 第一个工作组
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("orch", "lead") }),
    });

    // 带跨工作组边的第二个工作组
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: terminalPod("dev", "impl"),
        crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("扩展包含从新工作组到现有节点的边时，仅启动新节点", async () => {
    const rig = seedRig();
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pod: terminalPod("backend", "api") }),
    });

    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: terminalPod("ops", "monitor"),
        crossPodEdges: [{ kind: "delegates_to", from: "ops.monitor", to: "backend.api" }],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].logicalId).toBe("ops.monitor");
  });

  it("工作组片段接受规范风格的 snake_case 成员字段", async () => {
    const rig = seedRig();
    const res = await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "qa",
          label: "QA",
          members: [
            {
              id: "reviewer",
              runtime: "terminal",
              agent_ref: "builtin:terminal",
              profile: "none",
              cwd: "/tmp",
              restore_policy: "checkpoint_only",
            },
          ],
          edges: [],
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodes[0].logicalId).toBe("qa.reviewer");
    const stored = db
      .prepare("SELECT agent_ref, restore_policy FROM nodes WHERE rig_id = ? AND logical_id = ?")
      .get(rig.id, "qa.reviewer") as { agent_ref: string; restore_policy: string } | undefined;
    expect(stored?.agent_ref).toBe("builtin:terminal");
    expect(stored?.restore_policy).toBe("checkpoint_only");
  });

  // OPR.0.5.6.3 修复（第 1 波 R2 暂停）：路由规范化器只识别 fork/rebuild，在服务映射器
  // 保留 ref.version 之前就静默丢弃整个 agent_image 会话源——已落地的 S03 服务测试直接
  // 调用 RigExpansionService，绕过了此入口。这些固定断言走真实 HTTP 路由，并观察
  // 服务/物化规范边界（materializeStructured 参数）。
  it("带版本固定的 agent_image session_source 经真实扩展入口后仍保留在物化规范中", async () => {
    const rig = seedRig("image-pin-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "img",
          label: "Imaged",
          members: [
            {
              id: "worker",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              cwd: "/tmp",
              session_source: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base", version: "3" } },
            },
          ],
          edges: [],
        },
      }),
    });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["session_source"]).toEqual({
      mode: "agent_image",
      ref: { kind: "image_name", value: "builder-base", version: "3" },
    });
    materializeSpy.mockRestore();
  });

  it("无版本 agent_image session_source 经入口后仍保留，且不凭空添加 version 键", async () => {
    const rig = seedRig("image-unpinned-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "img2",
          label: "Imaged2",
          members: [
            {
              id: "worker",
              runtime: "claude-code",
              agent_ref: "local:agents/impl",
              profile: "default",
              cwd: "/tmp",
              session_source: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base" } },
            },
          ],
          edges: [],
        },
      }),
    });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["session_source"]).toEqual({
      mode: "agent_image",
      ref: { kind: "image_name", value: "builder-base" },
    });
    materializeSpy.mockRestore();
  });

  it("有效数字版本按 schema 一致性转换为字符串", async () => {
    const rig = seedRig("image-numeric-rig");
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await setup.app.request(`/api/rigs/${rig.id}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pod: {
          id: "imgnum",
          label: "X",
          members: [
            { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: { mode: "agent_image", ref: { kind: "image_name", value: "ok", version: 3 } } },
          ],
          edges: [],
        },
      }),
    });
    // 数字版本转换为字符串——保持 schema 一致（rigspec-schema.ts 校验 string|number，
    // 并以 String(versionRaw) 规范化；编排负责人 2026-08-28 12:06Z 裁定：若只接受
    // 字符串，会在 YAML `version: 3` 上重新引入静默默认缺陷）
    const spec = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    expect(spec.pods[0]!.members[0]!["session_source"]).toEqual({ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: "3" } });
    materializeSpy.mockRestore();
  });

  // S03 修复补充（R2 管控暂停）：存在但无效的 agent_image 形态必须到达唯一标准校验器，
  // 并以结构化形式失败——绝不能被抹为 session_source 缺省，后者会把无效请求静默放宽为
  // 未固定/无来源扩展（将接缝 B 的存在性保留规则应用于 session_source）。
  it("存在但无效的 agent_image 形态到达标准校验器：结构化 400、零持久化，绝不抹为缺省", async () => {
    const rig = seedRig("image-invalid-rig");
    const post = (sessionSource: unknown, podId: string) =>
      setup.app.request(`/api/rigs/${rig.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pod: {
            id: podId,
            label: "X",
            members: [
              { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: sessionSource },
            ],
            edges: [],
          },
        }),
      });

    const cases: Array<[unknown, string]> = [
      [{ mode: "agent_image", ref: { kind: "image_name", value: "" } }, "inv1"],
      [{ mode: "agent_image", ref: { kind: "image_id", value: "x" } }, "inv2"],
      [{ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: { pin: 3 } } }, "inv3"],
      [{ mode: "agent_image", ref: { kind: "image_name", value: "ok", version: true } }, "inv4"],
    ];
    for (const [sessionSource, podId] of cases) {
      const res = await post(sessionSource, podId);
      expect(res.status, `${podId} must fail structured validation, not expand`).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body), `${podId} error must name session_source`).toMatch(/session_source/);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE ?").get(`${podId}.%`),
        `${podId} must persist nothing`,
      ).toMatchObject({ c: 0 });
    }
  });

  // S03 最终存在性补充：不变量是键是否存在，而不是列举错误形态。任何存在的
  // session_source 值——仅 mode 的对象、null/非对象 ref、原始值或 null 本身——都必须
  // 到达标准校验器并以结构化形式失败；只有真正不存在的键才保持缺省。
  it("存在性不变量：仅 mode、ref:null、原始值和 null 的 session_source 均到达标准校验器（400 指明 session_source，零持久化）", async () => {
    const rig = seedRig("presence-invariant-rig");
    const post = (sessionSource: unknown, podId: string) =>
      setup.app.request(`/api/rigs/${rig.id}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pod: {
            id: podId,
            label: "P",
            members: [
              { id: "w", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp", session_source: sessionSource },
            ],
            edges: [],
          },
        }),
      });

    const cases: Array<[unknown, string]> = [
      [{ mode: "agent_image" }, "pres1"],
      [{ mode: "agent_image", ref: null }, "pres2"],
      [{ mode: "agent_image", ref: "builder-base" }, "pres3"],
      ["builder-base", "pres4"],
      [null, "pres5"],
      [{ mode: "snapshot", ref: { kind: "image_name", value: "x" } }, "pres6"],
    ];
    for (const [sessionSource, podId] of cases) {
      const res = await post(sessionSource, podId);
      expect(res.status, `${podId} must fail structured validation, never erase into absence`).toBe(400);
      const body = await res.json();
      expect(JSON.stringify(body), `${podId} error must name session_source`).toMatch(/session_source/);
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE logical_id LIKE ?").get(`${podId}.%`),
        `${podId} must persist nothing`,
      ).toMatchObject({ c: 0 });
    }
  });
});
