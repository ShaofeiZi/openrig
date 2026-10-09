// Slice 18——“为你推荐”的逐卡片忽略状态，以事件 seq 作为软键。
//
// 被忽略的 seq 持久化到 localStorage，使同一操作员会话在重新加载后仍保持整洁。
// 一旦某条目的 seq 小于当前活动缓冲区中的最小 seq，就会自动清理；此时来源事件已过期，
// 被忽略条目不会再次出现，继续保存只会让集合无限增长。

import { useCallback, useEffect, useMemo, useState } from "react";

export const DISMISSED_SEQS_STORAGE_KEY = "forYou.dismissedSeqs";

function readDismissedFromStorage(): Set<number> {
  try {
    const raw = localStorage.getItem(DISMISSED_SEQS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const numbers = parsed.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return new Set(numbers);
  } catch {
    return new Set();
  }
}

function writeDismissedToStorage(seqs: Set<number>): void {
  try {
    localStorage.setItem(DISMISSED_SEQS_STORAGE_KEY, JSON.stringify(Array.from(seqs)));
  } catch {
    // localStorage 可能因隐私模式、配额等原因不可用；忽略异常。
  }
}

export interface UseDismissedSeqsResult {
  dismissedSeqs: Set<number>;
  dismiss(seq: number): void;
  undismiss(seq: number): void;
}

export function useDismissedSeqs(currentSeqs: number[]): UseDismissedSeqsResult {
  const [dismissedSeqs, setDismissedSeqs] = useState<Set<number>>(() => readDismissedFromStorage());

  const minCurrentSeq = useMemo(() => {
    if (currentSeqs.length === 0) return null;
    let min = currentSeqs[0]!;
    for (const seq of currentSeqs) {
      if (seq < min) min = seq;
    }
    return min;
  }, [currentSeqs]);

  useEffect(() => {
    if (minCurrentSeq === null) return;
    let changed = false;
    const next = new Set<number>();
    for (const seq of dismissedSeqs) {
      if (seq >= minCurrentSeq) {
        next.add(seq);
      } else {
        changed = true;
      }
    }
    if (changed) {
      setDismissedSeqs(next);
      writeDismissedToStorage(next);
    }
  }, [minCurrentSeq, dismissedSeqs]);

  const dismiss = useCallback((seq: number) => {
    setDismissedSeqs((prev) => {
      if (prev.has(seq)) return prev;
      const next = new Set(prev);
      next.add(seq);
      writeDismissedToStorage(next);
      return next;
    });
  }, []);

  const undismiss = useCallback((seq: number) => {
    setDismissedSeqs((prev) => {
      if (!prev.has(seq)) return prev;
      const next = new Set(prev);
      next.delete(seq);
      writeDismissedToStorage(next);
      return next;
    });
  }, []);

  return { dismissedSeqs, dismiss, undismiss };
}
