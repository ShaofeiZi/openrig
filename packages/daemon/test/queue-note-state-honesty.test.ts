import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { QueueRepository, type QueueState } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("S8a——note 不是 state 写入", () => {
  let db: Database.Database;
  let repo: QueueRepository;
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
      i3IdentityProvenanceSchema,
    ]);
    const eventBus = new EventBus(db);
    repo = new QueueRepository(db, eventBus);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, eventBus);
      c.set("queueRepo" as never, repo);
      await next();
    });
    app.route("/api/queue", queueRoutes());
  });

  afterEach(() => db.close());

  async function createTerminal(state: "done" | "canceled" | "handed-off") {
    const item = await repo.create({ sourceSession: "author@rig", destinationSession: "owner@rig", body: "work" });
    repo.update({
      qitemId: item.qitemId,
      actorSession: "owner@rig",
      state,
      ...(state === "done" ? { closureReason: "no-follow-on" as const } : {}),
      ...(state === "handed-off"
        ? { closureReason: "handed_off_to" as const, closureTarget: "review@rig" }
        : {}),
    });
    return item.qitemId;
  }

  function update(qitemId: string, body: Record<string, unknown>) {
    return app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-OpenRig-Session": "auditor@rig" },
      body: JSON.stringify(body),
    });
  }

  it.each([
    "same-state specimen note",
    "testimony specimen note",
  ])("在 handed-off row 上追加 '%s'，且不改变该 row 的任何字节", async (note) => {
    const qitemId = await createTerminal("handed-off");
    const before = db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(qitemId);

    const response = await update(qitemId, { transitionNote: note });

    expect(response.status).toBe(200);
    const after = db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(qitemId);
    expect(after).toEqual(before);
    const transitions = repo.transitionLog.listForQitem(qitemId);
    expect(transitions.at(-1)).toMatchObject({
      state: "handed-off",
      actorSession: "auditor@rig",
      transitionNote: note,
      identityProvenance: "transport:v1",
    });
  });

  it.each(["done", "canceled", "handed-off"] as const)(
    "拒绝意外的 %s -> pending reopen，并保持 row 不变",
    async (terminalState) => {
      const qitemId = await createTerminal(terminalState);
      const before = db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(qitemId);
      const transitionCount = repo.transitionLog.listForQitem(qitemId).length;

      const response = await update(qitemId, { state: "pending", transitionNote: "audit" });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: "terminal_reopen_requires_ack",
        currentState: terminalState,
        requestedState: "pending",
      });
      expect(db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(qitemId)).toEqual(before);
      expect(repo.transitionLog.listForQitem(qitemId)).toHaveLength(transitionCount);
    },
  );

  it("显式 reopen 恰好一次，并记录 acknowledgment、actor 与 note", async () => {
    const qitemId = await createTerminal("handed-off");
    const transitionCount = repo.transitionLog.listForQitem(qitemId).length;

    const response = await update(qitemId, {
      state: "pending",
      transitionNote: "repair the mistaken handoff",
      reopen: true,
    });

    expect(response.status).toBe(200);
    expect(repo.getById(qitemId)?.state).toBe("pending");
    const transitions = repo.transitionLog.listForQitem(qitemId);
    expect(transitions).toHaveLength(transitionCount + 1);
    expect(transitions.at(-1)).toMatchObject({
      state: "pending",
      actorSession: "auditor@rig",
      transitionNote: "已确认 reopen：repair the mistaken handoff",
      identityProvenance: "transport:v1",
    });
  });

  it("note 无法写入时报告错误，而非静默报告成功", async () => {
    const response = await update("qitem-missing", { transitionNote: "must persist" });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "qitem_not_found" });
  });

  it("在 terminal row 上重申相同状态属于 append，而非 row 写入", async () => {
    const qitemId = await createTerminal("canceled");
    db.prepare("UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?").run("2000-01-01T00:00:00.000Z", qitemId);
    const before = db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(qitemId);

    const result = repo.update({
      qitemId,
      actorSession: "auditor@rig",
      state: "canceled" as QueueState,
      transitionNote: "confirm cancellation",
    });

    expect(result.state).toBe("canceled");
    expect(db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(qitemId)).toEqual(before);
    expect(repo.transitionLog.listForQitem(qitemId).at(-1)?.transitionNote).toBe("confirm cancellation");
  });
});
