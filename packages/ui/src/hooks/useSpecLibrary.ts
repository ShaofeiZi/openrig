import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";
import type { RigSpecReview, AgentSpecReview } from "./useSpecReview.js";

export type SpecLibraryKind = "rig" | "agent" | "workflow";

export interface SpecLibraryEntry {
  id: string;
  kind: SpecLibraryKind;
  name: string;
  version: string;
  sourceType: "builtin" | "user_file";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  summary?: string;
  hasServices?: boolean;
  // Spec Library v0 中的工作流——仅工作流相关的元数据。
  isBuiltIn?: boolean;
  rolesCount?: number;
  stepsCount?: number;
  terminalTurnRule?: string;
  targetRig?: string | null;
  // Slice 11（workflow-spec-folder-discovery）——对操作者 specs/workflows 文件夹
  // 中浮现的工作流行的诊断状态。
  status?: "valid" | "error";
  errorMessage?: string | null;
}

export interface LibraryReview {
  libraryEntryId: string;
  sourcePath: string;
  sourceState: "library_item";
}

export type LibraryRigReview = RigSpecReview & LibraryReview;
export type LibraryAgentReview = AgentSpecReview & LibraryReview;

// Spec Library v0 中的工作流——工作流评审负载的结构。
export interface LibraryWorkflowReview {
  kind: "workflow";
  libraryEntryId: string;
  name: string;
  version: string;
  purpose: string | null;
  targetRig: string | null;
  terminalTurnRule: string;
  rolesCount: number;
  stepsCount: number;
  isBuiltIn: boolean;
  sourcePath: string;
  cachedAt: string;
  topology: {
    nodes: Array<{
      stepId: string;
      role: string;
      objective: string | null;
      preferredTarget: string | null;
      isEntry: boolean;
      isTerminal: boolean;
      // OPR.0.4.6.WF4（C1，架构 Q1）——既有扫描器早于 WF-2 引入的节点字段。
      // 可选、缺失即省略：WF-2 之前的 spec 投影不带这些键（逐字节一致）。
      // 结构与后台服务完全镜像（spec-library-workflow-scanner.ts / workflow-types.ts）：
      // harness = WorkflowAgentHarness，gate = WorkflowGateSpec {target,summary?,evidence_ref?}。
      harness?: "claude-code" | "codex";
      host?: string;
      gate?: { target: string; summary?: string; evidence_ref?: string };
    }>;
    edges: Array<{
      fromStepId: string;
      toStepId: string;
      // OPR.0.4.6.WF4（C1）——"branch" 指带 next_hop.on 条件的边（既有扫描器此前完全丢弃这类边）。
      // branchOn = 触发路由的已记录退出（WorkflowExitKind）；直连边上不存在。
      routingType: "direct" | "branch";
      branchOn?: "handoff" | "waiting" | "done" | "failed";
    }>;
  };
  steps: Array<{
    stepId: string;
    role: string;
    objective: string | null;
    allowedExits: string[];
    allowedNextSteps: Array<{ stepId: string; role: string }>;
  }>;
}

async function fetchLibraryEntries(kind: SpecLibraryKind | undefined, hostId: string): Promise<SpecLibraryEntry[]> {
  // OPR.0.4.6.MH2 FR-2 —— 所选主机信封；来源形态逐字透传；本地路径不变
  // （对本地而言 withHostParam 是恒等变换）。
  const url = kind ? `/api/specs/library?kind=${kind}` : "/api/specs/library";
  const res = await fetch(withHostParam(url, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchLibraryReview(id: string, hostId: string): Promise<LibraryRigReview | LibraryAgentReview | LibraryWorkflowReview> {
  const res = await fetch(withHostParam(`/api/specs/library/${encodeURIComponent(id)}/review`, hostId));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function useSpecLibrary(kind?: SpecLibraryKind) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["spec-library", kind ?? "all", hostId],
    queryFn: () => fetchLibraryEntries(kind, hostId),
    placeholderData: keepPreviousData,
  });
}

export function useLibraryReview(id: string | null) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["spec-library", "review", id, hostId],
    queryFn: () => fetchLibraryReview(id!, hostId),
    enabled: !!id,
    placeholderData: keepPreviousData,
  });
}

// 注意（MH-2）：active-lens 刻意不重新定向——它是带有写动词的本地操作者偏好，
// 不在读取白名单之列。

// --- Spec Library v0 中的工作流：active-lens hook ---

export interface ActiveLensPayload {
  specName: string;
  specVersion: string;
  activatedAt: string;
}

async function fetchActiveLens(): Promise<ActiveLensPayload | null> {
  const res = await fetch("/api/specs/library/active-lens");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { activeLens: ActiveLensPayload | null };
  return body.activeLens ?? null;
}

export function useActiveLens() {
  return useQuery({
    queryKey: ["spec-library", "active-lens"],
    queryFn: fetchActiveLens,
    staleTime: 0,
  });
}

export async function setActiveLens(specName: string, specVersion: string): Promise<ActiveLensPayload | null> {
  const res = await fetch("/api/specs/library/active-lens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ specName, specVersion }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { activeLens: ActiveLensPayload | null };
  return body.activeLens ?? null;
}

export async function clearActiveLens(): Promise<void> {
  const res = await fetch("/api/specs/library/active-lens", { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
