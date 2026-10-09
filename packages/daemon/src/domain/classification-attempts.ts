import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { ClassifierLeaseManager } from "./classifier-lease-manager.js";

/**
 * 分类尝试台账（0.6.0 S02 P1）。
 *
 * 保存分类器占用者必须记住、但不属于不可变 `project_classifications` 行的一切：
 * 在途工作、弃权和错误。它是台账，不是调度器——占用者由现有 watchdog/wake
 * 节奏唤醒，再询问 `eligible()` 下一步做什么。
 *
 * 身份：(stream_item_id, classifier_version, taxonomy_version, evidence_epoch)。
 * - abstained：仅对该身份为终态。新的 classifier/taxonomy 版本，或负责人授权的
 *   evidence epoch，构成新身份。
 * - error / 遗弃的 in_flight：按有界倍增延迟重试，耗尽预算后进入 `exhausted`
 *   （终态、可见）。
 * - written：由 ProjectClassifier 在与该行相同的事务中设置。
 *
 * 每次状态变更都在写事务内验证租约：有效、同一会话、同一 lease id 且未过期。
 *
 * 执行围栏：每次 begin——首次尝试、超时重发或错误重试——都会生成新的 executionId。
 * abstain、fail 和 classify 尝试绑定必须携带当前 executionId；旧执行会以
 * `attempt_superseded` 被拒绝，且不触碰当前执行。租约可以无限续期，因此租约有效
 * 不能证明旧执行已死，只有此围栏可以。
 */

export const ATTEMPT_STATUSES = ["in_flight", "abstained", "written", "error", "exhausted"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
const TERMINAL: readonly AttemptStatus[] = ["abstained", "written", "exhausted"];

/**
 * 重试默认值基于现有节奏选择，不另建调度器：
 * - 每个身份预算 3 次：一次尝试加两次重试，足以跨过临时 provider 或后台服务抖动，
 *   又不会在毒条目上循环；
 * - 退避从 5 分钟开始倍增，上限 60 分钟：比占用者自己的 wake 更粗，失败条目不会空转；
 *   同时有界，provider 恢复后可在一小时内重试；
 * - 在途超时 15 分钟：超过时间仍未完成，可作为新执行重发（常见原因是崩溃）。
 *   这不能证明旧执行已死，因为租约可续期；所以重发会生成新 executionId，旧执行不能再完成。
 *   重发计入预算。
 * 所有值都是构造器选项；测试注入时间而不 sleep。
 */
export const DEFAULT_RETRY_BUDGET = 3;
export const DEFAULT_BASE_BACKOFF_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000;
export const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_ELIGIBLE_PAGE = 100;

export interface AttemptIdentity {
  streamItemId: string;
  classifierVersion: string;
  taxonomyVersion: string;
  /** 负责人授权、绑定变更证据的重试 epoch；未使用时为 "0"。 */
  evidenceEpoch: string;
}

export interface ClassificationAttempt extends AttemptIdentity {
  attemptId: string;
  /** 当前执行；只有此值可以结束尝试。 */
  executionId: string;
  status: AttemptStatus;
  attemptCount: number;
  leaseId: string;
  classifierSession: string;
  retryAfter: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EligibleItem {
  streamItemId: string;
  tsEmitted: string;
  streamSortKey: string;
  sourceSession: string;
}

export interface EligiblePage {
  items: EligibleItem[];
  /** 作为 `afterSortKey` 传入以读取本轮下一页；结束时为 null。 */
  nextAfterSortKey: string | null;
}

interface AttemptRow {
  attempt_id: string;
  stream_item_id: string;
  classifier_version: string;
  taxonomy_version: string;
  evidence_epoch: string;
  status: string;
  attempt_count: number;
  execution_id: string;
  lease_id: string;
  classifier_session: string;
  retry_after: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export class ClassificationAttemptError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export interface ClassificationAttemptLedgerOptions {
  now?: () => Date;
  retryBudget?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  inFlightTimeoutMs?: number;
}

export class ClassificationAttemptLedger {
  readonly db: Database.Database;
  private readonly leaseManager: ClassifierLeaseManager;
  private readonly now: () => Date;
  private readonly retryBudget: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly inFlightTimeoutMs: number;

  constructor(db: Database.Database, leaseManager: ClassifierLeaseManager, opts?: ClassificationAttemptLedgerOptions) {
    this.db = db;
    this.leaseManager = leaseManager;
    this.now = opts?.now ?? (() => new Date());
    this.retryBudget = opts?.retryBudget ?? DEFAULT_RETRY_BUDGET;
    this.baseBackoffMs = opts?.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.inFlightTimeoutMs = opts?.inFlightTimeoutMs ?? DEFAULT_IN_FLIGHT_TIMEOUT_MS;
  }

  /**
   * 在调用方租约下启动或合法恢复某个身份的一次尝试。拒绝终态身份、新鲜的在途尝试，
   * 以及尚未到期的错误。超过在途超时，或由已替换租约持有的在途尝试，视为崩溃后遗弃。
   */
  begin(input: AttemptIdentity & { leaseId: string; classifierSession: string }): ClassificationAttempt {
    requireIdentity(input);
    requireStringFields(input, ["leaseId", "classifierSession"]);
    const txn = this.db.transaction((): { attemptId: string; exhausted: boolean } => {
      this.leaseManager.requireActiveHolder(input.classifierSession, input.leaseId);
      const stream = this.db
        .prepare(`SELECT 1 FROM stream_items WHERE stream_item_id = ?`)
        .get(input.streamItemId);
      if (!stream) {
        throw new ClassificationAttemptError("unknown_stream_item", `stream_item_id ${input.streamItemId} 不存在`, {
          streamItemId: input.streamItemId,
        });
      }
      const classified = this.db
        .prepare(`SELECT project_id FROM project_classifications WHERE stream_item_id = ?`)
        .get(input.streamItemId) as { project_id: string } | undefined;
      if (classified) {
        throw new ClassificationAttemptError("already_classified", `stream_item_id ${input.streamItemId} 已分类`, {
          existingProjectId: classified.project_id,
        });
      }

      const nowIso = this.now().toISOString();
      const existing = this.findRow(input);
      if (!existing) {
        const attemptId = ulid();
        this.db
          .prepare(
            `INSERT INTO classification_attempts (
              attempt_id, stream_item_id, classifier_version, taxonomy_version, evidence_epoch,
              status, attempt_count, execution_id, lease_id, classifier_session, retry_after, reason, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'in_flight', 1, ?, ?, ?, NULL, NULL, ?, ?)`,
          )
          .run(
            attemptId, input.streamItemId, input.classifierVersion, input.taxonomyVersion, input.evidenceEpoch,
            ulid(), input.leaseId, input.classifierSession, nowIso, nowIso,
          );
        return { attemptId, exhausted: false };
      }

      const status = existing.status as AttemptStatus;
      if (TERMINAL.includes(status)) {
        throw new ClassificationAttemptError("attempt_terminal", `此身份的 attempt 已处于 ${status}`, {
          attemptId: existing.attempt_id,
          status,
        });
      }
      if (status === "in_flight") {
        const abandoned =
          existing.lease_id !== input.leaseId ||
          Date.parse(existing.updated_at) + this.inFlightTimeoutMs <= this.now().getTime();
        if (!abandoned) {
          throw new ClassificationAttemptError("attempt_in_flight", "此身份已有 attempt 正在执行", {
            attemptId: existing.attempt_id,
          });
        }
      }
      if (status === "error" && existing.retry_after !== null && existing.retry_after > nowIso) {
        throw new ClassificationAttemptError("attempt_not_due", `重试要到 ${existing.retry_after} 才到期`, {
          attemptId: existing.attempt_id,
          retryAfter: existing.retry_after,
        });
      }
      if (existing.attempt_count >= this.retryBudget) {
        this.db
          .prepare(
            `UPDATE classification_attempts
               SET status = 'exhausted', retry_after = NULL, updated_at = ?,
                   reason = COALESCE(reason, 'retry budget spent')
             WHERE attempt_id = ?`,
          )
          .run(nowIso, existing.attempt_id);
        // 先提交终态迁移，再在提交后抛出拒绝。
        return { attemptId: existing.attempt_id, exhausted: true };
      }
      this.db
        .prepare(
          `UPDATE classification_attempts
             SET status = 'in_flight', attempt_count = attempt_count + 1, execution_id = ?,
                 lease_id = ?, classifier_session = ?, retry_after = NULL, updated_at = ?
           WHERE attempt_id = ?`,
        )
        .run(ulid(), input.leaseId, input.classifierSession, nowIso, existing.attempt_id);
      return { attemptId: existing.attempt_id, exhausted: false };
    });
    const result = txn();
    if (result.exhausted) {
      throw new ClassificationAttemptError("attempt_exhausted", `${this.retryBudget} 次重试预算已耗尽`, {
        attemptId: result.attemptId,
      });
    }
    return this.getByIdOrThrow(result.attemptId);
  }

  /** 此身份的终态弃权（低于阈值或 INDETERMINATE）。 */
  abstain(input: FinishInput): ClassificationAttempt {
    return this.finish(input, (row, nowIso) => {
      this.db
        .prepare(`UPDATE classification_attempts SET status = 'abstained', reason = ?, retry_after = NULL, updated_at = ? WHERE attempt_id = ?`)
        .run(input.reason, nowIso, row.attempt_id);
    });
  }

  /** 临时失败：安排有界重试，或耗尽预算。 */
  fail(input: FinishInput): ClassificationAttempt {
    return this.finish(input, (row, nowIso) => {
      if (row.attempt_count >= this.retryBudget) {
        this.db
          .prepare(`UPDATE classification_attempts SET status = 'exhausted', reason = ?, retry_after = NULL, updated_at = ? WHERE attempt_id = ?`)
          .run(input.reason, nowIso, row.attempt_id);
        return;
      }
      const retryAfter = new Date(this.now().getTime() + this.backoffMs(row.attempt_count)).toISOString();
      this.db
        .prepare(`UPDATE classification_attempts SET status = 'error', reason = ?, retry_after = ?, updated_at = ? WHERE attempt_id = ?`)
        .run(input.reason, retryAfter, nowIso, row.attempt_id);
    });
  }

  /**
   * 按流顺序返回一页有界条目，表示占用者在指定版本和 epoch 下当前可尝试的工作。
   * 每次调用都通过 anti-join 派生，因此稍后到期的重试会在下一轮重新出现，
   * 不会被持久化游标跳过。`afterSortKey` 只在单轮内分页。
   */
  eligible(opts: {
    classifierVersion: string;
    taxonomyVersion: string;
    evidenceEpoch: string;
    limit?: number;
    afterSortKey?: string;
  }): EligiblePage {
    requireIdentity({ streamItemId: "-", ...opts });
    const limit = Math.max(1, Math.min(opts.limit ?? MAX_ELIGIBLE_PAGE, MAX_ELIGIBLE_PAGE));
    const nowIso = this.now().toISOString();
    const inFlightCutoff = new Date(this.now().getTime() - this.inFlightTimeoutMs).toISOString();
    const params: unknown[] = [
      opts.classifierVersion, opts.taxonomyVersion, opts.evidenceEpoch, nowIso, inFlightCutoff,
    ];
    let cursorClause = "";
    if (opts.afterSortKey) {
      const cursor = this.db
        .prepare(`SELECT ts_emitted, stream_sort_key FROM stream_items WHERE stream_sort_key = ?`)
        .get(opts.afterSortKey) as { ts_emitted: string; stream_sort_key: string } | undefined;
      if (!cursor) {
        throw new ClassificationAttemptError("unknown_cursor", `afterSortKey ${opts.afterSortKey} 不是 stream sort key`);
      }
      cursorClause = "AND (s.ts_emitted, s.stream_sort_key) > (?, ?)";
      params.push(cursor.ts_emitted, cursor.stream_sort_key);
    }
    params.push(limit + 1);
    const rows = this.db
      .prepare(
        `SELECT s.stream_item_id, s.ts_emitted, s.stream_sort_key, s.source_session
           FROM stream_items s
           LEFT JOIN project_classifications p ON p.stream_item_id = s.stream_item_id
           LEFT JOIN classification_attempts a
             ON a.stream_item_id = s.stream_item_id
            AND a.classifier_version = ? AND a.taxonomy_version = ? AND a.evidence_epoch = ?
          WHERE s.archived_at IS NULL
            AND p.stream_item_id IS NULL
            AND (
              a.attempt_id IS NULL
              OR (a.status = 'error' AND (a.retry_after IS NULL OR a.retry_after <= ?))
              OR (a.status = 'in_flight' AND a.updated_at <= ?)
            )
            ${cursorClause}
          ORDER BY s.ts_emitted, s.stream_sort_key
          LIMIT ?`,
      )
      .all(...params) as Array<{ stream_item_id: string; ts_emitted: string; stream_sort_key: string; source_session: string }>;
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map((r) => ({
      streamItemId: r.stream_item_id,
      tsEmitted: r.ts_emitted,
      streamSortKey: r.stream_sort_key,
      sourceSession: r.source_session,
    }));
    return { items: page, nextAfterSortKey: more ? page[page.length - 1]!.streamSortKey : null };
  }

  getById(attemptId: string): ClassificationAttempt | null {
    const row = this.db.prepare(`SELECT * FROM classification_attempts WHERE attempt_id = ?`).get(attemptId) as
      | AttemptRow
      | undefined;
    return row ? rowToAttempt(row) : null;
  }

  private finish(input: FinishInput, apply: (row: AttemptRow, nowIso: string) => void): ClassificationAttempt {
    requireStringFields(input, ["attemptId", "executionId", "leaseId", "classifierSession", "reason"]);
    const txn = this.db.transaction(() => {
      this.leaseManager.requireActiveHolder(input.classifierSession, input.leaseId);
      const row = this.db.prepare(`SELECT * FROM classification_attempts WHERE attempt_id = ?`).get(input.attemptId) as
        | AttemptRow
        | undefined;
      if (!row) throw new ClassificationAttemptError("attempt_not_found", `未找到 attempt ${input.attemptId}`);
      if (row.execution_id !== input.executionId) {
        throw new ClassificationAttemptError("attempt_superseded", "本次执行已被该 attempt 的更新执行取代", {
          attemptId: row.attempt_id,
        });
      }
      if (row.status !== "in_flight" || row.lease_id !== input.leaseId) {
        throw new ClassificationAttemptError("attempt_mismatch", "attempt 并未在此租约下执行", {
          attemptId: row.attempt_id,
          status: row.status,
          attemptLeaseId: row.lease_id,
        });
      }
      apply(row, this.now().toISOString());
    });
    txn();
    return this.getByIdOrThrow(input.attemptId);
  }

  private backoffMs(attemptCount: number): number {
    return Math.min(this.baseBackoffMs * 2 ** Math.max(0, attemptCount - 1), this.maxBackoffMs);
  }

  private findRow(id: AttemptIdentity): AttemptRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM classification_attempts
          WHERE stream_item_id = ? AND classifier_version = ? AND taxonomy_version = ? AND evidence_epoch = ?`,
      )
      .get(id.streamItemId, id.classifierVersion, id.taxonomyVersion, id.evidenceEpoch) as AttemptRow | undefined;
  }

  private getByIdOrThrow(attemptId: string): ClassificationAttempt {
    const a = this.getById(attemptId);
    if (!a) throw new ClassificationAttemptError("attempt_not_found", `写入后未找到 attempt ${attemptId}`);
    return a;
  }
}

export interface FinishInput {
  attemptId: string;
  /** 启动本次执行的 begin() 所返回的 executionId。 */
  executionId: string;
  leaseId: string;
  classifierSession: string;
  reason: string;
}

/** 对代码消费的字符串字段做形状检查：存在、为字符串且非空白。 */
function requireStringFields(input: object, fields: readonly string[]): void {
  for (const field of fields) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new ClassificationAttemptError("invalid_field", `${field} 必须是非空字符串`, { field });
    }
  }
}

function requireIdentity(id: AttemptIdentity): void {
  for (const key of ["streamItemId", "classifierVersion", "taxonomyVersion", "evidenceEpoch"] as const) {
    if (typeof id[key] !== "string" || id[key].trim() === "") {
      throw new ClassificationAttemptError("invalid_attempt_identity", `${key} 为必填项`, { field: key });
    }
  }
}

function rowToAttempt(row: AttemptRow): ClassificationAttempt {
  return {
    attemptId: row.attempt_id,
    streamItemId: row.stream_item_id,
    classifierVersion: row.classifier_version,
    taxonomyVersion: row.taxonomy_version,
    evidenceEpoch: row.evidence_epoch,
    status: row.status as AttemptStatus,
    attemptCount: row.attempt_count,
    executionId: row.execution_id,
    leaseId: row.lease_id,
    classifierSession: row.classifier_session,
    retryAfter: row.retry_after,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
