import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import {
  archiveAgedTerminalTransitions,
  pruneWatchdogHistory,
  runQueueRetentionSweep,
  DEFAULT_TERMINAL_STATES,
  type RetentionOptions,
} from "../src/domain/queue-retention.js";

// OPR.0.4.6.FS-1 W2——queue-retention 单元测试。手工构建最小 schema：只包含保留函数
// 会访问的列，不设外键，以隔离测试保留逻辑。表名和列名对应迁移 024/025/054/034/032。
// 完整 schema 的字节一致性和真实事件数据行为由 W3 VM 证明。
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE queue_transitions (
      transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
      qitem_id TEXT NOT NULL, ts TEXT NOT NULL, state TEXT NOT NULL,
      transition_note TEXT, actor_session TEXT NOT NULL,
      closure_reason TEXT, closure_target TEXT
    );
    CREATE TABLE queue_transitions_archive (
      transition_id INTEGER PRIMARY KEY, qitem_id TEXT NOT NULL, ts TEXT NOT NULL,
      state TEXT NOT NULL, transition_note TEXT, actor_session TEXT NOT NULL,
      closure_reason TEXT, closure_target TEXT, archived_at TEXT NOT NULL
    );
    CREATE TABLE workflow_instances (
      instance_id TEXT PRIMARY KEY, workflow_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      current_frontier_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE watchdog_history (
      history_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, evaluated_at TEXT NOT NULL
    );
  `);
  // 51-08 A2：扫描现在会排空 usage_samples 处理；fixture 安装真实迁移
  //（模块契约是“迁移后运行”）。
  db.exec(usageSamplesSchema.sql);
  return db;
}

function seedQitem(db: Database.Database, id: string, state: string, tsList: string[]): void {
  db.prepare("INSERT INTO queue_items (qitem_id, state) VALUES (?, ?)").run(id, state);
  const ins = db.prepare(
    "INSERT INTO queue_transitions (qitem_id, ts, state, actor_session) VALUES (?, ?, ?, ?)",
  );
  for (const ts of tsList) ins.run(id, ts, state, "seat@rig");
}

const count = (db: Database.Database, sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { c: number }).c;

const NOW = "2026-07-08T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z"; // > 30d before NOW (aged)
const RECENT = "2026-07-07T00:00:00.000Z"; // < 30d before NOW (fresh)
const opts = (over: Partial<RetentionOptions> = {}): RetentionOptions => ({ nowIso: NOW, ...over });

describe("queue-retention — archiveAgedTerminalTransitions", () => {
  it("归档最后一次转换早于窗口的终态 qitem（移动而非删除）", () => {
    const db = makeDb();
    seedQitem(db, "q-done-old", "done", [OLD, OLD]);
    const r = archiveAgedTerminalTransitions(db, opts());
    expect(r.archivedQitems).toBe(1);
    expect(r.archivedRows).toBe(2);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-done-old")).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions_archive WHERE qitem_id=?", "q-done-old")).toBe(2);
    // 出处：archived_at 写入 nowIso，原始时间戳保留（移动而非重写）。
    const row = db
      .prepare("SELECT archived_at, ts FROM queue_transitions_archive WHERE qitem_id=? LIMIT 1")
      .get("q-done-old") as { archived_at: string; ts: string };
    expect(row.archived_at).toBe(NOW);
    expect(row.ts).toBe(OLD);
  });

  it("不归档最后一次转换仍在窗口内的终态 qitem", () => {
    const db = makeDb();
    seedQitem(db, "q-done-recent", "done", [OLD, RECENT]); // MAX(ts)=RECENT → not aged
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-done-recent")).toBe(2);
  });

  it("活动 frontier 不变量：无论多旧都绝不归档非终态 qitem", () => {
    const db = makeDb();
    seedQitem(db, "q-inprogress-old", "in-progress", [OLD, OLD]);
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-inprogress-old")).toBe(2);
  });

  it("也归档 handed-off（完整终态集合，架构 D3 细化——不只 done）", () => {
    const db = makeDb();
    seedQitem(db, "q-handed", "handed-off", [OLD]);
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(1);
    expect([...DEFAULT_TERMINAL_STATES]).toEqual(["done", "handed-off"]);
  });

  // P2——具名的当前空真 frontier 存活性测试（架构 P2 固定）。
  it("P2 frontier 存活性（当前为空真）：活动工作流 frontier 引用的终态旧 qitem 不归档；实例终态后再归档", () => {
    const db = makeDb();
    seedQitem(db, "q-frontier", "done", [OLD]);
    // 活动工作流实例在其 frontier 中引用 q-frontier。
    db.prepare(
      "INSERT INTO workflow_instances (instance_id, workflow_name, status, current_frontier_json) VALUES (?, ?, ?, ?)",
    ).run("wi-1", "wf", "active", JSON.stringify(["q-frontier"]));
    // 已守卫：实例存活时，NOT EXISTS 会排除它。
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-frontier")).toBe(1);
    // 将实例切为终态 completed 且 frontier 为空，即不再存活，随后归档。
    db.prepare("UPDATE workflow_instances SET status='completed', current_frontier_json='[]' WHERE instance_id=?").run("wi-1");
    expect(archiveAgedTerminalTransitions(db, opts()).archivedQitems).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id=?", "q-frontier")).toBe(0);
  });

  it("有界批次：遵守 batchSize（每次最多返回 batchSize 个 qitem）", () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) seedQitem(db, `q${i}`, "done", [OLD]);
    const r = archiveAgedTerminalTransitions(db, opts({ batchSize: 2 }));
    expect(r.archivedQitems).toBe(2);
    expect(count(db, "SELECT COUNT(*) c FROM queue_items q WHERE EXISTS (SELECT 1 FROM queue_transitions t WHERE t.qitem_id=q.qitem_id)", )).toBe(3);
  });
});

describe("queue-retention — pruneWatchdogHistory", () => {
  const insHist = (db: Database.Database) =>
    db.prepare("INSERT INTO watchdog_history (history_id, job_id, evaluated_at) VALUES (?, ?, ?)");

  it("删除早于窗口且超出每个 job 保留 K 条限制的记录，并保留最近 K 条", () => {
    const db = makeDb();
    const ins = insHist(db);
    ins.run("a1", "jobA", "2026-01-01T00:00:00.000Z");
    ins.run("a2", "jobA", "2026-01-02T00:00:00.000Z");
    ins.run("a3", "jobA", "2026-01-03T00:00:00.000Z");
    const r = pruneWatchdogHistory(db, opts({ watchdogRetentionDays: 14, watchdogKeepPerJob: 2 }));
    expect(r.deletedRows).toBe(1); // only a1 (oldest, rank 3 > keep 2, older than 14d)
    const remaining = (db.prepare("SELECT history_id FROM watchdog_history WHERE job_id='jobA' ORDER BY evaluated_at").all() as Array<{ history_id: string }>).map((x) => x.history_id);
    expect(remaining).toEqual(["a2", "a3"]);
  });

  it("即使早于窗口也保留最近 K 条记录（每 job 保留策略优先）", () => {
    const db = makeDb();
    insHist(db).run("b1", "jobB", "2026-01-01T00:00:00.000Z");
    expect(pruneWatchdogHistory(db, opts({ watchdogKeepPerJob: 50 })).deletedRows).toBe(0);
  });
});

describe("queue-retention — runQueueRetentionSweep", () => {
  it("以有界批次排空两轮处理并报告摘要", async () => {
    const db = makeDb();
    seedQitem(db, "q1", "done", [OLD]);
    seedQitem(db, "q2", "handed-off", [OLD]);
    db.prepare("INSERT INTO watchdog_history (history_id, job_id, evaluated_at) VALUES ('h1','j','2026-01-01T00:00:00.000Z')").run();
    const s = await runQueueRetentionSweep(db, opts({ watchdogKeepPerJob: 0, batchSize: 1 }));
    expect(s.archivedQitems).toBe(2); // both terminal qitems archived across bounded batches
    expect(s.watchdogDeleted).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM queue_transitions")).toBe(0);
  });
});

// ——51-08 A2（计划锁定 rev-1，产品决策 2：14 天滚动后删除，可调）——
// usage_samples 是遥测数据（遵循 watchdog_history 契约：普通有界 DELETE，无审计归档）。
// 席位空闲超过窗口后会丢弃记录，查询表面如实显示 unknown，绝不伪造最后一个值。
// 红灯优先：在 pruneUsageSamples 存在前编写。
import { pruneUsageSamples, RETENTION_DEFAULTS } from "../src/domain/queue-retention.js";

function makeUsageDb(): Database.Database {
  return makeDb(); // makeDb installs the REAL 062 migration
}

function seedSample(db: Database.Database, seat: string, capturedAt: string): void {
  db.prepare(
    `INSERT INTO usage_samples (lane, seat_session, captured_at, used_percentage)
     VALUES ('context', ?, ?, 10)`,
  ).run(seat, capturedAt);
}

describe("51-08 A2 — pruneUsageSamples", () => {
  const NOW = "2026-08-21T00:00:00.000Z"; // cutoff at 14d default = 2026-08-07T00:00:00.000Z
  const count = (db: Database.Database) =>
    (db.prepare("SELECT COUNT(*) AS n FROM usage_samples").get() as { n: number }).n;

  it("默认值为产品裁决的 14 天", () => {
    expect(RETENTION_DEFAULTS.usageSamplesRetentionDays).toBe(14);
  });

  it("绝对边界双例：刚超出边界的记录删除，恰好在截止点和刚进入边界的记录保留", () => {
    const db = makeUsageDb();
    seedSample(db, "a@r", "2026-08-06T23:59:59.999Z"); // just outside → deleted
    seedSample(db, "b@r", "2026-08-07T00:00:00.000Z"); // exact cutoff → survives (< semantics)
    seedSample(db, "c@r", "2026-08-07T00:00:00.001Z"); // just inside → survives
    const res = pruneUsageSamples(db, { nowIso: NOW });
    expect(res.deletedRows).toBe(1);
    expect(count(db)).toBe(2);
    const seats = (db.prepare("SELECT seat_session AS s FROM usage_samples ORDER BY s").all() as Array<{ s: string }>).map((r) => r.s);
    expect(seats).toEqual(["b@r", "c@r"]);
  });

  it("保留窗口可调：usageSamplesRetentionDays 覆盖默认值", () => {
    const db = makeUsageDb();
    seedSample(db, "a@r", "2026-08-19T00:00:00.000Z"); // 2d old
    expect(pruneUsageSamples(db, { nowIso: NOW, usageSamplesRetentionDays: 1 }).deletedRows).toBe(1);
    expect(count(db)).toBe(0);
  });

  it("有界批次：每批最多返回 batchSize 个删除项；处理到空批次时终止循环", () => {
    const db = makeUsageDb();
    for (let i = 0; i < 7; i += 1) seedSample(db, `s${i}@r`, "2026-01-01T00:00:00.000Z");
    expect(pruneUsageSamples(db, { nowIso: NOW, batchSize: 3 }).deletedRows).toBe(3);
    expect(pruneUsageSamples(db, { nowIso: NOW, batchSize: 3 }).deletedRows).toBe(3);
    expect(pruneUsageSamples(db, { nowIso: NOW, batchSize: 3 }).deletedRows).toBe(1);
    expect(pruneUsageSamples(db, { nowIso: NOW, batchSize: 3 }).deletedRows).toBe(0);
  });

  it("扫描入口在队列处理之外同时排空 usage 处理", async () => {
    const db = makeUsageDb();
    for (let i = 0; i < 5; i += 1) seedSample(db, `s${i}@r`, "2026-01-01T00:00:00.000Z");
    seedSample(db, "fresh@r", "2026-08-20T00:00:00.000Z");
    const summary = await runQueueRetentionSweep(db, { nowIso: NOW, batchSize: 2 });
    expect(summary.usageSamplesDeleted).toBe(5);
    expect(count(db)).toBe(1); // the in-window row survives the full sweep
  });
});
