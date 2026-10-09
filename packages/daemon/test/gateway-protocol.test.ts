import { describe, it, expect } from "vitest";
import {
  decodeGatewayMessage,
  encodeGatewayMessage,
  isAdvertisedOp,
  GATEWAY_PROTOCOL_VERSION,
  type CapabilityDescriptor,
} from "../src/domain/gateway/protocol.js";

// M1 A4a——gateway<->connector framed-JSON 封闭 union。proof-9 基础：未知 kind 明确拒绝；
// 未声明的 op 被拒绝且不尝试。

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack",
  protocolVersion: GATEWAY_PROTOCOL_VERSION, ops: ["post_message", "upload_file"],
};

describe("A4a gateway wire protocol（封闭 union）", () => {
  it("解码 CapabilityDescriptor", () => {
    const r = decodeGatewayMessage(JSON.stringify(CAP));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.kind === "capability") expect(r.message.ops).toEqual(["post_message", "upload_file"]);
  });

  it("解码 OutboundDecision（通过 encode 往返）", () => {
    const dec = { kind: "outbound_decision", decisionId: "d1", op: "post_message", entityBindingRef: "mike#slack-1", payload: { text: "hi" } };
    const r = decodeGatewayMessage(encodeGatewayMessage(dec as never));
    expect(r.ok).toBe(true);
    if (r.ok && r.message.kind === "outbound_decision") expect(r.message.decisionId).toBe("d1");
  });

  it("解码两种 Ack 结构（ok + failed）", () => {
    expect(decodeGatewayMessage(JSON.stringify({ kind: "ack", decisionId: "d1", ok: true })).ok).toBe(true);
    const f = decodeGatewayMessage(JSON.stringify({ kind: "ack", decisionId: "d1", ok: false, failed: { class: "rate_limited", detail: "429" } }));
    expect(f.ok).toBe(true);
    if (f.ok && f.message.kind === "ack" && f.message.ok === false) expect(f.message.failed.class).toBe("rate_limited");
  });

  it("拒绝未知 message kind（proof-9：封闭 union）", () => {
    const r = decodeGatewayMessage(JSON.stringify({ kind: "exec_shell", decisionId: "x" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/未知 gateway message kind.*已拒绝/i);
  });

  it("拒绝不完整或格式错误的消息（不静默接受部分数据）", () => {
    expect(decodeGatewayMessage(JSON.stringify({ kind: "outbound_decision", decisionId: "d1" })).ok).toBe(false); // 无 op。
    expect(decodeGatewayMessage(JSON.stringify({ kind: "ack", decisionId: "d1", ok: false })).ok).toBe(false);    // 缺少 failed。
    expect(decodeGatewayMessage("not json{").ok).toBe(false);
    expect(decodeGatewayMessage(JSON.stringify({ kind: "capability", connectorId: "c", platform: "p", protocolVersion: 1, ops: "nope" })).ok).toBe(false);
  });

  it("isAdvertisedOp：已声明为 true，未声明为 false（proof-9 dispatch 守卫）", () => {
    expect(isAdvertisedOp(CAP, "post_message")).toBe(true);
    expect(isAdvertisedOp(CAP, "delete_workspace")).toBe(false); // 未声明时拒绝，绝不尝试。
  });
});
