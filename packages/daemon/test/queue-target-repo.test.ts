// PL-007 Workspace Primitive v0——queue_items.target_repo 往返测试。
//
// 固定项：
//   - 带 targetRepo 创建时持久化，并通过 getById 往返
//   - list 按 targetRepo 筛选
//   - 未覆盖时 handoff 继承 source 的 targetRepo
//   - 未覆盖时 handoff-and-complete 继承 source 的 targetRepo；显式 override 胜出
//   - migrate 运行后存在 migration 038 的列

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";

let db: Database.Database;
let repo: QueueRepository;

beforeEach(() => {
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema, outboxEntriesSchema]);
  repo = new QueueRepository(db, new EventBus(db));
  // W1 MF2：意图 nudge 的 terminal handoff 需要已附加 wake-intent store。
  repo.attachOutbox(new OutboxHandler(db));
});

describe("queue target_repo（PL-007）", () => {
  it("migration 038 添加 target_repo 列", () => {
    const cols = db.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "target_repo")).toBe(true);
  });

  it("create 持久化 target_repo，getById 可往返读取", async () => {
    const created = await repo.create({
      sourceSession: "alice@rigA",
      destinationSession: "bob@rigA",
      body: "test",
      targetRepo: "openrig",
    });
    expect(created.targetRepo).toBe("openrig");
    const fetched = repo.getById(created.qitemId);
    expect(fetched?.targetRepo).toBe("openrig");
  });

  it("不带 targetRepo 的 create 持久化 null", async () => {
    const created = await repo.create({
      sourceSession: "alice@rigA",
      destinationSession: "bob@rigA",
      body: "test",
    });
    expect(created.targetRepo).toBeNull();
  });

  it("list 按 targetRepo 筛选", async () => {
    await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "x", targetRepo: "openrig" });
    await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "y", targetRepo: "internal" });
    await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "z" });
    const filtered = repo.list({ targetRepo: "openrig" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.targetRepo).toBe("openrig");
  });

  it("未覆盖时 handoff 继承 source 的 targetRepo", async () => {
    const src = await repo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "openrig",
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@r",
      toSession: "c@r",
    });
    expect(result.created.targetRepo).toBe("openrig");
  });

  it("handoff 的显式 targetRepo 覆盖 source 值", async () => {
    const src = await repo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "openrig",
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@r",
      toSession: "c@r",
      targetRepo: "internal",
    });
    expect(result.created.targetRepo).toBe("internal");
  });

  it("未覆盖时 handoffAndComplete 继承 source 的 targetRepo", async () => {
    const src = await repo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "openrig",
    });
    const result = await repo.handoffAndComplete({
      qitemId: src.qitemId,
      fromSession: "b@r",
      toSession: "c@r",
    });
    expect(result.created.targetRepo).toBe("openrig");
    expect(result.closed.state).toBe("done");
  });

  it("缺少 migration 038 的 legacy fixture 可优雅降级（不持久化 target_repo，也不抛错）", async () => {
    const legacyDb = createDb();
    migrate(legacyDb, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    const legacyRepo = new QueueRepository(legacyDb, new EventBus(legacyDb));
    // schema 检测应为 false；INSERT 使用 legacy 语句；targetRepo 输入被静默丢弃。
    const created = await legacyRepo.create({
      sourceSession: "a@r",
      destinationSession: "b@r",
      body: "x",
      targetRepo: "openrig",
    });
    expect(created.targetRepo).toBeNull();
  });
});
