// F1（错误诚实，桌面批准轻量路径）：ERROR payload 绝不得携带
// SUCCESS 形状字段。三个 blocker 拒绝在其 meta 中携带 `blockedOn`——即
// success 形状所用同一 key——这引入了 phantom queue-block 缺陷背后的
// 字段过滤误读（三个独立样本，一类）。拒绝现将被拒值命名为
// `rejectedBlocker`；`blockedOn` 绝不出现于 error payload。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

describe("F1 —— blocker 拒绝载荷携带 rejectedBlocker，绝不携带成功结构的 blockedOn", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());

  async function refusalMeta(blockedOn: string, prep?: () => Promise<void>): Promise<{ code: string; meta: Record<string, unknown> }> {
    const row = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "target" });
    await prep?.();
    try {
      repo.update({ qitemId: row.qitemId, actorSession: "a@r", state: "blocked", blockedOn, transitionNote: "park attempt" });
    } catch (err) {
      const e = err as QueueRepositoryError;
      return { code: e.code, meta: (e.meta ?? {}) as Record<string, unknown> };
    }
    throw new Error("expected a refusal");
  }

  it("blocker_not_found：给出 rejectedBlocker，载荷中不含 blockedOn", async () => {
    const r = await refusalMeta("qitem-19990101000000-deadbeef");
    expect(r.code).toBe("blocker_not_found");
    expect(r.meta.rejectedBlocker).toBe("qitem-19990101000000-deadbeef");
    expect("blockedOn" in r.meta, "an error payload must never carry the success-shaped field").toBe(false);
  });

  it("blocker_not_live：给出 rejectedBlocker 与 blockerState，不含 blockedOn", async () => {
    const dead = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "dead blocker" });
    repo.update({ qitemId: dead.qitemId, actorSession: "a@r", state: "done", closureReason: "no-follow-on", transitionNote: "closed" });
    const r = await refusalMeta(dead.qitemId);
    expect(r.code).toBe("blocker_not_live");
    expect(r.meta.rejectedBlocker).toBe(dead.qitemId);
    expect(r.meta.blockerState).toBe("done");
    expect("blockedOn" in r.meta).toBe(false);
  });

  it("blocker_malformed：给出 rejectedBlocker，不含 blockedOn", async () => {
    const r = await refusalMeta("fold:");
    expect(r.code).toBe("blocker_malformed");
    expect(r.meta.rejectedBlocker).toBe("fold:");
    expect("blockedOn" in r.meta).toBe(false);
  });

  it("成功结构保持不变：有效 park 仍在条目上返回 blockedOn", async () => {
    const blocker = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "live blocker" });
    const row = await repo.create({ sourceSession: "a@r", destinationSession: "b@r", body: "target" });
    const updated = repo.update({ qitemId: row.qitemId, actorSession: "a@r", state: "blocked", blockedOn: blocker.qitemId, transitionNote: "parked" });
    expect(updated.state).toBe("blocked");
    expect(updated.blockedOn).toBe(blocker.qitemId);
  });
});
