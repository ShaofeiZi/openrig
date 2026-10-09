// PL-005 阶段 A：包含 9 个字段、适合手机阅读的内容模型原子。
//
// 按 PRD §验收标准第 1 项，这是不可协商的要求：该行逐字携带全部 9 个字段。UI 可以紧凑显示，
// 在手机宽度下只露出前 3–4 个字段，但 JSON 载荷保留全部 9 个。
//
// PRD 中逐字规定的 9 个字段：
//   1. 工作组/任务名称
//   2. 当前阶段
//   3. active/idle/attention/blocked/degraded
//   4. 下一步操作
//   5. 待人工决策
//   6. 阅读成本（完整 / 略读并批准 / 仅摘要）
//   7. 最近更新时间戳
//   8. 置信度/新鲜度
//   9. 证据链接

import { useState, type MouseEvent } from "react";
import type { CompactStatusRow as CompactStatusRowData } from "../hooks/useMissionControlView.js";

export interface CompactStatusRowProps {
  row: CompactStatusRowData;
  density?: "compact" | "expanded";
  onAction?: () => void;
  highlighted?: boolean;
}

const STATE_BADGES: Record<CompactStatusRowData["state"], { label: string; cls: string }> = {
  active: { label: "运行中", cls: "bg-emerald-100 text-emerald-800" },
  idle: { label: "空闲", cls: "bg-surface-low text-on-surface" },
  attention: { label: "关注", cls: "bg-amber-100 text-amber-800" },
  blocked: { label: "已阻塞", cls: "bg-red-100 text-red-800" },
  degraded: { label: "降级", cls: "bg-orange-100 text-orange-800" },
};

export function CompactStatusRow({
  row,
  density = "expanded",
  onAction,
  highlighted = false,
}: CompactStatusRowProps) {
  const badge = STATE_BADGES[row.state];
  const summary = row.qitemSummary ?? summarizeQitemBody(row.qitemBody);
  const fullBody = row.qitemBody?.trim() ?? "";
  const hasDetails = Boolean(fullBody || row.qitemId || row.rawSourceRef);
  const [isExpanded, setIsExpanded] = useState(highlighted);

  const toggleDetails = () => {
    if (hasDetails) setIsExpanded((current) => !current);
  };

  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("a,button,input,select,textarea")) return;
    toggleDetails();
  };

  return (
    <div
      data-testid="mc-status-row"
      data-state={row.state}
      data-qitem-id={row.qitemId ?? ""}
      data-highlighted={highlighted ? "true" : "false"}
      data-expanded={isExpanded ? "true" : "false"}
      id={row.qitemId ? `mc-qitem-${row.qitemId}` : undefined}
      onClick={onRowClick}
      className={`border p-3 hover:bg-background ${
        hasDetails ? "cursor-pointer" : ""
      } ${
        highlighted
          ? "border-amber-400 bg-amber-50 ring-2 ring-amber-300"
          : "border-outline-variant bg-surface-lowest"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            data-testid="mc-state-badge"
            className={`inline-flex items-center px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${badge.cls}`}
          >
            {badge.label}
          </span>
          <span
            data-testid="mc-rig-name"
            className="font-mono text-xs text-on-surface truncate"
            title={row.rigOrMissionName}
          >
            {row.rigOrMissionName}
          </span>
          {row.currentPhase ? (
            <span
              data-testid="mc-current-phase"
              className="font-mono text-[10px] text-on-surface-variant"
            >
              · {row.currentPhase}
            </span>
          ) : null}
        </div>
        {hasDetails ? (
          <button
            type="button"
            onClick={() => toggleDetails()}
            data-testid="mc-row-details-toggle"
            className="border border-outline-variant px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface hover:bg-surface-low"
            aria-expanded={isExpanded}
          >
            {isExpanded ? "隐藏" : "详情"}
          </button>
        ) : null}
        {onAction ? (
          <button
            type="button"
            onClick={onAction}
            data-testid="mc-row-action"
            className="border border-outline-variant px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface hover:bg-surface-low"
          >
            操作
          </button>
        ) : null}
      </div>
      {summary ? (
        <p
          data-testid="mc-qitem-summary"
          className="mt-2 break-words text-sm leading-snug text-on-surface"
        >
          {summary}
        </p>
      ) : null}
      {density === "expanded" && (
        <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-on-surface sm:grid-cols-2">
          {row.nextAction ? (
            <div data-testid="mc-next-action">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-on-surface-variant">下一步</span>{" "}
              {row.nextAction}
            </div>
          ) : null}
          {row.pendingHumanDecision ? (
            <div data-testid="mc-pending-human-decision" className="text-amber-800">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-amber-700">人工</span>{" "}
              {row.pendingHumanDecision}
            </div>
          ) : null}
          {row.readCost ? (
            <div data-testid="mc-read-cost">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-on-surface-variant">阅读</span>{" "}
              {row.readCost}
            </div>
          ) : null}
          {row.confidenceFreshness ? (
            <div data-testid="mc-confidence-freshness">
              <span className="font-mono uppercase text-[9px] tracking-[0.1em] text-on-surface-variant">置信</span>{" "}
              {row.confidenceFreshness}
            </div>
          ) : null}
          <div data-testid="mc-last-update" className="text-on-surface-variant font-mono text-[10px]">
            {row.lastUpdate}
          </div>
          {row.evidenceLink ? (
            <a
              data-testid="mc-evidence-link"
              href={row.evidenceLink}
              className="text-on-surface-variant underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              证据
            </a>
          ) : null}
        </div>
      )}
      {isExpanded && hasDetails ? (
        <div
          data-testid="mc-qitem-details"
          className="mt-3 space-y-2 border-t border-outline-variant pt-2 text-[11px] text-on-surface"
        >
          {fullBody ? (
            <div data-testid="mc-qitem-body" className="whitespace-pre-wrap break-words text-xs text-on-surface">
              {fullBody}
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-1 font-mono text-[10px] text-on-surface-variant sm:grid-cols-2">
            {row.qitemId ? (
              <div>
                队列项 <span data-testid="mc-qitem-id">{row.qitemId}</span>
              </div>
            ) : null}
            {row.rawSourceRef ? (
              <div>
                来源 <span data-testid="mc-qitem-source">{row.rawSourceRef}</span>
              </div>
            ) : null}
          </div>
          {row.qitemId ? (
            <a
              data-testid="mc-qitem-audit-link"
              href={`/mission-control?view=audit-history&qitem_id=${encodeURIComponent(row.qitemId)}`}
              className="inline-flex border border-outline-variant px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hover:bg-surface-low"
            >
              审计
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function summarizeQitemBody(body: string | null | undefined): string | null {
  const compact = body?.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 117).trimEnd()}...`;
}
