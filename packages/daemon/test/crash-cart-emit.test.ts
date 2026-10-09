import { describe, it, expect, vi } from "vitest";
import { emitCrashCartState } from "../src/domain/crash-cart-emit.js";

// 故障诊断 C3——emitCrashCartState 是 `zrig crash-cart --json` payload 的唯一真源（约束 3：
// 一份 JSON = 三态 verdict + discovery）。它逐字组合 detector + C2 read（约束 2）。读取以
// fail-closed 拒绝时发出结构化 JSON（refusal note，不含 discovery），使 TUI 绝不会从拒绝中
// 渲染控制台。子步骤均通过注入提供，因此行为确定。

const deps = (over: Partial<Parameters<typeof emitCrashCartState>[0]> = {}) => ({
  resolveState: async () => "down" as const,
  assembleEvidence: async () => ({ pidState: "dead", probeResult: "refused", failedSignal: "connection refused" }),
  loadDiscovery: async () => ({ header: { lastActivityAt: null, lastBootAt: null, firstBootAt: null, hostId: null, stopReason: null, priorUptimeMs: null }, foundOnHost: [], whereWorkStopped: [] }),
  ...over,
});

describe("emitCrashCartState——verb 的 JSON verdict", () => {
  it("UP → 只返回 state（无 evidence、无 discovery、不尝试读取）", async () => {
    const loadDiscovery = vi.fn(deps().loadDiscovery);
    const out = await emitCrashCartState(deps({ resolveState: async () => "up", loadDiscovery }));
    expect(out).toEqual({ state: "up" });
    expect(loadDiscovery).not.toHaveBeenCalled();
  });

  it("UNVERIFIED → state + evidence，不含 discovery（不尝试读取）", async () => {
    const loadDiscovery = vi.fn(deps().loadDiscovery);
    const out = await emitCrashCartState(deps({ resolveState: async () => "unverified", loadDiscovery }));
    expect(out.state).toBe("unverified");
    expect(out.evidence).toEqual({ pidState: "dead", probeResult: "refused", failedSignal: "connection refused" });
    expect(out.discovery).toBeUndefined();
    expect(loadDiscovery).not.toHaveBeenCalled();
  });

  it("DOWN + 读取成功 → state + discovery", async () => {
    const out = await emitCrashCartState(deps({ resolveState: async () => "down" }));
    expect(out.state).toBe("down");
    expect(out.discovery).toBeTruthy();
    expect(out.refusal).toBeUndefined();
  });

  it("DOWN + 读取拒绝 → 结构化 refusal（含 note、无 discovery，TUI 不渲染控制台）", async () => {
    const out = await emitCrashCartState(
      deps({
        resolveState: async () => "down",
        loadDiscovery: async () => {
          throw new Error("a daemon answered /healthz — refusing the direct read");
        },
      }),
    );
    expect(out.state).toBe("down");
    expect(out.discovery).toBeUndefined();
    expect(out.refusal).toContain("refusing the direct read");
  });
});
