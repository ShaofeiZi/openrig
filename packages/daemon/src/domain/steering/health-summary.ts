// Operator Surface Reconciliation v0——健康状态摘要聚合器。
//
// 第 1F 项：steering 表面上的紧凑健康门禁，包含两种聚合：
//   - nodes：跨工作组汇总节点 sessionStatus + lifecycleState
//     （镜像 `zrig ps --nodes --summary` 形状；UI 用于展示
//     "running / detached / attention-required" 徽章）。
//   - context：跨工作组汇总上下文用量紧急度与新鲜度
//     （镜像 `rigx-context --json` 摘要；UI 用于展示
//     "critical / warning / ok / stale" 徽章）。
//
// 在后台服务侧聚合而不是调用 CLI shell：steering 组合器保留在进程内，
// 避免每个请求都生成子进程；数据相同，成本更低。

import type Database from "better-sqlite3";
import type { RigRepository } from "../rig-repository.js";
import { getNodeInventory } from "../node-inventory.js";

export interface NodeHealthSummary {
  /** 所有工作组的节点总数。 */
  total: number;
  /** 按 node.sessionStatus 分组的计数（running / detached / exited / unknown）。 */
  bySessionStatus: Record<string, number>;
  /** 按 lifecycleState 分组的计数（running / recoverable / detached / attention_required）。 */
  byLifecycle: Record<string, number>;
  /** 供 steering 表面标题数字使用的便捷汇总。 */
  attentionRequired: number;
}

export interface ContextHealthSummary {
  /** 上下文存储已知的节点总数。 */
  total: number;
  /** 按上下文紧急度分组的计数（critical / warning / low / unknown）。 */
  byUrgency: Record<string, number>;
  /** 按最近样本新鲜度分组的计数（fresh / stale / none）。 */
  byFreshness: Record<string, number>;
  /** steering 表面重点展示的便捷汇总。 */
  critical: number;
  warning: number;
  stale: number;
}

const FRESHNESS_THRESHOLD_S = 300;
const URGENCY_CRITICAL_PCT = 80;
const URGENCY_WARNING_PCT = 60;

export function computeNodeHealthSummary(deps: { db: Database.Database; rigRepo: RigRepository }): NodeHealthSummary {
  const rigs = deps.rigRepo.listRigs();
  const bySessionStatus: Record<string, number> = {};
  const byLifecycle: Record<string, number> = {};
  let total = 0;
  let attentionRequired = 0;
  for (const rig of rigs) {
    const inventory = getNodeInventory(deps.db, rig.id);
    for (const node of inventory) {
      total++;
      const sessionStatus = node.sessionStatus ?? "unknown";
      bySessionStatus[sessionStatus] = (bySessionStatus[sessionStatus] ?? 0) + 1;
      const lifecycle = (node as { lifecycleState?: string }).lifecycleState ?? "unknown";
      byLifecycle[lifecycle] = (byLifecycle[lifecycle] ?? 0) + 1;
      if (lifecycle === "attention_required") attentionRequired++;
    }
  }
  return { total, bySessionStatus, byLifecycle, attentionRequired };
}

/** 将 context_usage 行归并为 steering 健康状态摘要。紧急度由 usedPercentage 阈值推导
 *（≥80 为 critical，≥60 为 warning，否则为 low）；新鲜度由 sampledAt 的时间差与
 * FRESHNESS_THRESHOLD_S（300 秒）比较得出。这里直接读取 context_usage，因为
 * ContextUsageStore 有意只暴露逐节点访问器；列出全部行属于 steering 表面职责，
 * 而不是逐节点职责。 */
export function computeContextHealthSummary(deps: { db: Database.Database }): ContextHealthSummary {
  let samples: Array<{ usedPercentage: number | null; sampledAt: string | null }> = [];
  try {
    samples = deps.db.prepare(
      `SELECT used_percentage AS usedPercentage, sampled_at AS sampledAt FROM context_usage`,
    ).all() as Array<{ usedPercentage: number | null; sampledAt: string | null }>;
  } catch {
    // 表不存在（测试工具未应用迁移）时返回空摘要。
    samples = [];
  }
  const byUrgency: Record<string, number> = { critical: 0, warning: 0, low: 0, unknown: 0 };
  const byFreshness: Record<string, number> = { fresh: 0, stale: 0, none: 0 };
  let critical = 0;
  let warning = 0;
  let stale = 0;
  const now = Date.now();
  for (const sample of samples) {
    const used = sample.usedPercentage;
    let urgencyKey: keyof typeof byUrgency;
    if (used == null) urgencyKey = "unknown";
    else if (used >= URGENCY_CRITICAL_PCT) { urgencyKey = "critical"; critical++; }
    else if (used >= URGENCY_WARNING_PCT) { urgencyKey = "warning"; warning++; }
    else urgencyKey = "low";
    byUrgency[urgencyKey] = (byUrgency[urgencyKey] ?? 0) + 1;

    let freshnessKey: keyof typeof byFreshness;
    if (!sample.sampledAt) freshnessKey = "none";
    else {
      const ageS = (now - new Date(sample.sampledAt).getTime()) / 1000;
      if (ageS > FRESHNESS_THRESHOLD_S) { freshnessKey = "stale"; stale++; }
      else freshnessKey = "fresh";
    }
    byFreshness[freshnessKey] = (byFreshness[freshnessKey] ?? 0) + 1;
  }
  return {
    total: samples.length,
    byUrgency,
    byFreshness,
    critical,
    warning,
    stale,
  };
}
