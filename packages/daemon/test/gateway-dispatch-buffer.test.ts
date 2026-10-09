import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DispatchBuffer, dispatchBufferPath } from "../src/domain/gateway/dispatch-buffer.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";

// M1 A4a——durable dispatch buffer（proof-9 无丢失/ack-gated-drain 机制）。

const dec = (id: string): OutboundDecision => ({
  kind: "outbound_decision", decisionId: id, op: "post_message", entityBindingRef: "mike#slack-1", payload: { text: id },
});

describe("A4a DispatchBuffer（durable、ack-gated drain）", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "a4a-buf-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("enqueue 持久化 decision（durable-first），pending() 可跨新 instance 读回（重启后存留）", () => {
    new DispatchBuffer(home).enqueue(dec("d1"));
    expect(existsSync(dispatchBufferPath(home))).toBe(true);
    // 全新 instance（模拟重启）可以看到 pending decision
    expect(new DispatchBuffer(home).pending().map((d) => d.decisionId)).toEqual(["d1"]);
  });

  it("ack 排空一个 decision（且仅此一个）；无 ack -> 保留（connector 中断时不丢失）", () => {
    const b = new DispatchBuffer(home);
    b.enqueue(dec("d1")); b.enqueue(dec("d2"));
    b.ack("d1");
    expect(b.pending().map((d) => d.decisionId)).toEqual(["d2"]); // d2 未 ack -> 保留
  });

  it("enqueue 对 decisionId 幂等（重新分派只保留一条记录——逐字节相同的副本不会重复）", () => {
    const b = new DispatchBuffer(home);
    b.enqueue(dec("d1")); b.enqueue(dec("d1"));
    expect(b.pending()).toHaveLength(1);
  });

  it("对未知 decisionId 执行 ack 是 no-op（幂等排空）", () => {
    const b = new DispatchBuffer(home);
    b.enqueue(dec("d1"));
    b.ack("nope");
    expect(b.pending().map((d) => d.decisionId)).toEqual(["d1"]);
  });

  it("A5b：带 media 的 decision 会逐字节一致地保留并 replay（media 与 text 一样不会丢失）", () => {
    // buffer 与 payload 无关：decision 上的 image attachment 与 text 一样保留并 replay
    //（proof-4 的 screenshot 不得因 delivery 失败而丢失）。
    const media: OutboundDecision = {
      kind: "outbound_decision", decisionId: "m1", op: "post_message", entityBindingRef: "mike#slack-1",
      payload: { qitemId: "q9", summary: "chart", body: "see attached", media: [{ imageUrl: "https://ok.example.com/shot.png", altText: "the screenshot" }] },
    };
    new DispatchBuffer(home).enqueue(media);
    // 重启后仍可读取：media payload 逐字节一致地返回（保留用于 replay）。
    const pending = new DispatchBuffer(home).pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(media); // 完整 payload（包括 media）——无丢弃或特殊处理
  });
});
