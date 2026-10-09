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
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { i3IdentityProvenanceSchema } from "../src/db/migrations/067_i3_identity_provenance.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { queueRoutes } from "../src/routes/queue.js";

// ── P18 扫描——来源洗白的红灯测试（dev50-driver 已封存的发现）。
//
// 删除 requireSenderIdentity 的拒绝逻辑会制造一条此前不存在的无请求头投递路径：调用方没有
// X-OpenRig-Session，却可以用正文声明的执行者身份完成投递，并标记为 `claimed:v1`。若路由位置
// 硬编码 `identityProvenance: "transport:v1"`，就会把仅由正文声明的记录错误盖章为线路认证。
// 这会把未验证来源洗白为已验证来源，违反 resolveRecordedProvenance 自身的契约。缺陷存在时
// tsc 仍为 0，所有携带请求头的测试也都会通过；只有此路径能暴露问题。修复要求各调用点传递
// resolveRecordedProvenance(c, identity)。
function buildApp(opts: {
  eventBus: EventBus;
  queueRepo: QueueRepository;
  inboxHandler: InboxHandler;
  outboxHandler: OutboxHandler;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("queueRepo" as never, opts.queueRepo);
    c.set("inboxHandler" as never, opts.inboxHandler);
    c.set("outboxHandler" as never, opts.outboxHandler);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return app;
}

describe("P18 来源链路——缺少请求头的投递不得将 claimed:v1 洗白为 transport:v1", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let inbox: InboxHandler;
  let outbox: OutboxHandler;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      streamItemsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      inboxEntriesSchema,
      outboxEntriesSchema,
      queueTargetRepoSchema,
      i3IdentityProvenanceSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    outbox = new OutboxHandler(db);
    queueRepo.attachOutbox(outbox);
    app = buildApp({ eventBus: bus, queueRepo, inboxHandler: inbox, outboxHandler: outbox });
  });

  afterEach(() => db.close());

  // outbox_entries 表——发件箱记录（queue.ts:1021）。
  it("发件箱记录：缺少请求头且正文含 senderSession 时可投递，并记录 claimed:v1（而非 transport:v1）", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // 不含 X-OpenRig-Session——用于覆盖被制造出的路径
      body: JSON.stringify({ senderSession: "claimant@rig", destinationSession: "dest@rig", body: "hi" }),
    });
    expect(res.status).toBe(201); // 投递并标注来源，而不是拒绝
    const { outboxId } = (await res.json()) as { outboxId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  // 阳性对照——携带请求头的路径逐字节不变（仍为 transport:v1）。
  it("发件箱记录：携带请求头时记录 transport:v1（认证路径不变）", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "me@rig" },
      body: JSON.stringify({ destinationSession: "dest@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { outboxId } = (await res.json()) as { outboxId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it.each([{ "x-openrig-origin-unknown": "true" }, { "x-openrig-relay": "true", "x-openrig-provenance": "origin-unknown:v1" }])("队列创建在直接和中继投递中持久保留未知来源：%j", async (relayHeaders) => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "me@rig", ...relayHeaders },
      body: JSON.stringify({ destinationSession: "dest@rig", body: "origin unavailable" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = await res.json() as { qitemId: string };
    expect(db.prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?").get(qitemId)).toEqual({ source_session: "me@rig" });
    expect(db.prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid LIMIT 1").get(qitemId)).toEqual({ identity_provenance: "origin-unknown:v1" });
  });

  // queue_transitions 表——创建操作（queue.ts:470）。
  it("队列创建：缺少请求头且正文含 sourceSession 时可投递，转换记录 claimed:v1（而非 transport:v1）", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // 不含 X-OpenRig-Session
      body: JSON.stringify({ destinationSession: "dest@rig", body: "hi", sourceSession: "claimant@rig" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("队列创建：携带请求头时转换记录 transport:v1（认证路径不变）", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "me@rig" },
      body: JSON.stringify({ destinationSession: "dest@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });
});
