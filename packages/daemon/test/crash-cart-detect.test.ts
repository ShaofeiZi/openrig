import { describe, it, expect, vi } from "vitest";
import { classifyDaemonState, resolveDaemonState, type HealthzProbeResult } from "../src/domain/crash-cart-detect.js";

// 故障诊断 C3——后台服务状态分类器（规划者 + PM 裁定，诚实降级的防漏报护栏）。三种状态：
// UP（healthz 已响应）· DOWN（仅有确证：pid 已终止/不存在且 healthz 连接被拒）·
// UNVERIFIED（其他所有情况——超时、卡死、外来占用者）。驾驶舱 + C2 读取仅在 DOWN
// 时触发；探测抖动绝不能捏造崩溃叙事。此处只探测一次；有界重试由调用方负责。
// 所有探针均通过注入提供 → 测试完全隔离。

const deps = (over: Partial<Parameters<typeof classifyDaemonState>[0]> = {}) => ({
  openrigHome: "/scratch/.openrig",
  readDaemonJson: () => ({ pid: 9, port: 7433, host: "127.0.0.1" }),
  isProcessAlive: () => false,
  probeHealthz: async () => "refused" as const,
  openrigUrl: undefined as string | undefined,
  ...over,
});

describe("classifyDaemonState——三态诚实降级护栏", () => {
  it("healthz 响应时为 UP（即使记录的 pid 看起来已终止）", async () => {
    expect(await classifyDaemonState(deps({ probeHealthz: async () => "answered" }))).toBe("up");
  });

  it("仅在有确证时为 DOWN：pid 已终止且 healthz 被拒", async () => {
    expect(await classifyDaemonState(deps({ isProcessAlive: () => false, probeHealthz: async () => "refused" }))).toBe("down");
  });

  it("没有 daemon.json 且 healthz 被拒时为 DOWN", async () => {
    expect(await classifyDaemonState(deps({ readDaemonJson: () => undefined, probeHealthz: async () => "refused" }))).toBe("down");
  });

  it("pid 存活但 healthz 被拒时为 UNVERIFIED（进程存在但未服务——卡死或启动中）", async () => {
    expect(await classifyDaemonState(deps({ isProcessAlive: () => true, probeHealthz: async () => "refused" }))).toBe("unverified");
  });

  it("healthz 超时时为 UNVERIFIED（绝非 DOWN——抖动不能捏造崩溃）", async () => {
    expect(await classifyDaemonState(deps({ isProcessAlive: () => false, probeHealthz: async () => "timeout" }))).toBe("unverified");
  });

  it("非 OpenRig 进程响应该端口时为 UNVERIFIED", async () => {
    expect(await classifyDaemonState(deps({ probeHealthz: async () => "not-openrig" }))).toBe("unverified");
  });

  it("设置 OPENRIG_URL 时探测该地址，否则依次使用 daemon.json host:port 和默认地址", async () => {
    const seen: string[] = [];
    const probe = async (url: string) => {
      seen.push(url);
      return "refused" as const;
    };
    await classifyDaemonState(deps({ openrigUrl: "http://foreign:8080", probeHealthz: probe }));
    await classifyDaemonState(deps({ readDaemonJson: () => ({ pid: 9, port: 9999, host: "10.0.0.5" }), probeHealthz: probe }));
    await classifyDaemonState(deps({ readDaemonJson: () => undefined, probeHealthz: probe }));
    expect(seen).toEqual([
      "http://foreign:8080/healthz",
      "http://10.0.0.5:9999/healthz",
      "http://127.0.0.1:7433/healthz",
    ]);
  });
});

describe("resolveDaemonState——有界重试（注入时钟；超时绝不升级为 DOWN）", () => {
  function seq(results: HealthzProbeResult[]) {
    let i = 0;
    return async () => results[Math.min(i++, results.length - 1)]!;
  }
  const rdeps = (over: Partial<Parameters<typeof resolveDaemonState>[0]> = {}) => ({
    openrigHome: "/scratch/.openrig",
    readDaemonJson: () => ({ pid: 9, port: 7433, host: "127.0.0.1" }),
    isProcessAlive: () => false,
    probeHealthz: seq(["timeout"]),
    openrigUrl: undefined as string | undefined,
    sleep: vi.fn(async () => {}),
    maxProbes: 3,
    retryDelayMs: 400,
    ...over,
  });

  it("第一次探测有响应时解析为 UP，不重试", async () => {
    const sleep = vi.fn(async () => {});
    expect(await resolveDaemonState(rdeps({ probeHealthz: seq(["answered"]), sleep }))).toBe("up");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("连接被拒且 pid 已终止时立即解析为 DOWN（结论明确，不重试）", async () => {
    const sleep = vi.fn(async () => {});
    expect(await resolveDaemonState(rdeps({ probeHealthz: seq(["refused"]), sleep }))).toBe("down");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("遇到瞬时超时后重试并解析为 UP", async () => {
    const sleep = vi.fn(async () => {});
    expect(await resolveDaemonState(rdeps({ probeHealthz: seq(["timeout", "answered"]), sleep }))).toBe("up");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("持续超时 → 达到边界后为 UNVERIFIED（绝非 DOWN），休眠 maxProbes-1 次", async () => {
    const sleep = vi.fn(async () => {});
    expect(await resolveDaemonState(rdeps({ probeHealthz: seq(["timeout"]), sleep, maxProbes: 3 }))).toBe("unverified");
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
