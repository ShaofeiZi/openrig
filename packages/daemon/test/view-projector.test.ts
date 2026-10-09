import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import {
  ViewProjector,
  ViewProjectorError,
  BUILT_IN_VIEW_NAMES,
} from "../src/domain/view-projector.js";

describe("ViewProjector（PL-004 阶段 B；L5 只读投影）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let projector: ViewProjector;

  beforeEach(async () => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, viewsCustomSchema]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    projector = new ViewProjector(db, bus);
    // 为视图植入待投影的实时 qitem。
    await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "planning@product-lab",
      body: "设计新功能",
      priority: "routine",
      tier: "deep",
      nudge: false,
    });
    await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "planning@product-lab",
      body: "修复关键缺陷",
      priority: "critical",
      tier: "fast",
      nudge: false,
    });
    const blocked = await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "delivery@product-lab",
      body: "被阻塞的工作",
      nudge: false,
    });
    queueRepo.update({
      qitemId: blocked.qitemId,
      actorSession: "delivery@product-lab",
      state: "blocked",
      transitionNote: "被依赖项阻塞",
    });
    // Fixture rig（默认应排除）。
    await queueRepo.create({
      sourceSession: "alice@test-rig",
      destinationSession: "bob@test-rig",
      body: "fixture 工作",
      nudge: false,
    });
  });

  afterEach(() => {
    db.close();
    delete process.env.OPENRIG_VIEW_INCLUDE_FIXTURES;
  });

  it("BUILT_IN_VIEW_NAMES 包含预期的全部 8 个名称", () => {
    expect([...BUILT_IN_VIEW_NAMES]).toEqual([
      "recently-active",
      "founder",
      "pod-load",
      "escalations",
      "held",
      "activity",
      "pickup",
      "execution",
    ]);
  });

  it("show recently-active 按 ts_updated 降序返回活跃状态 qitem，并排除 fixture", () => {
    const result = projector.show("recently-active");
    expect(result.viewName).toBe("recently-active");
    expect(result.rowCount).toBe(3); // 3 个 product-lab qitem；已排除 fixture
    expect(result.rows.every((r) => !String(r.destination_session).includes("@test-"))).toBe(true);
  });

  it("show founder 返回 critical 优先级或 fast/critical 层级的 qitem", () => {
    const result = projector.show("founder");
    expect(result.rowCount).toBe(1); // 只有 critical/fast qitem
    expect(result.rows[0]!.priority).toBe("critical");
  });

  it("show pod-load 按 destination_session 分组计数", () => {
    const result = projector.show("pod-load");
    expect(result.rowCount).toBe(2); // planning@... 和 delivery@...
    const podMap = new Map<string, number>(result.rows.map((r) => [String(r.pod), Number(r.active_count)]));
    expect(podMap.get("planning@product-lab")).toBe(2);
    expect(podMap.get("delivery@product-lab")).toBe(1);
  });

  it("show held 返回 blocked qitem", () => {
    const result = projector.show("held");
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]!.state).toBe("blocked");
  });

  it("show escalations 返回 closure_reason='escalation' 的 qitem", () => {
    // fixture 中没有 escalation；应返回 0。
    const result = projector.show("escalations");
    expect(result.rowCount).toBe(0);
  });

  it("show activity 返回与活跃 qitem 关联的近期转换", () => {
    const result = projector.show("activity");
    expect(result.rowCount).toBeGreaterThan(0);
    // 每行都有来自 queue_transitions 的 transition_id。
    expect(result.rows[0]).toHaveProperty("transition_id");
  });

  it("OPENRIG_VIEW_INCLUDE_FIXTURES=1 时包含 fixture rig", () => {
    process.env.OPENRIG_VIEW_INCLUDE_FIXTURES = "1";
    const result = projector.show("recently-active");
    expect(result.rowCount).toBe(4); // 包括 fixture qitem
  });

  it("带 --rig 筛选条件的 show 按会话后缀匹配缩小范围", () => {
    const result = projector.show("recently-active", { rig: "product-lab" });
    expect(result.rowCount).toBe(3); // 全部 3 个 product-lab qitem
  });

  it("show <unknown-view> 抛出 view_not_found", () => {
    expect(() => projector.show("nonexistent-view")).toThrow(ViewProjectorError);
  });

  it("registerCustomView 接受任意 SQL，且可通过 show 查询", () => {
    const view = projector.registerCustomView({
      viewName: "all-pending",
      definition: "SELECT qitem_id, destination_session FROM queue_items WHERE state = 'pending'",
      registeredBySession: "operator@rig",
    });
    expect(view.viewId).toMatch(/^[0-9A-Z]{26}$/);
    const result = projector.show("all-pending");
    expect(result.viewName).toBe("all-pending");
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it("registerCustomView 拒绝保留的内置名称", () => {
    try {
      projector.registerCustomView({
        viewName: "recently-active",
        definition: "SELECT 1",
        registeredBySession: "operator@rig",
      });
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ViewProjectorError);
      expect((err as ViewProjectorError).code).toBe("view_name_reserved");
    }
  });

  it("registerCustomView 重新注册时更新定义（不重复）", () => {
    const first = projector.registerCustomView({
      viewName: "my-view",
      definition: "SELECT 1 as a",
      registeredBySession: "operator@rig",
    });
    const second = projector.registerCustomView({
      viewName: "my-view",
      definition: "SELECT 2 as b",
      registeredBySession: "operator@rig",
    });
    expect(second.viewId).toBe(first.viewId);
    expect(second.definition).toContain("SELECT 2");
    expect(projector.listCustomViews()).toHaveLength(1);
  });

  it("list 返回内置视图名称和自定义视图记录", () => {
    projector.registerCustomView({
      viewName: "my-view",
      definition: "SELECT 1",
      registeredBySession: "operator@rig",
    });
    const result = projector.list();
    expect(result.builtIn).toEqual([
      "recently-active",
      "founder",
      "pod-load",
      "escalations",
      "held",
      "activity",
      "pickup",
      "execution",
    ]);
    expect(result.custom).toHaveLength(1);
    expect(result.custom[0]!.viewName).toBe("my-view");
  });

  it("notifyViewChanged 为外层 drain 持久化 view.changed，而不直接投递", () => {
    const captured: unknown[] = [];
    bus.subscribe((e) => captured.push(e));
    projector.notifyViewChanged("recently-active", "queue.created");
    expect(captured).toEqual([]);
    expect(bus.replayAll(0).at(-1)).toMatchObject({
      type: "view.changed",
      viewName: "recently-active",
      cause: "queue.created",
    });
  });
});
