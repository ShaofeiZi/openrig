import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { activityRoutes, evidenceFromHookActivity } from "../src/routes/activity.js";
import { SeatActivityService, HOOK_AUTHORITY_WINDOW_MS } from "../src/domain/seat-activity-service.js";
import type { AgentActivity } from "../src/domain/types.js";
import type { AdapterRungInventory } from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A4——ingest 统一：hook 事件经 adapter seam 到达 ONE oracle；
// AgentActivityStore 退化为 raw-event 记录器。store 的归一化仍是单一 event-name parser
//（无孪生）——这些钉死经 fake store 消费它的 OUTPUT 形状，并证明路由喂给 SeatActivityService。

const TOKEN = "test-token";
const SEAT = "node-ing-1";
const SESSION = "dev50-qa@v-openrig-build";

const CLAUDE_INVENTORY: AdapterRungInventory = {
  adapterId: "claude-code-adapter",
  runtime: "claude-code",
  rungs: [
    { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" },
  ],
};

function activity(state: AgentActivity["state"], atMs: number, reason = "turn boundary"): AgentActivity {
  return {
    state,
    reason,
    evidenceSource: "hook" as AgentActivity["evidenceSource"],
    sampledAt: new Date(atMs).toISOString(),
    evidence: null,
    runtime: "claude-code",
  };
}

function makeApp(clock: { now: number }) {
  const svc = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(clock.now),
  });
  svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
  let cannedState: AgentActivity["state"] = "idle";
  const fakeStore = {
    recordHookEvent: () => ({
      ok: true as const,
      activity: activity(cannedState, clock.now),
      event: { nodeId: SEAT, sessionName: SESSION, runtime: "claude-code" },
    }),
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, fakeStore as never);
    c.set("activityHookToken" as never, TOKEN as never);
    c.set("seatActivityService" as never, svc as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const post = (hookEvent: string, state: AgentActivity["state"]) => {
    cannedState = state;
    return app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ runtime: "claude-code", sessionName: SESSION, nodeId: SEAT, hookEvent }),
    });
  };
  return { svc, post };
}

describe("S19 A4——映射：store 归一化 state → oracle evidence（一个 parser，无孪生）", () => {
  const base = { seatNodeId: SEAT, sessionName: SESSION, runtime: "claude-code", seq: 1 };
  const AT = 2_000_000;

  it("running → 在 lifecycle-hooks rung 上 working", () => {
    const ev = evidenceFromHookActivity({ ...base, activity: activity("running", AT) })!;
    expect(ev.rung).toBe("lifecycle-hooks");
    expect(ev.activity).toBe("working");
    expect(ev.sourceId).toBe("claude-code:hooks");
  });

  it("idle → idle-at-prompt（一个 turn 边界，exactly-once 语义住在源头）", () => {
    expect(evidenceFromHookActivity({ ...base, activity: activity("idle", AT) })!.activity).toBe("idle-at-prompt");
  });

  it("needs_input → 在 hooks rung 上给出 needs-input COUNT+reason，绝不作为 activity 值", () => {
    const ev = evidenceFromHookActivity({ ...base, activity: activity("needs_input", AT, "permission prompt") })!;
    expect(ev.activity).toBeUndefined();
    expect(ev.needsInput).toEqual({ count: 1, reason: "permission prompt" });
  });

  it("unknown → null：噪声绝不作为 evidence 喂给 oracle", () => {
    expect(evidenceFromHookActivity({ ...base, activity: activity("unknown", AT) })).toBeNull();
  });
});

describe("S19 A4——路由喂给 ONE oracle（trace：一个仲裁点）", () => {
  it("Stop 形 hook 经 seam 把仲裁 state 推到 idle", async () => {
    const clock = { now: 2_000_000 };
    const { svc, post } = makeApp(clock);
    const res = await post("UserPromptSubmit", "running");
    expect(res.status).toBe(200);
    expect(svc.getSeatState(SEAT)!.activity).toBe("working");
    expect(svc.getSeatState(SEAT)!.decidedBy).toBe("lifecycle-hooks");
    await post("Stop", "idle");
    expect(svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt"); // turn 边界——瞬时，无 debounce
  });

  it("PermissionRequest 形 hook 在 activity 旁呈现 needs-input（authoritative rung）", async () => {
    const clock = { now: 2_000_000 };
    const { svc, post } = makeApp(clock);
    await post("UserPromptSubmit", "running");
    await post("Notification", "needs_input");
    const s = svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working"); // turn 仍在飞
    expect(s.needsInput.count).toBe(1);
    // 后续 turn 边界清掉它：
    await post("Stop", "idle");
    expect(svc.getSeatState(SEAT)!.needsInput.count).toBe(0);
  });

  it("KILLED RELAY（补充材料的风险样本）：hook 沉默走 rung-stale，由 sampling 决定——绝不 idle-forever", async () => {
    const clock = { now: 2_000_000 };
    const { svc, post } = makeApp(clock);
    await post("Stop", "idle"); // relay 死前最后遗言
    expect(svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt");
    // seat 开始新 turn；死 relay 什么都不报。sampling 看到输出。
    clock.now += HOOK_AUTHORITY_WINDOW_MS + 1_000;
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "window-sampling",
      sourceId: "tmux:window-activity", seq: 999, observedAt: new Date(clock.now).toISOString(),
      activity: "working",
    });
    const s = svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working");
    expect(s.decidedBy).toBe("window-sampling"); // rung-stale = 穿透；relay 之死绝不冻结 state
  });

  it("chrome 与 hooks 携带的 needs-input 同时存在时 chrome 优先", async () => {
    const clock = { now: 2_000_000 };
    const { svc, post } = makeApp(clock);
    svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, {
      ...CLAUDE_INVENTORY,
      rungs: [...CLAUDE_INVENTORY.rungs, { rung: "needs-input-chrome", lifecycleCoverage: "full", initialTrust: "authoritative" }],
    });
    await post("Notification", "needs_input"); // hooks：count 1，fixture 的 "turn boundary" reason
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "needs-input-chrome",
      sourceId: "tmux:chrome", seq: 500, observedAt: new Date(clock.now).toISOString(),
      needsInput: { count: 2, reason: "usage limit" },
    });
    expect(svc.getSeatState(SEAT)!.needsInput).toEqual({ count: 2, reason: "usage limit" });
  });
});
