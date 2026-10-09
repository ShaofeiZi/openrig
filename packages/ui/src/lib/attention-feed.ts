// OPR.0.3.2.20 —— 适配器：把开放的待关注队列项投影为 FeedCard[]。
//
// “For You”中“需要操作”与“待审批”两个视图，此前取自客户端内存里一个扁平
// FIFO（useActivityFeed.MAX_ACTIVITY_EVENTS=100），而常规队列抖动会把它挤出。
// 本适配器把后台服务持久化的开放待关注集合（GET /api/queue/list?attention=1）
// 投影为 feed 已经在渲染的同款 FeedCard 结构。
//
// 合并规则：
//   - 对“需要操作”和“待审批”两类，队列来源的卡片按相同 qitemId 覆盖事件来源的卡片。
//   - 当队列里有一条待关注项未在事件中出现（即此前被挤出的缺陷场景）时，
//     它仍会被展示，因为队列才是事实来源。
//   - 其他类别（已送达、进行中、观察）不受影响，仍来自 useActivityFeed/classifyFeed。

import type { FeedCard } from "./feed-classifier.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";
import type { AttentionQueueItem } from "../hooks/useAttentionItems.js";
// OPR.0.4.6.MH1 FR-8：人类席位判定复用共享的会话名约定
// （此前是同一正则在本地的一份拷贝，容易漂移）。
import { isHumanSeatSessionRef } from "./session-name.js";

/**
 * 判定队列项的待关注类别。与 mission-control 读取层及分类器的 queueKind 逻辑保持一致，
 * 以便“For You”各视图与 mission-control 的人工关卡视图口径统一。
 *
 *   - approval         → tier === "human-gate"
 *   - action-required  → destinationSession 命中人类席位正则
 *
 * 这里不导出为通用判定谓词，以免与后台服务 isAttentionItem 漂移；本适配器只把
 * 后台服务返回的合并待关注集合收窄为界面可见的这两类。
 */
function attentionKindFor(item: AttentionQueueItem): "approval" | "action-required" {
  if (item.tier === "human-gate") return "approval";
  if (isHumanSeatSessionRef(item.destinationSession ?? "")) return "action-required";
  // 兜底——后台服务对 attention=1 的项保证二者之一；这里给防御性默认值，
  // 保持联合类型紧凑。
  return "action-required";
}

/**
 * 把一条待关注队列项投影为合成 FeedCard。合成的 source ActivityEvent 携带 qitemId，
 * 使下游代码（qitemIdForCard、操作处理器）能统一处理。
 */
export function attentionItemToFeedCard(item: AttentionQueueItem): FeedCard {
  const kind = attentionKindFor(item);
  // 确定性的 FeedCard.id——事件用 `${evt.type}-${seq}`。队列来源卡片用稳定前缀，
  // 便于需要时识别队列来源卡片，也让 React key 在重新拉取时保持稳定。
  const id = `queue-attention-${item.qitemId}`;
  const receivedAt = Date.parse(item.tsUpdated) || Date.now();
  const createdAt = item.tsUpdated || item.tsCreated || new Date().toISOString();
  const syntheticEvent: ActivityEvent = {
    seq: -1,
    type: "queue.attention.synthetic",
    payload: {
      qitemId: item.qitemId,
      destinationSession: item.destinationSession,
      sourceSession: item.sourceSession,
      tier: item.tier,
      state: item.state,
      body: item.body,
    },
    createdAt,
    receivedAt,
  };
  // BR-10 平实语言：队列摘要存在时用作卡片标题；原始 qitem id 只在下钻一层展示。
  const title =
    item.summary ??
    (kind === "approval"
      ? `需要审批：${item.qitemId.slice(0, 24)}`
      : `需要处理：${item.qitemId.slice(0, 24)}`);
  // FR-9 收益 #1：带 slice 标签的待关注项是 living-notes 项——其卡片会深链到该 slice
  // 的 Review 标签页并锚定到这条“需要你”的项（对智能体项而言，手风琴的标识就是 qitem id）。
  const sliceTag = (item.tags ?? []).find((t) => t.startsWith("slice:"));
  return {
    id,
    kind,
    title,
    body: item.body,
    authorSession: item.sourceSession,
    receivedAt,
    createdAt,
    source: syntheticEvent,
    evidenceRef: item.evidenceRef ?? null,
    reviewSlice: sliceTag ? sliceTag.slice("slice:".length) : null,
    reviewAnchor: sliceTag ? item.qitemId : null,
    // OPR.0.4.4.15：来源主机沿同一分类器路径透传——仅作为展示/筛选维度，
    // 不另建一套远程卡片模型。
    ...(item.hostId !== undefined ? { hostId: item.hostId } : {}),
  };
}

/**
 * 把队列来源的待关注卡片合并进事件来源的 feed。
 * - 删除事件来源中 kind ∈ {action-required, approval} 且 qitemId 与队列卡片相同的卡片
 *   （队列优先；修复此前被挤出的缺陷）。
 * - 追加全部队列来源卡片。
 * - 非待关注类别原样透传（HG-6 无回归）。
 *
 * 调用方按惯例在下游排序/按 id 去重。
 */
export function mergeAttentionIntoFeed(
  eventDerived: FeedCard[],
  queueDerived: FeedCard[],
): FeedCard[] {
  const queueQitemIds = new Set<string>();
  for (const card of queueDerived) {
    const qitemId = qitemIdFromCard(card);
    if (qitemId) queueQitemIds.add(qitemId);
  }
  const filtered = eventDerived.filter((c) => {
    if (c.kind !== "action-required" && c.kind !== "approval") return true;
    const qitemId = qitemIdFromCard(c);
    if (!qitemId) return true;
    return !queueQitemIds.has(qitemId);
  });
  return [...queueDerived, ...filtered];
}

/**
 * OPR.0.3.2.20 —— 队列来源卡片的标识前缀。Feed.tsx 用它来路由关闭操作
 * （队列 → 字符串键的 dismissedIds；事件 → 数字的 dismissedSeqs），
 * 并把队列来源卡片从按 seq 裁剪的输入中排除（队列卡片的合成 seq=-1，
 * 否则会把 min-seq 钉在 -1，破坏事件来源关闭项的 useDismissedSeqs 自动裁剪
 * ——见 guard re-verify-2 qitem-20260518192210 CLEANUP-1）。
 */
export const QUEUE_DERIVED_CARD_ID_PREFIX = "queue-attention-";
export const ACTIVITY_NEEDS_INPUT_CARD_ID_PREFIX = "activity-needs-input-";

export function isSyntheticFeedCard(card: FeedCard): boolean {
  return card.id.startsWith(QUEUE_DERIVED_CARD_ID_PREFIX)
    || card.id.startsWith(ACTIVITY_NEEDS_INPUT_CARD_ID_PREFIX);
}

export function isQueueDerivedFeedCard(card: FeedCard): boolean {
  return card.id.startsWith(QUEUE_DERIVED_CARD_ID_PREFIX);
}

export function eventDerivedSeqsForPrune(rawCards: FeedCard[]): number[] {
  return rawCards.filter((c) => !isSyntheticFeedCard(c)).map((c) => c.source.seq);
}

function qitemIdFromCard(card: FeedCard): string | null {
  const payload = (card.source.payload ?? {}) as Record<string, unknown>;
  const fromPayload =
    (typeof payload.qitemId === "string" && payload.qitemId.length > 0)
      ? payload.qitemId
      : (typeof payload.qitem_id === "string" && payload.qitem_id.length > 0)
        ? (payload.qitem_id as string)
        : null;
  return fromPayload;
}

export interface NeedsInputSeat {
  logicalId: string;
  sessionName?: string | null;
  source: "hook" | "pane_heuristic" | string;
  eventAt?: string | null;
  sampledAt?: string;
  rigId?: string;
}

export function needsInputSeatToFeedCard(seat: NeedsInputSeat): FeedCard {
  const id = `activity-needs-input-${seat.rigId ?? "unknown"}-${seat.logicalId}`;
  const createdAt = seat.eventAt ?? seat.sampledAt ?? new Date().toISOString();
  const receivedAt = Date.parse(createdAt) || Date.now();
  const syntheticEvent: ActivityEvent = {
    seq: -1,
    type: "activity.needs_input.synthetic",
    payload: {
      logicalId: seat.logicalId,
      sessionName: seat.sessionName,
      source: seat.source,
      rigId: seat.rigId,
    },
    createdAt,
    receivedAt,
  };
  return {
    id,
    kind: "action-required",
    title: `${seat.logicalId} 需要输入${seat.source !== "hook" ? "（活动级）" : ""}`,
    body: seat.sessionName ?? undefined,
    rigId: seat.rigId,
    source: syntheticEvent,
    receivedAt,
    createdAt,
  };
}
