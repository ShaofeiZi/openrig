// V1 第三次尝试阶段 3——“为你推荐”信息流分类器，依据 for-you-feed.md 第 106–107 行与 SC-17。
//
// **在客户端基于现有后台服务事件合成。** V1 不新增后台服务的
// `lifecycle.shipped` 事件类型——后台服务边界保持干净
// （SC-29）。SHIPPED 卡片由 queue.close + git 事件构建。

import type { ActivityEvent } from "../hooks/useActivityFeed.js";
import { isHumanSeatSessionRef } from "./session-name.js";

export type FeedCardKind =
  | "action-required"
  | "approval"
  | "shipped"
  | "progress"
  | "observation";

export interface FeedCard {
  id: string;
  kind: FeedCardKind;
  title: string;
  body?: string;
  authorSession?: string;
  rigId?: string;
  receivedAt: number;
  createdAt: string;
  // 点击穿透到工作范围所用的原始事件。
  source: ActivityEvent;
  /** OPR.0.4.4.20 FR-9 收益 2：evidence_ref 的 judge-this 链接，直接显示在
   *  卡片上（仅渲染；从待关注读取路径带过来）。 */
  evidenceRef?: string | null;
  /** OPR.0.4.4.20 FR-9 收益 1：living-notes 深链——即切片“评审”标签页中
   *  定位到本卡片 NEEDS-YOU 条目的锚点。非 living-notes 卡片上不存在
   *  （其既有下钻行为不变——属于增量路由）。 */
  reviewSlice?: string | null;
  reviewAnchor?: string | null;
  /** OPR.0.4.4.15：聚合多主机条目上的来源主机 id（'local'
   *  或已注册的主机 id）。缺省 = local（零配置行为不变）。 */
  hostId?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return undefined;
}

function shortQitemId(qitemId: string | undefined): string | undefined {
  if (!qitemId) return undefined;
  if (qitemId.length <= 28) return qitemId;
  return `${qitemId.slice(0, 18)}...${qitemId.slice(-6)}`;
}

function queueEventLabel(type: string): string {
  switch (type) {
    case "queue.created":
    case "queue.item.created":
      return "队列事项已创建";
    case "queue.updated":
    case "queue.item.updated":
      return "队列事项已更新";
    case "queue.handed_off":
      return "队列事项已交接";
    case "queue.claimed":
      return "队列事项已认领";
    case "queue.unclaimed":
      return "队列事项已取消认领";
    case "qitem.fallback_routed":
      return "队列事项已路由到回退目标";
    case "qitem.closure_overdue":
      return "队列事项关闭已逾期";
    case "inbox.absorbed":
      return "收件箱事项已吸收";
    case "inbox.denied":
      return "收件箱事项已拒绝";
    default:
      return type;
  }
}

function isQueueVisibilityEvent(type: string): boolean {
  return (
    type === "queue.created" ||
    type === "queue.updated" ||
    type === "queue.claimed" ||
    type === "queue.unclaimed" ||
    type === "queue.handed_off" ||
    type === "queue.item.created" ||
    type === "queue.item.updated" ||
    type === "qitem.fallback_routed" ||
    type === "qitem.closure_overdue" ||
    type === "inbox.absorbed" ||
    type === "inbox.denied"
  );
}

function queueKind(type: string, state: string | undefined, tier: string | undefined): FeedCardKind {
  if (type.startsWith("queue.") && type.endsWith(".closed")) {
    return "shipped";
  }
  if (type === "qitem.closure_overdue" || type === "inbox.denied") {
    return "action-required";
  }
  // OPR.0.4.4.19 FR-3：human-gate 是层级值，绝不是状态；原来的
  // `state === "human-gate"` 分支永远不可达，因为状态枚举不含该值。修复后的分支按 tier
  // 分类为审批卡片，与 attention-feed.ts 的 attentionKindFor 及任务控制读取层一致。
  if (tier === "human-gate") {
    return "approval";
  }
  if (state === "pending-approval") {
    return "action-required";
  }
  if (state === "closeout-pending-ratify") {
    return "approval";
  }
  if (state === "done" || state === "closed" || state === "completed" || state === "shipped") {
    return "shipped";
  }
  return "progress";
}

function queueBody(payload: Record<string, unknown>): string | undefined {
  const source = pickString(payload, "sourceSession", "source_session", "fromSession");
  const destination = pickString(
    payload,
    "destinationSession",
    "destination_session",
    "toSession",
    "destination",
  );
  const route =
    source && destination
      ? `${source} -> ${destination}`
      : source
        ? `来源：${source}`
        : destination
          ? `目标：${destination}`
          : undefined;
  const meta = [
    pickString(payload, "priority") ? `priority=${pickString(payload, "priority")}` : undefined,
    pickString(payload, "tier") ? `tier=${pickString(payload, "tier")}` : undefined,
    pickString(payload, "state", "toState") ? `state=${pickString(payload, "state", "toState")}` : undefined,
    pickString(payload, "closureReason") ? `closure=${pickString(payload, "closureReason")}` : undefined,
  ].filter((item): item is string => Boolean(item));

  return [route, meta.length > 0 ? meta.join(" / ") : undefined]
    .filter((item): item is string => Boolean(item))
    .join("\n") || undefined;
}

// OPR.0.4.4.19 FR-3：导出此函数，使 Feed.tsx 的卡片类型填充使用同一严格的人类席位谓词，
// 而非猜测前缀。
export function isHumanSeat(session: string | undefined): boolean {
  // OPR.0.4.6.MH1 FR-8：委托给共享会话名契约；原先是本地正则副本，正是此注释一直
  // 防范的漂移来源。
  return isHumanSeatSessionRef(session ?? "");
}

function classifyEvent(evt: ActivityEvent): FeedCard | null {
  const payload = (evt.payload ?? {}) as Record<string, unknown>;
  const author = pickString(
    payload,
    "actor_session",
    "actorSession",
    "source_session",
    "sourceSession",
    "fromSession",
    "sender",
  );
  const rigId = pickString(payload, "rig_id", "rigId");
  const summary = pickString(payload, "summary", "body", "title");
  const base = {
    id: `${evt.type}-${evt.seq}`,
    title: summary ?? evt.type,
    body: asString(payload.body),
    authorSession: author,
    rigId,
    receivedAt: evt.receivedAt,
    createdAt: evt.createdAt,
    source: evt,
  };

  // 按类型映射。保持精简，随反馈逐步扩充。
  if (evt.type.startsWith("queue.") && evt.type.endsWith(".closed")) {
    return { ...base, kind: "shipped" };
  }
  if (isQueueVisibilityEvent(evt.type)) {
    const qitemId = pickString(payload, "qitemId", "qitem_id");
    const destination = pickString(
      payload,
      "destinationSession",
      "destination_session",
      "toSession",
      "destination",
    );
    const state = pickString(payload, "state", "toState");
    const tier = pickString(payload, "tier");
    const classifiedKind = queueKind(evt.type, state, tier);
    const kind =
      classifiedKind === "approval"
        ? "approval"
        : isHumanSeat(destination)
          ? "action-required"
          : classifiedKind;
    const explicitTitle = pickString(payload, "summary", "title");
    const label =
      kind === "shipped" && evt.type === "queue.updated"
        ? "队列事项已交付"
        : queueEventLabel(evt.type);
    const title =
      explicitTitle ??
      [label, shortQitemId(qitemId)]
        .filter((item): item is string => Boolean(item))
        .join(": ");
    return {
      ...base,
      title,
      body: asString(payload.body) ?? queueBody(payload),
      kind,
    };
  }
  if (evt.type.startsWith("workflow.")) {
    return { ...base, kind: "progress" };
  }
  if (evt.type.startsWith("stream.") || evt.type.startsWith("watchdog.")) {
    return { ...base, kind: "observation" };
  }
  if (evt.type.startsWith("lifecycle.") || evt.type.startsWith("git.")) {
    return { ...base, kind: "shipped" };
  }
  // 默认把每个事件呈现为观察项，确保没有内容被静默丢弃。
  return { ...base, kind: "observation" };
}

export function classifyFeed(events: ActivityEvent[]): FeedCard[] {
  const cards = events.map(classifyEvent).filter((c): c is FeedCard => c !== null);
  return cards.sort((a, b) => b.receivedAt - a.receivedAt);
}

// OPR.0.3.3.20——按异常管理的排序。列出需要人工决策的类别；相较于它们，其他内容都是
// 非决策噪声。
const DECISION_KINDS: ReadonlySet<FeedCardKind> = new Set(["action-required", "approval"]);

/**
 * OPR.0.3.3.20——对已分类/合并 feed 执行有针对性的决策带排序。把所有需要操作/审批的
 * 卡片提升到进度/观察/已交付卡片之上，包括仅事件卡片；若只按最新优先排序，这些卡片会被
 * 更新的进度噪声淹没。每个条带内部仍保持最新优先。实现采用双条带稳定分区加现有时间比较器，
 * 有意不做优先级排名引擎：不引入分数、逐类别权重或卡片新字段。
 */
export function sortFeedByDecisionBand(cards: FeedCard[]): FeedCard[] {
  const newestFirst = (a: FeedCard, b: FeedCard) => b.receivedAt - a.receivedAt;
  const decision = cards.filter((c) => DECISION_KINDS.has(c.kind)).sort(newestFirst);
  const rest = cards.filter((c) => !DECISION_KINDS.has(c.kind)).sort(newestFirst);
  return [...decision, ...rest];
}
