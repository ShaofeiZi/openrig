import type Database from "better-sqlite3";
import { isQueueWait } from "./queue-wait-backoff.js";

export type ParkWakeKind = "watchdog" | "timer" | "blocker";
export type ParkWakePhase = "armed" | "fired";

/** S16：标识唯一共享的 provider/账号阻塞项，其计时器到期时间会被依赖它的 HELD 行继承。
 * 普通阻塞项仍不带到期时间。 */
export const USAGE_LIMIT_BLOCKER_TAG = "usage-limit-blocker";
export const USAGE_LIMIT_POOL_TAG_PREFIX = "usage-limit-pool:";

/** S16 计时器预计到期边界的唯一计算方式。附加阶段用 registeredAt 初始化
 * lastEvaluationAt 后，调度器会执行同一边界。 */
export function timerExpiresAt(registeredAt: string, intervalSeconds: number): string | undefined {
  const registeredAtMs = Date.parse(registeredAt);
  if (!Number.isFinite(registeredAtMs) || !Number.isFinite(intervalSeconds)) return undefined;
  return new Date(registeredAtMs + intervalSeconds * 1000).toISOString();
}

export interface QueueWakeRecord {
  transitionId: number;
  qitemId: string;
  phase: ParkWakePhase;
  kind: ParkWakeKind;
  ref: string;
  deliveryStatus: string | null;
  expiresAt?: string;
}

export interface ParkWakeStatus {
  kind: ParkWakeKind;
  ref: string;
  phase: ParkWakePhase;
  live: boolean;
  deliveryStatus: string | null;
  /** 唤醒已触发，但该行仍处于 HELD。恢复尝试必须可见，不能误认为健康的已武装延续。 */
  unconsumed: boolean;
  /** 重复等待通知由独立且有界的恢复责任方处理。 */
  recoveryOwner?: "queue-stuck-sweep";
  /** 从规范 watchdog 元数据派生的绝对到期时间。只对计时器或获准的使用量限制计时器
   * 阻塞项的依赖者提供。 */
  expiresAt?: string;
}

interface WakeRow {
  transition_id: number;
  qitem_id: string;
  phase: string;
  wake_kind: string;
  wake_ref: string;
  delivery_status: string | null;
}

/** 与转换绑定的暂存唤醒持久化及实时状态投影。 */
export class QueueWakeRepository {
  private readonly available: boolean;

  constructor(private readonly db: Database.Database) {
    this.available = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'queue_transition_wakes'",
    ).get() !== undefined;
  }

  record(input: QueueWakeRecord): void {
    if (!this.available) return;
    this.db.prepare(
      `INSERT INTO queue_transition_wakes
        (transition_id, qitem_id, phase, wake_kind, wake_ref, delivery_status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.transitionId,
      input.qitemId,
      input.phase,
      input.kind,
      input.ref,
      input.deliveryStatus,
    );
  }

  getForTransition(transitionId: number): QueueWakeRecord | null {
    if (!this.available) return null;
    const row = this.db.prepare(
      "SELECT * FROM queue_transition_wakes WHERE transition_id = ?",
    ).get(transitionId) as WakeRow | undefined;
    return row ? this.row(row) : null;
  }

  getStatus(qitemId: string): ParkWakeStatus | null {
    if (!this.available) return null;
    const armed = this.db.prepare(
      `SELECT * FROM queue_transition_wakes
        WHERE qitem_id = ? AND phase = 'armed'
        ORDER BY transition_id DESC LIMIT 1`,
    ).get(qitemId) as WakeRow | undefined;
    if (!armed) return null;
    const fired = this.db.prepare(
      `SELECT * FROM queue_transition_wakes
        WHERE qitem_id = ? AND phase = 'fired' AND wake_ref = ?
          AND transition_id > ?
        ORDER BY transition_id DESC LIMIT 1`,
    ).get(qitemId, armed.wake_ref, armed.transition_id) as WakeRow | undefined;
    const state = (this.db.prepare(
      "SELECT state FROM queue_items WHERE qitem_id = ?",
    ).get(qitemId) as { state: string } | undefined)?.state;
    const kind = armed.wake_kind as ParkWakeKind;
    const expiresAt = this.wakeExpiry(qitemId, kind, armed.wake_ref);
    return {
      kind,
      ref: armed.wake_ref,
      phase: fired ? "fired" : "armed",
      live: fired && !this.isRepeatingTimer(armed.wake_ref) ? false : this.isLive(kind, armed.wake_ref),
      deliveryStatus: fired?.delivery_status ?? null,
      unconsumed: fired !== undefined && state === "blocked",
      ...(this.isRepeatingTimer(armed.wake_ref) ? { recoveryOwner: "queue-stuck-sweep" as const } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  findBlockedQitemsByWatchdog(jobId: string): Array<{ qitemId: string; kind: "watchdog" | "timer" }> {
    if (!this.available) return [];
    return this.db.prepare(
      `SELECT DISTINCT w.qitem_id, w.wake_kind
         FROM queue_transition_wakes w
         JOIN queue_items q ON q.qitem_id = w.qitem_id
        WHERE w.phase = 'armed' AND w.wake_ref = ?
          AND w.wake_kind IN ('watchdog', 'timer') AND q.state = 'blocked'
          AND (? OR NOT EXISTS (
            SELECT 1 FROM queue_transition_wakes f
             WHERE f.qitem_id = w.qitem_id AND f.phase = 'fired'
               AND f.wake_ref = w.wake_ref AND f.transition_id > w.transition_id
          ))`,
    ).all(jobId, this.isRepeatingTimer(jobId) ? 1 : 0).map((row) => {
      const r = row as { qitem_id: string; wake_kind: "watchdog" | "timer" };
      return { qitemId: r.qitem_id, kind: r.wake_kind };
    });
  }

  /** 查找绑定到暂存流程所生成计时器的队列行，不论计时器此前是否触发。旧版后台服务可能在
   * 行关闭后仍保留重复计时器，因此交付时防护必须查询原始 armed 绑定，不能只看当前
   * blocked/fired 投影。 */
  findQitemsByGeneratedTimer(jobId: string): Array<{ qitemId: string; state: string }> {
    if (!this.available) return [];
    return this.db.prepare(
      `SELECT DISTINCT w.qitem_id, q.state
         FROM queue_transition_wakes w
         JOIN queue_items q ON q.qitem_id = w.qitem_id
        WHERE w.phase = 'armed' AND w.wake_ref = ? AND w.wake_kind = 'timer'`,
    ).all(jobId).map((row) => {
      const r = row as { qitem_id: string; state: string };
      return { qitemId: r.qitem_id, state: r.state };
    });
  }

  /** 查找把操作者 watchdog 附加到此任务的队列行，不限其当前状态。暂存流程生成的计时器
   * 与操作者附件可以共享同一个任务 ID：`--wake-watchdog` 接受目标匹配暂存所有者的任意
   * 活跃任务，包括另一行通过 `--wake-after` 创建的任务；第二个绑定会以
   * wake_kind = 'watchdog' 持久化到相同 wake_ref。计时器后备机制借此判断该任务并非只能
   * 由自己退役。 */
  findQitemsByAttachedWatchdog(jobId: string): Array<{ qitemId: string; state: string }> {
    if (!this.available) return [];
    return this.db.prepare(
      `SELECT DISTINCT w.qitem_id, q.state
         FROM queue_transition_wakes w
         JOIN queue_items q ON q.qitem_id = w.qitem_id
        WHERE w.phase = 'armed' AND w.wake_ref = ? AND w.wake_kind = 'watchdog'`,
    ).all(jobId).map((row) => {
      const r = row as { qitem_id: string; state: string };
      return { qitemId: r.qitem_id, state: r.state };
    });
  }

  private isLive(kind: ParkWakeKind, ref: string): boolean {
    if (kind === "blocker") {
      const row = this.db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(ref) as
        | { state: string }
        | undefined;
      return row !== undefined && ["pending", "in-progress", "blocked"].includes(row.state);
    }
    const row = this.db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(ref) as
      | { state: string }
      | undefined;
    return row?.state === "active";
  }

  private isRepeatingTimer(ref: string): boolean {
    const row = this.db.prepare("SELECT spec_yaml FROM watchdog_jobs WHERE job_id = ? AND state = 'active'").get(ref) as { spec_yaml: string } | undefined;
    return row ? isQueueWait(row.spec_yaml) : false;
  }

  private isUsageLimitBlocker(qitemId: string): boolean {
    const row = this.db.prepare("SELECT tags FROM queue_items WHERE qitem_id = ?").get(qitemId) as
      | { tags: string | null }
      | undefined;
    if (!row?.tags) return false;
    try {
      return (JSON.parse(row.tags) as unknown[]).includes(USAGE_LIMIT_BLOCKER_TAG);
    } catch {
      return false;
    }
  }

  private wakeExpiry(qitemId: string, kind: ParkWakeKind, ref: string): string | undefined {
    if (kind === "timer" && this.isUsageLimitBlocker(qitemId)) return this.timerExpiry(ref);
    if (kind === "blocker" && this.isUsageLimitBlocker(ref)) return this.usageLimitBlockerExpiry(ref);
    return undefined;
  }

  private usageLimitBlockerExpiry(qitemId: string): string | undefined {
    const row = this.db.prepare(
      `SELECT wake_ref FROM queue_transition_wakes
        WHERE qitem_id = ? AND phase = 'armed' AND wake_kind = 'timer'
        ORDER BY transition_id DESC LIMIT 1`,
    ).get(qitemId) as { wake_ref: string } | undefined;
    return row ? this.timerExpiry(row.wake_ref) : undefined;
  }

  private timerExpiry(jobId: string): string | undefined {
    const row = this.db.prepare(
      "SELECT registered_at, interval_seconds FROM watchdog_jobs WHERE job_id = ?",
    ).get(jobId) as { registered_at: string; interval_seconds: number } | undefined;
    if (!row) return undefined;
    return timerExpiresAt(row.registered_at, row.interval_seconds);
  }

  private row(row: WakeRow): QueueWakeRecord {
    const kind = row.wake_kind as ParkWakeKind;
    const expiresAt = this.wakeExpiry(row.qitem_id, kind, row.wake_ref);
    return {
      transitionId: row.transition_id,
      qitemId: row.qitem_id,
      phase: row.phase as ParkWakePhase,
      kind,
      ref: row.wake_ref,
      deliveryStatus: row.delivery_status,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
}
