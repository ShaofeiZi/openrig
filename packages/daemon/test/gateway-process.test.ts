import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGatewayProcess, type GatewayProcessHandle } from "../src/domain/gateway/gateway-process.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { encodeGatewayMessage, decodeGatewayMessage, type CapabilityDescriptor, type OutboundDecision } from "../src/domain/gateway/protocol.js";

// M1 A4a——进程 BRAIN 的进程内测试（快速、细粒度）。这不能证明 liveness（派生进程静默退出会被
// vitest 自身事件循环掩盖，该性质由 gateway-spawn-e2e.test.ts 证明）。此处证明 brain 正确组合
// buffer 与 transport：重新拨号时，通过进程层重放未 Ack 的 decision（无损恢复）。

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack", protocolVersion: 1, ops: ["post_message"],
};

interface Stub { server: Server; received: OutboundDecision[]; sockets: Socket[]; }
function startStub(path: string, ackAll: boolean): Promise<Stub> {
  const received: OutboundDecision[] = []; const sockets: Socket[] = [];
  try { if (existsSync(path)) unlinkSync(path); } catch { /* 保持初始状态。 */ }
  const server = createServer((sock) => {
    sockets.push(sock); sock.setEncoding("utf8"); sock.on("error", () => {});
    sock.write(encodeGatewayMessage(CAP));
    let acc = "";
    sock.on("data", (chunk: string) => {
      acc += chunk; let nl: number;
      while ((nl = acc.indexOf("\n")) >= 0) {
        const f = acc.slice(0, nl); acc = acc.slice(nl + 1); if (!f) continue;
        const d = decodeGatewayMessage(f);
        if (d.ok && d.message.kind === "outbound_decision") {
          received.push(d.message);
          if (ackAll) sock.write(encodeGatewayMessage({ kind: "ack", decisionId: d.message.decisionId, ok: true }));
        }
      }
    });
  });
  return new Promise((resolve, reject) => { server.on("error", reject); server.listen(path, () => resolve({ server, received, sockets })); });
}
const closeStub = (s: Stub): Promise<void> => new Promise((res) => { for (const sk of s.sockets) { try { sk.destroy(); } catch {} } s.server.close(() => res()); });
function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
        const iv = setInterval(() => { if (pred()) { clearInterval(iv); resolve(); } else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error("waitFor 超时")); } }, 15);
  });
}

describe("A4a runGatewayProcess（进程内 brain）", () => {
  let home: string;
  let handle: GatewayProcessHandle | undefined;
  afterEach(() => { handle?.stop(); handle = undefined; if (home) rmSync(home, { recursive: true, force: true }); });

  it("连接后公开存活 dispatcher，stop() 可完成拆除", async () => {
    home = mkdtempSync(join(tmpdir(), "a4a-proc-"));
    const sockPath = join(home, "g.sock");
    const stub = await startStub(sockPath, true);
    handle = runGatewayProcess({ socketPath: sockPath, home, reconnectMs: 100 });
    await waitFor(() => handle!.connected() && handle!.connection()?.dispatcher.connectorId === "slack-1");
    expect(handle.connected()).toBe(true);
    handle.stop();
    expect(handle.connected()).toBe(false);
    await closeStub(stub);
  });

  it("故障后重新拨号并重放未 Ack 的 decision（通过 brain 无损恢复）", async () => {
    home = mkdtempSync(join(tmpdir(), "a4a-proc-"));
    const sockPath = join(home, "g.sock");

    // 第 1 轮：connector 从不 ack；dispatch d1 后持久保留。
    const stub1 = await startStub(sockPath, false);
    handle = runGatewayProcess({ socketPath: sockPath, home, reconnectMs: 100 });
    await waitFor(() => handle!.connection()?.dispatcher.connectorId === "slack-1");
    const r = handle.connection()!.dispatcher.dispatch("post_message", "mike#slack-1", { text: "hi" });
    expect(r.ok).toBe(true);
    await waitFor(() => stub1.received.length === 1);
    expect(new DispatchBuffer(home).pending().map((x) => x.decisionId)).toEqual([r.ok ? r.decisionId : ""]);
    await closeStub(stub1); // 故障。

    // 第 2 轮：会 ack 的新 connector 在同一路径启动；brain 重新拨号，transport 在握手时重放
    // 未 Ack 的 d1，connector 再次接收、ack 并排空。
    const stub2 = await startStub(sockPath, true);
    await waitFor(() => stub2.received.length >= 1); // 重新拨号后已重放。
    await waitFor(() => new DispatchBuffer(home).pending().length === 0); // 已 ack 并排空：无丢失。
    await closeStub(stub2);
  });
});
