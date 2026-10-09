// 0.3.1 slice 06——TimelineTab（对先前 StoryTab 的重命名 + 增强）。
// 把 slice 生命周期展示为最新在前的连通步骤树。圆点列按派生的事件状态着色，
// 使这条线一眼可读。当父级传入 `timelineMarkdown` 块（通常经 /api/files/read 从
// `<slice-dir>/timeline.md` 加载）时，它经 MarkdownViewer 渲染在事件流上方——
// 策展叙事增强（绝不取代）自动捕获的事件轨迹。
//
// 内部 data-testid 前缀（`story-row-*`、`story-step-*`、`story-tab` 等）予以保留，
// 以保持既有测试面向后兼容；slice-06 边界处改变的只是导出符号 + 文件名 + 圆点强调色
// + 可选 markdown 头部。

import { useMemo, useState } from "react";
import type {
  PhaseDefinition,
  QueueItemDetail,
  StoryEvent,
} from "../../../hooks/useSlices.js";
import { QueueItemTrigger } from "../../drawer-triggers/QueueItemTrigger.js";
import {
  DateChip,
  EventBadge,
  FlowChips,
  ProjectPill,
  TagPill,
  eventToken,
  type ProjectToken,
} from "../../project/ProjectMetaPrimitives.js";
import { MarkdownViewer } from "../../markdown/MarkdownViewer.js";

/** 从事件种类派生视觉状态，使圆点列一眼可读。保守映射：只有明显表示
 *  成功/失败/警告的种类才上强色；其余保持中性信息蓝或柔和色。 */
export type TimelineDotStatus = "success" | "warning" | "danger" | "info" | "muted";
export function statusFromEventKind(kind: string): TimelineDotStatus {
  const k = kind.toLowerCase();
  if (k.includes("complete") || k.includes("shipped") || k.includes("handed_off") || k.includes("merged") || k.includes("done")) return "success";
  if (k.includes("fail") || k.includes("error") || k.includes("blocked") || k.includes("rejected")) return "danger";
  if (k.includes("warn") || k.includes("attention") || k.includes("flagged")) return "warning";
  if (k.includes("created") || k.includes("started") || k.includes("in_progress") || k.includes("in-progress") || k.includes("transition") || k.includes("edited") || k.includes("updated")) return "info";
  return "muted";
}

const DOT_TOKENS: Record<TimelineDotStatus, string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger:  "bg-red-500",
  info:    "bg-sky-500",
  muted:   "bg-surface-highest",
};

const PHASE_PALETTE: string[] = [
  "bg-amber-100 text-amber-800 border-amber-300",
  "bg-violet-100 text-violet-800 border-violet-300",
  "bg-emerald-100 text-emerald-800 border-emerald-300",
  "bg-sky-100 text-sky-800 border-sky-300",
  "bg-rose-100 text-rose-800 border-rose-300",
  "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300",
  "bg-cyan-100 text-cyan-800 border-cyan-300",
  "bg-orange-100 text-orange-800 border-orange-300",
];
const UNTAGGED_CLASS = "bg-surface-low text-on-surface border-outline-variant";
const PAGE_SIZE = 12;

export function TimelineTab({
  events,
  phaseDefinitions,
  queueItemsById,
  timelineMarkdown,
}: {
  events: StoryEvent[];
  phaseDefinitions: PhaseDefinition[] | null;
  queueItemsById?: Map<string, QueueItemDetail>;
  /** 可选的 `<slice-dir>/timeline.md` 内容；存在时渲染在事件流上方。
   *  父级经 /api/files/read 负责拉取。 */
  timelineMarkdown?: string;
}) {
  const [page, setPage] = useState(0);
  const phaseMeta = useMemo(() => {
    const map = new Map<string, { label: string; colorClass: string; token: ProjectToken }>();
    if (phaseDefinitions) {
      phaseDefinitions.forEach((p, idx) => {
        map.set(p.id, {
          label: p.label,
          colorClass: PHASE_PALETTE[idx % PHASE_PALETTE.length]!,
          token: { label: p.label, tone: (["warning", "info", "success", "neutral"] as const)[idx % 4]! },
        });
      });
    }
    return map;
  }, [phaseDefinitions]);

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => timestampSortValue(b.ts) - timestampSortValue(a.ts)),
    [events],
  );
  const totalPages = Math.max(1, Math.ceil(sortedEvents.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedEvents = sortedEvents.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const hasMarkdown = typeof timelineMarkdown === "string" && timelineMarkdown.trim().length > 0;
  const hasEvents = events.length > 0;

  if (!hasEvents && !hasMarkdown) {
    return (
      <div
        data-testid="story-empty"
        className="border border-dashed border-outline-variant bg-surface-lowest/35 p-4 font-body text-[11px] leading-relaxed text-on-surface-variant"
      >
        {/* Slice 16：空态文案是正文；按 DESIGN §Typography，文件路径 / frontmatter /
            围栏块标记作为代码标识符保持等宽字体。 */}
        <div className="mb-1 font-mono uppercase tracking-[0.12em] text-on-surface-variant">暂无时间线</div>
        <div className="text-on-surface">
          在 <span className="font-mono text-on-surface">&lt;slice-dir&gt;/timeline.md</span> 中编写，带前置元数据
          <span className="font-mono text-on-surface"> kind: incident-timeline</span> 和一个 <span className="font-mono text-on-surface">```timeline```</span> 围栏块。
        </div>
      </div>
    );
  }

  return (
    <div data-testid="story-tab" className="space-y-3">
      {hasMarkdown && (
        <div
          data-testid="story-timeline-markdown"
          className="border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm"
        >
          <MarkdownViewer content={timelineMarkdown!} hideFrontmatter hideRawToggle />
        </div>
      )}
      {hasEvents && (
      <div data-testid="story-step-tree" data-order="newest-first" className="relative border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm">
        {pagedEvents.map((event, idx) => (
          <StoryStepCard
            key={`${event.ts}-${event.kind}-${idx}`}
            event={event}
            phaseMeta={phaseMeta}
            isLast={idx === pagedEvents.length - 1}
            queueItem={event.qitemId ? queueItemsById?.get(event.qitemId) : undefined}
          />
        ))}
      </div>
      )}
      {totalPages > 1 ? (
        <div className="mt-3 flex items-center justify-between border border-outline-variant bg-surface-lowest/35 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
          <button
            type="button"
            data-testid="story-page-prev"
            disabled={safePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            className="border border-outline-variant px-2 py-1 disabled:opacity-40"
          >
            较新
          </button>
          <span data-testid="story-page-status">
            第 {safePage + 1} / {totalPages} 页
          </span>
          <button
            type="button"
            data-testid="story-page-next"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
            className="border border-outline-variant px-2 py-1 disabled:opacity-40"
          >
            较早
          </button>
        </div>
      ) : null}
    </div>
  );
}

function timestampSortValue(ts: string): number {
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : 0;
}

function detailString(detail: Record<string, unknown> | null, keys: string[]): string | null {
  if (!detail) return null;
  for (const key of keys) {
    const value = detail[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function flowLabel(event: StoryEvent): { source: string | null; target: string | null } {
  const source =
    detailString(event.detail, ["fromSession", "sourceSession", "source", "actorSession"]) ??
    event.actorSession;
  const target = detailString(event.detail, ["toSession", "destinationSession", "targetSession", "target"]);
  return { source, target };
}

function eventBody(event: StoryEvent, queueItem: QueueItemDetail | undefined): string {
  // OPR.0.4.4.19 FR-2：标签先读摘要（给人看的平实语言）；正文经 qitemViewerData 在钻取时仍可取。
  const detailBody = detailString(event.detail, ["body", "content", "message"]);
  return queueItem?.summary ?? queueItem?.body ?? detailBody ?? event.summary;
}

function qitemViewerData(event: StoryEvent, queueItem: QueueItemDetail | undefined) {
  return {
    qitemId: event.qitemId ?? queueItem?.qitemId ?? "",
    source: queueItem?.sourceSession ?? flowLabel(event).source ?? undefined,
    destination: queueItem?.destinationSession ?? flowLabel(event).target ?? undefined,
    state: queueItem?.state ?? detailString(event.detail, ["state", "toState", "fromState"]) ?? undefined,
    tags: queueItem?.tags ?? undefined,
    createdAt: queueItem?.tsCreated ?? event.ts,
    body: queueItem?.body ?? eventBody(event, queueItem),
  };
}

function previewText(text: string, maxLines = 12): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…还有 ${lines.length - maxLines} 行`;
}

function StoryStepCard({
  event,
  phaseMeta,
  isLast,
  queueItem,
}: {
  event: StoryEvent;
  phaseMeta: Map<string, { label: string; colorClass: string; token: ProjectToken }>;
  isLast: boolean;
  queueItem?: QueueItemDetail;
}) {
  const meta = event.phase ? phaseMeta.get(event.phase) : undefined;
  const phaseLabel = meta?.label ?? event.phase ?? "未标记";
  const phaseClass = meta?.colorClass ?? UNTAGGED_CLASS;
  const phaseToken = meta?.token ?? { label: phaseLabel, tone: "neutral" as const };
  const flow = flowLabel(event);
  const scopeLabel = detailString(event.detail, ["sliceLabel", "sliceName"]);
  const primaryBody = eventBody(event, queueItem);
  const bodyIsQitem = Boolean(queueItem?.body);
  const stepToken = eventToken(event.kind);
  const StepIcon = stepToken.icon;
  const rowBody = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid={`story-row-phase-${event.kind}`}
          data-phase-id={event.phase ?? "untagged"}
          className={`sr-only ${phaseClass}`}
        >
          {phaseLabel}
        </span>
        <ProjectPill token={phaseToken} compact />
        {scopeLabel ? <ProjectPill token={{ label: scopeLabel, tone: "neutral" }} compact /> : null}
        <EventBadge kind={event.kind} compact />
        <DateChip value={event.ts} />
      </div>
        {/* Slice 16：事件正文是 prose（qitem 正文或事件摘要）。
            按 DESIGN §Typography：prose 用 font-body Inter；保留 `<pre>` 元素，
            经 whitespace-pre-wrap 保留源中的换行，但字体用正文。 */}
      <pre
        data-testid={`story-row-body-${event.kind}`}
        data-source={bodyIsQitem ? "qitem" : "event"}
        className="mt-2 whitespace-pre-wrap break-words font-body text-[12px] leading-relaxed text-on-surface"
      >
        {previewText(primaryBody)}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {event.qitemId ? <TagPill tag={event.qitemId} /> : null}
        {queueItem?.tags?.slice(0, 4).map((tag) => <TagPill key={tag} tag={tag} />)}
      </div>
      {bodyIsQitem && event.summary !== primaryBody ? (
        <div data-testid={`story-row-summary-${event.kind}`} className="mt-2 truncate font-mono text-[9px] text-on-surface-variant">
          {event.summary}
        </div>
      ) : null}
      {(flow.source || flow.target) && (
        <div data-testid={`story-step-flow-${event.kind}`} className="mt-2">
          <FlowChips source={flow.source} destination={flow.target} muted />
        </div>
      )}
    </>
  );

  return (
    <div className="relative pl-9 pb-3 last:pb-0">
      {!isLast && (
        <div
          data-testid={`story-step-connector-${event.kind}`}
          className="absolute left-[14px] top-7 bottom-0 w-px bg-outline-variant"
        />
      )}
      <div
        data-testid={`story-step-dot-${event.kind}`}
        data-dot-status={statusFromEventKind(event.kind)}
        className={`absolute left-[5px] top-3.5 flex h-5 w-5 items-center justify-center border border-outline-variant text-white shadow-[1px_1px_0_rgba(46,52,46,0.12)] ${DOT_TOKENS[statusFromEventKind(event.kind)]}`}
      >
        {StepIcon ? <StepIcon className="h-3 w-3" strokeWidth={1.7} /> : null}
      </div>
      {event.qitemId ? (
        <QueueItemTrigger
          data={qitemViewerData(event, queueItem)}
          testId={`story-row-${event.kind}`}
          className="block w-full border border-outline-variant bg-surface-lowest/45 px-3 py-2 text-left hard-shadow backdrop-blur-sm hover:bg-surface-lowest/60"
        >
          {rowBody}
        </QueueItemTrigger>
      ) : (
        <div
          data-testid={`story-row-${event.kind}`}
          className="w-full border border-outline-variant bg-surface-lowest/45 px-3 py-2 text-left hard-shadow backdrop-blur-sm"
        >
          {rowBody}
        </div>
      )}
      {event.detail && (
        <details className="mt-1">
          <summary className="cursor-pointer font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
            事件详情
          </summary>
          <pre data-testid={`story-row-detail-${event.kind}`} className="mt-1 overflow-x-auto bg-background p-2 font-mono text-[9px] text-on-surface">
            {JSON.stringify(event.detail, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
