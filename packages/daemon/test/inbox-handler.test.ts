import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler, InboxHandlerError } from "../src/domain/inbox-handler.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("InboxHandler 收件箱处理器", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let inbox: InboxHandler;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      inboxEntriesSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("drop 记录发送者、标签与 audit_pointer", () => {
    const e = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "异步工作",
      tags: ["batch", "low-prio"],
      auditPointer: "audit/2026/04/28/x.md",
    });
    expect(e.inboxId).toMatch(/^inbox-\d{14}-[a-f0-9]{8}$/);
    expect(e.senderSession).toBe("alice@rig");
    expect(e.tags).toEqual(["batch", "low-prio"]);
    expect(e.state).toBe("pending");
    expect(e.auditPointer).toBe("audit/2026/04/28/x.md");
  });

  it("drop 对 inbox_id 幂等", () => {
    const id = "inbox-fixed-test-id-0001";
    const a = inbox.drop({
      inboxId: id,
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "第一条",
    });
    const b = inbox.drop({
      inboxId: id,
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "第二条（忽略）",
    });
    expect(a.inboxId).toBe(b.inboxId);
    expect(b.body).toBe("第一条");
  });

  // P18 发送者来源：身份验证已从处理器移到唯一传输关口。处理器不再携带 `authenticate`
  // 谓词——其默认全允许加正文转发主体曾构成伪造权限表层。它如实记录调用方
  //（/inbox/drop 路由）提供的、从传输层派生的 senderSession；伪造发送者证明
  //（从 header 派生与正文声明对比，并拒绝无法归因者）位于路由层。
  it("原样记录传入的、从传输层派生的 senderSession", () => {
    const entry = inbox.drop({ destinationSession: "bob@rig", senderSession: "alice@rig", body: "x" });
    expect(entry.senderSession).toBe("alice@rig");
  });

  it("absorb 将待处理条目提升为 queue_item，并发出 inbox.absorbed", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "审查此项",
      urgency: "urgent",
    });
    const result = await inbox.absorb(entry.inboxId, "bob@rig");
    expect(result.entry.state).toBe("absorbed");
    expect(result.entry.absorbedQitemId).toBe(result.qitemId);

    const qitem = queueRepo.getById(result.qitemId)!;
    expect(qitem.body).toBe("审查此项");
    expect(qitem.priority).toBe("urgent");
    expect(qitem.sourceSession).toBe("alice@rig");
    expect(qitem.destinationSession).toBe("bob@rig");

    expect(captured.some((e) => e.type === "inbox.absorbed")).toBe(true);
  });

  it("absorb 幂等——第二次调用返回相同 qitem_id", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "x",
    });
    const a = await inbox.absorb(entry.inboxId, "bob@rig");
    const b = await inbox.absorb(entry.inboxId, "bob@rig");
    expect(a.qitemId).toBe(b.qitemId);
  });

  it("目标不匹配时 absorb 拒绝操作", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "x",
    });
    await expect(inbox.absorb(entry.inboxId, "carol@rig")).rejects.toThrow(/目标是/);
  });

  it("deny 记录原因并发出 inbox.denied；之后无法 absorb", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "偏离主题",
    });
    const denied = inbox.deny(entry.inboxId, "bob@rig", "与此装备无关");
    expect(denied.state).toBe("denied");
    expect(denied.deniedReason).toBe("与此装备无关");
    expect(captured.some((e) => e.type === "inbox.denied")).toBe(true);
    await expect(inbox.absorb(entry.inboxId, "bob@rig")).rejects.toThrow(/已被拒绝/);
  });

  it("listPending 仅返回指定目标的待处理条目", () => {
    inbox.drop({ destinationSession: "bob@rig", senderSession: "a@r", body: "1" });
    const e2 = inbox.drop({ destinationSession: "bob@rig", senderSession: "a@r", body: "2" });
    inbox.drop({ destinationSession: "carol@rig", senderSession: "a@r", body: "3" });
    inbox.deny(e2.inboxId, "bob@rig", "no");

    const pending = inbox.listPending("bob@rig");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.body).toBe("1");
  });
});
