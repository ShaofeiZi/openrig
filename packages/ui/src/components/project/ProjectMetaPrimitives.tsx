import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Ban,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  CirclePlus,
  Clock,
  ClipboardCheck,
  GitBranch,
  History,
  Inbox,
  MessageSquareText,
  PackageCheck,
  RotateCcw,
  Route,
  Send,
  UserCheck,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { parseSessionName } from "../../lib/session-name.js";
import { proofAssetUrl } from "../../hooks/useSlices.js";
import { ActorMark, ToolMark } from "../graphics/RuntimeMark.js";

export type ProjectMetaTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface ProjectToken {
  label: string;
  tone: ProjectMetaTone;
  icon?: LucideIcon;
}

const toneClass: Record<ProjectMetaTone, string> = {
  neutral: "border-outline-variant bg-surface-lowest/55 text-on-surface",
  info: "border-sky-300 bg-sky-50/75 text-sky-800",
  success: "border-emerald-300 bg-emerald-50/75 text-emerald-800",
  warning: "border-amber-300 bg-amber-50/80 text-amber-800",
  danger: "border-rose-300 bg-rose-50/80 text-rose-800",
};

export const statusDotClass: Record<ProjectMetaTone, string> = {
  neutral: "border-outline bg-surface-highest",
  info: "border-sky-400 bg-sky-200",
  success: "border-emerald-500 bg-emerald-400",
  warning: "border-amber-400 bg-amber-300",
  danger: "border-rose-400 bg-rose-300",
};

export function eventToken(kind: string): ProjectToken {
  const normalized = kind.toLowerCase();
  if (normalized.includes("mission_control.action_executed")) {
    return { label: "人工决策", tone: "success", icon: ClipboardCheck };
  }
  if (normalized.includes("closure_overdue") || normalized.includes("overdue")) {
    return { label: "已逾期", tone: "danger", icon: CircleAlert };
  }
  if (normalized.includes("approval")) {
    return { label: "待审批", tone: "warning", icon: ClipboardCheck };
  }
  if (normalized.includes("human-gate") || normalized.includes("human")) {
    return { label: "人工操作", tone: "danger", icon: CircleAlert };
  }
  if (normalized.includes("inbox.denied")) {
    return { label: "收件箱已拒绝", tone: "danger", icon: Ban };
  }
  if (normalized.includes("inbox.absorbed")) {
    return { label: "收件箱已接收", tone: "success", icon: Inbox };
  }
  if (normalized.includes("shipped")) {
    return { label: "已交付", tone: "success", icon: PackageCheck };
  }
  if (normalized.includes("transition.done") || normalized.includes("transition.complete")) {
    return { label: "标记完成", tone: "success", icon: CheckCircle2 };
  }
  if (normalized.includes("transition.in-progress") || normalized.includes("transition.claim")) {
    return { label: "进行中", tone: "info", icon: Clock };
  }
  if (normalized.includes("transition.pending")) {
    return { label: "待处理", tone: "warning", icon: Clock };
  }
  if (normalized.includes("transition")) {
    return { label: "状态变更", tone: "neutral", icon: History };
  }
  if (normalized.includes("ship") || normalized.includes("done") || normalized.includes("complete")) {
    return { label: "已完成", tone: "success", icon: CheckCircle2 };
  }
  if (normalized.includes("unclaim")) {
    return { label: "已释放", tone: "neutral", icon: RotateCcw };
  }
  if (normalized.includes("claim")) {
    return { label: "已认领", tone: "info", icon: UserCheck };
  }
  if (normalized.includes("handoff") || normalized.includes("handed_off") || normalized.includes("routed")) {
    return { label: "移交", tone: "info", icon: Send };
  }
  if (normalized.includes("created")) {
    return { label: "已创建", tone: "info", icon: CirclePlus };
  }
  if (normalized.includes("queue.updated") || normalized.includes("queue.item.updated")) {
    return { label: "队列更新", tone: "neutral", icon: History };
  }
  if (normalized.includes("progress")) {
    return { label: "进展", tone: "info", icon: History };
  }
  return { label: humanizeCodeLabel(kind), tone: "neutral", icon: MessageSquareText };
}

export function queueStateToken(state: string | undefined | null): ProjectToken {
  const normalized = state?.toLowerCase().trim() ?? "";
  if (!normalized) return { label: "未知状态", tone: "neutral", icon: MessageSquareText };
  if (normalized.includes("closeout-pending-ratify")) {
    return { label: "等待审批", tone: "warning", icon: ClipboardCheck };
  }
  if (normalized.includes("human-gate") || normalized.includes("pending-approval")) {
    return { label: "需人工", tone: "danger", icon: CircleAlert };
  }
  if (normalized.includes("blocked") || normalized.includes("failed") || normalized.includes("error") || normalized.includes("denied")) {
    return { label: humanizeCodeLabel(state ?? ""), tone: "danger", icon: CircleAlert };
  }
  if (normalized.includes("handed-off") || normalized.includes("routed")) {
    return { label: "已路由", tone: "info", icon: Send };
  }
  if (normalized.includes("done") || normalized.includes("complete") || normalized.includes("closed") || normalized.includes("shipped")) {
    return { label: "完成", tone: "success", icon: CheckCircle2 };
  }
  if (normalized.includes("in-progress") || normalized.includes("running") || normalized.includes("claimed")) {
    return { label: "进行中", tone: "info", icon: UserCheck };
  }
  if (normalized.includes("pending") || normalized.includes("open") || normalized.includes("queued")) {
    return { label: "待处理", tone: "warning", icon: Clock };
  }
  if (normalized.includes("canceled") || normalized.includes("cancelled") || normalized.includes("stopped")) {
    return { label: humanizeCodeLabel(state ?? ""), tone: "neutral", icon: Ban };
  }
  return { label: humanizeCodeLabel(state ?? ""), tone: "neutral", icon: History };
}

export function scopeToken(scope: "workspace" | "mission" | "slice"): ProjectToken {
  if (scope === "workspace") return { label: "工作区", tone: "neutral", icon: Route };
  if (scope === "mission") return { label: "任务", tone: "info", icon: GitBranch };
  return { label: "切片", tone: "success", icon: MessageSquareText };
}

export function stateTone(state: string | undefined): ProjectMetaTone {
  const normalized = state?.toLowerCase() ?? "";
  if (normalized.includes("done") || normalized.includes("complete") || normalized.includes("closed")) return "success";
  if (normalized.includes("fail") || normalized.includes("blocked") || normalized.includes("overdue")) return "danger";
  if (normalized.includes("pending") || normalized.includes("human") || normalized.includes("approval")) return "warning";
  if (normalized.includes("progress") || normalized.includes("claim")) return "info";
  return "neutral";
}

export function sliceStatusTone(state: string | undefined): ProjectMetaTone {
  const normalized = state?.toLowerCase() ?? "";
  if (normalized === "active" || normalized === "in-flight") return "info";
  return stateTone(state);
}

/** 仅本地化已知的 slice 展示状态；未知扩展值原样保留，避免改写协议语义。 */
export function sliceStatusLabel(state: string | undefined): string {
  switch (state?.toLowerCase()) {
    case "active": return "进行中";
    case "done": return "已完成";
    case "blocked": return "已阻塞";
    case "draft": return "草稿";
    default: return state ?? "未知";
  }
}

const REVIEW_LEG_LABELS: Record<string, string> = {
  attention: "待关注",
  exception: "异常",
  overdue: "已逾期",
  stuck: "卡住",
  awareness: "需留意",
  anomaly: "异常",
  "insufficient-proof": "证明不足",
  "stale-after-change": "变更后已过期",
  "workflow-failed": "工作流失败",
  "park-on-human": "等待人工",
  "human-routed": "已路由给人工",
  "confirm-faithful": "待如实确认",
};

const REVIEW_PRIORITY_LABELS: Record<string, string> = {
  urgent: "紧急",
  routine: "常规",
};

export function reviewLegLabel(value: string): string {
  return REVIEW_LEG_LABELS[value] ?? value;
}

export function reviewPriorityLabel(value: string | null): string | null {
  return value ? REVIEW_PRIORITY_LABELS[value] ?? value : null;
}

export function humanizeCodeLabel(value: string): string {
  return value
    .replace(/[_./-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

export function compactSessionLabel(session: string | undefined | null): string {
  if (!session) return "未知";
  if (session === "human@host") return "human@host";
  // OPR.0.4.6.MH1 FR-8：共享解析契约（贪婪取第一个 @ 后的 rig——
  // 不对第二个 @ 之后的内容做静默截断）。
  const parsed = parseSessionName(session);
  if (parsed.kind !== "canonical") return session;
  return `${parsed.member}@${parsed.rig}`;
}

export function formatFriendlyDate(value: string | undefined | null): string {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return `今天 ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function ProjectPill({
  token,
  compact = false,
  testId,
  className,
}: {
  token: ProjectToken;
  compact?: boolean;
  testId?: string;
  className?: string;
}) {
  const Icon = token.icon;
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1 border font-mono uppercase tracking-[0.10em]",
        compact ? "px-1.5 py-0.5 text-[8px]" : "px-2 py-1 text-[9px]",
        toneClass[token.tone],
        className,
      )}
    >
      {Icon ? <Icon className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} strokeWidth={1.6} /> : null}
      {token.label}
    </span>
  );
}

export function EventBadge({ kind, compact, testId }: { kind: string; compact?: boolean; testId?: string }) {
  return <ProjectPill token={eventToken(kind)} compact={compact} testId={testId} />;
}

export function QueueStateBadge({ state, compact, testId }: { state: string | undefined | null; compact?: boolean; testId?: string }) {
  return <ProjectPill token={queueStateToken(state)} compact={compact} testId={testId} />;
}

export function QueueCountIcon({
  count,
  testId,
}: {
  count: number;
  testId?: string;
}) {
  const label = `${count} 个队列项`;
  return (
    <span
      data-testid={testId}
      title={label}
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-1 border border-outline-variant bg-surface-lowest/45 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-on-surface-variant"
    >
      <Inbox className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
      <span>{count}</span>
    </span>
  );
}

export function StatusDot({
  tone,
  label,
  testId,
}: {
  tone: ProjectMetaTone;
  label: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      title={label}
      aria-label={label}
      role="img"
      className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full border", statusDotClass[tone])}
    />
  );
}

export function TagPill({ tag, compact = true }: { tag: string; compact?: boolean }) {
  const tone: ProjectMetaTone =
    /urgent|blocked|human/i.test(tag) ? "danger" :
    /proof|pass|done|ship/i.test(tag) ? "success" :
    /cycle|phase|qa|review/i.test(tag) ? "info" :
    "neutral";
  return <ProjectPill token={{ label: tag, tone }} compact={compact} />;
}

export function ActorChip({
  session,
  muted,
}: {
  session: string | undefined | null;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 border px-1.5 py-0.5 font-mono text-[9px]",
        muted ? "border-outline-variant bg-surface-lowest/35 text-on-surface-variant" : "border-outline-variant bg-surface-lowest/55 text-on-surface",
      )}
    >
      <ActorMark actor={session} size="xs" decorative />
      <span className="truncate">{compactSessionLabel(session)}</span>
    </span>
  );
}

export function DateChip({ value }: { value: string | undefined | null }) {
  return (
    <time
      dateTime={value ?? undefined}
      className="inline-flex items-center gap-1 border border-outline-variant bg-surface-lowest/45 px-1.5 py-0.5 font-mono text-[9px] text-on-surface-variant"
    >
      <CalendarDays className="h-3 w-3" strokeWidth={1.5} />
      {formatFriendlyDate(value)}
    </time>
  );
}

export function FlowChips({
  source,
  destination,
  muted,
}: {
  source?: string | null;
  destination?: string | null;
  muted?: boolean;
}) {
  if (!source && !destination) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ActorChip session={source ?? "未知来源"} muted={muted} />
      <ArrowRight className="h-3.5 w-3.5 text-on-surface-variant" strokeWidth={1.4} />
      <ActorChip session={destination ?? "未解析目标"} muted={muted} />
    </div>
  );
}

export function ProofThumbnailGrid({
  sliceName,
  screenshots,
  onSelect,
  max = 4,
  testIdPrefix,
}: {
  sliceName: string;
  screenshots: string[];
  onSelect?: (relPath: string) => void;
  max?: number;
  testIdPrefix?: string;
}) {
  if (screenshots.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {screenshots.slice(0, max).map((rel) => {
        const image = (
          <img
            data-testid={testIdPrefix ? `${testIdPrefix}-${rel}` : undefined}
            src={proofAssetUrl(sliceName, rel)}
            alt={rel}
            className="h-24 w-full border border-outline-variant bg-surface-low object-cover"
            loading="lazy"
          />
        );
        if (!onSelect) return <div key={rel}>{image}</div>;
        return (
          <button
            key={rel}
            type="button"
            onClick={() => onSelect(rel)}
            className="group relative block w-full text-left focus:outline-none focus:ring-2 focus:ring-on-surface/20"
          >
            {image}
            <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 border border-amber-400/45 bg-surface-lowest/80 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.10em] text-amber-950 backdrop-blur-sm">
              <ToolMark tool={rel} size="xs" decorative />
              校验图
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ProofPacketHeader({
  title,
  badge,
}: {
  title: string;
  badge: string;
}) {
  const badgeLabel = ({
    pass: "通过",
    fail: "失败",
    partial: "部分通过",
    unknown: "未知",
  } as Record<string, string>)[badge] ?? badge;
  return (
    <div className="flex items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
      <span className="truncate inline-flex items-center gap-1">
        <ToolMark tool="proof" size="xs" />
        {title}
      </span>
      <ProjectPill token={{ label: badgeLabel, tone: stateTone(badge) }} compact />
    </div>
  );
}
