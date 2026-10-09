import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { RigEvent, PersistedEvent } from "./types.js";

type Subscriber = (event: PersistedEvent) => void;

declare const notifyTokenBrand: unique symbol;
export type NotifyToken = PersistedEvent & { readonly [notifyTokenBrand]: true };
export type NotifyRegister = (token: PersistedEvent) => void;

export interface NotifyDrainStatus {
  state: "healthy" | "unparseable";
  watermark: number;
  lastPoison: { seq: number; error: string; payloadSha: string } | null;
}

export class NotifyEnvelopeError extends Error {
  readonly code: "notify_registration_mismatch" | "nested_notify_envelope";

  constructor(code: NotifyEnvelopeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface ActiveEnvelope {
  persisted: Set<PersistedEvent>;
  registered: Set<PersistedEvent>;
}

export class EventBus {
  private subscribers = new Set<Subscriber>();
  private activeEnvelope: ActiveEnvelope | null = null;
  private drainingNotifyRows = false;
  private notifyEnvelopeRuns = 0;
  private notifyDrainStatus: NotifyDrainStatus;
  readonly db: Database.Database;

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  constructor(db: Database.Database) {
    this.db = db;
    this.notifyDrainStatus = {
      state: "healthy",
      watermark: this.maxSeq(),
      lastPoison: null,
    };
  }

  /**
   * 持久化事件并通知订阅者。用于调用方管理的事务之外的独立 emit。
   */
  emit(event: RigEvent): PersistedEvent {
    const persisted = this.persistWithinTransaction(event);
    this.notifySubscribers(persisted);
    return persisted;
  }

  /**
   * 向 events 表插入事件行并返回 PersistedEvent。应在调用方管理的 db.transaction() 内调用，
   * 使事件插入与其他写入保持原子性（例如在一个事务中写 session + binding + event）。
   * 不通知订阅者。notify envelope 在提交后排空；旧版单事件调用方保留显式的提交后通知。
   */
  persistWithinTransaction(event: RigEvent): NotifyToken {
    const rigId = "rigId" in event ? (event as { rigId: string }).rigId : null;
    const nodeId = "nodeId" in event ? event.nodeId : null;

    const result = this.db
      .prepare(
        "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
      )
      .run(rigId, nodeId, event.type, JSON.stringify(event));

    const seq = Number(result.lastInsertRowid);

    const row = this.db
      .prepare("SELECT created_at FROM events WHERE seq = ?")
      .get(seq) as { created_at: string };

    const token = {
      ...event,
      seq,
      createdAt: row.created_at,
    } as NotifyToken;
    this.activeEnvelope?.persisted.add(token);
    return token;
  }

  /**
   * 将嵌套事务 writer 的精确 token 注册到调用方当前 notify envelope。envelope 外返回 false，
   * 使同一 writer 可为旧版提交后通知收集 token。
   */
  registerPersistedWithinActiveEnvelope(token: PersistedEvent): boolean {
    if (!this.activeEnvelope) return false;
    this.activeEnvelope.registered.add(token);
    return true;
  }

  /**
   * 在 W2b notification envelope 下运行一个由调用方拥有的同步事务。callback 期间经 EventBus
   * 持久化的每个 token 都必须在返回前注册。提交前比较精确的对象 identity 集合；随后从日志投递
   * 已提交的行。
   */
  withNotifyEnvelope<T>(callback: (register: NotifyRegister) => T): T {
    if (this.activeEnvelope) {
      throw new NotifyEnvelopeError(
        "nested_notify_envelope",
        "notify envelope 不能嵌套",
      );
    }

    const envelope: ActiveEnvelope = { persisted: new Set(), registered: new Set() };
    const register: NotifyRegister = (token) => {
      envelope.registered.add(token);
    };
    this.notifyEnvelopeRuns += 1;

    const txn = this.db.transaction(() => {
      this.activeEnvelope = envelope;
      try {
        const result = callback(register);
        if (!setsEqual(envelope.persisted, envelope.registered)) {
          throw new NotifyEnvelopeError(
            "notify_registration_mismatch",
            `notify envelope 持久化了 ${envelope.persisted.size} 个 token，但只注册了 ${envelope.registered.size} 个精确 token`,
          );
        }
        return result;
      } finally {
        this.activeEnvelope = null;
      }
    });

    const result = txn();
    this.drainNotifyRowsToQuiescence(this.notifyDrainStatus.watermark);
    return result;
  }

  getNotifyDrainStatus(): NotifyDrainStatus {
    return {
      ...this.notifyDrainStatus,
      lastPoison: this.notifyDrainStatus.lastPoison
        ? { ...this.notifyDrainStatus.lastPoison }
        : null,
    };
  }

  assertNotifyEnvelopeExercised(): void {
    if (this.notifyEnvelopeRuns === 0) {
      throw new Error("未检查任何 notify envelope 事务");
    }
  }

  /**
   * 将持久事件扇出给内存订阅者。不会插入数据库；订阅者错误彼此隔离。
   */
  notifySubscribers(event: PersistedEvent): void {
    const nestedRowsStartAfter = this.maxSeq();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (err) {
        console.error("EventBus 订阅者错误：", err);
      }
    }
    this.notifyDrainStatus.watermark = Math.max(this.notifyDrainStatus.watermark, event.seq);
    if (!this.drainingNotifyRows) {
      this.drainNotifyRowsToQuiescence(nestedRowsStartAfter);
    }
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  replaySince(seq: number, rigId: string): PersistedEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, rig_id, node_id, type, payload, created_at FROM events WHERE rig_id = ? AND seq > ? ORDER BY seq"
      )
      .all(rigId, seq) as EventRow[];

    return rows.map((row) => this.rowToPersistedEvent(row));
  }

  replayAll(seq: number): PersistedEvent[] {
    const rows = this.rowsAfter(seq);

    return rows.map((row) => this.rowToPersistedEvent(row));
  }

  private drainNotifyRowsToQuiescence(startAfter: number): void {
    if (this.drainingNotifyRows) return;
    this.drainingNotifyRows = true;
    let cursor = startAfter;
    try {
      for (;;) {
        const rows = this.rowsAfter(cursor);
        if (rows.length === 0) return;
        for (const row of rows) {
          let event: PersistedEvent;
          try {
            event = this.rowToPersistedEvent(row);
          } catch (caught) {
            const error = caught instanceof SyntaxError
              ? "事件 payload JSON 无效"
              : "事件 payload 结构无效";
            const payloadSha = createHash("sha256").update(row.payload).digest("hex");
            this.notifyDrainStatus = {
              state: "unparseable",
              watermark: row.seq,
              lastPoison: { seq: row.seq, error, payloadSha },
            };
            this.persistWithinTransaction({
              type: "event.delivery_poisoned",
              poisonedSeq: row.seq,
              error,
              payloadSha,
            });
            cursor = row.seq;
            continue;
          }
          this.notifySubscribers(event);
          cursor = row.seq;
        }
      }
    } finally {
      this.drainingNotifyRows = false;
    }
  }

  private maxSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  private rowsAfter(seq: number): EventRow[] {
    return this.db
      .prepare(
        "SELECT seq, rig_id, node_id, type, payload, created_at FROM events WHERE seq > ? ORDER BY seq",
      )
      .all(seq) as EventRow[];
  }

  private rowToPersistedEvent(row: EventRow): PersistedEvent {
    const parsed = JSON.parse(row.payload) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { type?: unknown }).type !== "string" ||
      (parsed as { type: string }).type.length === 0
    ) {
      throw new Error("事件 payload 结构无效");
    }
    const event = parsed as RigEvent;
    return {
      ...event,
      seq: row.seq,
      createdAt: row.created_at,
    };
  }
}

interface EventRow {
  seq: number;
  rig_id: string | null;
  node_id: string | null;
  type: string;
  payload: string;
  created_at: string;
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
