// PL-019 item 6：topology edge-activity 事件归一化。hook
// 本身在下方 render-tree 测试中测；此处深挖
// normalize 步骤，它把每个已追踪事件类型的 payload 形状映射到
// 统一的 (source, dest) 有向对。

import { describe, it, expect } from "vitest";
import { __test_internals } from "../src/hooks/useTopologyEdgeActivity.js";

const { normalizeEvent, makeKey, JUST_FIRED_WINDOW_MS, RECENT_TRAFFIC_WINDOW_MS } = __test_internals;

describe("PL-019 topology edge-activity normalization", () => {
  it("queue.created maps sourceSession + destinationSession", () => {
    const out = normalizeEvent({
      type: "queue.created",
      sourceSession: "alpha@r",
      destinationSession: "beta@r",
      qitemId: "q1",
    });
    expect(out).toEqual({ type: "queue.created", source: "alpha@r", dest: "beta@r" });
  });

  it("queue.handed_off maps fromSession + toSession (handoff direction)", () => {
    const out = normalizeEvent({
      type: "queue.handed_off",
      fromSession: "alpha@r",
      toSession: "gamma@r",
      qitemId: "q2",
    });
    expect(out).toEqual({ type: "queue.handed_off", source: "alpha@r", dest: "gamma@r" });
  });

  it("qitem.fallback_routed maps originalDestination + rerouteDestination (the new owner edge lights up)", () => {
    const out = normalizeEvent({
      type: "qitem.fallback_routed",
      originalDestination: "alpha@r",
      rerouteDestination: "gamma@r",
      qitemId: "q3",
      reason: "no_pod_match",
    });
    expect(out).toEqual({ type: "qitem.fallback_routed", source: "alpha@r", dest: "gamma@r" });
  });

  it("returns null for unknown / non-PL-019 event types", () => {
    expect(normalizeEvent({ type: "rig.created", rigId: "r-1" })).toBeNull();
    expect(normalizeEvent({ type: "node.startup_completed", rigId: "r-1" })).toBeNull();
    // mission_control.action_executed 在 v0 故意不映射，
    // 因事件 payload 缺目标 session 对。
    expect(normalizeEvent({ type: "mission_control.action_executed", actorSession: "a@r" })).toBeNull();
  });

  it("returns null when required pair fields are missing", () => {
    expect(normalizeEvent({ type: "queue.created", sourceSession: "alpha@r" })).toBeNull();
    expect(normalizeEvent({ type: "queue.handed_off", fromSession: "alpha@r" })).toBeNull();
    expect(normalizeEvent({ type: "qitem.fallback_routed", originalDestination: "alpha@r" })).toBeNull();
  });

  it("returns null on malformed input (non-object / missing type)", () => {
    expect(normalizeEvent(null)).toBeNull();
    expect(normalizeEvent(undefined)).toBeNull();
    expect(normalizeEvent("not-an-object")).toBeNull();
    expect(normalizeEvent({ sourceSession: "x", destinationSession: "y" })).toBeNull();
  });

  it("makeKey produces directional keys (alpha→beta != beta→alpha)", () => {
    expect(makeKey("alpha@r", "beta@r")).not.toBe(makeKey("beta@r", "alpha@r"));
  });

  it("just-fired window is shorter than recent-traffic window (one-shot ⊂ sustained)", () => {
    expect(JUST_FIRED_WINDOW_MS).toBeLessThan(RECENT_TRAFFIC_WINDOW_MS);
    // 健全：设计指南称 one-shot ~1.2s，持续 ~30s。
    expect(JUST_FIRED_WINDOW_MS).toBe(1_200);
    expect(RECENT_TRAFFIC_WINDOW_MS).toBe(30_000);
  });
});
