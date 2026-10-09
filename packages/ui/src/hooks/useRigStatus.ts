// OPR.0.4.3.22 —— 组合后的 rig 状态对象（GET /api/rigs/:id/status）。
//
// 与后台服务的 `composeRigStatus` 折叠对应：一个 rig 的状态由多个后端信号
// （ps 生命周期 + 恢复计划 + 恢复检查 + 内核状态）组合而成，绝不从窗格文本或
// /healthz 推断。`src[]` 是这次组合的来源。各席位的真实状态被保留
// （锁定：不做全局“全部刷新”的翻转）。

import { useQuery } from "@tanstack/react-query";

export type RigAggStatus = "up" | "partial" | "down" | "blocked" | "unknown";
export type SeatTokenState = "present" | "missing" | "stale" | "unverified";
export type SeatIntendedAction = "resume-original" | "fresh-primed" | "awaiting-decision";

export interface RigStatusSeat {
  logicalId: string;
  runtime: string | null;
  lifecycleState: "running" | "detached" | "recoverable" | "attention_required";
  tokenState: SeatTokenState;
  intendedAction: SeatIntendedAction;
  freshRequired: boolean;
  blocked: boolean;
  provenance?: string | null;
  lastVerified?: string | null;
  reason?: string;
  runtimePrompt?: string;
}

export interface RigStatusObject {
  rigId: string;
  rigName: string;
  isKernel: boolean;
  status: RigAggStatus;
  seatsTotal: number;
  seatsRunning: number;
  recoverable: boolean;
  perSeat: RigStatusSeat[];
  src: string[];
}

async function fetchRigStatus(rigId: string): Promise<RigStatusObject> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useRigStatus(rigId: string | undefined) {
  return useQuery({
    queryKey: ["rig", rigId, "status"],
    queryFn: () => fetchRigStatus(rigId!),
    enabled: !!rigId,
    // 状态会折叠恢复检查（涉及一些文件系统探测）——温和轮询，不要用 ps 那种 3 秒节奏。
    refetchInterval: 10_000,
  });
}
