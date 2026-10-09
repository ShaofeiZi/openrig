import type { ComposeServicesAdapter, ComposeServiceStatus } from "../adapters/compose-services-adapter.js";
import type { RigServicesWaitTarget } from "./types.js";

export interface WaitTargetResult {
  target: RigServicesWaitTarget;
  status: "healthy" | "unhealthy" | "pending";
  detail: string | null;
}

/**
 * 共享 readiness 求值器。wait-target 求值与派生 env health 逻辑的唯一位置。
 *
 * 已发布消费者：
 * - 启动时 health gate（ServiceOrchestrator.boot）
 * - 按需 receipt 捕获（ServiceOrchestrator.captureReceipt → env 路由）
 *
 * 已延期：
 * - 后台 health monitor（尚未实现）
 * - rig ps env 汇总（尚未实现）
 */
export async function evaluateWaitTargets(
  targets: RigServicesWaitTarget[],
  adapter: ComposeServicesAdapter,
  composeStatuses?: ComposeServiceStatus[],
): Promise<WaitTargetResult[]> {
  const results: WaitTargetResult[] = [];

  for (const target of targets) {
    if (target.url) {
      // HTTP 探针。
      const ok = await adapter.probeHttp(target.url);
      results.push({
        target,
        status: ok ? "healthy" : "unhealthy",
        detail: ok ? null : `HTTP 探针失败：${target.url}`,
      });
    } else if (target.tcp) {
      // TCP 探针。
      const ok = await adapter.probeTcp(target.tcp);
      results.push({
        target,
        status: ok ? "healthy" : "unhealthy",
        detail: ok ? null : `TCP 探针失败：${target.tcp}`,
      });
    } else if (target.condition === "healthy" && target.service) {
      // Compose health check——检查 compose ps 输出。
      const svc = composeStatuses?.find((s) => s.name === target.service);
      if (!svc) {
        results.push({ target, status: "unhealthy", detail: `compose 状态中未找到 service '${target.service}'` });
      } else if (svc.health === "healthy") {
        results.push({ target, status: "healthy", detail: null });
      } else {
        results.push({ target, status: svc.health === "starting" ? "pending" : "unhealthy", detail: `Service '${target.service}' 健康状态：${svc.health ?? svc.state}` });
      }
    } else {
      results.push({ target, status: "unhealthy", detail: "未知 wait target 类型" });
    }
  }

  return results;
}

/** 从 wait target 结果派生整体 env health。 */
export function deriveEnvHealth(results: WaitTargetResult[]): "healthy" | "degraded" | "unhealthy" {
  if (results.length === 0) return "healthy";
  const allHealthy = results.every((r) => r.status === "healthy");
  if (allHealthy) return "healthy";
  const anyHealthy = results.some((r) => r.status === "healthy");
  return anyHealthy ? "degraded" : "unhealthy";
}
