// OPR.0.4.6.MH5——组合全局读取契约的 UI 镜像（useReview 的同级实现；一个聚合端点，
// 两个由创建者锁定的表面——/fleet 路由页与 FLEET 条带——都使用此钩子，因此两者
// 对“只计一次”的身份规则不会产生分歧）。
//
// D-6 + 架构 R1.1（FS-1 启用条件，具约束力）：轮询节奏是有界、具名常量，且明确规定
// 下限不得短于已交付 feed 的节奏类别；绝不使用无界或魔法间隔。已交付的 feed 类别
//（useAttentionItems/useReview）为 staleTime 15 秒 + refetchOnWindowFocus "always"；
// 全局读取增加一个有界后台间隔，取该下限的 2 倍。FS-1 性能事故已证明
// “N 台主机 × 组合读取 × M 个打开标签页”会放大后台服务卡死：逐主机读取截止时间限制单次
// 轮询，而此常量限制轮询频率。SSE 活性是具名后续项（D-6）；规模化启用属于 FS-1
// 发布验证范围，不由本节奏决定。

import { useQuery } from "@tanstack/react-query";

// --- 契约镜像（packages/daemon/src/domain/review/types.ts 的 MH5 块）---

import type { NeedsYouItem } from "./useReview.js";
import type { AttentionHostStatus } from "./useAttentionItems.js";

/** 已交付的 NeedsYouItem，加上全局主机维度、Q4 只计一次键和可检查来源（FR-3）。 */
export interface FleetNeedsYouItem extends NeedsYouItem {
  hostId: string;
  /** `${hostId}|${identity}`——在展开的抽屉中逐字显示。 */
  fleetKey: string;
  /** 此身份在其主机上可见的层级（即扇出实际读取的内容；v1 读取每台主机的工作组根）。 */
  seenFrom: string[];
}

/** 只有成功读取主机组合集合（status 为 ok）时才提供计数；无法访问的主机条目是缺失，
 *  而不是零。 */
export interface FleetHostRollup {
  hostId: string;
  kind: "local" | "remote";
  status: AttentionHostStatus;
  needsYouCount?: number;
  exceptionsByKind?: Array<{ kind: string; count: number }>;
  seatCount?: number;
  rigCount?: number;
  topLine?: string;
}

export interface ComposedFleetRollup {
  needsYouCount: number;
  exceptionCount: number;
  exceptionsByKind: Array<{ kind: string; count: number }>;
  hostCount: number;
  unreachableCount: number;
}

export interface FleetSettledRow {
  fromSession: string;
  toSession: string;
  summary: string | null;
  closedAtIso: string;
  qitemId: string;
  hostId: string;
}

export interface ComposedFleet {
  rollup: ComposedFleetRollup;
  needsYou: { items: FleetNeedsYouItem[]; provenance: string };
  hosts: FleetHostRollup[];
  settled: FleetSettledRow[];
  settledProvenance: string;
  /** 仅当注册表存在但加载失败时提供；如实反映，不会静默退化为仅本地全局视图。 */
  registryError?: string;
  composedAt: string;
}

// --- R1.1：有界、具名的轮询节奏 ---

/** feed 节奏类别的下限（已交付的 attention/review staleTime）。
 *  FLEET_POLL_INTERVAL_MS 绝不能低于此值。 */
export const FLEET_POLL_FLOOR_MS = 15_000;

/** 全局后台轮询间隔——有界且具名（架构 R1.1）。取 feed 下限的 2 倍：全局读取会在服务端
 *  扇出到 N 台主机，因此轮询频率是单主机读取类别刷新频率的一半。 */
export const FLEET_POLL_INTERVAL_MS = 30_000;

export const FLEET_QUERY_KEY = ["review", "fleet"] as const;

async function fetchFleet(): Promise<ComposedFleet> {
  const res = await fetch("/api/review/fleet");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ComposedFleet;
}

/** 两个锁定表面共享的唯一全局读取。`enabled` 使 AMBIENT 条带能根据全局是否存在来门控
 *  获取动作，而不只是门控渲染；单主机操作员的 /agents 页面不会发起任何新增全局读取
 *  （FS-1 放大器约束），而 /fleet 路由因用户明确进入细查而始终读取。 */
export function useFleet(opts: { enabled?: boolean } = {}) {
  return useQuery<ComposedFleet>({
    queryKey: FLEET_QUERY_KEY,
    queryFn: fetchFleet,
    enabled: opts.enabled ?? true,
    staleTime: FLEET_POLL_FLOOR_MS,
    refetchInterval: FLEET_POLL_INTERVAL_MS,
    // HG-8（已纳入）：使用字符串形式；布尔值 `true` 会受过期谓词限制，可能在窗口期内
    // 跳过聚焦后的重新获取。
    refetchOnWindowFocus: "always",
  });
}
