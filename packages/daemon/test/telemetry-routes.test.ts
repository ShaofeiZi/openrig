// 51-08 A3——telemetry 路由：经 HTTP 从单一 projection 服务 series + top-N burn
//（PM 决策 4：一个 projection，CLI + HTTP 共用）。RED-first：在 routes/telemetry.ts
// 存在之前写。
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { telemetryRoutes } from "../src/routes/telemetry.js";

function seeded(): Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(usageSamplesSchema.sql);
  const store = new UsageSamplesStore(db);
  const seed = (seat: string, at: string, tin: number) =>
    store.appendContextSample(
      {
        nodeId: `n-${seat}`,
        seatSession: seat,
        source: "claude_statusline_json",
        sampledAt: at,
        totalInputTokens: tin,
        totalOutputTokens: 0,
        usedPercentage: 10,
      },
      at,
    );
  seed("burner@r", "2026-08-07T10:00:00.000Z", 100_000);
  seed("burner@r", "2026-08-07T12:00:00.000Z", 700_000);
  seed("calm@r", "2026-08-07T10:00:00.000Z", 1_000);
  seed("calm@r", "2026-08-07T12:00:00.000Z", 2_000);
  return db;
}

function appWith(db: Database, nowIso: string): Hono {
  const app = new Hono();
  app.route("/api/telemetry", telemetryRoutes({ db: () => db, nowIso: () => nowIso }));
  return app;
}

describe("telemetry 路由", () => {
  const NOW = "2026-08-07T12:30:00.000Z";

  it("GET /usage/series 为 seat 服务原始行，且响应 key 不携带账户身份", async () => {
    const app = appWith(seeded(), NOW);
    const res = await app.request("/api/telemetry/usage/series?seat=burner%40r");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows.length).toBe(2);
    expect(body.rows[0]!.seatSession).toBe("burner@r");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("account");
  });

  it("GET /usage/top 把 burner 排到 top-1，tokens/hour 从 series 计算", async () => {
    const app = appWith(seeded(), NOW);
    const res = await app.request("/api/telemetry/usage/top?window_hours=4&top=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ranked: Array<{ seatSession: string; tokensPerHour: number }>;
      unknown: unknown[];
      totalRankedSeats: number;
    };
    expect(body.ranked[0]!.seatSession).toBe("burner@r");
    expect(body.ranked[0]!.tokensPerHour).toBe(300_000);
    expect(body.totalRankedSeats).toBe(2);
  });

  it("非法 window_hours 返回带说明的 400，绝不静默默认", async () => {
    const app = appWith(seeded(), NOW);
    const res = await app.request("/api/telemetry/usage/top?window_hours=zero");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/window_hours/);
  });
});
