import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { displayAgentName, inferPodName } from "../../lib/display-name.js";
import {
  getActivityAnimationClass,
  getActivityBgClass,
  getActivityLabel,
  getActivityStateWithSource,
  isActivityStale,
  getTimeInState,
} from "../../lib/activity-visuals.js";
import type { AgentActivitySummary, SeatIdentityVerdictSummary } from "../../hooks/useNodeInventory.js";
import { cn } from "../../lib/utils.js";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { ActivityRing } from "./ActivityRing.js";
import { getActivityCardClasses, getActivityCardSignal } from "./activity-card-visuals.js";
import { TerminalPreviewPopover } from "./TerminalPreviewPopover.js";
import type { TopologyActivityVisual } from "../../lib/topology-activity.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../../lib/token-format.js";
import { formatRuntimeModel } from "../../lib/runtime-brand.js";
import { RuntimeBadge, ToolMark } from "../graphics/RuntimeMark.js";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";

interface HybridPodGroupNodeData {
  podDisplayName?: string | null;
  podNamespace?: string | null;
  podId?: string | null;
  logicalId?: string | null;
  agentCount?: number;
}

interface HybridAgentNodeData {
  logicalId: string;
  role?: string | null;
  runtime?: string | null;
  model?: string | null;
  status?: string | null;
  nodeKind?: "agent" | "infrastructure";
  startupStatus?: "pending" | "ready" | "attention_required" | "failed" | null;
  canonicalSessionName?: string | null;
  resolvedSpecName?: string | null;
  profile?: string | null;
  contextUsedPercentage?: number | null;
  contextFresh?: boolean;
  contextAvailability?: string | null;
  contextTotalInputTokens?: number | null;
  contextTotalOutputTokens?: number | null;
  agentActivity?: AgentActivitySummary | null;
  terminalActive?: boolean | null;
  // OPR.0.4.3.19——活性身份判定；mismatch/pane_missing 覆盖 terminalActive，
  // 使圆点绝不渲染成 active/running 绿色。
  identityVerdict?: SeatIdentityVerdictSummary | null;
  currentQitems?: unknown[];
  rigId?: string | null;
  activityRing?: TopologyActivityVisual;
  reducedMotion?: boolean;
}

function isCoreRole(role: string | null | undefined): boolean {
  return role === "architect" || role === "lead" || role === "orchestrator";
}

function contextClass(percent: number | null | undefined, fresh: boolean | undefined): string {
  if (typeof percent !== "number") return "text-on-surface-variant";
  const tone = percent >= 80
    ? "text-red-600"
    : percent >= 60
      ? "text-amber-600"
      : "text-green-700";
  return fresh === false ? `${tone} opacity-50` : tone;
}

function HybridPodGroupNodeInner({ data }: { data: HybridPodGroupNodeData }) {
  const label = data.podDisplayName
    ?? data.podNamespace
    ?? inferPodName(data.logicalId ?? null)
    ?? data.podId
    ?? "Pod";
  return (
    <div
      data-testid="hybrid-pod-group-node"
      className="relative h-full w-full border border-dashed border-outline/55 bg-background/25"
    >
      <div className="absolute left-2 top-2 flex items-center gap-2 font-mono text-[9px] lowercase tracking-[0.02em] text-on-surface-variant">
        <span>{label}</span>
        {typeof data.agentCount === "number" ? (
          <span className="text-on-surface-variant">{data.agentCount}</span>
        ) : null}
      </div>
      <Handle type="target" position={Position.Left} className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Right} className="opacity-0 pointer-events-none" />
    </div>
  );
}

/** V0.3.1 bug-fix slice topology-perf——图 CPU 优化。Pod 组节点内容只依赖标签字段 +
 *  智能体数；data 引用在每次 topology-activity 跳动时都变化，但可见内容不变。
 *  按渲染器读取的字段做 memo。 */
export const HybridPodGroupNode = memo(
  HybridPodGroupNodeInner,
  (prev, next) => {
    const a = prev.data;
    const b = next.data;
    return (
      a.podDisplayName === b.podDisplayName &&
      a.podNamespace === b.podNamespace &&
      a.podId === b.podId &&
      a.logicalId === b.logicalId &&
      a.agentCount === b.agentCount
    );
  },
);
HybridPodGroupNode.displayName = "HybridPodGroupNode";

function HybridAgentNodeInner({ data }: { data: HybridAgentNodeData }) {
  // OPR.0.4.6.MH2 rev1-r2 B1——终端预览 + cmux 打开是本地提示
  // （本地会话读取 / 裸本地 POST）；当画布上是远程主机的数据时关闭
  // （FR-7 只读远程视图）。
  const nodeIsRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  const cmuxLaunch = useCmuxLaunch();
  const core = isCoreRole(data.role);
  const isInfra = data.nodeKind === "infrastructure";
  const { state: activityState, source: activitySource } = getActivityStateWithSource(data.agentActivity, data.terminalActive, data.identityVerdict);
  const activityLabel = getActivityLabel(activityState);
  const activityBgClass = getActivityBgClass(activityState);
  const activityAnimClass = getActivityAnimationClass(activityState);
  const activityStale = isActivityStale(data.agentActivity);
  const timeInState = getTimeInState(data.agentActivity);
  const activityCard = getActivityCardSignal({ activityRing: data.activityRing, activityState });
  const runtimeTitle = data.runtime || data.model ? formatRuntimeModel(data.runtime, data.model) : null;
  const contextKnown = data.contextAvailability === "known" && typeof data.contextUsedPercentage === "number";
  const tokenTotal = sumTokenCounts(data.contextTotalInputTokens, data.contextTotalOutputTokens);
  const tokenLabel = formatCompactTokenCount(tokenTotal);
  const tokenTitle = formatTokenTotalTitle(data.contextTotalInputTokens, data.contextTotalOutputTokens);
  const hoverIconClass = "inline-flex h-6 w-6 items-center justify-center border border-outline-variant bg-surface-lowest/90 text-on-surface opacity-0 shadow-[1px_1px_0_rgba(46,52,46,0.14)] transition-opacity hover:bg-surface-low hover:text-on-surface focus:!opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-on-surface/20 group-hover:!opacity-100 group-hover:opacity-100 group-focus-within:!opacity-100 group-focus-within:opacity-100";

  const card = (
    <div
      data-testid="hybrid-agent-node"
      title={[
        data.canonicalSessionName,
        `活动：${activityLabel}${activityStale ? "（已停滞）" : ""}`,
        runtimeTitle,
        tokenTitle,
      ].filter(Boolean).join("\n")}
      data-activity-card-state={activityCard.state}
      data-activity-card-flash={activityCard.flash ?? "none"}
      className={cn(
        "group relative h-full w-full select-none border bg-surface-lowest/40 backdrop-blur-[8px] hard-shadow transition-[background-color,border-color,box-shadow] duration-300",
        getActivityCardClasses({
          state: activityCard.state,
          flash: activityCard.flash,
          reducedMotion: data.reducedMotion,
        }),
        data.startupStatus === "failed"
          ? "border-red-700"
          : data.startupStatus === "attention_required"
            ? "border-amber-700"
            : "border-on-surface",
      )}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />
      <div
        className={cn(
          "flex items-center justify-between gap-1 px-2 py-1 font-mono text-[8px]",
          isInfra
            ? "bg-outline text-white border-b border-on-surface"
            : core
              ? "bg-inverse-surface text-background"
              : "border-b border-on-surface bg-surface-high text-on-surface",
        )}
      >
        <span className="truncate font-bold">{displayAgentName(data.logicalId)}</span>
        <span
          className={cn(
            "inline-flex h-2 w-2 shrink-0 rounded-full border border-white/60",
            activityBgClass,
            activityAnimClass,
          )}
          data-testid={`hybrid-activity-dot-${data.logicalId}`}
          data-activity-state={activityState}
          data-activity-source={activitySource}
          aria-label={`活动：${activityLabel}${timeInState ? ` ${timeInState.label}` : ""}${activitySource !== "hook" && activitySource !== "none" ? "（活动分级）" : ""}`}
        />
      </div>
      {data.rigId && !nodeIsRemote ? (
        <TerminalPreviewPopover
          rigId={data.rigId}
          logicalId={data.logicalId}
          sessionName={data.canonicalSessionName ?? null}
          reducedMotion={data.reducedMotion}
          testIdPrefix={`hybrid-${data.logicalId}`}
          wrapperClassName="absolute right-8 top-6 z-20"
          buttonClassName={hoverIconClass}
          progressive
        />
      ) : null}
      {data.rigId && !nodeIsRemote ? (
        <>
        <button
          type="button"
          data-testid={`hybrid-cmux-open-${data.logicalId}`}
          aria-busy={cmuxLaunch.isPending || undefined}
          aria-label={
            cmuxLaunch.isPending
              ? `正在在 cmux 中打开 ${data.logicalId}`
              : cmuxLaunch.isError
                ? `在 cmux 中打开 ${data.logicalId} 失败：${cmuxLaunch.error instanceof Error ? cmuxLaunch.error.message : String(cmuxLaunch.error)}。点击重试。`
                : `在 cmux 中打开 ${data.logicalId}`
          }
          title={
            cmuxLaunch.isPending
              ? "正在在 cmux 中打开"
              : cmuxLaunch.isError
                ? `失败：${cmuxLaunch.error instanceof Error ? cmuxLaunch.error.message : String(cmuxLaunch.error)}——点击重试`
                : "在 cmux 中打开"
          }
          disabled={cmuxLaunch.isPending || !data.logicalId}
          data-error={cmuxLaunch.isError || undefined}
          onClick={(event) => {
            event.stopPropagation();
            // OPR.0.4.1.31 part D（rev1-r2）——与表格守卫对称：绝不为畸形节点 POST
            // open-cmux（null/空 logicalId 会拼出 /nodes/"null"/open-cmux）。上面按钮也已禁用。
            if (!data.logicalId) return;
            // part B——先重置先前错误再重试；失败不再静默
            // （data-error + title/aria 携带消息）。
            if (cmuxLaunch.isError) cmuxLaunch.reset();
            cmuxLaunch.mutate({ rigId: data.rigId!, logicalId: data.logicalId });
          }}
          className={cn("absolute right-1.5 top-6 z-10 disabled:cursor-wait disabled:opacity-60", cmuxLaunch.isError ? "text-rose-700" : "", hoverIconClass)}
        >
          <ToolMark tool="cmux" size="sm" />
        </button>
        {cmuxLaunch.isError ? (
          // OPR.0.4.1.31 B2（dev1-guard）——一条稳定、可见的错误消息（不只是
          // title/aria/颜色）：按钮旁一个持久的 role=alert 小条，携带后台服务消息，
          // 使失败的 open-cmux 可读，而非一个看起来像死了的按钮。
          <span
            data-testid={`hybrid-cmux-error-${data.logicalId}`}
            role="alert"
            className="absolute right-1.5 top-14 z-20 max-w-[180px] border border-rose-300 bg-rose-50 px-1.5 py-1 font-mono text-[8px] leading-tight text-rose-700 whitespace-normal break-words shadow-sm"
          >
            {cmuxLaunch.error instanceof Error ? cmuxLaunch.error.message : String(cmuxLaunch.error)}
          </span>
        ) : null}
        </>
      ) : null}
      <div className="space-y-1 px-2 py-1.5">
        <div className="truncate font-mono text-[8px] leading-tight text-on-surface-variant">
          {data.canonicalSessionName ?? data.logicalId}
        </div>
        <div className="min-w-0">
          <RuntimeBadge
            runtime={data.runtime}
            model={data.model}
            size="xs"
            compact
            variant="inline"
            className="max-w-full"
          />
          {!runtimeTitle && (data.resolvedSpecName || data.profile) ? (
            <span className="ml-1 font-mono text-[7px] uppercase tracking-[0.12em] text-on-surface-variant">
              {data.resolvedSpecName || data.profile}
            </span>
          ) : null}
        </div>
        <div className="flex items-end justify-between gap-2 pt-0.5">
          <div
            className={cn("font-mono text-[14px] font-bold leading-none", contextClass(data.contextUsedPercentage, data.contextFresh))}
            data-testid="hybrid-context-badge"
          >
            {contextKnown ? `${data.contextUsedPercentage}%` : "--"}
          </div>
          <div
            className={cn(
              "font-mono text-[13px] font-bold leading-none tracking-[0.02em]",
              tokenLabel ? "text-on-surface-variant" : "text-on-surface-variant",
            )}
            data-testid="hybrid-token-total"
            title={tokenTitle ?? "Token 样本不可用"}
          >
            {tokenLabel ?? "--"}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
  return (
    <ActivityRing
      state={data.activityRing?.state ?? "idle"}
      flash={data.activityRing?.flash ?? null}
      reducedMotion={data.reducedMotion}
      testId={`hybrid-activity-ring-${data.logicalId}`}
      className="h-full w-full rounded-none"
    >
      {card}
    </ActivityRing>
  );
}

/** V0.3.1 bug-fix slice topology-perf——图 CPU 优化。
 *
 * HybridAgentNode 是工作区拓扑图上每个席位的卡片。它的 `data` prop 引用在每次
 * `useTopologyActivity` 跳动（1 秒间隔 + HostMultiRigGraph.activeNodes 里的逐流事件）
 * 时都变化，但对任一给定席位，大多数字段在跳动间是稳定的。若不 memo，我们会为每个可见席位
 * 在每个 tick 重渲染整张卡片——包括 `useCmuxLaunch`、`TerminalPreviewPopover`、多次格式化调用、
 * ActivityRing。Slice 12.5 把图挂载到工作区范围（多工作组 × 多席位）后这一问题变尖锐。
 *
 * 自定义相等比较渲染器读取的所有字段（可见内容 + activity-ring 形状 + flash）。
 * `currentQitems` 数组按长度比较（信号足够；深比较会重新引入开销）。 */
export const HybridAgentNode = memo(HybridAgentNodeInner, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  return (
    a.logicalId === b.logicalId &&
    a.role === b.role &&
    a.runtime === b.runtime &&
    a.model === b.model &&
    a.status === b.status &&
    a.nodeKind === b.nodeKind &&
    a.startupStatus === b.startupStatus &&
    a.canonicalSessionName === b.canonicalSessionName &&
    a.resolvedSpecName === b.resolvedSpecName &&
    a.profile === b.profile &&
    a.contextUsedPercentage === b.contextUsedPercentage &&
    a.contextFresh === b.contextFresh &&
    a.contextAvailability === b.contextAvailability &&
    a.contextTotalInputTokens === b.contextTotalInputTokens &&
    a.contextTotalOutputTokens === b.contextTotalOutputTokens &&
    a.agentActivity === b.agentActivity &&
    (a.currentQitems?.length ?? 0) === (b.currentQitems?.length ?? 0) &&
    a.rigId === b.rigId &&
    a.activityRing?.state === b.activityRing?.state &&
    a.activityRing?.flash === b.activityRing?.flash &&
    a.reducedMotion === b.reducedMotion
  );
});
HybridAgentNode.displayName = "HybridAgentNode";
