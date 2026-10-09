// 51-08 A3——时序查询 + top-N burn 投影（plan-lock rev-1）。
// PM 决策 3+4：一个 daemon 侧投影同时服务路由和 CLI——不出现第五份阈值副本；
// rig 提供事实（rate、span、delta），detector 负责判断。RED 优先：写于 usage-series.ts 出现之前。
import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { queryUsageSeries, computeTopBurn } from "../src/domain/usage-series.js";

const NOW = "2026-08-07T12:00:00.000Z";

function db_(): Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(usageSamplesSchema.sql);
  return db;
}

function seedContext(
  store: UsageSamplesStore,
  seat: string,
  at: string,
  tin: number,
  tout: number,
): void {
  store.appendContextSample(
    {
      nodeId: `n-${seat}`,
      seatSession: seat,
      source: "claude_statusline_json",
      sampledAt: at,
      totalInputTokens: tin,
      totalOutputTokens: tout,
      usedPercentage: 10,
    },
    at,
  );
}

describe("queryUsageSeries——原始行、有时间边界、逐席位", () => {
  let db: Database;
  let store: UsageSamplesStore;
  beforeEach(() => {
    db = db_();
    store = new UsageSamplesStore(db);
  });

  it("返回按席位和 since 边界过滤的原始存储行，最早的在前", () => {
    seedContext(store, "a@r", "2026-08-07T10:00:00.000Z", 1000, 100);
    seedContext(store, "a@r", "2026-08-07T11:00:00.000Z", 3000, 200);
    seedContext(store, "b@r", "2026-08-07T11:00:00.000Z", 500, 50);
    const rows = queryUsageSeries(db, { seatSession: "a@r", sinceIso: "2026-08-07T09:00:00.000Z" });
    expect(rows.map((r) => r.totalInputTokens)).toEqual([1000, 3000]);
    expect(rows.every((r) => r.seatSession === "a@r")).toBe(true);
    // 返回的任何行都没有 account 字段（投影层的 Option-A 固定测试）
    for (const r of rows) {
      expect(Object.keys(r).some((k) => /account/i.test(k))).toBe(false);
    }
  });

  it("since 边界严格作用于 captured_at：刚好在外的行排除，刚好在内的行包含", () => {
    seedContext(store, "a@r", "2026-08-07T09:59:59.999Z", 1000, 100);
    seedContext(store, "a@r", "2026-08-07T10:00:00.001Z", 2000, 100);
    const rows = queryUsageSeries(db, { seatSession: "a@r", sinceIso: "2026-08-07T10:00:00.000Z" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.totalInputTokens).toBe(2000);
  });
});

describe("computeTopBurn——tokens/hour + window velocity，只提供事实而非判断", () => {
  let db: Database;
  let store: UsageSamplesStore;
  beforeEach(() => {
    db = db_();
    store = new UsageSamplesStore(db);
  });

  it("按窗口内 tokens/hour 对席位排序；合成 burner 排名第一", () => {
    // burner：10:00→12:00（2h）期间 600k token = 300k/h
    seedContext(store, "burner@r", "2026-08-07T10:00:00.000Z", 100_000, 0);
    seedContext(store, "burner@r", "2026-08-07T11:00:00.000Z", 400_000, 0);
    seedContext(store, "burner@r", "2026-08-07T12:00:00.000Z", 700_000, 0);
    // calm 席位：同一时间跨度内 10k = 5k/h
    seedContext(store, "calm@r", "2026-08-07T10:00:00.000Z", 10_000, 0);
    seedContext(store, "calm@r", "2026-08-07T12:00:00.000Z", 20_000, 0);
    const top = computeTopBurn(db, { windowHours: 4, nowIso: NOW });
    expect(top.ranked.length).toBe(2);
    expect(top.ranked[0]!.seatSession).toBe("burner@r");
    expect(top.ranked[0]!.tokensPerHour).toBe(300_000);
    expect(top.ranked[1]!.seatSession).toBe("calm@r");
    expect(top.ranked[1]!.tokensPerHour).toBe(5_000);
  });

  it("totals RESET（重启）绝不虚构负 burn：正 delta 累加，并统计 reset", () => {
    seedContext(store, "a@r", "2026-08-07T10:00:00.000Z", 500_000, 0);
    seedContext(store, "a@r", "2026-08-07T11:00:00.000Z", 600_000, 0); // +100k
    seedContext(store, "a@r", "2026-08-07T11:30:00.000Z", 50_000, 0);  // RESET（重启）
    seedContext(store, "a@r", "2026-08-07T12:00:00.000Z", 150_000, 0); // +100k
    const top = computeTopBurn(db, { windowHours: 4, nowIso: NOW });
    expect(top.ranked[0]!.tokensPerHour).toBe(100_000); // 2h 时间跨度内 200k 正 delta
    expect(top.ranked[0]!.resets).toBe(1);
  });

  it("HONEST UNKNOWN：有序列历史但窗口内样本少于 2 个的席位列为 unknown，绝不为 0", () => {
    seedContext(store, "stale@r", "2026-08-07T01:00:00.000Z", 100_000, 0);
    seedContext(store, "stale@r", "2026-08-07T02:00:00.000Z", 200_000, 0);
    seedContext(store, "single@r", "2026-08-07T11:30:00.000Z", 1_000, 0);
    const top = computeTopBurn(db, { windowHours: 2, nowIso: NOW });
    expect(top.ranked.length).toBe(0);
    const unknown = Object.fromEntries(top.unknown.map((u) => [u.seatSession, u.reason]));
    expect(unknown["stale@r"]).toBe("no_fresh_samples");
    expect(unknown["single@r"]).toBe("insufficient_samples");
    // 排名中绝不出现虚构的零值行
    expect(top.ranked.some((r) => r.tokensPerHour === 0)).toBe(false);
  });

  it("window velocity 按 window kind 使用 provider 通道（事实：first/last/velocity）", () => {
    store.appendProviderWindowSample(
      { seatSession: "a@r", window: "five_hour", usedPercent: 20, resetsAt: null, asOf: "2026-08-07T10:00:00.000Z" },
      "2026-08-07T10:00:00.000Z",
    );
    store.appendProviderWindowSample(
      { seatSession: "a@r", window: "five_hour", usedPercent: 60, resetsAt: null, asOf: "2026-08-07T12:00:00.000Z" },
      "2026-08-07T12:00:00.000Z",
    );
    seedContext(store, "a@r", "2026-08-07T10:00:00.000Z", 1000, 0);
    seedContext(store, "a@r", "2026-08-07T12:00:00.000Z", 2000, 0);
    const top = computeTopBurn(db, { windowHours: 4, nowIso: NOW });
    const w = top.ranked[0]!.windows.find((x) => x.window === "five_hour")!;
    expect(w.usedPercentFirst).toBe(20);
    expect(w.usedPercentLast).toBe(60);
    expect(w.percentPerHour).toBe(20); // 2h 内增加 40%
  });

  it("topN 限制排名数量；同时报告上限，因此截断绝不静默", () => {
    for (let i = 0; i < 5; i += 1) {
      seedContext(store, `s${i}@r`, "2026-08-07T10:00:00.000Z", 0, 0);
      seedContext(store, `s${i}@r`, "2026-08-07T12:00:00.000Z", (i + 1) * 1000, 0);
    }
    const top = computeTopBurn(db, { windowHours: 4, nowIso: NOW, topN: 2 });
    expect(top.ranked.length).toBe(2);
    expect(top.ranked[0]!.seatSession).toBe("s4@r");
    expect(top.totalRankedSeats).toBe(5);
  });
});
