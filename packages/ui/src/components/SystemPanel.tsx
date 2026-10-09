import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ServerCog } from "lucide-react";
import { LogFeedList } from "./ActivityFeed.js";
import { SettingsTab } from "./system/SettingsTab.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";
import { ToolMark } from "./graphics/RuntimeMark.js";
// OPR.0.4.3.21 —— 唯一的后台服务健康状态来源（与实时终端的
// 控制面不健康消歧共享），而非面板本地轮询 /healthz。
import { useDaemonHealth } from "../hooks/useDaemonHealth.js";

type SystemTab = "log" | "status" | "settings";

async function fetchCmux(): Promise<{ available: boolean }> {
  const res = await fetch("/api/adapters/cmux/status");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface SystemPanelProps {
  onClose: () => void;
  events: ActivityEvent[];
  initialTab?: SystemTab;
}

function statusTone(ok: boolean | null): string {
  if (ok === null) return "text-on-surface-variant";
  return ok ? "text-green-600" : "text-amber-600";
}

function statusLabel(ok: boolean | null, positive: string, negative: string, unknown = "未知"): string {
  if (ok === null) return unknown;
  return ok ? positive : negative;
}

// OPR.0.4.3.21 前瞻修复 —— 后台服务健康表面如实展示楔形状态：
// 一个 /healthz 能应答（进程存在）但事件循环判定为 `healthy:false` 的后台服务，
// 渲染为"有证据的不健康"，而不是"已连接"。
// `unavailable` = /healthz 无应答；`unknown` = 仍在加载。
type DaemonUiState = "unknown" | "connected" | "unhealthy" | "unavailable";

function daemonStateTone(state: DaemonUiState): string {
  switch (state) {
    case "connected": return "text-green-600";
    case "unhealthy": return "text-amber-600";
    case "unavailable": return "text-amber-600";
    default: return "text-on-surface-variant";
  }
}

function daemonStateLabel(state: DaemonUiState): string {
  switch (state) {
    case "connected": return "已连接";
    case "unhealthy": return "进程在运行，健康状态异常";
    case "unavailable": return "不可用";
    default: return "未知";
  }
}

export function SystemPanel({ onClose, events, initialTab = "log" }: SystemPanelProps) {
  const [activeTab, setActiveTab] = useState<SystemTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const { query: healthQuery, signal: healthSignal } = useDaemonHealth();

  const cmuxQuery = useQuery({
    queryKey: ["daemon", "cmux"],
    queryFn: fetchCmux,
    refetchInterval: 30_000,
    retry: false,
  });

  // OPR.0.4.3.21 前瞻修复 —— 从 isSuccess 和事件循环判定共同派生。
  // 当 eventLoop.healthy !== false 时，healthy/connected 路径不变。
  const eventLoopUnhealthy = healthQuery.isSuccess && healthSignal.evidence?.healthy === false;
  const daemonState: DaemonUiState =
    eventLoopUnhealthy ? "unhealthy"
    : healthQuery.isSuccess ? "connected"
    : healthQuery.isError ? "unavailable"
    : "unknown";
  // cmux 状态仅在后台服务应答（进程存在）后才有意义，无论其事件循环是否被阻塞。
  const daemonResponded = healthQuery.isSuccess;
  const cmuxAvailable = daemonResponded ? (cmuxQuery.data?.available ?? null) : null;

  return (
    <aside
      data-testid="system-panel"
      className="absolute inset-y-0 right-0 z-20 w-80 border-l border-outline-variant/25 bg-[hsl(var(--background)/0.035)] supports-[backdrop-filter]:bg-[hsl(var(--background)/0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/35 shrink-0">
        <h2 className="min-w-0 font-mono text-xs font-bold text-on-surface truncate">系统</h2>
        <button
          data-testid="system-close"
          onClick={onClose}
          className="text-on-surface-variant hover:text-on-surface text-sm"
          aria-label="关闭"
        >
          ✕
        </button>
      </div>

      <div className="flex border-b border-outline-variant/35 shrink-0" data-testid="system-tabs">
        <button
          data-testid="system-tab-log"
          onClick={() => setActiveTab("log")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "log" ? "border-b-2 border-on-surface font-bold text-on-surface" : "text-on-surface-variant"}`}
        >
          近期日志
        </button>
        <button
          data-testid="system-tab-status"
          onClick={() => setActiveTab("status")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "status" ? "border-b-2 border-on-surface font-bold text-on-surface" : "text-on-surface-variant"}`}
        >
          状态
        </button>
        <button
          data-testid="system-tab-settings"
          onClick={() => setActiveTab("settings")}
          className={`flex-1 py-2 text-xs font-mono uppercase text-center ${activeTab === "settings" ? "border-b-2 border-on-surface font-bold text-on-surface" : "text-on-surface-variant"}`}
        >
          设置
        </button>
      </div>

      {activeTab === "log" && (
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden" data-testid="system-log-tab">
          <LogFeedList events={events} />
        </div>
      )}
      {activeTab === "status" && (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4" data-testid="system-status-tab">
          <section className="border border-outline-variant/28 bg-surface-lowest/[0.12] px-3 py-3">
            <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-3">运行时</div>
            <div className="space-y-3 font-mono text-[10px]">
              <div className="flex items-start gap-3">
                <ServerCog className={`mt-[1px] h-3.5 w-3.5 shrink-0 ${daemonStateTone(daemonState)}`} />
                <div className="min-w-0">
                  <div className="text-on-surface">后台服务</div>
                  <div data-testid="system-daemon-status" className={daemonStateTone(daemonState)}>
                    {daemonStateLabel(daemonState)}
                  </div>
                  {/* OPR.0.4.3.21 前瞻修复 —— 进程存在但事件循环被阻塞时，
                      展示事件循环证据。 */}
                  {eventLoopUnhealthy && healthSignal.evidence && (
                    <div data-testid="system-daemon-evidence" className="text-amber-600">
                      事件循环饥饿 —— 滞后 {healthSignal.evidence.lagMeanMs.toFixed(0)}ms，
                      最后心跳 {healthSignal.evidence.lastTickAgeMs.toFixed(0)}ms
                    </div>
                  )}
                  <div className="text-on-surface-variant">控制本地 zrig 后台服务连接。</div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <ToolMark tool="cmux" size="sm" className={`mt-[1px] ${statusTone(cmuxAvailable)}`} />
                <div className="min-w-0">
                  <div className="text-on-surface">cmux 控制</div>
                  <div data-testid="system-cmux-status" className={statusTone(cmuxAvailable)}>
                    {statusLabel(cmuxAvailable, "可用", "不可用")}
                  </div>
                  <div className="text-on-surface-variant">zrig 可控制 cmux 面板以打开或聚焦节点。</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
      {activeTab === "settings" && <SettingsTab />}
    </aside>
  );
}
