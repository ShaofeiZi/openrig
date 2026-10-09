import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useBundleInstall, type BundleInstallResult } from "../hooks/useBundles.js";
import { WorkspacePage } from "./WorkspacePage.js";

type Step = "enter" | "planning" | "planned" | "applying" | "done" | "error";

export function BundleInstallFlow() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("enter");
  // 若 URL 查询参数中带 bundlePath（来自 inspector 的交接），则读取它
  const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const [bundlePath, setBundlePath] = useState(urlParams?.get("bundlePath") ?? "");
  const [targetRoot, setTargetRoot] = useState("");
  const [planResult, setPlanResult] = useState<BundleInstallResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const installMutation = useBundleInstall();

  const handlePlan = async () => {
    if (!bundlePath.trim()) return;
    setStep("planning");
    try {
      const result = await installMutation.mutateAsync({ bundlePath: bundlePath.trim(), plan: true });
      setPlanResult(result);
      setStep("planned");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStep("error");
    }
  };

  const handleApply = async () => {
    if (!targetRoot.trim()) return;
    setStep("applying");
    try {
      const result = await installMutation.mutateAsync({
        bundlePath: bundlePath.trim(),
        autoApprove: true,
        targetRoot: targetRoot.trim(),
      });
      setPlanResult(result);
      setStep("done");
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStep("error");
    }
  };

  return (
    <WorkspacePage>
    <div data-testid="bundle-install-flow">
      <h2 className="text-headline-lg uppercase mb-spacing-4">安装安装包</h2>

      {step === "enter" && (
        <div data-testid="step-enter">
          <label className="text-label-md uppercase block mb-spacing-2">安装包路径</label>
          <input data-testid="bundle-input" type="text" value={bundlePath}
            onChange={(e) => setBundlePath(e.target.value)}
            placeholder="/path/to/my-rig.rigbundle"
            className="w-full bg-transparent border-b border-foreground/20 py-spacing-2 text-body-md font-mono focus:outline-none focus:border-primary mb-spacing-4" />
          <label className="text-label-md uppercase block mb-spacing-2">目标根目录</label>
          <input data-testid="target-input" type="text" value={targetRoot}
            onChange={(e) => setTargetRoot(e.target.value)}
            placeholder="/path/to/target/project"
            className="w-full bg-transparent border-b border-foreground/20 py-spacing-2 text-body-md font-mono focus:outline-none focus:border-primary mb-spacing-4" />
          <Button variant="tactical" onClick={handlePlan} disabled={!bundlePath.trim()} data-testid="plan-btn">规划</Button>
        </div>
      )}

      {step === "planning" && <div data-testid="step-planning" className="text-foreground-muted">正在规划…</div>}

      {step === "planned" && planResult && (
        <div data-testid="step-planned">
          <h3 className="text-headline-md uppercase mb-spacing-3">规划方案</h3>
          <div className="space-y-spacing-1 mb-spacing-4">
            {planResult.stages.map((s) => (
              <div key={s.stage} className="text-label-sm font-mono">
                <span className={s.status === "ok" ? "text-success" : "text-foreground-muted"}>{s.status.toUpperCase()}</span> {s.stage}
              </div>
            ))}
          </div>
          <Button variant="tactical" onClick={handleApply} disabled={!targetRoot.trim()} data-testid="apply-btn">应用</Button>
        </div>
      )}

      {step === "applying" && <div data-testid="step-applying" className="text-foreground-muted">正在安装…</div>}

      {step === "done" && planResult && (
        <div data-testid="step-done">
          <h3 className="text-headline-md uppercase mb-spacing-3">完成</h3>
          <div className="text-label-sm font-mono">
            状态：<span className="text-success">{planResult.status.toUpperCase()}</span>
            {planResult.stages.some((s) => s.detail?.source === "pod_bundle") ? (
              <span className="ml-spacing-2 text-primary" data-testid="bundle-type-label">支持 Pod 的安装包</span>
            ) : (
              <span className="ml-spacing-2 text-foreground-muted" data-testid="bundle-type-label">旧版安装包</span>
            )}
          </div>
          {planResult.rigId && (
            <div className="text-label-sm font-mono" data-testid="result-rig-id">工作组：{planResult.rigId}</div>
          )}
          {planResult.rigId && (
            <Button variant="tactical" className="mt-spacing-3" onClick={() => navigate({ to: "/rigs/$rigId", params: { rigId: planResult.rigId! } })}>查看工作组</Button>
          )}
        </div>
      )}

      {step === "error" && (
        <div data-testid="step-error">
          <p className="text-destructive text-body-md mb-spacing-4">{errorMessage}</p>
          <Button variant="tactical" onClick={() => { setStep("enter"); setErrorMessage(null); installMutation.reset(); }} data-testid="try-again-btn">重试</Button>
        </div>
      )}
    </div>
    </WorkspacePage>
  );
}
