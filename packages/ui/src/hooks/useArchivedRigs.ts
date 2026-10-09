import { useQuery } from "@tanstack/react-query";
import type { RigSummary } from "./useRigSummary.js";

// OPR.0.3.3.19——资源管理器“归档”分区专用的已归档工作组摘要。它与默认视图使用的
// useRigSummary 是独立查询，因此默认树/图/表仍只显示活动项；我们不会在客户端过滤
// 全部工作组列表（多个表面共享 useRigSummary）。沿用已交付的 stream-items 归档先例：
// 使用专门的仅归档读取。
async function fetchArchived(): Promise<RigSummary[]> {
  const res = await fetch("/api/rigs/summary?archived=only");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 只获取已归档工作组。调用方可通过 `enabled` 保持延迟扇出，例如仅在展开“归档”分区后
 * 获取，从而让折叠状态下的归档分区不产生开销。
 */
export function useArchivedRigs(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["rigs", "summary", "archived"],
    queryFn: fetchArchived,
    enabled: options?.enabled ?? true,
  });
}
