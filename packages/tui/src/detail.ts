// 详情视图组件词汇表（创建者 round-2 指令）：每个详情页使用一种视觉
// 语言——批准 mock 的智能体规格框架是参考原语。仅纯层（ContentLine[]）；
// stylize 按这些约定绘制：
//   字段行     "  标签:      值"        → 置灰标签 / 亮色值
//   分区规则   "  ── 标题 ──────"       → 铬规则 / 亮色标题
//   列表项     "  ▪ 项"                 → 统一字形
//   链接       尾随 "(打开 ▸)"          → 唯一打开可用性
// 扫视测试是标准：相同事实类型，相同视觉位置，每个页面。
import type { Action } from "./types.js";
import type { Token } from "./theme.js";
import { strWidth } from "./text-width.js";

export interface ContentLine {
  text: string;
  action?: Action;
  zones?: Array<{ start: number; end: number; action: Action }>;
  /** 显式语义绘制段。其纯文本必须等于 `text`。 */
  segs?: Array<{ text: string; token?: Token; bold?: boolean; bg?: Token; inverse?: boolean }>;
}

/** 包装散文和完整引用而不丢失链接目标。图形/表格行
 *  保留自己的布局；调用方仅为详情页选择加入。 */
export function wrapDetailLines(lines: ContentLine[], width: number): ContentLine[] {
  const room = Math.max(8, width);
  // ContentLine 是一个逻辑终端行。YAML 块标量和当前
  // 源文件可能包含 CR/LF；绝不在物理行内发出这些。
  const logical = lines.flatMap((line) => line.text.split(/\r\n|\r|\n/).map((text, i) => ({
    ...line, text: text.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`),
    ...(i ? { action: undefined, zones: undefined, segs: undefined } : {}),
  })));
  return logical.flatMap((line) => {
    if (line.zones) return [line]; // 标签命中区域保留渲染器的现有裁剪规则
    if (line.text.startsWith("  ──") && strWidth(line.text.replace(/─+$/, "")) <= room) return [{ ...line, text: takeColumns(line.text, room) }];
    if (strWidth(line.text) <= room) return [line];
    const result: ContentLine[] = [];
    // 保持源扁平：在每一行前为剩余后缀加缩进会
    // 重复扁平化/复制一个大的不间断文件行。切片按终端列宽
    // 计算，避免中文双宽字符把下一条可点击行挤出视口。
    let remaining = line.text;
    let indent = "";
    while (remaining.length > 0) {
      const budget = Math.max(1, room - strWidth(indent));
      const prefix = takeColumns(remaining, budget);
      if (prefix.length === remaining.length) {
        result.push({ text: indent + remaining, ...(result.length === 0 && line.action ? { action: line.action } : {}) });
        break;
      }
      const space = prefix.lastIndexOf(" ");
      // `budget` 是终端列数，`space` 是字符串索引；词边界门槛也应按
      // 显示宽度判断。若首个字符本身比预算宽，仍强制消费一个码点。
      const cut = space >= 0 && strWidth(prefix.slice(0, space)) >= Math.floor(budget / 2)
        ? space
        : prefix.length || (remaining.codePointAt(0)! > 0xffff ? 2 : 1);
      result.push({ text: indent + prefix.slice(0, cut), ...(result.length === 0 && line.action ? { action: line.action } : {}) });
      remaining = remaining.slice(cut).replace(/^\s+/, "");
      indent = "    ";
    }
    return result;
  });
}

/** 返回不超过给定终端列数的完整 Unicode 字符前缀。 */
function takeColumns(text: string, width: number): string {
  let result = "";
  let used = 0;
  for (const char of text) {
    const charWidth = strWidth(char);
    if (used + charWidth > width) break;
    result += char;
    used += charWidth;
  }
  return result;
}

/** 固定标签列——每个详情页一种节奏 */
export const LABEL_W = 12;
const OPEN = "(打开 ▸)";

export interface Field {
  label: string;
  value: string;
  /** 点击行派发此动作（以标准可用性渲染） */
  link?: Action;
}

export interface Section {
  title?: string;
  fields?: Field[];
  /** 已遵循词汇表的预构建行（列表、表格） */
  lines?: ContentLine[];
}

function pad(text: string, width: number): string {
  const used = strWidth(text);
  return used >= width ? text : text + " ".repeat(width - used);
}

export function fieldLine(field: Field): ContentLine {
  const label = pad(`${field.label}:`, LABEL_W);
  const base = `  ${label} ${field.value}`;
  if (!field.link) return { text: base };
  return { text: `${base}  ${OPEN}`, action: field.link };
}

export function sectionRule(title: string, width = 96): ContentLine {
  const head = `  ── ${title} `;
  return { text: head + "─".repeat(Math.max(width - strWidth(head), 4)) };
}

export function listItem(text: string, link?: Action, indent = 2): ContentLine {
  const base = `${" ".repeat(indent)}▪ ${text}`;
  if (!link) return { text: base };
  return { text: `${base}  ${OPEN}`, action: link };
}

/** 组装详情页：一种间距节奏——每个分区规则前空一行，第一个内容块除外。 */
export function detailPage(heading: ContentLine, sections: Section[]): ContentLine[] {
  const lines: ContentLine[] = [heading];
  for (const section of sections) {
    const body: ContentLine[] = [];
    for (const field of section.fields ?? []) body.push(fieldLine(field));
    body.push(...(section.lines ?? []));
    if (body.length === 0) continue;
    lines.push({ text: "" });
    if (section.title) lines.push(sectionRule(section.title));
    lines.push(...body);
  }
  return lines;
}

/** 列表式页面的对齐列（needs-you, hosts-down）：扫视
 *  优势是固定列，而非破折号连缀。 */
export function alignedRow(cols: Array<[string, number]>, tail = ""): string {
  return cols.map(([text, width]) => pad(text, width)).join(" ") + tail;
}
