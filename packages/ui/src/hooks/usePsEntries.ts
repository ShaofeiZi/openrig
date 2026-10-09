import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export interface PsEntry {
  rigId: string;
  name: string;
  nodeCount: number;
  /** 进程存活计数（旧版；语义不变）。 */
  runningCount: number;
  /**
   * Slice 15 —— 终端活跃计数：在静默窗口内仍产出 tmux 输出的节点子集。
   * 来自后台服务的 SeatActivityService。界面的活跃统计（如仪表盘 “Active”）
   * 读这个值，而非 runningCount。
   */
  activeCount?: number;
  /**
   * Slice 15 —— 有活可干计数：至少有一个待处理 qitem 分配到其规范会话名的节点子集。
   * 与 activeCount 分开渲染（“不推断”约定）。
   */
  hasWorkCount?: number;
  status: "running" | "partial" | "stopped";
  /** OPR.0.4.3.22 —— 由各节点状态折叠而来的 rig 级生命周期。后台服务的 /api/ps 投影
   *  已填充此字段；在此透传，便于各界面区分“可恢复”与“普通已停止”。 */
  lifecycleState?: "running" | "recoverable" | "stopped" | "degraded" | "attention_required";
  uptime: string | null;
  latestSnapshot: string | null;
}

async function fetchPsEntries(hostId: string, signal?: AbortSignal): Promise<PsEntry[]> {
  // OPR.0.4.6.MH2 FR-2 —— 所选主机信封；来源形态逐字透传；本地路径不变
  // （对本地而言 withHostParam 是恒等变换）。
  // slice-04：透传 TanStack query 的 AbortSignal，使被取代/取消的请求真正中止，而不是堆积。
  const res = await fetch(withHostParam("/api/ps", hostId), { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function usePsEntries() {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["ps", hostId],
    queryFn: ({ signal }) => fetchPsEntries(hostId, signal),
    refetchInterval: 3_000,
    placeholderData: keepPreviousData,
  });
}
