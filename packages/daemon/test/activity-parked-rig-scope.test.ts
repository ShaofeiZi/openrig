import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";

// WAVE O FIX R1 — B2（R2 结论 508e383d）：`zrig parked` 声称限定在 rig 范围内，
// 实际却聚合了 daemon 中所有正在运行的 rig。保留 R2 的效果判别条件：rig-a 中有一个空闲席位，
// rig-b 中有一个空闲席位，且仅 rig-b 中有义务——来自 rig-a 的调用者必须只看到 rig-a，
// 结果为 NOT-PARKED。使用真实 sqlite、真实路由和真实判定逻辑；仅按目标伪造队列的义务侧。

const DDL = `
CREATE TABLE rigs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE nodes (id TEXT PRIMARY KEY, rig_id TEXT NOT NULL);
CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, session_name TEXT, status TEXT);
`;

describe("Wave-O B2 — parked 诊断限定在已明确命名的 RIG 范围内", () => {
  let db: Database.Database;
  let svc: SeatActivityService;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(DDL);
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-a-id", "rig-a");
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-b-id", "rig-b");
    db.prepare("INSERT INTO nodes (id, rig_id) VALUES (?, ?)").run("node-a", "rig-a-id");
    db.prepare("INSERT INTO nodes (id, rig_id) VALUES (?, ?)").run("node-b", "rig-b-id");
    db.prepare("INSERT INTO sessions (node_id, session_name, status) VALUES (?, ?, ?)").run("node-a", "dev-a@rig-a", "running");
    db.prepare("INSERT INTO sessions (node_id, session_name, status) VALUES (?, ?, ?)").run("node-b", "dev-b@rig-b", "running");

    const clock = { now: 9_000_000 };
    svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3,
      now: () => new Date(clock.now),
    });
    for (const [node, session] of [["node-a", "dev-a@rig-a"], ["node-b", "dev-b@rig-b"]] as const) {
      svc.declareRungInventory({ seatNodeId: node, sessionName: session }, {
        adapterId: "tmux-generic", runtime: "tmux-generic",
        rungs: [{ rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" }],
      });
      svc.reportEvidence({
        seatNodeId: node, sessionName: session, rung: "window-sampling",
        sourceId: "tmux:window-activity", seq: 1, observedAt: new Date(clock.now).toISOString(),
        activity: "idle-at-prompt",
      });
    }

    // 义务侧：只有 dev-b@rig-b 尚有工作义务。
    const queueRepo = {
      list: (opts: { destinationSession?: string }) =>
        opts.destinationSession === "dev-b@rig-b"
          ? [{ qitemId: "qitem-b-1", state: "pending", summary: "owed in rig-b" }]
          : [],
    };

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("seatActivityService" as never, svc as never);
      c.set("queueRepo" as never, queueRepo as never);
      c.set("rigRepo" as never, { db } as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
  });
  afterEach(() => db.close());

  it("R2 判别条件：来自 rig-a 的调用者只看到 rig-a 席位和 NOT-PARKED——rig-b 的义务不得泄漏", async () => {
    const res = await app.request("/api/activity/parked", {
      headers: { "x-openrig-session": "dev-a@rig-a" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; rig: { parked: boolean | string; scope?: { rig: string; resolvedFrom: string }; seats: Array<{ sessionName: string }> } };
    const names = body.rig.seats.map((s) => s.sessionName);
    expect(names).toEqual(["dev-a@rig-a"]); // 候选实现返回了两个 rig
    expect(body.rig.parked).toBe(false);    // 候选实现因 rig-b 的义务而判定为 PARKED
    expect(body.rig.scope).toEqual({ rig: "rig-a", resolvedFrom: "caller-session" }); // AM-3：范围已明确命名
  });

  it("显式 ?rig= 坐标将范围限定到对应 rig——rig-b 因自身义务而处于 parked 状态", async () => {
    const res = await app.request("/api/activity/parked?rig=rig-b");
    const body = await res.json() as { rig: { parked: boolean; scope?: { rig: string; resolvedFrom: string }; seats: Array<{ sessionName: string; parked: boolean | string }> } };
    expect(body.rig.seats.map((s) => s.sessionName)).toEqual(["dev-b@rig-b"]);
    expect(body.rig.parked).toBe(true);
    expect(body.rig.scope).toEqual({ rig: "rig-b", resolvedFrom: "query-param" });
  });

  it("没有可解析的 rig 范围时拒绝请求并给出指引——绝不静默聚合整个机群", async () => {
    const res = await app.request("/api/activity/parked");
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/rig/i);      // 指明缺失的坐标
    expect(body.error).toMatch(/\?rig=|--rig|session/i); // 并说明如何传入
  });

  it("保留显式席位语义：携带 @rig 坐标的 ?seat= 可自行确定范围", async () => {
    const res = await app.request("/api/activity/parked?seat=dev-b%40rig-b");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; seat: { sessionName: string; parked: boolean | string } };
    expect(body.seat.sessionName).toBe("dev-b@rig-b");
    expect(body.seat.parked).toBe(true);
  });

  it("遇到未知 rig 坐标时列出已知 rig 作为指引", async () => {
    const res = await app.request("/api/activity/parked?rig=ghost-rig");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("rig-a");
    expect(body.error).toContain("rig-b");
  });
});
