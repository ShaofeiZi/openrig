// OPR.0.4.3.21 —— 共享的后台服务健康信号。
//
// 一个后台服务可能活着、在监听，但事件循环卡死而无法服务请求。
// `/healthz` 跑在同一个循环上，因此一次失败/超时的健康轮询
// （或一个事件循环判定为 `healthy:false` 的增强响应体）就是诚实的
// 「控制面不健康」信号。
//
// 这是系统面板与实时终端共用的唯一信源：面板经 {@link useDaemonHealth}，
// 终端经 React context（这样它能优雅降级——没有 provider 挂载时
// `useContext` 返回健康默认值，例如在许多单独渲染 FocusedTerminal 的终端单测里）。

import { createContext, useContext } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

export interface DaemonEventLoopEvidence {
  lagMeanMs: number;
  lagP99Ms: number;
  utilization: number;
  lastTickAgeMs: number;
  healthy: boolean;
}

export interface DaemonHealthPayload {
  status: string;
  /** 仅当后台服务已接入事件循环监视器时存在（OPR.0.4.3.21+）。 */
  eventLoop?: DaemonEventLoopEvidence;
}

async function fetchDaemonHealth(): Promise<DaemonHealthPayload> {
  const res = await fetch("/healthz");
  if (!res.ok) throw new Error("unhealthy");
  return (await res.json()) as DaemonHealthPayload;
}

export interface DaemonHealthSignal {
  /**
   * 仅在明确知道控制面不健康时为 true：健康轮询失败（卡死的循环无法响应 /healthz），
   * 或 healthz 已响应但其事件循环判定为 `healthy:false`。未知/首次加载状态绝不为 true，
   * 因而终端只有在存在真实信号时才覆盖 broker 的通用消息。
   */
  controlPlaneUnhealthy: boolean;
  evidence: DaemonEventLoopEvidence | null;
}

/**
 * 后台服务健康查询。使用系统面板一直采用的同一 queryKey，因此所有使用方共享一次轮询和
 * 一个缓存条目。
 */
export function useDaemonHealthQuery(): UseQueryResult<DaemonHealthPayload> {
  return useQuery({
    queryKey: ["daemon", "health"],
    queryFn: fetchDaemonHealth,
    refetchInterval: 10_000,
    retry: false,
  });
}

export function deriveDaemonHealthSignal(query: UseQueryResult<DaemonHealthPayload>): DaemonHealthSignal {
  const evidence = query.data?.eventLoop ?? null;
  const controlPlaneUnhealthy = query.isError || evidence?.healthy === false;
  return { controlPlaneUnhealthy, evidence };
}

/** 便捷组合：查询加派生信号，供面板类使用方调用。 */
export function useDaemonHealth(): { query: UseQueryResult<DaemonHealthPayload>; signal: DaemonHealthSignal } {
  const query = useDaemonHealthQuery();
  return { query, signal: deriveDaemonHealthSignal(query) };
}

// 默认健康：未挂载 provider 时，终端绝不覆盖消息；这使所有不带 provider 的 FocusedTerminal
// 单元测试保持原有行为。
export const DaemonHealthContext = createContext<DaemonHealthSignal>({
  controlPlaneUnhealthy: false,
  evidence: null,
});

export function useDaemonHealthSignal(): DaemonHealthSignal {
  return useContext(DaemonHealthContext);
}
