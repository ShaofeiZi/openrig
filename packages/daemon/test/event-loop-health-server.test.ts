import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { EventLoopMonitor, HEALTHZ_RESPONSIVENESS_BUDGET_MS } from "../src/domain/event-loop-monitor.js";
import { RouteTimingRecorder } from "../src/domain/route-timing-recorder.js";

function seedRigWithNodes(db: Database.Database, name: string, nodeCount: number): string {
  const rigId = `rig-${name}`;
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(rigId, name);
  for (let i = 0; i < nodeCount; i++) {
    const nodeId = `node-${rigId}-${i}`;
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(nodeId, rigId, `seat-${i}`);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`sess-${nodeId}`, nodeId, `tmux-${nodeId}`, "running", new Date().toISOString().replace("T", " ").slice(0, 19));
  }
  return rigId;
}

describe("OPR.0.4.3.21——丰富 /healthz 信息", () => {
  it("无需事件循环监控器即可报告进程身份", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", pid: process.pid });
    db.close();
  });

  it("接入监控器时公开事件循环证据与路由计时", async () => {
    const db = createFullTestDb();
    const monitor = new EventLoopMonitor();
    const routeTimingRecorder = new RouteTimingRecorder();
    const { app } = createTestApp(db, { eventLoopMonitor: monitor, routeTimingRecorder });

    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      pid: number;
      eventLoop: { lagMeanMs: number; lagP99Ms: number; utilization: number; lastTickAgeMs: number; healthy: boolean };
      routeTimings: Record<string, unknown>;
    };
    expect(body.status).toBe("ok");
    expect(body.pid).toBe(process.pid);
    expect(typeof body.eventLoop.lagMeanMs).toBe("number");
    expect(typeof body.eventLoop.lastTickAgeMs).toBe("number");
    expect(typeof body.eventLoop.healthy).toBe("boolean");
    expect(body.routeTimings).toBeTypeOf("object");

    monitor.stop();
    db.close();
  });
});

describe("OPR.0.4.3.21——后端压力证明（门禁）", () => {
  it(
    "在拓扑路由负载下使 /healthz 保持在已证明的响应预算内，并捕获路由与事件循环证据",
    async () => {
      const db = createFullTestDb();
      const monitor = new EventLoopMonitor();
      const routeTimingRecorder = new RouteTimingRecorder();
      const { app } = createTestApp(db, { eventLoopMonitor: monitor, routeTimingRecorder });

      const rigIds: string[] = [];
      for (let r = 0; r < 6; r++) rigIds.push(seedRigWithNodes(db, `stress-${r}`, 4));

      // 对高成本拓扑接口施加广泛负载并反复探测 /healthz。断言热点路径承受压力期间，
      // 每次 healthz 探测都在已证明的预算内响应。
      const ROUNDS = 15;
      const healthLatenciesMs: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const load: Promise<unknown>[] = [];
        for (const rigId of rigIds) {
          load.push(app.request("/api/rigs/summary"));
          load.push(app.request(`/api/rigs/${rigId}/graph`));
          load.push(app.request(`/api/rigs/${rigId}/nodes`));
          load.push(app.request("/api/ps"));
        }
        const t0 = performance.now();
        const healthRes = await app.request("/healthz");
        healthLatenciesMs.push(performance.now() - t0);
        expect(healthRes.status).toBe(200);
        await Promise.all(load);
      }

      // /healthz 始终在已证明的阈值内保持响应。
      const worst = Math.max(...healthLatenciesMs);
      expect(worst).toBeLessThan(HEALTHZ_RESPONSIVENESS_BUDGET_MS);

      // 已捕获事件循环证据，且事件循环未因负载而饥饿。
      const finalHealth = (await app.request("/healthz")).clone();
      const body = (await finalHealth.json()) as {
        eventLoop: { healthy: boolean };
        routeTimings: Record<string, { lastMs: number; maxMs: number; count: number }>;
      };
      expect(body.eventLoop.healthy).toBe(true);

      // 已为证明过程触发的高成本路由捕获持续时间证据。
      const labels = Object.keys(body.routeTimings);
      expect(labels).toContain("GET /api/ps");
      expect(labels).toContain("GET /api/rigs/summary");
      expect(labels).toContain("GET /api/rigs/:id/graph");
      expect(labels).toContain("GET /api/rigs/:id/nodes");
      expect(body.routeTimings["GET /api/ps"]!.count).toBeGreaterThan(0);

      monitor.stop();
      db.close();
    },
  );
});
