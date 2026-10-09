import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { findQueueRecovery, recoveryTag } from "../src/domain/queue-recovery.js";
import { queueRecoveryOwnsWake, readWakeLadderBackstop } from "../src/domain/queue-wake-ladder.js";

describe("recovery 查询工作与 fresh disposition", () => {
  let db: Database.Database, repo: QueueRepository;
  const at = "2026-09-11T10:00:00.000Z";
  function row(id: string, state = "pending", tags: string | null = "[]", updated = at) {
    db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body)
      VALUES (?, ?, ?, 'sender@r', 'worker@r', ?, ?, 'exact retained body')`).run(id, at, updated, state, tags);
  }
  function transition(id: string, ts = at) {
    db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session,transition_note) VALUES (?,?,'pending','owner@r','actual owner change')").run(id, ts);
  }
  beforeEach(() => { db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); repo = new QueueRepository(db, new EventBus(db)); });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it("只读取一次完整 queue 行，不为其 delivery receipt 再做一次无用 recovery 扫描", () => {
    row("source"); row("arbitrary recovery", "blocked", JSON.stringify([recoveryTag("source")]));
    const internal = repo as unknown as { rowToItem: (row: unknown, waiting?: boolean) => unknown };
    const project = internal.rowToItem.bind(repo);
    const legacy = vi.spyOn(internal, "rowToItem").mockImplementation((r) => project(r, true));
    const expected = repo.getById("source"); legacy.mockRestore();
    const prepare = db.prepare.bind(db); const calls: unknown[] = [];
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.includes("json_each(tags)") && sql.includes("ts_updated DESC, qitem_id DESC LIMIT 1")) calls.push(sql);
      return prepare(sql);
    });
    expect(repo.getById("source")).toEqual(expected);
    expect(expected?.waiting?.nextBackstop.recovery).toEqual({ qitemId: "arbitrary recovery", state: "blocked" });
    expect(calls).toHaveLength(1);
  });

  it.each([
    (tag: string) => JSON.stringify([tag]),
    (tag: string) => JSON.stringify([tag]).replace("recovery", "\\u0072ecovery"),
    (tag: string) => JSON.stringify({ member: tag }),
    (tag: string) => JSON.stringify(tag),
  ])("保留精确解码的 membership 和任意转义 identity", (encode) => {
    const id = "odd'\"\\\n%_ id"; row(id);
    row("null-tags", "pending", null); row("malformed-tags", "pending", "{");
    row("substring", "pending", JSON.stringify([recoveryTag(id) + "suffix"]));
    row("unrelated", "pending", JSON.stringify([recoveryTag("other")]));
    row("not-generated", "blocked", encode(recoveryTag(id)));
    expect(findQueueRecovery(db, id)).toEqual({ qitemId: "not-generated", state: "blocked" });
    expect(findQueueRecovery(db, "missing")).toBeNull();
  });

  it("依次优先 active recovery、更新时间、ID；共享 membership 保持精确", () => {
    row("source"); row("other");
    const tags = JSON.stringify([recoveryTag("source"), recoveryTag("other")]);
    row("z-terminal", "done", tags, "2026-09-11T12:00:00Z");
    row("a", "pending", tags); row("b", "blocked", tags);
    expect(findQueueRecovery(db, "source")).toEqual({ qitemId: "b", state: "blocked" });
    db.prepare("UPDATE queue_items SET ts_updated='2026-09-11T11:00:00Z',state='in-progress' WHERE qitem_id='a'").run();
    expect(findQueueRecovery(db, "other")).toEqual({ qitemId: "a", state: "in-progress" });
  });

  it.each(["transition-id", "transition-time", "failed-attempt"])("后续 %s 会使 terminal disposition 失效，且不跨读取缓存", (reason) => {
    row("source"); row("disposition", "done", JSON.stringify([recoveryTag("source")]));
    transition("source", "2026-09-11T09:00:00Z"); transition("disposition");
    expect(findQueueRecovery(db, "source")).toEqual({ qitemId: "disposition", state: "done" });
    expect(readWakeLadderBackstop(db, "source")?.mechanism).toBe("queue-recovery:resolved");
    if (reason === "transition-id") transition("source", "2026-09-11T09:00:00Z");
    if (reason === "transition-time") {
      db.prepare("DELETE FROM queue_transitions WHERE qitem_id='disposition'").run();
      db.prepare("UPDATE queue_transitions SET ts='2026-09-11T11:00:00Z' WHERE qitem_id='source'").run();
    }
    if (reason === "failed-attempt") db.prepare("UPDATE queue_items SET last_nudge_result='failed:fixture',last_nudge_attempt='2026-09-11T11:00:00Z' WHERE qitem_id='source'").run();
    expect(findQueueRecovery(db, "source")).toBeNull();
    expect(readWakeLadderBackstop(db, "source")).toBeNull();
    db.prepare("UPDATE queue_items SET state='blocked' WHERE qitem_id='disposition'").run();
    expect(repo.getById("source")?.waiting?.nextBackstop.recovery).toEqual({ qitemId: "disposition", state: "blocked" });
    expect(queueRecoveryOwnsWake(db, repo.getById("source"))).toBe(true);
    db.prepare("UPDATE queue_items SET tags='[]' WHERE qitem_id='disposition'").run();
    expect(queueRecoveryOwnsWake(db, repo.getById("source"))).toBe(false);
  });

  it("保持独立 handle 新鲜，并通过 queue 接口传播查询错误", () => {
    row("source"); row("disposition", "pending", JSON.stringify([recoveryTag("source")]));
    const other = new Database(":memory:");
    try { migrate(other, ALL_MIGRATIONS); expect(findQueueRecovery(other, "source")).toBeNull(); } finally { other.close(); }
    expect(findQueueRecovery(db, "source")?.qitemId).toBe("disposition");
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      if (sql.includes("json_each(tags)") && sql.includes("ts_updated DESC, qitem_id DESC LIMIT 1")) throw new Error("fixture lookup unavailable");
      return prepare(sql);
    });
    expect(() => repo.getById("source")).toThrow("fixture lookup unavailable");
    expect(() => repo.list({ state: "pending" })).toThrow("fixture lookup unavailable");
  });
});
