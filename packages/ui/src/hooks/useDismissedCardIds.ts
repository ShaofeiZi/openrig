// OPR.0.3.2.20——为队列派生的待关注卡片提供字符串键忽略机制。它与 useDismissedSeqs
// 并行；后者以事件 seq 为键，并按活动 FIFO 单调增长的最小 seq 自动清理。队列派生的
// 合成 FeedCard 没有唯一事件 seq（合成 ActivityEvent.seq = -1），因此沿用以 seq 为键的
// 忽略机制会让所有队列派生卡片发生冲突——忽略一张卡会连带隐藏其他所有待关注卡片。
//
// 此钩子以稳定的字符串 FeedCard.id（如 `queue-attention-<qitemId>`）为键，根据其是否
// 属于当前 id 集合进行清理（qitem 关闭、卡片消失后，对应忽略记录也删除），并持久化到
// 独立的 localStorage 命名空间，因此不会影响基于事件 seq 的忽略记录。

import { useCallback, useEffect, useMemo, useState } from "react";

export const DISMISSED_CARD_IDS_STORAGE_KEY = "forYou.dismissedCardIds";

function readDismissedFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_CARD_IDS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const strings = parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
    return new Set(strings);
  } catch {
    return new Set();
  }
}

function writeDismissedToStorage(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // localStorage 可能不可用；忽略异常。
  }
}

export interface UseDismissedCardIdsResult {
  dismissedIds: Set<string>;
  dismiss(id: string): void;
  undismiss(id: string): void;
}

/**
 * @param currentIds 当前渲染集合中所有卡片的 id，用于自动清理：卡片 id 不再存在时
 *   （qitem 已关闭/已交接），删除对应忽略记录，避免 localStorage 集合无限增长。
 */
export function useDismissedCardIds(currentIds: string[]): UseDismissedCardIdsResult {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => readDismissedFromStorage());

  const currentSet = useMemo(() => new Set(currentIds), [currentIds]);

  useEffect(() => {
    if (currentSet.size === 0) return;
    let changed = false;
    const next = new Set<string>();
    for (const id of dismissedIds) {
      if (currentSet.has(id)) {
        next.add(id);
      } else {
        changed = true;
      }
    }
    if (changed) {
      setDismissedIds(next);
      writeDismissedToStorage(next);
    }
  }, [currentSet, dismissedIds]);

  const dismiss = useCallback((id: string) => {
    setDismissedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      writeDismissedToStorage(next);
      return next;
    });
  }, []);

  const undismiss = useCallback((id: string) => {
    setDismissedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      writeDismissedToStorage(next);
      return next;
    });
  }, []);

  return { dismissedIds, dismiss, undismiss };
}
