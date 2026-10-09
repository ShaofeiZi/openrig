// 0.3.1 slice 06——“为你推荐”的叙事卡片原语。
//
// 面向移动端优先设计的信息流卡片：折叠（约 80px）→ 点按后行内展开预览
// → 点按“打开”进入详情。
//
// 2026-05-15 迭代——与 vellum 协调一致的重新设计。
// 卡片现在采用与仪表盘目标卡片相同的 vellum 表面语言（半透明石色、背景模糊、
// 环境阴影和 L 形角标），但内容布局以可读性为先，因为“为你推荐”是人的注意力队列；
// 阅读体验比装饰更重要。

import { useState, type ReactNode } from "react";
import { CornerBracket } from "../../dashboard/vellum/index.js";
import type { FeedCard } from "../../../lib/feed-classifier.js";

// -----------------------------------------------------------------------------
// CardShell——共享外观框架
// -----------------------------------------------------------------------------

export interface CardShellProps {
  testId: string;
  kind: CardKind;
  title: string;
  oneLiner: string;
  accent: CardAccent;
  expanded: ReactNode;
  drillInHref?: string;
  drillInLabel?: string;
  /** 渲染在折叠视图右上角的行内操作行。 */
  inlineActions?: ReactNode;
  /** 渲染在标题左侧的可选附件（状态圆点或状态条）。 */
  leadingAccessory?: ReactNode;
}

export type CardKind = "shipped" | "incident" | "progress" | "approval" | "concept";

interface CardAccent {
  stripe: string; // legacy — preserved for backwards compatibility
  pill: string;
  ink: string;
  label: string;
}

export const ACCENTS: Record<CardKind, CardAccent> = {
  shipped:  { stripe: "border-l-emerald-600", pill: "bg-emerald-50 border-emerald-300", ink: "text-emerald-800", label: "已交付" },
  incident: { stripe: "border-l-red-600",     pill: "bg-red-50 border-red-300",         ink: "text-red-800",     label: "事件" },
  progress: { stripe: "border-l-sky-600",     pill: "bg-sky-50 border-sky-300",         ink: "text-sky-800",     label: "进展" },
  approval: { stripe: "border-l-amber-600",   pill: "bg-amber-50 border-amber-300",     ink: "text-amber-800",   label: "需审批" },
  concept:  { stripe: "border-l-violet-600",  pill: "bg-violet-50 border-violet-300",   ink: "text-violet-800",  label: "概念" },
};

// 按类型着色的前导圆点使用设计令牌（success/warning/tertiary），不使用
// bg-emerald-50 等偏离品牌的颜色。圆点是类型标签中唯一的彩色元素，其余内容保持
// 单色黑，以确保可读性。
const KIND_DOT: Record<CardKind, string> = {
  shipped:  "bg-success",
  incident: "bg-tertiary",
  progress: "bg-secondary",
  approval: "bg-warning",
  concept:  "bg-outline",
};

const KIND_LABEL: Record<CardKind, string> = {
  shipped:  "已交付",
  incident: "事件",
  progress: "进展",
  approval: "审批",
  concept:  "概念",
};

// 环境阴影采用多段式设置，用于界定卡片四边；配方与仪表盘目标卡片相同。
const AMBIENT_SHADOW = {
  boxShadow: [
    "0 2px 4px rgba(0, 0, 0, 0.14)",
    "0 8px 20px rgba(0, 0, 0, 0.16)",
    "0 0 40px rgba(0, 0, 0, 0.12)",
  ].join(", "),
};

export function CardShell({ testId, kind, title, oneLiner, expanded, drillInHref, drillInLabel, inlineActions, leadingAccessory }: CardShellProps) {
  const [open, setOpen] = useState(false);
  return (
    <article
      data-testid={testId}
      data-card-kind={kind}
      data-expanded={open}
      style={AMBIENT_SHADOW}
      className="relative bg-surface-low/45 backdrop-blur-[10px] overflow-hidden"
    >
      {/* L-shaped corner brackets register the card bounds without a hard
          border — vellum vocabulary from the dashboard. */}
      <CornerBracket position="tl" />
      <CornerBracket position="tr" />
      <CornerBracket position="bl" />
      <CornerBracket position="br" />

      <div
        role="button"
        tabIndex={0}
        data-testid={`${testId}-toggle`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
        className="flex w-full min-h-[80px] cursor-pointer items-start gap-4 px-5 py-4 text-left"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          {/* Kind tag — mono uppercase with leading colored dot. NOT a
              colored pill; the only color is the dot. */}
          <div
            data-testid={`${testId}-pill`}
            className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface"
          >
            <span aria-hidden="true" className={`inline-block w-1.5 h-1.5 rounded-full ${KIND_DOT[kind]}`} />
            <span>{KIND_LABEL[kind]}</span>
          </div>

          {/* Title — display weight, sized for legibility (north star) */}
          <h3
            data-testid={`${testId}-title`}
            className="mt-2 flex items-center gap-2 font-headline text-[16px] font-bold leading-tight text-on-surface"
          >
            {leadingAccessory}
            <span className="truncate">{title}</span>
          </h3>

          {/* One-liner — clear body text */}
          <p
            data-testid={`${testId}-one-liner`}
            className="mt-1.5 font-body text-[12px] leading-relaxed text-on-surface line-clamp-2"
          >
            {oneLiner}
          </p>
        </div>

        {inlineActions && (
          <div
            data-testid={`${testId}-inline-actions`}
            className="flex shrink-0 items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            {inlineActions}
          </div>
        )}
      </div>

      {open && (
        <div
          data-testid={`${testId}-expanded`}
          className="border-t border-outline-variant/40 px-5 py-4"
        >
          {expanded}
          {drillInHref && (
            <div className="mt-3 flex justify-end">
              <a
                data-testid={`${testId}-drill-in`}
                href={drillInHref}
                className="inline-flex items-center gap-1 min-h-[44px] border border-on-surface px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hover:bg-inverse-surface hover:text-background transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                {drillInLabel ?? "打开"} →
              </a>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// -----------------------------------------------------------------------------
// ShippedCard——功能已交付叙事
// -----------------------------------------------------------------------------

export interface ShippedCardSource {
  sliceId: string;
  title: string;
  oneLiner: string;
  /** 可选的编号章节预览（在行内展开视图中渲染）。 */
  sections?: Array<{ number: number; heading: string; summary: string }>;
}

export function ShippedCard({ source }: { source: ShippedCardSource }) {
  return (
    <CardShell
      testId={`feed-card-shipped-${source.sliceId}`}
      kind="shipped"
      title={source.title}
      oneLiner={source.oneLiner}
      accent={ACCENTS.shipped}
      drillInHref={`/project/slice/${source.sliceId}`}
      expanded={
        source.sections && source.sections.length > 0 ? (
          <ol className="space-y-2 text-[11px]">
            {source.sections.slice(0, 3).map((s) => (
              <li key={s.number} data-testid={`feed-card-shipped-${source.sliceId}-section-${s.number}`} className="flex gap-2">
                <span className="font-mono text-[10px] font-bold text-on-surface-variant">{s.number}.</span>
                <div>
                  <div className="font-semibold text-on-surface">{s.heading}</div>
                  <div className="text-on-surface">{s.summary}</div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="text-[11px] text-on-surface-variant">{source.oneLiner}</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// IncidentCard——事件时间线摘要
// -----------------------------------------------------------------------------

export interface IncidentCardSource {
  sliceId: string;
  title: string;
  oneLiner: string;
  status: "success" | "warning" | "danger" | "info" | "muted";
  /** 行内展开时最多预览 3 条时间线记录。 */
  recentEntries?: Array<{ time: string; title: string; status: "success" | "warning" | "danger" | "info" | "muted" }>;
}

const STATUS_DOT: Record<IncidentCardSource["status"], string> = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger:  "bg-red-500",
  info:    "bg-sky-500",
  muted:   "bg-outline-variant",
};

export function IncidentCard({ source }: { source: IncidentCardSource }) {
  return (
    <CardShell
      testId={`feed-card-incident-${source.sliceId}`}
      kind="incident"
      title={source.title}
      oneLiner={source.oneLiner}
      accent={ACCENTS.incident}
      drillInHref={`/project/slice/${source.sliceId}`}
      drillInLabel="打开时间线"
      leadingAccessory={
        <span
          data-testid={`feed-card-incident-${source.sliceId}-dot`}
          className={`inline-block h-3 w-3 rounded-full shrink-0 ${STATUS_DOT[source.status]}`}
          aria-hidden="true"
        />
      }
      expanded={
        source.recentEntries && source.recentEntries.length > 0 ? (
          <ul className="space-y-2 text-[11px]">
            {source.recentEntries.slice(0, 3).map((e, i) => (
              <li key={i} data-testid={`feed-card-incident-${source.sliceId}-entry-${i}`} className="flex items-baseline gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[e.status]} shrink-0`} aria-hidden="true" />
                <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface-variant shrink-0">{e.time}</span>
                <span className="text-on-surface">{e.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[11px] text-on-surface-variant">暂无近期条目。</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// ProgressCard——任务/切片进度
// -----------------------------------------------------------------------------

export interface ProgressCardSource {
  missionId: string;
  title: string;
  oneLiner: string;
  /** 0..100 */
  percent: number;
  /** 按 IMPL-PRD §6 在折叠视图中显示的下一步提示
   *（“标题 + 进度条 + 下一步”）。省略时由 oneLiner 代替。 */
  nextStep?: string;
  /** 当前活跃子切片正在做什么（行内展开时显示）。 */
  activeSlice?: { id: string; label: string; status: string };
}

export function ProgressCard({
  source,
  onMarkComplete,
}: {
  source: ProgressCardSource;
  /**
   * Slice 18 §3.5——传入时，ProgressCard 会渲染“标记为完成”行内操作。
   * 点击后调用 onMarkComplete(missionId)；实际变更（后台服务端点和本地乐观状态）
   * 仍由父组件负责。
   */
  onMarkComplete?: (missionId: string) => void;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(source.percent)));
  const inlineActions = onMarkComplete ? (
    <button
      type="button"
      data-testid="progress-card-mark-complete"
      onClick={(event) => {
        event.stopPropagation();
        onMarkComplete(source.missionId);
      }}
      className="min-h-[36px] border border-on-surface px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hover:bg-inverse-surface hover:text-background transition-colors focus:outline-none focus:ring-1 focus:ring-on-surface"
    >
      标记为完成
    </button>
  ) : undefined;
  return (
    <CardShell
      testId={`feed-card-progress-${source.missionId}`}
      kind="progress"
      title={source.title}
      oneLiner={source.nextStep ?? source.oneLiner}
      accent={ACCENTS.progress}
      drillInHref={`/project/mission/${source.missionId}`}
      drillInLabel="打开任务"
      inlineActions={inlineActions}
      leadingAccessory={
        <div
          data-testid={`feed-card-progress-${source.missionId}-bar`}
          data-percent={pct}
          className="h-1.5 w-16 shrink-0 border border-outline-variant bg-surface-low overflow-hidden"
          aria-label={`进度 ${pct}%`}
        >
          <div
            data-testid={`feed-card-progress-${source.missionId}-bar-fill`}
            className="h-full bg-sky-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      }
      expanded={
        source.activeSlice ? (
          <div data-testid={`feed-card-progress-${source.missionId}-active-slice`} className="border border-outline-variant bg-background px-2 py-2">
            <div className="font-mono text-[8px] uppercase tracking-[0.18em] text-on-surface-variant">进行中的切片</div>
            <div className="mt-1 text-[12px] font-semibold text-on-surface">{source.activeSlice.label}</div>
            <div className="mt-0.5 font-mono text-[9px] text-on-surface-variant">状态：{source.activeSlice.status}</div>
          </div>
        ) : (
          <div className="text-[11px] text-on-surface-variant">无进行中的切片。</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// ApprovalCard——tier 为 human-gate 的队列项
// -----------------------------------------------------------------------------

export interface ApprovalCardSource {
  qitemId: string;
  title: string;
  oneLiner: string;
  /** 行内展开时显示的正文预览。 */
  bodyPreview?: string;
  /** 进入详情的目标（队列详情或切片）。 */
  drillInHref?: string;
  onApprove?: () => void;
  onDeny?: () => void;
}

export function ApprovalCard({ source }: { source: ApprovalCardSource }) {
  return (
    <CardShell
      testId={`feed-card-approval-${source.qitemId}`}
      kind="approval"
      title={source.title}
      oneLiner={source.oneLiner}
      accent={ACCENTS.approval}
      drillInHref={source.drillInHref}
      drillInLabel="打开详情"
      inlineActions={
        <>
          {source.onApprove && (
            <button
              type="button"
              data-testid={`feed-card-approval-${source.qitemId}-approve`}
              onClick={source.onApprove}
              className="min-h-[44px] border border-success px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-success hover:bg-success hover:text-white transition-colors"
            >
              批准
            </button>
          )}
          {source.onDeny && (
            <button
              type="button"
              data-testid={`feed-card-approval-${source.qitemId}-deny`}
              onClick={source.onDeny}
              className="min-h-[44px] border border-on-surface px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hover:bg-inverse-surface hover:text-background transition-colors"
            >
              拒绝
            </button>
          )}
        </>
      }
      expanded={
        source.bodyPreview ? (
          <pre data-testid={`feed-card-approval-${source.qitemId}-body`} className="overflow-x-auto whitespace-pre-wrap break-words bg-background p-2 font-body text-[11px] leading-relaxed text-on-surface">
            {source.bodyPreview}
          </pre>
        ) : (
          <div className="text-[11px] text-on-surface-variant">无正文预览。</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// ConceptCard——kind 为 concept-explainer
// -----------------------------------------------------------------------------

export interface ConceptCardSource {
  sliceId: string;
  title: string;
  oneLiner: string;
  /** 图示的可选缩略图 URL。 */
  thumbnailUrl?: string;
  /** 可选的比较预览（v0 中仅渲染为文本行）。 */
  comparePreview?: Array<{ label: string; valueOld: string; valueNew: string }>;
}

export function ConceptCard({ source }: { source: ConceptCardSource }) {
  return (
    <CardShell
      testId={`feed-card-concept-${source.sliceId}`}
      kind="concept"
      title={source.title}
      oneLiner={source.oneLiner}
      accent={ACCENTS.concept}
      drillInHref={`/project/slice/${source.sliceId}`}
      drillInLabel="打开概念"
      expanded={
        source.comparePreview && source.comparePreview.length > 0 ? (
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-background">
                <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant"></th>
                <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant">旧</th>
                <th className="border border-outline-variant px-2 py-1 text-left font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant">新</th>
              </tr>
            </thead>
            <tbody>
              {source.comparePreview.slice(0, 3).map((row, i) => (
                <tr key={i}>
                  <td className="border border-outline-variant px-2 py-1 font-mono text-[10px] font-semibold text-on-surface">{row.label}</td>
                  <td className="border border-outline-variant px-2 py-1 text-on-surface">{row.valueOld}</td>
                  <td className="border border-outline-variant px-2 py-1 text-on-surface">{row.valueNew}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-[11px] text-on-surface-variant">{source.oneLiner}</div>
        )
      }
    />
  );
}

// -----------------------------------------------------------------------------
// StorytellingFeed——面向移动端优先的纵向卡片堆栈
// -----------------------------------------------------------------------------

export type FeedCardItem =
  | { kind: "shipped"; source: ShippedCardSource }
  | { kind: "incident"; source: IncidentCardSource }
  | { kind: "progress"; source: ProgressCardSource }
  | { kind: "approval"; source: ApprovalCardSource }
  | { kind: "concept"; source: ConceptCardSource };

/** 0.3.1 slice 06 前向修复 #2：将后台服务提供的任务与切片行转换为
 * FeedCardItem[] 的纯适配器。它会导出作为单元测试界面，使调用方无须挂载完整的
 * Feed.tsx，即可验证生产接线的路由：任务 → ProgressCard；已交付切片 →
 * ShippedCard；其余项 → 带派生状态的 IncidentCard。 */
export interface AdapterMissionRow {
  name: string;
  path: string;
  /**
   * Slice 18 §3.5：来自后台服务的任务 frontmatter 状态
   *（GET /api/missions/:id）。状态为 "complete" 时，即使任务不在本地
   * completedMissionIds 集合中，也会从叙事预览带中过滤掉；这一持久事实来源可在
   * 浏览器/localStorage 重置后继续生效。
   */
  status?: string | null;
}
export interface AdapterSliceRow {
  name: string;
  missionId?: string | null;
  displayName?: string;
  status?: string | null;
  lastActivityAt?: string | null;
  /**
   * OPR.0.3.2.17：原始 frontmatter `status` 值，与归类后的 `status` 一并保留，
   * 使适配器无须改变后台服务的归类逻辑即可将 candidate 切片路由到 ConceptCard。
   * 调用方传入 sliceRows 时，从 SliceListEntry.rawStatus 填充。
   */
  rawStatus?: string | null;
  /**
   * OPR.0.3.2.17：切片 frontmatter 的 `description`。当切片通过
   * `rawStatus === "candidate"` 路由时，用作 ConceptCard.oneLiner。缺少该值时
   * 回退到稳定占位文本，使预览带仍能正常渲染。
   */
  description?: string | null;
}
// 已接线的卡片类型（OPR.0.3.2.17 之后，ConceptCard 数据源已接入）：
//   - progress  ← 任务（由 useMissionDiscovery 行映射）
//   - shipped   ← 状态为 shipped/complete/done 的切片
//   - incident  ← 状态为 blocked/failed/danger 等的切片
//   - approval  ← kind === "approval" 的 FeedCard 项（来自
//                 useActivityFeed → classifyFeed），由调用方通过第 4 个参数传入
//   - concept   ← rawStatus === "candidate" 的切片（已成形的待办项）：
//                 title ← displayName；oneLiner ← description；
//                 drillInHref ← /project/slice/<name>。按精选预览带规则最多 2 条
//                 （HG-4）；没有 candidate 行时优雅为空（HG-2）。
/**
 * OPR.0.3.2.17：按 PRD 方案 A 判定 ConceptCard 数据源。只有同时满足以下条件，
 * 切片才属于“已成形的待办候选项”：
 *   - frontmatter 状态为 "candidate"（不区分大小写）
 *   - 切片位于 `backlog` 任务下
 *
 * 导出该判定函数，使其成为独立且可测试的界面。守卫 BLOCKING
 * qitem-20260518093643 指出，原筛选条件仅检查 rawStatus，会错误匹配任意任务中的
 * candidate 切片。
 */
export function isBacklogCandidateSlice(slice: AdapterSliceRow): boolean {
  const status = (slice.rawStatus ?? "").toLowerCase();
  if (status !== "candidate") return false;
  return slice.missionId === "backlog";
}

export function buildStorytellingFeedItems(
  missions: AdapterMissionRow[],
  slices: AdapterSliceRow[],
  /**
   * Slice 18 §3.5：提供该集合时，名称位于集合中的任务会从进度预览中滤除。
   * 它支撑“入门指南”的完成后隐藏流程（操作人员点击 → 标记完成 → 任务从叙事预览带消失）。
   */
  completedMissionIds?: Set<string>,
  /**
   * 0.3.1 叙事适配器接线：来自 useActivityFeed/classifyFeed 且已分类的 FeedCard
   * 项。适配器只保留 `kind === "approval"` 的项，并在预览带中最多输出两张
   * ApprovalCard。此处忽略其他类型，FeedCard.tsx 会继续渲染下方的长列表。
   */
  feedCards?: FeedCard[],
): FeedCardItem[] {
  const items: FeedCardItem[] = [];
  // 两层筛选：一是 localStorage 中的乐观隐藏集合；二是持久化的 frontmatter
  // status === "complete"（调用方通过 GET /api/missions/:id 读取并传入行）。
  // 状态筛选是跨浏览器/localStorage 重置仍可存续的事实来源，本地集合则提供即时反馈镜像。
  const hiddenMissionIds = new Set(completedMissionIds ? Array.from(completedMissionIds) : []);
  for (const mission of missions ?? []) {
    if ((mission.status ?? "").toLowerCase() === "complete") {
      hiddenMissionIds.add(mission.name);
    }
  }
  const eligibleMissions = (missions ?? []).filter((m) => {
    return !hiddenMissionIds.has(m.name);
  });
  for (const mission of eligibleMissions.slice(0, 2)) {
    items.push({
      kind: "progress",
      source: {
        missionId: mission.name,
        title: mission.name,
        oneLiner: `任务位于 ${mission.path}`,
        nextStep: `打开任务查看实时状态与进行中的切片。`,
        percent: 0,
      },
    });
  }
  const eligibleSlices = (slices ?? []).filter((slice) => {
    return !slice.missionId || !hiddenMissionIds.has(slice.missionId);
  });

  // OPR.0.3.2.17——ConceptCard 路由。
  // PRD 方案 A：数据源专指 `missions/backlog/slices/<slug>/README.md` 中状态为
  // `candidate` 的已成形待办候选项，而不是任意任务中的 candidate 切片。判定函数要求
  // 两个条件同时成立；其他任务（例如 release-0.3.2）下的 `status: candidate` 切片会走
  // 普通状态分桶路径，而不会成为概念项。这样可使 ConceptCard 预览带在语义上符合
  // 操作人员对“已成形待办”的认知模型。
  //
  // 将候选项从普通状态分桶路由中分离，使单个切片只路由到一种类型
  //（HG-5：不得重复计数）。精选预览带最多显示 2 条（HG-4）。优雅为空规则（HG-2）：
  // 不存在 candidate 行时，此分支不贡献任何项。
  const candidateSlices = eligibleSlices.filter(isBacklogCandidateSlice);
  const nonCandidateSlices = eligibleSlices.filter(
    (s) => !isBacklogCandidateSlice(s),
  );
  for (const slice of candidateSlices.slice(0, 2)) {
    const title = slice.displayName || slice.name;
    const oneLinerRaw = (slice.description ?? "").trim();
    const oneLiner = oneLinerRaw.length > 0
      ? oneLinerRaw
      : "成形候选 —— 打开以查看拟议变更。";
    items.push({
      kind: "concept",
      source: {
        sliceId: slice.name,
        title,
        oneLiner,
      },
    });
  }

  for (const slice of nonCandidateSlices.slice(0, 3)) {
    const oneLiner = slice.lastActivityAt
      ? `最近活动 ${slice.lastActivityAt}`
      : `切片处于 ${slice.status ?? "未知"} 状态`;
    const title = slice.displayName || slice.name;
    const sliceId = slice.name;
    const status = (slice.status ?? "").toLowerCase();
    if (status === "shipped" || status === "complete" || status === "done") {
      items.push({ kind: "shipped", source: { sliceId, title, oneLiner } });
    } else if (status === "blocked" || status === "danger" || status === "failed") {
      items.push({
        kind: "incident",
        source: { sliceId, title, oneLiner, status: status === "blocked" ? "warning" : "danger" },
      });
    } else {
      items.push({ kind: "incident", source: { sliceId, title, oneLiner, status: "info" } });
    }
  }
  // Approval 接线：将 kind === "approval" 的已分类 FeedCard 映射为
  // ApprovalCardSource。qitemId 位于源事件载荷中，FeedCard.id 是 `${type}-${seq}`，
  // 并非 qitem ID；只有两个 qitem 键都不存在时才回退到 FeedCard.id，确保每张卡片
  // 仍有稳定的 React key。最多保留 2 条，以符合预览带的紧凑预算。
  const approvals = (feedCards ?? []).filter((c) => c.kind === "approval");
  for (const card of approvals.slice(0, 2)) {
    const payload = (card.source.payload ?? {}) as Record<string, unknown>;
    const fromPayload =
      (typeof payload.qitemId === "string" && payload.qitemId.length > 0)
        ? payload.qitemId
        : (typeof payload.qitem_id === "string" && payload.qitem_id.length > 0)
          ? payload.qitem_id
          : null;
    const qitemId = fromPayload ?? card.id;
    const author = card.authorSession ? ` 来自 ${card.authorSession}` : "";
    const bodyPreview =
      card.body && card.body.length > 240
        ? `${card.body.slice(0, 237)}...`
        : card.body;
    items.push({
      kind: "approval",
      source: {
        qitemId,
        title: card.title,
        oneLiner: `需要审批${author}`,
        bodyPreview,
        drillInHref: "/for-you",
      },
    });
  }
  return items;
}

export function StorytellingFeed({
  items,
  onMarkMissionComplete,
}: {
  items: FeedCardItem[];
  /** Slice 18 §3.5：提供时传递给 ProgressCard，让操作人员可从预览带中隐藏已完成任务。 */
  onMarkMissionComplete?: (missionId: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div data-testid="storytelling-feed-empty" className="border border-dashed border-outline-variant bg-surface-lowest/35 p-4 font-body text-[11px] text-on-surface-variant">
        信息流中暂无条目。
      </div>
    );
  }
  return (
    <div data-testid="storytelling-feed" className="flex flex-col gap-4">
      {items.map((item, i) => {
        // OPR.0.3.2.17：重新加入 ConceptCard 分支。适配器会为已成形的待办候选项
        //（rawStatus === "candidate"）输出 `kind: "concept"`，switch 再将其路由到
        // ConceptCard。其他四种类型保持不变（HG-5）。
        if (item.kind === "shipped")  return <ShippedCard key={i}  source={item.source} />;
        if (item.kind === "incident") return <IncidentCard key={i} source={item.source} />;
        if (item.kind === "progress") return <ProgressCard key={i} source={item.source} onMarkComplete={onMarkMissionComplete} />;
        if (item.kind === "approval") return <ApprovalCard key={i} source={item.source} />;
        if (item.kind === "concept")  return <ConceptCard key={i}  source={item.source} />;
        return null;
      })}
    </div>
  );
}
