import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { wireViewEventBridge } from "../src/domain/view-event-bridge.js";
import { viewsRoutes } from "../src/routes/views.js";

function buildApp(opts: {
  eventBus: EventBus;
  projector: ViewProjector;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("viewProjector" as never, opts.projector);
    await next();
  });
  app.route("/api/views", viewsRoutes());
  return app;
}

describe("views 路由（PL-004 阶段 B）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let projector: ViewProjector;
  let app: Hono;

  beforeEach(async () => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, viewsCustomSchema]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    projector = new ViewProjector(db, bus);
    app = buildApp({ eventBus: bus, projector });
    // 预置若干 qitem，使 view 有可投影内容。
    await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "planning@product-lab",
      body: "x",
      nudge: false,
    });
    await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "delivery@product-lab",
      body: "y",
      nudge: false,
    });
  });

  afterEach(() => db.close());

  it("GET /api/views/list 返回内置与自定义 view 名称", async () => {
    const res = await app.request("/api/views/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builtIn: string[]; custom: unknown[] };
    expect(body.builtIn).toContain("recently-active");
    expect(body.builtIn).toContain("founder");
    expect(body.builtIn).toContain("pod-load");
    expect(body.builtIn).toContain("escalations");
    expect(body.builtIn).toContain("held");
    expect(body.builtIn).toContain("activity");
    expect(body.custom).toHaveLength(0);
  });

  it("GET /api/views/recently-active 返回 rows、viewName 与 generatedAt", async () => {
    const res = await app.request("/api/views/recently-active");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewName: string; rowCount: number; rows: unknown[]; generatedAt: string };
    expect(body.viewName).toBe("recently-active");
    expect(body.rowCount).toBe(2);
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("GET /api/views/<unknown-view> 返回 404 view_not_found", async () => {
    const res = await app.request("/api/views/nonexistent-view");
    expect(res.status).toBe(404);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe("view_not_found");
  });

  it("GET /api/views/recently-active?limit=1 遵循 limit 查询参数", async () => {
    const res = await app.request("/api/views/recently-active?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rowCount: number };
    expect(body.rowCount).toBe(1);
  });

  it("POST /api/views/custom/register 注册自定义 view；可按名称查询", async () => {
    const reg = await app.request("/api/views/custom/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        viewName: "all-pending",
        definition: "SELECT qitem_id FROM queue_items WHERE state = 'pending'",
        registeredBySession: "operator@rig",
      }),
    });
    expect(reg.status).toBe(201);
    const res = await app.request("/api/views/all-pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewName: string; rowCount: number };
    expect(body.viewName).toBe("all-pending");
    expect(body.rowCount).toBeGreaterThan(0);
  });

  it("POST /api/views/custom/register 使用保留名称时返回 409 view_name_reserved", async () => {
    const res = await app.request("/api/views/custom/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        viewName: "recently-active",
        definition: "SELECT 1",
        registeredBySession: "operator@rig",
      }),
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe("view_name_reserved");
  });

  it("R1 SSE 模式：GET /api/views/sse 返回 200 与 content-type text/event-stream", async () => {
    const res = await app.request("/api/views/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：GET /api/views/recently-active/sse 返回 200 与 content-type text/event-stream", async () => {
    const res = await app.request("/api/views/recently-active/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：GET /api/views/sse 不返回 view_not_found（路由顺序回归保护）", async () => {
    const res = await app.request("/api/views/sse");
    try {
      expect(res.status).not.toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });

  // ---- queue 变化时，SSE consumer 观测到 view.changed ----
  // 路由级测试：改变 queue 状态并观测 view.changed event。测试中接入 view-event-bridge，
  // 以覆盖生产代码路径。
  it("R1 阻塞项 2：queue 变化触发 SSE consumer 可见的 view.changed", async () => {
    // 接入 bridge，使 queue.created → view.changed 经由 SSE handler 订阅的 event-bus 流动。
    wireViewEventBridge(bus, projector);

    // 订阅 SSE stream 并持续读取，直至看到 queue.created 导致的 recently-active view.changed 行，
    // 或在短暂超时后退出。
    const sseResPromise = app.request("/api/views/recently-active/sse");

    // 并行改变 queue 状态：创建新 qitem。
    await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "trigger view.changed",
      nudge: false,
    });

    const res = await sseResPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    // 最多读取约 1.5 秒 SSE body，寻找 view.changed event。
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 1500;
    let observed = false;
    try {
      while (Date.now() < deadline && !observed) {
        const readP = reader.read();
        const tickP = new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 200),
        );
        const { done, value } = (await Promise.race([readP, tickP])) as { done: boolean; value?: Uint8Array };
        if (!done && value) buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('"type":"view.changed"') && buffer.includes('"viewName":"recently-active"')) {
          observed = true;
          break;
        }
        // 若尚未看到 event，则再次触发变化——第一次可能早于 SSE handler 完成订阅。
        if (Date.now() < deadline && !observed) {
          await queueRepo.create({
            sourceSession: "alice@rig",
            destinationSession: "bob@rig",
            body: `nudge-${Date.now()}`,
            nudge: false,
          });
        }
      }
    } finally {
      // 通过 reader 取消，以干净释放 stream lock。
      await reader.cancel().catch(() => {});
    }

    expect(observed).toBe(true);
  });

  // ---- queue.updated 触发 SSE consumer 可见的 view.changed ----
  // pending → blocked / in-progress → done / 关闭 / 升级
  // 经 QueueRepository.update() 执行的转换必须发出 queue.updated → view.changed。否则正常状态变化
  // 永远无法唤醒 /api/views/:name/sse 上的 SSE consumer。
  it("R2 阻塞项：queue.update 变化触发 SSE consumer 可见的 view.changed（cause=queue.updated）", async () => {
    wireViewEventBridge(bus, projector);

    // 预先创建并领取 qitem，以便执行 update 路径。
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "pre-existing for update",
      nudge: false,
    });
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });

    // 先订阅 view SSE，以免错过 event。
    const sseResPromise = app.request("/api/views/recently-active/sse");

    // 通过通用状态 mutator 执行更新（in-progress → done）。
    queueRepo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
    });

    const res = await sseResPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 1500;
    let observed = false;
    try {
      while (Date.now() < deadline && !observed) {
        const readP = reader.read();
        const tickP = new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 200),
        );
        const { done, value } = (await Promise.race([readP, tickP])) as { done: boolean; value?: Uint8Array };
        if (!done && value) buffer += decoder.decode(value, { stream: true });
        if (
          buffer.includes('"type":"view.changed"') &&
          buffer.includes('"viewName":"recently-active"') &&
          buffer.includes('"cause":"queue.updated"')
        ) {
          observed = true;
          break;
        }
        if (Date.now() < deadline && !observed) {
          const item2 = await queueRepo.create({
            sourceSession: "alice@rig",
            destinationSession: "bob@rig",
            body: `nudge-${Date.now()}`,
            nudge: false,
          });
          queueRepo.update({
            qitemId: item2.qitemId,
            actorSession: "bob@rig",
            state: "blocked",
            transitionNote: "nudge",
          });
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    expect(observed).toBe(true);
  });
});
