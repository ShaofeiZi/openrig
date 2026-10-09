// 显示宽度工具：处理终端中 CJK 宽字符占 2 列的问题。
// JavaScript 的 string.length 按 UTF-16 码元计数，不反映终端列宽。

/** 计算字符串在终端中的显示宽度。自动剥离 ANSI SGR 序列。 */
export function strWidth(s: string): number {
  // 先剥离 ANSI 转义序列（SGR 颜色等不占显示列）
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      // 补充平面中的 emoji 通常占 2 列。不要把 U+2600–U+27BF 的所有
      // 文本符号都算作双宽；例如状态字形 ✕ 在常用终端里占 1 列。
      (code >= 0x1f300 && code <= 0x1f6ff) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x1f700 && code <= 0x1f77f)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** 按显示宽度右填充空格，使总宽度等于 width 列。 */
export function padEndW(text: string, width: number): string {
  const w = strWidth(text);
  if (w >= width) return text;
  return text + " ".repeat(width - w);
}

/** 按显示宽度左填充空格。 */
export function padStartW(text: string, width: number): string {
  const w = strWidth(text);
  if (w >= width) return text;
  return " ".repeat(width - w) + text;
}

/** 按显示宽度截断，超出时末尾加省略号。SGR 控制序列整段原样保留（0 列），
 *  绝不能逐字符拆开——否则会把 `\x1b[31m` 截成半个序列泄漏到终端。
 *  实际行为：先判 `strWidth(text)<=width` 早返回原文（空串/纯 SGR/未超宽都走这里）；
 *  仅当文本超宽时才进入截断循环，此时若 width<=0 会立即中断并返回 "…"（输出占 1 列，
 *  历史边界，并非正确契约；调用方需自行保证 room>0，见 render-pulse 已判 avail>0）。
 *  只承诺 SGR 控制序列整体 + BMP 内 CJK 码点，不泛化所有 ANSI 转义。 */
export function clipW(text: string, width: number): string {
  if (strWidth(text) <= width) return text;
  const sgr = /\x1b\[[0-9;]*m/g;
  let w = 0;
  let result = "";
  let i = 0;
  while (i < text.length) {
    sgr.lastIndex = i;
    const m = sgr.exec(text);
    if (m && m.index === i) {
      result += m[0]; // 整个 SGR 序列，不占列、不可截断
      i += m[0].length;
      continue;
    }
    const ch = text.codePointAt(i)!;
    const chStr = String.fromCodePoint(ch);
    const cw = strWidth(chStr);
    if (w + cw > width - 1) break;
    result += chStr;
    w += cw;
    i += chStr.length;
  }
  return result + "…";
}

/** 丢弃字符串开头指定数量的终端显示列，用于从整屏行中提取窗格内容。
 *  SGR 转义序列整段保留（不占列、也不随丢弃被切掉，颜色状态须延续）；
 *  双宽字符不拆：若下一字符会越过 width 则停止，与无 SGR 路径逐字一致。 */
export function dropW(text: string, width: number): string {
  if (width <= 0) return text;
  const sgr = /\x1b\[[0-9;]*m/g;
  let used = 0;
  let i = 0;
  let prefix = ""; // 落在丢弃区内的 SGR 需保留，不能被 slice 切掉
  while (i < text.length) {
    sgr.lastIndex = i;
    const m = sgr.exec(text);
    if (m && m.index === i) {
      prefix += m[0]; // 颜色序列：保留，不计列
      i += m[0].length;
      continue;
    }
    const chStr = String.fromCodePoint(text.codePointAt(i)!);
    const cw = strWidth(chStr);
    if (used + cw > width) break; // 不越界才丢弃，保持原双宽不拆语义
    used += cw;
    i += chStr.length;
    if (used === width) break;
  }
  return prefix + text.slice(i);
}

/** 返回指定终端显示列对应的 UTF-16 字符串索引。
 *  SGR 序列占用字符串索引但不占显示列（定位标记时不能把转义字节算成列）。 */
export function columnIndex(text: string, column: number): number {
  if (column <= 0) return 0;
  const sgr = /\x1b\[[0-9;]*m/g;
  let used = 0;
  let i = 0;
  while (i < text.length) {
    if (used >= column) break;
    sgr.lastIndex = i;
    const m = sgr.exec(text);
    if (m && m.index === i) {
      i += m[0].length; // 占索引、不占列
      continue;
    }
    const chStr = String.fromCodePoint(text.codePointAt(i)!);
    used += strWidth(chStr);
    i += chStr.length;
  }
  return i;
}
