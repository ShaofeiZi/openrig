// OPR.0.4.3.22 —— 内核状态（GET /api/kernel/status）。
//
// 内核健康来自内核启动追踪界面，绝不从后台服务 /healthz 检查推断（guard 4）。
// 200 时返回追踪器信封；追踪器未接入时返回 503 的 `kernel_boot_tracker_unavailable`
// 形态——界面据此渲染为 `unknown`，绝不显示为绿色（健康）。

import { useQuery } from "@tanstack/react-query";

export type KernelState =
  | "skipped"
  | "auth_blocked"
  | "spec_missing"
  | "booting"
  | "partial_ready"
  | "ready"
  | "bootstrap_failed"
  | "degraded";

export interface KernelStatusAgent {
  session_name: string;
  runtime: string;
  startup_status: "pending" | "ready" | "attention_required" | "failed";
}

export interface KernelStatus {
  kernel_state: KernelState;
  agents: KernelStatusAgent[];
  first_unready_since: string | null;
  variant: string | null;
  detail: string | null;
}

/** 503 形态——该后台服务未接入追踪器。 */
export interface KernelStatusUnavailable {
  error: "kernel_boot_tracker_unavailable";
  message: string;
}

export type KernelStatusResult = KernelStatus | KernelStatusUnavailable;

export function isKernelUnavailable(r: KernelStatusResult | undefined): r is KernelStatusUnavailable {
  return !!r && "error" in r;
}

async function fetchKernelStatus(): Promise<KernelStatusResult> {
  const res = await fetch("/api/kernel/status");
  // 503 返回合法的 JSON 信封（追踪器不可用）——正常消费，不抛错。
  if (res.status === 503) return res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useKernelStatus() {
  return useQuery({
    queryKey: ["kernel", "status"],
    queryFn: fetchKernelStatus,
    refetchInterval: 10_000,
  });
}
