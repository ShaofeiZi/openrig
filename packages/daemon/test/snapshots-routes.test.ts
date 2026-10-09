import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { createDaemon } from "../src/startup.js";
import type { ExecFn } from "../src/adapters/tmux.js";

describe("快照 route", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let snapshotCapture: SnapshotCapture;
  let snapshotRepo: SnapshotRepository;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    snapshotCapture = setup.snapshotCapture;
    snapshotRepo = setup.snapshotRepo;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/rigs/:rigId/snapshots → 201，并返回含 id 与 kind 的快照", async () => {
    const rig = rigRepo.createRig("r99");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.kind).toBe("manual");
    expect(body.rigId).toBe(rig.id);
  });

  it("POST snapshot 把显式 intended-seat 名册解析为持久 node ID", async () => {
    const rig = rigRepo.createRig("r99");
    const lead = rigRepo.addNode(rig.id, "dev.lead", { role: "lead" });
    rigRepo.addNode(rig.id, "dev.historical", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual", intendedSeats: ["dev.lead"] }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.topologyRoster).toEqual({
      version: 1,
      source: "operator_explicit",
      intendedNodeIds: [lead.id],
    });
  });

  it("POST snapshot 拒绝格式错误或为空的显式 intended-seat 名册", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "dev.lead", { role: "lead" });

    for (const intendedSeats of [[], ["dev.lead", 42], [" "], "dev.lead", ["dev.lead", "dev.lead"]]) {
      const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "manual", intendedSeats }),
      });
      expect(res.status).toBe(400);
    }
    expect(snapshotRepo.listSnapshots(rig.id)).toHaveLength(0);
  });

  it("GET /api/rigs/:rigId/snapshots → 快照列表", async () => {
    const rig = rigRepo.createRig("r99");
    snapshotCapture.captureSnapshot(rig.id, "manual");
    snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it("GET /api/rigs/:rigId/snapshots/:id → 含已解析数据的快照", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots/${snap.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(snap.id);
    expect(body.data.rig.name).toBe("r99");
    expect(body.data.nodes).toHaveLength(1);
  });

  it("POST /api/rigs/nonexistent/snapshots → 404", async () => {
    const res = await app.request("/api/rigs/nonexistent-rig/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST 遇到包含 'not found' 的非工作组错误时返回 500，不误判为 404", async () => {
    const rig = rigRepo.createRig("r99");

    // 注入包含 'not found' 的错误消息，不得匹配为 404。
    db.exec("CREATE TRIGGER block_snap_notfound BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'index not found in cache'); END;");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(res.status).toBe(500);

    db.exec("DROP TRIGGER block_snap_notfound");
  });

  it("POST snapshot 遇到被注入故障的数据库时返回 500，而非 404", async () => {
    const rig = rigRepo.createRig("r99");

    // 向 snapshots 表注入故障，使创建以非 not-found 错误失败。
    db.exec("CREATE TRIGGER block_snap_create BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'db error'); END;");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(res.status).toBe(500);

    db.exec("DROP TRIGGER block_snap_create");
  });

  it("GET 不存在的 snapshot → 404", async () => {
    const rig = rigRepo.createRig("r99");
    const res = await app.request(`/api/rigs/${rig.id}/snapshots/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("GET 其他工作组的 snapshot → 404", async () => {
    const rigA = rigRepo.createRig("r99");
    const rigB = rigRepo.createRig("r98");
    const snap = snapshotCapture.captureSnapshot(rigA.id, "manual");

    // snapshot 属于 rigA，却从 rigB 下请求。
    const res = await app.request(`/api/rigs/${rigB.id}/snapshots/${snap.id}`);
    expect(res.status).toBe(404);
  });
});

describe("恢复 route", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotCapture = setup.snapshotCapture;
  });

  afterEach(() => {
    db.close();
  });

  // L3：发出 restore.started 后，route 立即返回 202 + attemptId。逐节点恢复工作在后台运行，
  // 客户端通过 event log / node inventory 查询后续状态。
  it("POST /api/rigs/:rigId/restore/:snapshotId → 202 + attemptId（L3）", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("started");
    expect(body.rigId).toBe(rig.id);
    expect(typeof body.attemptId).toBe("number");
    expect(body.attemptId).toBeGreaterThan(0);

    // attemptId 必须与可查询的 restore.started 事件 seq 一致。
    const startedEvent = db
      .prepare("SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.started' ORDER BY seq DESC LIMIT 1")
      .get(rig.id) as { seq: number } | undefined;
    expect(startedEvent?.seq).toBe(body.attemptId);
  });

  it("GET restore status 根据仅追加事件派生已完成的尝试回执", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    const started = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    const { attemptId } = await started.json() as { attemptId: number };

    let status: Response | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      status = await app.request(`/api/rigs/${rig.id}/restore/status/${attemptId}`);
      if (status.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(status?.status).toBe(200);
    const body = await status!.json();
    expect(body).toMatchObject({
      ok: true,
      attemptId,
      snapshotSelection: { snapshotId: snap.id, mode: "explicit" },
      originalResult: { snapshotId: snap.id },
    });
    expect(body.currentIntendedSetVerdict).toBeDefined();
  });

  it("恢复前验证阻塞时 POST restore 返回 409 not_attempted", async () => {
    const rig = rigRepo.createRig("r99");
    const fixtureNode = rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(fixtureNode.id, "r99-worker");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-blocked", "relaunch_fresh", session.id);
    sessionRegistry.updateStatus(session.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    sessionRegistry.updateStatus(session.id, "exited");
    const data = JSON.parse(JSON.stringify(snap.data));
    const node = data.nodes[0];
    const missingPath = `/tmp/openrig-slice7-snapshot-missing-${Date.now()}.md`;
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

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("pre_restore_validation_failed");
    expect(body.rigResult).toBe("not_attempted");
    expect(body.preRestoreSnapshotId).toBeNull();
    expect(body.nodes).toEqual([]);
    expect(body.blockers[0]).toMatchObject({
      code: "required_startup_file_missing",
      severity: "critical",
      logicalId: "worker",
      path: missingPath,
    });
    expect(body.remediation[0]).toContain("恢复缺失的启动文件");
  });

  it("POST restore 在启动前拒绝显式选择的不可用快照", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    const data = JSON.parse(JSON.stringify(snap.data));
    delete data.edges;
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);
    const beforeEvents = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "snapshot_unusable" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(beforeEvents.n);
  });

  it("POST 不存在的 snapshot → 404", async () => {
    const rig = rigRepo.createRig("r99");
    const res = await app.request(`/api/rigs/${rig.id}/restore/nonexistent`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST 跨工作组 restore → 404，且不执行恢复", async () => {
    const rigA = rigRepo.createRig("r99");
    const rigB = rigRepo.createRig("r98");
    rigRepo.addNode(rigA.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rigA.id, "manual");

    const res = await app.request(`/api/rigs/${rigB.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST restore 时快照对应工作组不存在 → 404", async () => {
    const rig = rigRepo.createRig("r99");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    // 删除工作组，使 restore 能找到快照但找不到工作组。
    rigRepo.deleteRig(rig.id);

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST restore_error → 500", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    // 通过阻止新插入的 trigger 向 snapshots 表注入故障（恢复前快照捕获会失败并触发
    // restore_error）；保留已有行，使原始快照仍可找到。
    db.exec(`
      CREATE TRIGGER block_snapshot_insert BEFORE INSERT ON snapshots
      BEGIN
        SELECT RAISE(ABORT, 'sabotaged: no new snapshots');
      END;
    `);

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(500);
  });

  it("POST 恢复仍有 live tmux session 的运行中工作组 → 409", async () => {
    // 使用 hasSession=true 的自定义 app 模拟真正存活的 tmux。
    const db2 = createFullTestDb();
    const tmux = mockTmuxAdapter();
    (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const setup = createTestApp(db2, { tmux });

    const rig = setup.rigRepo.createRig("r99");
    const node = setup.rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = setup.sessionRegistry.registerSession(node.id, "r99-worker");
    setup.sessionRegistry.updateStatus(session.id, "running");
    const snap = setup.snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await setup.app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("rig_not_stopped");
    db2.close();
  });

  // L3：逐节点详情不再出现在 route 的即时响应中。验证 route 返回新形状；逐节点状态由
  // restore-orchestrator 测试直接覆盖。
  it("restore 响应为异步形态：202 + attemptId，不含逐节点 body", async () => {
    const rig = rigRepo.createRig("r99");
    rigRepo.addNode(rig.id, "worker-a", { role: "worker" });
    rigRepo.addNode(rig.id, "worker-b", { role: "worker" });
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("started");
    expect(typeof body.attemptId).toBe("number");
    // 即时响应有意不包含 nodes/rigResult；逐节点工作在后台运行。
    expect(body.nodes).toBeUndefined();
    expect(body.rigResult).toBeUndefined();
  });
});

describe("恢复并发", () => {
  it("已有 restore 进行中时再次 restore → 409 Conflict", async () => {
    const db2 = createFullTestDb();
    // 使用延迟 createSession 的自定义 tmux mock。
    const { vi: vitest } = await import("vitest");
    const setup = createTestApp(db2);
    const rig = setup.rigRepo.createRig("r99");
    setup.rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const snap = setup.snapshotCapture.captureSnapshot(rig.id, "manual");

    // 两个请求并发到达，其中一个应得到 409。
    const [res1, res2] = await Promise.all([
      setup.app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" }),
      setup.app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toContain(409);

    db2.close();
  });
});

describe("恢复响应契约", () => {
  // L3：逐节点状态不再出现在 route 即时响应中（route 返回 202 + attemptId）。逐节点行为由
  // restore-orchestrator 测试直接验证。本测试确认即使节点存在 checkpoint（此前会得到
  // `rebuilt`），异步契约仍成立。
  it("节点存在 checkpoint 时 restore 仍返回 202 + attemptId（L3 异步契约）", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const db2 = createFullTestDb();
    const setup = createTestApp(db2);

    const rig = setup.rigRepo.createRig("r99");
    setup.rigRepo.addNode(rig.id, "worker", { role: "worker", cwd: tmpDir });
    setup.checkpointStore.createCheckpoint(
      setup.rigRepo.getRig(rig.id)!.nodes[0]!.id,
      { summary: "test checkpoint", keyArtifacts: [] }
    );
    const snap = setup.snapshotCapture.captureSnapshot(rig.id, "manual");

    const res = await setup.app.request(`/api/rigs/${rig.id}/restore/${snap.id}`, { method: "POST" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.attemptId).toBe("number");

    db2.close();
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe("启动挂载回归", () => {
  it("createDaemon app：POST snapshot 返回 201", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { app, db, deps } = await createDaemon({ tmuxExec, cmuxExec });
    const rig = deps.rigRepo.createRig("r99");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "manual" }),
    });
    expect(res.status).toBe(201);
    db.close();
  });

  it("createDaemon app：GET snapshots 返回 200", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { app, db, deps } = await createDaemon({ tmuxExec, cmuxExec });
    const rig = deps.rigRepo.createRig("r99");

    const res = await app.request(`/api/rigs/${rig.id}/snapshots`);
    expect(res.status).toBe(200);
    db.close();
  });

  it("createDaemon app：POST restore route 返回有效响应", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { app, db, deps } = await createDaemon({ tmuxExec, cmuxExec });
    const rig = deps.rigRepo.createRig("r99");

    // 不存在的 snapshot → 404，证明 route 已挂载且会处理请求。
    const res = await app.request(`/api/rigs/${rig.id}/restore/nonexistent`, { method: "POST" });
    expect(res.status).toBe(404);
    db.close();
  });
});
