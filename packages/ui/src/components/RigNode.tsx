import { useRef, useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { displayAgentName } from "../lib/display-name.js";
import { cn } from "../lib/utils.js";
import {
  getActivityStateWithSource,
  getActivityLabel,
  getActivityBgClass,
  getActivityAnimationClass,
  isActivityStale,
  getTimeInState,
  shortQitemTail,
} from "../lib/activity-visuals.js";
import type { AgentActivitySummary, CurrentQitemSummary, SeatIdentityVerdictSummary } from "../hooks/useNodeInventory.js";
import { ContextUsageRing } from "./ContextUsageRing.js";
import { ActivityRing } from "./topology/ActivityRing.js";
import { getActivityCardClasses, getActivityCardSignal } from "./topology/activity-card-visuals.js";
import { TerminalPreviewPopover } from "./topology/TerminalPreviewPopover.js";
import type { TopologyActivityVisual } from "../lib/topology-activity.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../lib/token-format.js";
import { formatRuntimeModel } from "../lib/runtime-brand.js";
import { postOpenCmux } from "../hooks/useCmuxLaunch.js";
import { RuntimeBadge, ToolMark } from "./graphics/RuntimeMark.js";

interface RigNodeData {
  logicalId: string;
  rigId?: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  status: string | null;
  packageRefs?: string[];
  nodeKind?: "agent" | "infrastructure";
  startupStatus?: "pending" | "ready" | "attention_required" | "failed" | null;
  canonicalSessionName?: string | null;
  podId?: string | null;
  restoreOutcome?: string;
  // OPR.0.4.3.06——挑战校验的定向判定，展示在 startupStatus 旁
  // （绝不并入或压低节点健康色）。
  oriented?: string;
  resumeToken?: string | null;
  resolvedSpecName?: string | null;
  profile?: string | null;
  edgeCount?: number;
  binding: {
    tmuxSession?: string | null;
    cmuxSurface?: string | null;
  } | null;
  contextUsedPercentage?: number | null;
  contextFresh?: boolean;
  contextAvailability?: string;
  contextTotalInputTokens?: number | null;
  contextTotalOutputTokens?: number | null;
  placementState?: "available" | "selected" | null;
  // PL-019：智能体活动驱动节点的主“这个智能体在工作吗？”圆点颜色
  // （取代此前的启动状态色）。currentQitems 在智能体运行时于悬停提示中展示。
  agentActivity?: AgentActivitySummary | null;
  terminalActive?: boolean | null;
  // OPR.0.4.3.19——活性身份判定；mismatch/pane_missing 判定覆盖 terminalActive，
  // 使圆点绝不渲染成 active/running 绿色。
  identityVerdict?: SeatIdentityVerdictSummary | null;
  currentQitems?: CurrentQitemSummary[];
  activityRing?: TopologyActivityVisual;
  reducedMotion?: boolean;
  // OPR.0.4.6.MH2 rev1-r2 B1：由 RigGraph 的富化设置（与 reducedMotion 同一通道），
  // 当选中远程主机时——悬停工具条的 cmux-open POST + 终端预览是本地动作，
  // 绝不在远程数据上挂载。是数据 prop（而非 hook），使独立 RigNode 测试架
  // 无需 QueryClientProvider。
  remoteReadonly?: boolean;
}

/** 核心角色用深色头条，工作角色用浅色 */
function isCore(role: string | null): boolean {
  return role === "architect" || role === "lead" || role === "orchestrator";
}

export function RigNode({ data }: { data: RigNodeData }) {
  const prevStatusRef = useRef(data.startupStatus);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusChanged, setStatusChanged] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<"cmux" | null>(null);
  const core = isCore(data.role);
  const isInfra = data.nodeKind === "infrastructure";

  useEffect(() => {
    if (prevStatusRef.current !== data.startupStatus && prevStatusRef.current !== null) {
      setStatusChanged(true);
      const timer = setTimeout(() => setStatusChanged(false), 600);
      prevStatusRef.current = data.startupStatus;
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = data.startupStatus;
  }, [data.startupStatus]);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const runtimeTitle = data.runtime || data.model ? formatRuntimeModel(data.runtime, data.model) : null;
  const agentName = displayAgentName(data.logicalId);

  // PL-019：圆点颜色现在由 agentActivity.state 驱动，而非 startupStatus。
  // startupStatus 经下方 ATTN/FAILED 徽章保留其独立界面\u2014\u2014活动回答“这个智能体在工作吗？”，
  // 启动回答“这个智能体启动了吗？”。两个不同的问题，两个不同的界面。
  const { state: activityState, source: activitySource } = getActivityStateWithSource(data.agentActivity, data.terminalActive, data.identityVerdict);
  const activityLabel = getActivityLabel(activityState);
  const activityBgClass = getActivityBgClass(activityState);
  const activityAnimClass = getActivityAnimationClass(activityState);
  const activityIsStale = isActivityStale(data.agentActivity);
  const timeInState = getTimeInState(data.agentActivity);
  const activityCard = getActivityCardSignal({ activityRing: data.activityRing, activityState });
  const tokenTotal = sumTokenCounts(data.contextTotalInputTokens, data.contextTotalOutputTokens);
  const tokenLabel = formatCompactTokenCount(tokenTotal);
  const tokenTitle = formatTokenTotalTitle(data.contextTotalInputTokens, data.contextTotalOutputTokens);

  const placementChipLabel = data.placementState === "selected" ? "目标" : data.placementState === "available" ? "可用" : null;

  // PL-019 第 5 项：当智能体当前在运行、且后台服务挂载了一个或多个 qitem 时，
  // 在悬停提示中包含活动 qitem 摘要。悬停用短 ULID 尾；完整 id 在抽屉里（独立界面）。
  const currentQitems = data.currentQitems ?? [];
  const qitemHoverLines = currentQitems.length > 0
    ? currentQitems.map((q) => `进行中：${shortQitemTail(q.qitemId)} \u2014 ${q.bodyExcerpt}`)
    : [];

  const hoverHintLines = [
    `活动：${activityLabel}${activityIsStale ? "（采样已停滞）" : ""}`,
    data.canonicalSessionName ? `会话：${data.canonicalSessionName}` : null,
    runtimeTitle ? `运行时：${runtimeTitle}` : null,
    data.resolvedSpecName ? `规格：${data.resolvedSpecName}` : null,
    data.profile ? `配置档：${data.profile}` : null,
    typeof data.edgeCount === "number" ? `边：${data.edgeCount}` : null,
    tokenTitle,
    ...qitemHoverLines,
  ].filter((line): line is string => Boolean(line));
  const hoverHint = hoverHintLines.join("\n");

  const flashFeedback = (kind: "cmux") => {
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
    }
    setActionFeedback(kind);
    feedbackTimerRef.current = setTimeout(() => {
      setActionFeedback((current) => (current === kind ? null : current));
      feedbackTimerRef.current = null;
    }, 900);
  };

  const handleOpenCmux = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!data.rigId) return;
    try {
      const result = await postOpenCmux({ rigId: data.rigId, logicalId: data.logicalId });
      if (result.ok) flashFeedback("cmux");
    } catch { /* 尽力而为 */ }
  };

  const buttonClass = (kind: "cmux") =>
    `inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[7px] uppercase transition-colors ${
      actionFeedback === kind
        ? "bg-inverse-surface text-background border-on-surface"
        : "bg-surface-lowest text-on-surface border-outline-variant hover:bg-surface-low"
    }`;
  const toolbarIconButtonClass = "border font-mono text-[7px] uppercase transition-colors bg-surface-lowest text-on-surface border-outline-variant hover:bg-surface-low inline-flex h-6 w-6 items-center justify-center px-0 py-0";
  const terminalSessionName = data.canonicalSessionName ?? data.binding?.tmuxSession ?? null;

  const card = (
    <div
      className={cn(
        "group relative min-w-[200px] border hard-shadow transition-[background-color,border-color,box-shadow] duration-300",
        getActivityCardClasses({
          state: activityCard.state,
          flash: activityCard.flash,
          reducedMotion: data.reducedMotion,
        }),
        data.placementState === "selected"
          ? "border-emerald-600 ring-2 ring-emerald-400/70 shadow-[0_0_0_3px_rgba(52,211,153,0.12)]"
          : data.placementState === "available"
            ? "border-emerald-500 ring-1 ring-emerald-300/70"
            : "border-on-surface",
      )}
      data-activity-card-state={activityCard.state}
      data-activity-card-flash={activityCard.flash ?? "none"}
      data-testid="rig-node"
      title={hoverHint || undefined}
    >
      <Handle type="target" position={Position.Top} />

      {/* 头条——核心深色，基础设施灰，工作角色浅色 */}
      <div className={`px-3 py-1 font-mono text-[10px] flex justify-between items-center ${
        isInfra
          ? "bg-outline text-white border-b border-on-surface"
          : core
            ? "bg-inverse-surface text-background"
            : "bg-surface-high text-on-surface border-b border-on-surface"
      }`}>
        <span className="font-bold truncate">
          {agentName}
        </span>
        <span className="inline-flex items-center gap-1">
          {activityIsStale && (
            <span
              data-testid={`activity-staleness-${data.logicalId}`}
              className="font-mono text-[7px] uppercase tracking-[0.10em] text-on-surface-variant"
              title={`活动采样已超过阈值；后台服务可能未在探测此席位`}
            >
              已停滞
            </span>
          )}
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full border border-white/50 ${activityBgClass} ${activityAnimClass} ${statusChanged ? "status-changed" : ""}`}
            data-testid={`activity-dot-${data.logicalId}`}
            data-activity-state={activityState}
            data-activity-source={activitySource}
            aria-label={`活动：${activityLabel}${timeInState ? ` ${timeInState.label}` : ""}${activitySource !== "hook" && activitySource !== "none" ? "（活动分级）" : ""}`}
            title={`活动：${activityLabel}${timeInState ? ` ${timeInState.label}` : ""}${activitySource !== "hook" && activitySource !== "none" ? "（活动分级）" : ""}`}
          />
          {/* PL-012：上下文用量分层环，与 PL-019 活动圆点并列。两个信号同尺度：
              “这个智能体在工作吗？”（左圆点，实心）vs
              “这个智能体是否接近上下文耗尽？”（右环，空心）。 */}
          <ContextUsageRing
            percent={data.contextUsedPercentage}
            fresh={data.contextFresh}
            availability={data.contextAvailability}
            testIdSuffix={data.logicalId}
          />
        </span>
      </div>

      {/* 正文 */}
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
          {!runtimeTitle && data.profile ? (
            <span className="ml-1 font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant">
              {data.profile}
            </span>
          ) : null}
        </div>

        {/* 规格提示 */}
        {data.resolvedSpecName && (
          <div className="font-mono text-[8px] text-on-surface-variant" data-testid="spec-hint">
            {data.resolvedSpecName}{data.profile ? ` · ${data.profile}` : ""}
          </div>
        )}

        {/* 上下文用量——突出的大数字 */}
        <div className="flex items-end justify-between gap-3 pt-0.5">
          {data.contextAvailability === "known" && typeof data.contextUsedPercentage === "number" ? (
            <div
              className={`font-mono text-base font-bold leading-none ${
                data.contextUsedPercentage >= 80 ? "text-red-600" :
                data.contextUsedPercentage >= 60 ? "text-amber-600" :
                "text-green-700"
              }${!data.contextFresh ? " opacity-50" : ""}`}
              data-testid="context-badge"
              title={data.contextFresh ? "上下文用量（新鲜）" : "上下文用量（采样已停滞）"}
            >
              {data.contextUsedPercentage}%
            </div>
          ) : (
            <div className="font-mono text-xs text-on-surface-variant" data-testid="context-badge-unknown">
              ?
            </div>
          )}
          <div
            className={`font-mono text-base font-bold leading-none tracking-[0.02em] ${tokenLabel ? "text-on-surface-variant" : "text-on-surface-variant"}`}
            data-testid="token-total"
            title={tokenTitle ?? "Token 样本不可用"}
          >
            {tokenLabel ?? "--"}
          </div>
        </div>

        {/* 恢复结果 */}
        {data.restoreOutcome && data.restoreOutcome !== "n-a" && (
          <div className="font-mono text-[8px] text-on-surface-variant">
            恢复：{data.restoreOutcome}
          </div>
        )}

        {/* OPR.0.4.3.06 启动凭证定向——一个区别于 startupStatus/health 的判定。
            `verified` = 已证明其读取了合同；`missing`/`rejected` 作为自己的标签展示，
            使席位绝不会在没有凭证的情况下静默“绿色 + 已定向”。`n-a`（已恢复/非智能体）
            隐藏，与 RESTORE 徽章一致。 */}
        {data.oriented && data.oriented !== "n-a" && (
          <div className="font-mono text-[8px] text-on-surface-variant" data-testid="orientation-badge">
            定向：{data.oriented}
          </div>
        )}

        {/* 包徽章（旧版） */}
        {data.packageRefs && data.packageRefs.length > 0 && (
          <div
            data-testid="package-badge"
            title={data.packageRefs.join(", ")}
            className="font-mono text-[8px] text-on-surface-variant"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            包 {data.packageRefs.length}
          </div>
        )}

        {/* 阻塞/失败启动的告警态 */}
        {data.startupStatus === "attention_required" && (
          <div className="stamp-badge">
            <div className="w-2 h-2 rounded-full bg-orange-500" />
            <span className="text-orange-600">待关注</span>
          </div>
        )}
        {data.startupStatus === "failed" && (
          <div className="stamp-badge">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-red-600">失败</span>
          </div>
        )}

        {!data.remoteReadonly && (terminalSessionName ?? data.rigId) && (
          <div
            data-testid="node-toolbar"
            className="absolute right-2 top-8 z-20 flex flex-wrap justify-end gap-1 opacity-0 transition-opacity group-hover:!opacity-100 group-hover:opacity-100 group-focus-within:!opacity-100 group-focus-within:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {data.rigId && (
              <button
                onClick={handleOpenCmux}
                data-testid="toolbar-cmux-open"
                className={`${buttonClass("cmux")} inline-flex h-6 w-6 items-center justify-center px-0 py-0`}
                aria-label="在 cmux 中打开"
                title="在 cmux 中打开"
              >
                <ToolMark tool="cmux" size="sm" />
                <span className="sr-only">{actionFeedback === "cmux" ? "已打开" : "cmux"}</span>
              </button>
            )}
            {data.rigId && terminalSessionName && (
              <TerminalPreviewPopover
                rigId={data.rigId}
                logicalId={data.logicalId}
                sessionName={terminalSessionName}
                reducedMotion={data.reducedMotion}
                testIdPrefix={`rig-node-${data.logicalId}`}
                buttonClassName={toolbarIconButtonClass}
                progressive
              />
            )}
          </div>
        )}

        {placementChipLabel && (
          <div className="pt-1">
            <span
              data-testid={`placement-chip-${data.logicalId}`}
              className={`inline-flex items-center border px-1.5 py-0.5 font-mono text-[7px] uppercase tracking-[0.12em] ${
                data.placementState === "selected"
                  ? "border-emerald-700 bg-emerald-700 text-white"
                  : "border-emerald-300 bg-emerald-50 text-emerald-800"
              }`}
            >
              {placementChipLabel}
            </span>
          </div>
        )}
      </div>

      {hoverHintLines.length > 0 && (
        <div
          data-testid="node-hover-hint"
          className="pointer-events-none absolute left-2 top-full z-20 mt-2 hidden min-w-[180px] border border-on-surface bg-surface-lowest px-2 py-1 font-mono text-[8px] text-on-surface shadow-[4px_4px_0_rgba(28,25,23,0.14)] group-hover:block"
        >
          {hoverHintLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
  return (
    <ActivityRing
      state={data.activityRing?.state ?? "idle"}
      flash={data.activityRing?.flash ?? null}
      reducedMotion={data.reducedMotion}
      testId={`rig-node-activity-ring-${data.logicalId}`}
      className="rounded-none"
    >
      {card}
    </ActivityRing>
  );
}
