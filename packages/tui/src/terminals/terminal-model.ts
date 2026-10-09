import type { DaemonClient } from "../daemon-client.js";
import type { ExplorerRow, FleetSnapshot, ViewState } from "../types.js";
import { wrapDetailLines, type ContentLine } from "../detail.js";
import { padEndW, clipW, strWidth } from "../text-width.js";

export interface TerminalEntry {
  view: string;
  name: string;
  kind: "saved" | "derived";
  members: string[];
  readinessUnverified?: boolean;
  ready: number;
  absent: number;
  degraded: number;
  pages: number;
}

export interface TerminalPreview {
  view: string;
  provider: string;
  planId: string;
  status: { available: boolean };
  composed: {
    id: string;
    pages: Array<Array<{ seat: string; label: string; readOnly: boolean; paneCommand: string }>>;
    opened: Array<{ seat: string }>;
    absent: Array<{ seat: string; reason: string }>;
    degraded: Array<{ seat: string; reason: string }>;
  };
  grids: Array<{ columns: number; rows: number; blanks: number }>;
}

export interface TerminalRead {
  catalog: TerminalEntry[];
  catalogLoaded?: boolean;
  preview: TerminalPreview | null;
  error?: string;
}

export async function readTerminals(client: DaemonClient, view?: string | null): Promise<TerminalRead> {
  const result: TerminalRead = { catalog: [], preview: null };
  try {
    const listing = await client.terminalViews();
    if (!Array.isArray(listing.saved) || !Array.isArray(listing.rigs)) throw new Error("无法读取终端名称。");
    result.catalog = [
      ...listing.saved.map(s => ({ view: `saved:${s.id}`, name: s.name, kind: "saved" as const, members: s.members.map(m => m.seat) })),
      ...listing.rigs.map(name => ({ view: `rig:${name}`, name, kind: "derived" as const, members: [] })),
    ].map(entry => ({ ...entry, readinessUnverified: true, ready: 0, absent: 0, degraded: 0, pages: 0 }));
    result.catalogLoaded = true;
    if (view) result.preview = await client.previewTerminal(view);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export function terminalExplorerRows(state: ViewState, snap: FleetSnapshot): ExplorerRow[] {
  if (!snap.terminals || (snap.terminals.error && !snap.terminals.catalogLoaded && !snap.terminals.catalog.length)) return [];
  const entries = snap.terminals.catalog;
  const rows: ExplorerRow[] = [];
  for (const kind of ["saved", "derived"] as const) {
    const key = `terminals:${kind}`;
    const open = kind === "saved" || state.expanded.includes(key) || !!state.filter;
    rows.push({ label: `  ${kind === "saved" ? "已保存" : `${open ? "▾" : "▸"} 派生`} (${entries.filter(e => e.kind === kind).length})`, key,
      action: kind === "saved" ? { type: "noop" } : { type: "toggle-expand", key } });
    if (!open) continue;
    for (const entry of entries.filter(e => e.kind === kind && `${e.name} ${e.members.join(" ")}`.toLowerCase().includes(state.filter.toLowerCase()))) {
      rows.push({ label: `    ${entry.name}${entry.readinessUnverified ? "" : ` · ${entry.ready}/${entry.members.length}`}`, key: `terminal:${entry.view}`, action: { type: "terminal-preview", view: entry.view } });
    }
  }
  return rows;
}

export function terminalLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  const read = snap.terminals;
  const lines: ContentLine[] = [{ text: "终端 · 已保存和派生视图" }];
  if (state.terminalResult && state.terminalResult.view === state.terminalView) lines.push({ text: `上次打开结果：${state.terminalResult!.message}` });
  if (!read) return [...lines, { text: "正在读取终端视图…" }];
  if (read.error) lines.push({ text: `不可用：${read.error}` });
  if (read.error && !read.catalogLoaded && !read.catalog.length) return wrapDetailLines(lines, width);
  const preview = read.preview?.view === state.terminalView ? read.preview : null;
  if (state.terminalView && !preview) {
    lines.push({ text: "返回终端视图", action: { type: "back" } });
    return wrapDetailLines(lines, width);
  }
  if (!preview) {
    lines.push({ text: "浏览和预览是被动的。仅打开创建 Herdr 空间。" });
    for (const kind of ["saved", "derived"] as const) {
      const entries = read.catalog.filter(e => e.kind === kind && `${e.name} ${e.members.join(" ")}`.toLowerCase().includes(state.filter.toLowerCase()));
      const open = kind === "saved" || state.expanded.includes("terminals:derived") || !!state.filter;
      lines.push({ text: "" }, { text: `${kind === "saved" ? "已保存" : `${open ? "▾" : "▸"} 派生`} · ${entries.length} 个视图`,
        ...(kind === "derived" ? { action: { type: "toggle-expand" as const, key: "terminals:derived" } } : {}) });
      if (!open) continue;
      if (!entries.length) lines.push({ text: kind === "saved" ? "无已保存视图。现有 terminal-views.yaml 存储成员，非自定义几何。" : "无可用派生工作组视图。" });
      for (const entry of entries) {
        lines.push({ text: `${entry.name} · ${entry.readinessUnverified ? (entry.kind === "saved" ? `${entry.members.length} 个已保存成员 · 预览就绪状态` : "预览成员和就绪状态") : `${entry.members.length} 个成员 · ${entry.ready} 个可附着 · ${entry.absent + entry.degraded} 个不可用 · ${entry.pages} 页`}`, action: { type: "terminal-preview", view: entry.view } });
        if (entry.kind === "saved") lines.push({ text: `  ${entry.members.join(", ") || "空视图"}` });
      }
    }
    return wrapDetailLines(lines, width);
  }

  const plan = preview.composed;
  const pageIndex = Math.min(Math.max(0, state.terminalPage ?? 0), Math.max(0, plan.pages.length - 1));
  const page = plan.pages[pageIndex] ?? [];
  const grid = preview.grids[pageIndex];
  lines.push({ text: plan.id }, { text: `${plan.opened.length} 个可附着 · ${plan.absent.length} 个缺失 · ${plan.degraded.length} 个降级` });
  // 动作先于图，使显式打开/返回在 80×24 仍可访问。
  lines.push({ text: "返回视图", action: { type: "back" } });
  if (preview.status.available && plan.opened.length) lines.push({ text: `在 Herdr 打开 · 全部 ${plan.pages.length} 页`, action: { type: "act", act: "open-terminal", view: preview.view, expectedPlan: preview.planId } });
  else lines.push({ text: preview.status.available ? "无可附着项；不会打开空间。" : "所选后台服务主机上 Herdr 不可用。在那里启动/连接 Herdr，然后刷新此预览。无自动恢复。" });
  lines.push({ text: "刷新预览", action: { type: "terminal-preview", view: preview.view } });
  if (plan.pages.length > 1) {
    if (pageIndex > 0) lines.push({ text: "上一页", action: { type: "terminal-page", page: pageIndex - 1 } });
    if (pageIndex + 1 < plan.pages.length) lines.push({ text: "下一页", action: { type: "terminal-page", page: pageIndex + 1 } });
  }
  lines.push({ text: `第 ${plan.pages.length ? pageIndex + 1 : 0}/${plan.pages.length} 页${grid ? ` · ${grid.columns} 列 × ${grid.rows} 行 · ${grid.blanks} 个填充单元格` : ""}` });
  if (grid) {
    const cellWidth = Math.max(4, Math.floor((width - 1) / grid.columns) - 1);
    const border = "+" + Array(grid.columns).fill("-".repeat(cellWidth)).join("+") + "+";
    lines.push({ text: border });
    for (let row = 0; row < grid.rows; row++) {
      const cells = Array.from({ length: grid.columns }, (_, col) => {
        const index = row * grid.columns + col;
        return padEndW(clipW(page[index] ? `${index + 1}${page[index]!.readOnly ? " 只读" : " 读写"}` : "空白", cellWidth), cellWidth);
      });
      lines.push({ text: "|" + cells.join("|") + "|" }, { text: border });
    }
  }
  page.forEach((member, index) => {
    lines.push({ text: `${index + 1}. ${member.label} · ${member.readOnly ? "只读" : "交互"}` }, { text: `   ${member.seat}${member.paneCommand.startsWith("ssh ") ? " · SSH 登录未验证；打开窗格将尝试连接" : ""}` });
  });
  lines.push({ text: "自动布局：等大单元格，每页最多 9 个成员。空白单元格填充不完整矩形。已保存视图仅存储成员；无自定义几何编辑器。" });
  for (const member of [...plan.absent, ...plan.degraded]) lines.push({ text: `不可用 · ${member.seat}：${member.reason}` });
  return wrapDetailLines(lines, width);
}
