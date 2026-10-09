// S19 MR2（§A2+§A4，创建者指导）——TUI 渲染与 Web UI 相同的运行时
// 标记，而非表亲。记录的身份是
// packages/ui/src/components/graphics/RuntimeMark.tsx：clawd = 16x16
// crispEdges 像素网格（主体 #ad6755，眼睛 #181818）；Codex = `>_`
// 提示符标记；终端 = 暗色单元格上的 `>_`。此模块从该网格派生单元格
// 艺术（矩形列表下面 1:1 转录）——绝非重设计。
//
// 颜色：标记需要 Web 的确切 RGB，因此主题获得标记 token
//（truecolor 精确；256 最近；16 色值 = 占位符待
// 创建者降级回退选择——在 mr7 包中携带，不静默
// 决定）。
import type { Token } from "../theme.js";

/** RuntimeMark.tsx 矩形列表，已转录 (x, y, w, h) */
const CLAWD_BODY_RECTS: Array<[number, number, number, number]> = [
  [3, 2, 10, 8], // 主体
  [1, 5, 2, 3], // 左臂
  [13, 5, 2, 3], // 右臂
  [4, 10, 2, 3], // 腿
  [7, 10, 2, 3],
  [10, 10, 2, 3],
];
const CLAWD_EYE_RECTS: Array<[number, number, number, number]> = [
  [5, 4, 1, 2],
  [10, 4, 1, 2],
];

export type ClawdPixel = 0 | 1 | 2; // 0 空 · 1 主体 · 2 眼睛

/** 16x16 像素矩阵，从矩形列表派生（行优先） */
export function clawdGrid(): ClawdPixel[][] {
  const g: ClawdPixel[][] = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => 0 as ClawdPixel));
  for (const [x, y, w, h] of CLAWD_BODY_RECTS)
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) g[r]![c] = 1;
  for (const [x, y, w, h] of CLAWD_EYE_RECTS)
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) g[r]![c] = 2;
  return g;
}

export interface MarkSeg {
  text: string;
  token?: Token;
  bold?: boolean;
  /** 下半/另一半不同的半/象限单元格的背景 token */
  bg?: Token;
}

/** 忠实形式——16 单元格 x 8 行半块（▀ 用 fg 绘制顶部像素
 *  用 bg 绘制底部）：详情面板/原型比例。 */
export function clawdFaithfulRows(): MarkSeg[][] {
  const g = clawdGrid();
  const rows: MarkSeg[][] = [];
  for (let r = 0; r < 16; r += 2) {
    const segs: MarkSeg[] = [];
    for (let c = 0; c < 16; c++) {
      const top = g[r]![c]!;
      const bot = g[r + 1]![c]!;
      const tok = (p: ClawdPixel): Token | undefined => (p === 1 ? "clawd" : p === 2 ? "clawdEye" : undefined);
      if (top === 0 && bot === 0) segs.push({ text: " " });
      else if (top === bot) segs.push({ text: "█", token: tok(top) });
      else if (top === 0) segs.push({ text: "▄", token: tok(bot) });
      else if (bot === 0) segs.push({ text: "▀", token: tok(top) });
      else segs.push({ text: "▀", token: tok(top), bg: tok(bot) });
    }
    rows.push(segs);
  }
  return rows;
}

/** 象限块降采样：16x16 网格 → cols x rows 单元格，每个单元格
 *  一个 2x2 象限，其象限是其源区域主体覆盖的多数投票。
 *  可证明网格派生（防护发现 4）——迷你形式
 *  是此函数的输出，绝非手挑字形。诚实限制：
 *  1px 眼睛在这些比例下低于多数阈值并消失——该
 *  保真事实是 mr7 包的一部分，不隐藏。 */
const QUADRANT_CHARS: Record<number, string> = {
  0b0000: " ", 0b0001: "▗", 0b0010: "▖", 0b0011: "▄", 0b0100: "▝", 0b0101: "▐",
  0b0110: "▞", 0b0111: "▟", 0b1000: "▘", 0b1001: "▚", 0b1010: "▌", 0b1011: "▙",
  0b1100: "▀", 0b1101: "▜", 0b1110: "▛", 0b1111: "█",
};

export function clawdDownsample(cols: number, rows: number): MarkSeg[][] {
  const g = clawdGrid();
  const cellW = 16 / cols;
  const cellH = 16 / rows;
  const covered = (x0: number, y0: number, x1: number, y1: number): boolean => {
    let body = 0;
    let total = 0;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        total++;
        if (g[y]![x]! !== 0) body++;
      }
    return total > 0 && body * 2 >= total; // 多数投票
  };
  const out: MarkSeg[][] = [];
  for (let r = 0; r < rows; r++) {
    const segs: MarkSeg[] = [];
    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;
      const y0 = r * cellH;
      const bits =
        (covered(x0, y0, x0 + cellW / 2, y0 + cellH / 2) ? 0b1000 : 0) |
        (covered(x0 + cellW / 2, y0, x0 + cellW, y0 + cellH / 2) ? 0b0100 : 0) |
        (covered(x0, y0 + cellH / 2, x0 + cellW / 2, y0 + cellH) ? 0b0010 : 0) |
        (covered(x0 + cellW / 2, y0 + cellH / 2, x0 + cellW, y0 + cellH) ? 0b0001 : 0);
      const ch = QUADRANT_CHARS[bits]!;
      segs.push(ch === " " ? { text: " " } : { text: ch, token: "clawd" });
    }
    out.push(segs);
  }
  return out;
}

/** 创建者 round-2 设计（2026-08-04 通过 pm-lead）：行标记是扁平
 *  claude 陶土色块，带两个短暗色垂直眼条居中——
 *  无四肢/腿；颜色 + 面在 2 单元格大小就是标记。精确源
 *  值：主体 #ad6755，眼睛 #181818（RuntimeMark.tsx）。 */
export function clawdFounderMark(): MarkSeg[] {
  // 被 clawdSquareMark 取代（round-3：宽矩形居中束被拒）；
  // 仅为决策记录血统保留
  return [
    { text: "╹", token: "clawdEye", bg: "clawd" },
    { text: "╹", token: "clawdEye", bg: "clawd" },
  ];
}

/** PICKS-V4 clawd 行标记（创建者修正，PICKS-OF-RECORD sha256-16
 *  14afeb74，2026-08-04——锁定方眼方向内的有界细化）：眼睛
 *  字面是字符 `><`——左眼 `>`，
 *  右眼 `<`，指向内，斜眼（参考 image-cache 102）。
 *  创建者理由原文：远边缘的眼睛读起来不像眼睛；
 *  内向尖括号使其读起来像一张脸。暗色 #181818 眼睛在
 *  #ad6755 陶土场上，不变。（血统：round-4 发布了 ▘▝
 *  外象限对；被此修正取代。） */
export function clawdSquareMark(): MarkSeg[] {
  return [
    { text: ">", token: "clawdEye", bg: "clawd" },
    { text: "<", token: "clawdEye", bg: "clawd" },
  ];
}

/** ROUND-3 codex 蓝色提示候选——在 picks v4 选定（14afeb74）：
 *  仅尖括号，仅在详情/拓扑表面（创建者委托；pm-lead
 *  裁决最克制选项）。codexMark() 下面现在发布尖括号
 *  形式；此记录为决策血统保留呈现的变体。每个
 *  变体使用官方采样 #6867aa（token codexBlue），绝不
 *  记忆值。 */
export function codexHintVariants(): Record<"chevron" | "outline" | "none", MarkSeg[]> {
  return {
    none: codexMark(),
    chevron: [
      { text: ">", token: "codexBlue", bold: true },
      { text: "_", token: "markInk", bold: true },
    ],
    outline: [
      { text: "▕", token: "codexBlue" },
      { text: ">", token: "markInk", bold: true },
      { text: "_", token: "markInk", bold: true },
      { text: "▏", token: "codexBlue" },
    ],
  };
}

/** mr7 选择的行标记候选——两者都是降采样输出 */
export function clawdMiniA(): MarkSeg[] {
  return clawdDownsample(2, 1)[0]!;
}

export function clawdMiniB(): MarkSeg[] {
  return clawdDownsample(3, 1)[0]!;
}

/** Codex：带 PICKS-V4 仅尖括号蓝色提示的 `>_` 提示符标记
 *（项 a，14afeb74）：`>` 携带官方采样 #6867aa；`_`
 *  保持浅色墨水。文本保持 exactly ASCII `>_`（Web 身份：相同
 *  标记，非表亲；❯ 保持否决）。此标记仅在详情 +
 *  拓扑表面渲染——资源管理器不携带标记（锁定）。 */
export function codexMark(): MarkSeg[] {
  return [
    { text: ">", token: "codexBlue", bold: true },
    { text: "_", token: "markInk", bold: true },
  ];
}

/** 终端/tty 运行时：暗色单元格 + 白色 `>_`——同族，反转。 */
export function terminalMark(): MarkSeg[] {
  return [
    { text: ">", token: "bright", bg: "markBg", bold: true },
    { text: "_", token: "bright", bg: "markBg", bold: true },
  ];
}

/** 服务端运行时字符串的行级标记（占位符安全默认：
 *  claude 用 miniA 直到创建者选择落地——交换点，单站点） */
export function runtimeMarkSegs(runtime: string | null | undefined): MarkSeg[] {
  const r = (runtime ?? "").toLowerCase();
  if (r.startsWith("claude")) return clawdSquareMark(); // round-3 锁方形
  if (r.startsWith("codex")) return codexMark();
  if (r === "terminal" || r === "tty" || r.startsWith("external")) return terminalMark();
  // 未知运行时：诚实文本 token，置暗——绝不伪造标记
  return [{ text: "?", token: "dim" }];
}

/** 标记的纯文本宽度（所有标记都是单单元格字形） */
export function markText(segs: MarkSeg[]): string {
  return segs.map((s) => s.text).join("");
}
