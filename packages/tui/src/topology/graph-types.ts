// SPIKE（topology-render-style，喂 OPR.0.5.0.17）——已存在
// `GET /api/rigs/:id/graph` 投影的窄 TUI 侧读取形状（R7：两个
// 渲染器在一个投影上；无新数据，无新遥测）。字段名
// 逐字匹配后台服务的序列化 ReactFlowGraph——见
// packages/daemon/src/domain/graph-projection.ts（RFNode/RFEdge）和
// 捕获的样本 spike/real-graph-v-openrig-build.json。
export interface GraphNodeData {
  logicalId: string;
  podNamespace?: string | null;
  podLabel?: string | null;
  runtime: string | null;
  model: string | null;
  /** 最新会话状态逐字（null = 无会话） */
  status: string | null;
  nodeKind: "agent" | "infrastructure";
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  contextUsedPercentage: number | null;
  agentActivity?: { state?: string } | null;
  terminalActive?: boolean | null;
  heldReason?: string | null;
  canonicalSessionName?: string | null;
}

export interface GraphNode {
  id: string;
  /** "podGroup"（席位容器）或 "rigNode"（智能体/基础设施席位） */
  type: string;
  parentId?: string;
  data: GraphNodeData;
}

export interface GraphEdge {
  id: string;
  /** 节点 id（非 logicalId）——通过 GraphNode.id 连接 */
  source: string;
  target: string;
  /** 服务的边类型字符串（如 delegates_to）——后台服务序列化
   *  在 `label` 下；spike 渲染为线颜色，绝非文本 */
  label: string;
}

export interface RigGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
