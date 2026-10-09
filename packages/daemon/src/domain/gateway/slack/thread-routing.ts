// S10——基于 thread↔seat map 的确定性 thread routing。四种枚举类别（proof contract）均为纯 lookup，
// 不做推断：
//   1. 新 conversation——仅 outbound：新 root 不带 thread 发出，随后打开 map
//                       （thread_ts = 已发出 root 的 ts）。Inbound 永不创建。
//   2. 已有 thread——reply 携带 thread_ts，命中 open map → 准确路由到 mapped seat。
//   3. 已关闭 thread——命中 closed map → 仍准确路由到 mapped seat（closure 是 conversation state，
//                    绝不是 routing black hole）。
//   4. 未映射 / human initiated——thread_ts 没有 mapping，或顶层 channel message（无 thread_ts）：
//                    写入 ORCHESTRATOR 的 unrouted-signal row——即带 unrouted-signal tag 的已配置
//                    inbound destination。绝不丢弃，也绝不猜测 seat。

import type { SlackEvent } from "./inbound.js";
import type { ThreadSeatMap } from "./thread-seat-map.js";

export interface InboundRoute {
  destination: string;
  tags: string[];
  /** 此 thread 所服务的准确 human-gate qitem；未映射 traffic 中缺失。 */
  correlationQitemId?: string;
  /** 触发的 routing class——每类 receipt 由 row tag + log 携带。 */
  routeClass: "existing-thread" | "closed-thread" | "unmapped-thread" | "human-initiated";
}

const BASE_TAGS = ["founder-slack", "inbound"];

export function makeThreadRouteResolver(opts: {
  map: ThreadSeatMap;
  /** unrouted signal 对应的 orchestrator slot（一等 config：inboundDestination）。 */
  unroutedDestination: string;
  log?: (msg: string) => void;
}): (ev: SlackEvent & { thread_ts?: string }) => InboundRoute {
  const log = opts.log ?? (() => {});
  return (ev) => {
    const threadTs = (ev as { thread_ts?: string }).thread_ts;
    if (threadTs) {
      const mapping = opts.map.resolveByThread(threadTs);
      if (mapping) {
        // FOUNDER ROOT INVARIANT（2026-08-27）：map 存储裸本地 seat，因为同一 instance 中 queue row
        // 的 source_session 是裸值——seat 按存储值路由。（L2 首轮的临时 self-host localizer 已随 root
        // stamping 删除；历史三段式 row 属于 operator adoption 的一次性清理。）
        const routeClass = mapping.state === "closed" ? "closed-thread" : "existing-thread";
        log(`入站已路由 thread_ts=${threadTs} → ${mapping.seat}（${routeClass}）`);
        return {
          destination: mapping.seat,
          tags: [...BASE_TAGS, "thread", `reply-to:${mapping.conversationId}`],
          correlationQitemId: mapping.conversationId,
          routeClass,
        };
      }
      log(`入站未映射 thread_ts=${threadTs} → 向 ${opts.unroutedDestination} 发送 unrouted-signal（绝不丢弃，绝不猜测）`);
      return { destination: opts.unroutedDestination, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "unmapped-thread" };
    }
    log(`人工发起的入站消息（无 thread_ts）→ 向 ${opts.unroutedDestination} 发送 unrouted-signal`);
    return { destination: opts.unroutedDestination, tags: [...BASE_TAGS, "unrouted-signal"], routeClass: "human-initiated" };
  };
}
