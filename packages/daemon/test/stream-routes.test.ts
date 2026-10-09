import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { i3IdentityProvenanceSchema } from "../src/db/migrations/067_i3_identity_provenance.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { streamRoutes } from "../src/routes/stream.js";

function buildApp(opts: { eventBus: EventBus; streamStore: StreamStore }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("streamStore" as never, opts.streamStore);
    await next();
  });
  app.route("/api/stream", streamRoutes());
  return app;
}

describe("stream 路由", () => {
  let db: Database.Database;
  let bus: EventBus;
  let store: StreamStore;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      streamItemsSchema,
      // 067 的 4 条 ALTER 需要此数据库中存在基础表
      queueItemsSchema,
      queueTransitionsSchema,
      inboxEntriesSchema,
      outboxEntriesSchema,
      i3IdentityProvenanceSchema, // P21 §4 era-stamp column on stream_items (+ the other spine stores)
    ]);
    bus = new EventBus(db);
    store = new StreamStore(db, bus);
    app = buildApp({ eventBus: bus, streamStore: store });
  });

  afterEach(() => db.close());

  it("POST /api/stream/emit 创建并返回条目", async () => {
    const res = await app.request("/api/stream/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" }, // P21 I3: source from the transport header
      body: JSON.stringify({
        sourceSession: "alice@rig",
        body: "hello",
        hintDestination: "bob@rig",
        interrupt: true,
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { streamItemId: string; body: string; interrupt: boolean };
    expect(data.body).toBe("hello");
    expect(data.interrupt).toBe(true);
    expect(data.streamItemId).toMatch(/^[0-9A-Z]{26}$/);
  });

  it("POST /api/stream/emit 拒绝缺失正文（source 从 header 派生；缺少来源走 401 路径）", async () => {
    const res = await app.request("/api/stream/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "alice@rig" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/body/);
  });

  // P21 I3——stream emit 曾允许正文任意提供 sourceSession；I3 改为从 header 派生。
  it("emit——无 header + 正文 sourceSession → 以声明 actor 交付，stream_items 标记 claimed:v1", async () => {
    const res = await app.request("/api/stream/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "alice@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { streamItemId } = (await res.json()) as { streamItemId: string };
    const row = db
      .prepare("SELECT source_session, identity_provenance FROM stream_items WHERE stream_item_id = ?")
      .get(streamItemId) as { source_session: string; identity_provenance: string | null } | undefined;
    expect(row?.source_session).toBe("alice@rig");
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("emit——有 header + 正文 sourceSession 不同 → 线路值优先（来源 alice@rig、transport:v1）；409 已退役", async () => {
    const res = await app.request("/api/stream/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "evil@rig", body: "hi" }), // superseded by the wire identity
    });
    expect(res.status).toBe(201);
    const { streamItemId } = (await res.json()) as { streamItemId: string };
    const row = db
      .prepare("SELECT source_session, identity_provenance FROM stream_items WHERE stream_item_id = ?")
      .get(streamItemId) as { source_session: string; identity_provenance: string | null } | undefined;
    expect(row?.source_session).toBe("alice@rig");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("emit——从 header 派生来源，并为 stream_items 标记时代 transport:v1", async () => {
    const res = await app.request("/api/stream/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "alice@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { streamItemId } = (await res.json()) as { streamItemId: string };
    const row = db
      .prepare("SELECT source_session, identity_provenance FROM stream_items WHERE stream_item_id = ?")
      .get(streamItemId) as { source_session: string; identity_provenance: string | null } | undefined;
    expect(row?.source_session).toBe("alice@rig");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("GET /api/stream/list 按筛选条件返回时间正序条目", async () => {
    store.emit({ sourceSession: "alice@rig", body: "1", hintDestination: "bob@rig" });
    store.emit({ sourceSession: "carol@rig", body: "2", hintDestination: "bob@rig" });
    store.emit({ sourceSession: "alice@rig", body: "3" });

    const res = await app.request("/api/stream/list?sourceSession=alice@rig");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ body: string }>;
    expect(data).toHaveLength(2);
    expect(data.map((i) => i.body)).toEqual(["1", "3"]);

    const filtered = await app.request("/api/stream/list?hintDestination=bob@rig");
    const filteredData = (await filtered.json()) as Array<{ body: string }>;
    expect(filteredData).toHaveLength(2);
  });

  it("GET /api/stream/list?direction=latest 按时间正序返回最新活跃页", async () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      store.emit({ sourceSession: "alice@rig", body: `item-${index + 1}` }),
    );

    const first = await app.request("/api/stream/list?limit=5&direction=latest");
    expect(first.status).toBe(200);
    expect(((await first.json()) as Array<{ body: string }>).map((item) => item.body)).toEqual([
      "item-3", "item-4", "item-5", "item-6", "item-7",
    ]);

    store.archive(items[6]!.streamItemId);
    const afterArchive = await app.request("/api/stream/list?limit=5&direction=latest");
    expect(((await afterArchive.json()) as Array<{ body: string }>).map((item) => item.body)).toEqual([
      "item-2", "item-3", "item-4", "item-5", "item-6",
    ]);
  });

  it("GET /api/stream/list 拒绝无效或有歧义的 direction 输入", async () => {
    expect((await app.request("/api/stream/list?direction=sideways")).status).toBe(400);
    expect((await app.request("/api/stream/list?direction=latest&afterSortKey=k1")).status).toBe(400);
  });

  it("GET /api/stream/list 接入精确标签与标准化的包含边界 ISO 时间筛选", async () => {
    const lower = store.emit({ sourceSession: "alice@rig", body: "lower", hintTags: ["context"] });
    const upper = store.emit({ sourceSession: "alice@rig", body: "upper", hintTags: ["context"] });
    const wrongTag = store.emit({ sourceSession: "alice@rig", body: "wrong-tag", hintTags: ["context-extra"] });
    const wrongSource = store.emit({ sourceSession: "bob@rig", body: "wrong-source", hintTags: ["context"] });
    const outsideWindow = store.emit({ sourceSession: "alice@rig", body: "outside-window", hintTags: ["context"] });
    const setTime = db.prepare("UPDATE stream_items SET ts_emitted = ? WHERE stream_item_id = ?");
    setTime.run("2026-08-03T09:00:00.000Z", lower.streamItemId);
    setTime.run("2026-08-03T10:00:00.000Z", upper.streamItemId);
    setTime.run("2026-08-03T09:30:00.000Z", wrongTag.streamItemId);
    setTime.run("2026-08-03T09:45:00.000Z", wrongSource.streamItemId);
    setTime.run("2026-08-03T10:00:00.001Z", outsideWindow.streamItemId);

    const res = await app.request(
      "/api/stream/list?sourceSession=alice%40rig&hintTag=context&since=2026-08-03T11%3A00%3A00%2B02%3A00&until=2026-08-03T06%3A00%3A00-04%3A00",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Array<{ body: string }>).map((item) => item.body)).toEqual(["lower", "upper"]);
  });

  it("GET /api/stream/list 拒绝无效时间窗口", async () => {
    const invalidSince = await app.request("/api/stream/list?since=not-a-time");
    expect(invalidSince.status).toBe(400);
    expect(await invalidSince.json()).toEqual({ error: "since 必须是合法的 ISO 时间戳" });
    const invalidUntil = await app.request("/api/stream/list?until=not-a-time");
    expect(invalidUntil.status).toBe(400);
    expect(await invalidUntil.json()).toEqual({ error: "until 必须是合法的 ISO 时间戳" });
    const reversed = await app.request(
      "/api/stream/list?since=2026-08-03T10%3A00%3A00.000Z&until=2026-08-03T09%3A00%3A00.000Z",
    );
    expect(reversed.status).toBe(400);
    expect(await reversed.json()).toEqual({ error: "since 不能晚于 until" });
  });

  it.each([
    ["since", "2026-02-30T00:00:00Z"],
    ["until", "2026-01-01T24:00:00Z"],
  ])("GET /api/stream/list rejects impossible %s timestamp components", async (field, value) => {
    const res = await app.request(`/api/stream/list?${field}=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `${field} 必须是合法的 ISO 时间戳` });
  });

  it.each([
    "since",
    "until",
  ])("GET /api/stream/list rejects unsupported %s sub-millisecond precision", async (field) => {
    const res = await app.request(`/api/stream/list?${field}=2026-08-03T09%3A00%3A00.0009Z`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `${field} 最多只能用毫秒精度` });
  });

  it("GET /api/stream/:id 遇到未知 ID 时返回 404", async () => {
    const res = await app.request("/api/stream/nonexistent");
    expect(res.status).toBe(404);
  });

  it("POST /api/stream/:id/archive 成功归档，并从默认列表排除", async () => {
    const item = store.emit({ sourceSession: "alice@rig", body: "x" });
    const res = await app.request(`/api/stream/${item.streamItemId}/archive`, { method: "POST" });
    expect(res.status).toBe(200);
    const list = await app.request("/api/stream/list");
    const data = (await list.json()) as unknown[];
    expect(data).toHaveLength(0);
  });

  // ---- PL-004 阶段 A 修订（R1）：SSE 路由——实时 GET 到达处理器 ----
  // 根据 QA 发现：HEAD 比较不充分。动态路由遮蔽（/:streamItemId 将 `sse` 与 `watch`
  // 捕获为 ID）会返回 404 与“未找到 stream 项”，而不是进入 SSE 处理器。实时 GET
  // 断言 content-type: text/event-stream，可证明处理器已到达。

  it("GET /api/stream/sse 返回 200 与 content-type:text/event-stream（已到达处理器）", async () => {
    const res = await app.request("/api/stream/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("GET /api/stream/watch 返回 200 与 content-type:text/event-stream（已到达处理器）", async () => {
    const res = await app.request("/api/stream/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("GET /api/stream/sse 不返回 stream-item-not-found（路由顺序回归护栏）", async () => {
    const res = await app.request("/api/stream/sse");
    try {
      expect(res.status).not.toBe(404);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });
});
