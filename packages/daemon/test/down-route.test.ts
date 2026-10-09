import { describe, it, expect, vi } from "vitest";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { createApp } from "../src/server.js";

describe("POST /api/down 路由", () => {
  // R1：缺少 rigId -> 400
  it("缺少 rigId 时返回 400", async () => {
    const { app } = createTestApp(createFullTestDb());
    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/rigId/);
  });

  // R2：装备不存在 -> 404
  it("装备不存在时返回 404", async () => {
    const { app } = createTestApp(createFullTestDb());
    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: "nonexistent-rig" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/未找到/);
  });

  // R3：终止失败阻止 --delete -> 409
  it("终止失败阻止删除时返回 409", async () => {
    const tmux = mockTmuxAdapter();
    (tmux.killSession as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, message: "终止失败" });
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { tmux });

    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "n1");
    const session = sessionRegistry.registerSession(node.id, "r01-dev1");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, delete: true }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.deleteBlocked).toBe(true);
    expect(body.deleted).toBe(false);
  });

  // R4：同一数据库句柄不变量
  it("teardownOrchestrator 使用不同数据库时抛错", () => {
    const db1 = createFullTestDb();
    const { app: _ignore, ...testApp1 } = createTestApp(db1);

    // 在独立数据库上构建有效的 RigTeardownOrchestrator
    const db2 = createFullTestDb();
    const { teardownOrchestrator: foreignTeardown } = createTestApp(db2);

    expect(() => {
      createApp({
        ...testApp1,
        teardownOrchestrator: foreignTeardown,
      });
    }).toThrow(/teardownOrchestrator 必须共享同一个数据库句柄/);
  });

  // R5：内部删除失败 -> 500（经路由 catch，而非 TeardownResult）
  it("内部删除失败时返回 500（不是 409）", async () => {
    const tmux = mockTmuxAdapter();
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { tmux });

    const rig = rigRepo.createRig("test-rig-2");
    const node = rigRepo.addNode(rig.id, "n1");
    const session = sessionRegistry.registerSession(node.id, "r01-dev1");
    sessionRegistry.updateStatus(session.id, "running");

    // 终止成功，但 deleteRig 抛错（atomicDelete 期间的内部失败）
    const origDelete = rigRepo.deleteRig.bind(rigRepo);
    rigRepo.deleteRig = () => { throw new Error("磁盘已满"); };

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, delete: true }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    // 编排器在内部捕获时，路由返回 TeardownResult；但此路径经非 alreadyStopped
    // 分支的 try-catch 传播
    expect(body.deleted).toBe(false);
    expect(body.deleteBlocked).toBe(false);

    rigRepo.deleteRig = origDelete;
  });

  // R6：--delete + 快照失败 + 删除成功 -> 200
  it("尽管有快照警告，删除成功时仍返回 200", async () => {
    const tmux = mockTmuxAdapter();
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry, snapshotCapture } = createTestApp(db, { tmux });

    const rig = rigRepo.createRig("test-rig-3");
    const node = rigRepo.addNode(rig.id, "n1");
    const session = sessionRegistry.registerSession(node.id, "r01-dev1");
    sessionRegistry.updateStatus(session.id, "running");

    // 破坏快照流程以产生错误
    const origCapture = snapshotCapture.captureSnapshot.bind(snapshotCapture);
    snapshotCapture.captureSnapshot = () => { throw new Error("快照磁盘已满"); };

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, delete: true, snapshot: true }),
    });
    // 快照失败 → errors[]，但删除仍成功 → 200
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);

    snapshotCapture.captureSnapshot = origCapture;
  });

  // NS-T06：down 时自动创建快照
  it("拆除前自动创建快照（auto-pre-down）", async () => {
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("auto-snap-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // 应已创建自动快照
    expect(body.snapshotId).toBeTruthy();
    // 验证快照类型
    const snap = db.prepare("SELECT kind FROM snapshots WHERE id = ?").get(body.snapshotId) as { kind: string } | undefined;
    expect(snap?.kind).toBe("auto-pre-down");
    db.close();
  });

  // NS-T06：down 响应包含用于命令后交接的装备名称
  it("响应包含用于命令后交接的 rigName", async () => {
    const db = createFullTestDb();
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("handoff-test");
    const node = rigRepo.addNode(rig.id, "impl");
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id }),
    });
    const body = await res.json();
    expect(body.rigName).toBe("handoff-test");
    db.close();
  });
});
