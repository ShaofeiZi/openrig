// V1 attempt-3 Phase 4 —— useCmuxLaunch。
//
// 对后台服务"打开或聚焦"端点的薄封装。
// `POST /api/rigs/:rigId/nodes/:logicalId/open-cmux` 在节点尚未绑定时创建一个
// cmux 界面，已绑定时则聚焦到既有界面。

import { useMutation } from "@tanstack/react-query";
import { terminalAuthHeaders } from "../components/mission-control/missionControlAuth.js";

interface CmuxLaunchInput {
  rigId: string;
  logicalId: string;
}

interface OpenCmuxResult {
  ok?: boolean;
  action?: string;
  code?: string;
  error?: string;
  message?: string;
}

export async function postOpenCmux({ rigId, logicalId }: CmuxLaunchInput): Promise<OpenCmuxResult> {
  const res = await fetch(
    `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/open-cmux`,
    { method: "POST", headers: terminalAuthHeaders() },
  );
  const body = (await res.json().catch(() => null)) as OpenCmuxResult | null;
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.message ?? body?.error ?? body?.code ?? `HTTP ${res.status}`);
  }
  return body ?? { ok: true };
}

export function useCmuxLaunch() {
  return useMutation({
    mutationFn: postOpenCmux,
  });
}
