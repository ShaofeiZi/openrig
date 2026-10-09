import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { useRigSpecReview } from "../hooks/useSpecReview.js";
import {
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";
import { RigSpecDisplay } from "./RigSpecDisplay.js";

export function RigSpecReview() {
  const navigate = useNavigate();
  const { selectedRigDraft, currentRigDraft } = useSpecsWorkspace();
  const draft = selectedRigDraft ?? currentRigDraft;
  const { data: review, isLoading, error } = useRigSpecReview(draft?.yaml ?? null);
  const reviewPods = review?.pods ?? [];
  const reviewNodes = review?.nodes ?? [];
  const reviewEdges = review?.edges ?? [];

  if (!draft) {
    return (
      <WorkspacePage>
        <div data-testid="rig-spec-review-empty" className="space-y-5">
          <WorkflowHeader
            eyebrow="工作组规格审查"
            title="未选择工作组规格"
            description="从资料库抽屉中选择当前或最近的工作组草稿，在导入或引导启动前在此审查。"
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>
            打开导入
          </Button>
        </div>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <div data-testid="rig-spec-review" className="space-y-6">
        <WorkflowHeader
          eyebrow="工作组规格审查"
          title={review?.name ?? draft.label}
          description={review?.summary ?? "在导入或引导启动前审查规格结构。"}
          actions={(
            <>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/import" })}>
                在导入中打开
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: "/bootstrap" })}>
                引导启动
              </Button>
            </>
          )}
        />

        {/* 摘要卡片 */}
        {review && (
          <WorkflowSummaryGrid>
            <WorkflowSummaryCard
              label="格式"
              value={review.format === "pod_aware" ? "感知 Pod" : "遗留"}
              testId="rig-spec-summary-format"
            />
            <WorkflowSummaryCard
              label={review.format === "pod_aware" ? "Pod" : "节点"}
              value={review.format === "pod_aware" ? reviewPods.length : reviewNodes.length}
              testId="rig-spec-summary-pods"
            />
            <WorkflowSummaryCard
              label="成员"
              value={review.format === "pod_aware"
                ? reviewPods.reduce((sum, p) => sum + p.members.length, 0)
                : reviewNodes.length}
              testId="rig-spec-summary-members"
            />
            <WorkflowSummaryCard
              label="边"
              value={reviewEdges.length + (review.format === "pod_aware"
                ? reviewPods.reduce((sum, p) => sum + (p.edges?.length ?? 0), 0)
                : 0)}
              testId="rig-spec-summary-edges"
            />
          </WorkflowSummaryGrid>
        )}

        {/* 加载中 / 错误 */}
        {isLoading && <div className="font-mono text-[10px] text-on-surface-variant">正在加载审查...</div>}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 font-mono text-[10px] text-red-700">
            {(error as Error).message}
          </div>
        )}

        {/* 委托展示 */}
        <RigSpecDisplay review={review} yaml={draft.yaml} yamlTestId="rig-spec-yaml" />
      </div>
    </WorkspacePage>
  );
}
