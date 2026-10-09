import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ReactFlow, Controls, Handle, Position, type NodeTypes, type EdgeTypes, type Node, type Edge, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRigGraph } from "../hooks/useRigGraph.js";
import { useRigEvents } from "../hooks/useRigEvents.js";
import { useDiscoveredSessionsConditional, type DiscoveredSession } from "../hooks/useDiscovery.js";
import { useDiscoveryPlacement, useDrawerSelection } from "./AppShell.js";
import { getEdgeStyle } from "@/lib/edge-styles";
import { applyTreeLayout } from "@/lib/graph-layout";
import { RigNode } from "./RigNode.js";
import { HotPotatoEdge } from "./topology/HotPotatoEdge.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { displayPodName, inferPodName } from "../lib/display-name.js";
import { useTopologyActivity } from "../hooks/useTopologyActivity.js";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion.js";
import { useSelectedHostId } from "../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";
import {
  applyHotPotatoEdges,
  buildTopologySessionIndex,
  type TopologyActivityBaseline,
} from "../lib/topology-activity.js";

function PodGroupNode({
  data,
}: {
  data: {
    podLabel?: string | null;
    logicalId?: string | null;
    podId?: string | null;
    podNamespace?: string | null;
    podDisplayName?: string | null;
    placementState?: "available" | "selected" | null;
  };
}) {
  const label = data.podDisplayName ?? data.podNamespace ?? inferPodName(data.logicalId) ?? displayPodName(data.podId ?? data.logicalId);

  return (
    <div
      data-testid="pod-group-node"
      className={`w-full h-full relative pointer-events-auto ${
        data.placementState === "selected"
          ? "ring-2 ring-emerald-500/80 shadow-[0_0_0_4px_rgba(52,211,153,0.12)]"
          : data.placementState === "available"
            ? "ring-1 ring-emerald-300/80"
            : ""
      }`}
    >
      <div className="absolute left-4 top-3 inline-flex items-center font-mono text-[12px] font-bold leading-none tracking-[0.08em] text-on-surface">
        {`${label} 容器组`}
      </div>
    </div>
  );
}

/** 以虚线边框渲染已发现但未受管的节点。 */
function DiscoveredNode({ data }: { data: { session: DiscoveredSession } }) {
  const s = data.session;
  return (
    <div data-testid="discovered-graph-node" className="border-dashed border-2 border-foreground/30 bg-surface-low/50 p-spacing-3 min-w-[180px]">
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="text-label-sm font-mono uppercase mb-spacing-1">{s.tmuxSession}:{s.tmuxPane}</div>
      <div className="flex gap-spacing-2 items-center mb-spacing-1">
        <span className="text-label-sm uppercase text-foreground-muted">{s.runtimeHint}</span>
        <span className="text-label-sm text-foreground-muted">{s.confidence}</span>
      </div>
      {s.cwd && <div className="text-label-sm font-mono text-foreground-muted truncate">{s.cwd}</div>}
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  rigNode: RigNode,
  discoveredNode: DiscoveredNode,
  podGroup: PodGroupNode,
};

const edgeTypes: EdgeTypes = {
  hotPotato: HotPotatoEdge,
};

/** 空拓扑的线框占位图。 */
function EmptyTopologyGhost() {
  return (
    <div className="flex flex-col items-center justify-center h-full relative text-foreground-muted" data-testid="empty-topology">
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 300" fill="none" style={{ opacity: 0.08 }}>
        <rect x="160" y="60" width="80" height="40" stroke="currentColor" strokeWidth="1" />
        <rect x="60" y="180" width="80" height="40" stroke="currentColor" strokeWidth="1" />
        <rect x="260" y="180" width="80" height="40" stroke="currentColor" strokeWidth="1" />
        <line x1="200" y1="100" x2="100" y2="180" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" />
        <line x1="200" y1="100" x2="300" y2="180" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" />
      </svg>
      <div className="relative z-10 text-center">
        <h2 className="text-headline-md uppercase">空拓扑</h2>
      </div>
    </div>
  );
}

interface FocusMessage {
  text: string;
  type: "success" | "error" | "info";
}

export function RigGraph({
  rigId,
  rigName = null,
  showDiscovered = true,
  podScope,
}: {
  rigId: string | null;
  rigName?: string | null;
  showDiscovered?: boolean;
  /** V1 打磨切片第 5.1 阶段 P5.1-5：Pod 范围筛选。设置后，图中只渲染 Pod 名称
   * 匹配的节点、边和 podGroups（通过 inferPodName 与 node.podId/podNamespace 匹配）。
   * 其他工作组节点会被滤除，使图呈现为单 Pod 子集。供
   * /topology/pod/$rigId/$podName 图视图模式使用。 */
  podScope?: string;
}) {
  const { data, isPending: loading, error: queryError } = useRigGraph(rigId ?? "");
  const discoveredSessions = useDiscoveredSessionsConditional(showDiscovered);
  const allRawNodes = data?.nodes ?? [];
  const allRawEdges = data?.edges ?? [];

  // P5.1-5 Pod 范围筛选：设置 podScope 后，只保留 Pod 匹配的节点，以及筛选后节点之间的边。
  // Hook 数据类型为 unknown[]，此处行内转换为已知形态。
  const { rawNodes, rawEdges } = useMemo(() => {
    if (!podScope) return { rawNodes: allRawNodes, rawEdges: allRawEdges };
    type RigNodeShape = {
      id: string;
      type?: string;
      data?: { logicalId?: string; podId?: string | null; podNamespace?: string | null };
    };
    type RigEdgeShape = { source: string; target: string };
    const allowedNodeIds = new Set<string>();
    const filteredNodes = (allRawNodes as RigNodeShape[]).filter((n) => {
      if (n.type === "podGroup" || n.type === "group") {
        const matches =
          (n.data?.podNamespace ?? n.data?.podId) === podScope;
        if (matches) allowedNodeIds.add(n.id);
        return matches;
      }
      const inferredPod =
        n.data?.podNamespace ??
        n.data?.podId ??
        inferPodName(n.data?.logicalId ?? null);
      const matches = inferredPod === podScope;
      if (matches) allowedNodeIds.add(n.id);
      return matches;
    });
    const filteredEdges = (allRawEdges as RigEdgeShape[]).filter(
      (e) => allowedNodeIds.has(e.source) && allowedNodeIds.has(e.target),
    );
    return { rawNodes: filteredNodes, rawEdges: filteredEdges };
  }, [allRawNodes, allRawEdges, podScope]);
  const error = queryError?.message ?? null;
  const { reconnecting } = useRigEvents(rigId);
  const reducedMotion = usePrefersReducedMotion();
  // OPR.0.4.6.MH2 rev1-r2 B1：cmux 聚焦是本地会话操作；选择远程主机时，点击节点仍会
  // 导航进入只读详情，但绝不能发出裸本地聚焦 POST。
  const graphIsRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  const [focusMessage, setFocusMessage] = useState<FocusMessage | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 进入动画跟踪：以 rigId 为键，每次导航只触发一次。
  const animatedRigRef = useRef<string | null>(null);
  const shouldAnimate = rigId !== null && animatedRigRef.current !== rigId;

  // 首次渲染后将动画标记为完成。
  useEffect(() => {
    if (rigId && rawNodes.length > 0 && animatedRigRef.current !== rigId) {
      animatedRigRef.current = rigId;
    }
  }, [rigId, rawNodes.length]);

  const showFocusMessage = useCallback((msg: FocusMessage) => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setFocusMessage(msg);
    dismissTimerRef.current = setTimeout(() => {
      setFocusMessage(null);
      dismissTimerRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  const sessionIndex = useMemo(() => {
    return buildTopologySessionIndex((rawNodes as Node[])
      .filter((node) => node.type === "rigNode")
      .map((node) => {
        const data = node.data as {
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
          rigId,
          rigName,
          logicalId: data?.logicalId ?? null,
          canonicalSessionName: data?.canonicalSessionName ?? null,
          agentActivity: data?.agentActivity ?? null,
          currentQitems: data?.currentQitems ?? null,
          startupStatus: data?.startupStatus ?? null,
          terminalActive: data?.terminalActive,
          hasAssignedWork: data?.hasAssignedWork ?? false,
          pendingWorkCount: data?.pendingWorkCount ?? 0,
        };
      }));
  }, [rawNodes, rigId, rigName]);
  const topologyActivity = useTopologyActivity(sessionIndex);

  const rfEdges = useMemo(() => {
    return (rawEdges as (Edge & { data?: { kind?: string } })[]).map((edge) => {
      const kind = (edge as { data?: { kind?: string } }).data?.kind ??
        (edge as { label?: string }).label ?? "delegates_to";
      const styleResult = getEdgeStyle(kind);
      return {
        ...edge,
        ...styleResult,
        className: shouldAnimate ? "edge-draw-in" : undefined,
        style: {
          ...styleResult.style,
          animationDelay: shouldAnimate ? `${Math.min(rawNodes.length * 50 + 100, 2000)}ms` : undefined,
        },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawEdges, shouldAnimate, rawNodes.length]);

  // 对节点应用树形布局和进入动画。
  const podMetaById = useMemo(() => {
    const meta = new Map<string, { displayName: string | null; namespace: string | null }>();
    for (const node of rawNodes as Node[]) {
      const nodeData = node.data as { logicalId?: string | null; podId?: string | null; podLabel?: string | null; podNamespace?: string | null } | undefined;
      if ((node.type === "podGroup" || node.type === "group") && nodeData?.podId) {
        meta.set(nodeData.podId, {
          displayName: nodeData.podLabel ?? nodeData.podNamespace ?? inferPodName(nodeData.logicalId) ?? displayPodName(nodeData.podId),
          namespace: nodeData.podNamespace ?? nodeData.logicalId ?? null,
        });
        continue;
      }
      const podId = nodeData?.podId ?? null;
      if (!podId) continue;
      const namespace = nodeData?.podNamespace ?? inferPodName(nodeData?.logicalId) ?? null;
      const displayName = nodeData?.podLabel ?? namespace ?? displayPodName(podId);
      if (!meta.has(podId)) {
        meta.set(podId, { displayName, namespace });
      }
    }
    return meta;
  }, [rawNodes]);

  const { selection, setSelection } = useDrawerSelection();
  const { selectedDiscoveredId, placementTarget, setPlacementTarget } = useDiscoveryPlacement();
  const placementMode = selection?.type === "discovery" && Boolean(selectedDiscoveredId);

  const rfNodes = useMemo(() => {
    const podDisplayNames = new Map<string, string>();
    for (const node of rawNodes as Node[]) {
      if (!node.parentId) {
        continue;
      }

      const logicalId = typeof node.data === "object" && node.data !== null && "logicalId" in node.data
        ? (node.data as { logicalId?: string | null }).logicalId
        : null;
      const podId = typeof node.data === "object" && node.data !== null && "podId" in node.data
        ? (node.data as { podId?: string | null }).podId
        : null;
      const podDisplayName = inferPodName(logicalId) ?? displayPodName(podId);

      if (podDisplayName && !podDisplayNames.has(node.parentId)) {
        podDisplayNames.set(node.parentId, podDisplayName);
      }
    }

    const layoutNodes = applyTreeLayout(rawNodes as Node[], rawEdges as unknown as Parameters<typeof applyTreeLayout>[1]);
    const managed = layoutNodes.map((node, index) => ({
      ...node,
      data: (() => {
        if (node.type === "podGroup" || node.type === "group") {
          const podData = node.data as { podId?: string | null };
          const podId = podData?.podId ?? null;
          const selectedPod =
            placementTarget?.kind === "pod" && podId !== null && placementTarget.podId === podId;
          return {
            ...(node.data ?? {}),
            podDisplayName: podDisplayNames.get(node.id) ?? null,
            placementState: placementMode ? (selectedPod ? "selected" : "available") : null,
          };
        }

        if (node.type === "rigNode") {
          const nodeData = node.data as {
            logicalId?: string | null;
            binding?: { tmuxSession?: string | null } | null;
            canonicalSessionName?: string | null;
          };
          const available = !nodeData?.binding && !nodeData?.canonicalSessionName;
          const selectedNode =
            placementTarget?.kind === "node" &&
            nodeData?.logicalId !== undefined &&
            placementTarget.logicalId === nodeData.logicalId;
          return {
            ...(node.data ?? {}),
            placementState: placementMode
              ? (selectedNode ? "selected" : available ? "available" : null)
              : null,
          };
        }

        return node.data;
      })(),
      className: shouldAnimate ? "node-enter" : undefined,
      style: {
        ...(node.style ?? {}),
        animationDelay: shouldAnimate ? `${Math.min(index * 50, 2000)}ms` : undefined,
      },
    }));

    // 在受管节点下方，以虚线节点加入已发现会话。
    const maxY = managed.reduce((max, n) => Math.max(max, (n.position?.y ?? 0)), 0);
    const discovered = discoveredSessions.map((s, i) => ({
      id: `discovered-${s.id}`,
      type: "discoveredNode" as const,
      position: { x: 300, y: maxY + 200 + i * 150 },
      data: { session: s } as Record<string, unknown>,
    }));

    return [...managed, ...discovered] as Node[];
  }, [rawNodes, rawEdges, shouldAnimate, discoveredSessions, placementMode, placementTarget]);

  const activityNodes = useMemo(() => rfNodes.map((node) => {
    if (node.type !== "rigNode") return node;
    const data = node.data as TopologyActivityBaseline;
    return {
      ...node,
      data: {
        ...(node.data ?? {}),
        activityRing: topologyActivity.getNodeActivity(node.id, data),
        reducedMotion,
        // OPR.0.4.6.MH2 rev1-r2 B1：与 reducedMotion 共用同一充实通道，使 RigNode 不使用 hook；
        // 独立测试装具因而无须 QueryClientProvider。
        remoteReadonly: graphIsRemote,
      },
    };
  }), [rfNodes, topologyActivity, reducedMotion, graphIsRemote]);

  const activityEdges = useMemo(
    () => applyHotPotatoEdges(rfEdges, topologyActivity.packets, { reducedMotion }),
    [rfEdges, topologyActivity.packets, reducedMotion],
  );

  // V1 打磨切片第 5.1 阶段 P5.1-2 + DRIFT P5.1-D2：点击图节点会导航到
  // /topology/seat/$rigId/$logicalId 中心页，与 Explorer 目录树和表格行点击契约一致。
  // 它替代旧的 setSelection({type:'seat-detail'}) 打开抽屉行为；第 5.1 阶段后已完全弃用
  // useNodeSelection 别名。
  const navigate = useNavigate();

  const onNodeClick: NodeMouseHandler = useCallback(
    async (_event, node) => {
      if (!rigId) return;

      if (placementMode) {
        // OPR.0.4.6.MH2 rev1-r2 再裁定 B1：放置目标会供给本地发现绑定/接纳变更，
        // 因此远程渲染的节点或 Pod 绝不能成为放置目标。
        if (graphIsRemote) {
          return;
        }
        if (node.type === "podGroup" || node.type === "group") {
          const podData = node.data as { podId?: string | null };
          const podId = podData?.podId ?? null;
          const podMeta = podId ? podMetaById.get(podId) : null;
          const eligible = Boolean(podId && podMeta?.namespace);
          setPlacementTarget({
            kind: "pod",
            rigId,
            podId: podId ?? "",
            podNamespace: podMeta?.namespace ?? null,
            podLabel: podMeta?.displayName ?? null,
            eligible,
            ...(eligible ? {} : { reason: "此容器组暂不可接收新节点。" }),
          });
          return;
        }

        if (node.type === "rigNode") {
          const nodeData = node.data as {
            logicalId: string;
            binding: { tmuxSession?: string | null; cmuxSurface?: string | null } | null;
            canonicalSessionName?: string | null;
          };
          const available = !nodeData.binding && !nodeData.canonicalSessionName;
          setPlacementTarget({
            kind: "node",
            rigId,
            logicalId: nodeData.logicalId,
            eligible: available,
            ...(available ? {} : { reason: "此节点已被占用。" }),
          });
          return;
        }
      }

      if (node.type === "podGroup" || node.type === "group") {
        // 第 4 阶段 P4-5：DrawerSelection 已弃用 'rig' 类型；在图层面点击 Pod 组不执行操作，
        // Pod 通过 Explorer 目录树的 /topology/pod/$rigId/$podName 链接打开。
        return;
      }

      const nodeData = node.data as {
        logicalId: string;
        binding: { cmuxSurface?: string | null } | null;
      };

      // V1 打磨切片第 5.1 阶段 P5.1-2：导航到中心页，规范智能体详情为 LiveNodeDetails。
      // 与 Explorer 目录树点击和拓扑表格行点击保持一致（P5.1-7）。
      navigate({
        to: "/topology/seat/$rigId/$logicalId",
        params: { rigId, logicalId: encodeURIComponent(nodeData.logicalId) },
      });

      if (graphIsRemote) {
        return;
      }

      if (!nodeData.binding?.cmuxSurface) {
        showFocusMessage({ text: "未绑定到 cmux 界面", type: "info" });
        return;
      }

      try {
        const res = await fetch(
          `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeData.logicalId)}/focus`,
          { method: "POST" }
        );

        if (!res.ok) {
          showFocusMessage({ text: "聚焦失败", type: "error" });
          return;
        }

        const result = await res.json();

        if (result.ok === false && result.code === "unavailable") {
          showFocusMessage({ text: "cmux 未连接", type: "error" });
        } else if (result.ok) {
          showFocusMessage({ text: "已聚焦", type: "success" });
        } else {
          showFocusMessage({ text: "聚焦失败", type: "error" });
        }
      } catch {
        showFocusMessage({ text: "聚焦失败", type: "error" });
      }
    },
    [placementMode, podMetaById, rigId, setPlacementTarget, navigate, setSelection, showFocusMessage, graphIsRemote]
  );

  if (rigId === null) {
    return <div className="p-spacing-6 text-foreground-muted">未选择工作组</div>;
  }

  if (loading) {
    return (
      <div className="p-spacing-6" data-testid="graph-loading">
        <div className="h-8 w-48 animate-pulse-tactical mb-spacing-4" />
        <div className="h-64 animate-pulse-tactical" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-spacing-6">
        <Alert data-testid="graph-error">
          <AlertDescription>错误：{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (activityNodes.length === 0) {
    return <EmptyTopologyGhost />;
  }

  return (
    <div
      className="w-full h-full relative"
      data-testid="graph-view"
      data-animated={shouldAnimate ? "true" : "false"}
    >
      {/* Registration marks on canvas */}
      <div className="absolute top-4 left-4 w-3 h-3 reg-mark"><div className="reg-tl" /></div>
      <div className="absolute top-4 right-4 w-3 h-3"><div className="reg-tr" /></div>
      <div className="absolute bottom-4 left-4 w-3 h-3"><div className="reg-bl" /></div>
      <div className="absolute bottom-4 right-4 w-3 h-3"><div className="reg-br" /></div>

      {reconnecting && (
        <div className="absolute top-spacing-4 right-spacing-4 z-20">
          <Alert>
            <AlertDescription className="text-warning">实时更新已与后台服务断开——正在重连…</AlertDescription>
          </Alert>
        </div>
      )}
      {focusMessage && (
        <div className={`absolute top-spacing-4 left-spacing-4 z-20 px-spacing-4 py-spacing-2 font-mono text-[10px] border ${
          focusMessage.type === "success" ? "bg-surface-lowest border-on-surface text-on-surface" :
          focusMessage.type === "error" ? "bg-tertiary/10 border-tertiary text-tertiary" :
          "bg-surface-lowest border-outline-variant text-on-surface-variant"
        }`}>
          {focusMessage.text}
        </div>
      )}
      {placementMode && !graphIsRemote && (
        <div
          data-testid="graph-placement-banner"
          className="absolute top-spacing-4 left-1/2 z-20 -translate-x-1/2 border border-emerald-300/90 bg-[rgba(236,253,245,0.92)] px-3.5 py-2 font-mono text-[10px] text-emerald-950 shadow-[0_12px_28px_rgba(34,197,94,0.14)] backdrop-blur-sm"
        >
          放置模式 / 点击可用节点进行绑定，或点击容器组以添加新节点。
        </div>
      )}
      <ReactFlow
        nodes={activityNodes}
        edges={activityEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        selectionOnDrag={false}
        panOnDrag
        fitView
        fitViewOptions={{ padding: 0.16, maxZoom: 1.15 }}
        className="relative z-10"
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Controls />
      </ReactFlow>
    </div>
  );
}
