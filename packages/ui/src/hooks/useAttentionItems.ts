// OPR.0.3.2.20 —— “For You”优先级窗口。
//
// useAttentionItems 封装后台服务的待关注读取——持久的事实来源——使“For You”的
// “需要操作”与“待审批”两个视图不再依赖客户端那个有损、易失的事件 FIFO
// （`useActivityFeed.MAX_ACTIVITY_EVENTS=100`）。
//
// OPR.0.4.4.15：当操作者启用了 ≥1 个远程主机订阅时，本 hook 改为轮询
// GET /api/queue/attention-aggregate（共享的 P4 约定：每项打上来源 hostId，并附带
// 一个按主机组织的结构化状态数组）——聚合在后台服务侧完成；本 hook 仍只与本地
// 后台服务通信（无 bearer、无跨域——这是 FR-1 的反向验收）。零配置保持今日的端点与
// 线上协议不变；本 hook 把两条路径都归一化为 {items, hosts}（旧路径下 hosts 为空）。
//
// HG-8 新鲜度：react-query 的 refetchOnWindowFocus 设为字符串 'always'（而非布尔 `true`）。
// 当存在非平凡 staleTime 时，布尔 `true` 会被新鲜度谓词门控，在 stale 窗口内可能跳过
// 重新拉取（沉淀反馈 feedback_refetchOnWindowFocus_staleness_gated_use_always_string）。
// 'always' 绕过该门控，使待关注界面在每次聚焦时都刷新。

import { useQuery } from "@tanstack/react-query";

export interface AttentionQueueItem {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  priority: string;
  tier: string | null;
  tags: string[] | null;
  blockedOn: string | null;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  body: string;
  /** 平实语言标题（队列摘要列），存在时使用。 */
  summary?: string | null;
  /** OPR.0.4.4.20 FR-9 收益 #2（Packet-1 C3）：“去评审”的指针。
   *  可选/防御性——P1 之前的后台服务上不存在。 */
  evidenceRef?: string | null;
  /** OPR.0.4.4.15：聚合项上的来源主机 id（'local' 或某个已注册主机 id）。
   *  旧的单主机路径上不存在。 */
  hostId?: string;
}

/** 后台服务 fanout 约定中 PerHostStatus 的镜像（封闭枚举）。 */
export interface AttentionHostStatus {
  hostId: string;
  status: "ok" | "unreachable" | "unsupported-transport" | "auth-failed";
  error?: string;
  failedStep?: string;
}

export interface AttentionData {
  items: AttentionQueueItem[];
  hosts: AttentionHostStatus[];
}

async function fetchAttentionItems(limit?: number): Promise<AttentionQueueItem[]> {
  const params = new URLSearchParams({ attention: "1" });
  if (limit !== undefined) params.set("limit", String(limit));
  const res = await fetch(`/api/queue/list?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AttentionQueueItem[];
}

async function fetchAggregatedAttention(limit?: number): Promise<AttentionData> {
  const res = await fetch("/api/queue/attention-aggregate");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as Partial<AttentionData>;
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    items: limit !== undefined ? items.slice(0, limit) : items,
    hosts: Array.isArray(payload.hosts) ? payload.hosts : [],
  };
}

/**
 * 开放的待关注类 qitem（tier="human-gate"，或目标经 isHumanSeatSessionRef
 * 判定为人类类——人类席位 /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/，
 * 或 A2 虚拟域分支 <local>@external）。状态默认为 pending|in-progress|blocked——
 * 已关闭/已完成的项不在此展示。
 *
 * `limit`（可选，默认 50）限制渲染集合，避免病态积压导致无限渲染。待关注集合本就很小。
 *
 * `aggregated`（OPR.0.4.4.15）：改为轮询合并后的多主机读取，而非单主机列表。
 * 仅在启用了远程主机订阅时调用方才传 true——零配置仍走旧线上协议。
 */
export function useAttentionItems(limit: number = 50, aggregated: boolean = false) {
  return useQuery<AttentionData>({
    queryKey: ["attention-items", limit, aggregated],
    queryFn: aggregated
      ? () => fetchAggregatedAttention(limit)
      : async () => ({ items: await fetchAttentionItems(limit), hosts: [] }),
    staleTime: 15_000,
    // HG-8：用 'always'（而非 `true`）——见文件头注释。
    refetchOnWindowFocus: "always",
  });
}
