// OPR.0.4.1.27 —— 选项 B 的层级控制。
//
// 经创始人批准的控制方案把 feed.subscriptions 的 5 个开关重组为一个
// 自然语言层级（分段控件：「全部活动 / 重点 / 需要你处理」）。
// 它是在既有开关模型之上的展示层——不改变模型。
//
// action_required 被强制开启（下限；见 useFeedSubscriptions），不属于任何层级预设。
// 一个层级只重组 4 个可开关种类。底层 5 个独立开关保留（高级视图）；
// 不匹配任何预设的开关组合派生为「自定义」。
import type { FeedSubscriptionState } from "../hooks/useFeedSubscriptions.js";

export type FeedLevel = "needs-you" | "highlights" | "all-activity";
export type DerivedLevel = FeedLevel | "custom";

// 从最窄（仅行动项）到最宽（全部）排序。
export const FEED_LEVELS: readonly FeedLevel[] = [
  "needs-you",
  "highlights",
  "all-activity",
] as const;

// 4 个可开关种类（action_required 被下限开启，永不出现在此）。
export type LevelToggles = Pick<
  FeedSubscriptionState,
  "approvals" | "shipped" | "progress" | "auditLog"
>;

const PRESETS: Record<FeedLevel, LevelToggles> = {
  // 只保留需要你处理的内容——仅行动项。
  "needs-you": { approvals: false, shipped: false, progress: false, auditLog: false },
  // 重点（默认）——加上 批准/已交付/进展；隐藏审计日志噪声。
  "highlights": { approvals: true, shipped: true, progress: true, auditLog: false },
  // 全部活动——一切，含审计日志（观察）。
  "all-activity": { approvals: true, shipped: true, progress: true, auditLog: true },
};

/** 指定层级对应的开关集合（排除 action_required——它被下限开启）。 */
export function levelToToggles(level: FeedLevel): LevelToggles {
  return { ...PRESETS[level] };
}

/** 反向：当前开关状态匹配哪个命名层级（若有）；否则为 "custom"。 */
export function deriveLevel(state: FeedSubscriptionState): DerivedLevel {
  for (const level of FEED_LEVELS) {
    const p = PRESETS[level];
    if (
      state.approvals === p.approvals &&
      state.shipped === p.shipped &&
      state.progress === p.progress &&
      state.auditLog === p.auditLog
    ) {
      return level;
    }
  }
  return "custom";
}

/** 选项 B 分段控件的人类可读层级标签。 */
export const FEED_LEVEL_LABELS: Record<FeedLevel, string> = {
  "all-activity": "全部活动",
  "highlights": "重点",
  "needs-you": "需要你处理",
};
