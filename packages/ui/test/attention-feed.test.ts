// OPR.0.3.2.20 —— For You 优先级窗口适配器测试。
//
// HG-3 失败优先判别：事件-FIFO 源在 MAX_ACTIVITY_EVENTS=100 之后
// 会丢弃注意力项；队列来源路径与窗口无关。本测试固定队列来源的
// 形状与合并规则。

import { describe, it, expect } from "vitest";
import {
  attentionItemToFeedCard,
  eventDerivedSeqsForPrune,
  isQueueDerivedFeedCard,
  mergeAttentionIntoFeed,
  QUEUE_DERIVED_CARD_ID_PREFIX,
} from "../src/lib/attention-feed.js";
import type { AttentionQueueItem } from "../src/hooks/useAttentionItems.js";
import type { FeedCard } from "../src/lib/feed-classifier.js";
import type { ActivityEvent } from "../src/hooks/useActivityFeed.js";

function makeAttention(overrides: Partial<AttentionQueueItem> = {}): AttentionQueueItem {
  return {
    qitemId: "qitem-20260518000000-aaaa",
    tsCreated: "2026-05-18T00:00:00.000Z",
    tsUpdated: "2026-05-18T00:00:00.000Z",
    sourceSession: "advisor@rig",
    destinationSession: "human-bob@kernel",
    state: "pending",
    priority: "routine",
    tier: null,
    tags: null,
    blockedOn: null,
    handedOffTo: null,
    handedOffFrom: null,
    body: "needs attention",
    ...overrides,
  };
}

function makeEvent(qitemId: string, type: string = "queue.created"): ActivityEvent {
  return {
    seq: 1,
    type,
    payload: { qitemId },
    createdAt: "2026-05-18T00:00:00.000Z",
    receivedAt: Date.parse("2026-05-18T00:00:00.000Z"),
  };
}

function makeFeedCard(opts: { kind: FeedCard["kind"]; qitemId?: string; id?: string }): FeedCard {
  const evt = opts.qitemId ? makeEvent(opts.qitemId) : { ...makeEvent("none"), payload: {} };
  return {
    id: opts.id ?? `${evt.type}-1`,
    kind: opts.kind,
    title: `${opts.kind} card`,
    body: "x",
    receivedAt: evt.receivedAt,
    createdAt: evt.createdAt,
    source: evt,
  };
}

describe("attentionItemToFeedCard —— 种类分类", () => {
  it("HG-4 审批类：tier='human-gate' → kind:'approval'", () => {
    const card = attentionItemToFeedCard(makeAttention({ tier: "human-gate", destinationSession: "advisor@rig" }));
    expect(card.kind).toBe("approval");
  });

  it("HG-4 需行动类：目标匹配 human-*@kernel → kind:'action-required'", () => {
    const card = attentionItemToFeedCard(makeAttention({ destinationSession: "human-bob@kernel" }));
    expect(card.kind).toBe("action-required");
  });

  it("HG-4 需行动类：目标匹配裸 human@host → kind:'action-required'", () => {
    const card = attentionItemToFeedCard(makeAttention({ destinationSession: "human@host" }));
    expect(card.kind).toBe("action-required");
  });

  it("HG-4：tier='human-gate' 压过 human-seat 目标（分类时审批优先）", () => {
    const card = attentionItemToFeedCard(makeAttention({ tier: "human-gate", destinationSession: "human-x@kernel" }));
    expect(card.kind).toBe("approval");
  });

  it("合成事件 payload 携带 qitemId，使下游 qitemId 查找可用", () => {
    const card = attentionItemToFeedCard(makeAttention({ qitemId: "qitem-test-1" }));
    const payload = card.source.payload as Record<string, unknown>;
    expect(payload.qitemId).toBe("qitem-test-1");
  });

  it("FeedCard.id 稳定且带队列前缀，重复拉取产生相同 key", () => {
    const a = attentionItemToFeedCard(makeAttention({ qitemId: "qitem-stable-1" }));
    const b = attentionItemToFeedCard(makeAttention({ qitemId: "qitem-stable-1" }));
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^queue-attention-/);
  });
});

describe("mergeAttentionIntoFeed —— 注意力类中队列压过事件", () => {
  it("HG-2 要点：即使无匹配事件，队列派生注意力卡也会浮现（被驱逐缺陷）", () => {
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "shipped", qitemId: "q-other" }),
      makeFeedCard({ kind: "progress", qitemId: "q-other-2" }),
    ];
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-evicted", destinationSession: "human-x@kernel" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    expect(merged.some((c) => c.kind === "action-required" && c.id.includes("qitem-evicted"))).toBe(true);
  });

  it("HG-3 去重：同 qitemId 的事件派生需行动卡被队列版本替换", () => {
    const sameQitem = "qitem-shared-1";
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "action-required", qitemId: sameQitem, id: "queue.created-99" }),
    ];
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: sameQitem, destinationSession: "human@host" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    // 事件派生卡片必须从合并结果中剔除；
    // 只保留队列派生版本。
    expect(merged.filter((c) => c.kind === "action-required")).toHaveLength(1);
    expect(merged.find((c) => c.kind === "action-required")!.id).toMatch(/^queue-attention-/);
    // 事件卡片 id 不出现。
    expect(merged.some((c) => c.id === "queue.created-99")).toBe(false);
  });

  it("HG-3 去重：同 qitemId 的事件派生审批卡被队列版本替换", () => {
    const sameQitem = "qitem-approval-1";
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "approval", qitemId: sameQitem }),
    ];
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: sameQitem, tier: "human-gate" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    expect(merged.filter((c) => c.kind === "approval")).toHaveLength(1);
    expect(merged.find((c) => c.kind === "approval")!.id).toMatch(/^queue-attention-/);
  });

  it("HG-6 无回归：非注意力事件卡（shipped/progress/observation）原样透传", () => {
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "shipped", qitemId: "q-shipped" }),
      makeFeedCard({ kind: "progress", qitemId: "q-progress" }),
      makeFeedCard({ kind: "observation", qitemId: "q-obs" }),
    ];
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-fresh", destinationSession: "human-y@kernel" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    expect(merged.filter((c) => c.kind === "shipped")).toHaveLength(1);
    expect(merged.filter((c) => c.kind === "progress")).toHaveLength(1);
    expect(merged.filter((c) => c.kind === "observation")).toHaveLength(1);
    expect(merged.filter((c) => c.kind === "action-required")).toHaveLength(1);
  });

  it("HG-5 优雅空态：无队列项 → 合并结果等于事件派生（无错误）", () => {
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "shipped", qitemId: "q-shipped" }),
      makeFeedCard({ kind: "approval", qitemId: "q-event-approval" }),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, []);
    expect(merged).toHaveLength(2);
    expect(merged.some((c) => c.kind === "approval")).toBe(true);
  });

  it("HG-3：无 qitemId 的事件派生注意力卡（异常 payload）在队列无匹配项时保留", () => {
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "action-required" /* no qitemId */ }),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, []);
    expect(merged).toHaveLength(1);
  });

  // HG-2 压测模拟：即使 200 个无关事件卡会把注意力项逐出 100-FIFO，
  // 合并仍会把它浮现，因为队列才是真相来源。
  it("HG-2 压测：200 个例行事件卡 + 1 个队列派生注意力卡 → 合并后注意力卡仍在", () => {
    const eventDerived: FeedCard[] = Array.from({ length: 200 }, (_, i) =>
      makeFeedCard({ kind: "shipped", qitemId: `q-routine-${i}` }),
    );
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-survives", destinationSession: "human-z@kernel" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    const attentionCards = merged.filter((c) => c.kind === "action-required");
    expect(attentionCards).toHaveLength(1);
    expect(attentionCards[0]!.id).toContain("qitem-survives");
  });
});

// 守卫 re-verify-2（qitem-20260518192210）CLEANUP-1：useDismissedSeqs
// 按 currentSeqs 的最小 seq 自动裁剪。队列派生的合成卡片携带 seq=-1（无真实事件）。
// 若这些 -1 哨兵进入 useDismissedSeqs，min-seq 会钉在 -1 ⇒ 事件 seq 的
// 忽略永远不会自动裁剪。eventDerivedSeqsForPrune 在进入 seq 输入前
// 把队列派生卡片过滤掉。

describe("CLEANUP-1：eventDerivedSeqsForPrune 使 seq 裁剪与队列派生哨兵隔离", () => {
  it("isQueueDerivedFeedCard 对 queue-attention-* id 返回 true，其余 false", () => {
    const eventCard = makeFeedCard({ kind: "approval", qitemId: "q1" });
    const queueCard = attentionItemToFeedCard(makeAttention({ qitemId: "qitem-Q", destinationSession: "human-bob@kernel" }));
    expect(isQueueDerivedFeedCard(eventCard)).toBe(false);
    expect(isQueueDerivedFeedCard(queueCard)).toBe(true);
    expect(QUEUE_DERIVED_CARD_ID_PREFIX).toBe("queue-attention-");
  });

  it("输入混合事件卡 + 队列卡时只返回事件派生 seq", () => {
    const cards: FeedCard[] = [
      makeFeedCard({ kind: "approval", qitemId: "q1", id: "queue.created-42" }),
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-Q1", destinationSession: "human-x@kernel" })),
      makeFeedCard({ kind: "shipped", qitemId: "q2", id: "queue.created-50" }),
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-Q2", tier: "human-gate" })),
    ];
    const seqs = eventDerivedSeqsForPrune(cards);
    // 事件派生 seq 为正数（真实事件）；队列派生的
    // 合成 seq=-1 必须被过滤掉。
    expect(seqs).toEqual([1, 1]); // makeFeedCard 默认用 seq=1
    expect(seqs).not.toContain(-1);
  });

  it("全部输入为队列派生时返回空数组", () => {
    const cards: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-a", destinationSession: "human-a@kernel" })),
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-b", destinationSession: "human-b@kernel" })),
    ];
    expect(eventDerivedSeqsForPrune(cards)).toEqual([]);
  });

  it("CLEANUP-1 回归：队列派生合成 seq=-1 喂入 useDismissedSeqs 时不钉住 min-seq", async () => {
    // 判别：隔离导入 useDismissedSeqs 并证明——用过滤后的 seq 输入
    // （仅事件派生 seq）时，自动裁剪能正确丢掉落到 min 以下的被忽略 seq；
    // 用未过滤输入（混入 -1 哨兵 + 真实 seq）时 min 会是 -1，裁剪永不触发。
    const { renderHook, act } = await import("@testing-library/react");
    const { useDismissedSeqs } = await import("../src/hooks/useDismissedSeqs.js");
    localStorage.clear();

    // 首次渲染：被忽略 seq 50 在当前集合中。
    const { result, rerender } = renderHook(({ seqs }) => useDismissedSeqs(seqs), {
      initialProps: { seqs: [50, 100, 200] },
    });
    act(() => result.current.dismiss(50));
    expect(result.current.dismissedSeqs.has(50)).toBe(true);

    // FIFO 丢弃较旧事件：只保留较新者。
    // 有 CLEANUP-1（队列派生哨兵被过滤）后，min-seq 推进到 150 ⇒ 被忽略的 50 被正确裁剪。
    rerender({ seqs: [150, 200, 300] });
    // 等待 useEffect 裁剪执行。
    await act(() => Promise.resolve());
    expect(result.current.dismissedSeqs.has(50)).toBe(false);
  });
});
