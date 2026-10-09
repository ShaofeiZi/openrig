import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export interface AgentActivitySummary {
  state: "running" | "needs_input" | "idle" | "unknown";
  reason: string;
  evidenceSource: string;
  sampledAt: string;
  eventAt?: string | null;
  evidence?: string | null;
  staleness?: number | null;
  stale?: boolean;
  fallback?: boolean;
}

export interface CurrentQitemSummary {
  qitemId: string;
  bodyExcerpt: string;
  tier: string | null;
}

/**
 * OPR.0.4.3.19 —— 席位存活身份判定（第三轴），随 /nodes + /graph 负载到达。
 * `mismatch`/`pane_missing` 判定必须在每个 UI 表面把该席位从 active/running 降级；
 * 后台服务已为环形图合成 graph startupStatus=attention_required，活动圆点直接消费
 * 此判定（getActivityStateWithSource），不会静默忽略它。
 */
export interface SeatIdentityVerdictSummary {
  verdict: "verified" | "mismatch" | "pane_missing" | "tmux_unavailable";
  evidenceSource?: string | null;
  reason?: string | null;
  evidence?: {
    registeredPane?: string | null;
    observedPid?: number | null;
    observedCommand?: string | null;
    matchedLayer?: number | null;
  } | null;
  sessionName?: string | null;
  observedAt?: string;
}

export interface NodeInventoryEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  restoreOutcome: string;
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  latestError: string | null;
  contextUsage?: {
    usedPercentage: number | null;
    remainingPercentage: number | null;
    contextWindowSize: number | null;
    availability: string | null;
    sampledAt: string | null;
    fresh: boolean;
    totalInputTokens?: number | null;
    totalOutputTokens?: number | null;
  };
  // PL-019：后台服务经 attachAgentActivity 附加的智能体活动。
  agentActivity?: AgentActivitySummary | null;
  // PL-019：节点详情响应中后台服务 join 的进行中 qitem。
  currentQitems?: CurrentQitemSummary[];
  terminalActive?: boolean | null;
  hasAssignedWork?: boolean;
  pendingWorkCount?: number;
  // OPR.0.4.3.19 —— 存活身份判定（第三轴）。从未观测时为 null/缺失；
  // mismatch/pane_missing 把该席位降为非绿色。
  identityVerdict?: SeatIdentityVerdictSummary | null;
  agentRef?: string | null;
  profile?: string | null;
  codexConfigProfile?: string | null;
}

async function fetchNodeInventory(rigId: string, hostId: string): Promise<NodeInventoryEntry[]> {
  // OPR.0.4.6.MH2 FR-2 —— 所选主机信封；源结构逐字保留；
  // 本地路径不变（withHostParam 对本地为恒等）。
  const res = await fetch(withHostParam(`/api/rigs/${encodeURIComponent(rigId)}/nodes`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useNodeInventory(rigId: string | null) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["rig", rigId, "nodes", hostId],
    queryFn: () => fetchNodeInventory(rigId!, hostId),
    enabled: !!rigId,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}
