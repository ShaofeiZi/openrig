// Living Notes Packet 2 —— 组合评审读取契约的 UI 镜像（OPR.0.4.4.20）。
// 一个契约，所有消费者共用：slice 评审标签页、任务看板的 U5 行展开、
// For-You 展开都读这些相同的 hook；agents 投影在单一端点上按 scope 参数化
// （slice:<id> | mission:<id> | rig）。

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

// --- 契约镜像（packages/daemon/src/domain/review/types.ts 的子集）---

export type ReviewPhase = "intent" | "spec" | "building" | "review" | "locked";
export type C1Verdict = "CLEAR" | "BLOCKING" | "CONCERNING" | "PASS" | "NOT-CLEAR";

export interface VerdictCell {
  role: "guard" | "qa" | "rev1-r1" | "rev1-r2";
  recordedToken: C1Verdict | null;
  tone: "pass" | "fail" | "unknown";
  state: "passing" | "non-passing" | "missing";
  source: string | null;
}

export interface VerifyLineage {
  candidateSha: string | null;
  mergeSha: string | null;
  mainTip: string;
  freshness: "fresh" | "stale" | "unknown";
  staleBehind: number | null;
  gateCells: VerdictCell[];
}

// 2026-07-05 §3.1 纠偏式重新设计：四套并行结构（章节/验收/联结/比较）合并为唯一结构，
// 即纵向的意图 → 计划 → 已交付堆栈。GreenState 已移除（§11：其记录判定的严谨性转化为
// 每个交付物 `verified` 的来源）。

/** 行内媒体（精选证明、计划模型图）。 */
export interface ReviewMedia {
  kind: "image" | "video";
  src: string;
  poster?: string;
  caption: string;
}

/** 两个明确印章之一（§4）：计划锁 / 证明锁。 */
export interface LockState {
  by: string;
  at: string;
  auditVerified: boolean;
}

/** §3.1 delivered.items[]——重新设计的联结：一个计划交付物与其精选证明和 QA 记录的
 * 比较信号配对。`verified` 要求已有记录的 QA 比较判定，仅有产物绝不够；这是逐项应用的
 * 双制度严谨性。失败开放：unverified/missing 会明确显示为不完整，但绝不阻塞。 */
export interface DeliveredItem {
  promised: { text: string; plannedRef?: ReviewMedia };
  proof: ReviewMedia[];
  verified: "verified" | "unverified" | "missing";
  note?: string;
}

export interface DerivedException {
  // OPR.0.4.6.WF4 Q6——与后台服务 review/types.ts 重新同步：此镜像此前缺少 WF-5 类型
  // workflow-failed | awareness | anomaly。
  kind: "stuck" | "overdue" | "insufficient-proof" | "stale-after-change" | "workflow-failed" | "awareness" | "anomaly";
  evidence: string;
  threshold: string;
}

/** OPR.0.4.6.WF4 Q6——后台服务 WorkflowRowRef（review/types.ts）的 UI 镜像，是唯一的
 * 结构化工作流身份联结。UI 只使用此指针完成工作流路由和深链接，绝不使用
 * identity/evidenceRef/summary 中的自然语言。仅在工作流来源行上存在，缺省时省略。 */
export interface WorkflowRowRef {
  instanceId: string;
  workflowName: string;
  stepId?: string;
}

export interface NeedsYouItem {
  source: "agent" | "derived";
  /** OPR.0.4.6.WF4 Q6——仅在工作流来源行上存在，缺省时省略。 */
  workflow?: WorkflowRowRef;
  identity: string;
  summary: string;
  leg: string;
  where: string;
  ageIso: string | null;
  priority: string | null;
  tier: string | null;
  evidenceRef: string | null;
  unblocks: string | null;
  qitemId: string | null;
  destinationSession: string | null;
  derived: DerivedException | null;
}

export interface NeedsYouBand {
  items: NeedsYouItem[];
  provenance: string;
}

export type AgentsScope = `slice:${string}` | `mission:${string}` | "rig";

export interface AgentRow {
  agentName: string;
  runtime: string;
  stateGlyph: "active" | "parked" | "idle" | "unknown";
  doing: string | null;
  holdsCount: number;
  lastTransitionIso: string | null;
  exception: DerivedException | null;
  sessionName: string;
  slices: string[];
}

export interface AgentsBand {
  scope: AgentsScope;
  rows: AgentRow[];
  provenance: string;
  coordinationHealth: string | null;
}

/** §3.1——唯一结构。它是磁盘产物的投影：每个章节始终参与组合，来源缺失时降级为低调的
 *“—”行；绝不虚构，也绝不阻塞。 */
export interface ComposedSliceReview {
  sourceObservation?: { state: string };
  readiness?: { configured: boolean; state: string; revision: string };
  slice: string;
  sliceId: string | null;
  title: string;
  missionId: string | null;
  phase: ReviewPhase;
  laneLabel: string;
  /** §1——逐字记录的意图，通常为文本。 */
  intent: {
    text: string | null;
    media: ReviewMedia[];
    ssotPath: string | null;
    degrade: string | null;
  };
  /** §2——微型需求和计划模型图；固定锁定集合；计划锁。 */
  plan: {
    concise: { text: string | null; media: ReviewMedia[] };
    lockedArtifacts: { name: string; path: string; kind: string }[];
    lock: LockState | null;
    ssotPath: string | null;
  };
  /** §3——重新设计的联结：计划项 ↔ 精选证明 ↔ QA 已验证。 */
  delivered: {
    items: DeliveredItem[];
    /** 未与单一交付物关联的辅助产物，数量有界（§6）。 */
    extraProof: ReviewMedia[];
    lock: LockState | null;
    /** “查看全部证明”的详情目标，包含完整修复循环历史。 */
    proofDirPath: string | null;
  };
  // 保留正交且已可靠的部分：注意项、协调和新鲜度。
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  lineage: VerifyLineage;
  defects: string[];
  composedAt: string;
}

export interface BoardSlot {
  slice: string;
  title: string;
  phase: ReviewPhase;
  laneLabel: string;
  agentsCount: number;
  stageCell: string;
  changedSinceStamp: boolean;
  attentionWorthy: boolean;
}

export interface LedgerRow {
  slice: string;
  candidateSha: string | null;
  gateCells: VerdictCell[];
  mergeSha: string | null;
  needsHumanCount: number;
  green: boolean;
}

export interface ComposedMissionReview {
  sourceObservation?: { state: string };
  readiness?: { state: string; revision: string };
  mission: string;
  missionId: string | null;
  title: string;
  /** 简报中的“做什么与为什么”，逐字投影（FR-8）。 */
  intent: string | null;
  /** 生成的状态主干正文，在页签内始终以最新内容渲染（FR-8）。 */
  briefSpine: { building: string; progress: string; proven: string; needsYou: string };
  board: BoardSlot[];
  ledger: LedgerRow[];
  cutComplete: boolean;
  cutCompleteBasis: string;
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  composedAt: string;
}

// --- OPR.0.4.4.22：工作组范围的独立层级根（同一组件族）---

export interface SettledRow {
  fromSession: string;
  toSession: string;
  summary: string | null;
  closedAtIso: string;
  qitemId: string;
}

export interface ComposedRigAgents {
  scope: "rig";
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  settled: SettledRow[];
  settledProvenance: string;
  composedAt: string;
}

// --- Hooks ---

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function useSliceReview(name: string | null) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["review", "slice", name],
    queryFn: () => fetchJson<ComposedSliceReview>(`/api/review/slice/${encodeURIComponent(name!)}`),
    enabled: !!name,
    // 操作后刷新依靠失效处理 useInvalidateReview，而不是窗口聚焦；保持较短 staleTime，
    // 使重新组合能及时呈现。
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  return { ...query, updatesUnavailable: query.data?.sourceObservation?.state === "unavailable", basisInvalidated: client.getQueryState(["review", "slice", name])?.isInvalidated === true };
}

export function useMissionReview(name: string | null) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["review", "mission", name],
    queryFn: () => fetchJson<ComposedMissionReview>(`/api/review/mission/${encodeURIComponent(name!)}`),
    enabled: !!name,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  return { ...query, updatesUnavailable: query.data?.sourceObservation?.state === "unavailable", basisInvalidated: client.getQueryState(["review", "mission", name])?.isInvalidated === true };
}

export function useReviewAgents(scope: AgentsScope | null) {
  return useQuery({
    queryKey: ["review", "agents", scope],
    queryFn: () => fetchJson<AgentsBand>(`/api/review/agents?scope=${encodeURIComponent(scope!)}`),
    enabled: !!scope,
    staleTime: 15_000,
  });
}

/** OPR.0.4.4.22——组合后的工作组智能体根（FR-1..FR-4）。常驻成本只有 queue+ps；
 * 会话记录详情通过单独的按需请求获取，绝不走此查询。 */
export function useRigAgents() {
  return useQuery({
    queryKey: ["review", "rig-agents"],
    queryFn: () => fetchJson<ComposedRigAgents>("/api/review/rig"),
    staleTime: 15_000,
  });
}

/** 操作后刷新：每个界面操作都会使评审查询失效，让行在持久写入后真正离开“需要你处理”
 *（FR-4）。 */
export function useInvalidateReview() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["review"] });
  }, [qc]);
}
