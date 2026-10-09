// Slice 18 §3.5 —— “入门指引”中“标记完成并隐藏”的本地状态。
//
// 沿用 useDismissedSeqs 的模式：用 localStorage 承载软状态，使“标记完成”能给操作者
// 即时的视觉反馈（任务从 storytelling 预览中消失）。后台服务侧的
// POST /api/missions/<id>/complete 会把任务 frontmatter 写入审计轨迹；
// 本 hook 只是界面上的乐观镜像。

import { useCallback, useState } from "react";

export const COMPLETED_MISSIONS_STORAGE_KEY = "forYou.completedMissionIds";

function readFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(COMPLETED_MISSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const ids = parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function writeToStorage(ids: Set<string>): void {
  try {
    localStorage.setItem(COMPLETED_MISSIONS_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // localStorage 不可用；静默吞掉。
  }
}

export interface UseCompletedMissionsResult {
  completedMissionIds: Set<string>;
  markCompleted(id: string): void;
  unmarkCompleted(id: string): void;
}

export function useCompletedMissions(): UseCompletedMissionsResult {
  const [completedMissionIds, setCompletedMissionIds] = useState<Set<string>>(() => readFromStorage());

  const markCompleted = useCallback((id: string) => {
    setCompletedMissionIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      writeToStorage(next);
      return next;
    });
  }, []);

  const unmarkCompleted = useCallback((id: string) => {
    setCompletedMissionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      writeToStorage(next);
      return next;
    });
  }, []);

  return { completedMissionIds, markCompleted, unmarkCompleted };
}
