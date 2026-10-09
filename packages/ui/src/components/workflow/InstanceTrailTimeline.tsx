// OPR.0.4.6.WF4（C4）——路由历史时间线（FR-2 轨迹界面）。
//
// 将仅追加步骤轨迹呈现为可扫视路径（采用 Temporal 的事件分组纪律：分组、按状态着色，绝不直接
// 倾倒原始日志）；每行可进入查看操作者、关闭证据和 packet 传承。实时前沿步骤以虚线“开放”行
// 位于已关闭轨迹下方。`?step=<id>` 深链接（FR-3）会自动展开匹配轨迹行；若锚点就是当前步骤，
// 则高亮前沿。

import { useState } from "react";
import { cn } from "../../lib/utils.js";
import type {
  WorkflowInstanceWithDeadline,
  WorkflowStepTrailEntry,
} from "../../hooks/useWorkflow.js";

const EXIT_GLYPH: Record<string, { glyph: string; cls: string }> = {
  handoff: { glyph: "→", cls: "text-emerald-800" },
  waiting: { glyph: "◐", cls: "text-on-surface-variant" },
  done: { glyph: "○", cls: "text-on-surface-variant" },
  failed: { glyph: "▲", cls: "text-red-700" },
};

const EXIT_LABEL: Record<string, string> = {
  handoff: "已移交",
  waiting: "等待中",
  done: "已完成",
  failed: "失败",
};

function fmtTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function TrailRow({
  entry,
  index,
  expanded,
  onToggle,
}: {
  entry: WorkflowStepTrailEntry;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const exit = EXIT_GLYPH[entry.closureReason] ?? { glyph: "?", cls: "text-on-surface-variant" };
  const note =
    entry.closureEvidence && typeof entry.closureEvidence.resultNote === "string"
      ? entry.closureEvidence.resultNote
      : null;
  return (
    <li id={`step-${entry.stepId}`}>
      <button
        type="button"
        data-testid={`workflow-trail-row-${entry.trailId}`}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-variant/50"
      >
        <span className="font-mono text-[10px] text-on-surface-variant w-6 shrink-0">{index + 1}.</span>
        <span className="font-mono text-[11px] font-bold text-on-surface w-28 shrink-0">{entry.stepId}</span>
        <span className="font-mono text-[10px] text-on-surface-variant w-20 shrink-0">{entry.stepRole}</span>
        <span className={cn("font-mono text-[11px] w-20 shrink-0", exit.cls)}>
          {exit.glyph} {EXIT_LABEL[entry.closureReason] ?? entry.closureReason}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-on-surface-variant">{note ?? "—"}</span>
        <span className="hidden font-mono text-[10px] text-on-surface-variant lg:inline">{entry.actorSession}</span>
        <span className="font-mono text-[10px] text-on-surface-variant">{fmtTime(entry.closedAt)}</span>
      </button>
      {expanded ? (
        <div
          data-testid={`workflow-trail-expanded-${entry.trailId}`}
          className="space-y-1 border-t border-outline-variant/50 bg-surface-lowest/10 px-8 py-2 font-mono text-[10px]"
        >
          <p>
            <span className="uppercase text-on-surface-variant">操作者：</span>
            {entry.actorSession}
          </p>
          <p>
            <span className="uppercase text-on-surface-variant">已关闭工作包：</span>
            {entry.priorQitemId}
          </p>
          <p>
            <span className="uppercase text-on-surface-variant">下一路由：</span>
            {entry.nextQitemId ?? "（终点——无下一工作包）"}
          </p>
          {entry.closureEvidence ? (
            <pre className="overflow-x-auto border border-outline-variant/40 bg-surface-lowest/20 p-2 text-[9px] leading-snug">
              {JSON.stringify(entry.closureEvidence, null, 2)}
            </pre>
          ) : (
            <p className="text-on-surface-variant">（未记录关闭证据）</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function InstanceTrailTimeline({
  trail,
  instance,
  anchorStepId,
}: {
  trail: WorkflowStepTrailEntry[];
  instance: WorkflowInstanceWithDeadline;
  /** `?step=<id>` 深链接目标：自动展开匹配的已关闭行。 */
  anchorStepId?: string | null;
}) {
  const [expanded, setExpanded] = useState<string | null>(() => {
    if (!anchorStepId) return null;
    const hit = trail.find((t) => t.stepId === anchorStepId);
    return hit ? hit.trailId : null;
  });

  const frontierAnchored = anchorStepId != null && anchorStepId === instance.currentStepId;

  return (
    <div className="space-y-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">
        路由历史
        <span className="ml-2 normal-case tracking-normal">
          {trail.length} 个已关闭步骤 · 只追加轨迹 · 确定性路径
          {instance.currentStepId ? ` → 当前位于 ${instance.currentStepId}` : ""}
        </span>
      </div>
      {trail.length === 0 ? (
        <p className="font-mono text-[11px] text-on-surface-variant">
          尚无已关闭步骤——入口工作包仍位于前沿。
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
          {trail.map((entry, i) => (
            <TrailRow
              key={entry.trailId}
              entry={entry}
              index={i}
              expanded={expanded === entry.trailId}
              onToggle={() => setExpanded((cur) => (cur === entry.trailId ? null : entry.trailId))}
            />
          ))}
        </ul>
      )}
      {instance.currentStepId ? (
        <div
          id={`step-${instance.currentStepId}`}
          data-testid="workflow-frontier-row"
          className={cn(
            "flex items-center gap-2 border border-dashed px-2 py-1.5",
            frontierAnchored ? "border-amber-700 bg-amber-700/5" : "border-outline-variant",
          )}
        >
          <span className="font-mono text-[10px] text-on-surface-variant w-6 shrink-0">{trail.length + 1}.</span>
          <span className="font-mono text-[11px] font-bold text-on-surface w-28 shrink-0">
            {instance.currentStepId}
          </span>
          <span className="font-mono text-[11px] text-emerald-800 w-20 shrink-0">● 开放</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-on-surface-variant">
            前沿工作包 {instance.currentFrontier[0] ?? "（无）"}
            {instance.deadline.evidence ? ` · 由 ${instance.deadline.evidence.ownerSession} 持有` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}
