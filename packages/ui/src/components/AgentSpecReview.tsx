import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "./WorkspacePage.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { useAgentSpecReview } from "../hooks/useSpecReview.js";
import {
  WorkflowHeader,
  WorkflowSummaryCard,
  WorkflowSummaryGrid,
} from "./WorkflowScaffold.js";
import { AgentSpecDisplay } from "./AgentSpecDisplay.js";

export function AgentSpecReview() {
  const navigate = useNavigate();
  const { selectedAgentDraft, currentAgentDraft } = useSpecsWorkspace();
  const draft = selectedAgentDraft ?? currentAgentDraft;
  const { data: review, isLoading, error } = useAgentSpecReview(draft?.yaml ?? null);

  if (!draft) {
    return (
      <WorkspacePage>
        <div data-testid="agent-spec-review-empty" className="space-y-5">
          <WorkflowHeader
            eyebrow="智能体规格评审"
            title="未选择 AgentSpec"
            description="从资料库抽屉中选择一个当前或最近的智能体草稿，即可在此评审，然后再进行验证。"
          />
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>
            打开验证
          </Button>
        </div>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage>
      <div data-testid="agent-spec-review" className="space-y-6">
        <WorkflowHeader
          eyebrow="智能体规格评审"
          title={review?.name ?? draft.label}
          description={review?.description ?? "在验证前评审智能体规格结构。"}
          actions={(
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/agents/validate" })}>
              在验证中打开
            </Button>
          )}
        />

        {/* 摘要卡片 */}
        {review && (
          <WorkflowSummaryGrid>
            <WorkflowSummaryCard label="格式" value="AgentSpec" testId="agent-spec-summary-format" />
            <WorkflowSummaryCard label="版本" value={review.version} testId="agent-spec-summary-version" />
            <WorkflowSummaryCard label="配置档" value={(review.profiles ?? []).length} testId="agent-spec-summary-profiles" />
            <WorkflowSummaryCard
              label="技能"
              value={(review.resources ?? { skills: [] }).skills.length}
              testId="agent-spec-summary-skills"
            />
          </WorkflowSummaryGrid>
        )}

        {/* 加载 / 错误 */}
        {isLoading && <div className="font-mono text-[10px] text-on-surface-variant">正在加载评审…</div>}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 font-mono text-[10px] text-red-700">
            {(error as Error).message}
          </div>
        )}

        {/* 委托展示 */}
        <AgentSpecDisplay review={review} yaml={draft.yaml} testIdPrefix="agent" />
      </div>
    </WorkspacePage>
  );
}
