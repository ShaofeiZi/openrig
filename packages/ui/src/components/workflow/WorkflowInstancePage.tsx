// OPR.0.4.6.WF4（C4）——实例详情页（FR-2 参考形态）。
//
// 通过放大入口寻址，而不是导航外壳（沿用 /agents 先例）：可从实例行（资料库信息带或
// /workflows 层级）以及“需要你处理”工作流行进入；后者带 FR-3 `?step=` 锚点深链接。
// 绝不从导航栏直接进入。
//
// 一个事实来源、两个投影（FR-4）：此处所有内容来自 `rig workflow trace` 所投影的同一读取，
// 即 GET /api/workflow/:id/trace（实例、轨迹和附加的截止判定），再加上资料库评审载荷中的
// 工作流形态，由客户端组合；UI 侧不重新计算（BR-4）。
//
// v1 变更界面只有恢复，是已交付 POST /:id/resume 的薄客户端。按 PM 裁定，网页重路由延后；
// 此处有意省略孪生中的重新路由入口，卡住状态框只显示证据与恢复，不显示重路由按钮。
// 这是唯一已披露的孪生与实现差异。

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { cn } from "../../lib/utils.js";
import { WorkspacePage } from "../WorkspacePage.js";
import { WorkflowHeader, WorkflowSummaryCard, WorkflowSummaryGrid } from "../WorkflowScaffold.js";
import { useLibraryReview, type LibraryWorkflowReview } from "../../hooks/useSpecLibrary.js";
import {
  useWorkflowTrace,
  type WorkflowInstanceWithDeadline,
  type WorkflowStepTrailEntry,
} from "../../hooks/useWorkflow.js";
import { WorkflowTopologyGraph } from "./WorkflowTopologyGraph.js";
import { InstanceTrailTimeline } from "./InstanceTrailTimeline.js";

function fmtTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

const WORKFLOW_STATUS_LABELS: Record<string, string> = {
  active: "运行中",
  waiting: "等待中",
  completed: "已完成",
  failed: "失败",
};

const DEADLINE_STATE_LABELS: Record<string, string> = {
  healthy: "健康",
  "overdue-claimed": "逾期·已认领",
  "overdue-unclaimed": "逾期·未认领",
};

function workflowStatusLabel(status: string): string {
  return WORKFLOW_STATUS_LABELS[status] ?? status;
}

function deadlineStateLabel(state: string): string {
  return DEADLINE_STATE_LABELS[state] ?? state;
}

// 人工网页操作的界面身份，与 SliceReviewTab / RigAgentsPage / MissionReviewTab 一致。
// 恢复是从网页发起的人工重驱。
const SURFACE_ACTOR = "human@host";

/** POST /api/workflow/:id/resume——已交付 WF-5 重驱的薄客户端。路由要求结构化
 * `actorSession`（routes/workflow.ts:266），缺少时返回 400；应从界面身份传入，绝不能使用
 * 自然语言值。 */
export async function postResume(instanceId: string): Promise<void> {
  const res = await fetch(`/api/workflow/${encodeURIComponent(instanceId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorSession: SURFACE_ACTOR }),
  });
  if (!res.ok) throw new Error(`恢复失败——HTTP ${res.status}`);
}

/** 根据已记录轨迹生成位置历史：已访问步骤、实际经过的连续步骤边，以及进入当前实时步骤的一跳。
 * 仅做派生；没有匹配形态边的组合不附加样式。 */
function takenFromTrail(
  trail: WorkflowStepTrailEntry[],
  currentStepId: string | null,
): { visited: string[]; edgeKeys: string[] } {
  const seq = trail.map((t) => t.stepId);
  if (currentStepId) seq.push(currentStepId);
  const edgeKeys: string[] = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    if (seq[i] !== seq[i + 1]) edgeKeys.push(`${seq[i]}→${seq[i + 1]}`);
  }
  return { visited: trail.map((t) => t.stepId), edgeKeys };
}

export function ExceptionBanner({
  instance,
  onResume,
  resuming,
  resumeError,
}: {
  instance: WorkflowInstanceWithDeadline;
  onResume: () => void;
  resuming: boolean;
  resumeError: string | null;
}) {
  const gated = instance.status === "waiting" && instance.currentStepId != null;
  const overdue = instance.deadline.state !== "healthy" && instance.deadline.evidence;
  const failed = instance.status === "failed";
  if (!gated && !overdue && !failed) return null;

  const tone = failed || overdue ? "border-red-700/60 bg-red-700/5" : "border-amber-700/60 bg-amber-700/5";
  return (
    <div data-testid="workflow-exception-banner" className={cn("space-y-2 border px-3 py-2", tone)}>
      {failed ? (
        <p className="font-mono text-[11px] text-red-700">
          ▲ 已失败 —— 该失败出口未映射恢复分支
          {instance.resumeCount > 0 ? ` · 已恢复 ${instance.resumeCount} 次` : ""}
        </p>
      ) : null}
      {overdue ? (
        <p className="font-mono text-[11px] text-red-700">
          ▲ {deadlineStateLabel(instance.deadline.state)} —— 步骤 {instance.deadline.evidence!.stepId ?? "（未绑定）"} 的数据包{" "}
          {instance.deadline.evidence!.packetId} 由 {instance.deadline.evidence!.ownerSession} 持有，已超过其{" "}
          {instance.deadline.evidence!.anchor} 锚点 {Math.floor(instance.deadline.evidence!.overdueBySeconds / 60)} 分钟
        </p>
      ) : null}
      {gated && !overdue && !failed ? (
        <p className="font-mono text-[11px] text-amber-800">
          ◐ 在 {instance.currentStepId} 等待 —— 门控数据包已挂起等待签收；解决该“需要你处理”项即可恢复确定性流程
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {failed ? (
          <button
            type="button"
            data-testid="workflow-resume"
            disabled={resuming}
            onClick={onResume}
            className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant disabled:cursor-not-allowed disabled:opacity-50"
            title={`POST /api/workflow/${instance.instanceId}/resume —— 从失败步骤重新驱动（WF-5 FR-4）`}
          >
            {resuming ? "正在恢复…" : "恢复"}
          </button>
        ) : null}
        {/* ROUTE-FROM-WEB 延后（PM 裁定）——v1 有意省略 twin 中的 RE-ROUTE 入口；
            这是已经公开说明的 twin 与正式构建差异。 */}
        {resumeError ? (
          <span data-testid="workflow-resume-error" className="font-mono text-[10px] text-red-700">
            {resumeError}
          </span>
        ) : null}
        <span className="font-mono text-[10px] text-on-surface-variant">
          CLI：zrig workflow trace {instance.instanceId}
        </span>
      </div>
    </div>
  );
}

export function WorkflowInstancePage({
  instanceId,
  anchorStepId,
}: {
  instanceId: string;
  /** FR-3 的 `?step=` 深链接锚点。 */
  anchorStepId?: string | null;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: trace, isLoading, error } = useWorkflowTrace(instanceId);
  const specLibraryId = trace ? `workflow:${trace.instance.workflowName}:${trace.instance.workflowVersion}` : null;
  const { data: specReview } = useLibraryReview(specLibraryId);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const onResume = () => {
    setResuming(true);
    setResumeError(null);
    void postResume(instanceId)
      .then(() => queryClient.invalidateQueries({ queryKey: ["workflow"] }))
      .catch((e: unknown) => setResumeError((e as Error).message))
      .finally(() => setResuming(false));
  };

  if (isLoading) {
    return (
      <WorkspacePage>
        <div className="font-mono text-[10px] text-on-surface-variant">正在加载工作流实例…</div>
      </WorkspacePage>
    );
  }
  if (error || !trace) {
    return (
      <WorkspacePage>
        <div data-testid="workflow-instance-error" className="space-y-4">
          <WorkflowHeader
            eyebrow="工作流 — 实例"
            title="未找到实例"
            description={(error as Error)?.message ?? `无工作流实例 ${instanceId}。`}
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/workflows" })}>
            返回工作流
          </Button>
        </div>
      </WorkspacePage>
    );
  }

  const { instance, trail } = trace;
  const { visited, edgeKeys } = takenFromTrail(trail, instance.currentStepId);
  const workflowReview =
    specReview && (specReview as LibraryWorkflowReview).kind === "workflow"
      ? (specReview as LibraryWorkflowReview)
      : null;
  const statusLabel = instance.deadline.state !== "healthy"
    ? deadlineStateLabel(instance.deadline.state)
    : workflowStatusLabel(instance.status);

  return (
    <WorkspacePage>
      <div data-testid="workflow-instance-page" className="space-y-6">
        <WorkflowHeader
          eyebrow={`工作流 — 实例 · ${instance.workflowName} v${instance.workflowVersion}`}
          title={instance.instanceId}
          description={
            instance.currentStepId
              ? `${workflowStatusLabel(instance.status)}，位于 ${instance.currentStepId} · 跳数 ${instance.hopCount}`
              : `${workflowStatusLabel(instance.status)} · 跳数 ${instance.hopCount}`
          }
          actions={
            <div className="flex gap-2 items-center">
              <Button
                variant="outline"
                size="sm"
                data-testid="workflow-view-spec"
                onClick={() =>
                  specLibraryId && navigate({ to: "/specs/library/$entryId", params: { entryId: specLibraryId } })
                }
              >
                查看规格
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/workflows" })}>
                返回
              </Button>
            </div>
          }
        />

        <WorkflowSummaryGrid>
          <WorkflowSummaryCard label="状态" value={statusLabel} testId="wf-inst-status" />
          <WorkflowSummaryCard
            label="位置"
            value={instance.currentStepId ?? (instance.status === "completed" ? "已关闭" : "已终止")}
            testId="wf-inst-position"
          />
          <WorkflowSummaryCard label="跳数" value={instance.hopCount} testId="wf-inst-hops" />
          <WorkflowSummaryCard label="恢复次数" value={instance.resumeCount} testId="wf-inst-resumes" />
        </WorkflowSummaryGrid>

        <p data-testid="wf-inst-provenance" className="font-mono text-[10px] text-on-surface-variant">
          由 {instance.createdBySession} 创建 · {fmtTime(instance.createdAt)}
          {instance.completedAt ? ` · 完成于 ${fmtTime(instance.completedAt)}` : ""}
        </p>

        <ExceptionBanner instance={instance} onResume={onResume} resuming={resuming} resumeError={resumeError} />

        {workflowReview ? (
          <WorkflowTopologyGraph
            topology={workflowReview.topology}
            testId="workflow-instance-graph"
            currentStepId={instance.currentStepId}
            visitedStepIds={visited}
            takenEdgeKeys={edgeKeys}
          />
        ) : (
          <p className="font-mono text-[10px] text-on-surface-variant">
            （工作流形状不可用 —— 规格不在库缓存中）
          </p>
        )}

        <InstanceTrailTimeline trail={trail} instance={instance} anchorStepId={anchorStepId} />
      </div>
    </WorkspacePage>
  );
}
