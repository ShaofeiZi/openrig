// V1 第 3 阶段尝试 3 —— MissionStatusBadge，依据 project-tree.md L132–L133（SC-26）。
//
// 状态派生自 `PROGRESS.md` 的 frontmatter 或顶层 `status:` 字段。
// 不涉及后台服务；沿用 OpenRig 对切片和任务目标采用的"文件系统即真相"模式。
// V1 将状态作为外部传入的 prop（调用方在第 3 阶段及以后通过专用 hook
// 或后续后台服务从 PROGRESS.md 解析）；本组件只负责渲染徽章。

import * as React from "react";
import { cn } from "../lib/utils.js";

// VM-005（release-0.4.7）：删除 "unknown" —— 任务目标状态永远不是真正不可知的
//（每个派生输入都是已知的），因此每个状态都使用如实的词。新增已知状态：
// idle（切片存在，但当前没有正在推进的，且未全部完成）·
// empty（零切片 —— 结构上仅用于树形展示）·
// draft（全草稿任务目标）。标签和配色可由创始者重新命名，无需改动逻辑。
export type MissionStatus =
  | "active"
  | "paused"
  | "shipped"
  | "blocked"
  | "idle"
  | "empty"
  | "draft";

/** MissionStatus 的中文展示标签（不改变枚举值本身）。 */
const MISSION_STATUS_LABEL_ZH: Record<MissionStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  shipped: "已发布",
  blocked: "已阻塞",
  idle: "空闲",
  empty: "空",
  draft: "草稿",
};

export interface MissionStatusBadgeProps {
  status: MissionStatus;
  label?: string;
  className?: string;
  testId?: string;
}

const toneClass: Record<MissionStatus, string> = {
  active: "border-success text-success",
  paused: "border-outline text-on-surface-variant",
  shipped: "border-secondary text-secondary",
  blocked: "border-warning text-warning",
  idle: "border-outline-variant text-on-surface-variant",
  empty: "border-outline-variant text-on-surface-variant",
  draft: "border-outline text-on-surface-variant",
};

const toneDot: Record<MissionStatus, string> = {
  active: "bg-success",
  paused: "bg-outline-variant",
  shipped: "bg-secondary",
  blocked: "bg-warning",
  idle: "bg-surface-highest",
  empty: "bg-surface-highest",
  draft: "bg-outline-variant",
};

export function MissionStatusBadge({
  status,
  label,
  className,
  testId,
}: MissionStatusBadgeProps) {
  return (
    <span
      data-testid={testId ?? `mission-status-${status}`}
      role="status"
      // 可见文本为中文标签；无自定义 label 时读屏须念与视觉一致的中文，
      // 而非英文枚举（机器枚举值本身不变，仅可访问名称对齐展示文本）。
      aria-label={label ?? MISSION_STATUS_LABEL_ZH[status]}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[9px] uppercase tracking-wide",
        toneClass[status],
        className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full", toneDot[status])} aria-hidden="true" />
      {label ?? MISSION_STATUS_LABEL_ZH[status]}
    </span>
  );
}

/**
 * 从 PROGRESS.md frontmatter 内容中解析任务目标的 `status:` 字段。
 * 若文件内容无法解析或未找到 status 字段，返回 "unknown"。
 *
 * VM-005：这个 PROGRESS.md 家族在本地扩大了自身返回值范围 —— "unknown"
 * 不再是 MissionStatus（徽章表面走的是 project-mission-state.ts 中已对齐的来源）。
 * SC-26 的"PROGRESS.md 是任务目标状态的真相来源"对于任务目标状态徽章而言
 * 已被 VM-005 FR-1（以作者撰写的 README frontmatter 为准）取代；
 * 它仍作用于"进度标签页/侧边栏"范围，本解析家族仍在为该范围服务。
 */
export function parseMissionStatus(
  progressMdContent: string | null | undefined,
): MissionStatus | "unknown" {
  if (!progressMdContent) return "unknown";
  // 匹配文件顶部 YAML frontmatter 中的 status 字段。
  const fmMatch = progressMdContent.match(/^---\s*\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch?.[1] ?? progressMdContent;
  const statusMatch = frontmatter.match(/^\s*status:\s*([a-z_-]+)\s*$/im);
  const raw = statusMatch?.[1]?.toLowerCase() ?? "";
  if (raw === "active" || raw === "in_progress" || raw === "in-progress")
    return "active";
  if (raw === "paused" || raw === "on_hold" || raw === "on-hold") return "paused";
  if (raw === "shipped" || raw === "complete" || raw === "completed" || raw === "done")
    return "shipped";
  if (raw === "blocked" || raw === "stalled") return "blocked";
  return "unknown";
}
