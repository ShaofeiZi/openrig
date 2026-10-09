// 0.3.1 slice 06——供类型布局和围栏块渲染器使用的空间原语。遵循 zrig vellum 令牌，
// 不使用 Thariq 色板字面量；除 12px 状态圆点外均为直角；按
// project_v1_professional_grade_ship_gate 采用战术制图美学。

import type {
  TimelineEntry,
  TimelineStatus,
  StatsEntry,
  RiskTableEntry,
  RiskLevel,
  CompareRow,
} from "./storytelling-primitives.js";

// -----------------------------------------------------------------------------
// 状态 → 令牌映射（原语间共享）
// -----------------------------------------------------------------------------

const STATUS_TOKENS: Record<TimelineStatus, { dot: string; ink: string; label: string }> = {
  success: { dot: "bg-emerald-600", ink: "text-emerald-800", label: "成功" },
  warning: { dot: "bg-amber-500", ink: "text-amber-800", label: "警告" },
  danger:  { dot: "bg-red-600",    ink: "text-red-800",    label: "危险" },
  info:    { dot: "bg-sky-600",    ink: "text-sky-800",    label: "信息" },
  muted:   { dot: "bg-outline",  ink: "text-on-surface",  label: "静默" },
};

const RISK_TOKENS: Record<RiskLevel, { ink: string; label: string }> = {
  low:  { ink: "text-emerald-800", label: "低" },
  med:  { ink: "text-amber-800",   label: "中" },
  high: { ink: "text-red-800",     label: "高" },
};

// -----------------------------------------------------------------------------
// TLDRSlate——深色 vellum 板，位于类型布局顶部
// -----------------------------------------------------------------------------

export function TLDRSlate({ children, testId = "primitive-tldr-slate" }: { children: React.ReactNode; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="my-4 border border-on-surface bg-inverse-surface px-4 py-3 text-[12px] leading-relaxed text-background hard-shadow"
    >
      <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.18em] text-on-surface-variant">摘要</div>
      <div>{children}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// DotTimeline——用于有序事件的纵向圆点加连线轨迹
// -----------------------------------------------------------------------------

export function DotTimeline({ entries, testId = "primitive-dot-timeline" }: { entries: TimelineEntry[]; testId?: string }) {
  if (entries.length === 0) return null;
  return (
    <ol data-testid={testId} className="my-4 list-none space-y-0 border-l border-outline-variant pl-0">
      {entries.map((e, i) => {
        const tokens = STATUS_TOKENS[e.status];
        const isLast = i === entries.length - 1;
        return (
          <li key={i} className="relative pl-9 pb-4" data-testid={`primitive-dot-timeline-entry-${i}`}>
            {!isLast && (
              <div className="absolute left-[13px] top-6 bottom-0 w-px bg-outline-variant" aria-hidden="true" />
            )}
            <div
              className={`absolute left-[7px] top-2 h-3 w-3 rounded-full border border-outline-variant ${tokens.dot}`}
              data-status={e.status}
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
              <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface-variant">{e.time}</span>
              <span className={`font-mono text-[8px] uppercase tracking-[0.12em] ${tokens.ink}`}>{tokens.label}</span>
            </div>
            <div className="mt-1 text-[12px] font-semibold text-on-surface">{e.title}</div>
            {e.body && <div className="mt-1 text-[11px] leading-relaxed text-on-surface">{e.body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

// -----------------------------------------------------------------------------
// StatCardBand——由标签/值/趋势卡片组成的横向行
// -----------------------------------------------------------------------------

const TREND_GLYPH = { up: "↑", flat: "—", down: "↓" } as const;
const TREND_INK = { up: "text-emerald-700", flat: "text-on-surface-variant", down: "text-red-700" } as const;

export function StatCardBand({ entries, testId = "primitive-stat-card-band" }: { entries: StatsEntry[]; testId?: string }) {
  if (entries.length === 0) return null;
  return (
    <div data-testid={testId} className="my-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {entries.map((e, i) => (
        <div
          key={i}
          data-testid={`primitive-stat-card-${i}`}
          className="border border-outline-variant bg-surface-lowest/45 px-3 py-2 hard-shadow"
        >
          <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-on-surface-variant">{e.label}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[18px] font-bold text-on-surface">{e.value}</span>
            {e.trend && (
              <span className={`font-mono text-[10px] ${TREND_INK[e.trend]}`} data-trend={e.trend}>
                {TREND_GLYPH[e.trend]}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// RiskTableGrid——风险 × 概率 × 影响 × 缓解措施网格
// -----------------------------------------------------------------------------

export function RiskTableGrid({ entries, testId = "primitive-risk-table-grid" }: { entries: RiskTableEntry[]; testId?: string }) {
  if (entries.length === 0) return null;
  return (
    <div data-testid={testId} className="my-4 overflow-x-auto">
      <table className="w-full border-collapse border border-outline-variant text-[11px]">
        <thead>
          <tr className="bg-background">
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">风险</th>
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">概率</th>
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">影响</th>
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">缓解</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => {
            const prob = RISK_TOKENS[e.probability];
            const imp = RISK_TOKENS[e.impact];
            return (
              <tr key={i} data-testid={`primitive-risk-row-${i}`}>
                <td className="border border-outline-variant px-2 py-1 text-on-surface">{e.risk}</td>
                <td className={`border border-outline-variant px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] ${prob.ink}`}>{prob.label}</td>
                <td className={`border border-outline-variant px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] ${imp.ink}`}>{imp.label}</td>
                <td className="border border-outline-variant px-2 py-1 text-on-surface">{e.mitigation}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// -----------------------------------------------------------------------------
// CompareTable——N 列对比表
// -----------------------------------------------------------------------------

export function CompareTable({ columns, rows, testId = "primitive-compare-table" }: { columns: string[]; rows: CompareRow[]; testId?: string }) {
  if (columns.length === 0) return null;
  return (
    <div data-testid={testId} className="my-4 overflow-x-auto">
      <table className="w-full border-collapse border border-outline-variant text-[11px]">
        <thead>
          <tr className="bg-background">
            <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant"></th>
            {columns.map((c, i) => (
              <th key={i} className="border border-outline-variant px-2 py-1 text-left font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} data-testid={`primitive-compare-row-${i}`}>
              <td className="border border-outline-variant px-2 py-1 font-mono text-[10px] font-semibold text-on-surface">{row.label}</td>
              {columns.map((_c, j) => (
                <td key={j} className="border border-outline-variant px-2 py-1 text-on-surface">{row.values[j] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// -----------------------------------------------------------------------------
// ActionChecklist——带完成状态的任务列表
// -----------------------------------------------------------------------------

export function ActionChecklist({ items, testId = "primitive-action-checklist" }: { items: Array<{ done: boolean; text: string }>; testId?: string }) {
  if (items.length === 0) return null;
  return (
    <ul data-testid={testId} className="my-4 list-none space-y-1 pl-0">
      {items.map((item, i) => (
        <li
          key={i}
          data-testid={`primitive-action-checklist-item-${i}`}
          className="flex items-baseline gap-2 text-[12px]"
        >
          <span
            data-done={item.done}
            className={`mt-0.5 inline-block h-3 w-3 shrink-0 border ${item.done ? "border-emerald-700 bg-emerald-600" : "border-outline-variant bg-surface-lowest"}`}
            aria-hidden="true"
          />
          <span className={item.done ? "text-on-surface-variant line-through" : "text-on-surface"}>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

// -----------------------------------------------------------------------------
// SummaryStrip——功能已交付布局顶部的单行摘要
// -----------------------------------------------------------------------------

export function SummaryStrip({
  label,
  body,
  testId = "primitive-summary-strip",
}: { label: string; body: string; testId?: string }) {
  return (
    <div data-testid={testId} className="my-3 border-l-4 border-emerald-600 bg-emerald-50/60 px-3 py-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-emerald-800">{label}</div>
      <div className="mt-1 text-[12px] text-on-surface">{body}</div>
    </div>
  );
}
