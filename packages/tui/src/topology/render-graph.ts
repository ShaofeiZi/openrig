// Slice-17 拓扑腿——生产样式注册表（按创建者样式裁决从
// spike 收窄）：hatchet = 已发布主线
//（frame-01），braille = 条件平滑样式（frame-09）带其
// 已证明的 TIER-1 回退。Frame-06 树保留（刻意不接线）；
// flow/blocks 保持仅 spike。每个样式渲染一个服务 /graph
// 投影在相同视图状态上（R7 + PIN-1）。
import { GraphCanvas } from "./canvas.js";
import { layoutGraph } from "./layout.js";
import { renderHatchet, type StyleContext } from "./styles/hatchet.js";
import { renderBraille } from "./styles/braille.js";
import type { RigGraph } from "./graph-types.js";

export const GRAPH_STYLE_NAMES = ["hatchet", "braille", "braille-fallback"] as const;
export type GraphStyle = (typeof GRAPH_STYLE_NAMES)[number];

export function isGraphStyle(value: string): value is GraphStyle {
  return (GRAPH_STYLE_NAMES as readonly string[]).includes(value);
}

export function renderGraphStyle(style: string, graph: RigGraph, ctx: StyleContext, width: number): GraphCanvas {
  switch (style) {
    case "braille":
      return renderBraille(layoutGraph(graph, width, ctx.rig), ctx, width, false);
    case "braille-fallback":
      return renderBraille(layoutGraph(graph, width, ctx.rig), ctx, width, true);
    default:
      // hatchet 是主线也是未知样式安全地板——
      // reducer 已在渲染前拒绝未知名称（一个表面）
      return renderHatchet(layoutGraph(graph, width, ctx.rig), ctx, width);
  }
}
