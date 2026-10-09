// V1 attempt-3 Phase 3——按 for-you-feed.md 的“为你推荐”feed 界面。
//
// 首要 UX = feed 本身。订阅不喧宾夺主
// （按 for-you-feed.md L134-L140 的承载性 SC-16）——浏览侧栏放订阅提示；
// feed 是核心。
//
// V1 attempt-3 Phase 5 P5-3：feed 卡片按 /api/config 的实时订阅状态筛选
// （5 个 feed.subscriptions.* 键）。action_required 卡片始终可见（按 L145 强制开）；
// observation 卡片仅在 audit_log 开时可见（默认关）。镜头 chip 在订阅筛选后的卡片上
// 叠加为临时的临时筛选。

import { useCallback, useMemo, useState } from "react";
import { cn } from "../../lib/utils.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { useActivityFeed } from "../../hooks/useActivityFeed.js";
import { useAttentionItems } from "../../hooks/useAttentionItems.js";
import {
  classifyFeed,
  isHumanSeat,
  sortFeedByDecisionBand,
  type FeedCard as FeedCardModel,
  type FeedCardKind,
} from "../../lib/feed-classifier.js";
import {
  attentionItemToFeedCard,
  needsInputSeatToFeedCard,
  eventDerivedSeqsForPrune,
  isQueueDerivedFeedCard,
  isSyntheticFeedCard,
  mergeAttentionIntoFeed,
} from "../../lib/attention-feed.js";
import { useNeedsInputSeats } from "../../hooks/useNeedsInputSeats.js";
import {
  useQueueItemMap,
  useSliceDetails,
  useSlices,
  type QueueItemDetail,
  type SliceDetail,
  type SliceListEntry,
} from "../../hooks/useSlices.js";
import {
  useFeedSubscriptions,
  isCardKindSubscribed,
} from "../../hooks/useFeedSubscriptions.js";
import { LevelControl } from "./LevelControl.js";
import { useDismissedSeqs } from "../../hooks/useDismissedSeqs.js";
import { useDismissedCardIds } from "../../hooks/useDismissedCardIds.js";
import { FeedCard } from "./FeedCard.js";
import { UndoToast } from "./UndoToast.js";
import type { FeedActionOutcome, FeedProofPreview } from "./FeedCard.js";
import {
  useMissionControlAudit,
  type AuditEntry,
} from "../mission-control/hooks/useMissionControlAudit.js";
import type { MissionControlVerb } from "../mission-control/hooks/useMissionControlAction.js";

const LENS_CHIPS: Array<{ id: FeedCardKind | "all"; label: string }> = [
  { id: "all", label: "全部" },
  { id: "action-required", label: "待处理动作" },
  { id: "approval", label: "审批" },
  { id: "shipped", label: "已交付" },
  { id: "progress", label: "进展" },
  { id: "observation", label: "审计" },
];

const HISTORY_LIMIT = 50; // 按 for-you-feed.md L182

const EMPTY_COPY: Record<FeedCardKind | "all", { label: string; description: string }> = {
  all: {
    label: "全部处理完毕",
    description: "当前没有需要你处理的事项。新的人工任务、审批、已交付校验包与进展更新会出现在这里。",
  },
  "action-required": {
    label: "没有待处理动作",
    // 纠正 §7.1 rev1-r2 修复回退（B1，2026-07-06）：空态文案
    // 不得泄露已退役的 deny/route schema——界面仅支持一键
    // 批准 + 聊天（创始人 N-1）。
    description: "当某个队列条目需要你回应时，会在这里出现，并可一键批准或与所属智能体聊天。",
  },
  approval: {
    label: "没有待处理审批",
    description: "当工作需要明确决策时，收尾与批准请求会汇集到这里。",
  },
  shipped: {
    label: "尚无已交付校验包",
    description: "切片关闭时，带校验包与截图的已完成工作会出现在这里。",
  },
  progress: {
    label: "暂无进展卡片",
    description: "随着工作推进，新的队列动态与项目更新会出现在这里。",
  },
  observation: {
    label: "暂无审计卡片",
    description: "观察事件目前很安静。打开审计订阅可查看更详尽的活动。",
  },
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];
}

function qitemIdForCard(card: FeedCardModel): string | null {
  const payload = (card.source.payload ?? {}) as Record<string, unknown>;
  return asString(payload.qitemId) ?? asString(payload.qitem_id) ?? null;
}

const FEED_ACTION_OUTCOME_VERBS = new Set<MissionControlVerb>([
  "approve",
  "deny",
  "route",
  "handoff",
  "hold",
  "drop",
]);

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function actionOutcomeFromAudit(row: AuditEntry): FeedActionOutcome | null {
  if (!row.qitemId) return null;
  const verb = row.actionVerb as MissionControlVerb;
  if (!FEED_ACTION_OUTCOME_VERBS.has(verb)) return null;
  const destinationSession =
    stringField(row.afterState, "handedOffTo") ??
    (stringField(row.afterState, "closureReason") === "handed_off_to"
      ? stringField(row.afterState, "closureTarget")
      : null);
  return {
    verb,
    actorSession: row.actorSession,
    actedAt: row.actedAt,
    state: stringField(row.afterState, "state"),
    destinationSession,
    reason: row.reason ?? stringField(row.afterState, "closureTarget"),
  };
}

function actionOutcomeMap(rows: AuditEntry[]): Map<string, FeedActionOutcome> {
  const byQitemId = new Map<string, FeedActionOutcome>();
  for (const row of rows) {
    if (!row.qitemId || byQitemId.has(row.qitemId)) continue;
    const outcome = actionOutcomeFromAudit(row);
    if (outcome) byQitemId.set(row.qitemId, outcome);
  }
  return byQitemId;
}

function queueTags(card: FeedCardModel, item: QueueItemDetail | undefined): string[] {
  const payload = (card.source.payload ?? {}) as Record<string, unknown>;
  return [
    ...asStringArray(payload.tags),
    ...(item?.tags ?? []),
  ];
}

// 导出供测试（OPR.0.4.4.19 FR-3——结构化信号契约由单元测试钉住；组件渲染路径不变）。
export function hydratedCardKind(
  card: FeedCardModel,
  item: QueueItemDetail | undefined,
  outcome: FeedActionOutcome | undefined,
): FeedCardKind {
  if (outcome && (card.kind === "action-required" || card.kind === "approval")) {
    return "approval";
  }
  if (!item) return card.kind;
  // OPR.0.4.4.19 FR-3：卡片类别提升只读结构化信号——
  // human-gate 层（C6）与严格的 human-seat 目标判定。
  // 此前的正文文本（"approval requested"）/标签猜测（"approval"、
  // "ratify"）/状态子串嗅探已退役，是删除：一旦信号在写路径强制执行，
  // 猜测不如读取。
  if (item.tier === "human-gate") return "approval";
  const state = item.state.toLowerCase();
  if (state === "done" || state === "closed" || state === "completed") return "shipped";
  if (isHumanSeat(item.destinationSession)) return "action-required";
  return card.kind;
}

function sliceForCard(
  card: FeedCardModel,
  item: QueueItemDetail | undefined,
  slices: SliceListEntry[],
): string | null {
  const tags = new Set(queueTags(card, item));
  for (const slice of slices) {
    if (tags.has(slice.name)) return slice.name;
  }
  const haystack = [
    card.title,
    card.body,
    item?.body,
    ...(item?.tags ?? []),
  ].filter((value): value is string => Boolean(value)).join("\n");
  for (const slice of slices) {
    if (haystack.includes(slice.name)) return slice.name;
  }
  return null;
}

function proofPreviewForSlice(detail: SliceDetail | undefined): FeedProofPreview | null {
  const packet = detail?.tests.proofPackets.find((candidate) => candidate.screenshots.length > 0)
    ?? detail?.tests.proofPackets[0];
  if (!detail || !packet || packet.screenshots.length === 0) return null;
  return {
    sliceName: detail.name,
    displayName: detail.displayName || detail.name,
    passFailBadge: packet.passFailBadge,
    screenshots: packet.screenshots,
  };
}

export function Feed() {
  const { events } = useActivityFeed();
  const [lens, setLens] = useState<FeedCardKind | "all">("all");
  const subs = useFeedSubscriptions();
  // Demo-bug 修复 #1——按 qitemId 键控的乐观动作结果。
  // VerbActions 在 mutation 成功时触发 onOptimisticOutcome；
  // ActionOutcomePanel 先从此读取，回退到下方 audit 派生的映射。
  // audit 重取最终会呈现同样形态，但用户可见状态是即时的。
  const [optimisticOutcomes, setOptimisticOutcomes] = useState<Map<string, FeedActionOutcome>>(
    () => new Map(),
  );
  const setOptimisticOutcome = useCallback(
    (qitemId: string, outcome: FeedActionOutcome) => {
      setOptimisticOutcomes((prev) => {
        const next = new Map(prev);
        next.set(qitemId, outcome);
        return next;
      });
    },
    [],
  );

  // OPR.0.3.2.20——为你推荐优先级窗口。
  // action-required + approval 镜头来自后台服务持久的 open-attention 查询
  // （与窗口无关），再与事件派生卡片合并。队列派生的关注卡片
  // 以相同 qitemId 取代事件派生卡片。其他类别
  // （shipped/progress/observation）保持事件派生（HG-6 无回归）。
  // OPR.0.4.4.15——合并的多主机 feed：当 ≥1 个已启用远程主机订阅时，
  // 关注轮询切到聚合端点（后台服务侧扇出；浏览器仍只与本地后台服务通信）。
  // 零配置保持今天的端点 + 渲染完全一致。
  const remoteFeedActive = subs.anyRemoteEnabled;
  const [hostFilter, setHostFilter] = useState<string | null>(null);
  const attentionQuery = useAttentionItems(50, remoteFeedActive);
  const hostStatuses = useMemo(() => attentionQuery.data?.hosts ?? [], [attentionQuery.data]);
  const queueDerivedAttention = useMemo<FeedCardModel[]>(
    () => (attentionQuery.data?.items ?? []).map(attentionItemToFeedCard),
    [attentionQuery.data],
  );
  const needsInputQuery = useNeedsInputSeats();
  const needsInputCards = useMemo<FeedCardModel[]>(
    () => (needsInputQuery.data ?? []).map(needsInputSeatToFeedCard),
    [needsInputQuery.data],
  );
  const eventDerivedCards = useMemo(() => classifyFeed(events).slice(0, HISTORY_LIMIT), [events]);
  const allAttention = useMemo(
    () => [...queueDerivedAttention, ...needsInputCards],
    [queueDerivedAttention, needsInputCards],
  );
  const rawCards = useMemo(
    () => sortFeedByDecisionBand(mergeAttentionIntoFeed(eventDerivedCards, allAttention)),
    [eventDerivedCards, allAttention],
  );
  // OPR.0.3.2.20——useDismissedSeqs 按 currentSeqs 的 min-seq 自动修剪。
  // 队列派生的合成卡片带 seq=-1，会把 min-seq 钉在 -1，从而阻止
  // 事件派生忽略的自动修剪（guard re-verify-2
  // qitem-20260518192210 CLEANUP-1）。eventDerivedSeqsForPrune
  // 把它们滤除——它们的忽略存在 useDismissedCardIds。
  const rawCardSeqs = useMemo(() => eventDerivedSeqsForPrune(rawCards), [rawCards]);
  const rawCardIds = useMemo(() => rawCards.map((c) => c.id), [rawCards]);
  const { dismissedSeqs, dismiss: dismissSeq, undismiss: undismissSeq } = useDismissedSeqs(rawCardSeqs);
  // OPR.0.3.2.20——与事件-seq 忽略并行的字符串键忽略。队列派生的关注卡片
  // 共享合成 ActivityEvent.seq = -1（无真实事件），故 seq 键忽略会在它们之间碰撞；
  // 把这些忽略路由到字符串-id 集合（FeedCard.id 稳定 + 唯一），使每个队列派生卡片
  // 的忽略独立。自动修剪基于成员关系：当 qitem 关闭，卡片从 rawCardIds 消失，
  // 忽略即被丢弃。
  const { dismissedIds, dismiss: dismissId, undismiss: undismissId } = useDismissedCardIds(rawCardIds);
  const [pendingUndo, setPendingUndo] = useState<{ kind: "seq"; seq: number } | { kind: "id"; id: string } | null>(null);

  // 路由忽略调用：合成卡片（queue-attention-* 与 activity-needs-input-*）
  // 用字符串键的 dismissedIds 集合；事件派生卡片继续用 seq 键的
  // dismissedSeqs 集合。避免在合成 seq=-1 上碰撞。
  const handleDismiss = useCallback(
    (card: FeedCardModel) => {
      if (isSyntheticFeedCard(card)) {
        dismissId(card.id);
        setPendingUndo({ kind: "id", id: card.id });
      } else {
        dismissSeq(card.source.seq);
        setPendingUndo({ kind: "seq", seq: card.source.seq });
      }
    },
    [dismissSeq, dismissId],
  );

  const handleUndo = useCallback(() => {
    if (pendingUndo === null) return;
    if (pendingUndo.kind === "seq") undismissSeq(pendingUndo.seq);
    else undismissId(pendingUndo.id);
    setPendingUndo(null);
  }, [pendingUndo, undismissSeq, undismissId]);

  const handleUndoExpire = useCallback(() => {
    setPendingUndo(null);
  }, []);
  const qitemIds = useMemo(
    () => rawCards.map(qitemIdForCard).filter((id): id is string => Boolean(id)),
    [rawCards],
  );
  const queueItems = useQueueItemMap(qitemIds);
  const actionAudit = useMissionControlAudit({ limit: 200 });
  const actionOutcomes = useMemo(
    () => actionOutcomeMap(actionAudit.data?.rows ?? []),
    [actionAudit.data?.rows],
  );
  const cards = useMemo(() => {
    const hydrated = rawCards.map((card) => {
      const qitemId = qitemIdForCard(card);
      const item = qitemId ? queueItems.itemsById.get(qitemId) : undefined;
      const outcome = qitemId ? actionOutcomes.get(qitemId) : undefined;
      const kind = hydratedCardKind(card, item, outcome);
      return kind === card.kind ? card : { ...card, kind };
    });
    // 先按订阅状态筛选，使 feed 尊重操作手配置，再应用临时镜头筛选，再丢弃
    // 操作手按事件-seq 软忽略的内容。
    const subscribed = hydrated.filter((c) =>
      isCardKindSubscribed(c.kind, subs.state),
    );
    const lensFiltered = lens === "all" ? subscribed : subscribed.filter((c) => c.kind === lens);
    // OPR.0.4.4.15——按主机筛选（无 hostId 的卡片按定义是本地的：
    // 事件派生 + needs-input 卡片永不出本机）。
    const hostFiltered = hostFilter === null ? lensFiltered : lensFiltered.filter((c) => (c.hostId ?? "local") === hostFilter);
    return hostFiltered.filter((c) => {
      if (isSyntheticFeedCard(c)) return !dismissedIds.has(c.id);
      return !dismissedSeqs.has(c.source.seq);
    });
  }, [rawCards, lens, hostFilter, queueItems.itemsById, actionOutcomes, subs.state, dismissedSeqs, dismissedIds]);
  const slicesQuery = useSlices("all");
  const sliceRows = useMemo(() => {
    if (!slicesQuery.data || "unavailable" in slicesQuery.data) return [];
    return slicesQuery.data.slices;
  }, [slicesQuery.data]);
  const proofSliceNames = useMemo(() => {
    const names = new Set<string>();
    for (const card of cards) {
      if (card.kind !== "shipped") continue;
      const qitemId = qitemIdForCard(card);
      const item = qitemId ? queueItems.itemsById.get(qitemId) : undefined;
      const sliceName = sliceForCard(card, item, sliceRows);
      if (sliceName) names.add(sliceName);
    }
    return Array.from(names);
  }, [cards, queueItems.itemsById, sliceRows]);
  const proofSlices = useSliceDetails(proofSliceNames);

  // OPR.0.4.1.27-foryou（创始人选的选项 a）——已删除残留的 0.3.1
  // 叙事预览带。为你推荐现在是下方 slice-27 重排、按订阅/镜头筛选的 FeedCard 列表；
  // 它曾重复的 mission/slice 汇总留在 Dashboard/Project。共享的
  // storytelling-cards.tsx 原语保留（/lab/card-previews 画廊仍导入它们）——
  // 只删了这个带的接线。

  return (
    <div data-testid="for-you-feed" className="mx-auto w-full max-w-[720px] px-6 py-8">
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">待关注</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-on-surface mt-1">
          为你推荐
        </h1>
      </header>

      {/* OPR.0.4.1.27——（手机端）feed 顶部的首要订阅控制：通俗层级
          （全部活动 / 重点 / 需要你），复用同一开关模型；动作项始终开。5 个
          独立开关保留在 Explorer 侧栏的高级视图。 */}
      <div data-testid="feed-level-control" className="mb-4">
        <LevelControl />
      </div>

      {/* 镜头 chip——临时筛选，不持久化（按 L156+）。用 Div 而非
          nav，使 SC-1 左侧 chrome 计数恰为 2。 */}
      <div
        data-testid="feed-lens-chips"
        role="toolbar"
        aria-label="动态筛选"
        className="flex flex-wrap gap-1 mb-4"
      >
        {LENS_CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            data-testid={`feed-lens-${c.id}`}
            data-active={lens === c.id}
            onClick={() => setLens(c.id)}
            className={cn(
              "px-2 py-1 border font-mono text-[9px] uppercase tracking-wide",
              lens === c.id
                ? "border-on-surface bg-inverse-surface text-background"
                : "border-outline-variant text-on-surface-variant hover:bg-surface-low",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* OPR.0.4.4.15——主机 chip + 逐主机状态行，仅在聚合激活时渲染
          （旧路径 hostStatuses 为空——零配置 DOM 与今天字节一致）。同样的
          镜头 chip 视觉；失败主机渲染为弱化 + 状态行
          （绝不静默地让 feed 变窄）。 */}
      {hostStatuses.length > 0 && (
        <div
          data-testid="feed-host-chips"
          role="toolbar"
          aria-label="主机筛选"
          className="flex flex-wrap gap-1 mb-2"
        >
          <button
            type="button"
            data-testid="feed-host-all"
            data-active={hostFilter === null}
            onClick={() => setHostFilter(null)}
            className={cn(
              "px-2 py-1 border font-mono text-[9px] uppercase tracking-wide",
              hostFilter === null
                ? "border-on-surface bg-inverse-surface text-background"
                : "border-outline-variant text-on-surface-variant hover:bg-surface-low",
            )}
          >
            所有主机
          </button>
          {hostStatuses.map((h) => (
            <button
              key={h.hostId}
              type="button"
              data-testid={`feed-host-${h.hostId}`}
              data-active={hostFilter === h.hostId}
              data-host-status={h.status}
              onClick={() => setHostFilter(hostFilter === h.hostId ? null : h.hostId)}
              className={cn(
                "px-2 py-1 border font-mono text-[9px] uppercase tracking-wide",
                hostFilter === h.hostId
                  ? "border-on-surface bg-inverse-surface text-background"
                  : "border-outline-variant text-on-surface-variant hover:bg-surface-low",
                h.status !== "ok" && "opacity-60",
              )}
            >
              {h.hostId}
              {h.status !== "ok" ? ` · ${h.status}` : ""}
            </button>
          ))}
        </div>
      )}
      {hostStatuses
        .filter((h) => h.status !== "ok")
        .map((h) => (
          <div
            key={`status-${h.hostId}`}
            data-testid={`feed-host-status-${h.hostId}`}
            className="mb-2 border border-outline-variant px-2 py-1 font-mono text-[9px] text-on-surface-variant"
          >
            {h.hostId}: {h.status}
            {h.error ? ` — ${h.error}` : ""}（其他主机的条目不受影响）
          </div>
        ))}

      {cards.length === 0 ? (
        <EmptyState
          label={EMPTY_COPY[lens].label}
          description={EMPTY_COPY[lens].description}
          variant="card"
          testId="for-you-empty"
        />
      ) : (
        <div data-testid="for-you-feed-cards">
          {cards.map((c) => {
            const qitemId = qitemIdForCard(c);
            const queueItem = qitemId ? queueItems.itemsById.get(qitemId) : undefined;
            const sliceName = c.kind === "shipped" ? sliceForCard(c, queueItem, sliceRows) : null;
            const proofPreview = sliceName ? proofPreviewForSlice(proofSlices.itemsByName.get(sliceName)) : null;
            const actionOutcome = qitemId
              ? optimisticOutcomes.get(qitemId) ?? actionOutcomes.get(qitemId) ?? null
              : null;
            return (
              <FeedCard
                key={c.id}
                card={c}
                queueItem={queueItem}
                proofPreview={proofPreview}
                actionOutcome={actionOutcome}
                onDismiss={handleDismiss}
                onOptimisticOutcome={setOptimisticOutcome}
              />
            );
          })}
        </div>
      )}
      {pendingUndo !== null ? (
        <UndoToast
          key={pendingUndo.kind === "seq" ? `seq-${pendingUndo.seq}` : `id-${pendingUndo.id}`}
          label="卡片已忽略"
          onUndo={handleUndo}
          onExpire={handleUndoExpire}
          durationMs={5000}
        />
      ) : null}
    </div>
  );
}
