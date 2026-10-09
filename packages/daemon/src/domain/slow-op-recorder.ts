import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import type { MiddlewareHandler } from "hono";

export const SLOW_OPERATION_BARRIER_TIMEOUT_MS = 250;
export const SLOW_OPERATION_THRESHOLD_MS = 250;
export const SLOW_OPERATION_ROTATION_BYTES = 1024 * 1024;
export const SLOW_OPERATION_ROTATION_COUNT = 3;
export const SLOW_OPERATION_LOG_BASENAME = "slow-operations.jsonl";

export interface SlowOperationSnapshot {
  healthy: boolean;
  reason?: string;
  site?: string;
}

/**
 * OPR.0.4.3.21（51elv2）——具名终态失败信号。recorder Worker 丢失后，
 * 被拒绝的 flush/close 携带此错误，使调用方不会把“已结束但丢失”的排空误认为
 * 成功持久排空（见 {@link SlowOpRecorder} 的终态迁移）。
 */
export class SlowOpRecorderTerminatedError extends Error {
  constructor(reason: string) {
    super(`慢操作记录器已终止：${reason}`);
    this.name = "SlowOpRecorderTerminatedError";
  }
}

/**
 * OPR.0.4.3.21（51elv2）——具名的已确认写失败信号。Worker 仍存活
 *（区别于 {@link SlowOpRecorderTerminatedError}），但它已确认某条记录无法持久写入；
 * flush()/close() 以此拒绝，避免已知丢失的记录看起来像干净的持久排空。
 */
export class SlowOpRecorderWriteError extends Error {
  constructor(reason: string) {
    super(`慢操作记录器写入失败：${reason}`);
    this.name = "SlowOpRecorderWriteError";
  }
}

export interface SlowOperationInstrumentation {
  runSync?<T>(site: string, fn: () => T): T;
  runStage?<T>(
    site: string,
    fn: () => Promise<T>,
    classify?: (value: T) => "ok" | "failed",
  ): Promise<T>;
  recordRequest?(site: string, durationMs: number): void;
  snapshot?(): SlowOperationSnapshot;
  setDegradedHandler?(handler: (snapshot: Required<Pick<SlowOperationSnapshot, "reason" | "site">>) => void): void;
  // OPR.0.4.3.21（51elv2）——可选优雅关闭生命周期。无法证明持久性的排空会被拒绝，
  // 绝不静默成功；见 index.ts。
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

// 请求计时中间件，被提取为已接线接缝（OPR request-observer）。它仅做测量：observer 在
// `finally` 中调用，并由独立 try/catch 隔离，所以 observer 抛错绝不能替换路由的真实 status/body。
// `now` 可注入（默认真实墙上时钟），使记录时长在测试中确定；这与 compaction-restore 和
// mission-bucket 接缝采用相同的可注入时钟纪律。server.ts 通过
// `app.use("*", createSlowOpRequestMiddleware(recorder))` 接线；startup-wiring 固定用例证明启用路径。
export function createSlowOpRequestMiddleware(
  recorder: Pick<SlowOperationInstrumentation, "recordRequest">,
  now: () => number = () => Date.now(),
): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = now();
    try {
      await next();
    } finally {
      try {
        recorder.recordRequest?.(`${c.req.method} ${c.req.path}`, now() - startedAt);
      } catch (error) {
        // 测量抛错绝不能重新进入 Hono 控制流，否则会把路由变成 500。
        console.error("[慢操作] 请求观察器失败", error);
      }
    }
  };
}

interface SlowOpRecorderOptions {
  logPath: string;
  maxBytes?: number;
  rotationCount?: number;
  slowThresholdMs?: number;
  barrierTimeoutMs?: number;
}

interface Span {
  spanId: string;
  site: string;
  startedAt: number;
}

const WORKER_SOURCE = String.raw`
  const fs = require("node:fs");
  const path = require("node:path");
  const { parentPort } = require("node:worker_threads");

  function rotate(logPath, rotationCount) {
    for (let index = rotationCount; index >= 1; index -= 1) {
      const source = index === 1 ? logPath : logPath + "." + (index - 1);
      const target = logPath + "." + index;
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
      fs.chmodSync(target, 0o600);
    }
  }

  function append(message) {
    const line = JSON.stringify(message.record) + "\n";
    fs.mkdirSync(path.dirname(message.logPath), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(message.logPath).size; } catch {}
    if (size > 0 && size + Buffer.byteLength(line) > message.maxBytes) {
      rotate(message.logPath, message.rotationCount);
    }
    const fd = fs.openSync(message.logPath, "a", 0o600);
    try {
      fs.chmodSync(message.logPath, 0o600);
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  parentPort.on("message", (message) => {
    let ok = true;
    let error;
    try {
      if (message.type === "append") append(message);
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : String(caught);
    }
    if (message.signal) {
      const state = new Int32Array(message.signal);
      Atomics.store(state, 0, ok ? 1 : 2);
      Atomics.notify(state, 0);
    } else if (message.id) {
      parentPort.postMessage({ id: message.id, ok, error });
    }
  });
`;

export class SlowOpRecorder implements SlowOperationInstrumentation {
  private readonly worker: Worker;
  private readonly logPath: string;
  private readonly maxBytes: number;
  private readonly rotationCount: number;
  private readonly slowThresholdMs: number;
  private readonly barrierTimeoutMs: number;
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
  private degraded: SlowOperationSnapshot = { healthy: true };
  private degradedHandler?: (snapshot: Required<Pick<SlowOperationSnapshot, "reason" | "site">>) => void;
  private closed = false;
  // OPR.0.4.3.21（51elv2）——Worker 丢失时设置一次（error、意外 exit、messageerror
  // 或同步 postMessage 失败）。它与 `closed`（调用方发起的预期拆除）不同：终态 recorder
  // 会拒绝后续所有 post/flush，避免无限等待或错误报告持久排空成功。
  private terminalReason: string | null = null;
  // OPR.0.4.3.21（51elv2）——Worker 确认某条记录无法持久写入（ok:false）后设置的
  // 粘性闩锁。Worker 仍存活，但持久性已丢失，因此 flush()/close() 必须拒绝报告干净排空。
  private acknowledgedWriteFailure = false;

  constructor(options: SlowOpRecorderOptions) {
    this.logPath = options.logPath;
    this.maxBytes = options.maxBytes ?? SLOW_OPERATION_ROTATION_BYTES;
    this.rotationCount = options.rotationCount ?? SLOW_OPERATION_ROTATION_COUNT;
    this.slowThresholdMs = options.slowThresholdMs ?? SLOW_OPERATION_THRESHOLD_MS;
    this.barrierTimeoutMs = options.barrierTimeoutMs ?? SLOW_OPERATION_BARRIER_TIMEOUT_MS;
    this.worker = new Worker(WORKER_SOURCE, { eval: true, execArgv: [] });
    this.worker.unref();
    this.worker.on("message", (message: { id?: string; ok?: boolean }) => {
      if (!message.id) return;
      if (message.ok === false) {
        // 在解决此 waiter 前锁存持久性丢失（写尝试已结束，只是失败）：保留一次性 degraded
        // 信号和 waiter 解决，但 flush()/close() 此后会拒绝干净排空。
        this.acknowledgedWriteFailure = true;
        this.markDegraded("recorder_write_failed", "recorder.worker");
      }
      this.pending.get(message.id)?.resolve();
      this.pending.delete(message.id);
    });
    // 所有不可恢复 Worker 丢失触发器共用一个终态迁移。
    this.worker.on("error", () => this.handleTerminalFailure("recorder_worker_failed"));
    // recorder 尚开启时的意外退出（包括退出码 0）都算丢失；正常 close() 会先设置
    // `closed`，因此此处跳过。
    this.worker.on("exit", () => {
      if (!this.closed) this.handleTerminalFailure("recorder_worker_exited");
    });
    this.worker.on("messageerror", () => this.handleTerminalFailure("recorder_worker_message_error"));
  }

  setDegradedHandler(handler: (snapshot: Required<Pick<SlowOperationSnapshot, "reason" | "site">>) => void): void {
    this.degradedHandler = handler;
  }

  snapshot(): SlowOperationSnapshot {
    return { ...this.degraded };
  }

  beginSyncSpan(site: string): Span {
    const span: Span = { spanId: randomUUID(), site, startedAt: performance.now() };
    const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const state = new Int32Array(signal);
    try {
      this.worker.postMessage({
        type: "append",
        signal,
        logPath: this.logPath,
        maxBytes: this.maxBytes,
        rotationCount: this.rotationCount,
        record: { v: 1, ts: new Date().toISOString(), spanId: span.spanId, phase: "begin", site },
      });
    } catch {
      // 同步 postMessage 失败表示 Worker 已消失：经终态迁移降级，但仍返回 span，
      // 使被包装操作执行完成，并精确保留其值/错误。
      this.handleTerminalFailure("recorder_post_failed", site);
      return span;
    }
    const wait = Atomics.wait(state, 0, 0, this.barrierTimeoutMs);
    if (wait === "timed-out") this.markDegraded("begin_barrier_timeout", site);
    else if (Atomics.load(state, 0) !== 1) this.markDegraded("begin_barrier_failed", site);
    return span;
  }

  runSync<T>(site: string, fn: () => T): T {
    const span = this.beginSyncSpan(site);
    try {
      const value = fn();
      this.endSpan(span, "ok");
      return value;
    } catch (error) {
      this.endSpan(span, "failed");
      throw error;
    }
  }

  async runStage<T>(
    site: string,
    fn: () => Promise<T>,
    classify?: (value: T) => "ok" | "failed",
  ): Promise<T> {
    const startedAt = performance.now();
    try {
      const value = await fn();
      this.recordMeasurement(site, performance.now() - startedAt, classify?.(value) ?? "ok");
      return value;
    } catch (error) {
      this.recordMeasurement(site, performance.now() - startedAt, "failed");
      throw error;
    }
  }

  recordMeasurement(site: string, durationMs: number, outcome: "ok" | "failed" = "ok"): void {
    this.appendAsync({
      v: 1,
      ts: new Date().toISOString(),
      spanId: randomUUID(),
      phase: "end",
      site,
      durationMs: Math.max(0, durationMs),
      outcome,
    });
  }

  recordRequest(site: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < this.slowThresholdMs) return;
    this.recordMeasurement(`request:${site}`, durationMs);
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    // Worker 丢失时以 SlowOpRecorderTerminatedError 拒绝——有界结束，绝不伪报持久排空成功。
    await this.postAndWait({ type: "flush" });
    // marker 已往返，但若 Worker 此前确认某次写入无法持久化，则持久性仍未证明；
    // 必须拒绝，使 flush()/close()（及生产排空）不在记录丢失时报告干净排空。
    if (this.acknowledgedWriteFailure) {
      throw new SlowOpRecorderWriteError("recorder_write_failed");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // 尽力排空仍会拆除 Worker 并在有限时间内结束，但为调用方保留终态排空失败；
    // index.ts 将其映射为非零退出，使丢失排空绝不会看起来像干净关闭。
    let drainError: unknown;
    try {
      await this.flush();
    } catch (error) {
      drainError = error;
    }
    this.closed = true;
    await this.worker.terminate();
    if (drainError) throw drainError;
  }

  private endSpan(span: Span, outcome: "ok" | "failed"): void {
    this.appendAsync({
      v: 1,
      ts: new Date().toISOString(),
      spanId: span.spanId,
      phase: "end",
      site: span.site,
      durationMs: Math.max(0, performance.now() - span.startedAt),
      outcome,
    });
  }

  private appendAsync(record: Record<string, unknown>): void {
    if (this.closed) return;
    // 发出即忘：终态 Worker 丢失会拒绝此 promise，因此在内部消化该结果；
    // Worker 丢失绝不能在测量路径上暴露成未处理拒绝。
    void this.postAndWait({
      type: "append",
      logPath: this.logPath,
      maxBytes: this.maxBytes,
      rotationCount: this.rotationCount,
      record,
    }).catch(() => {});
  }

  private postAndWait(message: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.terminalReason !== null) return Promise.reject(this.terminalError());
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ ...message, id });
      } catch {
        // 同步 postMessage 失败——Worker 已消失。执行同一终态迁移；
        // 此 waiter 与其他 waiter 一起被拒绝。
        this.pending.delete(id);
        this.handleTerminalFailure("recorder_post_failed");
        reject(this.terminalError());
      }
    });
  }

  private terminalError(): SlowOpRecorderTerminatedError {
    return new SlowOpRecorderTerminatedError(this.terminalReason ?? "recorder_terminated");
  }

  /**
   * 所有不可恢复 Worker 丢失触发器共用的唯一终态失败迁移。它是幂等的
   *（pending 仅结算一次），用一次性高紧急度信号将健康标为 degraded，并拒绝每个
   * pending waiter，使 flush 不会挂起或误报持久排空成功。
   */
  private handleTerminalFailure(reason: string, site = "recorder.worker"): void {
    if (this.terminalReason !== null) return;
    this.terminalReason = reason;
    this.markDegraded(reason, site);
    const error = this.terminalError();
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private markDegraded(reason: string, site: string): void {
    if (!this.degraded.healthy) return;
    this.degraded = { healthy: false, reason, site };
    try {
      this.degradedHandler?.({ reason, site });
    } catch {}
  }
}
