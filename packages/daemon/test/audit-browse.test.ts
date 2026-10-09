import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";

describe("MissionControlAuditBrowse（PL-005 Phase B，只读）", () => {
  let db: Database.Database;
  let log: MissionControlActionLog;
  let audit: MissionControlAuditBrowse;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema]);
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-1', '2026-05-04T01:00:00Z', '2026-05-04T01:00:00Z', 'a@r', 'b@r', 'pending', 'routine', 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-2', '2026-05-04T02:00:00Z', '2026-05-04T02:00:00Z', 'a@r', 'b@r', 'pending', 'routine', 'x')`,
    ).run();
    log = new MissionControlActionLog(db);
    audit = new MissionControlAuditBrowse(db);
    // 为 q-1 和 q-2 播种动词、执行者和时间各异的动作。
    log.record({ actionVerb: "approve", qitemId: "q-1", actorSession: "alice@r", actedAt: "2026-05-04T03:00:00.000Z" });
    log.record({ actionVerb: "deny", qitemId: "q-1", actorSession: "alice@r", actedAt: "2026-05-04T03:01:00.000Z" });
    log.record({ actionVerb: "approve", qitemId: "q-2", actorSession: "bob@r", actedAt: "2026-05-04T03:02:00.000Z" });
    log.record({ actionVerb: "annotate", qitemId: "q-2", actorSession: "alice@r", actedAt: "2026-05-04T03:03:00.000Z", annotation: "test" });
  });

  afterEach(() => db.close());

  it("无筛选查询按 acted_at 降序返回所有记录", () => {
    const result = audit.query({});
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]!.actedAt).toBe("2026-05-04T03:03:00.000Z");
    expect(result.rows[3]!.actedAt).toBe("2026-05-04T03:00:00.000Z");
  });

  it("按 qitem_id 精确筛选", () => {
    const result = audit.query({ qitemId: "q-1" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.qitemId === "q-1")).toBe(true);
  });

  it("按 action_verb 精确筛选", () => {
    const result = audit.query({ actionVerb: "approve" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.actionVerb === "approve")).toBe(true);
  });

  it("按 actor_session 精确筛选", () => {
    const result = audit.query({ actorSession: "alice@r" });
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.actorSession === "alice@r")).toBe(true);
  });

  it("按 since 筛选（acted_at >= since）", () => {
    const result = audit.query({ since: "2026-05-04T03:02:00.000Z" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.actedAt >= "2026-05-04T03:02:00.000Z")).toBe(true);
  });

  it("按 until 筛选（acted_at <= until）", () => {
    const result = audit.query({ until: "2026-05-04T03:01:00.000Z" });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.actedAt <= "2026-05-04T03:01:00.000Z")).toBe(true);
  });

  it("同时按 since 和 until 筛选范围", () => {
    const result = audit.query({
      since: "2026-05-04T03:01:00.000Z",
      until: "2026-05-04T03:02:00.000Z",
    });
    expect(result.rows).toHaveLength(2);
  });

  it("以结构化错误拒绝未知 action_verb", () => {
    expect(() => audit.query({ actionVerb: "totally-bogus" })).toThrow(/totally-bogus/);
  });

  it("分页遵守 limit，并设置 has_more 与 next_before_id", () => {
    const page1 = audit.query({ limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextBeforeId).not.toBeNull();
    const page2 = audit.query({ limit: 2, beforeId: page1.nextBeforeId! });
    expect(page2.rows).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextBeforeId).toBeNull();
  });

  it("限制 limit 范围：大于 200 取 200，小于 1 取 1", () => {
    const r1 = audit.query({ limit: 999 });
    expect(r1.rows.length).toBeLessThanOrEqual(200);
    const r2 = audit.query({ limit: 0 });
    expect(r2.rows.length).toBeLessThanOrEqual(1);
  });

  it("只读 API 表面不含 insert/update/delete 方法", () => {
    const proto = Object.getPrototypeOf(audit) as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(proto);
    expect(names).not.toContain("insert");
    expect(names).not.toContain("update");
    expect(names).not.toContain("delete");
    expect(names).not.toContain("record");
  });
});
