import { performance } from "node:perf_hooks";
import type { MiddlewareHandler } from "hono";

/**
 * OPR.0.4.3.21——只为高成本 topology 路由（rig summary/graph、per-rig node、ps）记录 request
 * duration。这些是同步 CPU 最密集的 handler（per-rig getNodeInventory fan-out、tmux
 * attachAgentActivity），也是 event loop 饥饿时的首要嫌疑。
 *
 * 复用优先（ponytail）：一个轻量 `app.use` middleware，按 route label 在内存滚动记录 last/max，
 * 并在现有 `/healthz` payload 上呈现。不新增 route/store/persistence。不测量低成本路由
 *（label === null → middleware 对其 no-op）。
 */

export interface RouteTiming {
  /** 此路由最近一次 request 的 duration（ms）。 */
  lastMs: number;
  /** boot 后观测到的此路由最大 duration（ms）。 */
  maxMs: number;
  /** boot 后观测到的此路由 request 数。 */
  count: number;
}

/**
 * 将 request 分类为稳定的 expensive-route label；不在记录范围时返回 null。保持 pure，便于单元证明
 * label 行为。
 *
 * Grounded at 719a059e (IMPL-SPEC §1.4):
 *  - GET /api/rigs/summary        （rigs.ts:163 逐工作组 getNodeInventory）
 *  - GET /api/rigs/:id/graph      （rigs.ts:205 attachAgentActivity tmux 扇出）
 *  - GET /api/rigs/:id/nodes      （sessions.ts:82 逐节点充实）
 *  - GET /api/ps                  (ps-projection.ts:151 N+1 inventory)
 */
export function expensiveRouteLabel(method: string, path: string): string | null {
  if (method !== "GET") return null;
  if (path === "/api/ps") return "GET /api/ps";
  if (path === "/api/rigs/summary") return "GET /api/rigs/summary";
  // /api/rigs/:id/graph 与 /api/rigs/:id/nodes——/api/rigs/ 和末尾 verb 之间只有一个动态 segment。
  const rigsMatch = /^\/api\/rigs\/[^/]+\/(graph|nodes)$/.exec(path);
  if (rigsMatch) return `GET /api/rigs/:id/${rigsMatch[1]}`;
  return null;
}

export class RouteTimingRecorder {
  private readonly timings = new Map<string, RouteTiming>();

  record(label: string, durationMs: number): void {
    const existing = this.timings.get(label);
    if (!existing) {
      this.timings.set(label, { lastMs: durationMs, maxMs: durationMs, count: 1 });
      return;
    }
    existing.lastMs = durationMs;
    existing.maxMs = Math.max(existing.maxMs, durationMs);
    existing.count += 1;
  }

  snapshot(): Record<string, RouteTiming> {
    return Object.fromEntries(
      [...this.timings.entries()].map(([label, t]) => [label, { ...t }]),
    );
  }
}

/**
 * 唯一 timing middleware。测量 `next()` 前后的 wall-clock，且只在 request 映射到 expensive route
 * label 时记录。
 */
export function createRouteTimingMiddleware(recorder: RouteTimingRecorder): MiddlewareHandler {
  return async (c, next) => {
    const label = expensiveRouteLabel(c.req.method, c.req.path);
    if (!label) {
      await next();
      return;
    }
    const startedAt = performance.now();
    try {
      await next();
    } finally {
      recorder.record(label, performance.now() - startedAt);
    }
  };
}
