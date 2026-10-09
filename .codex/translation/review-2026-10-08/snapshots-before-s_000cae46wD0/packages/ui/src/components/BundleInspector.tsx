import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useBundleInspect, type InspectResult } from "../hooks/useBundles.js";
import { cn } from "@/lib/utils";
import { WorkspacePage } from "./WorkspacePage.js";

export function BundleInspector() {
  const [bundlePath, setBundlePath] = useState("");
  const inspectMutation = useBundleInspect();

  const handleInspect = () => {
    if (!bundlePath.trim()) return;
    inspectMutation.mutate({ bundlePath: bundlePath.trim() });
  };

  const result = inspectMutation.data;

  return (
    <WorkspacePage>
    <div data-testid="bundle-inspector">
      <h2 className="text-headline-lg uppercase mb-spacing-4">检查包</h2>

      <div className="mb-spacing-4">
        <label className="text-label-md uppercase block mb-spacing-2">包路径</label>
        <input
          data-testid="bundle-path-input"
          type="text"
          value={bundlePath}
          onChange={(e) => setBundlePath(e.target.value)}
          placeholder="/path/to/my-rig.rigbundle"
          className="w-full bg-transparent border-b border-foreground/20 py-spacing-2 text-body-md font-mono focus:outline-none focus:border-primary"
        />
        <Button variant="tactical" onClick={handleInspect} disabled={!bundlePath.trim() || inspectMutation.isPending} className="mt-spacing-3" data-testid="inspect-btn">
          {inspectMutation.isPending ? "检查中…" : "检查"}
        </Button>
      </div>

      {inspectMutation.isError && (
        <div className="text-destructive text-body-md mb-spacing-4" data-testid="inspect-error">
          {inspectMutation.error.message}
        </div>
      )}

      {result && (
        <div data-testid="inspect-result">
          {/* 清单摘要 */}
          <div className="card-dark p-spacing-4 mb-spacing-4" data-testid="manifest-summary">
            <div className="flex items-center gap-spacing-2 mb-spacing-2">
              <h3 className="text-headline-md uppercase">{result.manifest.name}</h3>
              <span className="text-label-sm font-mono px-spacing-2 py-px bg-foreground/10" data-testid="schema-badge">
                v{result.manifest.schemaVersion ?? 1}
              </span>
            </div>
            <div className="text-label-sm font-mono text-foreground-muted-on-dark">v{result.manifest.version}</div>
            <div className="text-label-sm font-mono text-foreground-muted-on-dark">规格：{result.manifest.rigSpec}</div>
            <div className="mt-spacing-2 flex gap-spacing-3">
              <span className={cn("text-label-sm", result.digestValid ? "text-success" : "text-destructive")}>
                摘要：{result.digestValid ? "有效" : "无效"}
              </span>
              <span className={cn("text-label-sm", result.integrityResult.passed ? "text-success" : "text-destructive")} data-testid="integrity-status">
                完整性：{result.integrityResult.passed ? "通过" : "失败"}
              </span>
            </div>
          </div>

          {/* v2：智能体列表；v1：包列表 */}
          {result.manifest.schemaVersion === 2 && result.manifest.agents ? (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">智能体</h3>
              <div className="space-y-spacing-1 mb-spacing-4" data-testid="agent-list">
                {result.manifest.agents.map((agent) => (
                  <div key={agent.name} className="text-label-sm font-mono" data-testid="agent-entry">
                    {agent.name} v{agent.version} — {agent.path}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">包</h3>
              <div className="space-y-spacing-1 mb-spacing-4" data-testid="package-list">
                {(result.manifest.packages ?? []).map((pkg) => (
                  <div key={pkg.name} className="text-label-sm font-mono" data-testid="package-entry">
                    {pkg.name} v{pkg.version} — {pkg.path}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 项 1 / slice-05：来源块（bundle 携带时渲染） */}
          {result.manifest.provenance && (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">来源</h3>
              <div className="card-dark p-spacing-4 mb-spacing-4 space-y-spacing-1" data-testid="provenance-block">
                {result.manifest.provenance.createdAt && (
                  <div className="text-label-sm font-mono" data-testid="provenance-createdAt">
                    <span className="text-foreground-muted-on-dark">创建于：</span>{result.manifest.provenance.createdAt}
                  </div>
                )}
                {result.manifest.provenance.sourceHost && (
                  <div className="text-label-sm font-mono" data-testid="provenance-sourceHost">
                    <span className="text-foreground-muted-on-dark">主机：</span>{result.manifest.provenance.sourceHost}
                  </div>
                )}
                {result.manifest.provenance.authorSession && (
                  <div className="text-label-sm font-mono" data-testid="provenance-authorSession">
                    <span className="text-foreground-muted-on-dark">作者：</span>{result.manifest.provenance.authorSession}
                  </div>
                )}
                {result.manifest.provenance.sourceRigName && (
                  <div className="text-label-sm font-mono" data-testid="provenance-sourceRigName">
                    <span className="text-foreground-muted-on-dark">工作组：</span>{result.manifest.provenance.sourceRigName}
                    {result.manifest.provenance.sourceRigId && (
                      <span className="text-foreground-muted-on-dark">（{result.manifest.provenance.sourceRigId}）</span>
                    )}
                  </div>
                )}
                {(result.manifest.provenance.daemonVersion || result.manifest.provenance.cliVersion) && (
                  <div className="text-label-sm font-mono" data-testid="provenance-versions">
                    <span className="text-foreground-muted-on-dark">构建于：</span>
                    {result.manifest.provenance.daemonVersion && <>后台服务 {result.manifest.provenance.daemonVersion}</>}
                    {result.manifest.provenance.daemonVersion && result.manifest.provenance.cliVersion && " / "}
                    {result.manifest.provenance.cliVersion && <>CLI {result.manifest.provenance.cliVersion}</>}
                  </div>
                )}
                {result.manifest.provenance.notes && (
                  <div className="text-label-sm font-mono whitespace-pre-wrap mt-spacing-2" data-testid="provenance-notes">
                    <span className="text-foreground-muted-on-dark">备注：</span>{result.manifest.provenance.notes}
                  </div>
                )}
              </div>
            </>
          )}

          {/* 项 2 / slice-05：兼容性块（bundle 携带时渲染）。与“是否兼容当前后台服务”的实时比较延后——UI 仅展示 bundle 声明的最低版本；/api/bundles/install 处的安装时检查才对运行中的后台服务强制真实兼容性。 */}
          {result.manifest.compatibility && (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">兼容性</h3>
              <div className="card-dark p-spacing-4 mb-spacing-4 space-y-spacing-1" data-testid="compatibility-block">
                {result.manifest.compatibility.minDaemonVersion && (
                  <div className="text-label-sm font-mono" data-testid="compatibility-minDaemonVersion">
                    <span className="text-foreground-muted-on-dark">最低后台服务：</span>{result.manifest.compatibility.minDaemonVersion}
                  </div>
                )}
                {result.manifest.compatibility.minCliVersion && (
                  <div className="text-label-sm font-mono" data-testid="compatibility-minCliVersion">
                    <span className="text-foreground-muted-on-dark">最低 CLI：</span>{result.manifest.compatibility.minCliVersion}
                  </div>
                )}
                {result.manifest.compatibility.schemaVersion !== undefined && (
                  <div className="text-label-sm font-mono" data-testid="compatibility-schemaVersion">
                    <span className="text-foreground-muted-on-dark">规范版本：</span>v{result.manifest.compatibility.schemaVersion}
                  </div>
                )}
              </div>
            </>
          )}

          {/* 逐文件完整性 */}
          {result.integrityResult && (
            <>
              <h3 className="text-headline-md uppercase mb-spacing-3">文件完整性</h3>
              <div className="space-y-spacing-1 mb-spacing-4" data-testid="file-integrity">
                {Object.keys((result.manifest.packages ?? result.manifest.agents ?? []).length > 0 ? (result as unknown as { manifest: { integrity?: { files: Record<string, string> } } }).manifest?.integrity?.files ?? {} : {}).map((file) => {
                  const isMismatch = result.integrityResult.mismatches.includes(file);
                  const isMissing = result.integrityResult.missing.includes(file);
                  const status = isMismatch ? "不匹配" : isMissing ? "缺失" : "正常";
                  return (
                    <div key={file} className="flex items-center gap-spacing-3 text-label-sm font-mono" data-testid="file-row">
                      <span className={cn("w-2 h-2", status === "正常" ? "bg-success" : "bg-destructive")} data-testid="file-dot" />
                      <span>{file}</span>
                      <span className="text-foreground-muted ml-auto">{status}</span>
                    </div>
                  );
                })}
                {result.integrityResult.extra.map((file) => (
                  <div key={file} className="flex items-center gap-spacing-3 text-label-sm font-mono" data-testid="file-row">
                    <span className="w-2 h-2 bg-warning" data-testid="file-dot" />
                    <span>{file}</span>
                    <span className="text-foreground-muted ml-auto">多余</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 安装按钮 */}
          <Button variant="tactical" data-testid="install-btn" onClick={() => window.location.href = `/bundles/install?bundlePath=${encodeURIComponent(bundlePath)}`}>
            安装此包
          </Button>
        </div>
      )}
    </div>
    </WorkspacePage>
  );
}
