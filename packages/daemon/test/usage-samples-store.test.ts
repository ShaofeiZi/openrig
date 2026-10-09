// 51-08 A1（plan-lock 2026-08-07，PM rev-1：README d606b9cbe2e5f4e8）——仅追加
// per-seat usage series。RED-first：此文件在 migration + store 存在前即导入它们。这里固定的决策：
// 使用专用 table（不是 event）、仅在推进时增加 row（idle 时零增长）、Option-A 边界
//（新路径中任何位置都不含 account identity）。
import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import {
  UsageSamplesStore,
  type ContextSampleInput,
  type ProviderWindowSampleInput,
} from "../src/domain/usage-samples-store.js";

function freshDb(): Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(usageSamplesSchema.sql);
  return db;
}

const ctx = (over: Partial<ContextSampleInput> = {}): ContextSampleInput => ({
  nodeId: "node-1",
  seatSession: "dev50-qa@v-openrig-build",
  source: "claude_statusline_json",
  sampledAt: "2026-08-07T09:00:00.000Z",
  totalInputTokens: 1000,
  totalOutputTokens: 200,
  usedPercentage: 12.5,
  ...over,
});

const win = (over: Partial<ProviderWindowSampleInput> = {}): ProviderWindowSampleInput => ({
  seatSession: "dev50-qa@v-openrig-build",
  window: "five_hour",
  usedPercent: 40,
  resetsAt: "2026-08-07T12:00:00.000Z",
  asOf: "2026-08-07T09:00:00.000Z",
  ...over,
});

describe("062 usage_samples——append-only series（contract 第 1 项）", () => {
  let db: Database;
  let store: UsageSamplesStore;
  beforeEach(() => {
    db = freshDb();
    store = new UsageSamplesStore(db);
  });

  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM usage_samples").get() as { n: number }).n;

  it("两个已推进 context sample 追加两行；未变化 sample 不追加（idle 时零增长）", () => {
    expect(store.appendContextSample(ctx(), "2026-08-07T09:00:01.000Z")).toBe(true);
    // 下个 tick 再次观察到相同 sample——idle seat
    expect(store.appendContextSample(ctx(), "2026-08-07T09:00:31.000Z")).toBe(false);
    expect(count()).toBe(1);
    // sample 已推进（新 sampled_at + token 变化）
    expect(
      store.appendContextSample(
        ctx({ sampledAt: "2026-08-07T09:00:30.000Z", totalInputTokens: 5000, usedPercentage: 14.1 }),
        "2026-08-07T09:01:01.000Z",
      ),
    ).toBe(true);
    expect(count()).toBe(2);
  });

  it("sampled_at 不变但 value 变化时仍追加（value 属于推进条件）", () => {
    store.appendContextSample(ctx(), "t1");
    expect(store.appendContextSample(ctx({ totalOutputTokens: 900 }), "t2")).toBe(true);
    expect(count()).toBe(2);
  });

  it("按 seat 检测推进：另一个 seat 的相同 value 会独立追加", () => {
    store.appendContextSample(ctx(), "t1");
    expect(store.appendContextSample(ctx({ seatSession: "dev-qa@v-openrig-build", nodeId: "node-2" }), "t1")).toBe(true);
    expect(count()).toBe(2);
    // 第一个 seat 未变化的 sample 仍拒绝增长
    expect(store.appendContextSample(ctx(), "t2")).toBe(false);
  });

  it("row 仅追加：新 sample 绝不修改先前 row（不同于 context_usage upsert）", () => {
    store.appendContextSample(ctx(), "t1");
    store.appendContextSample(ctx({ sampledAt: "2026-08-07T09:00:30.000Z", totalInputTokens: 9999 }), "t2");
    const rows = db
      .prepare("SELECT total_input_tokens AS tin FROM usage_samples ORDER BY id")
      .all() as Array<{ tin: number }>;
    expect(rows.map((r) => r.tin)).toEqual([1000, 9999]); // 保留 history，不覆盖
  });
});

describe("062 usage_samples——provider rate-limit window（contract 第 2 项）", () => {
  let db: Database;
  let store: UsageSamplesStore;
  beforeEach(() => {
    db = freshDb();
    store = new UsageSamplesStore(db);
  });

  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM usage_samples").get() as { n: number }).n;

  it("five_hour 与 weekly window 累积携带 usedPercent + resetsAt 的 per-seat series row", () => {
    expect(store.appendProviderWindowSample(win(), "t1")).toBe(true);
    expect(store.appendProviderWindowSample(win({ window: "weekly", usedPercent: 12 }), "t1")).toBe(true);
    expect(count()).toBe(2);
    const row = db
      .prepare("SELECT window, window_used_percent AS up, resets_at AS ra FROM usage_samples WHERE window = 'five_hour'")
      .get() as { window: string; up: number; ra: string };
    expect(row.up).toBe(40);
    expect(row.ra).toBe("2026-08-07T12:00:00.000Z");
  });

  it("每个（seat、window）仅在推进时追加：asOf+value 不变则不追加，变化则追加", () => {
    store.appendProviderWindowSample(win(), "t1");
    expect(store.appendProviderWindowSample(win(), "t2")).toBe(false);
    expect(store.appendProviderWindowSample(win({ asOf: "2026-08-07T09:05:00.000Z", usedPercent: 43 }), "t3")).toBe(true);
    // sibling window 的推进相互独立
    store.appendProviderWindowSample(win({ window: "weekly", usedPercent: 12 }), "t3");
    expect(store.appendProviderWindowSample(win({ window: "weekly", usedPercent: 12 }), "t4")).toBe(false);
    expect(count()).toBe(3);
  });

  it("OPTION-A PIN（负向）：table 不含 account identity 列，任何 row 都无法夹带", () => {
    const cols = (db.prepare("PRAGMA table_info(usage_samples)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of cols) {
      expect(col.toLowerCase()).not.toMatch(/account/);
    }
    // seat identity 是唯一 identity：row 的 identity 列是 seat/node
    expect(cols).toContain("seat_session");
    expect(cols).toContain("node_id");
  });
});
