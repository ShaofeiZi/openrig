// LEG-7 LOW 1——isActiveRig 抽取（fold-wave qitem 79159e6f）。裸默认表投影
//（ps.ts ~L942）与 rigsOnHost scope 计数（~L1081）都内联应用相同的
// `.status !== "stopped"` active-rig 谓词。此处钉住它们现共享的唯一抽取
// `isActiveRig` 谓词，故 "1 of N" scope 标签与所显示行永不发散
//（LEG-2 QA 标记的 derived-label-must-carry-liveness 类）。先 RED：helper
// 导出前 import 不解析。
import { describe, expect, it } from "vitest";
import { isActiveRig } from "../src/commands/ps.js";

describe("isActiveRig — the one shared active-rig predicate (LEG-7 extraction)", () => {
  it("a rig is ACTIVE unless its status is exactly 'stopped'", () => {
    expect(isActiveRig({ status: "running" })).toBe(true);
    expect(isActiveRig({ status: "recoverable" })).toBe(true);
    expect(isActiveRig({ status: "degraded" })).toBe(true);
    expect(isActiveRig({ status: "stopped" })).toBe(false);
  });

  it("an absent/undefined status is ACTIVE (not stopped) — matches the pre-extraction inline behavior", () => {
    expect(isActiveRig({})).toBe(true);
    expect(isActiveRig({ status: undefined })).toBe(true);
  });
});
