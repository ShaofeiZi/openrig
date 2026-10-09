// 51-06 atom D2——不可持久化的 queue update metadata（summary/evidence_ref）必须依据
// Guard-bound 设计，在任何变更前直接拒绝（无提交后标记；先拒绝再写入）。
// 与迁移保持一致：规范 queue 集合加上 044（summary）与 048（evidence_ref），从而证明丢弃
// 确由非 park 规则引起，而非缺少列（本 atom 标出的测试套件一致性缺口）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";

const REJECT_CODE = "summary_evidence_not_persistable";

function buildApp(bus: EventBus, queueRepo: QueueRepository): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, queueRepo); await next(); });
  app.route("/api/queue", queueRoutes());
  return app;
}

describe("51-06 D2——拒绝非 park 的 queue update metadata", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema, queueTargetRepoSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    app = buildApp(bus, repo);
  });
  afterEach(() => db.close());

  const mkItem = async () => (await repo.create({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "d2 项目" })).qitemId;
  const txnCount = (id: string) => (db.prepare("SELECT count(*) c FROM queue_transitions WHERE qitem_id = ?").get(id) as { c: number }).c;
  const eventCount = () => (db.prepare("SELECT count(*) c FROM events").get() as { c: number }).c;

  async function expectRejectZeroMutation(input: Record<string, unknown>, invalidFields: string[]) {
    const id = await mkItem();
    const beforeState = repo.getByIdOrThrow(id).state;
    const beforeTxns = txnCount(id);
    const beforeEvents = eventCount();
    let err: unknown;
    try { repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", ...input }); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe(REJECT_CODE);
    expect((err as QueueRepositoryError).meta?.invalidFields).toEqual(invalidFields);
    // 零变更：无 UPDATE（state）、无日志（transition）、无事件。
    expect(repo.getByIdOrThrow(id).state).toBe(beforeState);
    expect(txnCount(id)).toBe(beforeTxns);
    expect(eventCount()).toBe(beforeEvents);
  }

  it("在任何变更前拒绝非 park transition 的 --summary", async () => {
    await expectRejectZeroMutation({ summary: "丢弃我" }, ["summary"]);
  });
  it("在任何变更前拒绝非 park transition 的 --evidence-ref", async () => {
    await expectRejectZeroMutation({ evidenceRef: "/proof/x.md" }, ["evidenceRef"]);
  });
  it("在任何变更前拒绝两个字段，并在 invalidFields 中列出两者", async () => {
    await expectRejectZeroMutation({ summary: "S", evidenceRef: "/e" }, ["summary", "evidenceRef"]);
  });
  it("把空字符串视为已提供（null=缺失，空字符串=已提供）并拒绝", async () => {
    await expectRejectZeroMutation({ summary: "" }, ["summary"]);
  });

  it("终态非 park transition（in-progress → done + closure）也会拒绝", async () => {
    const id = await mkItem();
    repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress" }); // claim（无 metadata，可通过）
    let err: unknown;
    try { repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "done", closureReason: "no-follow-on", summary: "S" }); }
    catch (e) { err = e; }
    expect((err as QueueRepositoryError).code).toBe(REJECT_CODE);
    expect(repo.getByIdOrThrow(id).state).toBe("in-progress"); // 被拒绝的 close 不会改变状态
  });

  it("不含 metadata 的非 park update 保持不变（null=缺失，不拒绝）", async () => {
    const id = await mkItem();
    const res = repo.update({ qitemId: id, actorSession: "dev-x@rig", state: "in-progress", summary: null, evidenceRef: null });
    expect(res.state).toBe("in-progress");
  });

  it("对照：human-seat park 仍逐字节持久化 summary + evidence", async () => {
    const id = await mkItem();
    const res = repo.update({ qitemId: id, actorSession: "orch@rig", state: "blocked", blockedOn: "human@kernel", summary: "PARK-KEEP", evidenceRef: "/proof/park.md" });
    expect(res.summary).toBe("PARK-KEEP");
    expect(res.evidenceRef).toBe("/proof/park.md");
  });

  it("路由：POST /:id/update 非 park + summary → HTTP 400 并列出 invalidFields", async () => {
    // P21 I3：create/update 从 transport header 派生 sender；header==body 声明时允许通过。
    const created = await app.request("/api/queue/create", { method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "orch@rig" }, body: JSON.stringify({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "r" }) });
    const id = ((await created.json()) as { qitemId: string }).qitemId;
    const res = await app.request(`/api/queue/${id}/update`, { method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "dev-x@rig" }, body: JSON.stringify({ actorSession: "dev-x@rig", state: "in-progress", summary: "丢弃我" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; invalidFields?: string[] };
    expect(body.error).toBe(REJECT_CODE);
    expect(body.invalidFields).toEqual(["summary"]);
  });
});
