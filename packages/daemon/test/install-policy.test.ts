import { describe, it, expect } from "vitest";
import { applyPolicy } from "../src/domain/install-policy.js";
import type { InstallPlanEntry } from "../src/domain/install-planner.js";
import type { RefinedInstallPlan } from "../src/domain/conflict-detector.js";

function makeEntry(overrides: Partial<InstallPlanEntry>): InstallPlanEntry {
  return {
    exportType: "skill",
    exportName: "test",
    classification: "safe_projection",
    targetPath: "/target",
    scope: "project_shared",
    deferred: false,
    ...overrides,
  };
}

function makePlan(
  actionable: InstallPlanEntry[],
  conflicts: InstallPlanEntry[] = [],
  noOps: InstallPlanEntry[] = [],
): RefinedInstallPlan {
  return {
    packageName: "test-pkg",
    packageVersion: "1.0.0",
    sourceRef: "/pkg",
    entries: [...actionable, ...conflicts, ...noOps],
    actionable,
    deferred: [],
    conflicts,
    noOps,
  };
}

describe("InstallPolicy", () => {
  // 测试 1：safe_projection -> approved
  it("safe_projection -> approved", () => {
    const entry = makeEntry({ classification: "safe_projection" });
    const plan = makePlan([entry]);
    const result = applyPolicy(plan);

    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]).toBe(entry);
    expect(result.rejected).toHaveLength(0);
  });

  // 测试 2：没有 allowMerge 的 managed_merge -> rejected
  it("没有 allowMerge 的 managed_merge -> rejected，并说明原因", () => {
    const entry = makeEntry({ classification: "managed_merge", exportType: "guidance" });
    const plan = makePlan([entry]);
    const result = applyPolicy(plan);

    expect(result.approved).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("allowMerge");
  });

  // 测试 3：带 allowMerge 的 managed_merge -> approved
  it("带 allowMerge:true 的 managed_merge -> approved", () => {
    const entry = makeEntry({ classification: "managed_merge", exportType: "guidance" });
    const plan = makePlan([entry]);
    const result = applyPolicy(plan, { allowMerge: true });

    expect(result.approved).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  // 测试 4：config_mutation -> rejected，延后至 Phase 5
  it("config_mutation -> rejected，并说明延后至 Phase 5", () => {
    const entry = makeEntry({ classification: "config_mutation" });
    const plan = makePlan([entry]);
    const result = applyPolicy(plan);

    expect(result.approved).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("Phase 5");
  });

  // 测试 5：混合 plan -> 正确拆分
  it("混合 plan -> 正确拆分 approved 与 rejected", () => {
    const safe = makeEntry({ exportName: "safe-skill", classification: "safe_projection" });
    const merge = makeEntry({ exportName: "guidance", classification: "managed_merge", exportType: "guidance" });
    const mutation = makeEntry({ exportName: "hook", classification: "config_mutation" });
    const plan = makePlan([safe, merge, mutation]);
    const result = applyPolicy(plan);

    // 批准 safe，拒绝 merge + mutation
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0]!.exportName).toBe("safe-skill");
    expect(result.rejected).toHaveLength(2);
  });

  // 测试 6：有 conflict 的 entry -> 始终拒绝
  it("有 conflict 的 entry -> 无论 classification 如何都拒绝", () => {
    const entry = makeEntry({
      classification: "safe_projection",
      conflict: { existingPath: "/existing", reason: "different content" },
    });
    const plan = makePlan([], [entry]); // conflict 位于 conflicts array
    const result = applyPolicy(plan);

    expect(result.approved).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("安装前必须先解决冲突");
  });

  // 测试 7：external_install -> rejected，延后至 Phase 5
  it("external_install -> rejected，并说明延后至 Phase 5", () => {
    const entry = makeEntry({ classification: "external_install", exportType: "requirement" });
    const plan = makePlan([entry]);
    const result = applyPolicy(plan);

    expect(result.approved).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("Phase 5");
  });

  // 测试 8：conflict 同时位于 actionable + conflicts -> 不重复拒绝
  it("同时位于两个 array 的 conflicted entry -> 恰好拒绝一次", () => {
    const entry = makeEntry({
      exportName: "overlapping",
      classification: "safe_projection",
      conflict: { existingPath: "/existing", reason: "different content" },
    });
    // 模拟 entry 同时出现在两处的真实 refined-plan shape
    const plan = makePlan([entry], [entry]);
    const result = applyPolicy(plan);

    // 必须恰好拒绝一次，而非两次
    const overlappingRejections = result.rejected.filter(
      (r) => r.entry.exportName === "overlapping"
    );
    expect(overlappingRejections).toHaveLength(1);
    expect(overlappingRejections[0]!.reason).toContain("安装前必须先解决冲突");
  });
});
