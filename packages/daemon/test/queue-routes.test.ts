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
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { i3IdentityProvenanceSchema } from "../src/db/migrations/067_i3_identity_provenance.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { CLOSURE_REASONS } from "../src/domain/hot-potato-enforcer.js";
import { queueRoutes } from "../src/routes/queue.js";

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

describe("queue 路由", () => {
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
      streamItemsSchema, // 067's stream_items ALTER needs its base table present
      queueItemsSchema,
      queueTransitionsSchema,
      watchdogJobsSchema,
      inboxEntriesSchema,
      outboxEntriesSchema,
      queueTargetRepoSchema, // OPR.0.3.2.20: required for attention=1&targetRepo=X composition tests
      i3IdentityProvenanceSchema, // queue-spine store 上的 P21 §4 era-stamp column（最后执行：需要全部 4 个 table）
    ]);
    createWakeContractTable(db);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    outbox = new OutboxHandler(db);
    queueRepo.attachOutbox(outbox); // W1 MF2: handoff routes need a wake-intent store
    app = buildApp({ eventBus: bus, queueRepo, inboxHandler: inbox, outboxHandler: outbox });
  });

  afterEach(() => db.close());

  function createWakeContractTable(database: Database.Database): void {
    database.exec(`
      CREATE TABLE queue_transition_wakes (
        transition_id INTEGER PRIMARY KEY,
        qitem_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        wake_kind TEXT NOT NULL,
        wake_ref TEXT NOT NULL,
        delivery_status TEXT
      );
      CREATE INDEX idx_queue_transition_wakes_qitem ON queue_transition_wakes(qitem_id, transition_id);
      CREATE INDEX idx_queue_transition_wakes_ref ON queue_transition_wakes(wake_ref, phase);
    `);
  }

  it("S03：update 路由透传 wakeAfterSeconds 并以原子方式记录 timer", async () => {
    const row = await queueRepo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", nudge: false });
    const res = await app.request(`/api/queue/${row.qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({
        state: "blocked",
        blockedOn: "external:cooldown",
        transitionNote: "continuation: retry after cooldown",
        wakeAfterSeconds: 45,
      }),
    });
    expect(res.status).toBe(200);
    const wake = db.prepare("SELECT wake_kind, wake_ref FROM queue_transition_wakes WHERE qitem_id = ?")
      .get(row.qitemId) as { wake_kind: string; wake_ref: string } | undefined;
    expect(wake?.wake_kind).toBe("timer");
    const transitions = await app.request(`/api/queue/${row.qitemId}/transitions`);
    expect(transitions.status).toBe(200);
    expect((await transitions.json() as Array<{ wake?: { kind: string; ref: string } }>).at(-1)?.wake)
      .toMatchObject({ kind: "timer", ref: wake?.wake_ref });
    const job = wake
      ? db.prepare("SELECT target_session, interval_seconds, state FROM watchdog_jobs WHERE job_id = ?").get(wake.wake_ref)
      : undefined;
    expect(job).toMatchObject({ target_session: "b@r", interval_seconds: 45, state: "active" });
  });

  // 0.5.1-54 DR-1——create-path failed-nudge surface（具名且人类/agent 可见的读取路径）。
  it("DR-1：GET /undelivered 呈现 failed-nudge pending strand，且仅限 V1", async () => {
    const failed = await queueRepo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "x" });
    queueRepo.recordNudgeAttempt(failed.qitemId, "failed:Session 'b@rig' not found");
    const delivered = await queueRepo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "y" });
    queueRepo.recordNudgeAttempt(delivered.qitemId, "verified");
    const res = await app.request("/api/queue/undelivered");
    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<{ qitemId: string; deliveryFailureClass: string | null }>;
    const ids = items.map((i) => i.qitemId);
    expect(ids, "the failed-nudge strand is surfaced").toContain(failed.qitemId);
    expect(ids, "V1-only: a delivered row is not surfaced").not.toContain(delivered.qitemId);
    // classifier fold：not-found strand 标记为 permanent-topology（无法在此 daemon 解析）。
    const strand = items.find((i) => i.qitemId === failed.qitemId)!;
    expect(strand.deliveryFailureClass, "the not-found strand is labeled permanent-topology").toBe("permanent-topology");
  });

  // ── P18 sender-provenance：/inbox/drop 从已认证 transport header（X-OpenRig-Session）派生
  // sender，绝不采用 request-body 声明；缺失时明确拒绝无法归因的请求。──
  describe("P18 sender-provenance", () => {
    it("记录由 transport 派生的 sender（header），忽略伪造的 body senderSession/authenticatedSender", async () => {
      const res = await app.request("/api/queue/inbox/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
        body: JSON.stringify({
          destinationSession: "bob@rig", body: "hi",
          senderSession: "mallory@rig", authenticatedSender: "mallory@rig", // 伪造的 body 声明——必须忽略
        }),
      });
      expect(res.status).toBe(201);
      const entry = await res.json() as { senderSession: string };
      expect(entry.senderSession).toBe("alice@rig"); // header 优先；伪造的 body 声明不会写入
    });

    it("缺少 header（不读取 body sender）→ 400 actor_required（P18 sweep：参数完整性，而非已废弃的 401 拒绝）", async () => {
      const res = await app.request("/api/queue/inbox/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // NO X-OpenRig-Session
        body: JSON.stringify({ destinationSession: "bob@rig", body: "hi", senderSession: "mallory@rig" }),
      });
      // inbox/drop 从不读取可伪造的 body sender，因此没有 header 就没有可标记的 actor →
      // 400 actor_required（queue.ts:215 类），而非已废弃的无法认证 sender 的 401 拒绝。
      expect(res.status).toBe(400);
      const err = await res.json() as { error: string; message: string };
      expect(err.error).toBe("actor_required");
      expect(err.message).toMatch(/X-OpenRig-Session/);
    });
  });

  it("inbox drop——为 inbox_entries 标记 transport:v1 era（P21 §4 derived-era boundary）", async () => {
    const res = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "sender@rig" },
      body: JSON.stringify({ destinationSession: "dest@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { inboxId } = (await res.json()) as { inboxId: string };
    // dropped entry 的 sender 由 transport 派生 → channel-of-record row 标记为 transport:v1。
    const row = db
      .prepare("SELECT identity_provenance FROM inbox_entries WHERE inbox_id = ?")
      .get(inboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  // P21 I3——inbox absorb/deny（receiverSession）+ outbox record（senderSession）曾是实时运行的
  // allow-all body-supplied identity site（specimen-5 family）。I3 改为从 header 派生。
  async function dropEntry(dest: string, sender: string): Promise<string> {
    const res = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": sender },
      body: JSON.stringify({ destinationSession: dest, body: "hi" }),
    });
    return ((await res.json()) as { inboxId: string }).inboxId;
  }

  it("outbox record——仍接受普通（非保留）outboxId", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "sender@rig" },
      body: JSON.stringify({ destinationSession: "dest@rig", body: "ordinary audit" }),
    });
    expect(res.status).toBe(201);
  });

  it("inbox absorb——缺少 header + body receiverSession → 以声明 actor 交付，transition 为 claimed:v1", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiverSession: "dest@rig" }),
    });
    expect(res.status).toBe(200);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("inbox absorb——header 存在且 body receiverSession 不同 → wire 优先（以 dest@rig、transport:v1 交付）；409 已废弃", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dest@rig" },
      body: JSON.stringify({ receiverSession: "mallory@rig" }), // 被 wire identity 覆盖
    });
    expect(res.status).toBe(200);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("inbox absorb——从 header 派生 receiver，并为吸收的 qitem 标记 transport:v1 era", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dest@rig" },
      body: JSON.stringify({ receiverSession: "dest@rig" }),
    });
    expect(res.status).toBe(200);
    const { qitemId } = (await res.json()) as { qitemId: string };
    // absorb 是 transport 派生的 receiver action → 所创建 qitem 的 transition 为 transport:v1。
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("inbox deny——缺少 header + body receiverSession → 以声明 actor 交付（200）；401 已废弃", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiverSession: "dest@rig", reason: "nope" }),
    });
    expect(res.status).toBe(200);
  });

  it("inbox deny——header 存在且 body receiverSession 不同 → wire 优先并交付（200）；409 已废弃", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dest@rig" },
      body: JSON.stringify({ receiverSession: "mallory@rig", reason: "nope" }), // 被 wire identity 覆盖
    });
    expect(res.status).toBe(200);
  });

  it("inbox deny——从 header 派生 receiver（200）", async () => {
    const inboxId = await dropEntry("dest@rig", "sender@rig");
    const res = await app.request(`/api/queue/inbox/${inboxId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dest@rig" },
      body: JSON.stringify({ receiverSession: "dest@rig", reason: "not mine" }),
    });
    expect(res.status).toBe(200);
  });

  it("outbox record——缺少 header + body senderSession → 以声明 actor 交付，outbox_entries 为 claimed:v1", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderSession: "me@rig", destinationSession: "you@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { outboxId } = (await res.json()) as { outboxId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("outbox record——header 存在且 body senderSession 不同 → wire 优先（transport:v1）；409 已废弃", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "me@rig" },
      body: JSON.stringify({ senderSession: "evil@rig", destinationSession: "you@rig", body: "hi" }), // superseded
    });
    expect(res.status).toBe(201);
    const { outboxId } = (await res.json()) as { outboxId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("outbox record——从 header 派生 sender，并为 outbox_entries 标记 transport:v1 era", async () => {
    const res = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "me@rig" },
      body: JSON.stringify({ senderSession: "me@rig", destinationSession: "you@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { outboxId } = (await res.json()) as { outboxId: string };
    const row = db
      .prepare("SELECT identity_provenance FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("POST /api/queue/create 创建 qitem", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "do thing",
        priority: "urgent",
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { qitemId: string; state: string; priority: string };
    expect(data.state).toBe("pending");
    expect(data.priority).toBe("urgent");
  });

  // P21 I3——create 的 sender 来自 transport header（X-OpenRig-Session），绝不采用 body 声明。
  // adopt-drop 窗口：仅当 body sourceSession 与 transport identity 相等时才容许它。
  it("create——缺少 header + body sourceSession → 以声明 actor 交付，transition 为 claimed:v1", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "bob@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const t = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(t?.identity_provenance).toBe("claimed:v1");
  });

  it("create——header 存在且 body sourceSession 不同 → wire 优先（source alice@rig、transport:v1）；409 已废弃", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "bob@rig", destinationSession: "dst@rig", body: "hi" }), // superseded
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as { source_session: string } | undefined;
    expect(row?.source_session).toBe("alice@rig");
    const t = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(t?.identity_provenance).toBe("transport:v1");
  });

  it("create——从 transport header 派生 source_session，绝不读取 body（允许相同声明）", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "alice@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as { source_session: string } | undefined;
    expect(row?.source_session).toBe("alice@rig");
  });

  it("create——为创建的 transition 标记 transport:v1 era（P21 §4 derived-era boundary）", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "alice@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    // 'created' transition 的 actor 由 transport 派生 → 标记为 transport:v1（缺失 = claimed-era）。
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  // P21 I3——update 的 actor 来自 transport header（X-OpenRig-Session），绝不采用 body 声明。
  async function createForUpdate(session: string): Promise<string> {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": session },
      body: JSON.stringify({ sourceSession: session, destinationSession: "worker@r", body: "x" }),
    });
    return ((await create.json()) as { qitemId: string }).qitemId;
  }

  it("update——缺少 header + body actorSession → 以声明 actor 交付，transition 为 claimed:v1", async () => {
    const qitemId = await createForUpdate("a@r");
    const res = await app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorSession: "worker@r", state: "in-progress" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("worker@r");
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("update——header 存在且 body actorSession 不同 → wire 优先（actor worker@r、transport:v1）；409 已废弃", async () => {
    const qitemId = await createForUpdate("a@r");
    const res = await app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@r" },
      body: JSON.stringify({ actorSession: "mallory@r", state: "in-progress" }), // 被 wire identity 覆盖
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("worker@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("update——从 transport header 派生 transition actor，绝不读取 body", async () => {
    const qitemId = await createForUpdate("a@r");
    const res = await app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@r" },
      body: JSON.stringify({ actorSession: "worker@r", state: "in-progress" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("worker@r");
    // P21 §4 era-stamp：transport 派生的 actor 标记为 transport:v1（缺失 = claimed-era）。
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  // P21 I3——handoff / handoff-and-complete 从 transport header 派生 fromSession，不读取 body。
  async function createForHandoff(dest: string): Promise<string> {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@r" },
      body: JSON.stringify({ sourceSession: "orch@r", destinationSession: dest, body: "x" }),
    });
    return ((await create.json()) as { qitemId: string }).qitemId;
  }

  for (const verb of ["handoff", "handoff-and-complete"] as const) {
    it(`${verb}——缺少 header + body fromSession → 以声明 actor 交付，close transition 为 claimed:v1`, async () => {
      const qitemId = await createForHandoff("b@r");
      const res = await app.request(`/api/queue/${qitemId}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSession: "b@r", toSession: "c@r" }),
      });
      expect(res.status).toBe(201);
      const closed = db
        .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(qitemId) as { identity_provenance: string | null } | undefined;
      expect(closed?.identity_provenance).toBe("claimed:v1");
    });

    it(`${verb}——header 存在且 body fromSession 不同 → wire 优先（交付、transport:v1）；409 已废弃`, async () => {
      const qitemId = await createForHandoff("b@r");
      const res = await app.request(`/api/queue/${qitemId}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({ fromSession: "mallory@r", toSession: "c@r" }), // 被 wire identity 覆盖
      });
      expect(res.status).toBe(201);
      const closed = db
        .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(qitemId) as { identity_provenance: string | null } | undefined;
      expect(closed?.identity_provenance).toBe("transport:v1");
    });

    it(`${verb}——从 header 派生 fromSession，并为 close transition 标记 transport:v1 era`, async () => {
      const qitemId = await createForHandoff("b@r");
      const res = await app.request(`/api/queue/${qitemId}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({ fromSession: "b@r", toSession: "c@r" }),
      });
      expect(res.status).toBe(201);
      // source-close transition（handed-off/done）的 actor 由 transport 派生 → transport:v1。
      const closed = db
        .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(qitemId) as { identity_provenance: string | null } | undefined;
      expect(closed?.identity_provenance).toBe("transport:v1");
    });
  }

  // P21 I3——claim/unclaim 从 transport header 派生 claimant（destinationSession）。
  // repo 仍强制只能（取消）认领分配给自身 identity 的 item。
  async function createAndClaim(dest: string): Promise<string> {
    const qitemId = await createForHandoff(dest);
    await app.request(`/api/queue/${qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": dest },
      body: JSON.stringify({ destinationSession: dest }),
    });
    return qitemId;
  }

  it("claim——缺少 header + body destinationSession → 以声明 actor 交付，transition 为 claimed:v1", async () => {
    const qitemId = await createForHandoff("b@r");
    const res = await app.request(`/api/queue/${qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "b@r" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("claim——header 存在且 body destinationSession 不同 → wire 优先（claimant b@r、transport:v1）；409 已废弃", async () => {
    const qitemId = await createForHandoff("b@r");
    const res = await app.request(`/api/queue/${qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ destinationSession: "mallory@r" }), // 被 wire identity 覆盖
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("claim——从 header 派生 claimant，并为 transition 标记 transport:v1 era", async () => {
    const qitemId = await createForHandoff("b@r");
    const res = await app.request(`/api/queue/${qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ destinationSession: "b@r" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("unclaim——缺少 header + body destinationSession → 以声明 actor 交付，transition 为 claimed:v1", async () => {
    const qitemId = await createAndClaim("b@r");
    const res = await app.request(`/api/queue/${qitemId}/unclaim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "b@r" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("claimed:v1");
  });

  it("unclaim——header 存在且 body destinationSession 不同 → wire 优先（b@r、transport:v1）；409 已废弃", async () => {
    const qitemId = await createAndClaim("b@r");
    const res = await app.request(`/api/queue/${qitemId}/unclaim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ destinationSession: "mallory@r" }), // 被 wire identity 覆盖
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("unclaim——从 header 派生 claimant，并为 transition 标记 transport:v1 era", async () => {
    const qitemId = await createAndClaim("b@r");
    const res = await app.request(`/api/queue/${qitemId}/unclaim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ destinationSession: "b@r" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("b@r");
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("POST /api/queue/:id/update 在 state=done 且缺少 closure_reason 时返回 400 与 validReasons", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const update = await app.request(`/api/queue/${item.qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
      body: JSON.stringify({ actorSession: "b@r", state: "done" }),
    });
    expect(update.status).toBe(400);
    const data = (await update.json()) as { error: string; validReasons: string[] };
    expect(data.error).toBe("missing_closure_reason");
    expect(data.validReasons).toEqual(CLOSURE_REASONS);
  });

  it("POST /api/queue/:id/update 接受每个有效 closure reason", async () => {
    for (const reason of CLOSURE_REASONS) {
      const create = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: `for-${reason}` }),
      });
      const item = (await create.json()) as { qitemId: string };

      const requiresTarget = reason === "handed_off_to" || reason === "blocked_on" || reason === "escalation";
      const update = await app.request(`/api/queue/${item.qitemId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({
          actorSession: "b@r",
          state: "done",
          closureReason: reason,
          ...(requiresTarget ? { closureTarget: "downstream-target" } : {}),
        }),
      });
      expect(update.status).toBe(200);
      const data = (await update.json()) as { state: string; closureReason: string };
      expect(data.state).toBe("done");
      expect(data.closureReason).toBe(reason);
    }
  });

  it("POST /api/queue/:id/handoff 在一个 transaction 中返回 closed + created", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const handoff = await app.request(`/api/queue/${item.qitemId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" }, // P21 I3：handoff actor 来自 transport header
      body: JSON.stringify({ fromSession: "b@r", toSession: "c@r", transitionNote: "specialty" }),
    });
    expect(handoff.status).toBe(201);
    const data = (await handoff.json()) as {
      closed: { state: string; closureReason: string; handedOffTo: string };
      created: { state: string; destinationSession: string; handedOffFrom: string };
    };
    expect(data.closed.state).toBe("handed-off");
    expect(data.closed.closureReason).toBe("handed_off_to");
    expect(data.closed.handedOffTo).toBe("c@r");
    expect(data.created.state).toBe("pending");
    expect(data.created.destinationSession).toBe("c@r");
    expect(data.created.handedOffFrom).toBe(item.qitemId);
  });

  it("GET /api/queue/:id 返回 qitem；transitions endpoint 返回日志", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const get = await app.request(`/api/queue/${item.qitemId}`);
    expect(get.status).toBe(200);

    const transitions = await app.request(`/api/queue/${item.qitemId}/transitions`);
    expect(transitions.status).toBe(200);
    const tlist = (await transitions.json()) as Array<{ state: string }>;
    expect(tlist).toHaveLength(1);
    expect(tlist[0]!.state).toBe("pending");
  });

  it("inbox drop / absorb / deny 往返", async () => {
    const drop = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" }, // P18: transport-derived sender
      body: JSON.stringify({
        destinationSession: "b@r",
        body: "async",
      }),
    });
    expect(drop.status).toBe(201);
    const entry = (await drop.json()) as { inboxId: string };

    const absorb = await app.request(`/api/queue/inbox/${entry.inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" }, // P21 I3：receiver 来自 transport header
      body: JSON.stringify({ receiverSession: "b@r" }),
    });
    expect(absorb.status).toBe(200);
    const absorbed = (await absorb.json()) as { qitemId: string };
    expect(absorbed.qitemId).toMatch(/^qitem-/);

    // 第二条 drop + deny 路径
    const drop2 = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" }, // P18: transport-derived sender
      body: JSON.stringify({ destinationSession: "b@r", body: "skip" }),
    });
    const entry2 = (await drop2.json()) as { inboxId: string };
    const deny = await app.request(`/api/queue/inbox/${entry2.inboxId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" }, // P21 I3：receiver 来自 transport header
      body: JSON.stringify({ receiverSession: "b@r", reason: "off-topic" }),
    });
    expect(deny.status).toBe(200);
  });

  it("outbox record + list 往返", async () => {
    const record = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" }, // P21 I3：outbox sender 来自 transport header
      body: JSON.stringify({ senderSession: "a@r", destinationSession: "b@r", body: "fyi" }),
    });
    expect(record.status).toBe(201);

    const list = await app.request("/api/queue/outbox/list?senderSession=a@r");
    expect(list.status).toBe(200);
    const data = (await list.json()) as Array<{ body: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.body).toBe("fyi");
  });

  it("GET /api/queue/list 按 destination + state 过滤", async () => {
    await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "1" }),
    });
    await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "c@r", body: "2" }),
    });
    const res = await app.request("/api/queue/list?destinationSession=b@r");
    const data = (await res.json()) as unknown[];
    expect(data).toHaveLength(1);
  });

  // OPR.0.3.2.20——For You 优先级窗口 slice 的 `?attention=1` filter。返回 OPEN
  // attention-class qitem（durable source of truth），使 UI 的 Action-required + Approval
  // 视图不依赖有损的临时 event FIFO。HG-4 已对照 mission-control read layer 的 canonical
  // attention 语义验证：approval class 为 tier === "human-gate"；action-required class 为
  // destinationSession 是 human-*@kernel|host；open state 为 pending | in-progress | blocked。
  describe("OPR.0.3.2.20 GET /api/queue/list?attention=1——open attention-class item", () => {
    it("仅含 tier 的 agent row 不会产生 human approval obligation", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "b@r",
          body: "approve please",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      expect(res.status).toBe(200);
      const data = (await res.json()) as Array<{ tier: string | null; body: string }>;
      expect(data).toHaveLength(0);
    });

    it("HG-4 正向（action-required 类）：返回 destination=human-foo@kernel 的 open qitem", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-bob@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "needs human",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as Array<{ destinationSession: string }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.destinationSession).toBe("human-bob@kernel");
    });

    it("HG-4 正向：返回 destination=human@host（裸 human prefix）的 open qitem", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human@host",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "needs human attention",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data).toHaveLength(1);
    });

    it("HG-4 负向：不返回普通 pending qitem（非 attention tier + 非 human destination）", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "b@r",
          body: "routine work",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data).toHaveLength(0);
    });

    it("HG-4 负向：不返回已关闭的 attention qitem（state=done）", async () => {
      const create = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-x@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "done already",
        }),
      });
      const item = (await create.json()) as { qitemId: string };
      await app.request(`/api/queue/${item.qitemId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "human-x@kernel" },
        body: JSON.stringify({
          actorSession: "human-x@kernel",
          state: "done",
          closureReason: "no-follow-on",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data).toHaveLength(0);
    });

    it("HG-5/HG-7 合理边界：?attention=1&limit=N 限制结果数量", async () => {
      // 预置 5 个 attention-class qitem
      for (let i = 0; i < 5; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
          body: JSON.stringify({
            sourceSession: "a@r",
            destinationSession: `human-${i}@kernel`,
            body: `attn ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1&limit=3");
      const data = (await res.json()) as unknown[];
      expect(data.length).toBeLessThanOrEqual(3);
    });

    it("HG-2（核心）：创建 100 多个无关普通 qitem 后仍能找到 attention-class item（queue 是 durable source）", async () => {
      // 先预置一个 attention-class item
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-founder@external",
          body: "approve me",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      // 随后创建 100 多个普通 qitem（无 attention marker）；这些会填满 UI 中任何 FIFO 窗口，
      // 但 queue 是 durable source——attention filter 仍须呈现 human-gate item。
      for (let i = 0; i < 110; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `routine-${i}@r` },
          body: JSON.stringify({
            sourceSession: `routine-${i}@r`,
            destinationSession: `other-${i}@r`,
            body: `noise ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as Array<{ tier: string | null }>;
      // 即使之后写入 110 个普通 qitem，attention item 仍存在。
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data.some((q) => q.tier === "human-gate")).toBe(true);
    });

    // Guard re-verify-2（qitem-20260518192210）BLOCKER-1：此前的 forward-fix 丢失了
    // destinationSession/sourceSession/targetRepo composition。本修复通过 listAttention
    // 将这些参数传入 SQL WHERE，使有 scope 的 attention query 只返回匹配项。

    it("BLOCKER re-verify-2：attention=1 + destinationSession=X 仅返回 X scope 的 attention item", async () => {
      // 在不同 destination 预置 2 个 attention item。
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r1" },
        body: JSON.stringify({
          sourceSession: "advisor@r1",
          destinationSession: "human-alice@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "for alice",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r2" },
        body: JSON.stringify({
          sourceSession: "advisor@r2",
          destinationSession: "human-bob@kernel",
          body: "for bob",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      // 还创建一个 destination 为 alice 的非 attention 普通 qitem；它不得出现。
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r1" },
        body: JSON.stringify({
          sourceSession: "advisor@r1",
          destinationSession: "human-alice@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          state: "pending",
          body: "another for alice",
        }),
      });

      const res = await app.request("/api/queue/list?attention=1&destinationSession=human-alice@kernel");
      const data = (await res.json()) as Array<{ destinationSession: string; body: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      for (const item of data) {
        expect(item.destinationSession).toBe("human-alice@kernel");
      }
      // 其中任何一项都不应属于 bob。
      expect(data.some((q) => q.destinationSession === "human-bob@kernel")).toBe(false);
    });

    it("BLOCKER re-verify-2：attention=1 + sourceSession=X 仅返回 source 为 X 的 attention item", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor-a@r" },
        body: JSON.stringify({
          sourceSession: "advisor-a@r",
          destinationSession: "human-x@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "from advisor-a",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor-b@r" },
        body: JSON.stringify({
          sourceSession: "advisor-b@r",
          destinationSession: "human-y@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "from advisor-b",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1&sourceSession=advisor-a@r");
      const data = (await res.json()) as Array<{ sourceSession: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      for (const item of data) {
        expect(item.sourceSession).toBe("advisor-a@r");
      }
    });

    it("BLOCKER re-verify-2：未设 scope 的 attention=1 仍返回全局 attention set（composition 为可选）", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-x@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "global x",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({
          sourceSession: "b@r",
          destinationSession: "human-y@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "global y",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data.length).toBeGreaterThanOrEqual(2);
    });

    // Guard re-verify BLOCKER 1（qitem-20260518190827）：此前的先 fetch 后 filter 方案
    //（ATTENTION_FETCH_BOUND=1000，再用 JS filter）会把一个 attention item 隐藏在 1001 个以上
    // 更新的普通 open qitem 后。本修复将 attention predicate 下推到 SQL，使 LIMIT 在 attention
    // filtering 后应用。此测试让普通项 churn 远超旧 ATTENTION_FETCH_BOUND，从构造上证明它不依赖窗口。
    // Guard re-verify-3（qitem-20260518193005）BLOCKER 1：SQL LIKE 是 regex 的超集。
    // `destination_session='human-@kernel'`（name segment 为空）等格式错误 row 会匹配
    // LIKE `human-%@kernel`，但无法通过严格 regex。超过 LIMIT 的此类 row 可在 JS filter 前
    // 填满 SQL 窗口，并隐藏其后的有效 attention item。
    //
    // 修复：SQLite function `is_human_seat_session` 在 SQL 中计算精确 regex——格式错误的 row
    // 会在 LIMIT 前被拒绝。
    it("BLOCKER re-verify-3：格式错误的 superset row（'human-@kernel'）不会挤掉有效 attention item", async () => {
      // 预置 1 个有效 attention item。
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r" },
        body: JSON.stringify({
          sourceSession: "advisor@r",
          destinationSession: "human-alice@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "valid attention",
        }),
      });
      // 预置 1100 个匹配 LIKE 'human-%@kernel' 或类似 pattern、但无法通过严格 regex 的
      // 格式错误 row（name segment 为空、含禁用字符）。混合多种形式，确保没有单一 LIKE
      // 分支成为泄漏点。
      for (let i = 0; i < 1100; i++) {
        const variant = i % 4;
        const dest = variant === 0
          ? "human-@kernel"          // empty segment between hyphen and @
          : variant === 1
            ? "human- @kernel"       // space (forbidden char) — would match LIKE 'human-%@kernel'
            : variant === 2
              ? "human-x:@kernel"    // colon (forbidden char)
              : "human-x/@kernel";   // slash (forbidden char)
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `garbage-${i}@r` },
          body: JSON.stringify({
            sourceSession: `garbage-${i}@r`,
            destinationSession: dest,
            body: `malformed ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1&limit=100");
      const data = (await res.json()) as Array<{ destinationSession: string; body: string }>;
      // 有效 item 必须呈现——它是唯一匹配严格 regex 的 row。格式错误的 row 不得出现。
      const valid = data.find((q) => q.destinationSession === "human-alice@kernel");
      expect(valid).toBeDefined();
      expect(valid!.body).toBe("valid attention");
      // 结果集中没有格式错误的 row。
      for (const q of data) {
        expect(q.destinationSession).not.toBe("human-@kernel");
        expect(q.destinationSession).not.toContain(" ");
        expect(q.destinationSession).not.toContain(":");
        expect(q.destinationSession).not.toContain("/");
      }
    });

    // Guard re-verify-3（qitem-20260518193005）BLOCKER 2：targetRepo composition 已在此前
    // forward-fix 中实现，但从未由测试固定。此 discriminator 证明 attention=1&targetRepo=X
    // 会限定结果 scope，并在 SQL 阶段与 attention predicate 组合（LIMIT 随后应用）。
    it("BLOCKER re-verify-3：attention=1 + targetRepo=X 将 attention 限定到 repo X", async () => {
      // 在不同 repo 中预置 attention item。
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-bob@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "for repo-a",
          targetRepo: "repo-a",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-carol@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "for repo-b",
          targetRepo: "repo-b",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1&targetRepo=repo-a");
      const data = (await res.json()) as Array<{ targetRepo: string | null; body: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      for (const item of data) {
        expect(item.targetRepo).toBe("repo-a");
      }
    });

    it("BLOCKER re-verify-3：targetRepo composition 保持超过 1100 个 routine-open 时的持久性保证", async () => {
      // 预置 1 个 targetRepo=repo-X 的 attention item。
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-z@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "repo-X attention",
          targetRepo: "repo-X",
        }),
      });
      // 在其他 repo 中预置 1100 个更新的普通 open qitem；若 targetRepo predicate 在 LIMIT 后
      // 才应用，它们会占满窗口。
      for (let i = 0; i < 1100; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `routine-${i}@r` },
          body: JSON.stringify({
            sourceSession: `routine-${i}@r`,
            destinationSession: `other-${i}@r`,
            body: `noise ${i}`,
            targetRepo: "repo-other",
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1&targetRepo=repo-X");
      const data = (await res.json()) as Array<{ targetRepo: string | null; body: string }>;
      expect(data.length).toBe(1);
      expect(data[0]!.targetRepo).toBe("repo-X");
      expect(data[0]!.body).toBe("repo-X attention");
    });

    it("BLOCKER-1：即使有超过 1100 个更新的普通 OPEN qitem，attention item 仍会呈现（SQL predicate pushdown）", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "old@r" },
        body: JSON.stringify({
          sourceSession: "old@r",
          destinationSession: "human-founder@external",
          body: "approve me — oldest",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      // 1100 个普通 OPEN qitem 在 attention item 之后写入，其 ts_created 均更新；
      // LIMIT 1000 的先 fetch 后 filter 方案永远不会返回该 attention item。
      for (let i = 0; i < 1100; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `routine-${i}@r` },
          body: JSON.stringify({
            sourceSession: `routine-${i}@r`,
            destinationSession: `other-${i}@r`,
            body: `noise ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as Array<{ tier: string | null; body: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      const found = data.find((q) => q.tier === "human-gate");
      expect(found).toBeDefined();
      expect(found!.body).toContain("oldest");
    });
  });

  // ---- PL-004 Phase A revision（R1）路由测试 ----

  describe("R1 cross-rig 校验拒绝", () => {
    let strictDb: Database.Database;
    let strictBus: EventBus;
    let strictRepo: QueueRepository;
    let strictApp: Hono;

    beforeEach(() => {
      strictDb = createDb();
      migrate(strictDb, [
        coreSchema,
        eventsSchema,
        streamItemsSchema, // 067 的 stream_items ALTER 需要基础 table 已存在
        queueItemsSchema,
        queueTransitionsSchema,
        inboxEntriesSchema,
        outboxEntriesSchema,
        i3IdentityProvenanceSchema, // P21 §4 era-stamp column (last: needs all 4 tables)
      ]);
      strictBus = new EventBus(strictDb);
      strictRepo = new QueueRepository(strictDb, strictBus, {
        // topology-backed validator stub：仅识别 `@known-rig`。
        validateRig: (s) => /^[^@]+@known-rig$/.test(s),
      });
      const strictInbox = new InboxHandler(strictDb, strictBus, strictRepo);
      const strictOutbox = new OutboxHandler(strictDb);
      strictRepo.attachOutbox(strictOutbox); // W1 MF2
      strictApp = buildApp({
        eventBus: strictBus,
        queueRepo: strictRepo,
        inboxHandler: strictInbox,
        outboxHandler: strictOutbox,
      });
    });

    afterEach(() => strictDb.close());

    it("POST /api/queue/create 以 400 + structured error 拒绝未知工作组", async () => {
      const res = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@phantom-rig",
          body: "x",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("unknown_destination_rig");
      expect(body.message).toMatch(/phantom-rig/);
    });

    it("POST /api/queue/create 以 201 接受已知工作组", async () => {
      const res = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@known-rig",
          body: "ok",
        }),
      });
      expect(res.status).toBe(201);
    });

    it("POST /api/queue/:id/handoff 拒绝未知目标工作组", async () => {
      const created = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@known-rig",
          body: "x",
        }),
      });
      const item = (await created.json()) as { qitemId: string };
      const res = await strictApp.request(`/api/queue/${item.qitemId}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@known-rig" }, // P21 I3：handoff actor 来自 transport header
        body: JSON.stringify({
          fromSession: "bob@known-rig",
          toSession: "carol@phantom-rig",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unknown_destination_rig");
    });

    it("POST /api/queue/:id/handoff-and-complete 拒绝未知目标工作组", async () => {
      const created = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@known-rig",
          body: "x",
        }),
      });
      const item = (await created.json()) as { qitemId: string };
      const res = await strictApp.request(`/api/queue/${item.qitemId}/handoff-and-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@known-rig" }, // P21 I3：handoff actor 来自 transport header
        body: JSON.stringify({
          fromSession: "bob@known-rig",
          toSession: "carol@phantom-rig",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unknown_destination_rig");
    });
  });

  describe("R1 handoff-and-complete 路由", () => {
    it("POST /api/queue/:id/handoff-and-complete 将 source 关闭为 done 并创建新项", async () => {
      const created = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "x" }),
      });
      const item = (await created.json()) as { qitemId: string };
      const res = await app.request(`/api/queue/${item.qitemId}/handoff-and-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@r" }, // P21 I3：handoff actor 来自 transport header
        body: JSON.stringify({
          fromSession: "bob@r",
          toSession: "carol@r",
          body: "carol's piece",
        }),
      });
      expect(res.status).toBe(201);
      const result = (await res.json()) as {
        closed: { state: string; closureReason: string; handedOffTo: string };
        created: { state: string; handedOffFrom: string; destinationSession: string; body: string };
      };
      expect(result.closed.state).toBe("done");
      expect(result.closed.closureReason).toBe("handed_off_to");
      expect(result.closed.handedOffTo).toBe("carol@r");
      expect(result.created.state).toBe("pending");
      expect(result.created.handedOffFrom).toBe(item.qitemId);
      expect(result.created.body).toBe("carol's piece");
    });

    it("POST /api/queue/:id/handoff-and-complete 缺少 toSession 时返回 400（fromSession 从 header 派生；缺失 sender 才走 401）", async () => {
      const res = await app.request("/api/queue/some-id/handoff-and-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@r" },
        body: JSON.stringify({ fromSession: "bob@r" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/toSession/);
    });
  });

  describe("R1 whoami 路由", () => {
    it("GET /api/queue/whoami 返回 session 的 counts + recent", async () => {
      // 预置：bob 有 2 个 pending + 1 个 in-progress；carol 有 1 个无关项。
      const a = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "1" }),
      });
      const itemA = (await a.json()) as { qitemId: string };
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "2" }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "carol@r", body: "3" }),
      });
      await app.request(`/api/queue/${itemA.qitemId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "bob@r" }, // P21 I3：claimant 来自 transport header
        body: JSON.stringify({ destinationSession: "bob@r" }),
      });

      const res = await app.request("/api/queue/whoami?session=bob@r");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        session: string;
        asDestination: { pending: number; inProgress: number; recent: unknown[] };
        asSource: { total: number };
      };
      expect(body.session).toBe("bob@r");
      expect(body.asDestination.pending).toBe(1);
      expect(body.asDestination.inProgress).toBe(1);
      expect(body.asDestination.recent).toHaveLength(2);
      expect(body.asSource.total).toBe(0);
    });

    it("GET /api/queue/whoami 缺少 session query param 时返回 400", async () => {
      const res = await app.request("/api/queue/whoami");
      expect(res.status).toBe(400);
    });
  });

  describe("R1 SSE 路由——live GET 会抵达 SSE handler（不被 /:qitemId 遮蔽）", () => {
    // 根据 QA finding 执行 live GET 测试：HEAD comparison 不充分，因为 dynamic route shadowing
    //（/:qitemId 将 `sse` 与 `watch` 捕获为 id）会返回带 `qitem_not_found` 的 404，而非进入 SSE
    // handler。真实 GET 断言 content-type: text/event-stream，可证明已抵达 SSE handler。
    // 随后取消 response body，以释放长连接 stream。

    it("GET /api/queue/sse 返回 200 + content-type: text/event-stream（已抵达 handler）", async () => {
      const res = await app.request("/api/queue/sse");
      try {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      } finally {
        await res.body?.cancel();
      }
    });

    it("GET /api/queue/watch 返回 200 + content-type: text/event-stream（已抵达 handler）", async () => {
      const res = await app.request("/api/queue/watch");
      try {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      } finally {
        await res.body?.cancel();
      }
    });

    it("GET /api/queue/sse 不返回 qitem_not_found（route-order 回归 guard）", async () => {
      const res = await app.request("/api/queue/sse");
      try {
        // 若 /:qitemId 将 `sse` 捕获为 id，会返回带 {"error":"qitem_not_found"} 的 404 JSON。
        // 绝不能发生这种情况。
        expect(res.status).not.toBe(404);
        const ct = res.headers.get("content-type") ?? "";
        expect(ct).not.toContain("application/json");
      } finally {
        await res.body?.cancel();
      }
    });
  });
});
