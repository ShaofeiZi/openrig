// OPR.0.4.1.27——方案 B 级别控制：3 个具名级别与 5 组 feed.subscriptions 开关状态
// 相互映射。action_required 始终保持开启，绝不属于级别预设；级别只调整其余 4 种可切换类别。
import { describe, it, expect } from "vitest";
import type { FeedSubscriptionState } from "../src/hooks/useFeedSubscriptions.js";
import {
  FEED_LEVELS,
  levelToToggles,
  deriveLevel,
} from "../src/lib/feed-levels.js";

const floored = { actionRequired: true } as const satisfies Partial<FeedSubscriptionState>;

describe("feed-levels — Option-B level <-> toggle-preset mapping", () => {
  it("FEED_LEVELS = the 3 named levels, ordered needs-you -> highlights -> all-activity", () => {
    expect(FEED_LEVELS).toEqual(["needs-you", "highlights", "all-activity"]);
  });

  it("needs-you = action items only (all 4 toggleables off)", () => {
    expect(levelToToggles("needs-you")).toEqual({
      approvals: false, shipped: false, progress: false, auditLog: false,
    });
  });

  it("highlights (default) = approvals + shipped + progress on, audit-log off", () => {
    expect(levelToToggles("highlights")).toEqual({
      approvals: true, shipped: true, progress: true, auditLog: false,
    });
  });

  it("all-activity = everything on, incl. audit-log (observation)", () => {
    expect(levelToToggles("all-activity")).toEqual({
      approvals: true, shipped: true, progress: true, auditLog: true,
    });
  });

  it("levelToToggles never includes action_required (it is floored, not level-controlled)", () => {
    expect(levelToToggles("needs-you")).not.toHaveProperty("actionRequired");
  });

  it("deriveLevel maps each named preset back (action_required ignored)", () => {
    expect(deriveLevel({ ...floored, approvals: false, shipped: false, progress: false, auditLog: false })).toBe("needs-you");
    expect(deriveLevel({ ...floored, approvals: true, shipped: true, progress: true, auditLog: false })).toBe("highlights");
    expect(deriveLevel({ ...floored, approvals: true, shipped: true, progress: true, auditLog: true })).toBe("all-activity");
  });

  it("a non-preset toggle combination derives 'custom' (advanced individual-toggle escape hatch)", () => {
    expect(deriveLevel({ ...floored, approvals: true, shipped: false, progress: false, auditLog: false })).toBe("custom");
    expect(deriveLevel({ ...floored, approvals: false, shipped: true, progress: true, auditLog: true })).toBe("custom");
  });

  it("round-trips: deriveLevel(levelToToggles(level)) === level for every named level", () => {
    for (const level of FEED_LEVELS) {
      expect(deriveLevel({ actionRequired: true, ...levelToToggles(level) })).toBe(level);
    }
  });
});
