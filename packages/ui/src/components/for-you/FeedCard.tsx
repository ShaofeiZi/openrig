import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CalendarDays, CircleAlert, Clock, History, PackageCheck, X } from "lucide-react";

import { CornerBracket } from "../dashboard/vellum/index.js";
import { AuthorAgentTag } from "./AuthorAgentTag.js";
import { FeedCardTerminalDrill } from "./FeedCardTerminalDrill.js";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import type { QueueItemViewerData } from "../drawer-viewers/QueueItemViewer.js";
import type { QueueItemDetail } from "../../hooks/useSlices.js";
import type { FeedCard as FeedCardModel, FeedCardKind } from "../../lib/feed-classifier.js";
import { isSyntheticFeedCard } from "../../lib/attention-feed.js";
import { VerbActions } from "../mission-control/components/VerbActions.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { buildChatPreamble } from "../review/chat.js";
import {
  ProofPacketHeader,
  ProofThumbnailGrid,
  TagPill,
  compactSessionLabel,
  eventToken,
  formatFriendlyDate,
  queueStateToken,
  type ProjectMetaTone,
  type ProjectToken,
} from "../project/ProjectMetaPrimitives.js";
import { ProofImageViewer } from "../project/ProofImageViewer.js";
import type { MissionControlVerb } from "../mission-control/hooks/useMissionControlAction.js";
import { ACTION_VERB_META, actionVerbToken } from "../mission-control/action-verb-meta.js";
import { ActorMark } from "../graphics/RuntimeMark.js";
import { cn } from "../../lib/utils.js";

/**
 * 与 vellum 协调一致的类型指示器。等宽大写标签加前导彩色圆点，映射到设计令牌
 *（success / warning / tertiary / secondary / stone-500），替代旧的彩色胶囊外观。
 */
const KIND_DOT: Record<FeedCardKind, string> = {
  "action-required": "bg-tertiary",
  approval: "bg-warning",
  shipped: "bg-success",
  progress: "bg-secondary",
  observation: "bg-outline",
};

const TONE_DOT: Record<ProjectMetaTone, string> = {
  neutral: "bg-outline",
  info: "bg-secondary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-tertiary",
};

const KIND_TESTID: Record<FeedCardKind, string> = {
  "action-required": "feed-card-action",
  approval: "feed-card-approval",
  shipped: "feed-card-shipped",
  progress: "feed-card-progress",
  observation: "feed-card-observation",
};

const KIND_TOKEN: Record<FeedCardKind, ProjectToken> = {
  // 纠偏 §7.1 守卫回修（2026-07-06）：类型标签与同级项一样是状态标签，绝不是操作指令外观。
  // 界面已移除“轮到你了”（创始人 N-1）；类型规范名称与批准框架中的订阅词汇一致：
  //“需要操作 · 必须由人处理的项目”。
  "action-required": { label: "需要处理", tone: "danger", icon: CircleAlert },
  approval: { label: "需要批准", tone: "warning", icon: CircleAlert },
  shipped: { label: "已交付", tone: "success", icon: PackageCheck },
  progress: { label: "进行中", tone: "info", icon: History },
  observation: { label: "观察", tone: "neutral", icon: Clock },
};

// OPR.0.4.1.27 单元 5——语气 → 文本颜色，用于类型图标，并镜像 TONE_DOT。
const TONE_TEXT: Record<ProjectMetaTone, string> = {
  neutral: "text-on-surface-variant",
  info: "text-secondary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-tertiary",
};

/**
 * OPR.0.4.1.27 单元 6——发送方或所有者终端解析器（保真映射）。人工操作卡片
 *（action-required / approval）打开发送方 sourceSession；智能体所有的卡片
 *（progress / shipped / observation）打开当前持有者 destinationSession，无法解析目标时回退到
 * 来源。sourceSession / destinationSession 是仅有的可寻址终端会话；绝不使用表示 qitem
 * 传承关系的 handed_off_from。
 */
export function resolveCardTerminalSession(
  kind: FeedCardKind,
  source: string | undefined,
  destination: string | undefined,
): string | undefined {
  if (kind === "action-required" || kind === "approval") return source;
  return destination ?? source;
}

/**
 * 卡片表面与 vellum 协调一致，并匹配 storytelling-cards.tsx 中的 CardShell，
 * 使 /for-you 呈现为统一界面。
 *   bg-surface-low/45 + backdrop-blur-[10px]
 *   三段环境 box-shadow 在 vellum 上勾勒卡片边缘
 *   无左侧条纹，无轮廓边框
 */
const CARD_SURFACE_CLASS =
  "relative bg-surface-low/45 backdrop-blur-[10px] overflow-hidden group";
const CARD_SHADOW_STYLE: React.CSSProperties = {
  boxShadow: [
    "0 2px 4px rgba(0, 0, 0, 0.14)",
    "0 8px 20px rgba(0, 0, 0, 0.16)",
    "0 0 40px rgba(0, 0, 0, 0.12)",
  ].join(", "),
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function extractQitemViewerData(card: FeedCardModel): QueueItemViewerData | null {
  const payload = (card.source.payload ?? {}) as Record<string, unknown>;
  const qitemId = asString(payload.qitem_id) ?? asString(payload.qitemId);
  if (!qitemId) return null;
  const tagsRaw = payload.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((t): t is string => typeof t === "string")
    : undefined;
  return {
    qitemId,
    source:
      asString(payload.source_session) ??
      asString(payload.sourceSession) ??
      asString(payload.fromSession),
    destination:
      asString(payload.destination) ??
      asString(payload.destination_session) ??
      asString(payload.destinationSession) ??
      asString(payload.toSession),
    state: asString(payload.state),
    tags,
    createdAt: card.createdAt,
    body: asString(payload.body) ?? card.body,
  };
}

export interface FeedProofPreview {
  sliceName: string;
  displayName: string;
  passFailBadge: string;
  screenshots: string[];
}

function qitemViewerDataFromItem(card: FeedCardModel, item: QueueItemDetail | undefined): QueueItemViewerData | null {
  const fallback = extractQitemViewerData(card);
  if (!item) return fallback;
  return {
    qitemId: item.qitemId,
    source: item.sourceSession,
    destination: item.destinationSession,
    state: item.state,
    tags: item.tags ?? undefined,
    createdAt: item.tsCreated,
    body: item.body || fallback?.body || card.body,
  };
}

function compactQueueBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (trimmed.length <= 520) return trimmed;
  return `${trimmed.slice(0, 520).trimEnd()}\n...`;
}

export interface FeedActionOutcome {
  verb: MissionControlVerb;
  actorSession: string;
  actedAt: string;
  state?: string | null;
  destinationSession?: string | null;
  reason?: string | null;
}

const TERMINAL_QUEUE_STATES = new Set([
  "done",
  "closed",
  "completed",
  "shipped",
  "canceled",
  "cancelled",
  "denied",
  "failed",
  "handed-off",
]);

function isTerminalQueueItem(item: QueueItemDetail | undefined): boolean {
  if (!item) return false;
  return TERMINAL_QUEUE_STATES.has(item.state.toLowerCase());
}

function isActionableCard(
  kind: FeedCardKind,
  item: QueueItemDetail | undefined,
  outcome: FeedActionOutcome | null,
): boolean {
  if (kind !== "action-required" && kind !== "approval") return false;
  if (outcome) return false;
  if (isTerminalQueueItem(item)) return false;
  return true;
}

function fallbackOutcomeFromQueueItem(
  kind: FeedCardKind,
  item: QueueItemDetail | undefined,
): FeedActionOutcome | null {
  if (kind !== "action-required" && kind !== "approval") return null;
  if (!item || !isTerminalQueueItem(item)) return null;
  const reason = item.closureReason ?? null;
  const destinationSession = item.handedOffTo ?? item.closureTarget ?? null;
  const verb: MissionControlVerb =
    reason === "denied" ? "deny"
      : reason === "handed_off_to" ? "route"
        : reason === "canceled" ? "drop"
          : "approve";
  return {
    verb,
    actorSession: item.destinationSession,
    actedAt: item.tsUpdated,
    state: item.state,
    destinationSession,
    reason: reason === "no-follow-on" ? null : item.closureTarget ?? reason,
  };
}

function outcomeToken(outcome: FeedActionOutcome): ProjectToken {
  return actionVerbToken(outcome.verb, "outcome");
}

/** 行内元数据标记：替代等宽大写胶囊的彩色圆点加标签。 */
function InlineMetaMark({ token }: { token: ProjectToken }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface">
      <span aria-hidden="true" className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", TONE_DOT[token.tone])} />
      {token.label}
    </span>
  );
}

function InlineDateMark({ value }: { value: string | undefined | null }) {
  return (
    <time
      dateTime={value ?? undefined}
      className="inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant"
    >
      <CalendarDays className="h-3 w-3" strokeWidth={1.5} />
      {formatFriendlyDate(value)}
    </time>
  );
}

function InlineActor({ session }: { session: string | undefined | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[10px] text-on-surface-variant">
      <ActorMark actor={session} size="xs" decorative />
      <span className="truncate">{compactSessionLabel(session)}</span>
    </span>
  );
}

function InlineFlow({ source, destination }: { source?: string | null; destination?: string | null }) {
  if (!source && !destination) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <InlineActor session={source ?? "未知来源"} />
      <ArrowRight className="h-3.5 w-3.5 text-on-surface-variant" strokeWidth={1.4} />
      <InlineActor session={destination ?? "未解析目标"} />
    </div>
  );
}

function outcomeSentence(outcome: FeedActionOutcome): string {
  switch (outcome.verb) {
    case "approve":
      return `已由 ${outcome.actorSession} 批准。`;
    case "deny":
      return `已由 ${outcome.actorSession} 拒绝${outcome.reason ? `：${outcome.reason}。` : "。"}`;
    case "route":
    case "handoff":
      return outcome.destinationSession
        ? `已由 ${outcome.actorSession} 转交至 ${outcome.destinationSession}。`
        : `已由 ${outcome.actorSession} 转交。`;
    case "hold":
      return `已由 ${outcome.actorSession} 挂起${outcome.reason ? `：${outcome.reason}。` : "。"}`;
    case "drop":
      return `已由 ${outcome.actorSession} 丢弃${outcome.reason ? `：${outcome.reason}。` : "。"}`;
    case "annotate":
      return `已由 ${outcome.actorSession} 标注。`;
  }
}

/**
 * 操作结果回执条，与 vellum 协调一致。
 *   所有语气统一使用轻微的 bg-background/40
 *   由前导彩色圆点指示语气，而不是给整条着色
 */
function ActionOutcomePanel({ outcome }: { outcome: FeedActionOutcome }) {
  const meta = ACTION_VERB_META[outcome.verb];
  const Icon = meta.icon;
  return (
    <div
      data-testid="feed-card-action-outcome"
      className="mt-3 bg-background/40 px-3 py-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span aria-hidden="true" className={cn("mt-2 inline-block w-1.5 h-1.5 rounded-full shrink-0", TONE_DOT[meta.tone])} />
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-lowest/55 text-on-surface">
            <Icon className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-on-surface">
              {meta.outcomeLabel}
            </div>
            <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
              已记录决策
            </div>
          </div>
        </div>
        <InlineDateMark value={outcome.actedAt} />
      </div>
      <p className="mt-3 font-body text-[12px] leading-relaxed text-on-surface">
        {outcomeSentence(outcome)}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <InlineActor session={outcome.actorSession} />
        {outcome.reason ? <TagPill tag={outcome.reason} /> : null}
      </div>
      {(outcome.verb === "route" || outcome.verb === "handoff") && outcome.destinationSession ? (
        <div className="mt-2">
          <InlineFlow source={outcome.actorSession} destination={outcome.destinationSession} />
        </div>
      ) : null}
    </div>
  );
}

const SWIPE_DISMISS_THRESHOLD = 0.5; // fraction of card width

export function FeedCard({
  card,
  queueItem,
  proofPreview,
  actionOutcome,
  onDismiss,
  onOptimisticOutcome,
}: {
  card: FeedCardModel;
  queueItem?: QueueItemDetail;
  proofPreview?: FeedProofPreview | null;
  actionOutcome?: FeedActionOutcome | null;
  /**
   * OPR.0.3.2.20：关闭时接收完整卡片，让父组件可将关闭操作路由到正确的关闭集合。
   * 事件派生卡片使用 event-seq，队列派生的注意项卡片使用 string-id。旧的 `(seq: number)`
   * 签名会让所有队列派生卡片发生冲突，因为它们共享合成 seq=-1；这是已记录守卫 BLOCKER
   * qitem-20260518190827。
   */
  onDismiss?: (card: FeedCardModel) => void;
  /**
   * 0.3.1 演示缺陷修复：变更成功时由 VerbActions 触发，使父组件 Feed.tsx 无须等待重新获取
   * 审计日志，即可乐观渲染 ActionOutcomePanel。
   */
  onOptimisticOutcome?: (qitemId: string, outcome: FeedActionOutcome) => void;
}) {
  const [selectedScreenshot, setSelectedScreenshot] = useState<string | null>(null);
  // 纠偏 §7.1——聊天快捷操作状态（按 BR-12 使用共享终端）。
  const [chatOpen, setChatOpen] = useState(false);
  const dragStateRef = useRef<{ startX: number; pointerId: number; isTouch: boolean } | null>(null);

  const handleKeyDown: React.KeyboardEventHandler<HTMLElement> = (event) => {
    if (!onDismiss) return;
    if (event.target !== event.currentTarget) return;
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      onDismiss(card);
    }
  };

  const handleTouchStart: React.TouchEventHandler<HTMLElement> = (event) => {
    if (!onDismiss) return;
    const touch = event.touches[0];
    if (!touch) return;
    dragStateRef.current = { startX: touch.clientX, pointerId: touch.identifier, isTouch: true };
  };

  const handleTouchEnd: React.TouchEventHandler<HTMLElement> = (event) => {
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    if (!onDismiss || !drag) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touch.clientX - drag.startX;
    if (deltaX <= 0) return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    if (deltaX / rect.width >= SWIPE_DISMISS_THRESHOLD) {
      onDismiss(card);
    }
  };

  const handleDismissClick: React.MouseEventHandler<HTMLButtonElement> = (event) => {
    event.stopPropagation();
    if (!onDismiss) return;
    onDismiss(card);
  };
  const qitemViewerData = qitemViewerDataFromItem(card, queueItem);
  const body = compactQueueBody(queueItem?.body || card.body);
  const tags = queueItem?.tags ?? qitemViewerData?.tags ?? [];
  const source = qitemViewerData?.source ?? card.authorSession;
  const destination = qitemViewerData?.destination;
  const actorSession = destination?.startsWith("human") ? destination : "human@host";
  const renderedOutcome = actionOutcome ?? fallbackOutcomeFromQueueItem(card.kind, queueItem);
  const primaryToken = renderedOutcome ? outcomeToken(renderedOutcome) : KIND_TOKEN[card.kind];
  const primaryDotClass = renderedOutcome
    ? TONE_DOT[primaryToken.tone]
    : KIND_DOT[card.kind];
  // OPR.0.4.1.27 单元 5——类型图标（模型图保真）：定义图标时按类型语气着色，
  // 而不是只渲染裸圆点。
  const PrimaryIcon = primaryToken.icon;
  // OPR.0.4.1.27 单元 6——发送方或所有者的终端地址。
  const terminalSession = resolveCardTerminalSession(card.kind, source, destination);
  return (
    <article
      data-testid={KIND_TESTID[card.kind]}
      style={CARD_SHADOW_STYLE}
      className={cn(CARD_SURFACE_CLASS, "mb-3")}
      {...(onDismiss
        ? {
            tabIndex: 0,
            onKeyDown: handleKeyDown,
            onTouchStart: handleTouchStart,
            onTouchEnd: handleTouchEnd,
          }
        : {})}
    >
      {/* 4 corner brackets — register the card bounds through the vellum
          without a hard border. */}
      <CornerBracket position="tl" />
      <CornerBracket position="tr" />
      <CornerBracket position="bl" />
      <CornerBracket position="br" />

      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {/* Kind tag — mono uppercase + leading colored dot. Replaces
                  the old colored-pill chrome. */}
              <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-on-surface">
                {PrimaryIcon ? (
                  <PrimaryIcon aria-hidden="true" strokeWidth={1.7} className={cn("h-3.5 w-3.5 shrink-0", TONE_TEXT[primaryToken.tone])} />
                ) : (
                  <span aria-hidden="true" className={cn("inline-block w-1.5 h-1.5 rounded-full shrink-0", primaryDotClass)} />
                )}
                {primaryToken.label}
              </span>
              {/* OPR.0.4.1.27 real-data fidelity — only real event-derived cards
                  show the source-event token. Synthetic attention/needs-input
                  projection cards wrap a real qitem in an internal wrapper type
                  (queue.attention.synthetic / activity.needs_input.synthetic);
                  feeding that to eventToken humanized the code into a visible
                  "...Synthetic" mark (an internal-string leak). Suppress it for
                  synthetic cards — their kind tag + queue-state token + human
                  title already carry the meaning. */}
              {!isSyntheticFeedCard(card) ? <InlineMetaMark token={eventToken(card.source.type)} /> : null}
              {qitemViewerData?.state ? <InlineMetaMark token={queueStateToken(qitemViewerData.state)} /> : null}
              {/* OPR.0.4.4.15 — origin host chip on aggregated remote items
                  only ('local'/absent renders nothing: zero-config DOM is
                  byte-identical to today). */}
              {card.hostId && card.hostId !== "local" ? (
                <span
                  data-testid="feed-card-host-chip"
                  className="px-1 border border-outline-variant font-mono text-[9px] uppercase tracking-wide text-on-surface-variant"
                >
                  {card.hostId}
                </span>
              ) : null}
            </div>
            {/* Title — legibility north star: 16px headline bold. */}
            <h3 className="font-headline text-[16px] font-bold leading-tight text-on-surface truncate">
              {card.title}
            </h3>
          </div>
          <div className="flex items-start gap-2">
            <InlineDateMark value={card.createdAt} />
            {onDismiss ? (
              <button
                type="button"
                data-testid="feed-card-dismiss"
                aria-label="关闭卡片"
                onClick={handleDismissClick}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-outline transition-opacity inline-flex h-5 w-5 items-center justify-center border border-outline-variant bg-surface-lowest/80 text-on-surface-variant hover:text-on-surface hover:border-outline"
              >
                <X className="h-3 w-3" strokeWidth={1.8} />
              </button>
            ) : null}
          </div>
        </div>
        {body ? (
          // Qitem / 事件正文是散文文本，使用 12px 字号保证可读性。
          <p className="mt-3 font-body text-[12px] leading-relaxed text-on-surface whitespace-pre-line">
            {body}
          </p>
        ) : null}
        <div className="mt-3">
          <InlineFlow source={source} destination={destination} />
        </div>
        {tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.slice(0, 6).map((tag) => <TagPill key={tag} tag={tag} />)}
          </div>
        ) : null}
        {proofPreview && proofPreview.screenshots.length > 0 ? (
          <div
            data-testid={`feed-card-proof-preview-${card.id}`}
            className="mt-3 bg-background/40 p-2"
          >
            <ProofPacketHeader
              title={`证据包 · ${proofPreview.displayName}`}
              badge={proofPreview.passFailBadge}
            />
            <div className="mt-2">
              <ProofThumbnailGrid
                sliceName={proofPreview.sliceName}
                screenshots={proofPreview.screenshots}
                onSelect={setSelectedScreenshot}
                testIdPrefix="feed-card-proof-screenshot"
              />
            </div>
          </div>
        ) : null}
        {renderedOutcome ? <ActionOutcomePanel outcome={renderedOutcome} /> : null}
        {qitemViewerData && isActionableCard(card.kind, queueItem, renderedOutcome) ? (
          <div
            data-testid={`feed-card-actions-${card.id}`}
            className="mt-3 bg-background/40 p-3"
          >
            {/* CORRECTIVE §7.1 + founder live-review 2026-07-05: JUST the two
                buttons — APPROVE (one-tap, the existing verb + write path) and
                CHAT (the shared terminal, preamble per BR-12). No "Your turn"
                prose, no "Choose response" chrome (VerbActions `bare`) —
                buttons are self-evident. Deny/route stay retired. */}
            <div className="flex flex-wrap items-center gap-2">
              <VerbActions
                qitemId={qitemViewerData.qitemId}
                actorSession={actorSession}
                bare
                hostId={card.hostId}
                enabledVerbs={["approve"]}
                oneClickVerbs={["approve"]}
                onOptimisticOutcome={
                  onOptimisticOutcome
                    ? (outcome) => onOptimisticOutcome(qitemViewerData.qitemId, outcome)
                    : undefined
                }
              />
              <button
                type="button"
                data-testid={`feed-card-chat-${card.id}`}
                disabled={!terminalSession}
                title={terminalSession ? `与 ${terminalSession} 聊天` : "此卡片未解析到归属智能体"}
                onClick={() => setChatOpen((v) => !v)}
                className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant disabled:opacity-50"
              >
                ⌨ 聊天
              </button>
            </div>
            {chatOpen && terminalSession ? (
              <div className="mt-2 border border-outline-variant">
                <ProgressiveTerminal
                  sessionName={terminalSession}
                  terminalKey={`feed-chat:${card.id}`}
                  initialText={buildChatPreamble({ sessionName: terminalSession, itemRef: qitemViewerData.qitemId })}
                />
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[10px] text-on-surface-variant">
          <div className="flex items-center gap-2 min-w-0">
            {/* OPR.0.4.1.27 real-data fidelity — when there is no human author
                session, render nothing here. Previously this fell back to the raw
                card.source.type, which leaked the internal wrapper string
                (e.g. activity.needs_input.synthetic) user-visible. The kind tag +
                human title already identify the card. */}
            {card.authorSession ? (
              <AuthorAgentTag authorSession={card.authorSession} rigId={card.rigId} />
            ) : null}
            {qitemViewerData ? (
              <QueueItemTrigger
                data={qitemViewerData}
                testId={`feed-card-show-context-${card.id}`}
                className="font-mono text-[10px] uppercase tracking-wide text-on-surface hover:text-on-surface underline"
              >
                查看上下文
              </QueueItemTrigger>
            ) : null}
            {/* OPR.0.4.1.27 Unit 6 — drill into the live terminal of the right
                seat: the SENDER for human-action cards, the current HOLDER for
                agent-owned cards (sender-or-owner resolver). Session-name keyed;
                honest disabled state when no session resolves. */}
            <FeedCardTerminalDrill cardId={card.id} sessionName={terminalSession} />
            {/* OPR.0.4.4.20 FR-9 win #2: the evidence_ref judge-this pointer is
                visible on the card itself — the human sees WHAT to judge before
                drilling anywhere. */}
            {card.evidenceRef ? (
              <span
                data-testid={`feed-card-evidence-${card.id}`}
                title={card.evidenceRef}
                className="max-w-48 truncate font-mono text-[10px] text-on-surface-variant"
              >
                证据：{card.evidenceRef}
              </span>
            ) : null}
            {/* OPR.0.4.4.20 FR-9 win #1: living-notes cards deep-link into the
                slice Review tab anchored at this NEEDS-YOU item. Non-living-notes
                cards keep the existing drills unchanged (additive routing). */}
            {card.reviewSlice ? (
              <Link
                to="/project/slice/$sliceId"
                params={{ sliceId: card.reviewSlice }}
                hash={card.reviewAnchor ? `needs-you-${card.reviewAnchor}` : undefined}
                data-testid={`feed-card-review-link-${card.id}`}
                className="font-mono text-[10px] uppercase tracking-wide underline text-on-surface hover:text-on-surface-variant"
              >
                评审 →
              </Link>
            ) : null}
          </div>
        </div>
      </div>
      {proofPreview ? (
        <ProofImageViewer
          sliceName={proofPreview.sliceName}
          relPath={selectedScreenshot}
          onClose={() => setSelectedScreenshot(null)}
        />
      ) : null}
    </article>
  );
}
