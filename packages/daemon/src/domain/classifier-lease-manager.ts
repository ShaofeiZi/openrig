import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";

/**
 * 分类器租约管理器（PL-004 Phase B）。
 *
 * 后台服务为 project（classifier）原语强制执行的单写者租约。
 * 依据 PRD § L2 硬规则与 slice IMPL 的 Guard Checkpoint Focus 条目 2：
 *
 * - 单写者：任何时刻最多只有一个 `state='active'` 的租约，由部分 UNIQUE 索引
 *   `idx_classifier_leases_active_singleton` 强制保证。
 * - 基于 TTL 过期：每个租约都有 `expires_at`（acquired_at + ttlMs）。
 * - 心跳：租约持有者更新 `last_heartbeat`；超过 TTL 的陈旧心跳表示已失活。
 * - 失活检测：`evaluateDeadness` 由 project 命令路径或看门狗调用。管理器本身不会
 *   自动回收，只在心跳陈旧时标记 `expired`。
 * - 回收只能由操作员命令执行：`zrig project --reclaim-classifier [--if-dead]`。
 *   后台服务不会自动回收。回收路径从前任持有者手中收回 active 租约，并发送
 *   classifier.reclaimed。
 *
 * 结构沿用 Phase A 的 hot-potato-enforcer.ts：纯校验加生命周期方法，不依赖 Hono。
 * 路由导入本模块，本模块不导入路由。
 */

export const LEASE_STATES = ["active", "expired", "reclaimed"] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

export interface ClassifierLease {
  leaseId: string;
  classifierSession: string;
  acquiredAt: string;
  expiresAt: string;
  lastHeartbeat: string;
  state: LeaseState;
  reclaimedBySession: string | null;
  reclaimReason: string | null;
}

interface ClassifierLeaseRow {
  lease_id: string;
  classifier_session: string;
  acquired_at: string;
  expires_at: string;
  last_heartbeat: string;
  state: string;
  reclaimed_by_session: string | null;
  reclaim_reason: string | null;
}

export class ClassifierLeaseError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

/**
 * 默认租约 TTL 为 15 分钟。PRD 只规定“基于 TTL”，具体值由实现选择。15 分钟在
 * 陈旧检测延迟（越长则失活信号越慢）与不必要心跳流量（越短则唤醒越多）之间取得
 * 对操作员友好的平衡。可通过构造参数配置，便于测试及后续调优。
 */
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

export interface ClassifierLeaseManagerOptions {
  ttlMs?: number;
  /** 供测试注入确定性时钟；默认为 `() => new Date()`。 */
  now?: () => Date;
  /**
   * 存活检查（依据 PRD，通过 whoami-service/node-inventory）。会话仍存活时返回
   * true。租约管理器评估失活时调用它；仅当函数返回 false 且租约心跳已陈旧时，
   * 才将租约标记为 expired。
   *
   * 默认为 `() => true`（不检查存活；测试可替换）。
   */
  isAlive?: (classifierSession: string) => boolean;
}

export class ClassifierLeaseManager {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private isAlive: (classifierSession: string) => boolean;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    opts?: ClassifierLeaseManagerOptions,
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.now = opts?.now ?? (() => new Date());
    this.isAlive = opts?.isAlive ?? (() => true);
  }

  /**
   * 在构造后接入存活检查（startup.ts 在依赖图后段构造 whoami-service 时使用）。
   */
  attachIsAlive(check: (classifierSession: string) => boolean): void {
    this.isAlive = check;
  }

  /**
   * 为分类器会话获取 active 租约。若其他仍存活的会话持有 active 租约，则以
   * `lease_held`（409）失败。若租约持有会话已失活，调用方应先调用
   * `evaluateDeadness` 将其标记过期，或使用操作员回收路径。
   *
   * 同一 classifier_session 在租约未过期时重复获取具有幂等性：再次调用 acquire
   * 会原样返回现有租约（心跳由 `heartbeat` 单独更新）。若持有者自己的租约超过
   * TTL，acquire 会使其过期并签发新租约 ID，使绑定旧租约 ID 的结果无法再写入（S02 P1）。
   */
  acquire(classifierSession: string): ClassifierLease {
    const active = this.getActiveLease();
    if (active) {
      if (active.classifierSession === classifierSession) {
        if (!this.isPastTtl(active)) {
    // 当前持有者重复获取时保持幂等。
          return active;
        }
        return this.replaceExpiredOwnLease(active);
      }
      throw new ClassifierLeaseError(
        "lease_held",
        `classifier lease is held by ${active.classifierSession} until ${active.expiresAt}; reclaim via 'rig project --reclaim-classifier' if needed`,
        { holder: active.classifierSession, expiresAt: active.expiresAt },
      );
    }

    const leaseId = ulid();
    const txn = this.db.transaction(() => this.insertActiveLease(leaseId, classifierSession));
    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return this.getByIdOrThrow(leaseId);
  }

  /** 原子地使调用方自己的超时租约过期，并签发新租约。 */
  private replaceExpiredOwnLease(active: ClassifierLease): ClassifierLease {
    const leaseId = ulid();
    const nowIso = this.now().toISOString();
    const txn = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE classifier_leases SET state = 'expired' WHERE lease_id = ? AND state = 'active'`)
        .run(active.leaseId);
      const expired = this.eventBus.persistWithinTransaction({
        type: "classifier.lease_expired",
        leaseId: active.leaseId,
        classifierSession: active.classifierSession,
        expiredAt: nowIso,
      });
      return [expired, this.insertActiveLease(leaseId, active.classifierSession)];
    });
    for (const e of txn()) this.eventBus.notifySubscribers(e);
    return this.getByIdOrThrow(leaseId);
  }

  private insertActiveLease(leaseId: string, classifierSession: string): PersistedEvent {
    const acquiredAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + this.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO classifier_leases (
          lease_id, classifier_session, acquired_at, expires_at,
          last_heartbeat, state
        ) VALUES (?, ?, ?, ?, ?, 'active')`
      )
      .run(leaseId, classifierSession, acquiredAt, expiresAt, acquiredAt);
    return this.eventBus.persistWithinTransaction({
      type: "classifier.lease_acquired",
      leaseId,
      classifierSession,
      acquiredAt,
      expiresAt,
    });
  }

  private isPastTtl(lease: ClassifierLease): boolean {
    return this.now().toISOString() > lease.expiresAt;
  }

  /**
   * 接收租约持有者心跳。更新 `last_heartbeat`，并按 TTL 延长 `expires_at`
   * （滑动窗口 TTL 语义）。
   */
  heartbeat(leaseId: string, classifierSession: string): ClassifierLease {
    const lease = this.getById(leaseId);
    if (!lease) {
      throw new ClassifierLeaseError("lease_not_found", `lease ${leaseId} not found`);
    }
    if (lease.classifierSession !== classifierSession) {
      throw new ClassifierLeaseError(
        "lease_session_mismatch",
        `lease ${leaseId} is held by ${lease.classifierSession}, not ${classifierSession}`,
      );
    }
    if (lease.state !== "active") {
      throw new ClassifierLeaseError(
        "lease_not_active",
        `lease ${leaseId} is in state ${lease.state}; cannot heartbeat`,
      );
    }
    // S02 P1：超过 TTL 的租约不能通过心跳复活。持有者必须重新获取，这会为其
    // 已过期租约签发新的租约 ID。
    if (this.isPastTtl(lease)) {
      throw new ClassifierLeaseError(
        "lease_expired",
        `lease ${leaseId} expired at ${lease.expiresAt}; acquire a new lease instead of heartbeating`,
        { expiresAt: lease.expiresAt },
      );
    }

    const now = this.now();
    const lastHeartbeat = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();

    this.db
      .prepare(
        `UPDATE classifier_leases
           SET last_heartbeat = ?, expires_at = ?
         WHERE lease_id = ?`
      )
      .run(lastHeartbeat, expiresAt, leaseId);

    return this.getByIdOrThrow(leaseId);
  }

  /**
   * 评估当前 active 租约是否失活。若租约心跳陈旧（now > expires_at），或 `isAlive`
   * 报告持有者已失活，则将租约标记过期并发送 classifier.lease_expired 与
   * classifier.dead。返回已过期租约；若没有 active 租约或它仍存活则返回 null。
   *
   * 调用方包括：project 命令路径（acquire 前清理失活租约）、看门狗（周期扫描）
   * 或操作员触发的检查。
   *
   * 按 PRD，本方法不执行回收，只标记过期。之后任何会话的下一次 `acquire` 都可
   * 成功，因为 state='active' 的部分 UNIQUE 索引此时为空。
   */
  evaluateDeadness(): ClassifierLease | null {
    const active = this.getActiveLease();
    if (!active) return null;
    const nowIso = this.now().toISOString();
    const ttlPassed = nowIso > active.expiresAt;
    const sessionDead = !this.isAlive(active.classifierSession);
    if (!ttlPassed && !sessionDead) return null;

    const events: PersistedEvent[] = [];
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE classifier_leases SET state = 'expired' WHERE lease_id = ? AND state = 'active'`,
        )
        .run(active.leaseId);

      events.push(this.eventBus.persistWithinTransaction({
        type: "classifier.lease_expired",
        leaseId: active.leaseId,
        classifierSession: active.classifierSession,
        expiredAt: nowIso,
      }));

      if (sessionDead) {
        events.push(this.eventBus.persistWithinTransaction({
          type: "classifier.dead",
          leaseId: active.leaseId,
          classifierSession: active.classifierSession,
          lastHeartbeat: active.lastHeartbeat,
          detectedAt: nowIso,
        }));
      }
    });

    txn();
    for (const e of events) this.eventBus.notifySubscribers(e);
    return this.getByIdOrThrow(active.leaseId);
  }

  /**
   * 操作人员动作 reclaim。按 PRD § L2 硬规则，只有此路径可从持有者手中收回活跃租约。
   * 后台服务不会自动收回。
   *
   * - 若 `ifDead`：仅当 isAlive(holder) 返回 false 时成功；持有者仍存活则以
   *   `lease_still_active` 拒绝。
   * - 若 `!ifDead`：无条件取得租约。
   *
   * 将 active 租约标记为 state='reclaimed'，记录 reclaimed_by_session 与
   * reclaim_reason，并发送 classifier.reclaimed；之后任何会话均可再次 acquire。
   */
  reclaim(byClassifierSession: string, opts?: { ifDead?: boolean; reason?: string }): ClassifierLease {
    const active = this.getActiveLease();
    if (!active) {
      throw new ClassifierLeaseError(
        "no_active_lease",
        "no active classifier lease to reclaim",
      );
    }
    if (opts?.ifDead === true && this.isAlive(active.classifierSession)) {
      throw new ClassifierLeaseError(
        "lease_still_active",
        `classifier lease holder ${active.classifierSession} is still alive; --if-dead refuses to reclaim`,
        { holder: active.classifierSession },
      );
    }
    const reason = opts?.reason ?? (opts?.ifDead ? "operator-reclaim --if-dead" : "operator-reclaim");
    const reclaimedAt = this.now().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE classifier_leases
             SET state = 'reclaimed',
                 reclaimed_by_session = ?,
                 reclaim_reason = ?
           WHERE lease_id = ? AND state = 'active'`,
        )
        .run(byClassifierSession, reason, active.leaseId);

      return this.eventBus.persistWithinTransaction({
        type: "classifier.reclaimed",
        leaseId: active.leaseId,
        previousClassifierSession: active.classifierSession,
        reclaimedBySession: byClassifierSession,
        reason,
        reclaimedAt,
      });
    });

    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return this.getByIdOrThrow(active.leaseId);
  }

  /**
   * project-classifier 使用的校验钩子：仅当传入会话持有 active 租约时返回该租约，
   * 否则抛出异常。它集中实现“执行 project 前必须持有租约”的检查。
   *
   * 传入 `leaseId`（S02 P1）时，调用方还必须持有该特定租约：即使同一会话持有新
   * 租约，在已被替换租约下计算的结果也会以 `lease_mismatch` 拒绝。本方法只读，
   * 可安全地在写事务内调用。
   */
  requireActiveHolder(classifierSession: string, leaseId?: string): ClassifierLease {
    const active = this.getActiveLease();
    if (!active) {
      throw new ClassifierLeaseError(
        "no_active_lease",
        "no active classifier lease; call acquire first",
      );
    }
    if (active.classifierSession !== classifierSession) {
      throw new ClassifierLeaseError(
        "lease_held",
        `classifier lease is held by ${active.classifierSession}, not ${classifierSession}`,
        { holder: active.classifierSession },
      );
    }
    if (active.expiresAt < this.now().toISOString()) {
      throw new ClassifierLeaseError(
        "lease_expired",
        `classifier lease for ${classifierSession} expired at ${active.expiresAt}`,
      );
    }
    if (leaseId !== undefined && active.leaseId !== leaseId) {
      throw new ClassifierLeaseError(
        "lease_mismatch",
        `result is bound to lease ${leaseId}, but the active lease for ${classifierSession} is ${active.leaseId}`,
        { activeLeaseId: active.leaseId, suppliedLeaseId: leaseId },
      );
    }
    return active;
  }

  getActiveLease(): ClassifierLease | null {
    const row = this.db
      .prepare(`SELECT * FROM classifier_leases WHERE state = 'active' LIMIT 1`)
      .get() as ClassifierLeaseRow | undefined;
    return row ? this.rowToLease(row) : null;
  }

  getById(leaseId: string): ClassifierLease | null {
    const row = this.db
      .prepare(`SELECT * FROM classifier_leases WHERE lease_id = ?`)
      .get(leaseId) as ClassifierLeaseRow | undefined;
    return row ? this.rowToLease(row) : null;
  }

  list(opts?: { classifierSession?: string; limit?: number }): ClassifierLease[] {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.classifierSession) {
      conditions.push("classifier_session = ?");
      params.push(opts.classifierSession);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM classifier_leases ${where} ORDER BY acquired_at DESC LIMIT ?`)
      .all(...params) as ClassifierLeaseRow[];
    return rows.map((r) => this.rowToLease(r));
  }

  private getByIdOrThrow(leaseId: string): ClassifierLease {
    const lease = this.getById(leaseId);
    if (!lease) {
      throw new ClassifierLeaseError("lease_not_found", `lease ${leaseId} not found after write`);
    }
    return lease;
  }

  private rowToLease(row: ClassifierLeaseRow): ClassifierLease {
    return {
      leaseId: row.lease_id,
      classifierSession: row.classifier_session,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
      lastHeartbeat: row.last_heartbeat,
      state: row.state as LeaseState,
      reclaimedBySession: row.reclaimed_by_session,
      reclaimReason: row.reclaim_reason,
    };
  }
}
