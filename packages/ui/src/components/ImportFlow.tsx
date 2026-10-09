import { useEffect, useState } from "react";
import { useImportRig, ImportError } from "../hooks/mutations.js";
import { getInstantiateStatusColorClass } from "@/lib/instantiate-status-colors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { WorkspacePage } from "./WorkspacePage.js";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { useSpecsWorkspace } from "./SpecsWorkspace.js";
import { WorkflowHeader, WorkflowSection, WorkflowStepIndicator } from "./WorkflowScaffold.js";

type Step = "input" | "validating" | "valid" | "preflight" | "preflight_done" | "instantiating" | "done" | "error";

interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

interface PreflightResult {
  ready: boolean;
  warnings?: string[];
  errors?: string[];
}

interface InstantiateResult {
  rigId: string;
  specName: string;
  specVersion: string;
  nodes: Array<{ logicalId: string; status: string; error?: string }>;
}

interface InstantiateFailure {
  ok: false;
  code: string;
  errors?: string[];
  warnings?: string[];
  message?: string;
}

interface ImportFlowProps {
  onBack?: () => void;
}

const STEPS = [
  { num: 1, label: "校验 RigSpec" },
  { num: 2, label: "预检" },
  { num: 3, label: "实例化" },
] as const;

function getStepNumber(step: Step): number {
  switch (step) {
    case "input": case "validating": return 1;
    case "valid": case "preflight": return 2;
    case "preflight_done": case "instantiating": case "done": return 3;
    case "error": return 0; // handled by errorAtStep
  }
}

export function ImportFlow({ onBack }: ImportFlowProps = {}) {
  const importRig = useImportRig();
  const {
    currentRigDraft,
    selectedRigDraft,
    saveRigDraft,
    rememberRigDraft,
    clearSelectedRigDraft,
  } = useSpecsWorkspace();
  const [yaml, setYaml] = useState(() => selectedRigDraft?.yaml ?? currentRigDraft?.yaml ?? "");
  const [rigRoot, setRigRoot] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [errorAtStep, setErrorAtStep] = useState<number>(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<InstantiateResult | null>(null);

  useEffect(() => {
    saveRigDraft(yaml);
  }, [saveRigDraft, yaml]);

  useEffect(() => {
    if (!selectedRigDraft) return;
    setYaml(selectedRigDraft.yaml);
    clearSelectedRigDraft();
  }, [clearSelectedRigDraft, selectedRigDraft]);

  const handleValidate = async () => {
    rememberRigDraft(yaml);
    setStep("validating");
    setErrors([]);
    try {
      const res = await fetch("/api/rigs/import/validate", {
        method: "POST",
        headers: { "Content-Type": "text/yaml" },
        body: yaml,
      });
      const data = (await res.json()) as ValidationResult;
      if (!data.valid) {
        setErrors(data.errors ?? ["校验失败"]);
        setErrorAtStep(1);
        setStep("error");
      } else {
        setStep("valid");
      }
    } catch {
      setErrors(["校验请求失败"]);
      setErrorAtStep(1);
      setStep("error");
    }
  };

  const handlePreflight = async () => {
    setStep("preflight");
    setErrors([]);
    setWarnings([]);
    try {
      const headers: Record<string, string> = { "Content-Type": "text/yaml" };
      if (rigRoot) headers["X-Rig-Root"] = rigRoot;
      const res = await fetch("/api/rigs/import/preflight", {
        method: "POST",
        headers,
        body: yaml,
      });
      const data = (await res.json()) as PreflightResult;
      // 即使同时有错误，也要始终记录警告
      setWarnings(data.warnings ?? []);
      if (data.errors && data.errors.length > 0) {
        setErrors(data.errors);
        setErrorAtStep(2);
        setStep("error");
      } else {
        setStep("preflight_done");
      }
    } catch {
      setErrors(["预检请求失败"]);
      setErrorAtStep(2);
      setStep("error");
    }
  };

  const handleInstantiate = async () => {
    setStep("instantiating");
    setErrors([]);
    try {
      const data = await importRig.mutateAsync({ yaml, rigRoot: rigRoot.trim() || undefined }) as InstantiateResult;
      setResult(data);
      setStep("done");
    } catch (err) {
      if (err instanceof ImportError) {
        if (err.code === "cycle_error") {
          setErrors(["工作组拓扑中检测到环路"]);
        } else {
          setErrors(err.errors);
        }
        setWarnings(err.warnings);
      } else {
        setErrors([err instanceof Error ? err.message : "实例化请求失败"]);
      }
      setErrorAtStep(3);
      setStep("error");
    }
  };

  return (
    <WorkspacePage>
      <div data-testid="import-flow" className="space-y-8">
      <WorkflowHeader
        eyebrow="工作组导入"
        title="导入工作组"
        description="校验 RigSpec、运行预检检查，再从 YAML 实例化一个拓扑。"
      />

      <WorkflowStepIndicator
        data-testid="step-indicator"
        steps={STEPS}
        currentStep={getStepNumber(step)}
        errorAtStep={step === "error" ? errorAtStep : 0}
      />

      {/* 第 1 步：输入 */}
      {step === "input" && (
        <WorkflowSection title="工作组 YAML" description="粘贴一份工作组规格，可选地提供工作组根目录，以便在导入时锚定相对引用。">
          <Textarea
            data-testid="yaml-input"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder="在此粘贴 YAML 工作组规格…"
            rows={14}
            className="font-mono text-body-sm mb-spacing-4"
          />
          <div className="mb-spacing-4">
            <label className="text-label-sm text-foreground-muted uppercase tracking-[0.04em] block mb-spacing-1">工作组根目录（可选）</label>
            <Input
              data-testid="rig-root-input"
              type="text"
              value={rigRoot}
              onChange={(e) => setRigRoot(e.target.value)}
              placeholder="/path/to/rig/root"
              className="font-mono text-body-sm"
            />
          </div>
          <Button
            variant="tactical"
            data-testid="validate-btn"
            onClick={handleValidate}
            disabled={!yaml.trim()}
          >
            校验 RigSpec
          </Button>
        </WorkflowSection>
      )}

      {/* 校验中 */}
      {step === "validating" && (
        <div className="text-label-md text-foreground-muted">正在校验…</div>
      )}

      {/* 第 2 步：校验通过 -> 预检 */}
      {step === "valid" && (
        <WorkflowSection title="校验通过" description="RigSpec 有效。实例化前请先运行预检检查。">
          <Alert className="mb-spacing-4" data-testid="valid-message">
            <AlertDescription className="text-primary">RigSpec 有效。运行预检检查？</AlertDescription>
          </Alert>
          <Button variant="tactical" data-testid="preflight-btn" onClick={handlePreflight}>
            运行预检
          </Button>
        </WorkflowSection>
      )}

      {/* 预检运行中 */}
      {step === "preflight" && (
        <div className="text-label-md text-foreground-muted">正在运行预检…</div>
      )}

      {/* 第 3 步：预检完成 -> 实例化 */}
      {step === "preflight_done" && (
        <WorkflowSection title="预检结果" description="把工作组实例化到运行时会话之前，请检查警告。">
          {warnings.length > 0 && (
            <Alert className="mb-spacing-4" data-testid="preflight-warnings">
              <AlertDescription className="text-warning">
                <div className="text-label-md uppercase mb-spacing-1">警告</div>
                {warnings.map((w, i) => <div key={i}>— {w}</div>)}
              </AlertDescription>
            </Alert>
          )}
          <Alert className="mb-spacing-4" data-testid="preflight-ready">
            <AlertDescription className="text-primary">预检通过。可以实例化。</AlertDescription>
          </Alert>
          <Button variant="tactical" data-testid="instantiate-btn" onClick={handleInstantiate}>
            实例化
          </Button>
        </WorkflowSection>
      )}

      {/* 实例化中 */}
      {step === "instantiating" && (
        <div className="text-label-md text-foreground-muted">正在实例化…</div>
      )}

      {/* 完成：结果 */}
      {step === "done" && result && (
        <WorkflowSection
          title="实例化结果"
          description="后台服务返回了导入拓扑逐节点的启动状态。"
          className="space-y-4"
        >
        <div data-testid="import-result">
          <Alert className="mb-spacing-4">
            <AlertDescription>
              <span className="text-primary font-mono">{result.specName}</span>
              <span className="text-foreground-muted"> ({result.rigId})</span>
            </AlertDescription>
          </Alert>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>节点</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.nodes.map((n) => (
                <TableRow key={n.logicalId}>
                  <TableCell className="font-mono">{n.logicalId}</TableCell>
                  <TableCell>
                    <span className={`font-mono ${getInstantiateStatusColorClass(n.status)}`} data-testid={`inst-status-${n.logicalId}`}>
                      {n.status}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {onBack ? (
            <div className="mt-spacing-6">
              <Button variant="ghost" onClick={onBack}>
                关闭
              </Button>
            </div>
          ) : null}
        </div>
        </WorkflowSection>
      )}

      {/* 错误状态 */}
      {step === "error" && (
        <WorkflowSection title="导入错误" description="修复报告的问题后，重试导入流程。">
        <div data-testid="import-errors">
          {warnings.length > 0 && (
            <Alert className="mb-spacing-2" data-testid="error-warnings">
              <AlertDescription className="text-warning">
                <div className="text-label-md uppercase mb-spacing-1">警告</div>
                {warnings.map((w, i) => <div key={i}>— {w}</div>)}
              </AlertDescription>
            </Alert>
          )}
          {errors.map((e, i) => (
            <Alert key={i} className="mb-spacing-2">
              <AlertDescription className="text-destructive">{e}</AlertDescription>
            </Alert>
          ))}
          <Button
            variant="tactical"
            className="mt-spacing-4"
            onClick={() => { setStep("input"); setErrors([]); setWarnings([]); setResult(null); setErrorAtStep(0); setRigRoot(""); }}
          >
            重试
          </Button>
        </div>
        </WorkflowSection>
      )}
      </div>
    </WorkspacePage>
  );
}
