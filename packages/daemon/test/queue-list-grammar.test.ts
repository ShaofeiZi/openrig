import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { QueueRepository } from "../src/domain/queue-repository.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS queue_items (
    qitem_id TEXT PRIMARY KEY,
    ts_created TEXT NOT NULL,
    ts_updated TEXT NOT NULL,
    source_session TEXT NOT NULL,
    destination_session TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'normal',
    tier TEXT,
    tags TEXT,
    blocked_on TEXT,
    handed_off_to TEXT,
    handed_off_from TEXT,
    expires_at TEXT,
    chain_of_record TEXT,
    body TEXT NOT NULL DEFAULT '',
    closure_reason TEXT,
    closure_target TEXT,
    closure_required_at TEXT,
    claimed_at TEXT,
    last_nudge_attempt TEXT,
    last_nudge_result TEXT,
    last_heartbeat TEXT,
    resolution TEXT,
    target_repo TEXT
  )`);
  return db;
}

function seed(db: Database.Database, id: string, opts: {
  source: string;
  destination: string;
  state?: string;
  body?: string;
  tags?: string[];
  tsCreated?: string;
  closureReason?: string;
  closureTarget?: string;
  handedOffFrom?: string;
}) {
  const ts = opts.tsCreated ?? new Date().toISOString();
  db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, tags, chain_of_record, closure_reason, closure_target, handed_off_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, ts, ts, opts.source, opts.destination,
    opts.state ?? "pending",
    opts.body ?? `${id} 的正文。`.repeat(20),
    opts.tags ? JSON.stringify(opts.tags) : null,
    JSON.stringify([`chain-${id}`]),
    opts.closureReason ?? null,
    opts.closureTarget ?? null,
    opts.handedOffFrom ?? null,
  );
}

describe("OPR.0.4.0.32——queue list 语法修订", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new QueueRepository(db);
  });
  afterEach(() => { db.close(); });

  // -- AC-2：current-rig scope 覆盖来源或目的地 --
  it("AC-2：rig scope 会显示来源或目的地属于该 rig 的 item", () => {
    seed(db, "q-dest", { source: "seat-a@other-rig", destination: "seat-b@demo-rig", state: "pending" });
    seed(db, "q-src", { source: "seat-c@demo-rig", destination: "seat-d@other-rig", state: "in-progress" });
    seed(db, "q-unrelated", { source: "seat-e@unrelated", destination: "seat-f@unrelated", state: "pending" });

    const items = repo.list({ rig: "demo-rig", activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-dest");
    expect(ids).toContain("q-src");
    expect(ids).not.toContain("q-unrelated");
  });

  it("AC-2：rig 后缀匹配锚定末尾（不误匹配前缀）", () => {
    seed(db, "q-demo", { source: "a@demo", destination: "b@demo", state: "pending" });
    seed(db, "q-demo-2", { source: "a@demo-2", destination: "b@demo-2", state: "pending" });

    const items = repo.list({ rig: "demo", activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-demo");
    expect(ids).not.toContain("q-demo-2");
  });

  // -- AC-2b：活动集合 + handoff 判别器 --
  it("AC-2b：默认活动集合仅包含 pending/in-progress/blocked", () => {
    seed(db, "q-pending", { source: "a@rig", destination: "b@rig", state: "pending" });
    seed(db, "q-inprog", { source: "a@rig", destination: "b@rig", state: "in-progress" });
    seed(db, "q-blocked", { source: "a@rig", destination: "b@rig", state: "blocked" });
    seed(db, "q-done", { source: "a@rig", destination: "b@rig", state: "done" });
    seed(db, "q-canceled", { source: "a@rig", destination: "b@rig", state: "canceled" });
    seed(db, "q-handedoff", { source: "a@rig", destination: "b@rig", state: "handed-off" });
    seed(db, "q-failed", { source: "a@rig", destination: "b@rig", state: "failed" });
    seed(db, "q-denied", { source: "a@rig", destination: "b@rig", state: "denied" });

    const items = repo.list({ rig: "rig", activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-pending");
    expect(ids).toContain("q-inprog");
    expect(ids).toContain("q-blocked");
    expect(ids).not.toContain("q-done");
    expect(ids).not.toContain("q-canceled");
    expect(ids).not.toContain("q-handedoff");
    expect(ids).not.toContain("q-failed");
    expect(ids).not.toContain("q-denied");
  });

  it("AC-2b：handoff 判别器——裸 list 显示 pending 子项，不显示 handed-off 来源项", () => {
    seed(db, "q-source-handedoff", {
      source: "driver@demo-rig",
      destination: "guard@demo-rig",
      state: "handed-off",
      closureReason: "handed_off_to",
      closureTarget: "qa@demo-rig",
      tsCreated: "2026-06-19T00:00:00.000Z",
    });
    seed(db, "q-child-pending", {
      source: "guard@demo-rig",
      destination: "qa@demo-rig",
      state: "pending",
      handedOffFrom: "q-source-handedoff",
      tsCreated: "2026-06-19T00:01:00.000Z",
    });

    const active = repo.list({ rig: "demo-rig", activeOnly: true });
    const activeIds = active.map((i) => i.qitemId);
    expect(activeIds).toContain("q-child-pending");
    expect(activeIds).not.toContain("q-source-handedoff");

    const withHistory = repo.list({ rig: "demo-rig", activeOnly: false });
    const historyIds = withHistory.map((i) => i.qitemId);
    expect(historyIds).toContain("q-child-pending");
    expect(historyIds).toContain("q-source-handedoff");
  });

  // -- AC-3：compact JSON 排除 body/chain --
  it("AC-3：compact 排除 body 和 chainOfRecord", () => {
    seed(db, "q-1", { source: "a@rig", destination: "b@rig", body: "这里是很长的正文" });
    const compact = repo.list({ compact: true });
    expect(compact[0]!.body).toBe("");
    expect(compact[0]!.chainOfRecord).toBeNull();
  });

  // -- AC-4：各筛选轴可组合 --
  it("AC-4：rig + activeOnly=false 包含该 rig 内的历史记录", () => {
    seed(db, "q-active", { source: "a@demo-rig", destination: "b@demo-rig", state: "pending" });
    seed(db, "q-done", { source: "a@demo-rig", destination: "b@demo-rig", state: "done" });
    seed(db, "q-other", { source: "a@other", destination: "b@other", state: "done" });

    const items = repo.list({ rig: "demo-rig", activeOnly: false });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-active");
    expect(ids).toContain("q-done");
    expect(ids).not.toContain("q-other");
  });

  it("AC-4：无 rig + activeOnly 返回跨 rig 活动项", () => {
    seed(db, "q-a", { source: "a@rig-1", destination: "b@rig-1", state: "pending" });
    seed(db, "q-b", { source: "a@rig-2", destination: "b@rig-2", state: "in-progress" });
    seed(db, "q-done", { source: "a@rig-1", destination: "b@rig-1", state: "done" });

    const items = repo.list({ activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-a");
    expect(ids).toContain("q-b");
    expect(ids).not.toContain("q-done");
  });

  // -- AC-5：daemon 向后兼容（无新参数 = 当前完整行为）--
  it("AC-5：无新参数 = 完整且无 scope 限制的 list（向后兼容）", () => {
    seed(db, "q-1", { source: "a@rig", destination: "b@rig", state: "done", body: "完整正文" });
    const items = repo.list({});
    expect(items[0]!.body).toBe("完整正文");
    expect(items[0]!.chainOfRecord).toBeDefined();
  });

  // -- asSession（--mine）仍可工作 --
  it("asSession（--mine）把 scope 限定为调用方的 item", () => {
    seed(db, "q-mine", { source: "me@rig", destination: "other@rig", state: "pending" });
    seed(db, "q-not-mine", { source: "x@rig", destination: "y@rig", state: "pending" });

    const items = repo.list({ asSession: "me@rig", activeOnly: true });
    const ids = items.map((i) => i.qitemId);
    expect(ids).toContain("q-mine");
    expect(ids).not.toContain("q-not-mine");
  });
});
