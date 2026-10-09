import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  hasServices?: boolean;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
  /** OPR.0.4.3.22 —— 由逐节点状态折叠出的工作组级生命周期
   *  （running / recoverable / stopped / degraded / attention_required）。
   *  后台服务 /api/rigs/summary 路由已做富化；在这里携带，让 UI 界面无需二次往返
   *  就能选对操作员动作。 */
  lifecycleState?: "running" | "recoverable" | "stopped" | "degraded" | "attention_required";
}

async function fetchSummary(hostId: string, signal?: AbortSignal): Promise<RigSummary[]> {
  // OPR.0.4.6.MH2 FR-2 —— 所选 host 随查询信封携带；本地后台服务的透读逐字返回
  // 原始形态。local 保持今天的裸路径不变（对 local 而言 withHostParam 是恒等）。
  // slice-04：转发 TanStack query 的 AbortSignal，使取消的拉取能真正中止。
  const res = await fetch(withHostParam("/api/rigs/summary", hostId), { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useRigSummary() {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["rigs", "summary", hostId],
    queryFn: ({ signal }) => fetchSummary(hostId, signal),
    // FR-6：在新所选 host 的数据跨网络期间，保留上一个 host 的视图
    //（由指示器如实标注）。
    placeholderData: keepPreviousData,
  });
}
