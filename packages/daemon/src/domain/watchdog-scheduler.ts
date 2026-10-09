import type { WatchdogJob, WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import type { WatchdogPolicyEngine } from "./watchdog-policy-engine.js";

/**
 * Watchdog 调度器（PL-004 Phase C；后台服务原生监管树成员）。接入 createDaemon 生命周期：
 * policy engine 就绪后由 startup.ts 启动，在优雅关机期间停止。
 *
 * 循环语义：
 *   - 每隔 `tickIntervalMs`（默认 1000）唤醒，查询活跃作业中自 `last_evaluation_at` 起已超过
 *     `interval_seconds` 的项，以及从未评估过的项。
 *   - 对每个到期作业调用 policyEngine.evaluate(job)。engine 记录有意义的结果；纯粹未到期的
 *     轮询在此过滤，绝不进入历史。
 *   - SQLite 是规范调度状态；重启恢复自动完成：启动时 `listActive()` 返回同一集合，
 *     `last_evaluation_at` 决定下一次到期时间。
 *
 * 并发语义：
 *   - 同时只有一个在途 tick。若 tick 耗时超过 tickIntervalMs（policy.evaluate 较慢或投递较慢），
 *     下一 tick 会延后，不排队重叠 tick。
 *   - 一个 tick 内串行评估作业，以限制资源使用，并与 POC 的单循环行为一致。
 *
 * 关机语义：
 *   - stop() 设置 shuttingDown=true、清除定时器并等待在途 tick（若有）。该操作幂等。
 */

export interface WatchdogSchedulerDeps {
  jobsRepo: WatchdogJobsRepository;
  policyEngine: WatchdogPolicyEngine;
  /** Tick 唤醒节奏，默认 1000 ms。 */
  tickIntervalMs?: number;
  /** 测试可覆盖时钟。 */
  now?: () => Date;
  /** 测试可覆盖定时器调度器。 */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** 在取得到期作业快照前协调持久领域状态。 */
  beforeTick?: () => void;
  /** tick 错误通知，用于遥测；默认为 console.error。 */
  onTickError?: (err: unknown) => void;
}

export class WatchdogScheduler {
  private readonly jobsRepo: WatchdogJobsRepository;
  private readonly policyEngine: WatchdogPolicyEngine;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (handle: NodeJS.Timeout) => void;
  private readonly beforeTick?: () => void;
  private readonly onTickError: (err: unknown) => void;

  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private shuttingDown = false;
  private started = false;

  constructor(deps: WatchdogSchedulerDeps) {
    this.jobsRepo = deps.jobsRepo;
    this.beforeTick = deps.beforeTick;
    this.policyEngine = deps.policyEngine;
    this.tickIntervalMs = deps.tickIntervalMs ?? 1000;
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    this.onTickError = deps.onTickError ?? ((err) => console.error("[watchdog] tick 错误", err));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.shuttingDown = false;
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.shuttingDown = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        // 错误已通过 onTickError 记录；关机期间不再抛出。
      }
    }
    this.started = false;
  }

  isRunning(): boolean {
    return this.started && !this.shuttingDown;
  }

  /**
   * 同步运行一个 tick 并等待结果。公开给测试，使其无需定时器即可驱动 tick；
   * 生产路径通过定时器循环调用。
   */
  async runTickNow(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.tick();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private scheduleNextTick(): void {
    if (this.shuttingDown) return;
    this.timer = this.setTimer(() => {
      void this.runTickNow()
        .catch((err) => this.onTickError(err))
        .finally(() => this.scheduleNextTick());
    }, this.tickIntervalMs);
  }

  private async tick(): Promise<void> {
    if (this.shuttingDown) return;
    const passStartedAt = this.now();
    const nowMs = passStartedAt.getTime();
    this.beforeTick?.();
    const active = this.jobsRepo.listActive();
    for (const job of active) {
      if (this.shuttingDown) return;
      if (!isDue(job, nowMs)) continue;
      try {
        await this.policyEngine.evaluate(job, passStartedAt.toISOString());
      } catch (err) {
        this.onTickError(err);
      }
    }
  }
}

/**
 * R1 修复：提供 `scan_interval_seconds` 时由它控制扫描节奏，否则回退到 `interval_seconds`。
 * 这与 POC engine（lib/engine.mjs:38-46）一致，其中 `last_scan_at` 和
 * `scan_interval_seconds` 为策略调用设门禁。唤醒节奏（`active_wake_interval_seconds`）
 * 由上一层 policy engine 强制，不在此处理。
 */
export function isDue(job: WatchdogJob, nowMs: number): boolean {
  if (!job.lastEvaluationAt) return true;
  const last = Date.parse(job.lastEvaluationAt);
  if (Number.isNaN(last)) return true;
  const cadenceSeconds = job.scanIntervalSeconds ?? job.intervalSeconds;
  return nowMs - last >= cadenceSeconds * 1000;
}
