import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  RouteTimingRecorder,
  expensiveRouteLabel,
  createRouteTimingMiddleware,
} from "../src/domain/route-timing-recorder.js";

describe("expensiveRouteLabel", () => {
  it("标记四个高开销拓扑路由", () => {
    expect(expensiveRouteLabel("GET", "/api/ps")).toBe("GET /api/ps");
    expect(expensiveRouteLabel("GET", "/api/rigs/summary")).toBe("GET /api/rigs/summary");
    expect(expensiveRouteLabel("GET", "/api/rigs/abc-123/graph")).toBe("GET /api/rigs/:id/graph");
    expect(expensiveRouteLabel("GET", "/api/rigs/abc-123/nodes")).toBe("GET /api/rigs/:id/nodes");
  });

  it("对低开销路由、子路径和非 GET 动词返回 null", () => {
    expect(expensiveRouteLabel("GET", "/healthz")).toBeNull();
    expect(expensiveRouteLabel("GET", "/api/rigs")).toBeNull();
    expect(expensiveRouteLabel("GET", "/api/rigs/abc-123")).toBeNull();
    expect(expensiveRouteLabel("GET", "/api/rigs/abc/nodes/deep")).toBeNull();
    expect(expensiveRouteLabel("POST", "/api/ps")).toBeNull();
  });
});

describe("RouteTimingRecorder 滚动统计 last / max / count", () => {
  it("按标签跟踪 last、max 和 count", () => {
    const r = new RouteTimingRecorder();
    r.record("GET /api/ps", 10);
    r.record("GET /api/ps", 30);
    r.record("GET /api/ps", 20);
    expect(r.snapshot()["GET /api/ps"]).toEqual({ lastMs: 20, maxMs: 30, count: 3 });
  });

  it("snapshot 返回隔离副本，避免外部修改", () => {
    const r = new RouteTimingRecorder();
    r.record("GET /api/ps", 5);
    const snap = r.snapshot();
    snap["GET /api/ps"]!.maxMs = 999;
    expect(r.snapshot()["GET /api/ps"]!.maxMs).toBe(5);
  });
});

describe("createRouteTimingMiddleware 只记录高开销路由", () => {
  it("记录高开销路由，不为低开销路由计时", async () => {
    const recorder = new RouteTimingRecorder();
    const app = new Hono();
    app.use("*", createRouteTimingMiddleware(recorder));
    app.get("/api/ps", (c) => c.json({ ok: true }));
    app.get("/healthz", (c) => c.json({ status: "ok" }));

    await app.request("/api/ps");
    await app.request("/healthz");

    const snap = recorder.snapshot();
    expect(Object.keys(snap)).toEqual(["GET /api/ps"]);
    expect(snap["GET /api/ps"]!.count).toBe(1);
    expect(snap["GET /api/ps"]!.lastMs).toBeGreaterThanOrEqual(0);
  });
});
