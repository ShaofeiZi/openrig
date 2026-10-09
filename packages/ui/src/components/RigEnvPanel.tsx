import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { RigEnvData } from "../hooks/useRigEnv.js";

interface RigEnvPanelProps {
  rigId: string;
  envData: RigEnvData;
}

export function RigEnvPanel({ rigId, envData }: RigEnvPanelProps) {
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [downPending, setDownPending] = useState(false);
  const [downResult, setDownResult] = useState<string | null>(null);

  const receipt = envData.receipt;
  const surfaces = envData.surfaces;
  const services = receipt?.services ?? [];
  const waitFor = receipt?.waitFor ?? [];

  function formatWaitTarget(target: Record<string, unknown>): string {
    if (typeof target.url === "string") return target.url;
    if (typeof target.tcp === "string") return target.tcp;
    if (typeof target.service === "string") {
      return typeof target.condition === "string"
        ? `${target.service} (${target.condition})`
        : target.service;
    }
    return JSON.stringify(target);
  }

  function deriveEnvState(): "Healthy" | "Degraded" | "Stopped" | "Unknown" {
    if (!receipt) return "Unknown";
    const allHealthyServices = services.length > 0 && services.every((s) => s.health === "healthy");
    const anyRunningServices = services.some((s) => s.status === "running");
    const allHealthyWaits = waitFor.length > 0 && waitFor.every((gate) => gate.status === "healthy");
    const anyPendingWaits = waitFor.some((gate) => gate.status === "pending");
    const anyUnhealthyWaits = waitFor.some((gate) => gate.status === "unhealthy");

    if (allHealthyServices && (waitFor.length === 0 || allHealthyWaits)) return "Healthy";
    if (anyRunningServices || anyPendingWaits) return "Degraded";
    if (anyUnhealthyWaits) return "Stopped";
    if (allHealthyWaits) return "Healthy";
    if (services.length > 0) return "Stopped";
    return "Unknown";
  }

  /** 环境状态的中文展示标签（枚举值本身不变，仅渲染时映射）。 */
  const ENV_STATE_LABEL_ZH: Record<string, string> = {
    Healthy: "健康",
    Degraded: "降级",
    Stopped: "已停止",
    Unknown: "未知",
  };

  const envState = deriveEnvState();

  const fetchLogs = async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/env/logs?tail=100`);
      const data = await res.json() as { ok: boolean; output?: string; error?: string };
      if (!data.ok) {
        setLogsError(data.error ?? "获取日志失败");
      } else {
        setLogs(data.output ?? "");
      }
    } catch (err) {
      setLogsError((err as Error).message);
    } finally {
      setLogsLoading(false);
    }
  };

  const stopEnv = async () => {
    setDownPending(true);
    setDownResult(null);
    try {
      const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/env/down`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      setDownResult(data.ok ? "环境已停止。" : (data.error ?? "停止环境失败。"));
    } catch (err) {
      setDownResult((err as Error).message);
    } finally {
      setDownPending(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto" data-testid="env-panel">
      {/* 整体环境状态 */}
      <section className="px-4 py-3 border-b border-outline-variant">
        <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-1">环境</div>
        <div data-testid="env-state" className={`font-mono text-[12px] font-bold ${
          envState === "Healthy" ? "text-green-700"
            : envState === "Degraded" ? "text-amber-600"
            : envState === "Stopped" ? "text-red-600"
            : "text-on-surface-variant"
        }`}>
          {ENV_STATE_LABEL_ZH[envState] ?? envState}
        </div>
      </section>

      {/* 服务 */}
      {services.length > 0 && (
        <section className="px-4 py-3 border-b border-outline-variant">
          <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-2">服务</div>
          <div className="space-y-1">
            {services.map((svc) => (
              <div key={svc.name} className="flex items-center justify-between font-mono text-[10px]">
                <span className="text-on-surface">{svc.name}</span>
                <span className={svc.health === "healthy" ? "text-green-700" : "text-on-surface-variant"}>
                  {svc.health ?? svc.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 健康门禁 */}
      {waitFor.length > 0 && (
        <section className="px-4 py-3 border-b border-outline-variant">
          <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-2">健康门禁</div>
          <div className="space-y-2">
            {waitFor.map((gate, index) => (
              <div key={`${formatWaitTarget(gate.target)}-${index}`} className="space-y-1 font-mono text-[10px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-on-surface break-all">{formatWaitTarget(gate.target)}</span>
                  <span className={
                    gate.status === "healthy"
                      ? "text-green-700"
                      : gate.status === "pending"
                        ? "text-amber-600"
                        : "text-red-600"
                  }>
                    {gate.status}
                  </span>
                </div>
                {gate.detail && <div className="text-on-surface-variant break-all">{gate.detail}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 面板 */}
      {surfaces && (surfaces.urls?.length || surfaces.commands?.length) && (
        <section className="px-4 py-3 border-b border-outline-variant">
          <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-2">面板</div>
          <div className="space-y-1">
            {surfaces.urls?.map((u) => (
              <div key={u.name} className="flex items-center justify-between font-mono text-[10px]">
                <span className="text-on-surface">{u.name}</span>
                <a href={u.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate ml-2">
                  {u.url}
                </a>
              </div>
            ))}
            {surfaces.commands?.map((cmd) => (
              <div key={cmd.name} className="flex items-center justify-between font-mono text-[10px]">
                <span className="text-on-surface">{cmd.name}</span>
                <span className="text-on-surface-variant truncate ml-2">{cmd.command}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 操作 */}
      <section className="px-4 py-3 border-b border-outline-variant">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void fetchLogs()} disabled={logsLoading}>
            {logsLoading ? "加载中..." : "查看日志"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void stopEnv()} disabled={downPending}>
            {downPending ? "停止中..." : "停止环境"}
          </Button>
        </div>
        {downResult && <div className="mt-2 font-mono text-[9px] text-on-surface-variant">{downResult}</div>}
      </section>

      {/* 日志输出 */}
      {logsError && (
        <section className="px-4 py-3">
          <div className="font-mono text-[9px] text-red-600">{logsError}</div>
        </section>
      )}
      {logs !== null && !logsError && (
        <section className="px-4 py-3">
          <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-2">日志</div>
          <pre className="font-mono text-[9px] text-on-surface whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-background p-2 border border-outline-variant">
            {logs || "（空）"}
          </pre>
        </section>
      )}
    </div>
  );
}
