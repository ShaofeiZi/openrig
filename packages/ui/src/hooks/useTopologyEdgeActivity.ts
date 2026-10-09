// PL-019 第 6 项：订阅共享的拓扑事件中枢，跟踪近期的席位间流量，
// 使拓扑图能突出“刚刚触发”的边（一次性约 1.2 秒脉冲），以及“近约 30 秒内有流量”
// 的边（权重 1.5 倍 + 更亮，随后衰减回中性）。
//
// 视觉约定：
//   - 用短促脉冲强调，而非常亮闪烁
//   - 每个事件一次性约 1.2 秒；方向有意义（源 → 目标）
//   - 近约 30 秒内有流量的边保持 1.5 倍权重 + 更亮
//   - 按事件类型区分提示为可选项；v0 把四种事件类型统一纳入同一种“流量”处理，保持克制
//
// 我们按 `${sourceSession}::${destinationSession}` 跟踪边状态，并暴露一个稳定的
// 查询函数供 RigGraph 的边映射 memo 调用。到真正 graph-edge-id 的解析发生在渲染时，
// 因为图节点知道自己的 canonicalSessionName。

import { useEffect, useRef, useState } from "react";
import { subscribeTopologyEvents } from "../lib/topology-events.js";

const RECENT_TRAFFIC_WINDOW_MS = 30_000;
const JUST_FIRED_WINDOW_MS = 1_200;
const PRUNE_INTERVAL_MS = 1_000;

export interface EdgeActivityEntry {
  // 该有向对最近一次触发的时间戳（自纪元起的毫秒）。
  lastFiredAt: number;
  // 我们当前强调的四种 PL-019 跟踪事件类型。v0 对它们一视同仁；
  // 后续迭代可按类型区分提示。
  lastEventType: string;
}

export interface EdgeActivityLookup {
  /** 返回某个有向（源 → 目标）对的活动条目，若无则返回 null。 */
  get(sourceSession: string, destSession: string): EdgeActivityEntry | null;
  /** 该对是否在“刚触发”窗口内触发过（一次性脉冲）。 */
  justFired(sourceSession: string, destSession: string, nowMs?: number): boolean;
  /** 该对是否在“近期流量”窗口内触发过（持续强调）。 */
  recentTraffic(sourceSession: string, destSession: string, nowMs?: number): boolean;
  /** 内部：React 渲染路径用于稳定相等比较的快照。 */
  version: number;
}

interface ParsedEvent {
  type?: string;
  // 每种被跟踪的事件类型用不同字段名表示源/目标会话；我们在解析时归一化。
  source?: string;
  dest?: string;
}

function normalizeEvent(raw: unknown): ParsedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : undefined;
  if (!type) return null;
  // queue.created             → sourceSession + destinationSession
  // queue.handed_off          → fromSession + toSession
  // qitem.fallback_routed     → originalDestination + rerouteDestination
  //                             （把 reroute 视为目标，使亮起的边指向新的归属方）
  // mission_control.action_executed → actorSession +（若已知则为 qitem 目标）
  //                             v0 只对能从单个事件负载构造出的 源→目标 对做动画；
  //                             action_executed 缺少目标，因此跳过它，
  //                             直到后续迭代把 qitem 目标带进事件本身。
  if (type === "queue.created") {
    const source = typeof e.sourceSession === "string" ? e.sourceSession : undefined;
    const dest = typeof e.destinationSession === "string" ? e.destinationSession : undefined;
    if (!source || !dest) return null;
    return { type, source, dest };
  }
  if (type === "queue.handed_off") {
    const source = typeof e.fromSession === "string" ? e.fromSession : undefined;
    const dest = typeof e.toSession === "string" ? e.toSession : undefined;
    if (!source || !dest) return null;
    return { type, source, dest };
  }
  if (type === "qitem.fallback_routed") {
    const source = typeof e.originalDestination === "string" ? e.originalDestination : undefined;
    const dest = typeof e.rerouteDestination === "string" ? e.rerouteDestination : undefined;
    if (!source || !dest) return null;
    return { type, source, dest };
  }
  return null;
}

function makeKey(sourceSession: string, destSession: string): string {
  return `${sourceSession}\u0000${destSession}`;
}

export function useTopologyEdgeActivity(): EdgeActivityLookup {
  // 以有向对为键的 Map。我们把它放在 ref 里，使 EventSource 处理器可以直接修改，
  // 而不触发订阅的拆除；渲染时读取一个 `version` 计数器，它在裁剪/触发时递增。
  const mapRef = useRef<Map<string, EdgeActivityEntry>>(new Map());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = subscribeTopologyEvents((parsed) => {
      if (cancelled) return;
      const normalized = normalizeEvent(parsed);
      if (!normalized || !normalized.source || !normalized.dest) return;
      const key = makeKey(normalized.source, normalized.dest);
      mapRef.current.set(key, {
        lastFiredAt: Date.now(),
        lastEventType: normalized.type ?? "unknown",
      });
      setVersion((v) => v + 1);
    });

    // 定期裁剪。即使没有新事件到达，一条刚掉出“近期流量”窗口的边也应重新渲染以失去强调。
    const pruneTimer = setInterval(() => {
      if (cancelled) return;
      const cutoff = Date.now() - RECENT_TRAFFIC_WINDOW_MS;
      let mutated = false;
      for (const [key, entry] of mapRef.current.entries()) {
        if (entry.lastFiredAt < cutoff) {
          mapRef.current.delete(key);
          mutated = true;
        }
      }
      if (mutated) setVersion((v) => v + 1);
    }, PRUNE_INTERVAL_MS);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(pruneTimer);
    };
  }, []);

  // 返回绑定到最新 version 的稳定接口。调用方应把 `version` 放进 useMemo 依赖列表，
  // 以便活动变化时刷新；这样也避免暴露原始可变 Map。
  return {
    version,
    get(sourceSession: string, destSession: string): EdgeActivityEntry | null {
      return mapRef.current.get(makeKey(sourceSession, destSession)) ?? null;
    },
    justFired(sourceSession: string, destSession: string, nowMs?: number): boolean {
      const entry = mapRef.current.get(makeKey(sourceSession, destSession));
      if (!entry) return false;
      const now = nowMs ?? Date.now();
      return now - entry.lastFiredAt < JUST_FIRED_WINDOW_MS;
    },
    recentTraffic(sourceSession: string, destSession: string, nowMs?: number): boolean {
      const entry = mapRef.current.get(makeKey(sourceSession, destSession));
      if (!entry) return false;
      const now = nowMs ?? Date.now();
      return now - entry.lastFiredAt < RECENT_TRAFFIC_WINDOW_MS;
    },
  };
}

// 仅供测试的辅助函数，按命名导出，使 vitest 无需启动 EventSource 即可驱动查询。
// 与 Phase A 测试对待 MissionControlReadLayer 构造函数的方式一致。
export const __test_internals = {
  RECENT_TRAFFIC_WINDOW_MS,
  JUST_FIRED_WINDOW_MS,
  normalizeEvent,
  makeKey,
};
