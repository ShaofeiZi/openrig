import type { InstallPlanEntry } from "./install-planner.js";
import type { RefinedInstallPlan } from "./conflict-detector.js";

export interface PolicyRejection {
  entry: InstallPlanEntry;
  reason: string;
}

export interface PolicyResult {
  approved: InstallPlanEntry[];
  rejected: PolicyRejection[];
}

/**
 * install plan entry 的轻量 policy gate。按 classification 审批 plan.actionable，
 * 并始终拒绝 plan.conflicts。不会重复处理同时出现在两个 array 中的 entry。
 */
export function applyPolicy(
  plan: RefinedInstallPlan,
  options: { allowMerge?: boolean } = {},
): PolicyResult {
  const approved: InstallPlanEntry[] = [];
  const rejected: PolicyRejection[] = [];

  // 跟踪已处理的 entry identity，避免重复拒绝
  const processed = new Set<string>();

  // 始终先拒绝 conflict
  for (const entry of plan.conflicts) {
    const key = `${entry.exportType}:${entry.exportName}`;
    if (!processed.has(key)) {
      processed.add(key);
      rejected.push({
        entry,
        reason: "安装前必须先解决冲突",
      });
    }
  }

  // 对可操作 entry 分类
  for (const entry of plan.actionable) {
    const key = `${entry.exportType}:${entry.exportName}`;
    if (processed.has(key)) continue; // 已作为 conflict 处理

    switch (entry.classification) {
      case "safe_projection":
        approved.push(entry);
        break;

      case "managed_merge":
        if (options.allowMerge) {
          approved.push(entry);
        } else {
          rejected.push({
            entry,
            reason: "managed_merge 需要 allowMerge flag",
          });
        }
        break;

      case "config_mutation":
        rejected.push({ entry, reason: "延后至 Phase 5" });
        break;

      case "external_install":
        rejected.push({ entry, reason: "延后至 Phase 5" });
        break;

      case "manual_only":
        rejected.push({ entry, reason: "Phase 4 不支持手动合并" });
        break;
    }
  }

  return { approved, rejected };
}
