// V1 attempt-3 Phase 3——设置>状态标签页的系统状态面板。
// 按 code-map AFTER 树（新建）。由现有数据源组合后台服务健康 + cmux 状态。
//
// Phase 3 回弹修复 A4：恢复 cmux 块（回归——从原 SystemPanel L52–L131 抽取时
// 漏掉了 cmux 查询与区块）。

import { useQuery } from "@tanstack/react-query";
import { SectionHeader } from "../ui/section-header.js";
import { StatusPip } from "../ui/status-pip.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { usePsEntries } from "../../hooks/usePsEntries.js";

async function fetchHealth(): Promise<boolean> {
  const res = await fetch("/healthz");
  if (!res.ok) throw new Error("unhealthy");
  return true;
}

async function fetchCmux(): Promise<{ available: boolean }> {
  const res = await fetch("/api/adapters/cmux/status");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function SettingsSystemStatusPanel() {
  const healthQuery = useQuery({
    queryKey: ["daemon", "health"],
    queryFn: fetchHealth,
    refetchInterval: 10_000,
    retry: false,
  });
  const cmuxQuery = useQuery({
    queryKey: ["daemon", "cmux"],
    queryFn: fetchCmux,
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: rigs, isLoading: rigsLoading, error: rigsError } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const daemonConnected = healthQuery.isSuccess;
  const cmuxAvailable = daemonConnected ? (cmuxQuery.data?.available ?? null) : null;
  const totalRigs = rigs?.length ?? 0;
  const runningRigs = psEntries?.filter((p) => p.runningCount > 0).length ?? 0;

  const daemonStatus: React.ComponentProps<typeof StatusPip>["status"] =
    daemonConnected
      ? "active"
      : healthQuery.isError
      ? "error"
      : healthQuery.isLoading
      ? "info"
      : "stopped";

  const cmuxStatus: React.ComponentProps<typeof StatusPip>["status"] =
    cmuxAvailable === true
      ? "active"
      : cmuxAvailable === false
      ? "warning"
      : "info";

  return (
    <div data-testid="settings-status-panel" className="space-y-4">
      <section>
        <SectionHeader tone="muted">后台服务</SectionHeader>
        <div className="mt-2 flex items-center justify-between font-mono text-xs">
          <span className="text-on-surface-variant">可达</span>
          <StatusPip
            status={daemonStatus}
            label={
              daemonConnected
                ? "正常"
                : healthQuery.isError
                ? "错误"
                : healthQuery.isLoading
                ? "加载中"
                : "未连接"
            }
            variant="pill"
            testId="status-daemon"
          />
        </div>
      </section>
      {/* A4 回弹修复：恢复 cmux 控制行。 */}
      <section>
        <SectionHeader tone="muted">CMUX 控制</SectionHeader>
        <div className="mt-2 flex items-center justify-between font-mono text-xs">
          <span className="text-on-surface-variant">适配器</span>
          <StatusPip
            status={cmuxStatus}
            label={
              cmuxAvailable === true
                ? "可用"
                : cmuxAvailable === false
                ? "不可用"
                : "未知"
            }
            variant="pill"
            testId="status-cmux"
          />
        </div>
        <div className="mt-1 font-mono text-[10px] text-on-surface-variant">
          zrig 可控制 cmux 界面，用于打开或聚焦节点。
        </div>
      </section>
      <section>
        <SectionHeader tone="muted">工作组</SectionHeader>
        <div className="mt-2 space-y-1.5 font-mono text-xs">
          <div className="flex justify-between">
            <span className="text-on-surface-variant">总计</span>
            <span className="text-on-surface font-bold" data-testid="status-rigs-total">{totalRigs}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-on-surface-variant">运行中</span>
            <span className="text-on-surface font-bold" data-testid="status-rigs-running">{runningRigs}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
