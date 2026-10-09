import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

export interface DiscoveredSession {
  id: string;
  tmuxSession: string;
  tmuxWindow: string | null;
  tmuxPane: string | null;
  pid: number | null;
  cwd: string | null;
  activeCommand: string | null;
  runtimeHint: string;
  confidence: string;
  evidenceJson: string | null;
  configJson: string | null;
  status: string;
  claimedNodeId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DiscoveryQuery {
  status?: string;
  runtimeHint?: string[];
  minConfidence?: "lowest" | "low" | "medium" | "high" | "highest";
}

export type DiscoveryAdoptTarget =
  | { kind: "node"; logicalId: string }
  | { kind: "pod"; podId: string; podNamespace: string; memberName: string };

/** 触发一次发现扫描。成功后使发现列表相关查询失效。 */
export function useDiscoveryScan() {
  const queryClient = useQueryClient();
  return useMutation<{ sessions: DiscoveredSession[] }, Error>({
    mutationFn: async () => {
      const res = await fetch("/api/discovery/scan", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["discovery"] });
    },
  });
}

function buildDiscoveryUrl(query?: DiscoveryQuery): string {
  const params = new URLSearchParams();
  if (query?.status) params.set("status", query.status);
  if (query?.runtimeHint && query.runtimeHint.length > 0) {
    params.set("runtimeHint", query.runtimeHint.join(","));
  }
  if (query?.minConfidence) params.set("minConfidence", query.minConfidence);
  const qs = params.toString();
  return qs ? `/api/discovery?${qs}` : "/api/discovery";
}

/** 读取已发现会话列表。纯读取，不触发扫描副作用。对非数组响应做归一化。 */
export function useDiscoveredSessions(query?: DiscoveryQuery, enabled: boolean = true) {
  const url = buildDiscoveryUrl(query);
  const queryKey = ["discovery", query?.status ?? "all", query?.runtimeHint?.join(",") ?? "any", query?.minConfidence ?? "any"];
  return useQuery<DiscoveredSession[]>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    enabled,
  });
}

/** 发现会话的条件 hook——仅在 enabled 为真时才发起请求 */
export function useDiscoveredSessionsConditional(enabled: boolean): DiscoveredSession[] {
  const { data } = useDiscoveredSessions({ status: "active" }, enabled);
  return data ?? [];
}

// useClaimSession 已移除——请改用 useBindSession

/** 把一个已发现会话绑定到既有的逻辑节点。失效发现列表与 rig 图。 */
export function useBindSession() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: true; nodeId: string; sessionId: string }, Error, { discoveredId: string; rigId: string; logicalId: string }>({
    mutationFn: async ({ discoveredId, rigId, logicalId }) => {
      const res = await fetch(`/api/discovery/${encodeURIComponent(discoveredId)}/bind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rigId, logicalId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["discovery"] });
      queryClient.invalidateQueries({ queryKey: ["rig", vars.rigId, "graph"] });
    },
  });
}

/** 通过绑定到既有节点或在 pod 内新建节点，把一个已发现会话纳入某个 rig。 */
export function useAdoptSession() {
  const queryClient = useQueryClient();
  return useMutation<
    { ok: true; nodeId: string; sessionId: string; action: "bind" | "create_and_bind"; logicalId: string },
    Error,
    { discoveredId: string; rigId: string; target: DiscoveryAdoptTarget }
  >({
    mutationFn: async ({ discoveredId, rigId, target }) => {
      const res = await fetch(`/api/discovery/${encodeURIComponent(discoveredId)}/adopt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rigId, target }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["discovery"] });
      queryClient.invalidateQueries({ queryKey: ["rig", vars.rigId, "graph"] });
    },
  });
}

/** 基于轮询的扫描触发器：激活期间每隔 intervalMs 扫描一次。 */
export function useDiscoveryPoll(intervalMs: number = 30_000, enabled: boolean = true) {
  const scanMutation = useDiscoveryScan();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // 挂载时先扫描一次
    scanMutation.mutate();
    // 之后按间隔轮询
    intervalRef.current = setInterval(() => {
      scanMutation.mutate();
    }, intervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs]);

  return scanMutation;
}
