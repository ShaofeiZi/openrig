import { wrapDetailLines, type ContentLine } from "../detail.js";
import type { Screen, ViewState } from "../types.js";
import { filterPalette } from "./palette.js";
import { COMMAND_REGISTRY } from "./registry.js";
import { padEndW, clipW, strWidth } from "../text-width.js";

/** 帮助是命令面板的可读界面；执行仍走注册表。 */
export function helpScreen(palette: NonNullable<ViewState["palette"]>, context: string, cols: number, rows: number): Screen {
  const matches = filterPalette(palette.query, COMMAND_REGISTRY, context);
  const selection = Math.min(palette.selection, Math.max(0, matches.length - 1));
  const selected = matches[selection];
  const content: ContentLine[] = [
    { text: `help ▸ ${palette.query}▊  · 输入以查找命令` },
    { text: "帮助 · 命令栏、常用任务与 CLI" },
    ...wrapDetailLines([
      { text: "在 cmd ▸ 输入后按回车；Tab 补全。<arg> 必填，[arg] 可选。" },
      { text: "终端中的 CLI：zrig --help · zrig <command> --help · zrig tui commands" },
      { text: "终端中的故障诊断：zrig doctor · zrig doctor --help" },
      { text: "启动页：? 帮助 · w 跳过 · L 本地 · d 详情。Esc 从帮助返回。" },
      { text: "跳过后：S 返回启动页；L 本地读取。未连接/未验证状态下无需恢复即可阅读帮助。" },
    ], cols),
    { text: "" },
  ];
  const detail = selected ? wrapDetailLines([
    { text: selected.available ? selected.entry.description : `此处不可用：${selected.reason}。${selected.entry.description}` },
    { text: `示例：${selected.entry.sample}${selected.entry.aliases.length ? ` · 别名：${selected.entry.aliases.join(", ")}` : ""}` },
  ], cols) : [{ text: "无匹配命令。退格编辑搜索；Esc 返回。" }];
  // 在计算列表行数前预留指南、所选命令描述和页脚的位置。
  const count = Math.max(1, rows - content.length - detail.length - 3);
  const start = Math.max(0, selection - count + 1);
  for (let i = start; i < Math.min(matches.length, start + count); i++) {
    const row = matches[i]!;
    const text = clipW(`${i === selection ? "›" : " "} ${row.entry.name}${row.entry.args ? " " + row.entry.args : ""}${row.available ? "" : " · 此处不可用"}`, cols);
    content.push({ text, segs: [{ text, token: row.available ? "bright" : "dim", ...(i === selection ? { bg: "selection" as const, bold: true } : {}) }] });
  }
  content.push({ text: "" }, ...detail);
  while (content.length < rows - 2) content.push({ text: "" });
  content.push({ text: "↑↓ 浏览 · 回车 运行/填充参数 · Esc 返回" },
    { text: `${matches.length ? selection + 1 : 0}/${matches.length} 个命令 · ${context} · 搜索名称或别名` });
  const segRows: NonNullable<Screen["segRows"]> = {};
  content.forEach((line, i) => {
    if (line.segs) segRows[i + 1] = [{ ...line.segs[0], text: clipW(line.text, cols) }];
  });
  return { lines: content.slice(0, rows).map(l => padEndW(clipW(l.text, cols), cols)), segRows,
    explorerWidth: 0, explorerRows: [], hitMap: [], contentTargets: [], contentMaxOffset: 0 };
}
