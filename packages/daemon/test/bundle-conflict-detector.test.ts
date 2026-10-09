import { describe, it, expect } from "vitest";
import { detectBundleConflicts, type DetectConflictsInput } from "../src/domain/bundle-conflict-detector.js";

// Item 3 / slice-05 Checkpoint 4.1: bundle-conflict-detector pure-function tests.
// 判别模式：任何断言已报告冲突的测试，都必须在模块中对应检测分支被注释后失败。

describe("bundle-conflict-detector —— 工作组名称冲突", () => {
  // R1：runningRigs 为空时无冲突。
  it("runningRigs 为空时不产生冲突", () => {
    const input: DetectConflictsInput = { bundleRigName: "alpha", runningRigs: [] };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
    expect(report.conflicts).toHaveLength(0);
  });

  // R2：运行中工作组名称不同时无冲突。
  it("runningRigs 名称不同时不产生冲突", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "alpha",
      runningRigs: [
        { rigId: "01H000000000000000000001", name: "beta" },
        { rigId: "01H000000000000000000002", name: "gamma" },
      ],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
  });

  // R3：运行中工作组同名时，以正确结构报告冲突。
  it("同名运行中工作组产生 rig_name_collision 冲突", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "alpha",
      runningRigs: [
        { rigId: "01H000000000000000000003", name: "alpha" },
      ],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toHaveLength(1);
    const c = report.conflicts[0]!;
    expect(c.kind).toBe("rig_name_collision");
    expect(c.bundleRigName).toBe("alpha");
    if (c.kind === "rig_name_collision") {
      expect(c.collisionWith.rigId).toBe("01H000000000000000000003");
      expect(c.collisionWith.rigName).toBe("alpha");
      expect(c.description).toContain("alpha");
      expect(c.description).toContain("01H000000000000000000003");
      expect(c.resolutions.length).toBeGreaterThanOrEqual(2);
      // 解决方案提及 --target 和 --force 标志（Checkpoint 4.2 表面）。
      expect(c.resolutions.some((r) => r.includes("--target"))).toBe(true);
      expect(c.resolutions.some((r) => r.includes("--force"))).toBe(true);
    }
  });

  // R4：即使其他工作组排在匹配项之前，也能检测冲突。
  it("在多个工作组列表中只报告匹配项的冲突", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "alpha",
      runningRigs: [
        { rigId: "01H000000000000000000004", name: "beta" },
        { rigId: "01H000000000000000000005", name: "gamma" },
        { rigId: "01H000000000000000000006", name: "alpha" },
        { rigId: "01H000000000000000000007", name: "delta" },
      ],
    };
    const report = detectBundleConflicts(input);
    expect(report.conflicts).toHaveLength(1);
    if (report.conflicts[0]!.kind === "rig_name_collision") {
      expect(report.conflicts[0]!.collisionWith.rigId).toBe("01H000000000000000000006");
    }
  });

  // R5：bundleRigName 为空时无冲突（输入缺失时失败开放）。
  it("bundleRigName 为空时不产生冲突（没有工作组名便无从比较）", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "",
      runningRigs: [{ rigId: "01H000000000000000000008", name: "alpha" }],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
  });

  // R6：名称匹配区分大小写，只认精确名称。
  it("名称匹配区分大小写（大小写不同时无冲突）", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "alpha",
      runningRigs: [{ rigId: "01H000000000000000000009", name: "Alpha" }],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
  });
});
