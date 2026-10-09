import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RequirementsPanel, type RequirementResult } from "./RequirementsPanel.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { useBootstrapPlan, useBootstrapApply, type BootstrapPlanResult } from "../hooks/useBootstrap.js";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { WorkflowHeader, WorkflowSection, WorkflowStepIndicator } from "./WorkflowScaffold.js";

type Step = "enter" | "planning" | "planned" | "applying" | "done" | "error";

const STEP_LABELS = ["输入", "规划", "审阅", "执行"] as const;
const STEPS = STEP_LABELS.map((label, index) => ({ num: index + 1, label }));

function currentStepNumber(step: Step): number {
  switch (step) {
    case "enter": return 1;
    case "planning": return 2;
    case "planned": return 3;
    case "applying": return 4;
    case "done": case "error": return 4;
    default: return 1;
  }
}

export function BootstrapWizard() {
  const navigate = useNavigate();
  const { bootstrapSourceRef, setBootstrapSourceRef } = useSpecsWorkspace();
  const [step, setStep] = useState<Step>("enter");
  const [sourceRef, setSourceRef] = useState(() => bootstrapSourceRef);
  const [planResult, setPlanResult] = useState<BootstrapPlanResult | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [autoApprove, setAutoApprove] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const planMutation = useBootstrapPlan();
  const applyMutation = useBootstrapApply();

  useEffect(() => {
    setBootstrapSourceRef(sourceRef);
  }, [setBootstrapSourceRef, sourceRef]);

  const handlePlan = async () => {
    if (!sourceRef.trim()) return;
    setStep("planning");
    try {
      const result = await planMutation.mutateAsync({ sourceRef: sourceRef.trim() });
      setPlanResult(result);
      // 自动选中全部操作键
      setSelectedKeys(new Set(result.actionKeys ?? []));
      setStep("planned");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStep("error");
    }
  };

  const handleApply = async () => {
    setStep("applying");
    try {
      const result = await applyMutation.mutateAsync({
        sourceRef: sourceRef.trim(),
        autoApprove,
        approvedActionKeys: autoApprove ? undefined : [...selectedKeys],
      });
      setPlanResult(result);
      setStep("done");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStep("error");
    }
  };

  const handleReset = () => {
    setStep("enter");
    setSourceRef("");
    setPlanResult(null);
    setSelectedKeys(new Set());
    setAutoApprove(false);
    setErrorMessage(null);
    planMutation.reset();
    applyMutation.reset();
  };

  // 从规划结果提取需求
  const reqStage = planResult?.stages.find((s) => s.stage === "probe_requirements");
  const reqDetail = reqStage?.detail as { results?: RequirementResult[] } | undefined;
  const requirements = reqDetail?.results ?? [];

  // 从规划结果提取安装计划
  const planStage = planResult?.stages.find((s) => s.stage === "build_install_plan");
  const planDetail = planStage?.detail as {
    actions?: Array<{ key: string; requirementName: string; classification: string; commandPreview: string | null }>;
  } | undefined;
  const actions = planDetail?.actions ?? [];
  const isPlanBlocked = planStage?.status === "blocked";
  const hasActionableInstalls = actions.some((a) => a.classification !== "manual_only" && a.commandPreview);
  const noneSelected = hasActionableInstalls && selectedKeys.size === 0 && !autoApprove;

  return (
    <WorkspacePage>
      <div data-testid="bootstrap-wizard" className="space-y-8">
      <WorkflowHeader
        eyebrow="引导"
        title="引导"
        description="规划环境需求，批准安装操作，然后将工作组导入运行中的拓扑。"
      />
      <WorkflowStepIndicator data-testid="step-indicator" steps={STEPS} currentStep={currentStepNumber(step)} />

      {/* 步骤 1：输入 */}
      {step === "enter" && (
        <WorkflowSection
          title="来源"
          description="提供工作组规格或包路径。引导会在导入前检查需求。"
        >
        <div data-testid="step-enter">
          <label className="text-label-md uppercase block mb-spacing-2">规格或包路径</label>
          <Input
            data-testid="spec-input"
            type="text"
            value={sourceRef}
            onChange={(e) => setSourceRef(e.target.value)}
            placeholder="/path/to/rig.yaml 或 /path/to/bundle.rigbundle"
            className="font-mono text-body-md"
          />
          <p className="text-label-sm text-foreground-muted mt-spacing-1">
            支持 .yaml 工作组规格或 .rigbundle 归档。{" "}
            <span
              role="link"
              tabIndex={0}
              className="text-primary cursor-pointer"
              data-testid="inspect-link"
              onClick={() => navigate({ to: "/bundles/inspect" })}
              onKeyDown={(e) => { if (e.key === "Enter") navigate({ to: "/bundles/inspect" }); }}
            >
              先检查包 →
            </span>
          </p>
          <div className="mt-spacing-4">
            <Button variant="tactical" onClick={handlePlan} disabled={!sourceRef.trim()} data-testid="plan-btn">
              规划
            </Button>
          </div>
        </div>
        </WorkflowSection>
      )}

      {/* 步骤 2：规划中 */}
      {step === "planning" && (
        <div data-testid="step-planning" className="text-body-md text-foreground-muted">
          正在规划…
        </div>
      )}

      {/* 步骤 3：已规划 / 审阅 */}
      {step === "planned" && planResult && (
        <WorkflowSection
          title="计划审阅"
          description="审阅需求探测结果，并批准引导应执行的安装操作。"
        >
        <div data-testid="step-planned">
          {/* 阶段 */}
          <h3 className="text-headline-md uppercase mb-spacing-3">阶段</h3>
          <div className="space-y-spacing-1 mb-spacing-6" data-testid="stage-list">
            {planResult.stages.map((s) => (
              <div key={s.stage} className="flex items-center gap-spacing-3 text-label-sm font-mono" data-testid="stage-row">
                <span className={s.status === "ok" ? "text-success" : s.status === "blocked" ? "text-warning" : "text-foreground-muted"}>
                  {s.status.toUpperCase()}
                </span>
                <span>{s.stage}</span>
              </div>
            ))}
          </div>

          {/* 需求 */}
          {requirements.length > 0 && (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">需求</h3>
              <div className="mb-spacing-6">
                <RequirementsPanel results={requirements} />
              </div>
            </>
          )}

          {/* 操作 */}
          {actions.length > 0 && (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">操作</h3>
              <div className="space-y-spacing-1 mb-spacing-4">
                {actions.map((a) => (
                  <label key={a.key} className="flex items-center gap-spacing-3 text-label-sm font-mono cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoApprove || selectedKeys.has(a.key)}
                      disabled={autoApprove || a.classification === "manual_only"}
                      onChange={(e) => {
                        const next = new Set(selectedKeys);
                        if (e.target.checked) next.add(a.key);
                        else next.delete(a.key);
                        setSelectedKeys(next);
                      }}
                    />
                    <span className={a.classification === "manual_only" ? "text-warning" : ""}>{a.requirementName}</span>
                    {a.commandPreview && <span className="text-foreground-muted">{a.commandPreview}</span>}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-spacing-2 text-label-sm mb-spacing-4">
                <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
                自动批准全部受信任操作
              </label>
            </>
          )}

          {/* 阻断警告 */}
          {isPlanBlocked && (
            <div className="text-warning text-label-sm mb-spacing-4" data-testid="blocked-warning">
              必须先解决手动需求，引导才能继续。
            </div>
          )}

          {/* 警告 */}
          {planResult.warnings.length > 0 && (
            <div className="mb-spacing-4">
              {planResult.warnings.map((w, i) => (
                <div key={i} className="text-warning text-label-sm">{w}</div>
              ))}
            </div>
          )}

          <Button
            variant="tactical"
            onClick={handleApply}
            disabled={isPlanBlocked || noneSelected}
            title={isPlanBlocked ? "必须先解决手动需求" : noneSelected ? "选择要批准的操作" : undefined}
            data-testid="apply-btn"
          >
            执行
          </Button>
        </div>
        </WorkflowSection>
      )}

      {/* 步骤 4：执行中 —— 显示计划中的阶段清单 */}
      {step === "applying" && planResult && (
        <WorkflowSection
          title="执行中"
          description="引导正在执行已批准的操作并导入工作组。"
        >
        <div data-testid="step-applying">
          <h3 className="text-headline-md uppercase mb-spacing-3">执行中</h3>
          <div className="space-y-spacing-1 mb-spacing-4" data-testid="applying-checklist">
            {planResult.stages.map((s) => (
              <div key={s.stage} className="flex items-center gap-spacing-3 text-label-sm font-mono">
                <span className="text-foreground-muted">○</span>
                <span>{s.stage}</span>
              </div>
            ))}
            <div className="flex items-center gap-spacing-3 text-label-sm font-mono">
              <span className="text-foreground-muted">○</span>
              <span>execute_external_installs</span>
            </div>
            <div className="flex items-center gap-spacing-3 text-label-sm font-mono">
              <span className="text-foreground-muted">○</span>
              <span>install_packages</span>
            </div>
            <div className="flex items-center gap-spacing-3 text-label-sm font-mono">
              <span className="text-foreground-muted">○</span>
              <span>import_rig</span>
            </div>
          </div>
          <p className="text-body-sm text-foreground-muted">正在引导…</p>
        </div>
        </WorkflowSection>
      )}

      {/* 步骤 5：完成 */}
      {step === "done" && planResult && (
        <WorkflowSection
          title="结果"
          description="引导完成并返回受管工作组身份。"
        >
        <div data-testid="step-done">
          <h3 className="text-headline-md uppercase mb-spacing-3">
            {planResult.status === "completed" ? "引导完成" : "引导部分完成"}
          </h3>
          <div className="text-label-sm font-mono space-y-spacing-1 mb-spacing-4">
            <div>状态：<span className={planResult.status === "completed" ? "text-success" : "text-warning"}>{planResult.status.toUpperCase()}</span></div>
            {(planResult as { rigId?: string }).rigId && (
              <div data-testid="result-rig-id">工作组：{(planResult as { rigId?: string }).rigId}</div>
            )}
          </div>
          {(planResult as { rigId?: string }).rigId && (
            <Button
              variant="tactical"
              data-testid="view-rig-btn"
              onClick={() => navigate({ to: "/rigs/$rigId", params: { rigId: (planResult as unknown as { rigId: string }).rigId } })}
            >
              查看工作组
            </Button>
          )}
        </div>
        </WorkflowSection>
      )}

      {/* 错误 */}
      {step === "error" && (
        <WorkflowSection
          title="引导错误"
          description="引导无法完成。修复问题后重试计划。"
        >
        <div data-testid="step-error">
          <p className="text-destructive text-body-md mb-spacing-4">{errorMessage}</p>
          <Button variant="tactical" onClick={handleReset} data-testid="try-again-btn">
            重试
          </Button>
        </div>
        </WorkflowSection>
      )}
      </div>
    </WorkspacePage>
  );
}
