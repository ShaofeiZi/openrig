// Slice 18 §3.5 —— 持久化的任务状态查询。
//
// 对每个发现的任务扇出 GET /api/missions/:missionId，返回
// Map<missionId, status>。storytelling 预览以 status === "complete" 为门控，
// 这样 frontmatter 标注为 "complete" 的任务即使在全新浏览器/清空 localStorage 后
// 也会被隐藏。
//
// 每个 missionId 一个 react-query 查询——N 很小（storytelling 带目前最多取前 2 个
// 任务），所以扇出代价低。react-query 负责缓存 + 去重。

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

interface MissionDetailResponse {
  missionId: string;
  status?: string | null;
}

export interface UseMissionStatusesResult {
  statuses: Map<string, string | null>;
  isLoading: boolean;
}

export function useMissionStatuses(missionIds: string[]): UseMissionStatusesResult {
  const queries = useQueries({
    queries: missionIds.map((id) => ({
      queryKey: ["mission-status", id] as const,
      queryFn: async (): Promise<string | null> => {
        const res = await fetch(`/api/missions/${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        const body = (await res.json()) as MissionDetailResponse;
        return typeof body.status === "string" && body.status.length > 0 ? body.status : null;
      },
      enabled: id.length > 0,
      staleTime: 30_000,
    })),
  });

  return useMemo(() => {
    const statuses = new Map<string, string | null>();
    let isLoading = false;
    for (let i = 0; i < missionIds.length; i++) {
      const id = missionIds[i]!;
      const result = queries[i];
      statuses.set(id, result?.data ?? null);
      if (result?.isPending) isLoading = true;
    }
    return { statuses, isLoading };
  }, [missionIds, queries]);
}
