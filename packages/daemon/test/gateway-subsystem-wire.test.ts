import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildInProcessWire, GatewaySubsystem, type SubsystemDeliveryOutcome } from "../src/domain/gateway/gateway-subsystem.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";

// S10——进程内 wire 必须原样承载已发布的持久性契约（slice-11 / M1 语义，重新归位）：
// 在投递前持久化，仅在 delivered-ok 时清除，失败时保留，在下次激活时重放；同时保持 proof-9
//（拒绝未通告的 op，绝不尝试投递）不变。这些测试用于证明重新归位没有削弱契约。

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("S10 进程内 gateway wire——持久性契约凭据", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s10-wire-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("在 delivery 完成前持久化 decision（durable-first）", async () => {
    let release: (o: SubsystemDeliveryOutcome) => void = () => {};
    const gate = new Promise<SubsystemDeliveryOutcome>((r) => { release = r; });
    const wire = buildInProcessWire({ home, ops: ["post_message"], deliver: () => gate });
    const res = wire.dispatcher.dispatch("post_message", "mike#slack", { t: 1 });
    expect(res.ok).toBe(true);
    // Delivery 尚未完成——decision 此时必须已持久化到磁盘。
    const pending = new DispatchBuffer(home).pending();
    expect(pending.map((d) => d.decisionId)).toContain((res as { decisionId: string }).decisionId);
    release({ ok: true });
    await tick();
  });

  it("仅在 delivered-ok（进程内 ack）时清除", async () => {
    const wire = buildInProcessWire({ home, ops: ["post_message"], deliver: async () => ({ ok: true }) });
    const res = wire.dispatcher.dispatch("post_message", "mike#slack", { t: 2 });
    expect(res.ok).toBe(true);
    await tick();
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  it("保留失败的 delivery（绝不丢弃）并指明失败原因", async () => {
    const logs: string[] = [];
    const wire = buildInProcessWire({
      home, ops: ["post_message"],
      deliver: async () => ({ ok: false, class: "http-500", detail: "slack burped" }),
      log: (m) => logs.push(m),
    });
    const res = wire.dispatcher.dispatch("post_message", "mike#slack", { t: 3 });
    expect(res.ok).toBe(true);
    await tick();
    expect(new DispatchBuffer(home).pending()).toHaveLength(1); // 已保留
    expect(logs.join("\n")).toContain("http-500"); // 失败可见，且指明原因
  });

  it("deliver 抛出异常属于失败类别而非崩溃——保留 decision", async () => {
    const wire = buildInProcessWire({
      home, ops: ["post_message"],
      deliver: async () => { throw new Error("transport exploded"); },
    });
    wire.dispatcher.dispatch("post_message", "mike#slack", { t: 4 });
    await tick();
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
  });

  it("下次激活时通过 delivery 重放未 Ack 的 decision（重启不丢失）", async () => {
    // 第 1 次运行：delivery 不可用——保留 decision。
    const w1 = buildInProcessWire({ home, ops: ["post_message"], deliver: async () => ({ ok: false, class: "transport" }) });
    const r1 = w1.dispatcher.dispatch("post_message", "mike#slack", { t: 5 });
    await tick();
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    // 第 2 次运行（同一 home = 同一持久 buffer）：delivery 恢复——在激活流程的 post-bind 阶段，
    // 由 startServices() 触发重放（网络操作）。
    const redelivered: OutboundDecision[] = [];
    const w2 = buildInProcessWire({
      home, ops: ["post_message"],
      deliver: async (d) => { redelivered.push(d); return { ok: true }; },
    });
    w2.startServices?.();
    await tick();
    expect(redelivered.map((d) => d.decisionId)).toContain((r1 as { decisionId: string }).decisionId);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0);
  });

  it("进程内仍满足 proof-9：拒绝未通告的 op，且绝不投递", async () => {
    const delivered: OutboundDecision[] = [];
    const wire = buildInProcessWire({ home, ops: ["post_message"], deliver: async (d) => { delivered.push(d); return { ok: true }; } });
    const res = wire.dispatcher.dispatch("upload_file", "mike#slack", {});
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("未声明操作");
    await tick();
    expect(delivered).toHaveLength(0);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0); // 在 durable-enqueue 前已拒绝
  });

  it("subsystem 失败时 dispatch() 如实拒绝，restart() 可恢复", async () => {
    let attempts = 0;
    const subsystem = new GatewaySubsystem({
      home,
      wire: () => {
        attempts++;
        if (attempts === 1) throw new Error("first wiring dies");
        return buildInProcessWire({ home, ops: ["post_message"], deliver: async () => ({ ok: true }) });
      },
    });
    subsystem.start();
    expect(subsystem.status().state).toBe("failed");
    const refused = subsystem.dispatch("post_message", "mike#slack", {});
    expect(refused.ok).toBe(false);
    expect((refused as { error: string }).error).toContain("failed");
    subsystem.restart(); // recovers-or-reports 的恢复阶段
    expect(subsystem.status().state).toBe("active");
    expect(subsystem.dispatch("post_message", "mike#slack", {}).ok).toBe(true);
  });
});
