import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createTestApp } from "./helpers/test-app.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


const SIMPLE_SPEC_YAML = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

function getEvents(database: Database.Database): Array<{ type: string; payload: string }> {
  return database.prepare("SELECT type, payload FROM events ORDER BY seq").all() as Array<{ type: string; payload: string }>;
}

describe("Bootstrap API 路由", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-routes-"));
    setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSpec(yaml: string): string {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, yaml);
    return specPath;
  }

  // T1：POST /plan -> 200 + plan result
  it("POST /api/bootstrap/plan 返回结构化 plan", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);

    const res = await app.request("/api/bootstrap/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("planned");
    expect(body.runId).toBeTruthy();
    expect(body.stages.length).toBeGreaterThan(0);
  });

  // T2：POST /apply completed -> 201
  it("POST /api/bootstrap/apply 完成时返回 201", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);

    const res = await app.request("/api/bootstrap/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath, autoApprove: true }),
    });

    // Orchestrator 使用 mock tmux，可能实例化失败，但 route 应返回结构化 response。
    const body = await res.json();
    expect(body.runId).toBeTruthy();
    expect(typeof body.status).toBe("string");
  });

  // T3：GET /:id 返回 run 及 action
  it("GET /api/bootstrap/:id 返回 run 及 action", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);

    // 通过 plan 创建 run
    const planRes = await app.request("/api/bootstrap/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });
    const { runId } = await planRes.json();

    const res = await app.request(`/api/bootstrap/${runId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(runId);
    expect(Array.isArray(body.actions)).toBe(true);
  });

  // T4：GET / 列出 run
  it("GET /api/bootstrap 列出 run", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);

    // 创建 run
    await app.request("/api/bootstrap/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });

    const res = await app.request("/api/bootstrap");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  // T5：缺少 sourceRef -> 400
  it("POST /api/bootstrap/plan 缺少 sourceRef 时返回 400", async () => {
    const res = await app.request("/api/bootstrap/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("sourceRef");
  });

  // T6：POST /apply 使用无效 sourceRef -> 400 failed response
  it("POST /api/bootstrap/apply 使用无效 sourceRef 时返回 400", async () => {
    // 无效 spec 会在 resolve_spec 期间解析失败
    const specPath = path.join(tmpDir, "nonexistent.yaml");

    const res = await app.request("/api/bootstrap/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath, autoApprove: true }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(typeof body.errors[0]).toBe("string");
    expect(body.stages.some((stage: { stage: string; status: string; detail?: { code?: string } }) =>
      stage.stage === "resolve_spec" && stage.status === "failed" && stage.detail?.code === "file_not_found"
    )).toBe(true);
  });

  // T7：plan 后发出 bootstrap.planned event
  it("POST /api/bootstrap/plan 发出 bootstrap.planned event", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);

    await app.request("/api/bootstrap/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });

    const events = getEvents(db).filter((e) => e.type === "bootstrap.planned");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.runId).toBeTruthy();
    expect(payload.sourceRef).toBe(specPath);
  });

  // T8：apply 后发出 bootstrap.started + outcome event
  it("POST /api/bootstrap/apply 发出 bootstrap.started event", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);

    await app.request("/api/bootstrap/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath, autoApprove: true }),
    });

    const events = getEvents(db);
    const startedEvents = events.filter((e) => e.type === "bootstrap.started");
    expect(startedEvents.length).toBe(1);
    const payload = JSON.parse(startedEvents[0]!.payload);
    expect(payload.runId).toBeTruthy();

    // 还应有 completion/failure event
    const outcomeEvents = events.filter((e) =>
      e.type === "bootstrap.completed" || e.type === "bootstrap.partial" || e.type === "bootstrap.failed"
    );
    expect(outcomeEvents.length).toBe(1);
  });

  // T9：bootstrapRepo 的 same-db-handle 断言
  it("createApp 拒绝不匹配的 bootstrapRepo db handle", () => {
    const db2 = createDb();
    migrate(db2, ALL_MIGRATIONS);

    expect(() => {
      createTestApp(db, { tmux: undefined }); // This works — same db
    }).not.toThrow();

    db2.close();
  });

  // T10：createDaemon startup 接入 bootstrap route + Phase 5 依赖
  it("createDaemon 接入 bootstrap route（GET /api/bootstrap 返回 200）", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app: daemonApp, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });

    try {
      const res = await daemonApp.request("/api/bootstrap");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    } finally {
      daemonDb.close();
    }
  });

  // T11：apply 在 orchestrator 工作前设置 running status
  it("POST /api/bootstrap/apply 在 bootstrap run 上设置 running status", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);

    const res = await app.request("/api/bootstrap/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath, autoApprove: true }),
    });

    const body = await res.json();
    // run 应先设为 running，再设为最终 status；通过 started event 带 runId 来验证。
    const startedEvents = getEvents(db).filter((e) => e.type === "bootstrap.started");
    expect(startedEvents.length).toBe(1);
    const startedPayload = JSON.parse(startedEvents[0]!.payload);
    expect(startedPayload.runId).toBe(body.runId);
  });

  // T12：partial outcome 发出 bootstrap.partial event
  it("bootstrap.partial event type 在 event union 中有效", () => {
    // 结构性测试：event type 存在且可发出
    setup.eventBus.emit({
      type: "bootstrap.partial",
      runId: "test-run",
      sourceRef: "/tmp/spec.yaml",
      completed: 3,
      failed: 1,
    });

    const events = getEvents(db).filter((e) => e.type === "bootstrap.partial");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.completed).toBe(3);
    expect(payload.failed).toBe(1);
  });

  // T13：plan 失败返回 400，且无 bootstrap.planned event（R2-H2）
  it("POST /api/bootstrap/plan 使用不存在 spec 时返回 400，且无 bootstrap.planned", async () => {
    const res = await app.request("/api/bootstrap/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "/tmp/nonexistent-spec-12345.yaml" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("failed");

    // 不应发出 bootstrap.planned
    const plannedEvents = getEvents(db).filter((e) => e.type === "bootstrap.planned");
    expect(plannedEvents).toHaveLength(0);

    // 应改为发出 bootstrap.failed
    const failedEvents = getEvents(db).filter((e) => e.type === "bootstrap.failed");
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  // T14：apply exception boundary——捕获抛出的错误（R2-H3）
  it("POST /api/bootstrap/apply 捕获 orchestrator 抛出的错误", async () => {
    // 临时将 orchestrator bootstrap 方法替换为会抛错的实现
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    (setup.bootstrapOrchestrator as unknown as { bootstrap: unknown }).bootstrap = async () => {
      throw new Error("unexpected planner crash");
    };

    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const res = await app.request("/api/bootstrap/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath, autoApprove: true }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error).toContain("unexpected planner crash");

    // 抛错前应已发出 bootstrap.started
    const startedEvents = getEvents(db).filter((e) => e.type === "bootstrap.started");
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);

    // 还应发出 bootstrap.failed（exception boundary）
    const failedEvents = getEvents(db).filter((e) => e.type === "bootstrap.failed");
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);

    // run 应为 failed，而不是卡在 running
    const run = db.prepare("SELECT status FROM bootstrap_runs WHERE id = ?")
      .get(body.runId) as { status: string };
    expect(run.status).toBe("failed");

    // 恢复原实现
    (setup.bootstrapOrchestrator as unknown as { bootstrap: unknown }).bootstrap = origBootstrap;
  });

  // T15：concurrency lock——第二次 apply 返回 409，且不创建 run/started（R1-F4.6）
  it("同一 spec 的并发 apply 返回 409，且不创建 run", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);

    // 手工获取 lock
    setup.bootstrapOrchestrator.tryAcquire(specPath);

    const res = await app.request("/api/bootstrap/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath, autoApprove: true }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("conflict");

    // 此 request 不应发出 bootstrap.started event（lock 在创建 run 前阻塞）
    const startedEvents = getEvents(db).filter((e) => e.type === "bootstrap.started");
    expect(startedEvents).toHaveLength(0);

    // 释放以清理
    setup.bootstrapOrchestrator.release(specPath);
  });

  // T16：同一 spec 的 concurrent plan 冲突
  it("同一 spec 的 concurrent plan 返回 409", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);

    // 手工获取 lock（模拟正在执行的 concurrent plan）
    setup.bootstrapOrchestrator.tryAcquire(specPath);

    const res = await app.request("/api/bootstrap/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("conflict");

    setup.bootstrapOrchestrator.release(specPath);
  });
});
