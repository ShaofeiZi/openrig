import { describe, it, expect } from "vitest";
import {
  effectiveGateRoles,
  gateRolesOf,
  isGateTag,
  qitemIsGated,
} from "../src/domain/gate-predicate.js";

describe("gate-predicate（OPR.0.4.3.16——集中式队列门禁谓词）", () => {
  it("isGateTag 只识别格式正确的 gate:<role> tag", () => {
    expect(isGateTag("gate:guard")).toBe(true);
    expect(isGateTag("gate:spec-review")).toBe(true);
    expect(isGateTag("gate:")).toBe(false); // 角色为空。
    expect(isGateTag("mission:x")).toBe(false);
    expect(isGateTag("slice:16")).toBe(false);
    expect(isGateTag("notagate")).toBe(false);
  });

  it("gateRolesOf 提取角色并去重，同时保留顺序", () => {
    expect(gateRolesOf(["mission:x", "gate:guard", "gate:qa", "gate:guard"])).toEqual([
      "guard",
      "qa",
    ]);
    expect(gateRolesOf(null)).toEqual([]);
    expect(gateRolesOf([])).toEqual([]);
    expect(gateRolesOf(["slice:16"])).toEqual([]);
  });

  it("任意 gate:* tag 都会让 qitemIsGated 为 true（主谓词）", () => {
    expect(qitemIsGated({ tags: ["gate:guard"] })).toBe(true);
    expect(qitemIsGated({ tags: ["mission:x", "gate:spec-review"] })).toBe(true);
    expect(qitemIsGated({ tags: ["mission:x"], tier: "routine" })).toBe(false);
    expect(qitemIsGated({ tags: null })).toBe(false);
  });

  it("qitemIsGated 回退到 tier === human-gate（次谓词）", () => {
    expect(qitemIsGated({ tags: null, tier: "human-gate" })).toBe(true);
    expect(qitemIsGated({ tags: ["mission:x"], tier: "human-gate" })).toBe(true);
    expect(qitemIsGated({ tags: null, tier: "deep" })).toBe(false);
  });

  it("effectiveGateRoles 将 human-gate tier 显示为去重后的人类角色", () => {
    expect(effectiveGateRoles({ tags: ["gate:guard"], tier: "human-gate" })).toEqual([
      "guard",
      "human",
    ]);
    expect(effectiveGateRoles({ tags: ["gate:human"], tier: "human-gate" })).toEqual(["human"]);
    expect(effectiveGateRoles({ tags: null, tier: "human-gate" })).toEqual(["human"]);
    expect(effectiveGateRoles({ tags: null, tier: "routine" })).toEqual([]);
  });
});
