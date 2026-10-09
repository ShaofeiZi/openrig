// PULSE 视图渲染器（5.2 Wave B）。可复用、视图本地的行/分区/泳道
// 渲染器（计划 §crash-cart-pre-work：crash-cart 搭载这些）。以 TUI 惯用语
// 复现批准 mock 的结构/排序/强调——字形集
// ●/◌/⧗/▲/✓/○ 和分区措辞是契约；仅主题 token（无发明
// 颜色——⧗ 信息强调使用已解析 D4 信息 token，见 PULSE_INFO_TOKEN）。
import type { Token } from "../theme.js";
import type { Action } from "../types.js";
import { clipW, padEndW, strWidth } from "../text-width.js";
import type { PulseModel, PulseExceptionSection, PulseLane, PulseLaneRow } from "./pulse-model.js";

interface Seg { text: string; token?: Token; bold?: boolean; bg?: Token; inverse?: boolean }
interface Line { text: string; segs?: Seg[]; selected?: boolean }

/** 构建一个 Line，其纯 `text` 是其 segs 的拼接（捕获/宽度真相）。 */
function line(segs: Seg[], opts?: { selected?: boolean }): Line {
  return { text: segs.map((s) => s.text).join(""), segs, ...(opts?.selected ? { selected: true } : {}) };
}

// ── 顶部标签条：[ PULSE ] 表格 概览 图表 PULSE（PULSE 激活）──
export function renderPulseTabStrip(): Line {
  return line([
    { text: "[ PULSE ]", token: "dim" },
    { text: "  表格   概览   图表   " },
    // P2：mock 以粗体渲染激活标签。粗体需要颜色 token 才能在此
    // 管道中发出（仅粗体 seg 由 segRows 绘制器绘为纯——与
    // 异常主体同类的无操作类）；强调墨水 `bright` 承载它。
    { text: "PULSE", token: "bright", bold: true },
  ]);
}

// ── 异常分区：头（字形 标签 (n)）+ 其行 ──
export function renderExceptionSection(section: PulseExceptionSection): Line[] {
  // 延迟读取（暂停）：头不带 (n) 计数——伪造计数
  // 将虚假声称已运行连接——加一行暗"读取待处理"。
  if (section.pending) {
    return [
      line([{ text: `${section.glyph} ${section.label}`, token: section.token, bold: true }]),
      line([{ text: ` ${section.pending}`, token: "dim" }]),
    ];
  }
  const header = line([{ text: `${section.glyph} ${section.label} (${section.rows.length})`, token: section.token, bold: true }]);
  const rows = section.rows.map((r) =>
    line([
      { text: ` ${r.glyph} `, token: r.token },
      // 创建者选项 1：谁/什么主体以粗体引导（mock 的 <b>）。粗体
      // 需要颜色 token 才能在此管道中渲染（仅粗体 seg 绘为
      // 纯墨水），因此强调墨水 `bright` 承载它——详情（认领）
      // 保持纯，年龄（元数据）暗。
      { text: r.subject, token: "bright", bold: true },
      { text: r.claim },
      { text: r.meta, token: "dim" },
    ]),
  );
  return [header, ...rows];
}

// ── 三泳道分割：暗规则行然后固定宽度列 ──
const COL = [30, 26] as const; // 现在、刚完成内容宽度；下一个占其余
// 3 空格列间槽与内容垫分开保留，因此
// 它绝不在内容恰好填满其列的行上折叠（mock 的
// "✓ 14:02 slice-03 close-out" 恰好是 COL[1]）。renderLanes 将槽铺为
// 空格；规则行铺为连续虚线——相同步幅（COL[i] + 3）。
const LANE_GUTTER = "   ";

/** `── 现在 (n) ──… 刚完成 (n) ──… 下一个 (n) ──` 规则行（暗）。 */
export function renderLaneRule(lanes: [PulseLane, PulseLane, PulseLane]): Line {
  const seg = (label: string, count: number, w: number): string => {
    // 保留 (n) 后的空格；虚线在其后开始（mock："── 现在 (4) ───…"）。
    // 跨越内容宽度 + 槽，使虚线与列对齐。
    const head = `── ${label} (${count}) `;
    return head + "─".repeat(Math.max(0, w + strWidth(LANE_GUTTER) - strWidth(head)));
  };
  const text = seg(lanes[0].label, lanes[0].count, COL[0]) + seg(lanes[1].label, lanes[1].count, COL[1]) + `── ${lanes[2].label} (${lanes[2].count}) ` + "──────────";
  return line([{ text, token: "dim" }]);
}

function laneCell(row: PulseLaneRow | undefined, w: number): Seg[] {
  if (!row) return [{ text: padEndW("", w) }];
  const glyph = `${row.glyph} `;
  const time = row.time ? `${row.time} ` : "";
  // 将（可变）标签截断到单元格预算，使长真实标签绝不
  // 溢出并将下一列推出对齐——mock 的固定
  // 三泳道列是渲染契约。剪切以尾随
  // "…" 标记（诚实截断，非静默丢弃）；完整值保留在钻取中。
  const avail = Math.max(0, w - strWidth(glyph) - strWidth(time));
  const label = avail > 0 ? clipW(row.label, avail) : "";
  const segs: Seg[] = [{ text: glyph, token: row.token }];
  if (row.time) segs.push({ text: time, token: "dim" });
  segs.push({ text: label, token: row.time ? undefined : row.token === "ok" ? "dim" : row.token });
  // 将单元格垫到其内容宽度（纯尾随空格）；列间
  // 槽由 renderLanes 添加，因此即使 body === w 也保证。
  const pad = w - strWidth(glyph) - strWidth(time) - strWidth(label);
  if (pad > 0) segs.push({ text: " ".repeat(pad) });
  // 选择是按单元格的（incr-4）：选中的泳道行仅其单元格
  // 强调背景，绝非整个压缩终端行（跨越所有三泳道）——因此
  // 高亮命名一个实体，而非一行跨三列。incr-5 以
  // 相同方式添加新输出闪烁：仅此单元格上的反色（实时更新
  // 区域移动；兄弟保持平静）。选择（背景）和闪烁（反色）组合
  // 并在两者落在一个单元格上时保持视觉区分。
  if (!row.selected && !row.flashed) return segs;
  return segs.map((s) => ({
    ...s,
    ...(row.selected ? { bg: "accent" as const } : {}),
    ...(row.flashed ? { inverse: true as const } : {}),
  }));
}

// pulseLaneTargets 复用的内容单元格宽度，用于放置选择/命中跨度；
// 最后一泳道（下一个）占固定 40 列尾（见 renderLanes）。
const UP_NEXT_WIDTH = 40;

/** 将三泳道压缩成对齐列行（最大泳道长度）。选择
 *  携带在单个 PulseLaneRow 上（由 laneCell 按单元格绘制），非在
 *  行级，因此选中单元格仅高亮一个泳道。 */
export function renderLanes(lanes: [PulseLane, PulseLane, PulseLane]): Line[] {
  const rows = Math.max(...lanes.map((l) => l.rows.length));
  const out: Line[] = [];
  const gutter: Seg = { text: LANE_GUTTER };
  for (let i = 0; i < rows; i += 1) {
    const cells = [laneCell(lanes[0].rows[i], COL[0]), laneCell(lanes[1].rows[i], COL[1]), laneCell(lanes[2].rows[i], UP_NEXT_WIDTH)];
    // 槽保留在列之间（绝不在全宽行上折叠）；
    // 最后一列（下一个）不尾随槽。
    out.push(line([...cells[0]!, gutter, ...cells[1]!, gutter, ...cells[2]!]));
  }
  return out;
}

/** 一个可选泳道单元格：其在 renderPulseView 行列表中的位置，其
 *  泳道列的固定 x 跨度（1 基终端列），和钻取动作。 */
export interface PulseLaneTarget {
  lane: number; // 0=现在，1=刚完成，2=下一个
  row: number; // 该泳道行内索引
  lineIndex: number; // renderPulseView(model) 输出内 0 基行
  x1: number;
  x2: number;
  action: Action;
}

/** 列主序的可选泳道单元格（所有现在行，然后刚
 *  完成，然后下一个）——PULSE 选择用 ↑↓ 遍历的扁平域，每个
 *  映射到其在 renderPulseView 输出中的行索引和其泳道的固定
 *  列 x 跨度。无动作的行（"…" 溢出标记）被省略；它们
 *  不是实体。这是知道视图垂直布局的唯一点，
 *  因此 render.ts 绝不重新派生偏移计算。 */
export function pulseLaneTargets(model: PulseModel): PulseLaneTarget[] {
  const exceptionLines = model.exceptions.reduce((n, s) => n + renderExceptionSection(s).length, 0);
  // renderPulseView 布局：[标签条，空] + 异常 + [空，泳道规则] + 泳道行 + 页脚
  const laneStart = 2 + exceptionLines + 2;
  const g = LANE_GUTTER.length;
  const starts = [0, COL[0] + g, COL[0] + g + COL[1] + g]; // 每泳道单元格开始的文本列
  const widths = [COL[0], COL[1], UP_NEXT_WIDTH];
  const out: PulseLaneTarget[] = [];
  model.lanes.forEach((lane, li) =>
    lane.rows.forEach((row, ri) => {
      if (!row.action) return; // 溢出标记/无动作行不是目标
      out.push({ lane: li, row: ri, lineIndex: laneStart + ri, x1: starts[li]! + 1, x2: starts[li]! + widths[li]!, action: row.action });
    }),
  );
  return out;
}

export function renderPulseFooter(f: PulseModel["footer"]): Line {
  return line([{ text: `${f.active} 激活 · ${f.parked} 暂停 · ${f.waitingYou} 等待你 · ${f.updatedAgo}更新`, token: "dim" }]);
}

/** 整个 PULSE 视图（增量 1：来自 demoPulseModel 的静态）。上面可复用部分。 */
export function renderPulseView(model: PulseModel): Line[] {
  const out: Line[] = [renderPulseTabStrip(), { text: "" }];
  // 空分区由模型完全省略（空条即静默）；我们
  // 精确渲染存在的分区。
  for (const section of model.exceptions) out.push(...renderExceptionSection(section));
  out.push({ text: "" });
  out.push(renderLaneRule(model.lanes));
  out.push(...renderLanes(model.lanes));
  out.push(renderPulseFooter(model.footer));
  return out;
}
