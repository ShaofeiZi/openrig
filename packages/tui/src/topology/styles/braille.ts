// SPIKE——`--style braille`：可选平滑端（TIER-2，现代
// 终端）。与 Hatchet 主线相同的盒装节点；边以 2×4
// 子单元格分辨率绘为盲文点运行。被创建者细化
// 降级为可选样式——已证明的 TIER-1 回退就是 renderHatchet（相同
// 布局，盒绘边），因此降级失去平滑度，绝不失去含义。
import { GraphCanvas } from "../canvas.js";
import { edgeToken } from "../glyphs.js";
import type { GraphLayout } from "../layout.js";
import type { StyleContext } from "./hatchet.js";
import { drawClipIndicator, drawContainers, drawNodeBox, renderHatchet } from "./hatchet.js";
import type { Token } from "../../theme.js";

// 盲文点位按 (subCol 0-1, subRow 0-3)
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const;

class BrailleField {
  private cells = new Map<string, { bits: number; token: Token }>();

  setDot(px: number, py: number, token: Token): void {
    const cellX = Math.floor(px / 2);
    const cellY = Math.floor(py / 4);
    const key = `${cellX},${cellY}`;
    const bits = DOT_BITS[px % 2]![py % 4]!;
    const existing = this.cells.get(key);
    this.cells.set(key, { bits: (existing?.bits ?? 0) | bits, token: existing?.token ?? token });
  }

  line(x1: number, y1: number, x2: number, y2: number, token: Token): void {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let i = 0; i <= steps; i++) {
      this.setDot(Math.round(x1 + ((x2 - x1) * i) / steps), Math.round(y1 + ((y2 - y1) * i) / steps), token);
    }
  }

  blit(canvas: GraphCanvas): void {
    for (const [key, cell] of this.cells) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      if (canvas.charAt(x, y) !== " " || canvas.isProtected(x, y)) continue; // 绝不给框/文字打点
      canvas.set(x, y, String.fromCharCode(0x2800 + cell.bits), cell.token);
    }
  }
}

export function renderBraille(layout: GraphLayout, ctx: StyleContext, width: number, tier1Fallback: boolean): GraphCanvas {
  if (tier1Fallback) return renderHatchet(layout, ctx, width); // 已证明的回退路径
  // 绘制顺序 = hatchet 语义（pm 回扣：不透明度必须是类
  // 不变量，绝非绘制顺序伪影）：(1) 盒绘边运行先，
  // (2) 不透明框清除任何穿过段，(3) 盲文字段
  // 最后 blit 但感知保护单元格，(4) 箭头最后。
  const canvas = new GraphCanvas(width);
  drawContainers(canvas, layout, ctx);
  const field = new BrailleField();
  const arrows: Array<{ x: number; y: number; ch: string; token: ReturnType<typeof edgeToken> }> = [];
  for (const edge of layout.edges) {
    const from = layout.byId.get(edge.source);
    const to = layout.byId.get(edge.target);
    if (!from || !to) continue;
    const token = edgeToken(edge.label);
    const rightward = to.x > from.x;
    const txCell = rightward ? to.x - 1 : to.x + to.w;
    if (from.y === to.y) {
      // 净框细化：水平直线已经直——
      // 盒绘 ─ 与箭头中单元格对齐（盲文 ⠤ 位置低
      // 并使连接点扭结）；盲文仅在对角线上发挥作用。
      const [x1, x2] = rightward ? [from.x + from.w, txCell - 1] : [txCell + 1, from.x - 1];
      canvas.hline(x1, x2, from.y + 1, "─", token);
    } else {
      const sx = (rightward ? from.x + from.w : from.x - 1) * 2;
      const sy = (from.y + 1) * 4 + 2;
      const tx = txCell * 2 + (rightward ? 0 : 1);
      const ty = (to.y + 1) * 4 + 2;
      field.line(sx, sy, tx, ty, token);
    }
    arrows.push({ x: txCell, y: to.y + 1, ch: rightward ? "▸" : "◂", token });
  }
  for (const p of layout.placed) drawNodeBox(canvas, p, ctx);
  field.blit(canvas); // 感知保护：绝不给框单元格打点
  for (const a of arrows) if (!canvas.isProtected(a.x, a.y)) canvas.set(a.x, a.y, a.ch, a.token, true);
  drawClipIndicator(canvas, layout, width);
  canvas.text(2, canvas.height + 1, "盲文子单元格边 · TIER-2（现代终端）· 回退 = hatchet 盒绘", "dim");
  return canvas;
}
