// OPR.0.4.6.WF4 (C3b)——唯一的工作流形状渲染器，从 LibraryReview.tsx 提取
//（在那里作为本地组件发布；扩展不分叉，架构 Q2）。SliceWorkflowGraph 保持不变
//（收敛 = 命名后续）。
//
// 已发布行为精确保留：从入口节点的 BFS 深度布局（访问一次 = 最短路径深度，
// 循环安全），入口/终端强调色板，角色 + preferredTarget 节点结构，
// 静态非交互式画布。节点位置对任何给定拓扑与已发布渲染字节一致
//（布局数学不变）。
//
// WF-4 附加层——每层在其 prop/字段缺省时不渲染任何内容，使无实例的
// 库规格页保持已发布渲染：
//   - 分支边（C1 routingType:"branch"）渲染虚线 + 标签 `on <exit>`
//    （WF4-F1：已发布扫描器丢弃这些；C1 的投影携带它们）
//   - 每节点 harness / host / gate 芯片（WF-2 语言，C1 接缝）
//   - 实时位置：currentStepId → "你在此处"（重环 + ● 标记），
//     已访问步骤着色，已走轨迹边绘制实心深色
//
// WF4-F4（架构 Q-B，已裁定）：相同两个堆叠节点间的前向+后向边对
// 不得重叠为一条模糊线。机制 = 自定义节点上每个方向的不同连接点对
//（前向上/下通道 + 后向/侧向边的侧通道）。绑定约束：连接点分配是边记录的
// 纯函数（通过集合确定的最短路径深度）——绝不渲染顺序；置换边数组产生
// 相同连接点（WorkflowTopologyGraph 测试中断言）。这与 twin 的
// `type:"smoothstep"` 占位不同，twin 标记为不过度工程。

import { useMemo } from "react";
import {
  ReactFlow,
  Handle,
  Position,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { LibraryWorkflowReview } from "../../hooks/useSpecLibrary.js";
import { ToolMark } from "../graphics/RuntimeMark.js";

export const WF_NODE_WIDTH = 180;
export const WF_NODE_HEIGHT = 56;
export const WF_H_SPACING = 220;
export const WF_V_SPACING = 110;

type Topology = LibraryWorkflowReview["topology"];

// 连接点 id——每个节点携带全部四个，使任何边都能停靠任一通道。
const H_IN_TOP = "in-top";
const H_OUT_BOTTOM = "out-bottom";
const H_IN_SIDE = "in-side";
const H_OUT_SIDE = "out-side";

/** 已发布的 BFS 深度分配（从入口节点访问一次）。这是入口集合的最短路径距离，
 *  是边集合的纯函数——节点的首次访问 BFS 层级对兄弟/边数组顺序不变。
 *  因此同一映射同时驱动节点位置（字节一致）和 Q-B 连接点分类
 *（置换不变），无冲突。 */
export function computeStepDepths(topology: Topology): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const e of topology.edges) {
    if (!adj.has(e.fromStepId)) adj.set(e.fromStepId, []);
    adj.get(e.fromStepId)!.push(e.toStepId);
  }
  const depth = new Map<string, number>();
  const queue: Array<{ id: string; d: number }> = [];
  for (const n of topology.nodes) {
    if (n.isEntry) {
      depth.set(n.stepId, 0);
      queue.push({ id: n.stepId, d: 0 });
    }
  }
  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    for (const child of adj.get(id) ?? []) {
      if (!depth.has(child)) {
        depth.set(child, d + 1);
        queue.push({ id: child, d: d + 1 });
      }
    }
  }
  // 孤立节点回退（与已发布版本相同）。
  let fallbackDepth = 0;
  for (const n of topology.nodes) {
    if (!depth.has(n.stepId)) depth.set(n.stepId, fallbackDepth++);
  }
  return depth;
}

/** Q-B（架构已裁定，绑定）：将边的连接点对分配为边记录的纯函数——
 *  前向/下坡边（depth[to] > depth[from]）停靠上→下通道；回边或同级边停靠
 *  侧通道，使互惠对渲染为两条独立曲线。`depth` 由集合确定
 *（见 computeStepDepths），因此构造上置换不变。 */
export function assignEdgeHandles(
  fromStepId: string,
  toStepId: string,
  depth: Map<string, number>,
): { sourceHandle: string; targetHandle: string } {
  const dFrom = depth.get(fromStepId) ?? 0;
  const dTo = depth.get(toStepId) ?? 0;
  return dTo > dFrom
    ? { sourceHandle: H_OUT_BOTTOM, targetHandle: H_IN_TOP }
    : { sourceHandle: H_OUT_SIDE, targetHandle: H_IN_SIDE };
}

interface WorkflowStepData {
  stepId: string;
  role: string;
  preferredTarget: string | null;
  isEntry: boolean;
  isTerminal: boolean;
  harness?: "claude-code" | "codex";
  host?: string;
  gate?: { target: string; summary?: string; evidence_ref?: string };
  isCurrent: boolean;
  wasVisited: boolean;
}

/** 自定义步骤节点——内容与已发布默认节点标签相同，加上 WF-4 芯片/实时位置，
 *  带 Q-B 四连接点停靠集。 */
function WorkflowStepNode({ data }: { data: WorkflowStepData }) {
  const accent = data.isEntry ? "#a8c8d4" : data.isTerminal ? "#d4b8a8" : "#d4c4a8";
  const hasPins = Boolean(data.harness || data.host || data.gate);
  return (
    <div
      style={{
        backgroundColor: data.isCurrent ? "#e8dcb8" : data.wasVisited ? "#cfc3a4" : accent,
        border: data.isCurrent ? "3px solid #7a5c10" : "1px solid #8a8577",
        boxShadow: data.isCurrent ? "0 0 0 3px rgba(122, 92, 16, 0.25)" : undefined,
        // 锐角：设计系统将所有 border radius 归零
        //（tailwind-foundation + design-compliance 强制 borderRadius 0），
        // 应用的默认节点渲染 0 圆角——因此唯一的 build-vs-twin
        // 差异保持为 Q-B 边连接点对（裁定修复），而非节点框本身。
        borderRadius: 0,
        width: WF_NODE_WIDTH,
        height: hasPins ? WF_NODE_HEIGHT + 12 : WF_NODE_HEIGHT,
        padding: 6,
        fontFamily: "monospace",
        fontSize: 11,
      }}
    >
      {/* Q-B 停靠：前向上/下通道 + 回边侧通道。 */}
      <Handle type="target" position={Position.Top} id={H_IN_TOP} className="opacity-0" />
      <Handle type="source" position={Position.Bottom} id={H_OUT_BOTTOM} className="opacity-0" />
      <Handle type="target" position={Position.Right} id={H_IN_SIDE} className="opacity-0" />
      <Handle type="source" position={Position.Right} id={H_OUT_SIDE} className="opacity-0" />
      <div className="font-mono text-[10px] leading-tight">
        <div className="flex items-center justify-between gap-2 font-bold">
          <span>
            {data.isCurrent ? <span aria-hidden>● </span> : null}
            {data.stepId}
          </span>
          {data.isTerminal ? <ToolMark tool="terminal" size="xs" title="终止步骤" decorative /> : null}
        </div>
        <div className="text-on-surface-variant">{data.role}</div>
        {data.preferredTarget && <div className="text-[8px] text-on-surface-variant">→ {data.preferredTarget}</div>}
        {hasPins && (
          <div className="text-[8px] text-on-surface-variant">
            {data.harness ? <span data-testid={`wf-node-harness-${data.stepId}`}>⌁ {data.harness}</span> : null}
            {data.host ? <span data-testid={`wf-node-host-${data.stepId}`}>{data.harness ? " · " : ""}主机：{data.host}</span> : null}
            {data.gate ? (
              <span data-testid={`wf-node-gate-${data.stepId}`}>
                {data.harness || data.host ? " · " : ""}⛨ 门：{data.gate.target}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = { workflowStep: WorkflowStepNode };

export interface WorkflowTopologyGraphProps {
  topology: Topology;
  testId?: string;
  /** 实时位置：实例的持久当前步骤绑定。 */
  currentStepId?: string | null;
  /** 至少有一条关闭轨迹行的步骤（位置历史着色）。 */
  visitedStepIds?: string[];
  /** 从轨迹派生的已走路由边 "from→to" 键。 */
  takenEdgeKeys?: string[];
  /** 画布高度（Tailwind 类）；已发布默认 h-[400px]。 */
  heightClass?: string;
}

export function WorkflowTopologyGraph({
  topology,
  testId,
  currentStepId,
  visitedStepIds,
  takenEdgeKeys,
  heightClass,
}: WorkflowTopologyGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const depth = computeStepDepths(topology);

    // 按深度分组 → x 为深度内索引（与已发布版本相同）。
    const byDepth = new Map<number, string[]>();
    for (const n of topology.nodes) {
      const d = depth.get(n.stepId) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(n.stepId);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [d, ids] of byDepth) {
      ids.forEach((id, idx) => positions.set(id, { x: idx * WF_H_SPACING, y: d * WF_V_SPACING }));
    }

    const visited = new Set(visitedStepIds ?? []);
    const taken = new Set(takenEdgeKeys ?? []);

    const rfNodes: Node[] = topology.nodes.map((n) => ({
      id: n.stepId,
      type: "workflowStep",
      position: positions.get(n.stepId) ?? { x: 0, y: 0 },
      data: {
        stepId: n.stepId,
        role: n.role,
        preferredTarget: n.preferredTarget,
        isEntry: n.isEntry,
        isTerminal: n.isTerminal,
        harness: n.harness,
        host: n.host,
        gate: n.gate,
        isCurrent: currentStepId != null && n.stepId === currentStepId,
        wasVisited: visited.has(n.stepId),
      } as unknown as Record<string, unknown>,
    }));

    const rfEdges: Edge[] = topology.edges.map((e, i) => {
      const isBranch = e.routingType === "branch";
      const wasTaken = taken.has(`${e.fromStepId}→${e.toStepId}`);
      const { sourceHandle, targetHandle } = assignEdgeHandles(e.fromStepId, e.toStepId, depth);
      return {
        id: `e-${i}`,
        source: e.fromStepId,
        target: e.toStepId,
        sourceHandle,
        targetHandle,
        label: isBranch && e.branchOn ? `在 ${e.branchOn} 上` : undefined,
        labelStyle: { fontFamily: "monospace", fontSize: 9, fill: "#7a5c10" },
        labelBgStyle: { fill: "#f2ead6" },
        animated: wasTaken && currentStepId != null,
        style: {
          stroke: wasTaken ? "#5c4a10" : isBranch ? "#a8842c" : "#8a8577",
          strokeWidth: wasTaken ? 2.5 : 1,
          strokeDasharray: isBranch ? "6 4" : undefined,
        },
      };
    });

    return { nodes: rfNodes, edges: rfEdges };
  }, [topology, currentStepId, visitedStepIds, takenEdgeKeys]);

  return (
    <div
      data-testid={testId ?? "workflow-topology-graph"}
      className={`w-full ${heightClass ?? "h-[400px]"} bg-background border border-outline-variant`}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={0.5} color="#d4d0c8" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
