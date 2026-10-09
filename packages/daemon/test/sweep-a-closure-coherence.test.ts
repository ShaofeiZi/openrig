// SWEEP-a（shape f2576102）——closure/blocked-field 一致性：accept path 要么生效，要么显著失败；
// 不一致字段绝不静默持久化。Admits map（根据 live schema 使用修正——workflow park writer 在
// workflow-runtime.ts:587/1013 传入 state:"blocked" + closureReason:"blocked_on"）：
// closure_reason/target 在 done 时允许，或在 blocked 且 closureReason==="blocked_on" 时允许
//（park-record 形式）；blocked_on 只在 state 为 blocked 时允许。已向 PM 呈现。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

describe("SWEEP-a——closure/blocked 一致性 guard", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let id: string;

  beforeEach(async () => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema, queueTargetRepoSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    id = (await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "x" } as never)).qitemId;
  });
  afterEach(() => db.close());

  it("state=in-progress 上的 closure_reason 被显著拒绝，不持久化任何内容", async () => {
    let err: unknown;
    try { await repo.update({ qitemId: id, actorSession: "a@rig", state: "in-progress", closureReason: "denied" } as never); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe("closure_fields_not_admitted");
    expect(repo.getById(id)!.closureReason).toBeNull(); // 无写入。
    expect(repo.getById(id)!.state).toBe("pending");
  });

  it("state=done 上的 blocked_on 被显著拒绝", async () => {
    let err: unknown;
    try { await repo.update({ qitemId: id, actorSession: "a@rig", state: "done", closureReason: "canceled", blockedOn: "x@rig" } as never); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe("blocked_on_not_admitted");
    expect(repo.getById(id)!.state).toBe("pending"); // 整个 update 被拒绝。
  });

  it("对照：done+closure 保持绿色；blocked park-record 形式保持绿色（workflow writer）", async () => {
    await repo.update({ qitemId: id, actorSession: "a@rig", state: "blocked", closureReason: "blocked_on", closureTarget: "gate@rig", blockedOn: "gate@rig" } as never);
    expect(repo.getById(id)!.state).toBe("blocked");
    expect(repo.getById(id)!.blockedOn).toBe("gate@rig");
    await repo.update({ qitemId: id, actorSession: "a@rig", state: "done", closureReason: "no-follow-on" } as never);
    expect(repo.getById(id)!.state).toBe("done");
  });
});
