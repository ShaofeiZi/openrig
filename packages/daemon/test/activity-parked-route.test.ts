import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";

// OPR.0.5.5.19 A7——/api/activity/parked surface：只读 join oracle 与 queue obligation 界面，
// 并如实返回 503/404 拒绝。

const SEAT = "node-p1";
const SESSION = "dev50-qa@v-openrig-build";

function makeApp(opts: { withDeps: boolean; rows?: Array<{ qitemId: string; state: string; summary?: string | null }> }) {
  const clock = { now: 3_000_000 };
  const svc = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(clock.now),
  });
  svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, {
    adapterId: "claude-code-adapter",
    runtime: "claude-code",
    rungs: [{ rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" }],
  });
  svc.reportEvidence({
    seatNodeId: SEAT, sessionName: SESSION, rung: "window-sampling",
    sourceId: "tmux:window-activity", seq: 1, observedAt: new Date(clock.now).toISOString(),
    activity: "idle-at-prompt",
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (opts.withDeps) {
      c.set("seatActivityService" as never, svc as never);
      c.set("queueRepo" as never, { list: () => opts.rows ?? [] } as never);
      c.set("rigRepo" as never, { db: { prepare: (sql: string) => ({
        get: () => ({ id: "rig-1", name: "v-openrig-build" }),
        all: () => (sql.includes("SELECT name FROM rigs") ? [] : [{ node_id: SEAT, session_name: SESSION }]),
      }) } } as never);
    }
    await next();
  });
  app.route("/api/activity", activityRoutes);
  return app;
}

describe("S19 A7——GET /api/activity/parked", () => {
  it("rig 层：join oracle 与 obligation 界面并返回派生诊断", async () => {
    const app = makeApp({ withDeps: true, rows: [{ qitemId: "qitem-9", state: "pending", summary: "owed" }] });
    const res = await app.request("/api/activity/parked", { headers: { "x-openrig-session": SESSION } });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rig: { parked: boolean; seats: Array<{ parked: boolean }> } };
    expect(body.ok).toBe(true);
    expect(body.rig.parked).toBe(true);
    expect(body.rig.seats[0]!.parked).toBe(true);
  });

  it("seat 层解析 node id 或 session 名；未知席位会通过已知集合提供指引", async () => {
    const app = makeApp({ withDeps: true, rows: [] });
    const byName = await app.request(`/api/activity/parked?seat=${encodeURIComponent(SESSION)}`);
    expect(byName.status).toBe(200);
    const ghost = await app.request("/api/activity/parked?seat=ghost", { headers: { "x-openrig-session": SESSION } });
    expect(ghost.status).toBe(404);
    const body = await ghost.json() as { error: string };
    expect(body.error).toContain(SESSION); // 指引点名已知席位。
  });

  it("缺少依赖时以 503 拒绝并点名未配置 surface，绝不伪造空诊断", async () => {
    const app = makeApp({ withDeps: false });
    const res = await app.request("/api/activity/parked");
    expect(res.status).toBe(503);
  });
});
