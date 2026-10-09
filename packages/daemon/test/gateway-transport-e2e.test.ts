import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { connectGateway } from "../src/domain/gateway/transport.js";
import {
  encodeGatewayMessage,
  decodeGatewayMessage,
  type CapabilityDescriptor,
  type OutboundDecision,
} from "../src/domain/gateway/protocol.js";

// M1 A4a——通过真实 Unix socket（而非内存 sink）完成 proof-9：gateway 向外连接 stub
// connector，交换以换行分帧的 JSON，并证明：
//   1. 拒绝未公布的操作，绝不写入线路（proof-9：拒绝而非尝试）。
//   2. 已公布的分派到达 connector；其 ack 排空持久缓冲区。
//   3. connector 中断 → 持久缓冲区保留 → 重连后重放未确认的决策（字节完全一致）
//      → ack → 排空：不丢失。
//
// sun_path 约有 104 字节上限：socket 位于 os.tmpdir 下的短 mkdtemp 路径，绝不使用
// 深层临时路径。

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack", protocolVersion: 1, ops: ["post_message"],
};

interface Stub { server: Server; received: OutboundDecision[]; sockets: Socket[]; }

/** 最小 connector：连接时发送 CapabilityDescriptor，记录入站 outbound_decisions，并可选地
 *  确认每一项。先取消链接过期 socket 文件，使重连同一路径（真实场景）不会触发 EADDRINUSE。 */
function startStub(path: string, opts: { ackAll: boolean; sendCap?: boolean; failClass?: string }): Promise<Stub> {
  const received: OutboundDecision[] = [];
  const sockets: Socket[] = [];
  try { if (existsSync(path)) unlinkSync(path); } catch { /* 新路径 */ }
  const server = createServer((sock) => {
    sockets.push(sock);
    sock.setEncoding("utf8");
    sock.on("error", () => { /* 客户端拆除竞态——忽略。 */ });
    if (opts.sendCap !== false) sock.write(encodeGatewayMessage(CAP));
    let acc = "";
    sock.on("data", (chunk: string) => {
      acc += chunk as string;
      let nl: number;
      while ((nl = acc.indexOf("\n")) >= 0) {
        const frame = acc.slice(0, nl); acc = acc.slice(nl + 1);
        if (frame.length === 0) continue;
        const d = decodeGatewayMessage(frame);
        if (d.ok && d.message.kind === "outbound_decision") {
          received.push(d.message);
          const id = d.message.decisionId;
          if (opts.failClass !== undefined) {
            sock.write(encodeGatewayMessage({ kind: "ack", decisionId: id, ok: false, failed: { class: opts.failClass } }));
          } else if (opts.ackAll) {
            sock.write(encodeGatewayMessage({ kind: "ack", decisionId: id, ok: true }));
          }
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(path, () => resolve({ server, received, sockets }));
  });
}

// server.close() 仅在全部存活连接结束后才触发回调，因此先销毁服务端 socket
//（否则仍打开的客户端会让关闭操作永久卡住）。
const closeStub = (s: Stub): Promise<void> => new Promise((res) => {
  for (const sk of s.sockets) { try { sk.destroy(); } catch { /* 尽力而为。 */ } }
  s.server.close(() => res());
});
function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error("waitFor timeout")); }
    }, 10);
  });
}

describe("A4a gateway 传输端到端测试（真实 Unix socket）", () => {
  let home: string;
  let sockPath: string;
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanup.splice(0)) { try { c(); } catch { /* 尽力而为。 */ } }
    if (home) rmSync(home, { recursive: true, force: true });
  });
  const setup = () => {
    home = mkdtempSync(join(tmpdir(), "a4a-e2e-"));
    sockPath = join(home, "g.sock"); // 短路径：<tmpdir>/a4a-e2eXXXXXX/g.sock
    expect(sockPath.length).toBeLessThan(104); // sun_path 防护。
  };

  it("线路上的 proof-9：拒绝未公布的操作，且绝不写入 connector", async () => {
    setup();
    const stub = await startStub(sockPath, { ackAll: true });
    const buf = new DispatchBuffer(home);
    const conn = connectGateway({ socketPath: sockPath, buffer: buf });
    cleanup.push(() => conn.close());
    await waitFor(() => conn.dispatcher.connectorId === "slack-1"); // 握手完成。

    const r = conn.dispatcher.dispatch("delete_workspace", "mike#slack-1", {});
    expect(r.ok).toBe(false);
    await new Promise((res) => setTimeout(res, 60)); // 让任何错误的线路写入有机会到达。
    expect(stub.received).toHaveLength(0); // 从未在线路上尝试。
    expect(buf.pending()).toHaveLength(0); // 拒绝时不进行持久写入。
    conn.close();
    await closeStub(stub);
  });

  it("已公布的分派完成往返：到达 connector，ack 排空持久缓冲区", async () => {
    setup();
    const stub = await startStub(sockPath, { ackAll: true });
    const buf = new DispatchBuffer(home);
    const conn = connectGateway({ socketPath: sockPath, buffer: buf, newDecisionId: () => "d1" });
    cleanup.push(() => conn.close());
    await waitFor(() => conn.dispatcher.connectorId === "slack-1");

    const r = conn.dispatcher.dispatch("post_message", "mike#slack-1", { text: "hi" });
    expect(r.ok).toBe(true);
    await waitFor(() => stub.received.length === 1);
    expect(stub.received[0].decisionId).toBe("d1");
    expect(stub.received[0].op).toBe("post_message");
    await waitFor(() => buf.pending().length === 0); // ack 已将其排空。
    conn.close();
    await closeStub(stub);
  });

  it("connector 中断 → 持久缓冲区 → 重连后重放未确认决策（无丢失）", async () => {
    setup();
    // 第 1 轮：connector 收到决策，但 ack 路径已中断（从不确认）。
    const stub1 = await startStub(sockPath, { ackAll: false });
    const buf = new DispatchBuffer(home);
    const conn1 = connectGateway({ socketPath: sockPath, buffer: buf, newDecisionId: () => "d1" });
    await waitFor(() => conn1.dispatcher.connectorId === "slack-1");
    conn1.dispatcher.dispatch("post_message", "mike#slack-1", { text: "hi" });
    await waitFor(() => stub1.received.length === 1);
    expect(buf.pending().map((x) => x.decisionId)).toEqual(["d1"]); // 未确认 → 保留。
    conn1.close();
    await closeStub(stub1);

    // 第 2 轮：在同一持久缓冲区与路径上重连全新 gateway，并连接会确认的 stub。握手时
    // 传输层重放待处理项 → connector 再次收到 d1（字节完全一致）→ 确认 → 排空。
    // 中断期间没有丢失。
    const stub2 = await startStub(sockPath, { ackAll: true });
    const conn2 = connectGateway({ socketPath: sockPath, buffer: new DispatchBuffer(home) });
    cleanup.push(() => conn2.close());
    await waitFor(() => stub2.received.some((x) => x.decisionId === "d1")); // 重连时重放。
    await waitFor(() => buf.pending().length === 0); // 已确认并排空。
    conn2.close();
    await closeStub(stub2);
  });

  it("交付失败（ok:false ack）不会排空该行——保留并重放（无丢失）", async () => {
    setup();
    // 第 1 轮：connector 收到决策但交付失败——它以 ok:false 确认且不记录该决策
    //（契约规定 gateway 保留并重放）。gateway 收到 ok:false ack 时绝不能排空缓冲区
    //（在此排空等同于静默丢弃通知：不变量 2）。
    let failErr = "";
    const stub1 = await startStub(sockPath, { ackAll: true, failClass: "http-500" });
    const buf = new DispatchBuffer(home);
    const conn1 = connectGateway({
      socketPath: sockPath, buffer: buf, newDecisionId: () => "d1",
      onError: (e) => { failErr = e.message; },
    });
    cleanup.push(() => conn1.close());
    await waitFor(() => conn1.dispatcher.connectorId === "slack-1");
    conn1.dispatcher.dispatch("post_message", "mike#slack-1", { text: "hi" });
    await waitFor(() => stub1.received.length === 1);
    // ok:false ack 已处理；该行必须保留（这会让无条件在任何 ack 上排空的 onAck 失败）。
    await new Promise((res) => setTimeout(res, 80));
    expect(buf.pending().map((x) => x.decisionId)).toEqual(["d1"]); // 保留，未丢弃。
    expect(failErr).toMatch(/http-500|delivery fail/i);            // 为可观测性公开。
    conn1.close();
    await closeStub(stub1);

    // 第 2 轮：connector 恢复（以 ok:true 确认）。重连后重放保留的 d1 → 交付 → 排空。
    // 端到端保证失败的交付绝不丢失。
    const stub2 = await startStub(sockPath, { ackAll: true });
    const conn2 = connectGateway({ socketPath: sockPath, buffer: new DispatchBuffer(home) });
    cleanup.push(() => conn2.close());
    await waitFor(() => stub2.received.some((x) => x.decisionId === "d1")); // 失败后重放。
    await waitFor(() => buf.pending().length === 0); // 最终交付并排空。
    conn2.close();
    await closeStub(stub2);
  });
});
