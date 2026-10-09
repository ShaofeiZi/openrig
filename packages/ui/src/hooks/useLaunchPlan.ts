// OPR.0.4.3.22——获取只读的逐席位启动计划（POST /api/rigs/:id/launch-plan）。
// 启动/恢复弹窗会在任何变更前获取它（先计划后执行，AC-3）。此端点在结构上只读
//（mutated:false），绝不执行恢复或全新预热。传入 freshLogicalIds 可预测显式选择
// 全新启动时的预热计划。

import { useMutation } from "@tanstack/react-query";
import type { SeatTokenState, SeatIntendedAction } from "./useRigStatus.js";

export interface LaunchPlanNode {
  logicalId: string;
  intendedAction: SeatIntendedAction;
  reason?: string;
  tokenState: SeatTokenState;
  provenance?: string | null;
  lastVerified?: string | null;
  freshRequired: boolean;
  runtimePrompt?: string;
}

export interface LaunchPlan {
  status: "plan";
  mode: "restore";
  rigId: string;
  rigName: string;
  snapshot: { id: string; kind: string; createdAt: string } | null;
  wouldCaptureCurrentState: boolean;
  nodes: LaunchPlanNode[];
  mutated: false;
}

async function fetchLaunchPlan(rigId: string, freshLogicalIds?: string[]): Promise<LaunchPlan> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/launch-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(freshLogicalIds ? { freshLogicalIds } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `获取启动计划失败（HTTP ${res.status}）`);
  }
  return res.json();
}

/** 按需获取只读启动计划，例如弹窗打开或操作员切换策略时。采用 mutation 形态以便命令式
 *  调用，而非后台轮询；但它绝不改变工作组（后台服务路由只读）。 */
export function useLaunchPlan(rigId: string) {
  return useMutation({
    mutationFn: (freshLogicalIds?: string[]) => fetchLaunchPlan(rigId, freshLogicalIds),
  });
}
