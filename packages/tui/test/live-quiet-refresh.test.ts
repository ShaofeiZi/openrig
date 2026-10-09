import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveRefresh, QUIET_REFRESH_MS } from "../src/live.js";
import { emptySnapshot } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("S17 有界安静刷新", () => {
  it("完成的 hydrate 30 秒后被动重新 hydration，绝不 5 秒连串", async () => {
    vi.useFakeTimers();
    const hydrate = vi.fn(async () => emptySnapshot());
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => 0 });

    await live.refresh();
    expect(hydrate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hydrate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS - 5_000);
    expect(hydrate).toHaveBeenCalledTimes(2);
    live.close();
  });

  it("仅在 hydrate 完成后武装恰好一个超时，并在关闭时清除", async () => {
    vi.useFakeTimers();
    const first = deferred<FleetSnapshot>();
    const hydrate = vi.fn(() => first.promise);
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => 0 });

    const refresh = live.refresh();
    expect(vi.getTimerCount()).toBe(0);

    first.resolve(emptySnapshot());
    await refresh;
    expect(vi.getTimerCount()).toBe(1);

    live.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hydrate in-flight 时绝不安排回退，完成后重新武装", async () => {
    vi.useFakeTimers();
    const second = deferred<FleetSnapshot>();
    let calls = 0;
    const hydrate = vi.fn(() => {
      calls += 1;
      return calls === 2 ? second.promise : Promise.resolve(emptySnapshot());
    });
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => 0 });

    await live.refresh();
    await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS * 2);
    expect(hydrate).toHaveBeenCalledTimes(2);

    second.resolve(emptySnapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS - 1);
    expect(hydrate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(hydrate).toHaveBeenCalledTimes(3);
    live.close();
  });

  it("事件/操作者刷新清除旧超时并赢得全新安静窗口", async () => {
    vi.useFakeTimers();
    const hydrate = vi.fn(async () => emptySnapshot());
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => 0 });

    await live.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    await live.refresh();
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(hydrate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hydrate).toHaveBeenCalledTimes(3);
    live.close();
  });

  it("仅一个收到提前刷新时保持两个打开 client 独立", async () => {
    vi.useFakeTimers();
    const hydrateA = vi.fn(async () => emptySnapshot());
    const hydrateB = vi.fn(async () => emptySnapshot());
    const liveA = createLiveRefresh({ hydrate: hydrateA, onFrame: () => {}, now: () => 0 });
    const liveB = createLiveRefresh({ hydrate: hydrateB, onFrame: () => {}, now: () => 0 });

    await Promise.all([liveA.refresh(), liveB.refresh()]);
    await vi.advanceTimersByTimeAsync(15_000);
    await liveA.refresh();
    expect(hydrateA).toHaveBeenCalledTimes(2);
    expect(hydrateB).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(hydrateA).toHaveBeenCalledTimes(2);
    expect(hydrateB).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(hydrateA).toHaveBeenCalledTimes(3);
    expect(hydrateB).toHaveBeenCalledTimes(2);
    liveA.close();
    liveB.close();
  });

  it("unref 生产超时句柄，并在关闭时取消该确切句柄", async () => {
    const unref = vi.fn();
    const handle = { unref };
    const setTimeout = vi.fn(() => handle);
    const clearTimeout = vi.fn();
    const live = createLiveRefresh({
      hydrate: async () => emptySnapshot(),
      onFrame: () => {},
      now: () => 0,
      setTimeout,
      clearTimeout,
    });

    await live.refresh();
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), QUIET_REFRESH_MS);
    expect(unref).toHaveBeenCalledOnce();

    live.close();
    expect(clearTimeout).toHaveBeenCalledWith(handle);
  });

  it("把 refresh-owner 清理接入 TUI 关闭路径", () => {
    const main = readFileSync(join(repoRoot, "packages", "tui", "src", "main.ts"), "utf8");
    const shutdown = main.slice(main.indexOf("async function shutdown"), main.indexOf("process.on(\"SIGINT\""));
    expect(shutdown).toContain("live?.close()");
  });
});


describe("proof 基准新鲜度", () => {
  it("在既有 30 秒窗口内修复错过的变更，不把安静时间当陈旧", async () => {
    vi.useFakeTimers();
    let revision = "before";
    const live = createLiveRefresh({ hydrate: async () => ({ ...emptySnapshot(), instanceId: revision }), onFrame() {}, now: () => Date.now() });
    await live.refresh(); revision = "committed";
    await vi.advanceTimersByTimeAsync(5_000);
    expect(live.load().stale).toBe(false); expect(live.snapshot().instanceId).toBe("before");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(live.snapshot().instanceId).toBe("committed"); expect(live.load().stale).toBe(false);
    live.close();
  });
  it("标记已知失效与逾期对账，随后对账一个尾随变更", async () => {
    vi.useFakeTimers();
    const delayed = deferred<FleetSnapshot>(); let calls = 0;
    const live = createLiveRefresh({ hydrate: () => ++calls === 2 ? delayed.promise : Promise.resolve({ ...emptySnapshot(), instanceId: String(calls) }), onFrame() {}, now: () => Date.now() });
    await live.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(live.load().stale).toBe(false); // quiet reconciliation in flight, within its bound
    await vi.advanceTimersByTimeAsync(30_001);
    expect(live.load().stale).toBe(true);
    const invalidation = live.invalidate(); expect(live.load().stale).toBe(true);
    delayed.resolve({ ...emptySnapshot(), instanceId: "stale response" }); await invalidation;
    expect(live.snapshot().instanceId).toBe("3"); expect(live.load().stale).toBe(false);
    live.connectionStatus("dropped"); expect(live.load()).toMatchObject({ connection: "dropped", stale: true });
    live.close();
  });
});
