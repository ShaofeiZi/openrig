// Operator Surface Reconciliation v0——引导钩子与类型。
//
// 封装 GET /api/steering。把后台服务的 "steering_workspace_not_configured" 503 路径
// 表达为结构化 `unavailable` 哨兵，使 UI 能显示设置提示，而不是因 payload 未定义而崩溃。

import { useQuery } from "@tanstack/react-query";

export interface PriorityStackPayload {
  content: string;
  absolutePath: string;
  mtime: string;
  byteCount: number;
}

export interface RoadmapRailItem {
  line: number;
  text: string;
  done: boolean;
  railItemCode: string | null;
  isNextUnchecked: boolean;
}

export interface RoadmapRailPayload {
  absolutePath: string;
  mtime: string;
  items: RoadmapRailItem[];
  counts: { total: number; done: number; nextUncheckedLine: number | null };
}

export interface LaneRailItem {
  line: number;
  text: string;
  status: "active" | "done" | "blocked" | "unknown";
  isNextPull: boolean;
}

export interface LaneRailPayload {
  laneId: string;
  absolutePath: string;
  mtime: string;
  topItems: LaneRailItem[];
  healthBadges: { active: number; blocked: number; done: number; total: number };
  nextPullLine: number | null;
}

export interface SteeringPayload {
  priorityStack: PriorityStackPayload | null;
  roadmapRail: RoadmapRailPayload | null;
  laneRails: LaneRailPayload[];
  unavailableSources: Array<{ section: string; reason: string; envVar?: string }>;
}

export interface SteeringUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

async function fetchSteering(): Promise<SteeringPayload | SteeringUnavailable> {
  const res = await fetch("/api/steering");
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    return { unavailable: true, error: body.error ?? "steering_unavailable", hint: body.hint };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SteeringPayload;
}

export function useSteering() {
  return useQuery({
    queryKey: ["steering"],
    queryFn: fetchSteering,
    staleTime: 30_000,
  });
}

// --- 健康状态摘要 ---

export interface NodeHealthSummary {
  total: number;
  bySessionStatus: Record<string, number>;
  byLifecycle: Record<string, number>;
  attentionRequired: number;
}

export interface ContextHealthSummary {
  total: number;
  byUrgency: Record<string, number>;
  byFreshness: Record<string, number>;
  critical: number;
  warning: number;
  stale: number;
}

async function fetchNodeHealth(): Promise<NodeHealthSummary> {
  const res = await fetch("/api/health-summary/nodes");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as NodeHealthSummary;
}

async function fetchContextHealth(): Promise<ContextHealthSummary> {
  const res = await fetch("/api/health-summary/context");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ContextHealthSummary;
}

export function useNodeHealth() {
  return useQuery({
    queryKey: ["health-summary", "nodes"],
    queryFn: fetchNodeHealth,
    staleTime: 30_000,
  });
}

export function useContextHealth() {
  return useQuery({
    queryKey: ["health-summary", "context"],
    queryFn: fetchContextHealth,
    staleTime: 30_000,
  });
}

// --- 规范评审钩子（第 3 项）---

export interface SpecReviewError {
  field?: string;
  message: string;
  severity?: "error" | "warning";
}

export interface SpecReviewResponse {
  ok?: boolean;
  errors?: SpecReviewError[];
  warnings?: SpecReviewError[];
  /** 后台服务可能包含额外元数据（sourceState 等）；原样透传。 */
  [k: string]: unknown;
}

async function fetchSpecReview(kind: "rig" | "agent", yaml: string): Promise<SpecReviewResponse> {
  const res = await fetch(`/api/specs/review/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml }),
  });
  // 对有效和无效规范，后台服务都会返回 200 与 errors[]（按 spec-review.ts 契约，
  // SpecReviewError 抛出路径才表现为 400）。两者都视为“已获得评审结果”。
  if (res.status === 400) {
    return (await res.json()) as SpecReviewResponse;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SpecReviewResponse;
}

export function useSpecReview(kind: "rig" | "agent" | null, yaml: string | null) {
  return useQuery({
    queryKey: ["spec-review", kind, yaml ? yaml.length : 0, yaml ? yaml.slice(0, 64) : ""],
    queryFn: () => fetchSpecReview(kind!, yaml!),
    enabled: !!kind && !!yaml,
    staleTime: 60_000,
  });
}
