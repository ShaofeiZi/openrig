import { createHash } from "node:crypto";

/**
 * 只读捕获观察器（0.6.0 S01/S02 P2）。
 *
 * 记录发送/验证、探测和 guard 保留路径已经看到的内容，供后续离线或异步消费者
 * 分类。它从不作出决策：不授予粘贴、Enter 或重放权限，不进行新捕获，也绝不
 * 改变调用方结果。
 *
 * `record()` 是热路径上的唯一调用。它同步执行，不做 I/O、不等待且永不抛出：
 * 内部失败只计数，不向上抛。队列有界；满载时丢弃并统计新观察，确保分母真实。
 * `drain()` 把有界批次交给注入的消费者；绝不重放批次，也绝不阻塞 `record()`。
 */

export type ObserverSeam = "send_verify" | "probe_activity" | "retained_no_write";

/**
 * 捕获槽中保存的内容。`unavailable` 不会臆测无法得知的原因。captureSeq 对单个
 * 传输进程中观测到的捕获调用排序；capturedAt 记录返回或出错时间。二者都不是
 * 观察入队顺序或提供方时钟。持久化证据应按 attemptId 和 pre/post 槽关联。
 */
export type CaptureSlot =
  | { state: "captured"; content: string; capturedAt: string; captureSeq: number }
  /** 适配器返回 null；在此基础层只能确定其为空或失败。 */
  | { state: "unavailable"; cause: "empty_or_failed"; capturedAt: string; captureSeq: number }
  /** 捕获调用抛出异常：已知发生了失败。 */
  | { state: "unavailable"; cause: "capture_error"; capturedAt: string; captureSeq: number }
  /** 本次尝试未请求此捕获（例如仅发送而不验证）。 */
  | { state: "not_requested" }
  /** 已请求，但尝试在执行到此处前结束（例如粘贴失败）。 */
  | { state: "not_reached" };

export interface ObservedBinding {
  sessionName: string;
  nodeId: string | null;
  occupant: string | null;
  pane: string | null;
}

export interface ObservationInput {
  seam: ObserverSeam;
  /** 每次传输尝试一个 ID；同一次尝试的观察共享该 ID。 */
  attemptId: string;
  binding: ObservedBinding;
  runtime: string | null;
  /** 已发送文本的哈希，绝不保存文本本身；未发送内容时为 null。 */
  sentHash: string | null;
  pre: CaptureSlot;
  post: CaptureSlot;
  /**
   * 既有的正则/传输判定：只复制调用方实际产生的字段；缺失的可选字段保持缺失，
   * 绝不凭空构造判定。
   */
  regexResult: Record<string, unknown>;
  /** 尝试完成时间（不同于每次捕获各自的 capturedAt）。 */
  completedAt: string;
}

export interface Observation extends Readonly<ObservationInput> {
  /** 观察器接受记录的单调递增顺序。 */
  readonly seq: number;
}

export interface CaptureObserverStats {
  recorded: number;
  dropped: number;
  recordErrors: number;
  missingCaptures: number;
  notRequestedCaptures: number;
  notReachedCaptures: number;
  drained: number;
  consumerFailures: number;
  consumerFailedObservations: number;
  queued: number;
  queuedBytes: number;
  drainingBytes: number;
  droppedBytes: number;
}

export type ObservationConsumer = (batch: readonly Observation[]) => void | Promise<void>;

export const DEFAULT_OBSERVER_CAPACITY = 256;
export const DEFAULT_DRAIN_BATCH = 64;

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function hashSentText(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** 深度冻结普通数据，防止已入队的观察随后被修改。 */
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) freeze(v);
  }
  return value;
}

export class CaptureObserver {
  private accepting = true;
  private readonly capacity: number;
  private readonly queue: Observation[] = [];
  private readonly maxQueuedBytes: number;
  private readonly maxObservationBytes: number;
  private queuedBytes = 0;
  private drainingBytes = 0;
  private readonly sizes: number[] = [];
  private nextSeq = 1;
  private draining = false;
  private readonly counters = {
    recorded: 0, dropped: 0, droppedBytes: 0, recordErrors: 0, missingCaptures: 0, notRequestedCaptures: 0, notReachedCaptures: 0,
    drained: 0, consumerFailures: 0, consumerFailedObservations: 0,
  };

  constructor(opts?: { capacity?: number; maxQueuedBytes?: number; maxObservationBytes?: number }) {
    this.capacity = positiveInteger(opts?.capacity, DEFAULT_OBSERVER_CAPACITY);
    this.maxQueuedBytes = positiveInteger(opts?.maxQueuedBytes, 4 * 1024 * 1024);
    this.maxObservationBytes = positiveInteger(opts?.maxObservationBytes, 256 * 1024);
  }

  /** 热路径入口。同步、无 I/O、永不抛出异常。 */
  record(input: ObservationInput): void {
    if (!this.accepting) return;
    try {
      for (const slot of [input.pre, input.post]) {
        if (slot.state === "unavailable") this.counters.missingCaptures++;
        else if (slot.state === "not_requested") this.counters.notRequestedCaptures++;
        else if (slot.state === "not_reached") this.counters.notReachedCaptures++;
      }
      if (this.queue.length >= this.capacity) {
        this.counters.dropped++;
        return;
      }
      const contentBytes = [input.pre, input.post].reduce((n, slot) => n + (slot.state === "captured" ? Buffer.byteLength(slot.content) : 0), 0);
      if (contentBytes > this.maxObservationBytes) { this.counters.dropped++; this.counters.droppedBytes += contentBytes; return; }
      const observation = freeze({ ...structuredClone(input), seq: this.nextSeq++ }) as Observation;
      const size = Buffer.byteLength(JSON.stringify(observation)) + 1;
      if (size > this.maxObservationBytes || this.queuedBytes + size > this.maxQueuedBytes) {
        this.counters.dropped++; this.counters.droppedBytes += size; return;
      }
      this.sizes.push(size); this.queuedBytes += size;
      this.queue.push(observation);
      this.counters.recorded++;
    } catch {
      this.counters.recordErrors++;
    }
  }

  /**
   * 按顺序把最多 `maxItems` 条已入队观察交给 `consumer`。调用前即从队列移除：
   * 消费者失败时该批次会丢失（并计数），绝不重放。并发 drain 会被拒绝并返回 0，
   * 而不是等待。
   */
  async drain(consumer: ObservationConsumer, maxItems = DEFAULT_DRAIN_BATCH): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    const batch = Object.freeze(this.queue.splice(0, positiveInteger(maxItems, DEFAULT_DRAIN_BATCH)));
    this.drainingBytes = this.sizes.splice(0, batch.length).reduce((n, size) => n + size, 0);
    this.queuedBytes -= this.drainingBytes;
    try {
      if (batch.length === 0) return 0;
      await consumer(batch);
      this.counters.drained += batch.length;
      return batch.length;
    } catch {
      this.counters.consumerFailures++;
      this.counters.consumerFailedObservations += batch.length;
      return 0;
    } finally {
      this.draining = false; this.drainingBytes = 0;
    }
  }

  stats(): CaptureObserverStats {
    return { ...this.counters, queued: this.queue.length, queuedBytes: this.queuedBytes, drainingBytes: this.drainingBytes };
  }

  /** 停止接收新观察；已入队批次仍可 drain。 */
  stopRecording(): void { this.accepting = false; }
}

/** 传输层依赖的窄接口（任何提供安全 record() 的接收端均可）。 */
export interface CaptureObserverSink {
  record(input: ObservationInput): void;
}
