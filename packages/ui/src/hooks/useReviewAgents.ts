// OPR.0.4.6.2（FR-5）——派生任务/切片视图的实时智能体名册。
// GET /api/review/agents?scope=mission:<id>|slice:<id> → 在该范围工作的智能体
// （与组合评审界面读取的是同一组）。终端启动器用它在打开派生视图前预览其名册；
// 权威的分区仍来自 open POST。

import { useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export interface ReviewAgentRow {
  sessionName: string;
  agentName: string;
  /** "active" | "parked" | "idle" | "unknown" —— 状态字形。 */
  stateGlyph: string;
  runtime: string;
  slices: string[];
}

export interface ReviewAgentsBand {
  scope: string;
  rows: ReviewAgentRow[];
}

async function fetchReviewAgents(scope: string, hostId: string): Promise<ReviewAgentsBand> {
  const res = await fetch(withHostParam(`/api/review/agents?scope=${encodeURIComponent(scope)}`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 拉取某个 mission:/slice: 范围的名册。传 null 则保持空闲（禁用）。 */
export function useReviewAgents(scope: string | null) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["review", "agents", scope, hostId],
    queryFn: () => fetchReviewAgents(scope as string, hostId),
    enabled: !!scope,
  });
}
