// SPIKE——主线样式（创建者首选，Hatchet 参考）：
// 盒装节点 + 直盒绘连接线 + 箭头。
// 信息在节点内（名称行 + 运行时 · ctx% · 席位元数据行），
// 状态在节点上（边框颜色 + 字形），边类型是线颜色
// （delegates=青 accent · collaborates=绿 ok · escalates=琥珀 warn）——
// 图上无文本标签（创建者细化）。仅 TIER-1 字形。
import { GraphCanvas } from "../canvas.js";
import { edgeToken } from "../glyphs.js";
import { markText, runtimeMarkSegs } from "../runtime-marks.js";
import type { GraphContainer, GraphLayout, PlacedNode } from "../layout.js";
import type { Action, ResourceTarget } from "../../types.js";
import { strWidth } from "../../text-width.js";

export interface StyleContext {
  /** 钻取动作的主机/工作组名称（每个
   * 适配器派发的相同动作词汇——PIN-1） */
  host: string;
  rig: string;
  /** 所选节点的 logicalId（强调边框，如 Hatchet） */
  selected?: string | null;
}

export function drillAction(node: PlacedNode, ctx: StyleContext): Action {
  const target: ResourceTarget = {
    host: ctx.host,
    rig: ctx.rig,
    ...(node.node.data.podNamespace ? { pod: node.node.data.podNamespace } : {}),
  };
  return { type: "drill", resource: "agent", name: node.node.data.logicalId, target };
}

export function drawNodeBox(canvas: GraphCanvas, p: PlacedNode, ctx: StyleContext): void {
  const selected = ctx.selected === p.node.data.logicalId;
  const borderToken = selected ? "accent" : p.glyph.token;
  canvas.box(p.x, p.y, p.w, p.h, borderToken);
  canvas.text(p.x + 2, p.y + 1, p.glyph.glyph, p.glyph.token, true);
  canvas.text(p.x + 4, p.y + 1, p.title, "bright", selected);
  if (p.glyph.overlay) canvas.text(p.x + 4 + strWidth(p.title) + 2, p.y + 1, p.glyph.overlay, "warn", true);
  // S19 MR2：运行时渲染为 Web 族标记 + 相邻 ctx%
  let mx = p.x + 2;
  for (const seg of runtimeMarkSegs(p.node.data.runtime)) {
    canvas.text(mx, p.y + 2, seg.text, seg.token, seg.bold, );
    if (seg.bg) {
      let col = mx;
      for (const ch of seg.text) { canvas.set(col, p.y + 2, ch, seg.token, seg.bold, seg.bg); col += strWidth(ch); }
    }
    mx += strWidth(seg.text);
  }
  const ctxText = ` ${p.node.data.contextUsedPercentage == null ? "—" : `${Math.round(p.node.data.contextUsedPercentage)}%`}`;
  canvas.text(mx, p.y + 2, ctxText, "dim");
  // 整个框是命中面——每行发出相同钻取动作
  const action = drillAction(p, ctx);
  for (let row = 0; row < p.h; row++) canvas.zone(p.y + row, p.x, p.x + p.w, action);
}

interface Arrow {
  x: number;
  y: number;
  ch: string;
  token: ReturnType<typeof edgeToken>;
}

/** 直正交连接器；箭头返回，使调用方能
 * 最后绘制它（它必须在节点框覆盖线端后存活） */
type Rect = { x: number; y: number; w: number; h: number };

export function drawEdge(canvas: GraphCanvas, from: PlacedNode, to: PlacedNode, kind: string, lane = 0, obstacles: Rect[] = []): Arrow {
  const token = edgeToken(kind);
  const sy = from.y + 1;
  const ty = to.y + 1;
  if (to.x > from.x + from.w) {
    // 向右：从源右边缘出，一个走廊转弯，进入目标左边缘
    const sx = from.x + from.w;
    const corridor = to.x - 3 - lane * 2;
    canvas.hline(sx, corridor, sy, "─", token);
    if (sy !== ty) {
      canvas.vline(corridor, Math.min(sy, ty), Math.max(sy, ty), "│", token);
      canvas.set(corridor, sy, sy < ty ? "┐" : "┘", token);
      canvas.set(corridor, ty, sy < ty ? "└" : "┌", token);
    }
    canvas.hline(corridor + 1, to.x - 2, ty, "─", token);
    return { x: to.x - 1, y: ty, ch: "▸", token };
  }
  if (to.x + to.w < from.x) {
    // 向左回边（升级）：在框下布线，使它绝不
    // 拥挤委托行——沿低走廊向下、向左、向上进入
    // 目标底边缘（mockup 的曲线，盒绘）。垂直
    // 腿选择无其他框占用的列（感知障碍）。
    const belowY = Math.max(...[from, to, ...obstacles].map((p) => p.y + p.h)) + 1 + lane;
    const freeColumn = (box: Rect, fromRight: boolean): number => {
      const candidates: number[] = [];
      for (let i = 2; i < box.w - 1; i++) candidates.push(fromRight ? box.x + box.w - 1 - i : box.x + i);
      for (const x of candidates) {
        const blocked = obstacles.some(
          (p) => p !== box && x >= p.x && x <= p.x + p.w - 1 && p.y + p.h > box.y + box.h && p.y <= belowY,
        );
        if (!blocked) return x;
      }
      return box.x + 2;
    };
    const exitX = freeColumn(from, false);
    const enterX = freeColumn(to, true);
    canvas.vline(exitX, from.y + from.h, belowY - 1, "│", token);
    canvas.set(exitX, belowY, "┘", token);
    canvas.hline(enterX + 1, exitX - 1, belowY, "─", token);
    canvas.set(enterX, belowY, "└", token);
    canvas.vline(enterX, to.y + to.h + 1, belowY - 1, "│", token);
    return { x: enterX, y: to.y + to.h, ch: "▴", token };
  }
  // 同列：垂直连接器
  const x = from.x + Math.min(4, from.w - 2);
  if (to.y > from.y) {
    canvas.vline(x, from.y + from.h, to.y - 2, "│", token);
    return { x, y: to.y - 1, ch: "▾", token };
  }
  canvas.vline(x, to.y + to.h + 1, from.y - 1, "│", token);
  return { x, y: to.y + to.h, ch: "▴", token };
}

/** R2 HIGH-1：锁定的包含层级绘为真实容器框
 *——工作组（双线边框，名称标签页）包裹席位容器（单线边框，
 * ▾名称标签页，标题命中区 → 钻取席位），后者包裹其智能体框。
 * 容器是背景（未保护填充）：边可路由穿过
 * 其内部；智能体框在顶部保持不透明+保护。 */
export function drawContainers(canvas: GraphCanvas, layout: GraphLayout, ctx: StyleContext): void {
  for (const c of layout.containers) {
    if (c.kind === "rig") {
      canvas.box(c.x, c.y, c.w, c.h, "accent", true, false);
      const tab = ` ▦ 工作组 ${c.name || ctx.rig} `; // round-3 工作组字形
      canvas.text(c.x + 2, c.y, tab, "accent", true);
      canvas.zone(c.y, c.x + 2, c.x + 2 + strWidth(tab), { type: "drill", resource: "rig", name: c.name || ctx.rig, target: { host: ctx.host } });
    } else {
      canvas.box(c.x, c.y, c.w, c.h, "chrome", false, false);
      const tab = ` ≡ ${c.name} `; // round-3 席位字形
      canvas.text(c.x + 1, c.y, tab, "accent", true);
      canvas.zone(c.y, c.x + 1, c.x + 1 + strWidth(tab), { type: "drill", resource: "pod", name: c.name, target: { host: ctx.host, rig: ctx.rig } });
    }
  }
}

export function renderHatchet(layout: GraphLayout, ctx: StyleContext, width: number): GraphCanvas {
  const canvas = new GraphCanvas(width);
  drawContainers(canvas, layout, ctx);
  // 然后边、智能体框（边框清理线端）、箭头最后
  const lanes = new Map<string, number>();
  const arrows: Arrow[] = [];
  for (const edge of layout.edges) {
    const from = layout.byId.get(edge.source);
    const to = layout.byId.get(edge.target);
    if (!from || !to) continue; // 诚实：到未知节点的边不绘为猜测
    const laneKey = `${to.x}:${to.x + to.w < from.x ? "back" : "fwd"}`;
    const lane = lanes.get(laneKey) ?? 0;
    lanes.set(laneKey, lane + 1);
    arrows.push(drawEdge(canvas, from, to, edge.label, lane, [...layout.placed, ...layout.containers.filter((c) => c.kind === "pod")]));
  }
  for (const p of layout.placed) drawNodeBox(canvas, p, ctx);
  for (const a of arrows) canvas.set(a.x, a.y, a.ch, a.token, true);
  drawClipIndicator(canvas, layout, width);
  return canvas;
}

/** MR8 宽度裁剪诚实：视图绝不静默丢失右侧节点——
 * 仅指示器（创建者范围：无滚动，无返工，无上限） */
export function drawClipIndicator(canvas: GraphCanvas, layout: GraphLayout, width: number): void {
  if (!layout.clipped) return;
  const label = " 内容已裁剪 ▸ ";
  canvas.text(Math.max(width - strWidth(label), 0), 0, label, "warn", true);
}
