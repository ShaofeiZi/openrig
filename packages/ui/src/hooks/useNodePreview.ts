// 预览终端 v0（PL-018）——实时终端预览的界面 hook。
//
// 按操作者配置的间隔轮询 /api/rigs/:rigId/nodes/:logicalId/preview
// （`ui.preview.refresh_interval_seconds`，默认 3 秒；从 /api/config 读取）。
// 当后台服务没有该新路由（跨 CLI 版本漂移）时诚实兜底：消费方看到的是
// `unavailable: true` 而非异常。

import { useQuery } from "@tanstack/react-query";
import { useSettings } from "./useSettings.js";
import { terminalAuthHeaders } from "../components/mission-control/missionControlAuth.js";

export interface NodePreviewResponse {
  content: string;
  lines: number;
  sessionName: string;
  capturedAt: string;
}

export interface NodePreviewUnavailable {
  unavailable: true;
  reason: string;
  hint?: string;
}

export async function fetchNodePreview(
  rigId: string,
  logicalId: string,
  lines: number,
): Promise<NodePreviewResponse | NodePreviewUnavailable> {
  const url = `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/preview?lines=${lines}`;
  const res = await fetch(url, { headers: terminalAuthHeaders() });
  // 后台服务无此路由，或节点不存在 → 404 视为不可用。
  if (res.status === 404) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { unavailable: true, reason: body.error ?? "preview_unavailable" };
  }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    return { unavailable: true, reason: body.error ?? "session_unbound", hint: body.hint };
  }
  if (res.status === 502) {
    const body = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    return { unavailable: true, reason: body.error ?? "capture_failed", hint: body.hint };
  }
  if (res.status === 503) {
    const body = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    return { unavailable: true, reason: body.error ?? "preview_unavailable", hint: body.hint };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as NodePreviewResponse;
}

export interface UseNodePreviewOpts {
  rigId: string | null;
  logicalId: string | null;
  /** 覆盖行数；默认取 ui.preview.default_lines。 */
  lines?: number;
  /** 暂停轮询（例如抽屉折叠时）。 */
  paused?: boolean;
}

export function useNodePreview(opts: UseNodePreviewOpts) {
  const { data: settings } = useSettings();
  const intervalSeconds = settings?.settings?.["ui.preview.refresh_interval_seconds"]?.value as number | undefined;
  const defaultLines = settings?.settings?.["ui.preview.default_lines"]?.value as number | undefined;
  const lines = opts.lines ?? defaultLines ?? 50;
  const refetchInterval = opts.paused ? false : ((intervalSeconds ?? 3) * 1000);

  return useQuery({
    queryKey: ["node-preview", opts.rigId, opts.logicalId, lines],
    queryFn: () => fetchNodePreview(opts.rigId!, opts.logicalId!, lines),
    enabled: !!opts.rigId && !!opts.logicalId && !opts.paused,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}

export function isNodePreviewUnavailable(
  data: NodePreviewResponse | NodePreviewUnavailable | undefined,
): data is NodePreviewUnavailable {
  return Boolean(data && "unavailable" in data);
}

// --- 按会话名预览（与“有会话名但无 rigId/logicalId”的界面组合使用——
// Loop State 面板、Slice Story 视图的 Topology 标签页）。结构相同，路由不同。 ---

export async function fetchSessionPreview(
  sessionName: string,
  lines: number,
): Promise<NodePreviewResponse | NodePreviewUnavailable> {
  const url = `/api/sessions/${encodeURIComponent(sessionName)}/preview?lines=${lines}`;
  const res = await fetch(url, { headers: terminalAuthHeaders() });
  if (res.status === 404) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    return { unavailable: true, reason: body.error ?? "preview_unavailable" };
  }
  if (res.status === 502 || res.status === 503) {
    const body = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    return { unavailable: true, reason: body.error ?? "preview_unavailable", hint: body.hint };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as NodePreviewResponse;
}

export function useSessionPreview(opts: {
  sessionName: string | null;
  lines?: number;
  paused?: boolean;
}) {
  const { data: settings } = useSettings();
  const intervalSeconds = settings?.settings?.["ui.preview.refresh_interval_seconds"]?.value as number | undefined;
  const defaultLines = settings?.settings?.["ui.preview.default_lines"]?.value as number | undefined;
  const lines = opts.lines ?? defaultLines ?? 50;
  const refetchInterval = opts.paused ? false : ((intervalSeconds ?? 3) * 1000);

  return useQuery({
    queryKey: ["session-preview", opts.sessionName, lines],
    queryFn: () => fetchSessionPreview(opts.sessionName!, lines),
    enabled: !!opts.sessionName && !opts.paused,
    refetchInterval,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
}
