import { useQuery } from "@tanstack/react-query";
import { getActivityStateWithSource } from "../lib/activity-visuals.js";
import type { NodeInventoryEntry } from "./useNodeInventory.js";

export interface NeedsInputSeatEntry {
  logicalId: string;
  sessionName?: string | null;
  source: string;
  eventAt?: string | null;
  sampledAt?: string;
  rigId?: string;
}

export function useNeedsInputSeats() {
  return useQuery<NeedsInputSeatEntry[]>({
    queryKey: ["needs-input-seats"],
    queryFn: async () => {
      const psRes = await fetch("/api/ps");
      if (!psRes.ok) return [];
      const rigs = (await psRes.json()) as Array<{ rigId: string }>;
      const allSeats: NeedsInputSeatEntry[] = [];
      for (const rig of rigs) {
        let nodes: NodeInventoryEntry[];
        try {
          // OPR.0.4.3 healthz-wedge 修复：这是唯一需要对无 hook 席位做
          // 面板启发式 needs_input（优先级 #3）的消费方，因此它选择带 ?full=true 的
          // 逐节点 tmux 捕获。其他所有节点消费方（拓扑图/拓扑表）仍用廉价的快照默认。
          const nodesRes = await fetch(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes?full=true`);
          if (!nodesRes.ok) continue;
          nodes = (await nodesRes.json()) as NodeInventoryEntry[];
        } catch {
          continue;
        }
        for (const node of nodes) {
          const { state, source } = getActivityStateWithSource(node.agentActivity, node.terminalActive);
          if (state === "needs_input") {
            allSeats.push({
              logicalId: node.logicalId,
              sessionName: node.canonicalSessionName,
              source,
              eventAt: node.agentActivity?.eventAt,
              sampledAt: node.agentActivity?.sampledAt,
              rigId: rig.rigId,
            });
          }
        }
      }
      return allSeats;
    },
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}
