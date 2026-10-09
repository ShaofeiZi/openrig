import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type { EventBus } from "../src/domain/event-bus.js";

// OPR.0.5.5.19 AM-R18——推送底座：oracle 将裁决后的状态变更发到事件总线，
// GET /api/activity/events 再通过 SSE 将其流式传给已打开的 TUI 视图。这里只通知变更——
// payload 携带身份和 seq，绝不做第二次 activity 推导；视图从 /api/ps 恢复状态
//（已通过评审的形状）。

const SEAT = "node-ev-1";
const SESSION = "dev50-qa@v-openrig-build";

function makeSvc(emit: ReturnType<typeof vi.fn>, clock: { now: number }) {
  const svc = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(clock.now),
    eventBus: { emit } as unknown as EventBus,
  });
  svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, {
    adapterId: "claude-code-adapter", runtime: "claude-code",
    rungs: [{ rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" }],
  });
  return svc;
}

describe("S19 AM-R18——oracle 发出裁决后的状态变更", () => {
  it("状态转换会发出包含席位身份和单调递增序号的 seat.activity_changed（通知而非推导）", () => {
    const emit = vi.fn();
    const clock = { now: 7_000_000 };
    const svc = makeSvc(emit, clock);
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks",
      seq: 1, observedAt: new Date(clock.now).toISOString(), activity: "working",
    });
    const calls = emit.mock.calls.map((c) => c[0] as { type: string; seatNodeId?: string; seq?: number });
    const changed = calls.filter((e) => e.type === "seat.activity_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.seatNodeId).toBe(SEAT);
    expect(changed[0]!.seq).toBe(1);
  });

  it("重复上报同一状态不会发出事件——仅在状态变化时推送", () => {
    const emit = vi.fn();
    const clock = { now: 7_000_000 };
    const svc = makeSvc(emit, clock);
    svc.reportEvidence({ seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks", seq: 1, observedAt: new Date(clock.now).toISOString(), activity: "working" });
    emit.mockClear();
    svc.reportEvidence({ seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks", seq: 2, observedAt: new Date(clock.now).toISOString(), activity: "working" });
    expect(emit.mock.calls.filter((c) => (c[0] as { type: string }).type === "seat.activity_changed")).toHaveLength(0);
  });

  it("占用者切换也会发出变更事件（切换是可见推送）", () => {
    const emit = vi.fn();
    const clock = { now: 7_000_000 };
    const svc = makeSvc(emit, clock);
    svc.reportEvidence({ seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks", seq: 1, observedAt: new Date(clock.now).toISOString(), activity: "working" });
    emit.mockClear();
    svc.declareOccupantSwap(SEAT, "gen-next");
    expect(emit.mock.calls.some((c) => (c[0] as { type: string }).type === "seat.activity_changed")).toBe(true);
  });
});

describe("S19 AM-R18——GET /api/activity/events 通过 SSE 流式推送", () => {
  it("触发的 oracle 变更以一行 SSE 数据到达已连接流；断开连接会取消订阅", async () => {
    const subscribers = new Set<(e: unknown) => void>();
    const fakeBus = {
      subscribe: (cb: (e: unknown) => void) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, fakeBus as never); await next(); });
    app.route("/api/activity", activityRoutes);

    const res = await app.request("/api/activity/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(subscribers.size).toBe(1);

    const reader = res.body!.getReader();
    // 在流打开期间通过总线触发一次推送：
    for (const cb of subscribers) cb({ type: "seat.activity_changed", seatNodeId: SEAT, seq: 42 });
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("seat.activity_changed");
    expect(chunk).toContain('"seq":42');
    // 仅通知：SSE payload 绝不携带推导出的展示或词汇字段。
    expect(chunk).not.toMatch(/"display"|"terminalActive"/);

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(subscribers.size).toBe(0); // disconnect released the subscription
  });

  it("过滤无关总线事件——仅将 activity/rung-health 推送到流", async () => {
    const subscribers = new Set<(e: unknown) => void>();
    const fakeBus = { subscribe: (cb: (e: unknown) => void) => { subscribers.add(cb); return () => subscribers.delete(cb); } };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, fakeBus as never); await next(); });
    app.route("/api/activity", activityRoutes);
    const res = await app.request("/api/activity/events");
    const reader = res.body!.getReader();
    for (const cb of subscribers) {
      cb({ type: "queue.item_created", qitemId: "x" }); // not ours — filtered
      cb({ type: "seat.rung_health", seatNodeId: SEAT, rung: "lifecycle-hooks" });
    }
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("seat.rung_health");
    expect(chunk).not.toContain("queue.item_created");
    await reader.cancel();
  });
});
