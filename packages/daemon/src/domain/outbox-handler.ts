import type Database from "better-sqlite3";

/**
 * 可执行的 wake-intent 命名空间。后台服务（QueueRepository.stageWakeIntent）使用此前缀下的 id
 * 写入持久唤醒意图，启动时的 drain 会把此前缀下的每个 pending 行作为真实唤醒执行。
 *
 * 这不是路由保留：公开的 `/outbox/record` 审计路由不再拒绝调用方提供的此前缀 id
 *（W4 时期的 MF5 守卫已取消；创始人裁定其理由需要在该信任域内存在攻击者，
 * 但唯一调用方是后台服务自己的 localhost 客户端，属于过度设计）。调用方现在可以记录
 * 此前缀下的 id，drain 会选中它。这里只作为 drain 查询的单一事实来源。
 */
export const WAKE_INTENT_PREFIX = "wake-intent-";

// W1（事务闭合）：`indeterminate` 表示含糊的投递结果——发送已上网，但无法确认渲染
//（transport res.ok && !verified）。它绝不静默提升为 `delivered`（尚未确认），
// 也不降级为 `failed`（消息可能已送达）；CAS 转换以 'pending' 为门槛，因此
// indeterminate 行在 CAS 语义下是终态（对账是范围外的后续工作，不是 W1 转换）。
// `sending`（MF3）是暂态 CLAIM：drainer 在外部发送前以原子方式把唤醒意图从
// pending→sending，使并发 drainer 找不到可认领行，避免重复发送。发送中崩溃会留下可见的
// `sending` 行；恢复边界（启动时运行一次的 `reconcileAbandonedSending`）
// 把它对账为 `indeterminate`，绝不盲目重发。
export const OUTBOX_DELIVERY_STATES = ["pending", "sending", "delivered", "failed", "indeterminate", "retained", "retired"] as const;
export type OutboxDeliveryState = (typeof OUTBOX_DELIVERY_STATES)[number];

/**
 * 在把原始 `delivery_state` 单元格键入为 {@link OutboxDeliveryState} 前，先按闭合联合校验。
 * 这取代此前未经检查的 `as` 强转：类型断言永不失败，因此游离的数据库值（数据损坏，
 * 或旧后台服务读取了新后台服务写入的状态）会静默伪装成类型成员，使所有下游收窄失效。
 * 所有写入方都受我们控制，因此未知值是真实缺陷；应明确失败，不能伪造类型。
 */
export function parseDeliveryState(raw: string): OutboxDeliveryState {
  if ((OUTBOX_DELIVERY_STATES as readonly string[]).includes(raw)) {
    return raw as OutboxDeliveryState;
  }
  throw new OutboxHandlerError(
    "invalid_delivery_state",
    `outbox row has unknown delivery_state ${JSON.stringify(raw)} (expected one of ${OUTBOX_DELIVERY_STATES.join(", ")})`,
  );
}

export interface OutboxEntry {
  outboxId: string;
  senderSession: string;
  destinationSession: string;
  body: string;
  tags: string[] | null;
  urgency: string;
  tsDispatched: string;
  deliveryState: OutboxDeliveryState;
  deliveredAt: string | null;
  auditPointer: string | null;
  guardBinding?: { nodeId: string; session: string; occupant: string | null; pane: string | null } | null;
  retiredAt?: string | null;
  retiredBy?: string | null;
  retirementReason?: string | null;
}

interface OutboxEntryRow {
  outbox_id: string;
  sender_session: string;
  destination_session: string;
  body: string;
  tags: string | null;
  urgency: string;
  ts_dispatched: string;
  delivery_state: string;
  delivered_at: string | null;
  audit_pointer: string | null;
  guard_binding?: string | null;
  retired_at?: string | null;
  retired_by?: string | null;
  retirement_reason?: string | null;
}

export interface OutboxRecordInput {
  outboxId?: string;
  senderSession: string;
  destinationSession: string;
  body: string;
  tags?: string[];
  urgency?: string;
  auditPointer?: string;
  /** P21 §4 era-stamp：路由传入 `transport:v1`（senderSession 从 transport header 检查点派生）。
   * 写入 outbox 行；缺失表示 claimed-era。 */
  identityProvenance?: string | null;
}

export class OutboxHandlerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function newOutboxId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `outbox-${ts}-${hex}`;
}

/**
 * 发送方 outbox，与 InboxHandler 对称。独立于接收方行为记录发送方已派发的内容，
 * 按 outbox_id 幂等。
 *
 * 阶段 A 不发出 event-bus 事件，outbox 仅用于审计。若后续阶段需要投递跟踪事件，
 * 应通过此表面添加。
 */
export class OutboxHandler {
  readonly db: Database.Database;
  /** P21 §4：只检测一次。精选迁移测试数据库（或 067 之前的后台服务）可能没有 era-stamp 列，
   * 因此写入方选择降级（省略该列）而非抛错。 */
  private readonly hasIdentityProvenanceColumn: boolean;

  constructor(db: Database.Database) {
    this.db = db;
    this.hasIdentityProvenanceColumn = (
      this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>
    ).some((col) => col.name === "identity_provenance");
  }

  record(input: OutboxRecordInput): OutboxEntry {
    const id = input.outboxId ?? newOutboxId();
    const existing = this.getByIdRaw(id);
    if (existing) return this.rowToEntry(existing);

    const ts = new Date().toISOString();
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const urgency = input.urgency ?? "routine";

    if (this.hasIdentityProvenanceColumn) {
      this.db
        .prepare(
          `INSERT INTO outbox_entries (
            outbox_id, sender_session, destination_session, body, tags, urgency, ts_dispatched, audit_pointer, identity_provenance
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.senderSession,
          input.destinationSession,
          input.body,
          tags,
          urgency,
          ts,
          input.auditPointer ?? null,
          input.identityProvenance ?? null
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO outbox_entries (
            outbox_id, sender_session, destination_session, body, tags, urgency, ts_dispatched, audit_pointer
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.senderSession,
          input.destinationSession,
          input.body,
          tags,
          urgency,
          ts,
          input.auditPointer ?? null
        );
    }

    return this.getByIdOrThrow(id);
  }

  /** 保留流程复用现有 outbox ID。即使 guard 在暂存后才激活且配额现已耗尽，
   * 已提交的唤醒仍保留每个成员。 */
  retain(input: OutboxRecordInput & { outboxId: string }, binding: NonNullable<OutboxEntry["guardBinding"]>, precommitted = false): OutboxEntry {
    return this.db.transaction(() => {
      const existing = this.getById(input.outboxId);
      if (existing) {
        if (existing.senderSession !== input.senderSession || existing.destinationSession !== input.destinationSession || existing.body !== input.body ||
            (existing.guardBinding && JSON.stringify(existing.guardBinding) !== JSON.stringify(binding))) {
          throw new OutboxHandlerError("delivery_identity_conflict", "The delivery ID already names different content or target identity.");
        }
        if (existing.deliveryState === "retained" || existing.deliveryState === "retired") return existing;
        if (existing.deliveryState !== "pending" && existing.deliveryState !== "sending") {
          throw new OutboxHandlerError("delivery_already_attempted", "This delivery already has a terminal outcome; it cannot be retained or retried.");
        }
      } else if (precommitted) {
        throw new OutboxHandlerError("outbox_not_found", "Precommitted delivery is missing; no replacement custody is created.");
      }
      if (!precommitted) this.assertRetentionCapacity(binding.nodeId, input.body);
      if (!existing) this.record(input);
      this.db.prepare(`UPDATE outbox_entries SET delivery_state='retained', guard_binding=?, delivered_at=NULL
        WHERE outbox_id=? AND delivery_state IN ('pending','sending')`)
        .run(JSON.stringify(binding), input.outboxId);
      return this.getByIdOrThrow(input.outboxId);
    })();
  }

  assertRetentionCapacity(nodeId: string, body: string): void {
    // 临时的有界默认值。不会为了满足活跃配额而驱逐历史/已退役行或已提交的溢出项。
    const usage = this.db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes
      FROM outbox_entries WHERE delivery_state='retained' AND json_extract(guard_binding,'$.nodeId')=?`)
      .get(nodeId) as { count: number; bytes: number };
    const size = Buffer.byteLength(body, "utf8");
    if (size > 1024 * 1024 || usage.count >= 100 || usage.bytes + size > 8 * 1024 * 1024) {
      throw new OutboxHandlerError("retained_quota_full", "Held-message quota is full. Retire a specific held message to release active quota; no input was written.");
    }
  }

  retire(outboxId: string, actor: string, reason: string): OutboxEntry {
    if (!actor.trim() || !reason.trim()) throw new OutboxHandlerError("retirement_reason_required", "Actor and reason are required.");
    const entry = this.getByIdOrThrow(outboxId);
    if (entry.deliveryState === "retired") return entry;
    if (entry.deliveryState !== "retained") throw new OutboxHandlerError("delivery_not_retained", "Only retained messages can be retired.");
    this.db.prepare(`UPDATE outbox_entries SET delivery_state='retired', retired_at=?, retired_by=?, retirement_reason=?
      WHERE outbox_id=? AND delivery_state='retained'`).run(new Date().toISOString(), actor, reason, outboxId);
    return this.getByIdOrThrow(outboxId);
  }

  heldForNode(nodeId: string, limit = 100, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      throw new OutboxHandlerError("invalid_pagination", "Use limit 1–1000 and a nonnegative offset.");
    }
    const total = (this.db.prepare(`SELECT count(*) AS n FROM outbox_entries
      WHERE delivery_state='retained' AND json_extract(guard_binding,'$.nodeId')=?`).get(nodeId) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM outbox_entries
      WHERE delivery_state='retained' AND json_extract(guard_binding,'$.nodeId')=? ORDER BY ts_dispatched,outbox_id LIMIT ? OFFSET ?`)
      .all(nodeId, limit, offset) as OutboxEntryRow[];
    return { items: rows.map(r => this.rowToEntry(r)), total, limit, offset, truncated: offset + rows.length < total };
  }

  markDelivered(outboxId: string): OutboxEntry {
    const ts = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'delivered', delivered_at = ?
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(ts, outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  markFailed(outboxId: string): OutboxEntry {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'failed'
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  /**
   * W1（事务闭合）：记录含糊的投递结果——发送已经到达，但无法确认渲染
   *（transport res.ok && !verified）。它与 markFailed/markDelivered 使用相同的比较交换结构
   *（以 'pending' 为守卫），因此具备幂等性，绝不覆盖已经解决的行。indeterminate 行在 CAS
   * 语义下是终态：drain 既不会静默把它提升为 delivered，也不会降级为 failed。
   */
  markIndeterminate(outboxId: string): OutboxEntry {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'indeterminate'
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  /**
   * MF3：在外部发送前，以原子方式认领 pending 唤醒意图（pending→sending）。
   * 当且仅当当前调用方赢得认领时返回 true。并发 drainer 再认领时会发现行已不再是
   * `pending` 并返回 false，因此只有一个调用方执行外部发送。
   */
  claimForDelivery(outboxId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries SET delivery_state = 'sending'
          WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(outboxId);
    return result.changes === 1;
  }

  /**
   * MF3：外部发送得到结果后，完成已认领唤醒意图
   *（sending→delivered|indeterminate|failed）。CAS 以 `sending` 为守卫，
   * 因而只会完成当前 drainer 已认领的行；仅确认投递时才盖印 `delivered_at`。
   */
  finalizeDelivery(outboxId: string, state: "delivered" | "indeterminate" | "failed" | "retained"): OutboxEntry {
    const deliveredAt = state === "delivered" ? new Date().toISOString() : null;
    const result = this.db
      .prepare(
        `UPDATE outbox_entries SET delivery_state = ?, delivered_at = ?
          WHERE outbox_id = ? AND delivery_state = 'sending'`
      )
      .run(state, deliveredAt, outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  getById(outboxId: string): OutboxEntry | null {
    const row = this.getByIdRaw(outboxId);
    return row ? this.rowToEntry(row) : null;
  }

  listForSender(senderSession: string, limit = 100): OutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_entries WHERE sender_session = ? ORDER BY ts_dispatched DESC, rowid DESC LIMIT ?`
      )
      .all(senderSession, limit) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * W1（事务闭合）：按从旧到新的顺序列出 outbox_id 以 `idPrefix` 开头、
   * 且仍为 `pending` 的行。drain 用它恢复崩溃后已提交但未投递的意图。
   * `idPrefix` 是可信的编译期常量（如 "wake-intent-"），不含 LIKE 通配符。
   * 从旧到新并配合有界 `limit`，使调用方可分页，并在返回不足一批时结束，绝不静默截断。
   */
  listPending(idPrefix: string, limit = 200): OutboxEntry[] {
    // 前缀严格区分大小写。SQLite 的 `LIKE` 默认不区分大小写，因此
    // `LIKE 'wake-intent-%'` 也会执行 `WAKE-INTENT-…` 变体。
    // `substr(...) = ?` 使用区分大小写的二进制排序规则，因此只有一种拼写可执行。
    // 路由侧前缀拒绝已取消，这种窄匹配是阻止已记录大小写变体进入可执行 drain 的唯一措施；
    // 一旦放宽，变体也会变为可执行。
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_entries
          WHERE delivery_state = 'pending' AND substr(outbox_id, 1, ?) = ?
          ORDER BY ts_dispatched ASC, rowid ASC LIMIT ?`
      )
      .all(idPrefix.length, idPrefix, limit) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * BLOCKING 1（guard 重新封存）：在进程/恢复边界，以原子方式把废弃认领——崩溃进程
   * 留在暂态 `sending` 的行——对账为 `indeterminate`，且不重新发送。
   * `sending` 行具有歧义（外部发送可能在认领后送达，也可能没有），因此记录为
   * `indeterminate`，既不让认领永远停留在暂态，也不盲目重发。前缀严格区分大小写，
   * 与可执行选择器一致。返回已对账数量。
   */
  reconcileAbandonedSending(idPrefix: string): number {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries SET delivery_state = 'indeterminate'
          WHERE delivery_state = 'sending' AND substr(outbox_id, 1, ?) = ?`
      )
      .run(idPrefix.length, idPrefix);
    return result.changes;
  }

  private getByIdRaw(outboxId: string): OutboxEntryRow | undefined {
    return this.db
      .prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as OutboxEntryRow | undefined;
  }

  private getByIdOrThrow(outboxId: string): OutboxEntry {
    const entry = this.getById(outboxId);
    if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found after write`);
    return entry;
  }

  private rowToEntry(row: OutboxEntryRow): OutboxEntry {
    return {
      outboxId: row.outbox_id,
      senderSession: row.sender_session,
      destinationSession: row.destination_session,
      body: row.body,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      urgency: row.urgency,
      tsDispatched: row.ts_dispatched,
      deliveryState: parseDeliveryState(row.delivery_state),
      deliveredAt: row.delivered_at,
      auditPointer: row.audit_pointer,
      ...(row.guard_binding !== undefined ? {
        guardBinding: row.guard_binding ? JSON.parse(row.guard_binding) : null,
        retiredAt: row.retired_at ?? null,
        retiredBy: row.retired_by ?? null,
        retirementReason: row.retirement_reason ?? null,
      } : {}),
    };
  }
}
