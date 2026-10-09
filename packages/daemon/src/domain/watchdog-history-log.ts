import type Database from "better-sqlite3";
import { ulid } from "ulid";

/**
 * Watchdog 历史日志（PL-004 阶段 C；仅追加审计写入器）。
 *
 * 根据 slice IMPL § Guard Checkpoint Focus item 2：
 * - 不记录纯 `not_due` 轮询（与 POC 一致，以减小表大小）；只有
 *   `sent` / `skipped` / `terminal` 结果进入此日志。
 * - API 表面仅追加，只暴露 `record()`，不暴露 UPDATE/DELETE。SQLite 没有 view/role 层，
 *   直接 SQL 仍可修改，但此 domain 边界会强制契约。
 */

export type WatchdogOutcome = "sent" | "skipped" | "terminal";

export interface WatchdogHistoryRecordInput {
  jobId: string;
  evaluatedAt: string;
  outcome: WatchdogOutcome;
  skipReason?: string | null;
  deliveryTargetSession?: string | null;
  deliveryStatus?: string | null;
  deliveryMessage?: string | null;
  evaluationNotes?: Record<string, unknown> | null;
}

export interface WatchdogHistoryEntry {
  historyId: string;
  jobId: string;
  evaluatedAt: string;
  outcome: WatchdogOutcome;
  skipReason: string | null;
  deliveryTargetSession: string | null;
  deliveryStatus: string | null;
  deliveryMessage: string | null;
  evaluationNotes: Record<string, unknown> | null;
}

interface HistoryRow {
  history_id: string;
  job_id: string;
  evaluated_at: string;
  outcome: string;
  skip_reason: string | null;
  delivery_target_session: string | null;
  delivery_status: string | null;
  delivery_message: string | null;
  evaluation_notes: string | null;
}

export class WatchdogHistoryLog {
  constructor(private readonly db: Database.Database) {}

  /**
   * 追加有意义的评估结果并返回持久化条目。调用方不得为纯跳过的 `not_due` 结果调用本方法；
   * 按 POC 与 IMPL 指引，此类结果不记录。
   */
  record(input: WatchdogHistoryRecordInput): WatchdogHistoryEntry {
    const historyId = ulid();
    this.db
      .prepare(
        `INSERT INTO watchdog_history (
          history_id, job_id, evaluated_at, outcome,
          skip_reason, delivery_target_session, delivery_status,
          delivery_message, evaluation_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        historyId,
        input.jobId,
        input.evaluatedAt,
        input.outcome,
        input.skipReason ?? null,
        input.deliveryTargetSession ?? null,
        input.deliveryStatus ?? null,
        input.deliveryMessage ?? null,
        input.evaluationNotes ? JSON.stringify(input.evaluationNotes) : null,
      );
    return {
      historyId,
      jobId: input.jobId,
      evaluatedAt: input.evaluatedAt,
      outcome: input.outcome,
      skipReason: input.skipReason ?? null,
      deliveryTargetSession: input.deliveryTargetSession ?? null,
      deliveryStatus: input.deliveryStatus ?? null,
      deliveryMessage: input.deliveryMessage ?? null,
      evaluationNotes: input.evaluationNotes ?? null,
    };
  }

  listForJob(jobId: string, limit = 50): WatchdogHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watchdog_history WHERE job_id = ?
         ORDER BY evaluated_at DESC, history_id DESC LIMIT ?`,
      )
      .all(jobId, limit) as HistoryRow[];
    return rows.map(rowToEntry);
  }

  listAll(limit = 100): WatchdogHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watchdog_history
         ORDER BY evaluated_at DESC, history_id DESC LIMIT ?`,
      )
      .all(limit) as HistoryRow[];
    return rows.map(rowToEntry);
  }

  countForJob(jobId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM watchdog_history WHERE job_id = ?`)
      .get(jobId) as { n: number };
    return row.n;
  }
}

function rowToEntry(row: HistoryRow): WatchdogHistoryEntry {
  return {
    historyId: row.history_id,
    jobId: row.job_id,
    evaluatedAt: row.evaluated_at,
    outcome: row.outcome as WatchdogOutcome,
    skipReason: row.skip_reason,
    deliveryTargetSession: row.delivery_target_session,
    deliveryStatus: row.delivery_status,
    deliveryMessage: row.delivery_message,
    evaluationNotes: row.evaluation_notes ? JSON.parse(row.evaluation_notes) : null,
  };
}
