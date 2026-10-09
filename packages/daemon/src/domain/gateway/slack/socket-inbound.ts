// S10——后台服务内的 Socket Mode 入站服务。循环沿用已交付 relay runner 的形状
//（从随切换一并退役的 CLI `zrig slack inbound` 动作原样迁入）：通过 apps.connections.open
// 打开 WebSocket，快速 ACK 每个 envelope，经 InboundRouter 路由人工消息，在连接建立时及之后
// 定期排空 dead-letter（B1），并按退避策略重连。修订 A1（M1 §3）：入站只走 PLATFORM socket，
// 即本服务，绝不走 gateway↔connector wire。
//
// 冷启动回执（双路径类别 "inbound cold-init"）：每次（重新）连接时，router 的 dead-letter
// 集合会在处理新流量前排空；全新启动则从持久 seen/dead-letter store 的断点继续，
// 既不产生重放风暴，也不丢消息。

import { openSocketConnection, type FetchImpl } from "./slack-api.js";
import { handleEnvelope, type InboundRouter, type SocketEnvelope } from "./inbound.js";
import type { InboundReceiptStore, InboundReceiptStatus } from "./state-store.js";

export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: ((this: unknown, ev?: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null;
  onclose: ((this: unknown, ev?: unknown) => void) | null;
  onerror: ((this: unknown, ev?: unknown) => void) | null;
}

export interface SocketInboundDeps {
  fetchImpl?: FetchImpl;
  /** 打开 Socket Mode WebSocket（默认使用全局 WebSocket）；测试可注入替代实现。 */
  wsFactory?: (url: string) => WsLike;
  /** 测试接缝：运行 N 次重连后停止；默认持续运行，直到调用 stop()。 */
  inboundMaxConnects?: number;
  /** socket 保持连接期间的 dead-letter 重试节奏，默认 5 分钟。 */
  retryIntervalMs?: number;
  receipts?: InboundReceiptStore;
  log?: (msg: string) => void;
}

export interface SocketInboundHandle {
  /** 循环结束时 resolve（达到 maxConnects 或调用 stop()）。 */
  done: Promise<void>;
  stop(): void;
  status(): SocketInboundStatus;
}

export interface SocketInboundStatus {
  generation: number;
  reconnects: number;
  state: "connecting" | "connected" | "disconnected" | "stopped";
  connectedAt?: string;
  disconnectedAt?: string;
  lastEventAt?: string;
  lastEventTs?: string;
  lastDisposition?: InboundReceiptStatus;
}

/** 启动 Socket Mode 循环：保持已交付 runner 的精确形状，并封装为带 stop() 的服务。 */
export function startSocketInbound(appToken: string, router: InboundRouter, deps: SocketInboundDeps = {}): SocketInboundHandle {
  const log = deps.log ?? (() => {});
  const wsFactory = deps.wsFactory ?? ((url: string) => new (globalThis as unknown as { WebSocket: new (u: string) => WsLike }).WebSocket(url));
  const retryIntervalMs = deps.retryIntervalMs ?? 5 * 60 * 1000;
  let connects = 0;
  let backoff = 1000;
  let stopped = false;
  let liveWs: WsLike | undefined;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const status: SocketInboundStatus = { generation: 0, reconnects: 0, state: "disconnected" };
  const stamp = () => new Date().toISOString();
  const receipt = (entry: Parameters<InboundReceiptStore["append"]>[0]): void => {
    try {
      deps.receipts?.append(entry);
    } catch (error) {
      // 可观测性失败绝不能导致已经 ACK 的人工消息丢失。
      log(`入站回执写入失败（${entry.status}）：${(error as Error).message}`);
    }
  };

  const done = new Promise<void>((resolve) => {
    const connect = async (): Promise<void> => {
      if (stopped) return resolve();
      connects++;
      status.generation = connects;
      status.reconnects = Math.max(0, connects - 1);
      status.state = "connecting";
      receipt({ generation: connects, status: "connect-attempt" });
      const open = await openSocketConnection(appToken, deps.fetchImpl);
      if (stopped) return resolve();
      if (!open.ok || !open.url) {
        log(`连接失败：${open.error}`);
        status.state = "disconnected";
        status.disconnectedAt = stamp();
        receipt({ generation: connects, status: "connect-failed", reason: "connection-open-failed" });
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
        return;
      }
      const ws = wsFactory(open.url);
      liveWs = ws;
      let retryTimer: ReturnType<typeof setInterval> | undefined;
      ws.onopen = () => {
        backoff = 1000;
        log("socket 已连接");
        status.state = "connected";
        status.connectedAt = stamp();
        receipt({ generation: connects, status: "connected" });
        void router.retryDeadLetters(); // 连接时排空（冷启动）……
        // ……并在连接期间定期重试（B1：队列中断后的恢复不能等到下次 Slack 重连）。关闭时清除。
        retryTimer = setInterval(() => void router.retryDeadLetters(), retryIntervalMs);
        if (typeof (retryTimer as unknown as { unref?: () => void }).unref === "function") {
          (retryTimer as unknown as { unref: () => void }).unref();
        }
      };
      ws.onmessage = (m) => {
        let env: SocketEnvelope;
        try {
          env = JSON.parse(String(m.data)) as SocketEnvelope;
        } catch {
          return;
        }
        const ev = env.payload?.event;
        status.lastEventAt = stamp();
        status.lastEventTs = ev?.ts;
        void handleEnvelope(
          env,
          () => env.envelope_id && ws.send(JSON.stringify({ envelope_id: env.envelope_id })),
          router,
          log,
          () => receipt({
            generation: connects,
            status: "received",
            envelopeId: env.envelope_id,
            eventTs: ev?.ts,
            channel: ev?.channel,
          }),
        )
          .then((disposition) => {
            status.lastDisposition = disposition.status;
            receipt({
              generation: connects,
              status: disposition.status,
              envelopeId: env.envelope_id,
              eventTs: ev?.ts,
              channel: ev?.channel,
              reason: disposition.reason,
            });
          })
          .catch((error) => {
            status.lastDisposition = "handler-failed";
            receipt({
              generation: connects,
              status: "handler-failed",
              envelopeId: env.envelope_id,
              eventTs: ev?.ts,
              channel: ev?.channel,
              reason: "handler-threw",
            });
            log(`入站 handler 失败 ts=${ev?.ts ?? "-"}：${(error as Error).message}`);
          });
      };
      ws.onclose = () => {
        if (retryTimer) clearInterval(retryTimer);
        liveWs = undefined;
        status.state = stopped ? "stopped" : "disconnected";
        status.disconnectedAt = stamp();
        receipt({ generation: connects, status: "disconnected" });
        if (stopped) return resolve();
        log(`socket 已关闭；将在 ${backoff}ms 后重连`);
        if (deps.inboundMaxConnects && connects >= deps.inboundMaxConnects) return resolve();
        pendingTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* 忽略关闭错误。 */
        }
      };
    };
    void connect();
  });

  return {
    done,
    stop: () => {
      stopped = true;
      status.state = "stopped";
      if (pendingTimer) clearTimeout(pendingTimer);
      try { liveWs?.close(); } catch { /* 尽力关闭。 */ }
    },
    status: () => ({ ...status }),
  };
}
