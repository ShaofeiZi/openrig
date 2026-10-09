// PL-019：共享的活动状态视觉映射。RigNode（图上圆点）与 Explorer（树行图标）共用，
// 让操作者在各界面看到一致的配色。设计指导来自 orch（2026-05-04）：
//
//   running     温暖的绿/青色静态 + 极轻微的缓慢呼吸
//   needs_input 琥珀色，唯一需要抢眼的状态
//   idle        平静冷色静态（蓝灰），无动画
//   unknown     去饱和灰，无动画
//
// startupStatus（failed / attention_required）是另一条信号，仍由 RigNode 上既有的
// ATTN/FAILED 角标呈现——活动色回答“这个智能体在工作吗？”，启动色回答“这个智能体启动了吗？”。
// 二者不是同一个问题。

import type { AgentActivitySummary, SeatIdentityVerdictSummary } from "../hooks/useNodeInventory.js";

export type ActivityState = "running" | "needs_input" | "idle" | "unknown";

/**
 * OPR.0.4.3.19 —— 存活身份判定为 `mismatch`/`pane_missing` 时，把该席位从任何
 * active/running 渲染中降级（窗格内的进程并非注册席位：已死、孤儿或被抢占）。
 * `verified`、`tmux_unavailable` 以及缺失判定均不改变投影。与后台服务
 * identityVerdictDownranksRunning 闸门保持一致，使前后端对“不出现假绿色”口径统一。
 */
export function identityVerdictDownranksRunning(
  verdict: SeatIdentityVerdictSummary | null | undefined,
): boolean {
  return verdict?.verdict === "mismatch" || verdict?.verdict === "pane_missing";
}

// 展示用活动标签：状态枚举值保持英文，这里仅映射为面向操作者的中文标签。
const ACTIVITY_LABELS: Record<ActivityState, string> = {
  running: "运行中",
  needs_input: "待输入",
  idle: "空闲",
  unknown: "未知",
};

// Tailwind 工具类——刻意沿用 RigNode 与 Explorer 既有的 stone/emerald 配色，
// 不另立品牌色。running 用 emerald-500（暖绿）；needs_input 用 amber-500（抢眼色）；
// idle 用 slate-400（冷蓝灰）；unknown 用 stone-300（去饱和、可忽略）。
const ACTIVITY_BG_CLASSES: Record<ActivityState, string> = {
  running: "bg-emerald-500",
  needs_input: "bg-amber-500",
  idle: "bg-slate-400",
  unknown: "bg-stone-300",
};

const ACTIVITY_TEXT_CLASSES: Record<ActivityState, string> = {
  running: "text-emerald-600",
  needs_input: "text-amber-600",
  idle: "text-slate-500",
  unknown: "text-stone-400",
};

export type ActivitySource = "hook" | "terminal_activity" | "pane_heuristic" | "none";

export interface ActivityStateResult {
  state: ActivityState;
  source: ActivitySource;
}

export function getActivityState(
  activity: AgentActivitySummary | null | undefined,
  terminalActive?: boolean | null,
  identityVerdict?: SeatIdentityVerdictSummary | null,
): ActivityState {
  return getActivityStateWithSource(activity, terminalActive, identityVerdict).state;
}

export function getActivityStateWithSource(
  activity: AgentActivitySummary | null | undefined,
  terminalActive?: boolean | null,
  identityVerdict?: SeatIdentityVerdictSummary | null,
): ActivityStateResult {
  // OPR.0.4.3.19 —— 身份判定优先于输出来源的活动。窗格失配/已死时绝不能渲染为
  // active/running，哪怕（孤儿进程的）tmux 输出让 terminalActive 为真——那就是此前
  // 肉眼可见的假绿色。因此在 hook/终端活动信号之前最先检查。
  if (identityVerdictDownranksRunning(identityVerdict)) {
    return { state: "needs_input", source: "none" };
  }

  const isFreshHook = activity
    && activity.evidenceSource === "runtime_hook"
    && activity.state !== "unknown"
    && !activity.stale
    && !activity.fallback;

  if (isFreshHook) {
    return { state: activity!.state, source: "hook" };
  }
  if (activity?.state === "needs_input" && activity.evidenceSource === "pane_heuristic") {
    return { state: "needs_input", source: "pane_heuristic" };
  }
  if (terminalActive === true) return { state: "running", source: "terminal_activity" };
  if (terminalActive === false) return { state: "idle", source: "terminal_activity" };
  if (activity && activity.state !== "unknown" && activity.evidenceSource === "pane_heuristic") {
    return { state: activity.state, source: "pane_heuristic" };
  }
  if (activity && activity.state !== "unknown") {
    return { state: activity.state, source: "none" };
  }
  return { state: "unknown", source: "none" };
}

export function getActivityLabel(state: ActivityState): string {
  return ACTIVITY_LABELS[state];
}

export function getActivityBgClass(state: ActivityState): string {
  return ACTIVITY_BG_CLASSES[state];
}

export function getActivityTextClass(state: ActivityState): string {
  return ACTIVITY_TEXT_CLASSES[state];
}

// 仅 running 做轻微缓慢呼吸（约 2 秒周期、低透明度幅度）；needs_input 用静态更强色
// （需求里明确 needs_input 要抢眼，但保持不闪烁，避免自相干扰）。
export function getActivityAnimationClass(state: ActivityState): string {
  if (state === "running") return "activity-pulse-running";
  return "";
}

// 过期角标阈值：超过约 30 秒未更新的活动样本会显示一个小的弱化指示，
// 因为陈旧的活动样本可能误导判断。阈值由驱动方决定；PL-019 规划约 30 秒作为操作者可感知的边界。
const STALENESS_THRESHOLD_SECONDS = 30;

export function isActivityStale(activity: AgentActivitySummary | null | undefined): boolean {
  if (!activity) return false;
  // 并非每条探测路径都接入了 staleness 字段；缺失时退化为按 sampledAt 计算时间差。
  if (typeof activity.staleness === "number") {
    return activity.staleness > STALENESS_THRESHOLD_SECONDS;
  }
  if (!activity.sampledAt) return false;
  const sampled = Date.parse(activity.sampledAt);
  if (Number.isNaN(sampled)) return false;
  const ageSeconds = (Date.now() - sampled) / 1000;
  return ageSeconds > STALENESS_THRESHOLD_SECONDS;
}

// 用于悬浮提示的 ULID 短尾；完整 id 仍可在抽屉里查看。
export function shortQitemTail(qitemId: string): string {
  if (qitemId.length <= 8) return qitemId;
  return qitemId.slice(-8);
}

export function getTimeInState(activity: AgentActivitySummary | null | undefined): { seconds: number; label: string } | null {
  if (!activity) return null;
  const ts = activity.eventAt ?? activity.sampledAt;
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  return { seconds, label: formatDuration(seconds) };
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hours < 24) return remainMins > 0 ? `${hours}时${remainMins}分` : `${hours}时`;
  const days = Math.floor(hours / 24);
  return `${days}天`;
}

export function isHookGradeNeedsInput(result: ActivityStateResult): boolean {
  return result.state === "needs_input" && result.source === "hook";
}

export interface ActivityRollup {
  working: number;
  idle: number;
  needsInput: number;
  needsInputHookGrade: number;
  unknown: number;
  total: number;
}

export function computeActivityRollup(
  items: Array<{ activity: AgentActivitySummary | null | undefined; terminalActive?: boolean | null }>,
): ActivityRollup {
  const rollup: ActivityRollup = { working: 0, idle: 0, needsInput: 0, needsInputHookGrade: 0, unknown: 0, total: items.length };
  for (const item of items) {
    const result = getActivityStateWithSource(item.activity, item.terminalActive);
    switch (result.state) {
      case "running": rollup.working++; break;
      case "idle": rollup.idle++; break;
      case "needs_input":
        rollup.needsInput++;
        if (result.source === "hook") rollup.needsInputHookGrade++;
        break;
      case "unknown": rollup.unknown++; break;
    }
  }
  return rollup;
}

export function formatRollupLabel(rollup: ActivityRollup): string {
  const parts: string[] = [];
  if (rollup.working > 0) parts.push(`${rollup.working} 运行中`);
  if (rollup.idle > 0) parts.push(`${rollup.idle} 空闲`);
  if (rollup.needsInputHookGrade > 0) parts.push(`${rollup.needsInputHookGrade} 需要你处理`);
  const paneNeedsInput = rollup.needsInput - rollup.needsInputHookGrade;
  if (paneNeedsInput > 0) parts.push(`${paneNeedsInput} 待输入（活动级）`);
  if (rollup.unknown > 0) parts.push(`${rollup.unknown} 未知`);
  return parts.join(" · ") || "无席位";
}
