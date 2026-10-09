import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createTestApp } from "./helpers/test-app.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function getEvents(database: Database.Database): Array<{ type: string; payload: string }> {
  return database.prepare("SELECT type, payload FROM events ORDER BY seq").all() as Array<{ type: string; payload: string }>;
}

describe("发现 API 路由", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createTestApp>["app"];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => { db.close(); });

  function seedDiscovery(tmuxSession: string = "organic", tmuxPane: string = "%0") {
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run(`ds-${tmuxSession}-${tmuxPane}`, tmuxSession, tmuxPane, "claude-code", "high");
    return `ds-${tmuxSession}-${tmuxPane}`;
  }

  function seedRig() {
    const rig = setup.rigRepo.createRig("test-rig");
    return rig;
  }

  // T1：POST /scan 返回发现的会话。
  it("POST /api/discovery/scan 返回会话", async () => {
    // 扫描器不会发现任何内容（mock adapter 返回空），但路由应正常工作。
    const res = await app.request("/api/discovery/scan", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  // T1b：扫描器失败时 POST /scan 返回带结构化错误的 500。
  it("扫描器失败时 POST /api/discovery/scan 返回 500 和错误", async () => {
    // 覆盖扫描器，使其抛错。
    (setup.tmuxScanner as unknown as { scan: unknown }).scan = async () => {
      throw new Error("tmux boom");
    };

    const res = await app.request("/api/discovery/scan", { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("tmux boom");
  });

  // T2：GET /discovery 按状态过滤列表。
  it("GET /api/discovery?status=active 列出活动会话", async () => {
    seedDiscovery("s1", "%0");
    seedDiscovery("s2", "%0");

    const res = await app.request("/api/discovery?status=active");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("GET /api/discovery 按 runtime 提示和最低置信度过滤", async () => {
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run("ds-claude", "claude-team", "%0", "claude-code", "high");
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run("ds-codex", "codex-team", "%0", "codex", "medium");
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run("ds-shell", "shell", "%0", "terminal", "high");
    db.prepare(
      "INSERT INTO discovered_sessions (id, tmux_session, tmux_pane, runtime_hint, confidence) VALUES (?, ?, ?, ?, ?)"
    ).run("ds-weak", "weak", "%0", "claude-code", "low");

    const res = await app.request("/api/discovery?status=active&runtimeHint=claude-code,codex&minConfidence=medium");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((row: { id: string }) => row.id)).toEqual(["ds-claude", "ds-codex"]);
  });

  // T3：GET /:id 返回详情。
  it("GET /api/discovery/:id 返回会话详情", async () => {
    const id = seedDiscovery();

    const res = await app.request(`/api/discovery/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.runtimeHint).toBe("claude-code");
  });

  // T4：POST /:id/bind 成功返回 201（绑定到现有节点）。
  it("POST /api/discovery/:id/bind 绑定到现有节点", async () => {
    const id = seedDiscovery();
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/workspace" });

    const res = await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "orch.lead" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBeTruthy();
  });

  it("POST /api/discovery/:id/bind 绑定到现有受管节点", async () => {
    const id = seedDiscovery();
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/workspace" });

    const res = await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "orch.lead" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBeTruthy();
  });

  it("POST /api/discovery/:id/adopt 绑定到现有受管节点目标", async () => {
    const id = seedDiscovery();
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/workspace" });

    const res = await app.request(`/api/discovery/${id}/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rigId: rig.id,
        target: { kind: "node", logicalId: "orch.lead" },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe("bind");
    expect(body.logicalId).toBe("orch.lead");
  });

  it("POST /api/discovery/:id/adopt 在 pod 目标内创建并绑定新节点", async () => {
    const id = seedDiscovery("research-scout", "%2");
    const rig = seedRig();
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-research", rig.id, "research", "Research");
    setup.rigRepo.addNode(rig.id, "research.mapper", { runtime: "claude-code", podId: "pod-research" });

    const res = await app.request(`/api/discovery/${id}/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rigId: rig.id,
        target: { kind: "pod", podId: "pod-research", podNamespace: "research", memberName: "scout" },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.action).toBe("create_and_bind");
    expect(body.logicalId).toBe("research.scout");

    const claimedNode = setup.rigRepo.getRig(rig.id)?.nodes.find((node) => node.logicalId === "research.scout");
    expect(claimedNode?.podId).toBe("pod-research");
    expect(claimedNode?.binding?.tmuxSession).toBe("research-scout");
  });

  // T5a：绑定不存在的发现记录返回 404。
  it("绑定不存在的发现记录时返回 404", async () => {
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code" });
    const res = await app.request("/api/discovery/nonexistent/bind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "orch.lead" }),
    });
    expect(res.status).toBe(404);
  });

  // T5b：绑定到不存在的工作组返回 404。
  it("绑定到不存在的工作组时返回 404", async () => {
    const id = seedDiscovery();
    const res = await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: "nonexistent-rig", logicalId: "some-node" }),
    });
    expect(res.status).toBe(404);
  });

  // T5c：缺少 rigId 返回 400。
  it("claim 缺少 rigId 时返回 400", async () => {
    const id = seedDiscovery();
    const res = await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("bind 缺少 logicalId 时返回 400", async () => {
    const id = seedDiscovery();
    const rig = seedRig();
    const res = await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });
    expect(res.status).toBe(400);
  });

  // T6a：已绑定返回 409。
  it("绑定已绑定会话时返回 409", async () => {
    const id = seedDiscovery();
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "node-a", { runtime: "claude-code" });
    setup.rigRepo.addNode(rig.id, "node-b", { runtime: "claude-code" });

    // 首次绑定。
    await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "node-a" }),
    });

    // 再次绑定同一发现记录——会话已被认领。
    const res = await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "node-b" }),
    });
    expect(res.status).toBe(409);
  });

  // T6b：绑定到已绑定节点返回 409。
  it("绑定到已绑定节点时返回 409", async () => {
    const id1 = seedDiscovery("s1", "%0");
    const id2 = seedDiscovery("s2", "%0");
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "dev", { runtime: "claude-code" });

    // 将第一个会话绑定到 dev。
    await app.request(`/api/discovery/${id1}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "dev" }),
    });

    // 将第二个会话绑定到同一节点，返回 409（已绑定）。
    const res = await app.request(`/api/discovery/${id2}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "dev" }),
    });
    expect(res.status).toBe(409);
  });

  // T7：createDaemon 接入发现路由（GET /discovery 返回 200）。
  it("createDaemon wires discovery routes", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app: daemonApp, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });

    try {
      const res = await daemonApp.request("/api/discovery");
      expect(res.status).toBe(200);
    } finally {
      daemonDb.close();
    }
  });

  // T11：断言发现依赖使用相同数据库句柄（通过 createApp 导入）。
  it("createApp 拒绝数据库句柄不匹配的 discoveryRepo", async () => {
    const db2 = createDb();
    migrate(db2, ALL_MIGRATIONS);

    const { createApp } = await import("../src/server.js");
    const { DiscoveryRepository } = await import("../src/domain/discovery-repository.js");

    // 从现有测试应用构建正确依赖，再把 discoveryRepo 换成错误数据库。
    const goodSetup = createTestApp(db);
    const mismatchedRepo = new DiscoveryRepository(db2);

    expect(() => {
      createApp({ ...goodSetup, discoveryRepo: mismatchedRepo });
    }).toThrow(/discoveryRepo.*必须共享同一个数据库句柄/);

    db2.close();
  });

  // T12a：POST /scan 通过路由发出 session.discovered 事件。
  it("POST /scan 通过路由和协调器发出 session.discovered 事件", async () => {
    // 覆盖 mock 扫描器，使其返回一个 pane。
    (setup.tmuxScanner as unknown as { scan: unknown }).scan = async () => ({
      panes: [{ tmuxSession: "organic", tmuxWindow: "0", tmuxPane: "%0", pid: 1234, cwd: "/tmp", activeCommand: "claude" }],
      scannedAt: new Date().toISOString(),
    });

    await app.request("/api/discovery/scan", { method: "POST" });

    const events = getEvents(db).filter((e) => e.type === "session.discovered");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.tmuxSession).toBe("organic");
  });

  // T12b：会话消失后重新 POST /scan，通过路由发出 session.vanished。
  it("会话消失时 POST /scan 发出 session.vanished", async () => {
    // 第一次扫描：会话存在。
    (setup.tmuxScanner as unknown as { scan: unknown }).scan = async () => ({
      panes: [{ tmuxSession: "ephemeral", tmuxWindow: "0", tmuxPane: "%5", pid: 999, cwd: "/tmp", activeCommand: "bash" }],
      scannedAt: new Date().toISOString(),
    });
    await app.request("/api/discovery/scan", { method: "POST" });

    // 第二次扫描：会话消失。
    (setup.tmuxScanner as unknown as { scan: unknown }).scan = async () => ({
      panes: [],
      scannedAt: new Date().toISOString(),
    });
    await app.request("/api/discovery/scan", { method: "POST" });

    const events = getEvents(db).filter((e) => e.type === "session.vanished");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.tmuxSession).toBe("ephemeral");
  });

  // T12c：POST /:id/bind 发出 node.claimed 事件。
  it("POST /:id/bind emits node.claimed event", async () => {
    const id = seedDiscovery();
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code" });

    await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "orch.lead" }),
    });

    const events = getEvents(db).filter((e) => e.type === "node.claimed");
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
  });

  // T13：POST /:id/bind 通过异步 HTTP 路径设置 @rigged_* tmux 元数据。
  it("POST /:id/bind 在已采纳会话上设置 tmux 元数据", async () => {
    const id = seedDiscovery("claimed-target", "%0");
    const rig = seedRig();
    setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code" });

    const res = await app.request(`/api/discovery/${id}/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, logicalId: "orch.lead" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const setOpt = setup.tmuxAdapter.setSessionOption as ReturnType<typeof import("vitest").vi.fn>;
    expect(setOpt).toHaveBeenCalled();
    const calls = setOpt.mock.calls as [string, string, string][];
    // 所有元数据写入都以发现的 tmux 会话为目标。
    for (const call of calls) {
      expect(call[0]).toBe("claimed-target");
    }
    const metaMap = new Map(calls.map((c: [string, string, string]) => [c[1], c[2]]));
    expect(metaMap.get("@rigged_node_id")).toBe(body.nodeId);
    expect(metaMap.get("@rigged_session_name")).toBe("claimed-target");
    expect(metaMap.get("@rigged_rig_id")).toBe(rig.id);
    expect(metaMap.get("@rigged_rig_name")).toBe("test-rig");
    expect(metaMap.get("@rigged_logical_id")).toBe("orch.lead");
  });
});
