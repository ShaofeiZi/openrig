// S10 移植：将 slice-11 transport receipt 迁移到后台服务的 socket-inbound service
//（runInboundLoop 从退役的 CLI runner 原样迁移；queue 接缝是进程内端口）。receipt 本身不变，
// 包括 B1 周期性排空。
import { describe, it, expect } from "vitest";
import { startSocketInbound, type WsLike, type SocketInboundDeps } from "../src/domain/gateway/slack/socket-inbound.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore, InboundReceiptStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function memFs(onAppend?: (path: string, data: string) => void): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    appendFileSync: (p, d) => { onAppend?.(p, d); files.set(p, (files.get(p) ?? "") + d); },
    writeFileSync: (p, d) => files.set(p, d),
    rename: (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-07-30T00:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 5));

// 可控的虚假 Socket Mode WebSocket。
function makeFakeWs() {
  const sent: string[] = [];
  const ws: WsLike = { send: (d) => sent.push(d), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
  return { ws, sent };
}
// 用 ws URL 响应 apps.connections.open 的 fetchImpl。
const openFetch: FetchImpl = async () =>
  new Response(JSON.stringify({ ok: true, url: "wss://fake-slack/ws" }), { status: 200, headers: { "content-type": "application/json" } });

const envelope = (event: SlackEvent, id = `e-${event.ts}`) => JSON.stringify({ envelope_id: id, type: "events_api", payload: { event } });

describe("Slice-11 INBOUND transport——真实 runInboundLoop / open / message / ack / 周期重试（B1 + 证明缺口）", () => {
  it("open 失败时报告 disconnected，而不是让 connector 看似仍在连接", async () => {
    const fsx = memFs();
    const receipts = new InboundReceiptStore("/s/inbound-receipts.jsonl", fsx, clock);
    const router = new InboundRouter({
      queue: { createQitem: async () => "unused" },
      seen: new SeenStore("/s/seen.jsonl", fsx, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fsx, clock),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
    });
    const handle = startSocketInbound("xapp-EXAMPLE-fake", router, {
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: "temporary outage" }), { status: 200 }),
      inboundMaxConnects: 1,
      receipts,
    });

    await handle.done;
    expect(handle.status()).toMatchObject({ generation: 1, reconnects: 0, state: "disconnected" });
    expect(handle.status().disconnectedAt).toBeDefined();
    expect(receipts.readAll()).toEqual(expect.arrayContaining([
      expect.objectContaining({ generation: 1, status: "connect-attempt" }),
      expect.objectContaining({ generation: 1, status: "connect-failed", reason: "connection-open-failed" }),
    ]));
  });

  it("ack 每个 envelope、落地人工消息，并在连接时及连接期间周期性重试 dead-letter", async () => {
    const order: string[] = [];
    const fsx = memFs((path, data) => {
      if (path.endsWith("inbound-receipts.jsonl") && data.includes('"status":"received"')) order.push("received");
    });
    const seen = new SeenStore("/s/seen.jsonl", fsx, clock);
    const dead = new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fsx, clock);
    const receipts = new InboundReceiptStore("/s/inbound-receipts.jsonl", fsx, clock);
    const queue = { createQitem: async () => "qitem-xyz" };
    const router = new InboundRouter({ queue, seen, deadLetter: dead, destination: "operator-agent@kernel", resolveSender: (u) => ({ admitted: true, source: `human-${u}@kernel` }), log: () => {} });

    // 预先播种一个将在 ON-CONNECT 重试时落地的 dead-letter。
    dead.append({ type: "message", user: "U0", text: "queued during outage", ts: "D1", channel: "C0" }, 1);

    const fake = makeFakeWs();
    const send = fake.ws.send;
    fake.ws.send = (data) => { order.push("ack"); send(data); };
    let resolveWsCreated: () => void;
    const wsCreated = new Promise<void>((r) => (resolveWsCreated = r));
    const deps: SocketInboundDeps = {
      fetchImpl: openFetch,
      wsFactory: () => {
        resolveWsCreated();
        return fake.ws;
      },
      inboundMaxConnects: 1, // 此连接关闭后停止。
      retryIntervalMs: 20, // 足够短，使周期重试能在测试内触发。
      receipts,
      log: () => {},
    };

    const handle = startSocketInbound("xapp-EXAMPLE-fake", router, deps);
    await wsCreated;

    // open 后执行 on-connect dead-letter 排空（D1 落地）并启动周期定时器。
    fake.ws.onopen!();
    await flush();
    expect(seen.load().has("D1")).toBe(true); // 连接时已恢复。
    expect(dead.readAll()).toHaveLength(0);

    // 人工消息：快速 ACK 并落地。
    fake.ws.onmessage!({ data: envelope({ type: "message", user: "U1", text: "hi team", ts: "M1", channel: "C0" }) });
    await flush();
    expect(fake.sent.some((s) => s.includes('"envelope_id":"e-M1"'))).toBe(true); // 已发送快速 ACK。
    expect(order.indexOf("ack")).toBeLessThan(order.indexOf("received")); // receipt 在筛选前记录，但 ACK 仍最先。
    expect(seen.load().has("M1")).toBe(true); // 已经由真实 ack 路径落地。

    // 丢失回复诊断通道：每个解析后的 inbound event 都在筛选前记录 receipt，随后获得一条不含凭据的
    // 最终 disposition。消息正文、发送者 id 和 token 绝不进入台账。
    const inboundReceipts = receipts.readAll();
    expect(inboundReceipts.filter((r) => r.status === "received" && r.eventTs === "M1")).toHaveLength(1);
    expect(inboundReceipts.filter((r) => r.status === "accepted" && r.eventTs === "M1")).toHaveLength(1);
    expect(JSON.stringify(inboundReceipts)).not.toContain("hi team");
    expect(JSON.stringify(inboundReceipts)).not.toContain("U1");
    expect(handle.status()).toMatchObject({ generation: 1, reconnects: 0, lastEventTs: "M1", lastDisposition: "accepted" });

    // bot 消息仍会收到 ACK，但不会被摄取（循环安全）。
    fake.ws.onmessage!({ data: envelope({ type: "message", bot_id: "B1", text: "loop", ts: "B1TS" }, "e-bot") });
    await flush();
    expect(fake.sent.some((s) => s.includes('"envelope_id":"e-bot"'))).toBe(true);
    expect(seen.load().has("B1TS")).toBe(false);
    expect(receipts.readAll().some((r) => r.status === "ignored" && r.eventTs === "B1TS" && r.reason === "bot_id")).toBe(true);

    // B1：连接期间出现新的 dead-letter，由周期定时器排空（无需 Slack 重连）。这正是 QA 指出的缺口。
    dead.append({ type: "message", user: "U2", text: "outage recovered", ts: "D2", channel: "C0" }, 1);
    await new Promise((r) => setTimeout(r, 70)); // 约 3 个 20ms 周期。
    expect(seen.load().has("D2")).toBe(true); // socket 保持打开时已重试。
    expect(dead.readAll()).toHaveLength(0);

    // close 后循环结束（达到 inboundMaxConnects）。
    fake.ws.onclose!();
    await handle.done;
  });
});
