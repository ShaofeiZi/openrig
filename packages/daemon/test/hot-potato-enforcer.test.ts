import { describe, it, expect } from "vitest";
import {
  CLOSURE_REASONS,
  computeClosureRequiredAt,
  isClosureReason,
  validateClosure,
} from "../src/domain/hot-potato-enforcer.js";

describe("hot-potato-enforcer / validateClosure", () => {
  it("非 done 状态无需 closure reason 即可通过", () => {
    const r = validateClosure({ state: "in-progress" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.closureReason).toBeNull();
      expect(r.closureTarget).toBeNull();
    }
  });

  it("拒绝缺少 closure_reason 的 state=done", () => {
    const r = validateClosure({ state: "done" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("missing_closure_reason");
      expect(r.validReasons).toEqual(CLOSURE_REASONS);
    }
  });

  it("拒绝携带伪造 closure_reason 的 state=done", () => {
    const r = validateClosure({ state: "done", closureReason: "made-up-reason" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_closure_reason");
  });

  it.each(CLOSURE_REASONS)("接受带有效 closure_reason=%s 的 state=done", (reason) => {
    const target = (reason === "handed_off_to" || reason === "blocked_on" || reason === "escalation")
      ? "downstream-target"
      : null;
    const r = validateClosure({ state: "done", closureReason: reason, closureTarget: target });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.closureReason).toBe(reason);
  });

  it("拒绝缺少 closure_target 的 handed_off_to", () => {
    const r = validateClosure({ state: "done", closureReason: "handed_off_to" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_closure_target");
  });

  it("拒绝缺少 closure_target 的 blocked_on", () => {
    const r = validateClosure({ state: "done", closureReason: "blocked_on" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_closure_target");
  });

  it("拒绝缺少 closure_target 的 escalation", () => {
    const r = validateClosure({ state: "done", closureReason: "escalation" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_closure_target");
  });

  it("no-follow-on / canceled / denied 无 target 时可接受", () => {
    for (const reason of ["no-follow-on", "canceled", "denied"] as const) {
      const r = validateClosure({ state: "done", closureReason: reason });
      expect(r.ok).toBe(true);
    }
  });
});

describe("hot-potato-enforcer / isClosureReason", () => {
  it("识别全部 6 个枚举值", () => {
    for (const r of CLOSURE_REASONS) expect(isClosureReason(r)).toBe(true);
  });
  it("拒绝未知值", () => {
    expect(isClosureReason("nope")).toBe(false);
    expect(isClosureReason(null)).toBe(false);
    expect(isClosureReason(42)).toBe(false);
  });
});

describe("hot-potato-enforcer / computeClosureRequiredAt", () => {
  it("tier 为 null 时返回 null", () => {
    expect(computeClosureRequiredAt(new Date().toISOString(), null)).toBeNull();
  });
  it("tier 未知时返回 null", () => {
    expect(computeClosureRequiredAt(new Date().toISOString(), "made-up-tier")).toBeNull();
  });
  it("把 fast tier 计算为 claimed + 30 分钟", () => {
    const claimed = "2026-04-28T00:00:00.000Z";
    const required = computeClosureRequiredAt(claimed, "fast");
    expect(required).toBe("2026-04-28T00:30:00.000Z");
  });
  it("把 routine tier 计算为 claimed + 4 小时", () => {
    const claimed = "2026-04-28T00:00:00.000Z";
    const required = computeClosureRequiredAt(claimed, "routine");
    expect(required).toBe("2026-04-28T04:00:00.000Z");
  });
});
