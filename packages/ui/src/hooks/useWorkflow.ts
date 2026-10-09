// OPR.0.4.6.WF4（C3）——工作流实例的读取 hooks。
//
// FR-4 对齐护栏：这些 hooks 读取与 WF-3 CLI 相同的后台服务端点
// （routes/workflow.ts —— list / specs / :id / :id/trace），结构逐字一致，
// 界面侧对状态/截止时间/分支零重算（BR-4）。下面的类型镜像逐字段复述后台服务的读取契约，
// 已在 56556dcf 处亲自核对（C1/C2 未改动）：
//   WorkflowInstance             domain/workflow-types.ts:177
//   withDeadline 增强            domain/workflow-runtime.ts（截止时间判定）
//   WorkflowStepTrailEntry       domain/workflow-types.ts:224
//   WorkflowDeadlineVerdict      domain/workflow-deadline.ts
//   /api/workflow/specs 行       routes/workflow.ts:201-212（仅头部——工作流结构
//                                走 Library 评审负载，见 useSpecLibrary.ts）

import { useQuery } from "@tanstack/react-query";

export type WorkflowInstanceStatus = "active" | "waiting" | "completed" | "failed";
export type WorkflowExitKind = "handoff" | "waiting" | "done" | "failed";

export interface WorkflowStepDeadlineEvidence {
  instanceId: string;
  stepId: string | null;
  packetId: string;
  ownerSession: string;
  packetState: string;
  anchor: "closure_required_at" | "claimed_at" | "created_at";
  anchorAt: string;
  overdueBySeconds: number;
  ageSeconds: number;
  claimedAt: string | null;
}

export interface WorkflowDeadlineVerdict {
  state: "healthy" | "overdue-claimed" | "overdue-unclaimed";
  evidence: WorkflowStepDeadlineEvidence | null;
}

export interface WorkflowInstanceWithDeadline {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  createdBySession: string;
  createdAt: string;
  status: WorkflowInstanceStatus;
  currentFrontier: string[];
  currentStepId: string | null;
  hopCount: number;
  fallbackSynthesis: string | null;
  lastContinuationDecision: Record<string, unknown> | null;
  completedAt: string | null;
  version: number;
  resumeCount: number;
  hopsBaseline: number;
  deadline: WorkflowDeadlineVerdict;
}

export interface WorkflowStepTrailEntry {
  trailId: string;
  instanceId: string;
  stepId: string;
  stepRole: string;
  closedAt: string;
  closureReason: WorkflowExitKind;
  closureEvidence: Record<string, unknown> | null;
  actorSession: string;
  nextQitemId: string | null;
  priorQitemId: string;
}

export interface WorkflowSpecSummary {
  name: string;
  version: string;
  purpose: string | null;
  targetRig: string | null;
  coordinationTerminalTurnRule: string;
  sourcePath: string;
  cachedAt: string;
  isBuiltIn: boolean;
}

export interface WorkflowTrace {
  instance: WorkflowInstanceWithDeadline;
  trail: WorkflowStepTrailEntry[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** GET /api/workflow/list[?status=] —— 每个实例都携带派生的 WF-1 FR-2 截止时间判定
 *  （每次读取时重算，绝不持久化）。 */
export function useWorkflowInstances(status?: WorkflowInstanceStatus) {
  const qs = status ? `?status=${status}` : "";
  return useQuery({
    queryKey: ["workflow", "instances", status ?? "all"],
    queryFn: () => fetchJson<WorkflowInstanceWithDeadline[]>(`/api/workflow/list${qs}`),
    staleTime: 15_000,
  });
}

/** GET /api/workflow/:id —— 单个实例（详情），附带截止时间增强。 */
export function useWorkflowInstance(instanceId: string | null) {
  return useQuery({
    queryKey: ["workflow", "instance", instanceId],
    queryFn: () => fetchJson<WorkflowInstanceWithDeadline>(`/api/workflow/${encodeURIComponent(instanceId!)}`),
    enabled: !!instanceId,
    staleTime: 15_000,
  });
}

/** GET /api/workflow/specs —— 已缓存 spec 的头部（绝不含结构本体）。 */
export function useWorkflowSpecs() {
  return useQuery({
    queryKey: ["workflow", "specs"],
    queryFn: () => fetchJson<{ specs: WorkflowSpecSummary[] }>("/api/workflow/specs"),
    staleTime: 15_000,
  });
}

/** GET /api/workflow/:id/trace —— 实例 + 完整路由轨迹（与 `rig workflow trace`
 *  投影的是同一份读取；后台服务的 continue() 为只读，无写入）。 */
export function useWorkflowTrace(instanceId: string | null) {
  return useQuery({
    queryKey: ["workflow", "trace", instanceId],
    queryFn: () => fetchJson<WorkflowTrace>(`/api/workflow/${encodeURIComponent(instanceId!)}/trace`),
    enabled: !!instanceId,
    staleTime: 15_000,
  });
}
