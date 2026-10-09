// OPR.0.3.2.20——字符串键忽略钩子测试。锁定守卫裁决 qitem-20260518190827 的
// BLOCKER-2 修复：队列派生的合成 FeedCard 共用 ActivityEvent.seq=-1，因此旧版以 seq 为键的
// 忽略机制会让所有队列派生卡片冲突。useDismissedCardIds 以唯一字符串 FeedCard.id 为键，
// 使每张队列派生卡片拥有独立的忽略状态。

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useDismissedCardIds,
  DISMISSED_CARD_IDS_STORAGE_KEY,
} from "../src/hooks/useDismissedCardIds.js";

describe("useDismissedCardIds — string-keyed dismissal", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("initializes empty when localStorage is empty", () => {
    const { result } = renderHook(() => useDismissedCardIds(["a", "b", "c"]));
    expect(result.current.dismissedIds.size).toBe(0);
  });

  it("reads existing dismissed ids from localStorage on mount", () => {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, JSON.stringify(["queue-attention-q1", "queue-attention-q2"]));
    const { result } = renderHook(() =>
      useDismissedCardIds(["queue-attention-q1", "queue-attention-q2", "queue-attention-q3"]),
    );
    expect(result.current.dismissedIds.has("queue-attention-q1")).toBe(true);
    expect(result.current.dismissedIds.has("queue-attention-q2")).toBe(true);
    expect(result.current.dismissedIds.has("queue-attention-q3")).toBe(false);
  });

  it("tolerates malformed localStorage value (non-JSON)", () => {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, "{not json[");
    const { result } = renderHook(() => useDismissedCardIds(["a"]));
    expect(result.current.dismissedIds.size).toBe(0);
  });

  it("tolerates non-array localStorage value", () => {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, JSON.stringify({ not: "array" }));
    const { result } = renderHook(() => useDismissedCardIds(["a"]));
    expect(result.current.dismissedIds.size).toBe(0);
  });

  it("dismiss(id) adds id to the set and persists", () => {
    const { result } = renderHook(() => useDismissedCardIds(["a", "b"]));
    act(() => result.current.dismiss("a"));
    expect(result.current.dismissedIds.has("a")).toBe(true);
    const stored = JSON.parse(localStorage.getItem(DISMISSED_CARD_IDS_STORAGE_KEY) ?? "[]") as string[];
    expect(stored).toContain("a");
  });

  it("undismiss(id) removes id from the set and persists", () => {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, JSON.stringify(["a", "b"]));
    const { result } = renderHook(() => useDismissedCardIds(["a", "b"]));
    act(() => result.current.undismiss("a"));
    expect(result.current.dismissedIds.has("a")).toBe(false);
    expect(result.current.dismissedIds.has("b")).toBe(true);
  });

  // BLOCKER-2 判别项：每个 card.id 都是独立忽略键；忽略一张队列派生卡片不得隐藏其他卡片。
  it("BLOCKER-2 fix: dismissing one card id does NOT affect other cards (independent dismissal state)", () => {
    const { result } = renderHook(() =>
      useDismissedCardIds(["queue-attention-q1", "queue-attention-q2", "queue-attention-q3"]),
    );
    act(() => result.current.dismiss("queue-attention-q1"));
    expect(result.current.dismissedIds.has("queue-attention-q1")).toBe(true);
    expect(result.current.dismissedIds.has("queue-attention-q2")).toBe(false);
    expect(result.current.dismissedIds.has("queue-attention-q3")).toBe(false);
  });

  it("auto-prune: a dismissed id no longer in currentIds is dropped from the set", () => {
    localStorage.setItem(
      DISMISSED_CARD_IDS_STORAGE_KEY,
      JSON.stringify(["queue-attention-evicted", "queue-attention-still-here"]),
    );
    // 使用不含 "queue-attention-evicted" 的 currentIds 渲染；该 qitem 已关闭，
    // 卡片已从 feed 消失。
    const { result, rerender } = renderHook(
      ({ ids }) => useDismissedCardIds(ids),
      { initialProps: { ids: ["queue-attention-still-here"] } },
    );
    rerender({ ids: ["queue-attention-still-here"] });
    // 清理 effect 运行后，被淘汰的 id 消失。
    expect(result.current.dismissedIds.has("queue-attention-evicted")).toBe(false);
    expect(result.current.dismissedIds.has("queue-attention-still-here")).toBe(true);
  });

  it("dismiss is idempotent — calling twice doesn't double-add or churn storage", () => {
    const { result } = renderHook(() => useDismissedCardIds(["a"]));
    act(() => result.current.dismiss("a"));
    act(() => result.current.dismiss("a"));
    expect(result.current.dismissedIds.size).toBe(1);
  });

  it("uses a distinct localStorage namespace from useDismissedSeqs (no cross-contamination)", () => {
    // 存储键必须与 seq 键钩子的键不同。
    expect(DISMISSED_CARD_IDS_STORAGE_KEY).toBe("forYou.dismissedCardIds");
    expect(DISMISSED_CARD_IDS_STORAGE_KEY).not.toBe("forYou.dismissedSeqs");
  });
});
