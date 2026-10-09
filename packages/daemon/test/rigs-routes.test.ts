import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

function insertStartupContextRow(db: Database.Database, nodeId: string) {
  db.prepare(
    "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run(nodeId, "[]", "[]", "[]", "claude-code");
}

describe("Rig CRUD 路由", () => {
  let db: Database.Database;
  let app: Hono;
  let repo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotRepo: SnapshotRepository;
  let snapshotCapture: SnapshotCapture;
  let restoreOrchestrator: RestoreOrchestrator;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    repo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotRepo = setup.snapshotRepo;
    snapshotCapture = setup.snapshotCapture;
    restoreOrchestrator = setup.restoreOrchestrator;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/rigs 返回 201 及带 id/name 的新建 rig", async () => {
    const res = await app.request("/api/rigs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-rig" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("test-rig");
  });

  it("GET /api/rigs 返回 rig 列表", async () => {
    repo.createRig("rig-a");
    repo.createRig("rig-b");

    const res = await app.request("/api/rigs");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].name).toBeDefined();
  });

  it("GET /api/rigs/:id 返回包含 nodes、edges、bindings 的完整 graph", async () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(rig.id, "worker", { role: "worker" });
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/rigs/${rig.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rig.name).toBe("test-rig");
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0].kind).toBe("delegates_to");
  });

  it("GET /api/rigs/:id 中未绑定节点的 binding 为 null（不省略）", async () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    const worker = body.nodes.find((n: { logicalId: string }) => n.logicalId === "worker");
    expect(worker).toBeDefined();
    expect(worker).toHaveProperty("binding");
    expect(worker.binding).toBeNull();
  });

  it("GET /api/rigs/:id 的 id 不存在时返回 404", async () => {
    const res = await app.request("/api/rigs/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/rigs/:id 返回 204", async () => {
    const rig = repo.createRig("test-rig");

    const res = await app.request(`/api/rigs/${rig.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(repo.getRig(rig.id)).toBeNull();
  });

  it("DELETE /api/rigs/:id 在 DB 中写入 rig.deleted event 行", async () => {
    const rig = repo.createRig("test-rig");

    const res = await app.request(`/api/rigs/${rig.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const events = db
      .prepare("SELECT type, payload FROM events WHERE type = 'rig.deleted'")
      .all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
  });

  it("DELETE /api/rigs/:id 的 id 不存在时返回 204 且无 rig.deleted event", async () => {
    const res = await app.request("/api/rigs/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(204);

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'rig.deleted'")
      .all();
    expect(events).toHaveLength(0);
  });

  it("events 被破坏时 DELETE /api/rigs/:id 保留 rig 且不写 event 行", async () => {
    const rig = repo.createRig("test-rig");

    // 破坏 events 表，使 event insert 在事务内失败。
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const res = await app.request(`/api/rigs/${rig.id}`, { method: "DELETE" });
    // 应失败（事务回滚）。
    expect(res.status).toBe(500);

    // Rig 仍存在（已回滚）。
    expect(repo.getRig(rig.id)).not.toBeNull();

    // 没有部分写入的 event 行。
    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("POST /api/rigs 的 body 无效时返回 400", async () => {
    const res = await app.request("/api/rigs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/rigs/:id/attach-self 将 external_cli agent 绑定到现有节点", async () => {
    const rig = repo.createRig("rigged-buildout");
    const node = repo.addNode(rig.id, "orch1.lead", { runtime: "claude-code" });

    const res = await app.request(`/api/rigs/${rig.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logicalId: "orch1.lead",
        displayName: "orch1-lead@rigged-buildout",
        cwd: "/Users/example/code/openrig",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBe(node.id);
    expect(body.attachmentType).toBe("external_cli");
    expect(body.env.OPENRIG_NODE_ID).toBe(node.id);
    expect(body.env.OPENRIG_SESSION_NAME).toBe("orch1-lead@rigged-buildout");
  });

  it("POST /api/rigs/:id/attach-self 可在不发现的情况下自附加 tmux-backed shell", async () => {
    const rig = repo.createRig("rigged-buildout");
    const node = repo.addNode(rig.id, "dev1.impl2", { runtime: "claude-code" });

    const res = await app.request(`/api/rigs/${rig.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logicalId: "dev1.impl2",
        attachmentType: "tmux",
        tmuxSession: "dev1-impl2@rigged-buildout",
        tmuxWindow: "@12",
        tmuxPane: "%34",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nodeId).toBe(node.id);
    expect(body.attachmentType).toBe("tmux");
    expect(body.env.OPENRIG_NODE_ID).toBe(node.id);
    expect(body.env.OPENRIG_SESSION_NAME).toBe("dev1-impl2@rigged-buildout");

    const rigAfter = repo.getRig(rig.id);
    const attached = rigAfter?.nodes.find((candidate) => candidate.logicalId === "dev1.impl2");
    expect(attached?.binding?.attachmentType).toBe("tmux");
    expect(attached?.binding?.tmuxSession).toBe("dev1-impl2@rigged-buildout");
    expect(attached?.binding?.tmuxWindow).toBe("@12");
    expect(attached?.binding?.tmuxPane).toBe("%34");
    expect(attached?.binding?.externalSessionName).toBeNull();
  });

  it("提供 podNamespace + memberName 时 POST /api/rigs/:id/attach-self 创建新 pod 成员", async () => {
    const rig = repo.createRig("rigged-buildout");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-orch1", rig.id, "orch1", "Orchestrator");

    const res = await app.request(`/api/rigs/${rig.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        podNamespace: "orch1",
        memberName: "lead",
        runtime: "claude-code",
        displayName: "orch1-lead@rigged-buildout",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.logicalId).toBe("orch1.lead");

    const rigAfter = repo.getRig(rig.id);
    const node = rigAfter?.nodes.find((candidate) => candidate.logicalId === "orch1.lead");
    expect(node).toBeDefined();
    expect(node?.binding?.attachmentType).toBe("external_cli");
  });

  it("POST /api/rigs/:id/attach-self 拒绝同时使用 logicalId 和 pod mode", async () => {
    const rig = repo.createRig("rigged-buildout");

    const res = await app.request(`/api/rigs/${rig.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logicalId: "orch1.lead",
        podNamespace: "orch1",
        memberName: "lead",
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("请指定 logicalId");
  });

  it("目标节点已绑定时 POST /api/rigs/:id/attach-self 返回 409", async () => {
    const rig = repo.createRig("rigged-buildout");
    const node = repo.addNode(rig.id, "orch1.lead", { runtime: "claude-code" });
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "tmux",
      tmuxSession: "orch1-lead@rigged-buildout",
    });
    sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");

    const res = await app.request(`/api/rigs/${rig.id}/attach-self`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logicalId: "orch1.lead",
        displayName: "orch1-lead@rigged-buildout",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("already_bound");
  });

  // -- T21：Graph projection endpoint --

  it("GET /api/rigs/:id/graph 返回节点和边数量正确的 RF JSON", async () => {
    const rig = repo.createRig("r01");
    const n1 = repo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(rig.id, "worker", { role: "worker" });
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.edges).toHaveLength(1);
  });

  it("GET /api/rigs/:id/graph 的 node.data 包含 session 状态", async () => {
    const rig = repo.createRig("r01");
    const node = repo.addNode(rig.id, "dev1-impl", { role: "worker" });
    // 通过 app 注入的 sessionRegistry 播种 session。
    const session = sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();
    const nodeData = body.nodes.find((n: { data: { logicalId: string } }) => n.data.logicalId === "dev1-impl");
    expect(nodeData.data.status).toBe("running");
  });

  it("GET /api/rigs/:id/graph 的 node.data 携带真实的 assigned-work 明细", async () => {
    const rig = repo.createRig("r01");
    const node = repo.addNode(rig.id, "dev.impl", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@r01");
    sessionRegistry.updateStatus(session.id, "running");
    const ts = "2026-08-28 10:00:00";
    for (const [index, state] of ["pending", "in-progress", "blocked", "done"].entries()) {
      db.prepare(`
        INSERT INTO queue_items
          (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
        VALUES (?, ?, ?, 'op@test', 'dev-impl@r01', ?, 'routine', 'routine', 'body')
      `).run(`q-graph-${index}`, ts, ts, state);
    }

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const data = body.nodes.find((n: { data: { logicalId: string } }) => n.data.logicalId === "dev.impl").data;
    expect(data.hasAssignedWork).toBe(true);
    expect(data.assignedWorkCount).toBe(3);
    expect(data.pendingWorkCount).toBe(1);
    expect(data.inProgressWorkCount).toBe(1);
    expect(data.blockedWorkCount).toBe(1);
  });

  it("GET /api/rigs/:id/graph 中未绑定节点的数据含 binding: null", async () => {
    const rig = repo.createRig("r01");
    repo.addNode(rig.id, "worker");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();
    const nodeData = body.nodes[0];
    expect(nodeData.data).toHaveProperty("binding");
    expect(nodeData.data.binding).toBeNull();
  });

  it("GET /api/rigs/:id/graph 中节点的 type 为 'rigNode'", async () => {
    const rig = repo.createRig("r01");
    repo.addNode(rig.id, "worker");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();
    expect(body.nodes[0].type).toBe("rigNode");
  });

  it("GET /api/rigs/:id/graph 的 RF identity：node.id 为不透明 PK，edge 使用 PK", async () => {
    const rig = repo.createRig("r01");
    const n1 = repo.addNode(rig.id, "a");
    const n2 = repo.addNode(rig.id, "b");
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();

    expect(body.nodes[0].id).toBe(n1.id);
    expect(body.nodes[1].id).toBe(n2.id);
    expect(body.edges[0].source).toBe(n1.id);
    expect(body.edges[0].target).toBe(n2.id);
  });

  it("GET /api/rigs/:id/graph 中没有 session 的节点 status 为 null", async () => {
    const rig = repo.createRig("r01");
    repo.addNode(rig.id, "worker");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    const body = await res.json();
    expect(body.nodes[0].data).toHaveProperty("status");
    expect(body.nodes[0].data.status).toBeNull();
  });

  it("GET /api/rigs/:id/graph 的 id 不存在时返回 404", async () => {
    const res = await app.request("/api/rigs/nonexistent/graph");
    expect(res.status).toBe(404);
  });

  // -- UX-T01b：Rig summary endpoint --

  it("GET /api/rigs/summary 返回带节点数量的 rig 列表", async () => {
    const rig1 = repo.createRig("alpha");
    repo.addNode(rig1.id, "orchestrator", { runtime: "claude-code" });
    repo.addNode(rig1.id, "worker", { runtime: "codex" });

    const rig2 = repo.createRig("beta");
    repo.addNode(rig2.id, "solo", { runtime: "claude-code" });

    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toHaveLength(2);
    const alpha = body.find((r: { name: string }) => r.name === "alpha");
    const beta = body.find((r: { name: string }) => r.name === "beta");
    expect(alpha.id).toBe(rig1.id);
    expect(alpha.nodeCount).toBe(2);
    expect(beta.id).toBe(rig2.id);
    expect(beta.nodeCount).toBe(1);
  });

  it("summary 将观察到的 agent presence 与 attention、idle work 和 infrastructure 分离", async () => {
    const add = (name: string, status: string | null, runtime = "codex", attention = false) => {
      const rig = repo.createRig(name);
      const node = repo.addNode(rig.id, "worker", { runtime });
      if (status !== null) {
        const session = sessionRegistry.registerSession(node.id, `worker@${name}`);
        sessionRegistry.updateStatus(session.id, status);
        if (attention) sessionRegistry.updateStartupStatus(session.id, "attention_required");
      }
    };
    add("live-degraded", "running", "codex", true);
    add("idle-prompt", "idle");
    add("stopped", "stopped");
    add("exited", "exited");
    add("unstarted", null);
    add("unknown", "unknown");
    add("infrastructure", "running", "terminal");
    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const rows = await res.json();
    const row = (name: string) => rows.find((r: { name: string }) => r.name === name);
    expect(row("live-degraded")).toMatchObject({ hasLiveAgents: true, lifecycleState: "attention_required" });
    expect(row("idle-prompt").hasLiveAgents).toBe(true);
    for (const name of ["stopped", "exited", "unstarted", "infrastructure"]) expect(row(name).hasLiveAgents, name).toBe(false);
    expect(row("unknown").hasLiveAgents).toBeNull();
  });

  it("GET /api/rigs/summary 包含持久化 rig services 元数据中的 hasServices", async () => {
    const rig1 = repo.createRig("svc-rig");
    repo.addNode(rig1.id, "worker", { runtime: "claude-code" });
    repo.setServicesRecord(rig1.id, {
      kind: "compose",
      specJson: JSON.stringify({ services: { kind: "compose", compose_file: "svc.compose.yaml" } }),
      rigRoot: "/tmp",
      composeFile: "svc.compose.yaml",
      projectName: "svc-rig",
      latestReceiptJson: null,
    });

    const rig2 = repo.createRig("plain-rig");
    repo.addNode(rig2.id, "worker", { runtime: "claude-code" });

    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    const svcRig = body.find((r: { name: string }) => r.name === "svc-rig");
    const plainRig = body.find((r: { name: string }) => r.name === "plain-rig");
    expect(svcRig.hasServices).toBe(true);
    expect(plainRig.hasServices).toBe(false);
  });

  it("GET /api/rigs/summary 面对多个显式时间戳 snapshot 时由最新者胜出", async () => {
    const rig = repo.createRig("gamma");
    repo.addNode(rig.id, "worker", { runtime: "codex" });

    // 插入带显式时间戳的 snapshot，证明最新者胜出。
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("snap-old", rig.id, "manual", "complete", "{}", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("snap-new", rig.id, "manual", "complete", "{}", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("snap-mid", rig.id, "manual", "complete", "{}", "2026-03-23 02:00:00");

    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    const gamma = body.find((r: { name: string }) => r.name === "gamma");
    expect(gamma.latestSnapshotId).toBe("snap-new");
    expect(gamma.latestSnapshotAt).toBe("2026-03-23 03:00:00");
  });

  it("GET /api/rigs/summary 没有 snapshot 时 latestSnapshotAt 和 latestSnapshotId 都为 null", async () => {
    const rig = repo.createRig("delta");
    repo.addNode(rig.id, "worker", { runtime: "codex" });

    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    const delta = body.find((r: { name: string }) => r.name === "delta");
    expect(delta).toBeDefined();
    expect(delta.latestSnapshotAt).toBeNull();
    expect(delta.latestSnapshotId).toBeNull();
  });

  it("GET /api/rigs/summary 对空 DB 返回空数组", async () => {
    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("GET /api/rigs/summary 返回数组结构而非 rig-by-id 结构（路由顺序护栏）", async () => {
    // 此测试证明 /summary 不会被 /:id 吞掉。若 /:id 先解析，"summary" 会被视为 rig ID，
    // 并返回 404 或 rig-by-id 对象，而非数组。
    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    // 必须是数组（summary 结构），而不是对象（rig-by-id 或 404 error 结构）。
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/rigs/summary 面对同秒 snapshot 时无重复 rig 行，并按 id 确定性决胜", async () => {
    const rig = repo.createRig("epsilon");
    repo.addNode(rig.id, "worker", { runtime: "codex" });

    // 两个 snapshot 的 created_at 相同，ULID "ZZZZ" 排在 "AAAA" 后。
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("AAAA_snap", rig.id, "manual", "complete", "{}", "2026-03-23 05:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("ZZZZ_snap", rig.id, "manual", "complete", "{}", "2026-03-23 05:00:00");

    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();

    // epsilon 必须恰好有一行（无重复）。
    const epsilons = body.filter((r: { name: string }) => r.name === "epsilon");
    expect(epsilons).toHaveLength(1);
    // ZZZZ 排在 AAAA 后，因此 ZZZZ_snap 应在决胜中胜出。
    expect(epsilons[0].latestSnapshotId).toBe("ZZZZ_snap");
  });

  // NS-T12：graph 路由返回带 inventory overlay 的增强数据。
  it("GET /api/rigs/:id/graph 返回带 startupStatus 和 podId 的增强节点数据", async () => {
    const rig = repo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-1", rig.id, "Dev");
    const node = repo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-1" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");

    const res = await app.request(`/api/rigs/${rig.id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // 查找增强节点（不是 group 节点）。
    const graphNode = body.nodes.find((n: any) => n.data?.logicalId === "dev.impl");
    expect(graphNode).toBeDefined();
    expect(graphNode.data.startupStatus).toBe("ready");
    expect(graphNode.data.podId).toBe("pod-1");
    expect(graphNode.data.canonicalSessionName).toBe("dev-impl@test-rig");
    expect(graphNode.data.restoreOutcome).toBe("n-a");
    expect(graphNode.data.rigId).toBeDefined();
    // pod 的 group 节点。
    const groupNode = body.nodes.find((n: any) => n.id === "pod-pod-1");
    expect(groupNode).toBeDefined();
    expect(groupNode.type).toBe("podGroup");
    expect(groupNode.data.podLabel).toBe("Dev");
  });

  // NS-T06：POST /api/rigs/:id/up——从 auto-pre-down snapshot 启动。
  it("不存在 auto-pre-down snapshot 时 POST /api/rigs/:id/up 返回 404", async () => {
    const rig = repo.createRig("no-snap-rig");
    const res = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("no_snapshot");
  });

  it("POST /api/rigs/:id/up 从持久当前状态捕获 auto-rehydrate snapshot", async () => {
    const rig = repo.createRig("rehydrate-rig");
    const node = repo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@rehydrate-rig");
    sessionRegistry.updateStatus(session.id, "stopped");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    insertStartupContextRow(db, node.id);

    const res = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restored");
    expect(body.snapshotKind).toBe("auto-rehydrate");
    expect(body.warnings).toContain("无可用恢复快照；已捕获当前 DB 状态作为 auto-rehydrate 快照用于重启恢复。");
    const autoRehydrate = db
      .prepare("SELECT kind FROM snapshots WHERE rig_id = ? AND kind = 'auto-rehydrate'")
      .get(rig.id) as { kind: string } | undefined;
    expect(autoRehydrate?.kind).toBe("auto-rehydrate");
  });

  it("POST /api/rigs/:id/up 包含 restore rollup 的 rigResult", async () => {
    const rig = repo.createRig("restore-rig");
    const node = repo.addNode(rig.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, "worker@restore-rig");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-restore", "relaunch_fresh", session.id);
    sessionRegistry.updateStatus(session.id, "running");
    snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    sessionRegistry.updateStatus(session.id, "exited");

    const res = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restored");
    expect(body.rigResult).toBe("partially_restored");
    expect(body.nodes[0].status).toBe("fresh-primed");
  });

  it("POST /api/rigs/:id/up 将验证 blocker 返回为 not_attempted", async () => {
    const rig = repo.createRig("restore-rig");
    const fixtureNode = repo.addNode(rig.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(fixtureNode.id, "worker@restore-rig");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-blocked", "relaunch_fresh", session.id);
    sessionRegistry.updateStatus(session.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    sessionRegistry.updateStatus(session.id, "exited");
    const data = JSON.parse(JSON.stringify(snap.data));
    const node = data.nodes[0];
    const missingPath = `/tmp/openrig-slice7-rigs-missing-${Date.now()}.md`;
    data.nodeStartupContext[node.id] = {
      projectionEntries: [],
      resolvedStartupFiles: [{
        path: "startup.md",
        absolutePath: missingPath,
        ownerRoot: "/tmp",
        deliveryHint: "guidance_merge",
        required: true,
        appliesOn: ["restore"],
      }],
      startupActions: [],
      runtime: "claude-code",
    };
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

    const res = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("not_attempted");
    expect(body.code).toBe("pre_restore_validation_failed");
    expect(body.rigResult).toBe("not_attempted");
    expect(body.blockers[0].path).toBe(missingPath);
  });

  it("POST /api/rigs/:id/up 对不存在的 rig 返回 404", async () => {
    const res = await app.request("/api/rigs/nonexistent/up", { method: "POST" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("未找到工作组");
  });

  // L3b：/:id/up 镜像 rig-name 路径：优先 auto-pre-down，回退到最新可用于恢复的 manual snapshot，
  // 并回显 `snapshotKind`。
  it("L3b：无 auto-pre-down 时 POST /api/rigs/:id/up 回退到 manual snapshot 并回显 snapshotKind", async () => {
    const rig = repo.createRig("manual-only-byid");
    repo.addNode(rig.id, "worker", { role: "worker" });
    snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restored");
    expect(body.snapshotKind).toBe("manual");
  });

  it("L3b：POST /api/rigs/:id/up 优先 auto-pre-down，而非更新的 manual snapshot", async () => {
    const rig = repo.createRig("auto-pref-byid");
    repo.addNode(rig.id, "worker", { role: "worker" });
    // 捕获顺序无关；helper 按 `(kind = 'auto-pre-down') DESC` 排序。
    snapshotCapture.captureSnapshot(rig.id, "manual");
    snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

    const res = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshotKind).toBe("auto-pre-down");
  });

  it("L3b：POST /api/rigs/:id/up 返回 404 及更新后的“无可用恢复 snapshot”消息", async () => {
    const rig = repo.createRig("no-usable-snap");

    const res = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("no_snapshot");
    expect(body.error).toContain("没有可用恢复快照");
    expect(body.error).not.toContain("auto-pre-down snapshot");
  });

  // OPR.0.3.4.9——方案 Y：通过 Explorer /:id/up 将 auto-periodic 与 auto-pre-down 等同。
  it("OPR.0.3.4.9 方案 Y：陈旧 auto-pre-down + 更新 auto-periodic 时通过 /:id/up 从后者恢复", async () => {
    const rig = repo.createRig("option-y-explorer");
    repo.addNode(rig.id, "worker", { role: "worker" });
    snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    await new Promise((r) => setTimeout(r, 10));
    snapshotCapture.captureSnapshot(rig.id, "auto-periodic");

    const res = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshotKind).toBe("auto-periodic");
  });

  // OPR.0.3.4.4——Explorer restore 路由独立于 /api/up（此前完全不解析 body），因此 plan:true 被
  // 静默忽略且路由总会修改状态。以下测试也固定此处的后台服务只读 gate。
  describe("OPR.0.3.4.4 --plan 只读 restore gate（Explorer /:id/up）", () => {
    it("plan:true 返回只读预览：不调用 restore()，session/snapshot 零修改", async () => {
      const rig = repo.createRig("explorer-plan-rig");
      const node = repo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const sess = sessionRegistry.registerSession(node.id, "worker@explorer-plan-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_name", "tok-1", "running", sess.id);
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      sessionRegistry.updateStatus(sess.id, "detached");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");
      const sessionsBefore = db.prepare("SELECT * FROM sessions ORDER BY id").all();
      const snapshotsBefore = db.prepare("SELECT * FROM snapshots ORDER BY id").all();
      const bindingsBefore = db.prepare("SELECT * FROM bindings ORDER BY id").all();

      const res = await app.request(`/api/rigs/${rig.id}/up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("plan");
      expect(body.mode).toBe("restore");
      expect(body.mutated).toBe(false);
      expect(body.nodes).toHaveLength(1);
      expect(body.nodes[0].intendedAction).toBe("resume-original");
      // 关键 gate：不发生任何形式的 restore 修改。
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(sessionsBefore);
      expect(db.prepare("SELECT * FROM snapshots ORDER BY id").all()).toEqual(snapshotsBefore);
      expect(db.prepare("SELECT * FROM bindings ORDER BY id").all()).toEqual(bindingsBefore);
    });

    it("plan:true 且无可用 snapshot 时报告 wouldCaptureCurrentState，但不捕获", async () => {
      const rig = repo.createRig("explorer-plan-rehydrate");
      const node = repo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@explorer-plan-rehydrate");
      sessionRegistry.updateStatus(session.id, "stopped");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      insertStartupContextRow(db, node.id);
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");

      const res = await app.request(`/api/rigs/${rig.id}/up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshot).toBeNull();
      expect(body.wouldCaptureCurrentState).toBe(true);
      const rows = db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE rig_id = ?").get(rig.id) as { c: number };
      expect(rows.c).toBe(0);
      expect(restoreSpy).not.toHaveBeenCalled();
    });

    it("APPLY 回归：body 不含 plan 时仍恢复；无 body 的 POST 保持不变", async () => {
      const rig = repo.createRig("explorer-apply-rig");
      repo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");

      const res = await app.request(`/api/rigs/${rig.id}/up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: false }),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("restored");
      expect(restoreSpy).toHaveBeenCalledTimes(1);
    });
  });
});
