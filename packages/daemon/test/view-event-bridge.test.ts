import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { classificationFieldsAndAttemptsSchema } from "../src/db/migrations/086_classification_fields_and_attempts.js";
import { classificationIdentityProvenanceSchema } from "../src/db/migrations/089_classification_identity_provenance.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import { ProjectClassifier } from "../src/domain/project-classifier.js";
import { wireViewEventBridge } from "../src/domain/view-event-bridge.js";
import type { PersistedEvent } from "../src/domain/types.js";

/**
 * View event bridge tests (PL-004 Phase B R1; closes guard BLOCKER 2).
 *
 * bridge 订阅 coordination state-mutation 事件，并经
 * ViewProjector.notifyViewChanged 为受影响内置 view 发出 view.changed。
 * 无此，/api/views/:name/sse 永不收到变更通知。
 */

describe("view-event-bridge（PL-004 Phase B R1；BLOCKER 2 修复）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let inbox: InboxHandler;
  let streamStore: StreamStore;
  let projector: ViewProjector;
  let leaseMgr: ClassifierLeaseManager;
  let classifier: ProjectClassifier;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema,
      streamItemsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema,
      classifierLeasesSchema, projectClassificationsSchema, classificationFieldsAndAttemptsSchema,
      viewsCustomSchema, classificationIdentityProvenanceSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    streamStore = new StreamStore(db, bus);
    projector = new ViewProjector(db, bus);
    leaseMgr = new ClassifierLeaseManager(db, bus);
    classifier = new ProjectClassifier(db, bus, leaseMgr);
    captured = [];
    bus.subscribe((e) => captured.push(e));
    wireViewEventBridge(bus, projector);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function viewChangedEvents(): Array<{ viewName: string; cause: string }> {
    return captured
      .filter((e) => e.type === "view.changed")
      .map((e) => ({ viewName: (e as { viewName: string }).viewName, cause: (e as { cause: string }).cause }));
  }

  it("queue.created 为 recently-active + founder + pod-load + activity 触发 view.changed", async () => {
    await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    const events = viewChangedEvents();
    const viewNames = events.map((e) => e.viewName);
    expect(viewNames).toContain("recently-active");
    expect(viewNames).toContain("founder");
    expect(viewNames).toContain("pod-load");
    expect(viewNames).toContain("activity");
    // 每个 event 的 cause = source event type。
    expect(events.every((e) => e.cause === "queue.created")).toBe(true);
  });

  it("queue.handed_off 为 recently-active + pod-load + activity 触发 view.changed", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    captured.length = 0; // reset to focus on the handoff event
    await queueRepo.handoff({
      qitemId: item.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      nudge: false,
    });
    const events = viewChangedEvents();
    expect(events.some((e) => e.viewName === "recently-active" && e.cause === "queue.handed_off")).toBe(true);
    expect(events.some((e) => e.viewName === "pod-load" && e.cause === "queue.handed_off")).toBe(true);
    expect(events.some((e) => e.viewName === "activity" && e.cause === "queue.handed_off")).toBe(true);
    // queue.handed_off 还会为新 qitem 发出 queue.created（它会触发自己的 view.changed batch）。
  });

  it("R2：queue.updated 为全部 6 个 built-in view 触发 view.changed（state mutation 可能影响任意 view）", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    captured.length = 0;
    queueRepo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    const events = viewChangedEvents();
    const updateViewNames = events
      .filter((e) => e.cause === "queue.updated")
      .map((e) => e.viewName)
      .sort();
    // R2 mapping：queue.updated → 全部 6 个 built-in view。
    expect(updateViewNames).toEqual([
      "activity",
      "escalations",
      "founder",
      "held",
      "pod-load",
      "recently-active",
    ]);
  });

  it("R2：pending → blocked transition 的 queue.updated 为 held + activity（及其他 view）触发 view.changed", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test-blocked",
      nudge: false,
    });
    captured.length = 0;
    queueRepo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "blocked",
      transitionNote: "blocked on dep",
    });
    const events = viewChangedEvents();
    const updateViews = events.filter((e) => e.cause === "queue.updated").map((e) => e.viewName);
    // held + activity 在语义上受影响最大，但保守地触发全部 6 个 view。
    expect(updateViews).toContain("held");
    expect(updateViews).toContain("activity");
  });

  it("queue.claimed 为 recently-active + pod-load + activity 触发 view.changed", async () => {
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test",
      nudge: false,
    });
    captured.length = 0;
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    const events = viewChangedEvents();
    const claimEvents = events.filter((e) => e.cause === "queue.claimed");
    expect(claimEvents.map((e) => e.viewName).sort()).toEqual(["activity", "pod-load", "recently-active"]);
  });

  it("inbox.absorbed 为 recently-active + pod-load + activity 触发 view.changed", async () => {
    const drop = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "test",
    });
    captured.length = 0;
    await inbox.absorb(drop.inboxId, "bob@rig");
    const events = viewChangedEvents();
    const absorbEvents = events.filter((e) => e.cause === "inbox.absorbed");
    expect(absorbEvents.map((e) => e.viewName).sort()).toEqual(["activity", "pod-load", "recently-active"]);
  });

  it("inbox.denied 只为 activity 触发 view.changed", () => {
    const drop = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "test",
    });
    captured.length = 0;
    inbox.deny(drop.inboxId, "bob@rig", "off-topic");
    const events = viewChangedEvents();
    const denyEvents = events.filter((e) => e.cause === "inbox.denied");
    expect(denyEvents.map((e) => e.viewName)).toEqual(["activity"]);
  });

  it("project.classified 只为 activity 触发 view.changed", () => {
    streamStore.emit({ streamItemId: "stream-1", sourceSession: "discovery@rig", body: "x" });
    leaseMgr.acquire("alice@rig");
    captured.length = 0;
    classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      classificationType: "idea",
    });
    const events = viewChangedEvents();
    const classifyEvents = events.filter((e) => e.cause === "project.classified");
    expect(classifyEvents.map((e) => e.viewName)).toEqual(["activity"]);
  });

  it("classifier.lease_acquired 不触发 view.changed（lease lifecycle 属于 project SSE，而非 view SSE）", () => {
    leaseMgr.acquire("alice@rig");
    const events = viewChangedEvents();
    expect(events.filter((e) => e.cause === "classifier.lease_acquired")).toHaveLength(0);
  });

  it("notifyViewChanged 只持久化，view.changed 不通过 bridge 回显", () => {
    projector.notifyViewChanged("recently-active", "manual-test");
    captured.length = 0;
    projector.notifyViewChanged("recently-active", "manual-test-2");
    expect(captured).toEqual([]);
    const persisted = bus.replayAll(0).filter((event) => event.type === "view.changed");
    expect(persisted).toHaveLength(2);
    expect(persisted.map((event) => event.cause)).toEqual(["manual-test", "manual-test-2"]);
  });

  it("W2b 在 re-entrant view.changed row 前 drain outer event，并恰好投递每项一次", () => {
    captured.length = 0;

    bus.withNotifyEnvelope((register) => {
      register(bus.persistWithinTransaction({
        type: "queue.handed_off",
        qitemId: "q-w2b-handoff",
        fromSession: "alice@rig",
        toSession: "bob@rig",
        closureReason: "handed_off_to",
        summary: null,
      }));
      register(bus.persistWithinTransaction({
        type: "inbox.denied",
        inboxId: "inbox-w2b-denied",
        destinationSession: "bob@rig",
        senderSession: "alice@rig",
        reason: "ordering discriminator",
      }));
    });

    expect(captured.slice(0, 2).map((event) => event.type)).toEqual([
      "queue.handed_off",
      "inbox.denied",
    ]);
    const replayed = bus.replayAll(0);
    expect(captured.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(captured.map((event) => event.seq)).toEqual(replayed.map((event) => event.seq));
    expect(new Set(captured.map((event) => event.seq)).size).toBe(captured.length);
    expect(
      captured
        .filter((event) => event.type === "view.changed")
        .map((event) => `${event.viewName}:${event.cause}`),
    ).toEqual([
      "recently-active:queue.handed_off",
      "pod-load:queue.handed_off",
      "activity:queue.handed_off",
      "activity:inbox.denied",
    ]);
  });

  it("W2b 让 drain-time delivery failure 留在 bridge best-effort persist catch 之外", () => {
    const originalNotify = bus.notifySubscribers.bind(bus);
    vi.spyOn(bus, "notifySubscribers").mockImplementation((event) => {
      if (event.type === "view.changed") throw new Error("drain delivery failed");
      originalNotify(event);
    });

    expect(() =>
      bus.withNotifyEnvelope((register) => {
        register(bus.persistWithinTransaction({
          type: "queue.created",
          qitemId: "q-w2b-delivery-error",
          sourceSession: "alice@rig",
          destinationSession: "bob@rig",
          priority: "routine",
          tier: null,
          summary: null,
        }));
      }),
    ).toThrow("drain delivery failed");
  });

  it("unsubscribe 停止 bridge", async () => {
    // 重新接线并捕获 unsubscribe 函数。
    const localCaptured: PersistedEvent[] = [];
    bus.subscribe((e) => localCaptured.push(e));
    const stop = wireViewEventBridge(bus, projector);
    stop();
    await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "test-after-unsubscribe",
      nudge: false,
    });
    // beforeEach 中的主 bridge 仍已接线，会发出 view.changed。刚停止的 local bridge 不会发出。
    // 验证只触发一个 bridge（而非两个）：activity 应恰好出现一次。
    const activityEvents = captured.filter(
      (e) => e.type === "view.changed" && (e as { viewName: string }).viewName === "activity" && (e as { cause: string }).cause === "queue.created",
    );
    expect(activityEvents).toHaveLength(1);
  });
});
