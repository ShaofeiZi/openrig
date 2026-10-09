// SPIKE——盒装图样式的确定性手工布局。
// 委托深度将节点排位列（Hatchet 左→右读）；
// 协作者拉到其源右侧；escalates_to 是回边且
// 绝不排名。一切仅从服务投影派生。
import type { GraphEdge, GraphNode, RigGraph } from "./graph-types.js";
import { statusGlyph, type StatusGlyph } from "./glyphs.js";
import { markText, runtimeMarkSegs } from "./runtime-marks.js";

export interface PlacedNode {
  node: GraphNode;
  glyph: StatusGlyph;
  /** 仅成员显示标题（S19 MR1——身份保持 logicalId 在每个
   *  区/动作；仅此为显示） */
  title: string;
  /** `● member  63%` 和 `runtime · ctx%`——节点内的信息 */
  nameLine: string;
  metaLine: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphContainer {
  kind: "rig" | "pod";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphLayout {
  placed: PlacedNode[];
  byId: Map<string, PlacedNode>;
  edges: GraphEdge[];
  /** R2 HIGH-1：锁定的包含层级——工作组容器包裹
   *  席位容器，席位容器包裹其成员智能体框；渲染器
   *  必须绘制它们（席位中智能体中工作组是可见契约，非元数据） */
  containers: GraphContainer[];
  width: number;
  height: number;
  /** MR8：当布局范围超过视口宽度时为 true——
   *  渲染器必须显示诚实的裁剪内容指示 */
  clipped: boolean;
}

export function agentNodes(graph: RigGraph): GraphNode[] {
  return graph.nodes.filter((n) => n.type === "rigNode" && n.data.nodeKind === "agent");
}

export function nodeLines(node: GraphNode): { glyph: StatusGlyph; title: string; nameLine: string; metaLine: string } {
  const glyph = statusGlyph(node.data);
  const ctx = node.data.contextUsedPercentage;
  // S19 MR1（§A1）：席位仅命名一次——通过其容器标签页。卡片
  // 标题是仅成员段（确认的 `${pod}.` 前缀剥离，
  // 导航器规则；非前缀名称不变显示）且元数据
  // 去掉席位后缀。
  const pod = node.data.podNamespace;
  const member = pod && node.data.logicalId.startsWith(`${pod}.`)
    ? node.data.logicalId.slice(pod.length + 1)
    : node.data.logicalId;
  const nameLine = `${glyph.glyph} ${member}${glyph.overlay ? `  ${glyph.overlay}` : ""}`;
  // S19 MR2：元数据 = Web 族运行时标记 + 相邻 ctx%（诚实未知 —）
  const metaLine = `${markText(runtimeMarkSegs(node.data.runtime))} ${ctx == null ? "—" : `${Math.round(ctx)}%`}`;
  return { glyph, title: member, nameLine, metaLine };
}

function rankNodes(agents: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const rank = new Map<string, number>();
  const delegates = edges.filter((e) => e.label === "delegates_to");
  const hasIncoming = new Set(delegates.map((e) => e.target));
  const roots = agents.filter((n) => !hasIncoming.has(n.id));
  for (const root of roots) rank.set(root.id, 0);
  // 放宽委托深度（夹具规模图；有界通过）
  for (let pass = 0; pass < agents.length; pass++) {
    let changed = false;
    for (const e of delegates) {
      const from = rank.get(e.source);
      if (from == null) continue;
      const proposed = from + 1;
      if ((rank.get(e.target) ?? -1) < proposed) {
        rank.set(e.target, proposed);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 协作者坐在其伙伴右侧一列（mockup 读法：
  // lead → driver ═ qa）——适用于本身不是委托目标的节点，
  // 即使根默认临时将它们排为 0
  for (const e of edges.filter((x) => x.label === "collaborates_with")) {
    const from = rank.get(e.source);
    const targetIsDelegate = delegates.some((d) => d.target === e.target);
    const targetDelegates = delegates.some((d) => d.source === e.target);
    if (from != null && !targetIsDelegate && !targetDelegates) rank.set(e.target, from + 1);
  }
  for (const n of agents) if (!rank.has(n.id)) rank.set(n.id, 0);
  return rank;
}

const POD_GAP = 4;
const MARGIN_X = 1;

/** R2 HIGH-1 布局：席位是聚类单元——每个席位是一个容器
 *  列，垂直堆叠其成员智能体框；席位按其成员的
 *  最小委托排名排序（委托仍左→右读）；
 *  工作组容器包裹一切。未分组智能体获得"(无席位)"
 *  聚类，使无服务内容被丢弃。 */
export function layoutGraph(graph: RigGraph, maxWidth: number, rigName = ""): GraphLayout {
  const agents = agentNodes(graph);
  const rank = rankNodes(agents, graph.edges);
  const podLabel = new Map<string, string>(
    graph.nodes.filter((n) => n.type === "podGroup").map((n) => [n.id, n.data.podNamespace ?? n.data.logicalId]),
  );
  const pods = new Map<string, GraphNode[]>();
  for (const n of agents) {
    const key = (n.parentId && podLabel.get(n.parentId)) ?? n.data.podNamespace ?? "(无席位)";
    pods.set(key, [...(pods.get(key) ?? []), n]);
  }
  const podOrder = [...pods.entries()].sort(([an, a], [bn, b]) => {
    const ar = Math.min(...a.map((n) => rank.get(n.id) ?? 0));
    const br = Math.min(...b.map((n) => rank.get(n.id) ?? 0));
    return ar - br || an.localeCompare(bn);
  });

  const placed: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  const containers: GraphContainer[] = [];
  const rigX = MARGIN_X;
  const rigY = 1;
  let podX = rigX + 2;
  let maxPodBottom = 0;
  for (const [podName, members] of podOrder) {
    const sorted = [...members].sort(
      (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) || a.data.logicalId.localeCompare(b.data.logicalId),
    );
    const podTop = rigY + 1;
    let y = podTop + 1;
    let podInnerW = Math.max(`▾ ${podName}`.length + 2, 8);
    for (const node of sorted) {
      const { glyph, title, nameLine, metaLine } = nodeLines(node);
      const w = Math.max(nameLine.length, metaLine.length) + 4;
      const p: PlacedNode = { node, glyph, title, nameLine, metaLine, x: podX + 2, y, w, h: 4 };
      placed.push(p);
      byId.set(node.id, p);
      y += p.h + 1;
      podInnerW = Math.max(podInnerW, w);
    }
    const podW = podInnerW + 4;
    const podH = y - podTop + 1;
    containers.push({ kind: "pod", name: podName, x: podX, y: podTop, w: podW, h: podH });
    maxPodBottom = Math.max(maxPodBottom, podTop + podH);
    podX += podW + POD_GAP;
  }
  const rigW = podX - POD_GAP + 2 - rigX;
  // 两个备用内部行：升级下通行走廊（泳道 0-1）
  // 绝不能落在工作组自己的底边框上
  const rigH = maxPodBottom - rigY + 4;
  containers.unshift({ kind: "rig", name: rigName, x: rigX, y: rigY, w: rigW, h: rigH });

  const trueWidth = rigX + rigW + MARGIN_X;
  const width = Math.min(trueWidth, maxWidth);
  const height = rigY + rigH + 1;
  return { placed, byId, edges: graph.edges, containers, width, height, clipped: trueWidth > maxWidth };
}
