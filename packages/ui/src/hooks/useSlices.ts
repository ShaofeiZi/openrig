// Slice Story View v0 —— 列表 + 详情端点的 UI hooks。
//
// 封装 GET /api/slices?filter=... 与 GET /api/slices/:name。两个查询都把后台服务的
// "slices_root_not_configured" 503 路径暴露为结构化错误对象，使 UI 能渲染安装提示
// 而非原始 503。

import { useMemo } from "react";
import { keepPreviousData, useQueries, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { withHostParam } from "../lib/host-param.js";
import { useSelectedHostId } from "./useHosts.js";

export type SliceStatus = "active" | "done" | "blocked" | "draft";
export type SliceFilter = "all" | "active" | "done" | "blocked";

export interface ProofReadiness { state: string; revision: string; configured?: boolean; historicalStatus?: string | null; slices?: Array<{ readiness: { configured: boolean } }> }

export interface SliceListEntry {
  readiness?: ProofReadiness;
  name: string;
  missionId: string | null;
  displayName: string;
  railItem: string | null;
  status: SliceStatus;
  rawStatus: string | null;
  /** OPR.0.3.2.17 —— 来自 slice frontmatter 的简短描述
   *  （description/summary 兜底）。storytelling 适配器把它作为 ConceptCard.oneLiner，
   *  用于 `rawStatus === "candidate"` 的切片。缺失时为 null。 */
  description?: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
  /** PL-007：slice 文件夹的绝对文件系统路径，UI 据此对照工作组的
   *  RigSpec.workspace 块解析 workspace 种类。 */
  slicePath?: string;
}

export interface SliceListResponse {
  slices: SliceListEntry[];
  totalCount: number;
  filter: SliceFilter;
  /** VM-005（release-0.4.7）：增量编写的 mission-status 旁车——按 missionId 为键
   *  （至少有一个已索引切片的任务），携带 README frontmatter 原始 `status:`（缺失时为 null）。
   *  芯片表面把它喂给 reconcileMissionStatus，使 authored-wins 优先级成立，无需第二次往返。
   *  可选：旧版后台服务省略它。 */
  missions?: Record<string, { authoredStatus: string | null; readiness?: ProofReadiness }>;
  // Spec Library v0 中的工作流——仅在应用 boundToWorkflow 过滤器时出现。
  boundToWorkflow?: {
    specName: string;
    specVersion: string;
    matched: number;
    total: number;
  };
}

export interface SlicesUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

export interface BoundToWorkflowFilter {
  specName: string;
  specVersion: string;
}

async function fetchSlicesList(
  filter: SliceFilter,
  boundToWorkflow: BoundToWorkflowFilter | null,
  hostId: string,
): Promise<SliceListResponse | SlicesUnavailable> {
  // 资源管理器自动展示需要后台服务侧的缓存绕过 + React Query 重新获取二者。
  // 否则在 slice 文件夹刚创建后，focus 重新获取仍可能立刻拿到索引器陈旧的内存列表。
  const params = new URLSearchParams({ filter, refresh: "1" });
  if (boundToWorkflow) {
    params.set("boundToWorkflow", `${boundToWorkflow.specName}:${boundToWorkflow.specVersion}`);
  }
  // OPR.0.4.6.MH2 FR-2 —— 所选主机信封；源结构逐字保留；
  // 本地路径不变（withHostParam 对本地为恒等）。
  const res = await fetch(withHostParam(`/api/slices?${params.toString()}`, hostId), { signal: AbortSignal.timeout(5_000) });
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as Partial<SlicesUnavailable> & { error?: string; hint?: string };
    return {
      unavailable: true,
      error: body.error ?? "slices_indexer_unavailable",
      hint: body.hint,
    };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SliceListResponse;
}

export function useSlices(filter: SliceFilter, boundToWorkflow: BoundToWorkflowFilter | null = null) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: [
      "slices",
      "list",
      filter,
      boundToWorkflow ? `${boundToWorkflow.specName}:${boundToWorkflow.specVersion}` : "all",
      hostId,
    ],
    queryFn: () => fetchSlicesList(filter, boundToWorkflow, hostId),
    staleTime: 30_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
    // V0.3.1 slice 17 walk-item 8（资源管理器自动展示）：窗口聚焦时重新获取，
    // 使操作者切到别处 `mkdir slices/...` 再回来时能看到新文件夹，无需手动点刷新。
    //
    // 前向修复 #2（2026-05-11 velocity-qa VM 复核，需关注）：
    // 值必须是 'always' 而非裸 `true`。本查询本地 staleTime 为 30_000（30 秒），
    // 裸 `true` 会让重新获取受陈旧性谓词门控——陈旧窗口内的短聚焦测试观察不到重新获取。
    // 'always' 变体忽略陈旧性、每次聚焦都重新获取，这才是真实意图：看到操作者刚创建的新文件夹。
    refetchOnWindowFocus: "always",
  });
}

// V0.3.1 slice 17 founder-walk-workspace-state-correctness —— walk item 8（资源管理器自动展示）。
// 资源管理器头部手动刷新按钮的变更 hook：POST 到 /api/slices/refresh 丢弃后台服务侧索引器缓存，
// 然后使 react-query slices + files 缓存失效，下次渲染即取新数据。
export function useRefreshSlices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/slices/refresh", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { ok: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["slices"] });
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });
}

// --- 单切片详情 ---

export interface StoryEvent {
  ts: string;
  /** 绑定到 workflow_instance 且事件 qitem 映射到步骤轨迹时的 spec 定义 step.id；
   *  未打标签时为 null（无绑定、无轨迹映射或非 qitem 事件）。v1 移除了 v0 硬编码的旧阶段枚举。 */
  phase: string | null;
  kind: string;
  actorSession: string | null;
  qitemId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface PhaseDefinition {
  id: string;
  label: string;
  role: string;
}

export interface CurrentStepPayload {
  stepId: string;
  role: string;
  objective: string | null;
  allowedExits: string[];
  allowedNextSteps: Array<{ stepId: string; role: string; reason: "next_hop" }>;
  hopCount: number;
  instanceStatus: string;
}

export interface SpecGraphNode {
  stepId: string;
  label: string;
  role: string;
  preferredTarget: string | null;
  isEntry: boolean;
  isCurrent: boolean;
  isTerminal: boolean;
}

export interface SpecGraphEdge {
  fromStepId: string;
  toStepId: string;
  routingType: "direct";
  isLoopBack: boolean;
}

export interface SpecGraphPayload {
  specName: string;
  specVersion: string;
  nodes: SpecGraphNode[];
  edges: SpecGraphEdge[];
}

export interface WorkflowBindingPayload {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  status: string;
  currentStepId: string | null;
  currentFrontier: string[];
  hopCount: number;
  createdAt: string;
  completedAt: string | null;
  additionalInstanceIds: string[];
}

export interface AcceptanceItem {
  text: string;
  done: boolean;
  source: { file: string; line: number };
}

export interface DecisionRow {
  actionId: string;
  ts: string;
  actor: string;
  verb: string;
  qitemId: string;
  reason: string | null;
  beforeState: string | null;
  afterState: string | null;
}

export interface DocsTreeEntry {
  name: string;
  type: "file" | "dir";
  size: number | null;
  mtime: string | null;
  relPath: string;
}

export interface ProofPacketRendered {
  dirName: string;
  primaryMarkdown: { relPath: string; content: string } | null;
  additionalMarkdown: Array<{ relPath: string; content: string }>;
  screenshots: string[];
  videos: string[];
  traces: string[];
  passFailBadge: "pass" | "fail" | "partial" | "unknown";
}

export interface TopologyRigEntry {
  rigId: string;
  rigName: string;
  sessionNames: string[];
}

export interface SliceDetail {
  readiness?: ProofReadiness;
  name: string;
  missionId: string | null;
  slicePath: string;
  displayName: string;
  railItem: string | null;
  status: string;
  rawStatus: string | null;
  qitemIds: string[];
  commitRefs: string[];
  lastActivityAt: string | null;
  /** v1：绑定的 workflow_instance 元数据；当无实例触及本切片任何 qitem 时为 null
   *  （UI 退化为 v0 行为）。 */
  workflowBinding: WorkflowBindingPayload | null;
  story: {
    events: StoryEvent[];
    /** v1：spec 声明的阶段定义；无绑定实例时为 null。 */
    phaseDefinitions: PhaseDefinition[] | null;
  };
  acceptance: {
    totalItems: number;
    doneItems: number;
    percentage: number;
    items: AcceptanceItem[];
    closureCallout: string | null;
    /** v1：绑定实例的当前步骤 + 允许的下一步；无绑定实例时为 null。 */
    currentStep: CurrentStepPayload | null;
  };
  decisions: { rows: DecisionRow[] };
  docs: { tree: DocsTreeEntry[] };
  tests: { proofPackets: ProofPacketRendered[]; aggregate: { passCount: number; failCount: number } };
  topology: {
    affectedRigs: TopologyRigEntry[];
    totalSeats: number;
    /** v1：从绑定实例的 workflow_spec 派生的 spec 图（节点 + 边）；
     *  未绑定时为 null（UI 退化为按工作组的会话列表）。 */
    specGraph: SpecGraphPayload | null;
  };
}

async function fetchSliceDetail(name: string, hostId: string): Promise<SliceDetail> {
  // OPR.0.4.6.MH2 FR-2 —— 所选主机信封；源结构逐字保留。
  const res = await fetch(withHostParam(`/api/slices/${encodeURIComponent(name)}`, hostId), { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SliceDetail;
}

export function useSliceDetail(name: string | null) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["slices", "detail", name, hostId],
    queryFn: () => fetchSliceDetail(name!, hostId),
    enabled: !!name,
    staleTime: 30_000,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export interface SliceDetailsMapResult {
  itemsByName: Map<string, SliceDetail>;
  isFetching: boolean;
  missingNames: string[];
}

export function useSliceDetails(names: string[]): SliceDetailsMapResult {
  const hostId = useSelectedHostId();
  const uniqueNames = useMemo(
    () => Array.from(new Set(names.filter((name) => name.length > 0))).sort(),
    [names],
  );
  const queries = useQueries({
    queries: uniqueNames.map((name) => ({
      queryKey: ["slices", "detail", name, hostId],
      queryFn: () => fetchSliceDetail(name, hostId),
      staleTime: 30_000,
      refetchInterval: 30_000,
    })),
  });

  return useMemo(() => {
    const itemsByName = new Map<string, SliceDetail>();
    const missingNames: string[] = [];
    uniqueNames.forEach((name, idx) => {
      const item = queries[idx]?.data;
      if (item) {
        itemsByName.set(name, item);
      } else if (queries[idx]?.isError) {
        missingNames.push(name);
      }
    });
    return {
      itemsByName,
      isFetching: queries.some((query) => query.isFetching),
      missingNames,
    };
  }, [queries, uniqueNames]);
}

// --- 文档正文获取（Docs 标签页；点击时懒加载） ---

export interface SliceDocResponse {
  relPath: string;
  content: string;
}

async function fetchSliceDoc(name: string, relPath: string, hostId: string): Promise<SliceDocResponse> {
  // OPR.0.4.6.MH2 FR-2 —— 所选主机信封；源结构逐字保留。
  const res = await fetch(withHostParam(`/api/slices/${encodeURIComponent(name)}/doc/${encodeURI(relPath)}`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SliceDocResponse;
}

export function useSliceDoc(name: string | null, relPath: string | null) {
  const hostId = useSelectedHostId();
  return useQuery({
    queryKey: ["slices", "doc", name, relPath, hostId],
    queryFn: () => fetchSliceDoc(name!, relPath!, hostId),
    enabled: !!name && !!relPath,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function proofAssetUrl(sliceName: string, relPath: string): string {
  return `/api/slices/${encodeURIComponent(sliceName)}/proof-asset/${encodeURI(relPath)}`;
}

export interface QueueItemDetail {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  priority: string;
  tier: string | null;
  tags: string[] | null;
  body: string;
  // OPR.0.4.1.18 —— /api/queue/:id 提供的可选人类可读摘要
  // （后台服务 QueueItem.summary）；pre-18 的 qitem 为 null。Story 消费者
  // 在 null 时退化；body 仍是事实来源。
  summary: string | null;
  closureReason?: string | null;
  closureTarget?: string | null;
  handedOffTo?: string | null;
  handedOffFrom?: string | null;
  // OPR.0.4.1.19 —— 谱系已由 /api/queue/:id（queue-repository
  // row->QueueItem）序列化；在此暴露给 Story 标签页 DAG 重建。chainOfRecord 尾是直接父 qitem-id；
  // 交接创建的项上 handedOffFrom == 该尾。
  chainOfRecord?: string[] | null;
  blockedOn?: string | null;
  // OPR.0.4.1.19 —— 其余 /api/queue/:id QueueItem 字段，暴露给
  // Tier-3 抽屉事实来源视图（都已在负载中；仅类型）。
  claimedAt?: string | null;
  expiresAt?: string | null;
  closureRequiredAt?: string | null;
  lastNudgeAttempt?: string | null;
  lastNudgeResult?: string | null;
  lastHeartbeat?: string | null;
  resolution?: string | null;
  targetRepo?: string | null;
}

export interface QueueItemMapResult {
  itemsById: Map<string, QueueItemDetail>;
  isFetching: boolean;
  missingIds: string[];
}

async function fetchQueueItem(qitemId: string): Promise<QueueItemDetail | null> {
  const res = await fetch(`/api/queue/${encodeURIComponent(qitemId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as QueueItemDetail;
}

export function useQueueItemMap(qitemIds: string[]): QueueItemMapResult {
  const uniqueIds = useMemo(
    () => Array.from(new Set(qitemIds.filter((id) => id.length > 0))).sort(),
    [qitemIds],
  );
  const queries = useQueries({
    queries: uniqueIds.map((qitemId) => ({
      queryKey: ["queue", "item", qitemId],
      queryFn: () => fetchQueueItem(qitemId),
      staleTime: 30_000,
    })),
  });

  return useMemo(() => {
    const itemsById = new Map<string, QueueItemDetail>();
    const missingIds: string[] = [];
    uniqueIds.forEach((qitemId, idx) => {
      const item = queries[idx]?.data;
      if (item) {
        itemsById.set(qitemId, item);
      } else if (queries[idx]?.status === "success") {
        missingIds.push(qitemId);
      }
    });
    return {
      itemsById,
      isFetching: queries.some((query) => query.isFetching),
      missingIds,
    };
  }, [queries, uniqueIds]);
}
