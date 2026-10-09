import type { Hono } from "hono";
import type { TmuxAdapter } from "../adapters/tmux.js";
import * as crypto from "node:crypto";
import {
  TerminalBrokerRegistry,
  type BrokerTmux,
  type TerminalSessionBroker,
  type TerminalSubscriber,
} from "../terminal/TerminalSessionBroker.js";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const MAX_EARLY_TERMINAL_FRAMES = 32;
const MAX_EARLY_TERMINAL_FRAME_BYTES = 256 * 1024;

export function registerTerminalWs(
  app: Hono,
  upgradeWebSocket: Parameters<typeof import("@hono/node-ws").createNodeWebSocket>[0] extends { app: infer _A } ? never : never,
  opts: { bearerToken: string | null },
): void;
export function registerTerminalWs(
  app: Hono,
  upgradeWebSocket: (createHandler: (c: unknown) => unknown) => unknown,
  opts: { bearerToken: string | null; livenessIntervalMs?: number },
): void {
  const terminalAuthMiddleware = async (c: { req: { header(name: string): string | undefined; query(name: string): string | undefined }; json(data: unknown, status: number): unknown }, next: () => Promise<void>) => {
    const upgrade = c.req.header("Upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      const origin = c.req.header("Origin");
      if (origin) {
        try {
          const originHost = new URL(origin).hostname;
          const requestHost = c.req.header("Host")?.split(":")[0] ?? "";
          const allowed = originHost === requestHost || originHost === "localhost" || originHost === "127.0.0.1";
          if (!allowed) return c.json({ error: "origin_rejected", hint: `Origin ${origin} 与 host 不匹配` }, 403);
        } catch {
          return c.json({ error: "origin_rejected", hint: "Origin 头格式错误" }, 403);
        }
      }
    }
    const token = opts.bearerToken;
    if (!token) { await next(); return; }
    const header = c.req.header("Authorization") ?? c.req.header("authorization");
    if (header) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match && constantTimeEqual(match[1]!.trim(), token)) { await next(); return; }
    }
    const queryToken = c.req.query("token");
    if (queryToken && constantTimeEqual(queryToken.trim(), token)) { await next(); return; }
    return c.json({ error: "unauthorized", hint: "通过 Authorization 头或 ?token= 查询参数传递 terminal token" }, 401);
  };

  // 一个后台服务持有的 broker registry，跨所有 WebSocket 连接共享，
  // 从第一个连接的 tmux adapter 惰性创建（后台服务单例）。
  // 这让一个席位的多个观看者共享同一根 pipe 和一路 fan-out 流，
  // 而不是争抢按连接分配的 pipe。
  let registry: TerminalBrokerRegistry | null = null;
  const getRegistry = (tmux: BrokerTmux): TerminalBrokerRegistry => {
    if (!registry) {
      registry = new TerminalBrokerRegistry(tmux, { livenessMs: opts.livenessIntervalMs });
    }
    return registry;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).get(
    "/api/terminal/:sessionName",
    terminalAuthMiddleware,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (upgradeWebSocket as any)((c: any) => {
      const sessionName = decodeURIComponent(c.req.param("sessionName")!);
      let broker: TerminalSessionBroker | null = null;
      let subscriber: TerminalSubscriber | null = null;
      // WebSocket 可能在异步 attach 期间（broker 引用 resolve 之前）关闭。
      // 没有这个标志，onClose 会发现 broker===null 而跳过 detach，
      // 一旦 attach 最终 resolve 就留下一个幽灵 subscriber + 泄漏的 pipe。
      // 该标志让 onOpen 在事后重新 detach。
      let closed = false;
      // 客户端在 ws.onopen 触发的那一刻即可发送（CHAT initialText 帧正是如此——
      // OPR.0.4.4.20 delta-C），这可能在 onOpen 仍等待 attach 时到达此处。
      // 缓冲这些帧并在 broker resolve 后排空；丢弃它们会在每次 attach 慢于
      // 客户端时丢掉那一帧预填的 CHAT 内容。
      const earlyFrames: string[] = [];
      let earlyFrameBytes = 0;

      const handleFrame = async (data: string): Promise<void> => {
        if (!broker) return;
        try {
          const msg = JSON.parse(data) as Record<string, unknown>;
          if (msg.type === "keys" && Array.isArray(msg.keys)) {
            await broker.input({ type: "keys", keys: msg.keys as string[] });
          } else if (msg.type === "text" && typeof msg.text === "string") {
            await broker.input({ type: "text", text: msg.text });
          } else if (msg.type === "scroll" && typeof msg.offset === "number") {
            // OPR.0.4.0.39：按 subscriber 的回滚（tmux capture-pane 窗口）。
            // offset = 实时底部之上的行数；0 = 实时。按连接进行，
            // 使每个观看者独立滚动（在共享 pane 上只读）。
            if (subscriber) await broker.scroll(subscriber, msg.offset);
          }
          // FR-7：刻意没有 resize 分支。geometry 由 broker 固定持有；
          // 客户端驱动的 resize 被忽略，使多个观看者无法压缩共享 pane。
        } catch { /* 忽略格式错误的帧 */ }
      };

      return {
        async onOpen(_evt: unknown, ws: { send(data: string): void; close(code: number, reason: string): void }) {
          const tmux = c.get("tmuxAdapter") as TmuxAdapter | undefined;
          if (!tmux) { ws.close(1011, "tmux adapter 不可用"); return; }
          // 把 WebSocket 适配为 broker subscriber。broker 持有 pipe、seed、fanout、
          // 诚实的会话死亡关闭以及清理。
          const sub: TerminalSubscriber = {
            send: (data: string) => { try { ws.send(data); } catch { /* socket 已关闭 */ } },
            close: (code: number, reason: string) => { try { ws.close(code, reason); } catch { /* 已关闭 */ } },
          };
          subscriber = sub;
          const b = await getRegistry(tmux as unknown as BrokerTmux).attach(sessionName, sub);
          broker = b;
          // 若 socket 在 attach 进行期间关闭，现在就 detach，使 broker 不持有
          // 一个死掉的 subscriber（detach 幂等）。
          if (closed) { b.detach(sub); return; }
          // 按顺序排空 attach 进行期间到达的所有帧。
          while (earlyFrames.length > 0 && !closed) {
            const next = earlyFrames.shift()!;
            earlyFrameBytes -= Buffer.byteLength(next, "utf8");
            await handleFrame(next);
          }
        },

        async onMessage(evt: { data: unknown }, ws: { close(code: number, reason: string): void }) {
          if (closed) return;
          const data = typeof evt.data === "string" ? evt.data : "";
          if (!data) return;
          if (!broker) {
            const bytes = Buffer.byteLength(data, "utf8");
            if (
              earlyFrames.length >= MAX_EARLY_TERMINAL_FRAMES
              || earlyFrameBytes + bytes > MAX_EARLY_TERMINAL_FRAME_BYTES
            ) {
              closed = true;
              try { ws.close(1009, "就绪前的 terminal 输入超出缓冲上限"); } catch { /* 已关闭 */ }
              return;
            }
            earlyFrames.push(data);
            earlyFrameBytes += bytes;
            return;
          }
          await handleFrame(data);
        },

        async onClose() {
          closed = true;
          if (broker && subscriber) {
            broker.detach(subscriber);
          }
        },
      };
    }),
  );
}
