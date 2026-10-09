import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlNotificationDispatcher } from "../src/domain/mission-control/notification-dispatcher.js";
import type {
  NotificationAdapter,
  NotificationDeliveryResult,
  NotificationPayload,
} from "../src/domain/mission-control/notification-adapter-types.js";

class FakeAdapter implements NotificationAdapter {
  readonly mechanism = "fake";
  readonly target = "fake://test";
  calls: NotificationPayload[] = [];
  nextResult: NotificationDeliveryResult = { ok: true, ack: "fake-ok" };
  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    this.calls.push(payload);
    return this.nextResult;
  }
}

describe("MissionControlNotificationDispatcher（PL-005 阶段 B）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let adapter: FakeAdapter;
  let dispatcher: MissionControlNotificationDispatcher;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    adapter = new FakeAdapter();
    dispatcher = new MissionControlNotificationDispatcher({ db, eventBus: bus, adapter });
    dispatcher.start();
  });

  afterEach(() => {
    dispatcher.stop();
    db.close();
  });

  it("human-gate qitem 到达时派发（必选触发条件）", async () => {
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      body: "需要人工批准",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人工路由夹具）",
      evidenceRef: "proof/test-evidence.md",
    });
    // 让出事件循环，使派发器的异步处理器完成。
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.title).toContain("human-gate");
    expect(adapter.calls[0]!.tags).toContain("human-gate");
  });

  it("human-gate qitem 通知包含 Mission Control 深层链接", async () => {
    dispatcher.stop();
    dispatcher = new MissionControlNotificationDispatcher({
      db,
      eventBus: bus,
      adapter,
      missionControlBaseUrl: "http://100.95.124.51:18437",
    });
    dispatcher.start();

    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      body: "需要人工批准",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人工路由夹具）",
      evidenceRef: "proof/test-evidence.md",
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(adapter.calls[0]!.qitemRef).toBe(
      `http://100.95.124.51:18437/mission-control?view=human-gate&qitem=${encodeURIComponent(created.qitemId)}`,
    );
  });

  it("非 human-gate qitem 到达时不派发", async () => {
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "agent@rig",
      body: "智能体任务",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.calls).toHaveLength(0);
  });

  it("默认不在 action_executed 时派发（动词完成需选择加入）", async () => {
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人工路由夹具）",
      evidenceRef: "proof/test-evidence.md",
    });
    await new Promise((r) => setTimeout(r, 10));
    adapter.calls.length = 0;
    const actionLog = new MissionControlActionLog(db);
    const writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
    await writeContract.act({ verb: "approve", qitemId: created.qitemId, actorSession: "human@rig" });
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.calls).toHaveLength(0);
  });

  it("includeVerbCompletion=true 时会在 action_executed 时派发", async () => {
    dispatcher.stop();
    const dispatcher2 = new MissionControlNotificationDispatcher({
      db,
      eventBus: bus,
      adapter,
      includeVerbCompletion: true,
    });
    dispatcher2.start();
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人工路由夹具）",
      evidenceRef: "proof/test-evidence.md",
    });
    await new Promise((r) => setTimeout(r, 10));
    adapter.calls.length = 0;
    const actionLog = new MissionControlActionLog(db);
    const writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
    await writeContract.act({ verb: "approve", qitemId: created.qitemId, actorSession: "human@rig" });
    await new Promise((r) => setTimeout(r, 10));
    const verbCalls = adapter.calls.filter((c) => c.title.includes("verb 已完成"));
    expect(verbCalls).toHaveLength(1);
    dispatcher2.stop();
  });

  it("成功时发出 mission_control.notification_sent", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人工路由夹具）",
      evidenceRef: "proof/test-evidence.md",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.find((e) => e.type === "mission_control.notification_sent")).toBeDefined();
  });

  it("适配器返回 ok=false 时发出 mission_control.notification_failed（尽力而为；底层动作继续）", async () => {
    adapter.nextResult = { ok: false, error: "ntfy POST 503" };
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人工路由夹具）",
      evidenceRef: "proof/test-evidence.md",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.find((e) => e.type === "mission_control.notification_failed")).toBeDefined();
    // 底层队列项仍存在（通知失败不会撤销持久变更）。
    expect(queueRepo.getById(created.qitemId)).not.toBeNull();
  });

  it("对同一 qitem 去重（重新发出时不产生重复通知）", async () => {
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      body: "x",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人工路由夹具）",
      evidenceRef: "proof/test-evidence.md",
    });
    await new Promise((r) => setTimeout(r, 10));
    // 为同一 qitem 重新发出合成 queue.created 事件（防御性去重）。
    bus.emit({
      type: "queue.created",
      qitemId: created.qitemId,
      sourceSession: "src@rig",
      destinationSession: "human@rig",
      priority: "routine",
      tier: "human-gate",
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.calls).toHaveLength(1);
  });

  it("sendTest 通过适配器派发合成通知", async () => {
    const result = await dispatcher.sendTest();
    expect(result.ok).toBe(true);
    expect(result.mechanism).toBe("fake");
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]!.title).toContain("测试");
  });
});
