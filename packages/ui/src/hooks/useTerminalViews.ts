// OPR.0.4.6.2（FR-5）——终端启动器使用的已保存视图与可打开工作组列表。
// GET /api/terminal/views → { saved, rigs }（C3 规范路由）。已保存视图与 provider 无关，
// 在启动时读取；派生视图（工作组/任务目标/slice）实时计算，绝不会出现在这里。

import { useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export interface SavedViewMemberDto {
  seat: string;
  label?: string;
  host?: string;
  tmuxSession?: string;
  readOnly?: boolean;
}

export interface SavedViewDto {
  id: string;
  name: string;
  members: SavedViewMemberDto[];
}

export interface TerminalViewsResponse {
  saved: SavedViewDto[];
  /** 可作为逐工作组派生视图打开的工作组名称。 */
  rigs: string[];
}

async function fetchTerminalViews(hostId: string): Promise<TerminalViewsResponse> {
  const res = await fetch(withHostParam("/api/terminal/views", hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useTerminalViews() {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["terminal", "views", hostId],
    queryFn: () => fetchTerminalViews(hostId),
    refetchInterval: 30_000,
  });
}
