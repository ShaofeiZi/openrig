// 活动笔记包 2 —— AGENTS 带（OPR.0.4.4.20 FR-4 SSOT + delta-A）。
//
// 两个范围渲染的共享智能体行结构（此组件是唯一渲染器；slice-22 的
// 工作组高度消费相同结构 + 相同范围参数化契约）：名称 · 运行时徽章 ·
// 状态字形（遥测中断时诚实未知——绝不猜测）· 通俗语言"正在做"行 ·
// 持有计数 · 最后转换时间 · ▲ 标记带内联证据 · CHAT 控件（终端，BR-12）·
// 只读终端钻取（相同 ProgressiveTerminal，静态直到点击转实时）。
//
// 漂移消除者（逐字契约）：范围间无能力分叉；单一计数身份；
// 任务带绝不嵌入切片页面（仅行 + 缩放——区域锚定可寻址，无独立切片路由）；
// 无新导航词汇——此带就是"智能体"。

import { useState } from "react";
import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";
import type { AgentsBand } from "../../hooks/useReview.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { TranscriptDrillPanel } from "./TranscriptDrillPanel.js";
import { buildChatPreamble } from "./chat.js";

const GLYPH: Record<string, { char: string; cls: string; label: string }> = {
  active: { char: "●", cls: "text-emerald-700", label: "进行中" },
  parked: { char: "◐", cls: "text-amber-700", label: "已停放" },
  idle: { char: "○", cls: "text-on-surface-variant", label: "空闲" },
  unknown: { char: "◌", cls: "text-on-surface-variant", label: "未知（遥测中断）" },
};

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
}

function AgentRowItem({
  row,
  rowInstanceKey,
  bandScope,
  itemRef,
}: {
  row: AgentsBand["rows"][number];
  rowInstanceKey: string;
  bandScope: AgentsBand["scope"];
  itemRef: string;
}) {
  const [openChat, setOpenChat] = useState(false);
  const glyph = GLYPH[row.stateGlyph] ?? GLYPH["unknown"]!;

  return (
    <li className="px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <details className="min-w-0 flex-1">
          <summary
            data-testid={`agent-drill-${row.sessionName}`}
            title="钻取到转录（只读，按需）"
            className="flex min-w-0 cursor-pointer list-none items-center gap-2 text-left marker:hidden"
          >
            <span className={glyph.cls} title={glyph.label} aria-label={glyph.label}>
              {glyph.char}
            </span>
            <span className="text-[12px] font-medium">{row.agentName}</span>
            <span className="border border-outline-variant px-1 font-mono text-[9px] uppercase text-on-surface-variant">
              {row.runtime}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-on-surface-variant">
              {row.doing ?? "—"}
            </span>
            <span className="font-mono text-[10px] text-on-surface-variant">持有 {row.holdsCount}</span>
            <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(row.lastTransitionIso)}</span>
          </summary>
          {/* FR-6：转录钻取——已发布的只读路由，仅在打开时获取
              （零常驻转录成本）。 */}
          <TranscriptDrillPanel sessionName={row.sessionName} deferUntilDetailsOpen />
        </details>
        <button
          type="button"
          data-testid={`agent-chat-${row.sessionName}`}
          onClick={() => setOpenChat((cur) => !cur)}
          className="border border-outline px-2 py-0.5 font-mono text-[10px] uppercase hover:bg-surface-variant"
        >
          对话
        </button>
      </div>
      {row.exception ? (
        <p data-testid={`agent-exception-${row.sessionName}`} className="mt-1 font-mono text-[10px] text-amber-800">
          ▲ {row.exception.evidence} · 阈值：{row.exception.threshold}
        </p>
      ) : null}
      {openChat ? (
        <div className="mt-2 border border-outline-variant" data-testid={`agent-chat-terminal-${row.sessionName}`}>
          {/* BR-12：相同的已发布终端家族，CHAT 出现的每个位置。 */}
          <ProgressiveTerminal
            sessionName={row.sessionName}
            terminalKey={`review-agents:${bandScope}:${rowInstanceKey}`}
            initialText={buildChatPreamble({ sessionName: row.sessionName, itemRef })}
          />
        </div>
      ) : null}
    </li>
  );
}

export function AgentsBandView({
  band,
  itemRef,
  grouping = "agent",
  previewLimit,
}: {
  band: AgentsBand;
  itemRef: string;
  /** OPR.0.4.4.22 FR-1 —— 页面级排列（架构规则：扩展在这一个主目录，
   *  绝不分叉副本）："agent" = 每行一个智能体的平铺渲染（现有行为，默认）；
   *  "slice" = 相同行按其持有工作的每个切片分组——成员关系保持工作范围，
   *  绝不工作组共存（数据已保证）。 */
  grouping?: "agent" | "slice";
  /** 任务高度保持所有权可见，不让大队列分类账主导页面。仅披露余数。 */
  previewLimit?: number;
}) {
  const visibleRows = previewLimit === undefined ? band.rows : band.rows.slice(0, previewLimit);
  const overflowRows = previewLimit === undefined ? [] : band.rows.slice(previewLimit);
  const zoomHref = band.scope.startsWith("slice:")
    ? `/agents?slice=${encodeURIComponent(band.scope.slice("slice:".length))}`
    : band.scope === "rig"
      ? null
      : "/agents";
  const groups: Array<{ label: string | null; rows: typeof band.rows }> =
    grouping === "slice" && visibleRows.length > 0
      ? [...new Set(visibleRows.flatMap((r) => (r.slices.length > 0 ? r.slices : ["（无切片）"])))]
          .sort()
          .map((slice) => ({
            label: slice,
            rows: visibleRows.filter((r) => (r.slices.length > 0 ? r.slices.includes(slice) : slice === "（无切片）")),
          }))
      : [{ label: null, rows: visibleRows }];

  return (
    <section id="agents" data-testid="agents-band" className={cn(VELLUM_CARD, "space-y-1 p-2")}>
      <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">智能体</h3>
      {/* FR-4：每个范围的一条协调健康线。 */}
      {band.coordinationHealth ? (
        <p data-testid="agents-health" className="font-mono text-[10px] text-on-surface-variant">
          {band.coordinationHealth}
        </p>
      ) : null}
      {band.rows.length === 0 ? null : (
        <div data-testid={previewLimit === undefined ? undefined : "agents-visible"}>
          {groups.map((group) => (
            <div key={group.label ?? "__flat"}>
              {group.label ? (
                <p data-testid={`agents-group-${group.label}`} className="mt-1 font-mono text-[10px] uppercase text-on-surface-variant">
                  {group.label}
                </p>
              ) : null}
              <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
                {group.rows.map((row) => {
                  const rowInstanceKey = `${group.label ?? "__flat"}:${row.sessionName}`;
                  return <AgentRowItem key={rowInstanceKey} row={row} rowInstanceKey={rowInstanceKey} bandScope={band.scope} itemRef={itemRef} />;
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      {overflowRows.length > 0 ? (
        <details data-testid="agents-overflow" className="border border-outline-variant">
          <summary className="cursor-pointer px-2 py-1.5 font-mono text-[10px] text-on-surface-variant">
            +{overflowRows.length} 个更多队列范围智能体
          </summary>
          <ul className="divide-y divide-outline-variant/50 border-t border-outline-variant">
            {overflowRows.map((row) => (
              <AgentRowItem
                key={`__overflow:${row.sessionName}`}
                row={row}
                rowInstanceKey={`__overflow:${row.sessionName}`}
                bandScope={band.scope}
                itemRef={itemRef}
              />
            ))}
          </ul>
        </details>
      ) : null}
      <div data-testid="agents-footer" className="flex items-center justify-between gap-3 border-t border-outline-variant/60 pt-1.5">
        <p
          data-testid={band.rows.length === 0 ? "agents-empty" : undefined}
          className="font-mono text-[10px] text-on-surface-variant"
        >
          {band.provenance}
        </p>
        {zoomHref ? (
          <a
            href={zoomHref}
            className="shrink-0 font-mono text-[10px] uppercase text-on-surface-variant underline-offset-2 hover:underline"
          >
            全部智能体 ↗
          </a>
        ) : null}
      </div>
    </section>
  );
}
