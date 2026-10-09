import { describe, it, expect } from "vitest";
import { crashCartRenderOpts, probeCrashCart, type CrashCartEmit } from "../src/crash-cart/from-emit.js";

// Crash-cart C3 unit-C——把 `rig crash-cart --json` 裁决映射到 renderScreen daemon-down 选项。
// DOWN+discovery → cockpit；UNVERIFIED+证据 → cannot-verify 屏；UP → 常规 TUI。轨 3：
// DOWN+refusal（因 daemon 应答而读 fail-closed）绝不渲染 cockpit → 常规 TUI。

describe("crashCartRenderOpts——verdict → render opts", () => {
  it("DOWN + discovery → daemonState down + 构建好的 cockpit model", () => {
    const emit: CrashCartEmit = {
      state: "down",
      discovery: {
        header: { lastActivityAt: "2026-08-06T08:12:00Z" },
        foundOnHost: [{ rigName: "alpha", seatCount: 2, resumableCount: 2, lastActiveAt: "2026-08-06T08:00:00Z" }],
        whereWorkStopped: [],
      },
    };
    const o = crashCartRenderOpts(emit);
    expect(o.daemonState).toBe("down");
    expect(o.crashCart?.foundOnHost[0]?.name).toBe("alpha");
    expect(o.crashCart?.header.lastSeen).toBe("08:12");
  });

  it("UNVERIFIED + evidence → daemonState unverified + 证据", () => {
    const o = crashCartRenderOpts({ state: "unverified", evidence: { pidState: "alive", probeResult: "timeout", failedSignal: "x" } });
    expect(o.daemonState).toBe("unverified");
    expect(o.daemonEvidence?.probeResult).toBe("timeout");
    expect(o.crashCart).toBeUndefined();
  });

  it("UP → 常规 TUI（无 daemon-down opts）", () => {
    expect(crashCartRenderOpts({ state: "up" })).toEqual({});
  });

  it("DOWN + 拒绝仍可见，且不授权 daemon-down 恢复", () => {
    const o = crashCartRenderOpts({ state: "down", refusal: "a daemon answered /healthz — refusing the direct read" });
    expect(o.unavailable).toContain("a daemon answered");
    expect(o.daemonState).toBeUndefined();
  });
});

describe("probeCrashCart——运行 verb + map；失败绝不伪造 cockpit", () => {
  it("把有效 verb JSON 映射到 opts", async () => {
    const o = await probeCrashCart(async () => JSON.stringify({ state: "unverified", evidence: { pidState: "p", probeResult: "timeout", failedSignal: "s" } }));
    expect(o.daemonState).toBe("unverified");
  });
  it("verb 错误保留具名的不可用前提", async () => {
    expect((await probeCrashCart(async () => { throw new Error("spawn failed"); })).unavailable).toContain("spawn failed");
  });
  it("不可解析输出绝不变成空实例", async () => {
    const result = await probeCrashCart(async () => "not json");
    expect(result.unavailable).toBeTruthy();
    expect(result.crashCart).toBeUndefined();
  });
  it("保留 public CLI 的 native-load 失败详情", async () => {
    const result = await probeCrashCart(async () => JSON.stringify({ error: { message: "ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch" } }));
    expect(result.unavailable).toContain("ERR_DLOPEN_FAILED");
    expect(result.daemonState).toBeUndefined();
  });
});
