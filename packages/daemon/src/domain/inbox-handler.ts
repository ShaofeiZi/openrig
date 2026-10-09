import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import { QueueRepository } from "./queue-repository.js";

export const INBOX_STATES = ["pending", "absorbed", "denied"] as const;
export type InboxState = (typeof INBOX_STATES)[number];

export interface InboxEntry {
  inboxId: string;
  destinationSession: string;
  senderSession: string;
  body: string;
  tags: string[] | null;
  urgency: string;
  tsDropped: string;
  state: InboxState;
  absorbedAt: string | null;
  absorbedQitemId: string | null;
  deniedAt: string | null;
  deniedReason: string | null;
  auditPointer: string | null;
}

interface InboxEntryRow {
  inbox_id: string;
  destination_session: string;
  sender_session: string;
  body: string;
  tags: string | null;
  urgency: string;
  ts_dropped: string;
  state: string;
  absorbed_at: string | null;
  absorbed_qitem_id: string | null;
  denied_at: string | null;
  denied_reason: string | null;
  audit_pointer: string | null;
}

export interface InboxDropInput {
  inboxId?: string;
  destinationSession: string;
  senderSession: string;
  body: string;
  tags?: string[];
  urgency?: string;
  auditPointer?: string;
  /** P21 §4 纪元戳：路由传入 `transport:v1`（senderSession 来自传输 header 瓶颈点）。
   * 写入记录通道行；缺失表示 claimed 纪元。 */
  identityProvenance?: string | null;
}

export class InboxHandlerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function newInboxId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `inbox-${ts}-${hex}`;
}

/**
 * Inbox 邮箱处理器。投递后即离开；接收方选择 absorb（提升为 queue_item）或 deny（记录原因）。
 *
 * P18 发送方溯源：`input.senderSession` 具有权威性，必须是调用方路由提供的传输派生身份
 *（/inbox/drop 路由从 X-OpenRig-Session header 派生，缺失时拒绝）。本处理器不再携带可插拔的
 * `authenticate` 谓词或 `authenticatedSender` 参数；此前“默认全部允许 + body 转发 principal”
 * 构成了虚假授权表面（P18）。身份验证现在只存在于唯一传输瓶颈点，不再隐藏在此处可被重新引入的
 * body claim 回退之后。
 */
export class InboxHandler {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly queueRepo: QueueRepository;
  /** P21 §4：只检测一次。精选 migration 的测试 DB（或 067 之前的后台服务）可能缺少纪元戳列，
   * 因此 writer 会降级为省略该列，而不是抛错。 */
  private readonly hasIdentityProvenanceColumn: boolean;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    queueRepo: QueueRepository,
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.queueRepo = queueRepo;
    this.hasIdentityProvenanceColumn = (
      this.db.prepare("PRAGMA table_info(inbox_entries)").all() as Array<{ name: string }>
    ).some((col) => col.name === "identity_provenance");
  }

  drop(input: InboxDropInput): InboxEntry {

    const id = input.inboxId ?? newInboxId();
    const existing = this.getByIdRaw(id);
    if (existing) return this.rowToEntry(existing);

    const ts = new Date().toISOString();
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const urgency = input.urgency ?? "routine";

    if (this.hasIdentityProvenanceColumn) {
      this.db
        .prepare(
          `INSERT INTO inbox_entries (
            inbox_id, destination_session, sender_session, body, tags, urgency, ts_dropped, audit_pointer, identity_provenance
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.destinationSession,
          input.senderSession,
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
          `INSERT INTO inbox_entries (
            inbox_id, destination_session, sender_session, body, tags, urgency, ts_dropped, audit_pointer
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.destinationSession,
          input.senderSession,
          input.body,
          tags,
          urgency,
          ts,
          input.auditPointer ?? null
        );
    }

    return this.getByIdOrThrow(id);
  }

  /**
   * 接收方把 pending inbox 条目吸收到其主队列。
   * 按 inbox_id 幂等：若已吸收，则返回既有 `absorbed_qitem_id`，不创建重复项。
   */
  async absorb(inboxId: string, receiverSession: string, identityProvenance?: string | null): Promise<{ entry: InboxEntry; qitemId: string }> {
    const entry = this.getById(inboxId);
    if (!entry) {
      throw new InboxHandlerError("inbox_not_found", `未找到 inbox ${inboxId}`);
    }
    if (entry.destinationSession !== receiverSession) {
      throw new InboxHandlerError(
        "absorb_destination_mismatch",
        `inbox ${inboxId} 的目标是 ${entry.destinationSession}，不是 ${receiverSession}`
      );
    }
    if (entry.state === "absorbed") {
      return { entry, qitemId: entry.absorbedQitemId! };
    }
    if (entry.state === "denied") {
      throw new InboxHandlerError(
        "inbox_already_denied",
        `inbox ${inboxId} 已被拒绝，无法吸收`
      );
    }

    // Inbox absorb 会抑制队列创建时的默认 nudge：inbox 表面已经完成自身投递（原始 drop），
    // absorb 时再次 nudge 会重复；目标方已经知道条目被吸收。
    const qitem = await this.queueRepo.create({
      sourceSession: entry.senderSession,
      destinationSession: entry.destinationSession,
      body: entry.body,
      tags: entry.tags ?? undefined,
      priority: entry.urgency === "critical" ? "critical" : entry.urgency === "urgent" ? "urgent" : "routine",
      nudge: false,
      identityProvenance: identityProvenance ?? null, // P21 §4 纪元戳：传输派生的接收方动作。
    });

    const ts = new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE inbox_entries
             SET state = 'absorbed', absorbed_at = ?, absorbed_qitem_id = ?
           WHERE inbox_id = ?`
        )
        .run(ts, qitem.qitemId, inboxId);

      return this.eventBus.persistWithinTransaction({
        type: "inbox.absorbed",
        inboxId,
        destinationSession: entry.destinationSession,
        senderSession: entry.senderSession,
        promotedQitemId: qitem.qitemId,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);

    return { entry: this.getByIdOrThrow(inboxId), qitemId: qitem.qitemId };
  }

  deny(inboxId: string, receiverSession: string, reason: string): InboxEntry {
    const entry = this.getById(inboxId);
    if (!entry) {
      throw new InboxHandlerError("inbox_not_found", `未找到 inbox ${inboxId}`);
    }
    if (entry.destinationSession !== receiverSession) {
      throw new InboxHandlerError(
        "deny_destination_mismatch",
        `inbox ${inboxId} 的目标是 ${entry.destinationSession}，不是 ${receiverSession}`
      );
    }
    if (entry.state !== "pending") {
      throw new InboxHandlerError(
        "inbox_not_pending",
        `inbox ${inboxId} 当前状态为 ${entry.state}；只有 pending 条目可以拒绝`
      );
    }
    const ts = new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE inbox_entries
             SET state = 'denied', denied_at = ?, denied_reason = ?
           WHERE inbox_id = ?`
        )
        .run(ts, reason, inboxId);

      return this.eventBus.persistWithinTransaction({
        type: "inbox.denied",
        inboxId,
        destinationSession: entry.destinationSession,
        senderSession: entry.senderSession,
        reason,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);

    return this.getByIdOrThrow(inboxId);
  }

  getById(inboxId: string): InboxEntry | null {
    const row = this.getByIdRaw(inboxId);
    return row ? this.rowToEntry(row) : null;
  }

  listPending(destinationSession: string): InboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox_entries
          WHERE destination_session = ? AND state = 'pending'
          ORDER BY ts_dropped ASC`
      )
      .all(destinationSession) as InboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  listForDestination(destinationSession: string, limit = 100): InboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox_entries WHERE destination_session = ? ORDER BY ts_dropped DESC, rowid DESC LIMIT ?`
      )
      .all(destinationSession, limit) as InboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  private getByIdRaw(inboxId: string): InboxEntryRow | undefined {
    return this.db
      .prepare("SELECT * FROM inbox_entries WHERE inbox_id = ?")
      .get(inboxId) as InboxEntryRow | undefined;
  }

  private getByIdOrThrow(inboxId: string): InboxEntry {
    const entry = this.getById(inboxId);
    if (!entry) throw new InboxHandlerError("inbox_not_found", `写入后未找到 inbox ${inboxId}`);
    return entry;
  }

  private rowToEntry(row: InboxEntryRow): InboxEntry {
    return {
      inboxId: row.inbox_id,
      destinationSession: row.destination_session,
      senderSession: row.sender_session,
      body: row.body,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      urgency: row.urgency,
      tsDropped: row.ts_dropped,
      state: row.state as InboxState,
      absorbedAt: row.absorbed_at,
      absorbedQitemId: row.absorbed_qitem_id,
      deniedAt: row.denied_at,
      deniedReason: row.denied_reason,
      auditPointer: row.audit_pointer,
    };
  }
}
