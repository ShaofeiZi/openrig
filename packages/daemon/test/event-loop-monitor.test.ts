import { describe, it, expect } from "vitest";
import {
  EventLoopMonitor,
  evaluateEventLoopHealthy,
  EVENT_LOOP_LAG_UNHEALTHY_MS,
  LAST_TICK_STALE_MS,
} from "../src/domain/event-loop-monitor.js";

// OPR.0.4.3.21——在此证明具名阈值（无魔法数字）：在精确边界上验证纯判定，
// 并通过注入的时钟确定性证明最后一次 tick 的停滞信号。

describe("evaluateEventLoopHealthy——在边界证明具名阈值", () => {
  it("延迟和最后一次 tick 均严格低于阈值时健康", () => {
    expect(
      evaluateEventLoopHealthy({
        lagMeanMs: EVENT_LOOP_LAG_UNHEALTHY_MS - 1,
        lastTickAgeMs: LAST_TICK_STALE_MS - 1,
      }),
    ).toBe(true);
  });

  it("恰好达到延迟阈值时不健康", () => {
    expect(
      evaluateEventLoopHealthy({ lagMeanMs: EVENT_LOOP_LAG_UNHEALTHY_MS, lastTickAgeMs: 0 }),
    ).toBe(false);
  });

  it("恰好达到最后一次 tick 过期阈值时不健康", () => {
    expect(
      evaluateEventLoopHealthy({ lagMeanMs: 0, lastTickAgeMs: LAST_TICK_STALE_MS }),
    ).toBe(false);
  });
});

describe("EventLoopMonitor——事件循环未 tick 时，最后一次 tick 的时间差持续增长", () => {
  it("报告不断增长的最后 tick 时间差，并在超过过期阈值后切换为 healthy=false", () => {
    let clock = 1_000;
    const monitor = new EventLoopMonitor({ now: () => clock, autoStart: false });
    monitor.recordTick(); // 在 clock=1000 时记录 tick。

    // 刚好低于过期阈值：仍然健康。
    clock = 1_000 + LAST_TICK_STALE_MS - 1;
    let snap = monitor.snapshot();
    expect(snap.lastTickAgeMs).toBe(LAST_TICK_STALE_MS - 1);
    expect(snap.healthy).toBe(true);

    // 事件循环停滞：定时器无法触发，因此没有 recordTick——时间差达到过期阈值，
    // 判定随之翻转。
    clock = 1_000 + LAST_TICK_STALE_MS;
    snap = monitor.snapshot();
    expect(snap.lastTickAgeMs).toBe(LAST_TICK_STALE_MS);
    expect(snap.healthy).toBe(false);

    monitor.stop();
  });

  it("即使直方图尚未预热，快照仍为有限且非负的结构", () => {
    const monitor = new EventLoopMonitor({ autoStart: false });
    const snap = monitor.snapshot();
    expect(Number.isFinite(snap.lagMeanMs)).toBe(true);
    expect(Number.isFinite(snap.lagP99Ms)).toBe(true);
    expect(snap.lastTickAgeMs).toBeGreaterThanOrEqual(0);
    expect(typeof snap.healthy).toBe("boolean");
    monitor.stop();
  });
});

describe("EventLoopMonitor——真实直方图捕获模拟阻塞", () => {
  it("同步阻塞后记录可测量的事件循环延迟", async () => {
    const monitor = new EventLoopMonitor();
    // 同步阻塞事件循环，使直方图的内部定时器延迟触发。
    const until = Date.now() + 200;
    while (Date.now() < until) { /* busy-wait */ }
    // 让延迟的定时器样本进入直方图。
    await new Promise((r) => setTimeout(r, 30));
    const snap = monitor.snapshot();
    // 宽松断言（实际计时并非确定性）——证明捕获功能有效。
    expect(snap.lagP99Ms).toBeGreaterThan(0);
    monitor.stop();
  });
});
