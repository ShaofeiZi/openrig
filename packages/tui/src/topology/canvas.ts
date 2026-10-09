// SPIKE——图渲染样式的字符画布。每个单元格携带
// 可选语义 token；`plainLines()` 和 `paintedLines()` 从
// 相同单元格生成，因此 stripAnsi(painted) === plain 在构造上成立
//（已发布的 stylize 不变量，结构保持而非正则匹配）。
// 命中区在同一网格上以纯字符坐标记录。
import type { Style, Token } from "../theme.js";
import type { Action } from "../types.js";
import { padEndW, strWidth } from "../text-width.js";

interface Cell {
  ch: string;
  /** 宽字符后续占用的显示列；不输出字符。 */
  continuation?: boolean;
  /** 起始单元格占用的显示列数。 */
  width?: number;
  token?: Token;
  bold?: boolean;
  bg?: Token;
}

export interface CanvasZone {
  y: number; // 0 基画布行
  start: number; // 0 基 inclusive 列
  end: number; // exclusive
  action: Action;
}

export class GraphCanvas {
  private grid: Cell[][] = [];
  readonly zones: CanvasZone[] = [];

  constructor(readonly width: number) {}

  private row(y: number): Cell[] {
    while (this.grid.length <= y) this.grid.push([]);
    return this.grid[y]!;
  }

  set(x: number, y: number, ch: string, token?: Token, bold?: boolean, bg?: Token): void {
    const displayWidth = strWidth(ch);
    if (x < 0 || x >= this.width || y < 0 || displayWidth < 1 || x + displayWidth > this.width) return;
    const row = this.row(y);
    while (row.length < x + displayWidth) row.push({ ch: " " });
    // 清除与新字符重叠的旧宽字符，避免留下半个字符或悬空占位格。
    const clearAt = (column: number) => {
      let lead = column;
      while (lead > 0 && row[lead]?.continuation) lead--;
      const oldWidth = row[lead]?.width ?? 1;
      for (let i = lead; i < Math.min(this.width, lead + oldWidth); i++) row[i] = { ch: " " };
    };
    for (let i = x; i < x + displayWidth; i++) clearAt(i);
    row[x] = { ch, width: displayWidth, ...(token ? { token } : {}), ...(bold ? { bold } : {}), ...(bg ? { bg } : {}) };
    for (let i = 1; i < displayWidth; i++) {
      row[x + i] = { ch: "", continuation: true, ...(token ? { token } : {}), ...(bold ? { bold } : {}), ...(bg ? { bg } : {}) };
    }
  }

  /** 读取 (x, y) 处的纯字符——未设置时为 " " */
  charAt(x: number, y: number): string {
    return this.grid[y]?.[x]?.ch ?? " ";
  }

  text(x: number, y: number, text: string, token?: Token, bold?: boolean): void {
    let column = x;
    for (const ch of text) {
      this.set(column, y, ch, token, bold);
      column += strWidth(ch);
    }
  }

  hline(x1: number, x2: number, y: number, ch: string, token?: Token): void {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      // 盒绘交叉点：已存在的垂直运行变为 ┼
      const existing = this.charAt(x, y);
      this.set(x, y, existing === "│" ? "┼" : ch, token);
    }
  }

  vline(x: number, y1: number, y2: number, ch: string, token?: Token): void {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      const existing = this.charAt(x, y);
      this.set(x, y, existing === "─" ? "┼" : ch, token);
    }
  }

  private readonly protectedRects: Array<{ x: number; y: number; w: number; h: number }> = [];

  /** 当 (x, y) 位于已绘制框内（边框或内部）时为 true */
  isProtected(x: number, y: number): boolean {
    return this.protectedRects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  }

  /** 矩形边框，单线（─│┌┐└┘）或双线（═║╔╗╚╝）盒绘。
   *  完整矩形先清除并标记为保护：框是不透明的——
   *  早先绘制的边线绝不透过内部显示，子单元格
   * （盲文）通过绝不能在其内部打点。 */
  box(x: number, y: number, w: number, h: number, token?: Token, double = false, protect = true): void {
    for (let row = y; row < y + h; row++)
      for (let col = x; col < x + w; col++) this.set(col, row, " ");
    if (protect) this.protectedRects.push({ x, y, w, h });
    const [hz, vt, tl, tr, bl, br] = double ? ["═", "║", "╔", "╗", "╚", "╝"] : ["─", "│", "┌", "┐", "└", "┘"];
    this.hline(x + 1, x + w - 2, y, hz!, token);
    this.hline(x + 1, x + w - 2, y + h - 1, hz!, token);
    this.vline(x, y + 1, y + h - 2, vt!, token);
    this.vline(x + w - 1, y + 1, y + h - 2, vt!, token);
    this.set(x, y, tl!, token);
    this.set(x + w - 1, y, tr!, token);
    this.set(x, y + h - 1, bl!, token);
    this.set(x + w - 1, y + h - 1, br!, token);
  }

  zone(y: number, start: number, end: number, action: Action): void {
    // R2 c47219f1：命中区从与像素相同的视口裁剪真相派生——
    // 完全离屏区域不记录区（绝不键盘
    // 可选/可操作），部分可见的仅保留其可见的、
    // 鼠标可达范围。
    if (start >= this.width) return;
    this.zones.push({ y, start, end: Math.min(end, this.width), action });
  }

  get height(): number {
    return this.grid.length;
  }

  /** 每行 token 段——绘制层（stylize）用其
   *  Style 实例渲染这些；plain(segs) === plainLines()[y] 在构造上成立，因此
   *  已发布的 strip 不变量结构保持 */
  segLines(): Array<Array<{ text: string; token?: Token; bold?: boolean; bg?: Token }>> {
    return this.grid.map((row) => {
      const segs: Array<{ text: string; token?: Token; bold?: boolean; bg?: Token }> = [];
      const cells = [...row];
      while (cells.length < this.width) cells.push({ ch: " " });
      for (const cell of cells.slice(0, this.width)) {
        const last = segs.at(-1);
        if (last && last.token === cell.token && last.bold === cell.bold && last.bg === cell.bg) last.text += cell.ch;
        else segs.push({ text: cell.ch, ...(cell.token ? { token: cell.token } : {}), ...(cell.bold ? { bold: cell.bold } : {}), ...(cell.bg ? { bg: cell.bg } : {}) });
      }
      return segs;
    });
  }

  plainLines(): string[] {
    return this.grid.map((row) => padEndW(row.slice(0, this.width).map((cell) => cell.ch).join(""), this.width));
  }

  paintedLines(style: Style): string[] {
    return this.grid.map((row) => {
      let out = "";
      let run = "";
      let runToken: Token | undefined;
      let runBold: boolean | undefined;
      let runBg: Token | undefined;
      const flush = () => {
        if (run === "") return;
        out += runToken || runBg ? style.paint(runToken ?? "bright", run, { ...(runBold ? { bold: true } : {}), ...(runBg ? { bg: runBg } : {}) }) : run;
        run = "";
      };
      const cells = [...row];
      while (cells.length < this.width) cells.push({ ch: " " });
      for (const cell of cells.slice(0, this.width)) {
        if (cell.token !== runToken || cell.bold !== runBold || cell.bg !== runBg) {
          flush();
          runToken = cell.token;
          runBold = cell.bold;
          runBg = cell.bg;
        }
        run += cell.ch;
      }
      flush();
      return out;
    });
  }
}
