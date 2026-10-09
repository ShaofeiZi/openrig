// PL-005 A 阶段：7 个任务控制动词的变更 hook。
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { missionControlAuthHeaders } from "../missionControlAuth.js";

export const MISSION_CONTROL_VERBS = [
  "approve",
  "deny",
  "route",
  "annotate",
  "hold",
  "drop",
  "handoff",
] as const;

export type MissionControlVerb = (typeof MISSION_CONTROL_VERBS)[number];

export interface MissionControlActionInput {
  verb: MissionControlVerb;
  qitemId: string;
  actorSession: string;
  destinationSession?: string;
  body?: string;
  annotation?: string;
  reason?: string;
  notify?: boolean;
  auditNotes?: Record<string, unknown>;
  /** OPR.0.4.4.15 FR-4 —— 远端事项的源主机：后台服务在服务端将动词
   *  转发到该主机的写入路径（缺省/'local' = 今日本地路径逐字节不变）。 */
  hostId?: string;
}

export interface MissionControlActionResult {
  actionId: string;
  verb: MissionControlVerb;
  qitemId: string;
  closedQitem: unknown;
  createdQitemId: string | null;
  notifyAttempted: boolean;
  notifyResult: string | null;
  auditedAt: string;
}

async function postAction(input: MissionControlActionInput): Promise<MissionControlActionResult> {
  const res = await fetch("/api/mission-control/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...missionControlAuthHeaders() },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(
      typeof body === "object" && body && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`,
    ) as Error & { code?: string; details?: unknown };
    if (typeof body === "object" && body && "error" in body) {
      err.code = String((body as { error: unknown }).error);
    }
    err.details = body;
    throw err;
  }
  return body as MissionControlActionResult;
}

export function useMissionControlAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postAction,
    onSuccess: (result, input) => {
      // 使所有任务控制视图失效，操作者无需手动刷新即可看到操作后状态。
      queryClient.invalidateQueries({ queryKey: ["mission-control", "view"] });
      queryClient.invalidateQueries({ queryKey: ["mission-control", "audit"] });
      queryClient.invalidateQueries({ queryKey: ["queue", "item", input.qitemId] });
      if (result.createdQitemId) {
        queryClient.invalidateQueries({ queryKey: ["queue", "item", result.createdQitemId] });
      }
      queryClient.invalidateQueries({ queryKey: ["slices"] });
    },
  });
}
