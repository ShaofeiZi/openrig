// V0.3.1 slice 12 walk-item 1 —— mission scope 数据 hook。
//
// 封装 GET /api/missions/:missionId，这是聚合 mission 元数据的路由，
// 返回 missionPath + 过滤后的 SliceListEntry[]。与 useScopeMarkdown 配合，
// 经 /api/files/read 读取 README / PROGRESS 内容。

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";
import type { SliceListEntry } from "./useSlices.js";
import type { SpecGraphPayload } from "./useSlices.js";

/** V0.3.1 slice 13 巡检项 7——任务 frontmatter 的 `workflow_spec` 声明。由 missions 路由
 * 从 `<missionPath>/README.md` frontmatter 解析；缺失时为 null。 */
export interface MissionWorkflowSpecRef {
  name: string;
  version: string;
}

/** V0.3.1 slice 13 巡检项 7——投影后的任务拓扑。未声明 `workflow_spec` 时外层为 null；
 * 已声明但规格尚未进入缓存（已声明但未交付）时，外层中的 `specGraph` 为 null。 */
export interface MissionTopology {
  specGraph: SpecGraphPayload | null;
}

export interface MissionDataResponse {
  missionId: string;
  /** 任务目录的绝对文件系统路径。 */
  missionPath: string;
  /** 此任务中的切片（筛选后的 SliceListEntry[]）。 */
  slices: SliceListEntry[];
  /** V0.3.1 slice 13——workflow_spec frontmatter 声明。 */
  workflow_spec: MissionWorkflowSpecRef | null;
  /** V0.3.1 slice 13——投影后的任务拓扑（specGraph）。 */
  topology: MissionTopology | null;
}

export interface MissionUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

async function fetchMission(missionId: string, hostId: string): Promise<MissionDataResponse | MissionUnavailable> {
  // OPR.0.4.6.MH2 FR-2——选中主机信封；原始形态保持不变；本地路径不变，
  // withHostParam 对本地请求是恒等操作。
  const res = await fetch(withHostParam(`/api/missions/${encodeURIComponent(missionId)}`, hostId), { signal: AbortSignal.timeout(5_000) });
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    return {
      unavailable: true,
      error: body.error ?? "missions_route_unavailable",
      hint: body.hint,
    };
  }
  if (res.status === 404) {
    return {
      unavailable: true,
      error: "mission_not_found",
    };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MissionDataResponse;
}

export function useMission(missionId: string | null) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["mission", "detail", missionId, hostId],
    queryFn: () => fetchMission(missionId!, hostId),
    enabled: !!missionId,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: 30_000,
    // V0.3.1 slice 17 工作区状态正确性模式：窗口聚焦时重新拉取，
    // 这样新建了 slice 文件夹再切回标签页的操作者无需手动刷新就能看到新 slice。
    refetchOnWindowFocus: true,
  });
}
