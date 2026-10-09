import { describe, it, expect } from "vitest";
import { resolveBindPlan } from "../src/domain/bind-plan.js";

// OPR.0.5.5.20——bind intent 具有无歧义 provenance。事件形态（operator baton
// qitem-20260827070400）：managed environment 中的维护命令携带 OPENRIG_HOST=127.0.0.1；
// daemon 采用 single-bind，并静默丢弃 Tailscale。

describe("S20——resolveBindPlan：routing env 绝不代表 bind intent", () => {
  it("事件形态：注入 routing env + 无专用 intent → 默认 multi-bind、两个 listener，忽略行为可见", () => {
    const plan = resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: "127.0.0.1", tailscaleIp: "100.95.124.60" });
    expect(plan.mode).toBe("default");
    expect(plan.hosts).toEqual(["127.0.0.1", "100.95.124.60"]); // Tailscale listener 保留
    expect(plan.tailscaleDetected).toBe(true);
    expect(plan.ignoredRoutingHost).toBe("127.0.0.1"); // 绝不静默——provenance line 的 input
  });

  it("专用 intent 进入显式 single-bind 分支（用户 channel，managed env 无法逐字节注入）", () => {
    const plan = resolveBindPlan({ bindHostEnv: "100.95.124.51", routingHostEnv: "127.0.0.1", tailscaleIp: "100.95.124.51" });
    expect(plan.mode).toBe("explicit");
    expect(plan.hosts).toEqual(["100.95.124.51"]);
    expect(plan.ignoredRoutingHost).toBeUndefined(); // intent 已声明——没有忽略项
  });

  it("完全没有 env：无 tailscale 时默认仅 loopback；存在时使用 loopback+tailscale", () => {
    expect(resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: undefined, tailscaleIp: null }))
      .toEqual({ mode: "default", hosts: ["127.0.0.1"], tailscaleDetected: false });
    expect(resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: undefined, tailscaleIp: "100.64.0.9" }).hosts)
      .toEqual(["127.0.0.1", "100.64.0.9"]);
  });

  it("仅含空白的专用 env 视为缺失（绝不因空字符串意外进入 single-bind）", () => {
    const plan = resolveBindPlan({ bindHostEnv: "   ", routingHostEnv: undefined, tailscaleIp: "100.64.0.9" });
    expect(plan.mode).toBe("default");
    expect(plan.hosts).toEqual(["127.0.0.1", "100.64.0.9"]);
  });
});
