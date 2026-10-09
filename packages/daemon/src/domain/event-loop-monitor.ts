import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "node:perf_hooks";

/**
 * OPR.0.4.3.21——后台服务事件循环健康状态监测。
 *
 * 后台服务可能仍存活并监听（PID 存在、端口已绑定），但事件循环已经卡死或饥饿
 * （CPU 接近 100%），因此无法处理请求。`/healthz` 运行在同一事件循环上，也会随之沉默。
 * 此监控器以低成本检测卡死：持续启用 libuv timer 延迟直方图（monitorEventLoopDelay），
 * 并用一个已 unref 的轻量 interval 刷新 `lastTickAt`。事件循环饥饿时 interval 不再触发，
 * `lastTickAgeMs` 会持续增长，从而形成确定性的停滞信号。
 *
 * 优先复用：全部监测均使用 Node 自带的 `perf_hooks`，不引入新的外部原语；
 * 通过既有 `/healthz` 界面公开。
 */

// ---------------------------------------------------------------------------
// 具名阈值（已有测试证明，见 event-loop-monitor.test.ts 与后端压力证明）。不使用魔法数字：
// 下方每个常量都以后台服务既有且已验证的 250 ms healthz probe 上限为基准
//（packages/cli/src/daemon-lifecycle.ts 中的 HEALTHZ_PROBE_TIMEOUT_MS），确保事件循环判定与
// CLI healthz 超时对“饥饿”的定义一致，而不是另造一套数值。
// ---------------------------------------------------------------------------

/**
 * 直方图采样分辨率（毫秒）。采用 monitorEventLoopDelay 的 Node 默认值；在 libuv timer
 * 开销可忽略的前提下，足以捕获亚秒级停滞。
 */
export const EVENT_LOOP_DELAY_RESOLUTION_MS = 10;

/**
 * `lastTickAt` 的刷新间隔（毫秒）。4 Hz 开销很低；卡死的事件循环会停止触发该 interval，
 * 因而 `lastTickAgeMs` 成为确定性的停滞信号，并在循环阻塞期间随真实墙钟时间增长。
 */
export const EVENT_LOOP_TICK_INTERVAL_MS = 250;

/**
 * 事件循环平均延迟阈值（毫秒）；达到或超过该值即视为饥饿。它以既有 250 ms healthz probe
 * 超时为基准：平均调度延迟达到 probe 超时时，healthz 已会开始失败，因此这是代码库既有且一致的边界。
 */
export const EVENT_LOOP_LAG_UNHEALTHY_MS = 250;

/**
 * `lastTickAgeMs` 的停滞阈值（毫秒）；达到或超过该值即视为已停滞。该值为 tick 间隔的 4 倍，
 * 即明确漏掉四次 tick，足以避开调度抖动；它也等于 healthz 重试窗口，因此如此长的停滞已经会被
 * 操作员观察为后台服务无响应。
 */
export const LAST_TICK_STALE_MS = 1000;

/**
 * 压力证明上限：存在路由负载时，`/healthz` 必须在此毫秒数内响应。仍采用 250 ms 基准；
 * 若 healthz 无法在 probe 超时前响应，CLI 已会报告后台服务无响应，因此压力证明也用同一响应契约
 * 约束热点路径。
 */
export const HEALTHZ_RESPONSIVENESS_BUDGET_MS = 250;

export interface EventLoopHealthInput {
  lagMeanMs: number;
  lastTickAgeMs: number;
}

/**
 * 根据两个阈值作出的纯健康判定。保持为纯函数并导出，使精确边界可通过单元测试证明，
 * 无需依赖本质上不确定的真实事件循环时序。
 */
export function evaluateEventLoopHealthy(input: EventLoopHealthInput): boolean {
  return input.lagMeanMs < EVENT_LOOP_LAG_UNHEALTHY_MS
    && input.lastTickAgeMs < LAST_TICK_STALE_MS;
}

export interface EventLoopSnapshot {
  /** 事件循环平均延迟（毫秒；直方图均值由 ns 转换为 ms）。 */
  lagMeanMs: number;
  /** 事件循环 p99 延迟（毫秒；由 ns 转换为 ms）。 */
  lagP99Ms: number;
  /** 监控器生命周期内的事件循环利用率（0..1）。 */
  utilization: number;
  /** 距离上次记录 tick 的墙钟毫秒数；事件循环停滞时会持续增长。 */
  lastTickAgeMs: number;
  /** {@link evaluateEventLoopHealthy} 给出的判定。 */
  healthy: boolean;
}

export interface EventLoopMonitorOptions {
  /** 可注入时钟，供确定性测试使用；默认为 Date.now。 */
  now?: () => number;
  /** 直方图分辨率（毫秒）；默认为 {@link EVENT_LOOP_DELAY_RESOLUTION_MS}。 */
  resolutionMs?: number;
  /** lastTick 刷新间隔（毫秒）；默认为 {@link EVENT_LOOP_TICK_INTERVAL_MS}。 */
  tickIntervalMs?: number;
  /**
   * 是否立即启动直方图和 tick interval，默认为 true。测试传入 false 后，可通过 `recordTick()`
   * 与注入时钟进行确定性驱动。
   */
  autoStart?: boolean;
}

const NS_PER_MS = 1_000_000;

export class EventLoopMonitor {
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>;
  private readonly now: () => number;
  private readonly tickIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt: number;
  private eluBaseline: EventLoopUtilization;
  private started = false;

  constructor(opts: EventLoopMonitorOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.tickIntervalMs = opts.tickIntervalMs ?? EVENT_LOOP_TICK_INTERVAL_MS;
    this.histogram = monitorEventLoopDelay({
      resolution: opts.resolutionMs ?? EVENT_LOOP_DELAY_RESOLUTION_MS,
    });
    this.lastTickAt = this.now();
    this.eluBaseline = performance.eventLoopUtilization();
    if (opts.autoStart !== false) this.start();
  }

  /** 启用直方图并启动已 unref 的 tick interval，因此不会单独阻止进程退出。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.histogram.enable();
    this.eluBaseline = performance.eventLoopUtilization();
    this.lastTickAt = this.now();
    this.timer = setInterval(() => this.recordTick(), this.tickIntervalMs);
    // 监控 tick 绝不能单独让后台服务进程保持存活。
    this.timer.unref?.();
  }

  /** 刷新最后一次 tick 的时间戳；公开此方法以支持确定性测试。 */
  recordTick(): void {
    this.lastTickAt = this.now();
  }

  snapshot(): EventLoopSnapshot {
    const lagMeanMs = Number.isFinite(this.histogram.mean) ? this.histogram.mean / NS_PER_MS : 0;
    const lagP99Ms = this.histogram.percentile(99) / NS_PER_MS;
    const elu = performance.eventLoopUtilization(this.eluBaseline);
    const lastTickAgeMs = Math.max(0, this.now() - this.lastTickAt);
    return {
      lagMeanMs,
      lagP99Ms,
      utilization: elu.utilization,
      lastTickAgeMs,
      healthy: evaluateEventLoopHealthy({ lagMeanMs, lastTickAgeMs }),
    };
  }

  /** 禁用直方图并清除 tick interval；可幂等调用。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.started) {
      this.histogram.disable();
      this.started = false;
    }
  }
}
