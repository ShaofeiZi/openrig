// PL-005 A 阶段：7 动词操作子组件。
//
// 按 PRD § 验收标准第 2 项：7 个动词各为一个原子事务。
// 4 步 `handoff` 形状是后台服务内部的（此处不可见）；UI 仅提交动词 + 必填字段。

import { useState } from "react";
import {
  MISSION_CONTROL_VERBS,
  type MissionControlVerb,
  useMissionControlAction,
} from "../hooks/useMissionControlAction.js";
import { useMissionControlDestinations } from "../hooks/useMissionControlDestinations.js";
import { ACTION_VERB_META } from "../action-verb-meta.js";
import { cn } from "../../../lib/utils.js";
import type { FeedActionOutcome } from "../../for-you/FeedCard.js";

export interface VerbActionsProps {
  qitemId: string;
  actorSession: string;
  /** CORRECTIVE §7.1（创始者 2026-07-05）：仅渲染动词按钮——
   *  无"选择响应"头部/说明装饰；按钮自解释。变更 + 回执 + 错误路径完全相同。 */
  bare?: boolean;
  /** OPR.0.4.4.15 FR-4 —— 事项的来源主机（来自聚合 feed 卡片）。
   *  远端 id 随变更提交，后台服务将动词转发到 qitem 所在位置；
   *  缺省/'local' 不改变任何内容。 */
  hostId?: string;
  /** 限制提供的动词（例如 my-queue 可能只显示 approve/deny）。 */
  enabledVerbs?: MissionControlVerb[];
  /**
   * OPR.0.3.3.20 —— 点击直接提交的动词（无选择+确认步骤），
   * 触发相同的变更 + 乐观回执 + 持有错误路径。
   * 按契约仅 APPROVE（PRD 范围 + S 节）：类型将 prop 收窄为 "approve"，
   * ONE_CLICK_SAFE_VERBS 在运行时强制同一白名单——
   * 不在其中的动词（包括无输入动词如 deny）永不一键提交，即使调用者强制传入；
   * 它回退到受控选择+确认流程。For-You 传 ["approve"]。
   */
  oneClickVerbs?: Array<Extract<MissionControlVerb, "approve">>;
  onSettled?: () => void;
  /**
   * 0.3.1 demo-bug 修复 —— 乐观结果回调。变更成功时触发，
   * 用输入动词 + 目标 + 操作者构建 FeedActionOutcome。
   * 父组件（Feed.tsx）将其存入本地 Map，使 ActionOutcomePanel
   * 无需等待审计日志往返即可立即渲染。审计查询重新获取后
   * 后续对账为相同形状。
   */
  onOptimisticOutcome?: (outcome: FeedActionOutcome) => void;
}

/** 一键白名单（OPR.0.3.3.20，按范围裁定仅 approve）。
 *  无输入是必要但不充分条件——deny 无需输入但仍走受控选择+确认流程。
 *  动词仅在调用者列出它且它在此集合中时才一键提交。 */
const ONE_CLICK_SAFE_VERBS: ReadonlySet<MissionControlVerb> = new Set(["approve"]);

function extractMutationErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "操作失败。";
}

// 羊皮纸一致的动词按钮：静止时无边框无填充；悬停反转为填充。
// 激活状态保持填充以在填写动词必填字段时标识操作者选择。
//
// 色调类映射到设计令牌（success / warning / tertiary / secondary /
// stone-900）——绝不使用非品牌 emerald/rose/sky/amber 工具类。
const verbToneClass: Record<MissionControlVerb, { idle: string; active: string }> = {
  approve: {
    idle: "border-success text-success hover:bg-success hover:text-white",
    active: "border-success bg-success text-white",
  },
  deny: {
    idle: "border-tertiary text-tertiary hover:bg-tertiary hover:text-white",
    active: "border-tertiary bg-tertiary text-white",
  },
  route: {
    idle: "border-on-surface text-on-surface hover:bg-inverse-surface hover:text-background",
    active: "border-on-surface bg-inverse-surface text-background",
  },
  annotate: {
    idle: "border-on-surface text-on-surface hover:bg-inverse-surface hover:text-background",
    active: "border-on-surface bg-inverse-surface text-background",
  },
  hold: {
    idle: "border-warning text-warning hover:bg-warning hover:text-white",
    active: "border-warning bg-warning text-white",
  },
  drop: {
    idle: "border-on-surface text-on-surface hover:bg-inverse-surface hover:text-background",
    active: "border-on-surface bg-inverse-surface text-background",
  },
  handoff: {
    idle: "border-on-surface text-on-surface hover:bg-inverse-surface hover:text-background",
    active: "border-on-surface bg-inverse-surface text-background",
  },
};

export function VerbActions({
  qitemId,
  actorSession,
  bare = false,
  hostId,
  enabledVerbs = [...MISSION_CONTROL_VERBS],
  oneClickVerbs,
  onSettled,
  onOptimisticOutcome,
}: VerbActionsProps) {
  const mutation = useMissionControlAction();
  const [activeVerb, setActiveVerb] = useState<MissionControlVerb | null>(null);
  const [destinationSession, setDestinationSession] = useState("");
  const [manualDestination, setManualDestination] = useState(false);
  const [annotation, setAnnotation] = useState("");
  const [reason, setReason] = useState("");
  // Demo-bug 修复 #2 —— 内联错误状态。动词选择 + 显式重置时清除；
  // 跨变更状态转换保持，使操作者看到什么失败了，而非静默回退。
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const needsDestination = activeVerb === "route" || activeVerb === "handoff";
  const needsAnnotation = activeVerb === "annotate";
  const needsReason = activeVerb === "hold" || activeVerb === "drop";

  function reset() {
    setActiveVerb(null);
    setDestinationSession("");
    setManualDestination(false);
    setAnnotation("");
    setReason("");
    setErrorMessage(null);
  }

  function selectVerb(verb: MissionControlVerb) {
    setActiveVerb(verb);
    setDestinationSession("");
    setManualDestination(false);
    setAnnotation("");
    setReason("");
    setErrorMessage(null);
  }

  // 选择+确认提交与一键路径共享，使两者触发相同的变更 + 乐观回执 + 持有错误行为。
  function performSubmit(verb: MissionControlVerb, inputs: { dest?: string; annotationText?: string; reasonText?: string }) {
    const { dest, annotationText, reasonText } = inputs;
    mutation.mutate(
      {
        verb,
        qitemId,
        actorSession,
        destinationSession: dest,
        annotation: annotationText,
        reason: reasonText,
        // G15-CF6-1：远端卡片携带其来源，后台服务转发；
        // local/缺省不向 body 添加任何内容（字节一致）。
        ...(hostId && hostId !== "local" ? { hostId } : {}),
      },
      {
        // Demo-bug 修复 #1 —— 拆分 onSuccess / onError，使错误路径
        // 不重置选择（静默回退症状）。乐观结果在成功时触发，
        // ActionOutcomePanel 无需等待审计日志往返即可渲染。
        onSuccess: () => {
          onOptimisticOutcome?.({
            verb,
            actorSession,
            actedAt: new Date().toISOString(),
            destinationSession: dest ?? null,
            reason: reasonText ?? null,
          });
          reset();
          onSettled?.();
        },
        onError: (err) => {
          setErrorMessage(extractMutationErrorMessage(err));
        },
      },
    );
  }

  function submit() {
    if (!activeVerb) return;
    performSubmit(activeVerb, {
      dest: needsDestination ? destinationSession : undefined,
      annotationText: needsAnnotation ? annotation : undefined,
      reasonText: needsReason ? reason : undefined,
    });
  }

  // OPR.0.3.3.20 —— 一键提交，仅 approve：调用者列表和 ONE_CLICK_SAFE_VERBS
  // 白名单都必须包含该动词。操作驱动：在操作者点击时触发，绝不在定时器上。
  function isOneClick(verb: MissionControlVerb): boolean {
    return Boolean((oneClickVerbs as MissionControlVerb[] | undefined)?.includes(verb)) && ONE_CLICK_SAFE_VERBS.has(verb);
  }

  const destinationsQuery = useMissionControlDestinations(needsDestination);
  const destinationOptions = destinationsQuery.data?.destinations ?? [];
  const destinationListLoading = needsDestination && destinationsQuery.isLoading;
  const showDestinationSelect = needsDestination && (destinationOptions.length > 0 || destinationListLoading);
  const showManualDestinationInput =
    needsDestination &&
    (manualDestination || destinationsQuery.isError || (destinationsQuery.isFetched && destinationOptions.length === 0));

  return (
    <div data-testid="mc-verb-actions" className="space-y-2">
      {/* CORRECTIVE §7.1（创始者 2026-07-05）：`bare` 仅渲染动词按钮——
          按钮自解释，无说明装饰。变更 + 回执 + 错误路径字节一致。 */}
      {!bare ? (
      <div className="flex flex-wrap items-start justify-between gap-2 border border-outline-variant bg-surface-lowest/40 px-2 py-1.5 backdrop-blur-sm">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface">选择响应</div>
          <div className="mt-0.5 font-mono text-[10px] leading-relaxed text-on-surface-variant">
            为此队列项选择下一步操作。
          </div>
        </div>
        {activeVerb ? (
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
            已选：<span className="text-on-surface">{ACTION_VERB_META[activeVerb].label}</span>
          </div>
        ) : null}
      </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {enabledVerbs.map((verb) => {
          const meta = ACTION_VERB_META[verb];
          const Icon = meta.icon;
          const oneClick = isOneClick(verb);
          return (
            <button
              key={verb}
              type="button"
              data-testid={`mc-verb-${verb}`}
              data-one-click={oneClick ? "true" : undefined}
              onClick={() => {
                // OPR.0.3.3.20 —— 一键动词立即记录（无选择+确认步骤）；
                // 需要输入的动词始终走受控流程。
                if (oneClick) {
                  setErrorMessage(null);
                  performSubmit(verb, {});
                  return;
                }
                selectVerb(verb);
              }}
              disabled={mutation.isPending}
              title={oneClick ? `${meta.description}（立即记录）` : meta.description}
              className={cn(
                "inline-flex min-h-[44px] items-center gap-1 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors disabled:opacity-50",
                activeVerb === verb ? verbToneClass[verb].active : verbToneClass[verb].idle,
              )}
            >
              <Icon className="h-3 w-3" strokeWidth={1.7} />
              {meta.label}
            </button>
          );
        })}
      </div>
      {activeVerb && (
        <div className="space-y-1 border border-outline-variant bg-background p-2">
          <div data-testid="mc-verb-guidance" className="font-mono text-[10px] leading-relaxed text-on-surface-variant">
            {ACTION_VERB_META[activeVerb].description}
          </div>
          {needsDestination && (
            <div className="space-y-1">
              {showDestinationSelect ? (
                <select
                  data-testid="mc-verb-destination-select"
                  aria-label="目标会话"
                  value={manualDestination ? "__manual__" : destinationSession}
                  disabled={destinationListLoading}
                  onChange={(e) => {
                    if (e.target.value === "__manual__") {
                      setManualDestination(true);
                      setDestinationSession("");
                      return;
                    }
                    setManualDestination(false);
                    setDestinationSession(e.target.value);
                  }}
                  className="w-full border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-xs"
                >
                  <option value="">
                    {destinationListLoading ? "正在加载目标会话…" : "选择目标会话"}
                  </option>
                  {destinationOptions.map((destination) => (
                    <option key={destination.sessionName} value={destination.sessionName}>
                      {destination.label}
                    </option>
                  ))}
                  <option value="__manual__">手动输入</option>
                </select>
              ) : null}
              {showManualDestinationInput ? (
                <input
                  type="text"
                  data-testid="mc-verb-destination-input"
                  value={destinationSession}
                  onChange={(e) => setDestinationSession(e.target.value)}
                  placeholder="目标会话 (member@rig)"
                  className="w-full border border-outline-variant px-2 py-1 font-mono text-xs"
                />
              ) : null}
              {destinationsQuery.isError ? (
                <div className="font-mono text-[10px] text-amber-700">目标会话列表不可用</div>
              ) : null}
            </div>
          )}
          {needsAnnotation && (
            <textarea
              data-testid="mc-verb-annotation-input"
              value={annotation}
              onChange={(e) => setAnnotation(e.target.value)}
              placeholder="批注"
              rows={2}
              className="w-full border border-outline-variant px-2 py-1 font-mono text-xs"
            />
          )}
          {needsReason && (
            <input
              type="text"
              data-testid="mc-verb-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={`${activeVerb} 原因`}
              className="w-full border border-outline-variant px-2 py-1 font-mono text-xs"
            />
          )}
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={reset}
              data-testid="mc-verb-cancel"
              className="border border-outline-variant px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant"
            >
              取消
            </button>
            <button
              type="button"
              onClick={submit}
              data-testid="mc-verb-submit"
              disabled={
                mutation.isPending ||
                (needsDestination && !destinationSession) ||
                (needsAnnotation && !annotation) ||
                (needsReason && !reason)
              }
              className="border border-on-surface bg-inverse-surface px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-background disabled:opacity-50"
            >
              {mutation.isPending ? "…" : `确认 ${ACTION_VERB_META[activeVerb].label}`}
            </button>
          </div>
        </div>
      )}
      {errorMessage ? (
        <div
          data-testid="mc-verb-error"
          role="alert"
          className="truncate border border-tertiary bg-background/40 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-tertiary"
          title={errorMessage}
        >
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
