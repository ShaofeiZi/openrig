// 51-08 A3 —— usage_samples 之上的遥测读取表面（plan-lock rev-1）。
// 服务于唯一一个同时支撑 CLI 的投影（usage-series.ts）（PM 决策 4）——只给事实；
// 阈值与判断放在边缘（监督检测器）。Option-A 底线：任何响应中都不出现账号身份。
import { Hono } from "hono";
import type { Database } from "better-sqlite3";
import { queryUsageSeries, computeTopBurn } from "../domain/usage-series.js";

export interface TelemetryRouteDeps {
  db: () => Database;
  /** 可注入时钟，使测试与 VM 种子可复现 */
  nowIso?: () => string;
}

export function telemetryRoutes(deps: TelemetryRouteDeps): Hono {
  const app = new Hono();
  const now = deps.nowIso ?? (() => new Date().toISOString());

  app.get("/usage/series", (c) => {
    const seat = c.req.query("seat") || undefined;
    const lane = c.req.query("lane");
    const sinceIso = c.req.query("since") || undefined;
    const untilIso = c.req.query("until") || undefined;
    const limitRaw = c.req.query("limit");
    if (lane && lane !== "context" && lane !== "provider_window") {
      return c.json({ error: `未知 lane "${lane}"——可用值：context、provider_window` }, 400);
    }
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      limit = Number(limitRaw);
      if (!Number.isFinite(limit) || limit < 1) {
        return c.json({ error: `无效 limit "${limitRaw}"——必须是正数` }, 400);
      }
    }
    const rows = queryUsageSeries(deps.db(), {
      seatSession: seat,
      lane: lane as "context" | "provider_window" | undefined,
      sinceIso,
      untilIso,
      limit,
    });
    return c.json({ rows });
  });

  app.get("/usage/top", (c) => {
    const windowRaw = c.req.query("window_hours") ?? "1";
    const windowHours = Number(windowRaw);
    if (!Number.isFinite(windowHours) || windowHours <= 0) {
      return c.json({ error: `无效 window_hours "${windowRaw}"——必须是正数小时数` }, 400);
    }
    const topRaw = c.req.query("top");
    let topN: number | undefined;
    if (topRaw !== undefined) {
      topN = Number(topRaw);
      if (!Number.isFinite(topN) || topN < 1) {
        return c.json({ error: `无效 top "${topRaw}"——必须是正计数` }, 400);
      }
    }
    return c.json(computeTopBurn(deps.db(), { windowHours, nowIso: now(), topN }));
  });

  return app;
}
