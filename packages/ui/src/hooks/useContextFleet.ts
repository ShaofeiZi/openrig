// Token / 上下文用量界面 v0（PL-012）——跨 fleet 的上下文视图。
//
// 先拉 /api/ps，再逐 rig 拉 /api/rigs/:id/nodes（与 rig ps --nodes -A 组装
// 跨 rig 列表的方式一致——走后台服务 API，不受 v0.4.4 CLI 默认翻转影响），
// 用既有的 contextUsage 块丰富每个节点，并投影为扁平的每席位列表，供 /context 仪表盘使用。
//
// v0 不新增后台服务路由；复用已上线的能力。

import { useQuery } from "@tanstack/react-query";
import type { NodeInventoryEntry } from "./useNodeInventory.js";

export type ContextTier = "critical" | "warning" | "low" | "unknown";

export interface FleetSeat {
  rigId: string;
  rigName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  runtime: string | null;
  usedPercentage: number | null;
  fresh: boolean;
  availability: string;
  sampledAt: string | null;
  tier: ContextTier;
}

export interface FleetSummary {
  total: number;
  byTier: Record<ContextTier, number>;
  byRuntime: Record<string, number>;
  byRig: Array<{ rigId: string; rigName: string; count: number }>;
}

export interface FleetData {
  seats: FleetSeat[];
  summary: FleetSummary;
}

export function deriveContextTier(percent: number | null | undefined, availability?: string): ContextTier {
  if (availability !== "known" || typeof percent !== "number") return "unknown";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "low";
}

interface PsRig {
  rigId: string;
  name: string;
  rigName?: string;
}

async function fetchFleet(): Promise<FleetData> {
  const psRes = await fetch("/api/ps");
  if (!psRes.ok) throw new Error(`/api/ps 返回 HTTP ${psRes.status}`);
  const rigs = (await psRes.json()) as PsRig[];

  const seats: FleetSeat[] = [];
  for (const rig of rigs) {
    const rigName = rig.rigName ?? rig.name;
    const nodesRes = await fetch(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`);
    if (!nodesRes.ok) continue;
    const nodes = (await nodesRes.json()) as NodeInventoryEntry[];
    for (const n of nodes) {
      const ctx = n.contextUsage;
      const usedPercentage = ctx?.usedPercentage ?? null;
      const availability = ctx?.availability ?? "unknown";
      const fresh = ctx?.fresh ?? false;
      seats.push({
        rigId: rig.rigId,
        rigName,
        logicalId: n.logicalId,
        canonicalSessionName: n.canonicalSessionName,
        runtime: n.runtime,
        usedPercentage,
        fresh,
        availability,
        sampledAt: ctx?.sampledAt ?? null,
        tier: deriveContextTier(usedPercentage, availability),
      });
    }
  }

  const byTier: Record<ContextTier, number> = { critical: 0, warning: 0, low: 0, unknown: 0 };
  const byRuntime: Record<string, number> = {};
  const byRigCount = new Map<string, { rigName: string; count: number }>();
  for (const s of seats) {
    byTier[s.tier]++;
    const rt = s.runtime ?? "unknown";
    byRuntime[rt] = (byRuntime[rt] ?? 0) + 1;
    const existing = byRigCount.get(s.rigId);
    if (existing) existing.count++;
    else byRigCount.set(s.rigId, { rigName: s.rigName, count: 1 });
  }
  const byRig = Array.from(byRigCount.entries()).map(([rigId, v]) => ({ rigId, rigName: v.rigName, count: v.count }));

  return {
    seats,
    summary: { total: seats.length, byTier, byRuntime, byRig },
  };
}

export function useContextFleet() {
  return useQuery({
    queryKey: ["context-fleet"],
    queryFn: fetchFleet,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}
