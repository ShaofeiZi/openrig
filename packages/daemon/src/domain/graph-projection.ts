import type { RigWithRelations, Session, Binding, Pod, AgentActivity, SeatIdentityVerdict } from "./types.js";
import { identityVerdictDownranksRunning } from "./types.js";

export interface RigGraphInput extends RigWithRelations {
  sessions: Session[];
  pods?: Pod[];
}

export interface CurrentQitemSummary {
  qitemId: string;
  bodyExcerpt: string;
  tier: string | null;
}

interface RFNodeData {
  logicalId: string;
  podLabel?: string | null;
  podNamespace?: string | null;
  rigId: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  status: string | null;
  binding: Binding | null;
  nodeKind: "agent" | "infrastructure";
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  canonicalSessionName: string | null;
  podId: string | null;
  restoreOutcome: string;
  // OPR.0.4.3.06——经 challenge 验证的 orientation，与 startupStatus 不同。
  oriented: string;
  resumeToken?: string | null;
  resolvedSpecName: string | null;
  profile: string | null;
  edgeCount: number;
  contextUsedPercentage: number | null;
  contextFresh: boolean;
  contextAvailability: string;
  contextTotalInputTokens: number | null;
  contextTotalOutputTokens: number | null;
  agentActivity?: AgentActivity | null;
  currentQitems?: CurrentQitemSummary[];
  terminalActive?: boolean | null;
  hasAssignedWork?: boolean;
  assignedWorkCount?: number;
  pendingWorkCount?: number;
  inProgressWorkCount?: number;
  blockedWorkCount?: number;
  /** OPR.0.4.3.19——透传 liveness identity verdict，使 graph 呈现与 node inventory 相同的
   *  非绿色 mismatch/missing evidence。 */
  identityVerdict?: SeatIdentityVerdict | null;
  heldReason?: string | null;
}

interface RFNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: RFNodeData;
  parentId?: string;
}

interface RFEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface ReactFlowGraph {
  nodes: RFNode[];
  edges: RFEdge[];
}

const VERTICAL_SPACING = 200;

export interface InventoryOverlay {
  logicalId: string;
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  canonicalSessionName: string | null;
  restoreOutcome: string;
  oriented?: string;
  contextUsedPercentage?: number | null;
  contextFresh?: boolean;
  contextAvailability?: string;
  contextTotalInputTokens?: number | null;
  contextTotalOutputTokens?: number | null;
  agentActivity?: AgentActivity | null;
  currentQitems?: CurrentQitemSummary[];
  terminalActive?: boolean | null;
  hasAssignedWork?: boolean;
  assignedWorkCount?: number;
  pendingWorkCount?: number;
  inProgressWorkCount?: number;
  blockedWorkCount?: number;
  identityVerdict?: SeatIdentityVerdict | null;
  heldReason?: string | null;
}

export function projectRigToGraph(input: RigGraphInput, inventoryOverlay?: InventoryOverlay[]): ReactFlowGraph {
  const { nodes: rigNodes, edges: rigEdges, sessions, pods = [] } = input;
  const overlayMap = new Map((inventoryOverlay ?? []).map((o) => [o.logicalId, o]));
  const podLabelById = new Map(pods.map((pod) => [pod.id, pod.label]));
  const podNamespaceById = new Map(pods.map((pod) => [pod.id, pod.namespace]));

  // 收集唯一 pod，用于 group node
  const podNodes = new Map<string, string[]>(); // podId → node IDs

  const nodes: RFNode[] = rigNodes.map((node, index) => {
    // 按 ULID 顺序为此 node 查找最新 session（最大 session.id）
    const nodeSessions = sessions.filter((s) => s.nodeId === node.id);
    const latestSession = nodeSessions.length > 0
      ? nodeSessions.reduce((latest, s) => s.id > latest.id ? s : latest)
      : null;

    const overlay = overlayMap.get(node.logicalId);
    // OPR.0.4.3.19 forward-fix——降级 identity verdict（mismatch/pane_missing）会使 graph node
    // 的 effective startup status 变为 `attention_required`，于是所有已将
    // startupStatus==="attention_required" 视为非绿色的 UI surface（通过
    // getBaselineActivityState 的 activity ring、ATTN badge）无需新 vocabulary 即可显示非绿色。
    // `getBaselineActivityState` 在 terminalActive 前检查 attention_required，因此 orphan 的 tmux
    // output 不再能把 ring 标为 active。raw `status` 保持真实 session-row value；dot
    //（忽略 startupStatus 的 getActivityStateWithSource）在 UI 中通过 `identityVerdict` 独立控制。
    const identityDownranked = identityVerdictDownranksRunning(overlay?.identityVerdict?.verdict);
    const effectiveStartupStatus: RFNodeData["startupStatus"] = latestSession?.status === "running"
      ? (identityDownranked
        ? "attention_required"
        : (overlay?.startupStatus ?? (latestSession.startupStatus as RFNodeData["startupStatus"]) ?? null))
      : null;

    // 跟踪 pod
    if (node.podId) {
      if (!podNodes.has(node.podId)) podNodes.set(node.podId, []);
      podNodes.get(node.podId)!.push(node.id);
    }

    return {
      id: node.id,
      type: "rigNode",
      position: { x: 0, y: index * VERTICAL_SPACING },
      parentId: node.podId ? `pod-${node.podId}` : undefined,
      data: {
        logicalId: node.logicalId,
        podLabel: node.podId ? (podLabelById.get(node.podId) ?? null) : null,
        podNamespace: node.podId ? (podNamespaceById.get(node.podId) ?? null) : null,
        rigId: node.rigId,
        role: node.role,
        runtime: node.runtime,
        model: node.model,
        status: latestSession ? latestSession.status : null,
        binding: node.binding,
        nodeKind: node.runtime === "terminal" ? "infrastructure" : "agent",
        startupStatus: effectiveStartupStatus,
        canonicalSessionName: overlay?.canonicalSessionName ?? latestSession?.sessionName ?? null,
        podId: node.podId ?? null,
        restoreOutcome: overlay?.restoreOutcome ?? "n-a",
        oriented: overlay?.oriented ?? "n-a",
        resumeToken: latestSession?.resumeToken ?? null,
        resolvedSpecName: node.resolvedSpecName ?? null,
        profile: node.profile ?? null,
        edgeCount: rigEdges.filter((e) => e.sourceId === node.id || e.targetId === node.id).length,
        contextUsedPercentage: overlay?.contextUsedPercentage ?? null,
        contextFresh: overlay?.contextFresh ?? false,
        contextAvailability: overlay?.contextAvailability ?? "unknown",
        contextTotalInputTokens: overlay?.contextTotalInputTokens ?? null,
        contextTotalOutputTokens: overlay?.contextTotalOutputTokens ?? null,
        agentActivity: overlay?.agentActivity ?? null,
        currentQitems: overlay?.currentQitems ?? [],
        terminalActive: overlay?.terminalActive,
        hasAssignedWork: overlay?.hasAssignedWork ?? false,
        assignedWorkCount: overlay?.assignedWorkCount ?? 0,
        pendingWorkCount: overlay?.pendingWorkCount ?? 0,
        inProgressWorkCount: overlay?.inProgressWorkCount ?? 0,
        blockedWorkCount: overlay?.blockedWorkCount ?? 0,
        identityVerdict: overlay?.identityVerdict ?? null,
        heldReason: overlay?.heldReason ?? null,
      },
    };
  });

  // 创建 pod group node
  const groupNodes: RFNode[] = [];
  for (const [podId] of podNodes) {
    groupNodes.push({
      id: `pod-${podId}`,
      type: "podGroup",
      position: { x: 0, y: 0 },
      data: {
        logicalId: podNamespaceById.get(podId) ?? podId,
        podLabel: podLabelById.get(podId) ?? podId,
        podNamespace: podNamespaceById.get(podId) ?? podId,
        rigId: input.rig.id,
        role: null,
        runtime: null,
        model: null,
        status: null,
        binding: null,
        nodeKind: "agent",
        startupStatus: null,
        canonicalSessionName: null,
        podId,
        restoreOutcome: "n-a",
        oriented: "n-a",
        resumeToken: null,
        resolvedSpecName: null,
        profile: null,
        edgeCount: 0,
        contextUsedPercentage: null,
        contextFresh: false,
        contextAvailability: "unknown",
        contextTotalInputTokens: null,
        contextTotalOutputTokens: null,
        agentActivity: null,
        currentQitems: [],
        terminalActive: null,
        hasAssignedWork: false,
        assignedWorkCount: 0,
        pendingWorkCount: 0,
        inProgressWorkCount: 0,
        blockedWorkCount: 0,
        identityVerdict: null,
        heldReason: null,
      },
    });
  }

  const edges: RFEdge[] = rigEdges.map((edge) => ({
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    label: edge.kind,
  }));

  return { nodes: [...groupNodes, ...nodes], edges };
}
