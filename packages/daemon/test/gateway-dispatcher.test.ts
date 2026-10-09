import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayDispatcher } from "../src/domain/gateway/dispatcher.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import type { CapabilityDescriptor, OutboundDecision } from "../src/domain/gateway/protocol.js";

// M1 A4a——网关派发器核心（证明 9：拒绝未公布操作；连接器中断 -> 持久缓冲区 ->
// ACK 门禁排空，数据不丢失）。此处传输层为内存接收端。

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack", protocolVersion: 1, ops: ["post_message"],
};

describe("A4a GatewayDispatcher 网关派发器", () => {
  let home: string;
  let sent: OutboundDecision[];
  let seq: number;
  let buf: DispatchBuffer;
  let d: GatewayDispatcher;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "a4a-disp-"));
    sent = []; seq = 0;
    buf = new DispatchBuffer(home);
    d = new GatewayDispatcher({ buffer: buf, send: (dec) => sent.push(dec), newDecisionId: () => `d${++seq}` });
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("握手前拒绝派发（尚无描述符）", () => {
    const r = d.dispatch("post_message", "mike#slack-1", { text: "hi" });
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(buf.pending()).toHaveLength(0); // 拒绝时不持久写入任何内容
  });

  it("证明 9：拒绝未公布操作，且不尝试执行（不发送、不写缓冲区）", () => {
    d.onCapability(CAP);
    const r = d.dispatch("delete_workspace", "mike#slack-1", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/未声明操作|会被拒绝，不会尝试/);
    expect(sent).toHaveLength(0);
    expect(buf.pending()).toHaveLength(0);
  });

  it("已公布操作的派发：持久优先（缓冲），随后发送", () => {
    d.onCapability(CAP);
    const r = d.dispatch("post_message", "mike#slack-1", { text: "hi" });
    expect(r.ok).toBe(true);
    expect(buf.pending().map((x) => x.decisionId)).toEqual(["d1"]); // 已持久化
    expect(sent.map((x) => x.decisionId)).toEqual(["d1"]);          // 已发送
  });

  it("ACK 后排空；未确认项保留（连接器中断不丢失），并在重连时重放", () => {
    d.onCapability(CAP);
    d.dispatch("post_message", "a#slack-1", {}); // d1
    d.dispatch("post_message", "b#slack-1", {}); // d2
    d.onAck("d1");
    expect(buf.pending().map((x) => x.decisionId)).toEqual(["d2"]); // d2 未确认 -> 保留

    // 重连：在同一持久缓冲区上创建的新派发器重放 d2（不丢失）
    const sent2: OutboundDecision[] = [];
    const d2 = new GatewayDispatcher({ buffer: new DispatchBuffer(home), send: (x) => sent2.push(x) });
    d2.replayPending();
    expect(sent2.map((x) => x.decisionId)).toEqual(["d2"]); // 逐字节重发未确认决策
  });
});
