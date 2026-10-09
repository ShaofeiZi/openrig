// V1 润色切片：多工作组混合 /topology 图。
//
// 使用共享 dagre 辅助函数将每个展开的工作组布局为软框，
// 包含 Pod 子框和紧凑智能体叶节点，然后在主机画布上布局工作组框。
// V1 契约保持承重：惰性按工作组图抓取、跨工作组节点 ID 前缀、折叠持久化、
// URL 自动展开、图/树/表导航对等。
//
// 默认状态：工作组展开，使拓扑打开为完整舰队画布。显式折叠状态仍持久化在
// TopologyOverlayProvider，操作者可从画布控件折叠/展开每个工作组。
// 自动展开规则（与第 5.1 阶段 TopologyTreeView 对等）：
// 当路由为 /topology/rig/$rigId 或 /topology/seat/$rigId/* 或
// /topology/pod/$rigId/* 时，匹配工作组在挂载/路由变更时自动展开。
// 点击工作组卡片主体 → 切换折叠。点击工作组卡片名称上的箭头链接 →
// 导航到 /topology/rig/$rigId（下钻）。
//
// 性能：按工作组图数据惰性抓取（useQueries 仅在工作组展开时启用）。
// V1 操作者默认现在有意前置抓取展开的工作组；显式"全部折叠"恢复先前的
// 低扇出行为。

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ReactFlow,
  Controls,
  Panel,
  useReactFlow,
  useNodesInitialized,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQueries } from "@tanstack/react-query";
import { Maximize2, Minimize2 } from "lucide-react";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { RigGroupNode, type RigGroupNodeData } from "./RigGroupNode.js";
import { HybridAgentNode, HybridPodGroupNode } from "./HybridTopologyNodes.js";
import { HotPotatoEdge } from "./HotPotatoEdge.js";
import { useTopologyOverlay } from "./topology-overlay-context.js";
import { useTopologyActivity } from "../../hooks/useTopologyActivity.js";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { withHostParam } from "../../lib/host-param.js";
import {
  HYBRID_COLLAPSED_RIG_HEIGHT,
  HYBRID_COLLAPSED_RIG_WIDTH,
  layoutHybridOuterRigs,
  layoutHybridRig,
} from "../../lib/hybrid-layout.js";
import {
  applyHotPotatoEdges,
  buildTopologySessionIndex,
  type TopologyActivityBaseline,
} from "../../lib/topology-activity.js";

interface GraphData {
  nodes: unknown[];
  edges: unknown[];
}

async function fetchGraph(rigId: string, hostId: string): Promise<GraphData> {
  const res = await fetch(withHostParam(`/api/rigs/${encodeURIComponent(rigId)}/graph`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const nodeTypes: NodeTypes = {
  rigGroup: RigGroupNode as unknown as NodeTypes[string],
  podGroup: HybridPodGroupNode as unknown as NodeTypes[string],
  rigNode: HybridAgentNode as unknown as NodeTypes[string],
};

const edgeTypes: EdgeTypes = {
  hotPotato: HotPotatoEdge,
};

const DEFAULT_RIG_EXPANDED = true;
const HOST_GRAPH_MIN_ZOOM = 0.03;
const HOST_GRAPH_MAX_ZOOM = 2;
const HOST_GRAPH_FIT_PADDING = 0.08;

export function HostMultiRigGraph() {
  const navigate = useNavigate();
  const { data: psEntries } = usePsEntries();
  const hostId = useSelectedHostId();
  const reducedMotion = usePrefersReducedMotion();

  // V1 润色切片第 5.2 阶段反弹修复：工作组展开状态提升到
  // TopologyOverlayProvider 范围。直接 URL 进入 /topology/rig/$id
  //（挂载 RigScopePage，不是 HostMultiRigGraph，因为拓扑路由是兄弟节点）
  // 仍通过 provider 的自动展开 useEffect 更新 context 的 expandedRigs 映射；
  // 当操作者返回 /topology 时，此组件通过 useTopologyOverlay() 读取持久化状态
  // 并渲染匹配工作组为展开。
  const { expandedRigs: expanded, setRigExpanded } = useTopologyOverlay();
  const isRigExpanded = useCallback(
    (rigId: string) => expanded.get(rigId) ?? DEFAULT_RIG_EXPANDED,
    [expanded],
  );
  const toggleRig = useCallback((rigId: string) => {
    setRigExpanded(rigId, !isRigExpanded(rigId));
  }, [isRigExpanded, setRigExpanded]);

  // P5.2-2 + P5.2-3：useQueries 用于按工作组图数据；仅在工作组展开时启用。
  // 稳定 hook 调用数（单个 useQueries 调用），无论 psEntries 从 undefined 增长到 [N]，
  // 因此无 rules-of-hooks 回归（P0-1 模式保留）。
  const rigList = psEntries ?? [];
  const graphQueries = useQueries({
    queries: rigList.map((rig) => ({
      queryKey: ["rig", rig.rigId, "graph", hostId] as const,
      queryFn: () => fetchGraph(rig.rigId, hostId),
      enabled: isRigExpanded(rig.rigId),
      refetchInterval: 30_000,
    })),
  });
  const expandedCount = useMemo(
    () => rigList.filter((rig) => isRigExpanded(rig.rigId)).length,
    [rigList, isRigExpanded],
  );
  const expandAllRigs = useCallback(() => {
    for (const rig of rigList) setRigExpanded(rig.rigId, true);
  }, [rigList, setRigExpanded]);
  const collapseAllRigs = useCallback(() => {
    for (const rig of rigList) setRigExpanded(rig.rigId, false);
  }, [rigList, setRigExpanded]);

  // 构建逐工作组嵌套子图，并在主机画布上布局工作组边框。
  const { mergedNodes, mergedEdges } = useMemo(() => {
    type RawN = Node & { data?: Record<string, unknown>; initialWidth?: number; initialHeight?: number };
    type RawE = Edge & { source: string; target: string; data?: Record<string, unknown>; label?: unknown };

    const perRig: Array<{
      rigId: string;
      rigName: string;
      status: "running" | "partial" | "stopped";
      nodeCount: number;
      runningCount: number;
      /** 切片 15 —— 从 PsEntry 传入的终端活跃计数。 */
      activeCount?: number;
      podCount?: number;
      isExpanded: boolean;
      childNodes: Node[];
      childEdges: Edge[];
      width: number;
      height: number;
    }> = [];

    for (let i = 0; i < rigList.length; i++) {
      const rig = rigList[i]!;
      const isExpanded = isRigExpanded(rig.rigId);
      const queryResult = graphQueries[i];

      let childNodes: Node[] = [];
      let childEdges: Edge[] = [];
      let width = HYBRID_COLLAPSED_RIG_WIDTH;
      let height = HYBRID_COLLAPSED_RIG_HEIGHT;
      let podCount: number | undefined;

      const rawNodes = (queryResult?.data?.nodes ?? []) as RawN[];
      const rawEdges = (queryResult?.data?.edges ?? []) as RawE[];
      const layout = layoutHybridRig({
        rigId: rig.rigId,
        rigName: rig.name,
        nodes: rawNodes,
        edges: rawEdges,
        collapsed: !isExpanded,
      });
      width = layout.width;
      height = layout.height;
      if (isExpanded) {
        childNodes = layout.nodes;
        childEdges = layout.edges;
        podCount = layout.podCount;
      }

      perRig.push({
        rigId: rig.rigId,
        rigName: rig.name,
        status: rig.status,
        nodeCount: rig.nodeCount,
        runningCount: rig.runningCount,
        activeCount: (rig as { activeCount?: number }).activeCount,
        podCount,
        isExpanded,
        childNodes,
        childEdges,
        width,
        height,
      });
    }

    const packed = layoutHybridOuterRigs(
      perRig.map((p) => ({ rigId: p.rigId, width: p.width, height: p.height })),
    );

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < perRig.length; i++) {
      const p = perRig[i]!;
      const pack = packed[i]!;
      const data: RigGroupNodeData = {
        rigId: p.rigId,
        rigName: p.rigName,
        collapsed: !p.isExpanded,
        status: p.status,
        nodeCount: p.nodeCount,
        runningCount: p.runningCount,
        activeCount: p.activeCount,
        podCount: p.podCount,
        onToggle: toggleRig,
      };
      nodes.push({
        id: `rig-${p.rigId}`,
        type: "rigGroup",
        position: pack.position,
        data: data as unknown as Record<string, unknown>,
        style: { width: pack.width, height: pack.height },
        draggable: false,
        zIndex: 0,
      });
      if (p.isExpanded) {
        nodes.push(...p.childNodes);
        edges.push(...p.childEdges);
      }
    }

    return { mergedNodes: nodes, mergedEdges: edges };
    // toggleRig 每次渲染稳定，但 useMemo 不知道；安全地
    // 包含 rigList + expanded + graphQueries 作为依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigList, isRigExpanded, graphQueries]);

  const sessionIndex = useMemo(() => buildTopologySessionIndex(
    mergedNodes
      .filter((node) => node.type === "rigNode")
      .map((node) => {
        const data = node.data as {
          rigId?: string | null;
          rigName?: string | null;
          logicalId?: string | null;
          canonicalSessionName?: string | null;
          agentActivity?: TopologyActivityBaseline["agentActivity"];
          currentQitems?: TopologyActivityBaseline["currentQitems"];
          startupStatus?: string | null;
          terminalActive?: boolean | null;
          hasAssignedWork?: boolean;
          pendingWorkCount?: number;
        } | undefined;
        return {
          nodeId: node.id,
          rigId: data?.rigId ?? null,
          rigName: data?.rigName ?? null,
          logicalId: data?.logicalId ?? null,
          canonicalSessionName: data?.canonicalSessionName ?? null,
          agentActivity: data?.agentActivity ?? null,
          currentQitems: data?.currentQitems ?? null,
          startupStatus: data?.startupStatus ?? null,
          terminalActive: data?.terminalActive,
          hasAssignedWork: data?.hasAssignedWork ?? false,
          pendingWorkCount: data?.pendingWorkCount ?? 0,
        };
      }),
  ), [mergedNodes]);
  const topologyActivity = useTopologyActivity(sessionIndex);

  const activeNodes = useMemo(() => mergedNodes.map((node) => {
    if (node.type === "rigGroup") {
      const data = node.data as unknown as RigGroupNodeData;
      return {
        ...node,
        data: {
          ...data,
          recentActivity: topologyActivity.isRigRecentlyActive(data.rigId),
        } as unknown as Record<string, unknown>,
      };
    }
    if (node.type !== "rigNode") return node;
    const data = node.data as TopologyActivityBaseline & {
      logicalId?: string | null;
    };
    return {
      ...node,
      data: {
        ...(node.data ?? {}),
        activityRing: topologyActivity.getNodeActivity(node.id, data),
        reducedMotion,
      },
    };
  }), [mergedNodes, topologyActivity, reducedMotion]);

  const activeEdges = useMemo(
    () => applyHotPotatoEdges(mergedEdges, topologyActivity.packets, { reducedMotion }),
    [mergedEdges, topologyActivity.packets, reducedMotion],
  );
  const layoutSignature = useMemo(() => mergedNodes.map((node) => {
    const style = node.style as { width?: string | number; height?: string | number } | undefined;
    return [
      node.id,
      Math.round(node.position.x),
      Math.round(node.position.y),
      style?.width ?? "",
      style?.height ?? "",
      node.parentId ?? "",
    ].join(":");
  }).join("|"), [mergedNodes]);

  // P5.2-7 点击处理器：智能体 → 席位 URL；Pod 组 → Pod URL；
  // 工作组组 → 切换（在 RigGroupNode onClick 内处理；此
  // 处理器对 rigGroup 类型是空操作以避免双击触发）。
  const onNodeClick: NodeMouseHandler = (_evt, node) => {
    const data = node.data as { rigId?: string; logicalId?: string; podId?: string | null; podNamespace?: string | null } | undefined;
    const rigId = data?.rigId;
    if (!rigId) return;
    if (node.type === "rigGroup") return; // 主体点击由 RigGroupNode 处理
    if (node.type === "podGroup" || node.type === "group") {
      const podName = data?.podNamespace ?? data?.podId;
      if (!podName) return;
      navigate({
        to: "/topology/pod/$rigId/$podName",
        params: { rigId, podName },
      });
      return;
    }
    if (data?.logicalId) {
      navigate({
        to: "/topology/seat/$rigId/$logicalId",
        params: { rigId, logicalId: encodeURIComponent(data.logicalId) },
      });
    }
  };

  if (rigList.length === 0) {
    return (
      <div
        data-testid="host-multi-rig-graph-empty"
        className="flex flex-col items-center justify-center h-full font-mono text-[10px] text-on-surface-variant"
      >
        无已注册工作组。运行 <code className="ml-1 text-on-surface">zrig up</code> 启动一个。
      </div>
    );
  }

  return (
    <div
      data-testid="host-multi-rig-graph"
      className="w-full h-full relative"
    >
      <ReactFlow
        nodes={activeNodes}
        edges={activeEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        fitView
        fitViewOptions={{ padding: HOST_GRAPH_FIT_PADDING, includeHiddenNodes: false }}
        minZoom={HOST_GRAPH_MIN_ZOOM}
        maxZoom={HOST_GRAPH_MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        <HostGraphAutoFit layoutSignature={layoutSignature} />
        <Panel position="top-right" className="!m-3">
          <div className="flex items-center gap-1 border border-outline-variant bg-background/80 px-1.5 py-1 shadow-[2px_2px_0_rgba(46,52,46,0.10)] backdrop-blur-sm">
            <button
              type="button"
              data-testid="topology-expand-all-rigs"
              onClick={expandAllRigs}
              disabled={expandedCount === rigList.length}
              title="展开全部工作组"
              className="inline-flex h-7 items-center gap-1 border border-transparent px-2 font-mono text-[9px] uppercase tracking-[0.08em] text-on-surface hover:border-outline-variant hover:bg-surface-lowest/70 hover:text-on-surface disabled:pointer-events-none disabled:opacity-35"
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
              全部展开
            </button>
            <button
              type="button"
              data-testid="topology-collapse-all-rigs"
              onClick={collapseAllRigs}
              disabled={expandedCount === 0}
              title="折叠全部工作组"
              className="inline-flex h-7 items-center gap-1 border border-transparent px-2 font-mono text-[9px] uppercase tracking-[0.08em] text-on-surface hover:border-outline-variant hover:bg-surface-lowest/70 hover:text-on-surface disabled:pointer-events-none disabled:opacity-35"
            >
              <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
              全部折叠
            </button>
          </div>
        </Panel>
        <Controls
          position="bottom-right"
          showInteractive={false}
          className="!bg-surface-lowest/40 !border !border-outline-variant"
        />
      </ReactFlow>
    </div>
  );
}

function HostGraphAutoFit({ layoutSignature }: { layoutSignature: string }) {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    // OPR.0.4.2.17 —— 将 fitView 门控在 nodesInitialized（xyflow 已测量节点），
    // 而非固定 50ms 超时。30s 重新抓取时节点重新测量；旧的 50ms 在重新测量前
    // 触发，忠实地适配了折叠/未测量布局。测量完成时 nodesInitialized
    // 翻转为 true，此 effect 重新运行，适配真实（不同）布局。
    if (!layoutSignature || !nodesInitialized) return;
    if (lastSignatureRef.current === layoutSignature) return;
    lastSignatureRef.current = layoutSignature;
    void fitView({
      padding: HOST_GRAPH_FIT_PADDING,
      includeHiddenNodes: false,
      duration: 250,
    });
  }, [fitView, layoutSignature, nodesInitialized]);

  return null;
}
