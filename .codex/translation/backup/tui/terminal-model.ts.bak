import type { DaemonClient } from "../daemon-client.js";
import type { ExplorerRow, FleetSnapshot, ViewState } from "../types.js";
import { wrapDetailLines, type ContentLine } from "../detail.js";

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
    if (!Array.isArray(listing.saved) || !Array.isArray(listing.rigs)) throw new Error("Terminal names could not be read.");
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
    rows.push({ label: `  ${kind === "saved" ? "Saved" : `${open ? "▾" : "▸"} Derived`} (${entries.filter(e => e.kind === kind).length})`, key,
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
  const lines: ContentLine[] = [{ text: "TERMINALS · Saved and Derived views" }];
  if (state.terminalResult && state.terminalResult.view === state.terminalView) lines.push({ text: `Last Open result: ${state.terminalResult!.message}` });
  if (!read) return [...lines, { text: "Reading terminal views…" }];
  if (read.error) lines.push({ text: `Unavailable: ${read.error}` });
  if (read.error && !read.catalogLoaded && !read.catalog.length) return wrapDetailLines(lines, width);
  const preview = read.preview?.view === state.terminalView ? read.preview : null;
  if (state.terminalView && !preview) {
    lines.push({ text: "Back to terminal views", action: { type: "back" } });
    return wrapDetailLines(lines, width);
  }
  if (!preview) {
    lines.push({ text: "Browse and preview are passive. Only Open creates a Herdr space." });
    for (const kind of ["saved", "derived"] as const) {
      const entries = read.catalog.filter(e => e.kind === kind && `${e.name} ${e.members.join(" ")}`.toLowerCase().includes(state.filter.toLowerCase()));
      const open = kind === "saved" || state.expanded.includes("terminals:derived") || !!state.filter;
      lines.push({ text: "" }, { text: `${kind === "saved" ? "Saved" : `${open ? "▾" : "▸"} Derived`} · ${entries.length} views`,
        ...(kind === "derived" ? { action: { type: "toggle-expand" as const, key: "terminals:derived" } } : {}) });
      if (!open) continue;
      if (!entries.length) lines.push({ text: kind === "saved" ? "No saved views. Existing terminal-views.yaml stores membership, not custom geometry." : "No derived rig views available." });
      for (const entry of entries) {
        lines.push({ text: `${entry.name} · ${entry.readinessUnverified ? (entry.kind === "saved" ? `${entry.members.length} saved members · Preview readiness` : "Preview members and readiness") : `${entry.members.length} members · ${entry.ready} attachable · ${entry.absent + entry.degraded} unavailable · ${entry.pages} pages`}`, action: { type: "terminal-preview", view: entry.view } });
        if (entry.kind === "saved") lines.push({ text: `  ${entry.members.join(", ") || "Empty view"}` });
      }
    }
    return wrapDetailLines(lines, width);
  }

  const plan = preview.composed;
  const pageIndex = Math.min(Math.max(0, state.terminalPage ?? 0), Math.max(0, plan.pages.length - 1));
  const page = plan.pages[pageIndex] ?? [];
  const grid = preview.grids[pageIndex];
  lines.push({ text: plan.id }, { text: `${plan.opened.length} attachable · ${plan.absent.length} absent · ${plan.degraded.length} degraded` });
  // Actions precede the diagram so explicit Open/Back remain accessible at 80×24.
  lines.push({ text: "Back to views", action: { type: "back" } });
  if (preview.status.available && plan.opened.length) lines.push({ text: `Open in Herdr · all ${plan.pages.length} pages`, action: { type: "act", act: "open-terminal", view: preview.view, expectedPlan: preview.planId } });
  else lines.push({ text: preview.status.available ? "Nothing attachable; no space will be opened." : "Herdr unavailable on the selected daemon host. Start/connect Herdr there, then refresh this preview. No automatic recovery." });
  lines.push({ text: "Refresh preview", action: { type: "terminal-preview", view: preview.view } });
  if (plan.pages.length > 1) {
    if (pageIndex > 0) lines.push({ text: "Previous page", action: { type: "terminal-page", page: pageIndex - 1 } });
    if (pageIndex + 1 < plan.pages.length) lines.push({ text: "Next page", action: { type: "terminal-page", page: pageIndex + 1 } });
  }
  lines.push({ text: `Page ${plan.pages.length ? pageIndex + 1 : 0}/${plan.pages.length}${grid ? ` · ${grid.columns} columns × ${grid.rows} rows · ${grid.blanks} filler cells` : ""}` });
  if (grid) {
    const cellWidth = Math.max(4, Math.floor((width - 1) / grid.columns) - 1);
    const border = "+" + Array(grid.columns).fill("-".repeat(cellWidth)).join("+") + "+";
    lines.push({ text: border });
    for (let row = 0; row < grid.rows; row++) {
      const cells = Array.from({ length: grid.columns }, (_, col) => {
        const index = row * grid.columns + col;
        return (page[index] ? `${index + 1}${page[index]!.readOnly ? " RO" : " RW"}` : "blank").padEnd(cellWidth);
      });
      lines.push({ text: "|" + cells.join("|") + "|" }, { text: border });
    }
  }
  page.forEach((member, index) => {
    lines.push({ text: `${index + 1}. ${member.label} · ${member.readOnly ? "read-only" : "interactive"}` }, { text: `   ${member.seat}${member.paneCommand.startsWith("ssh ") ? " · SSH login unverified; opened pane will attempt connection" : ""}` });
  });
  lines.push({ text: "Auto-layout: equal cells, at most 9 members per page. Blank cells fill incomplete rectangles. Saved views store membership only; no custom geometry editor." });
  for (const member of [...plan.absent, ...plan.degraded]) lines.push({ text: `Unavailable · ${member.seat}: ${member.reason}` });
  return wrapDetailLines(lines, width);
}
