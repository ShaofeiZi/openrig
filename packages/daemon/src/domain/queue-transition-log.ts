import type Database from "better-sqlite3";
import type { ClosureReason } from "./hot-potato-enforcer.js";
import { archiveWhereClause } from "./rig-repository.js";
import { isHumanSeatSessionRef, parseSessionName } from "./session-name.js";

export const OWNER_NOTIFICATION_LEVELS = ["RECORD", "NOTICE", "ALERT"] as const;
export type OwnerNotificationLevel = (typeof OWNER_NOTIFICATION_LEVELS)[number];

export function ownerNotificationLevelAtLeast(
  level: OwnerNotificationLevel,
  minimum: OwnerNotificationLevel,
): boolean {
  return OWNER_NOTIFICATION_LEVELS.indexOf(level) >= OWNER_NOTIFICATION_LEVELS.indexOf(minimum);
}

export interface QueueTransition {
  transitionId: number;
  qitemId: string;
  ts: string;
  state: string;
  transitionNote: string | null;
  actorSession: string;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
  /** P21 第 4 节时代戳：actorSession 的建立方式。`transport:v1` 表示从 transport 窄口派生；
   *  null/缺失表示 claimed 时代（验证前），绝不重新标记。 */
  identityProvenance: string | null;
  ownerNotificationKind: string | null;
  ownerNotificationLevel: OwnerNotificationLevel;
}

export interface QueueTransitionInput {
  qitemId: string;
  state: string;
  actorSession: string;
  transitionNote?: string;
  closureReason?: ClosureReason;
  closureTarget?: string;
  /** P21 第 4 节时代戳：actorSession 来自 transport header 窄口时，路由传入 `transport:v1`；
   *  system/claimed 时代迁移省略为 null——缺失本身就是标记。 */
  identityProvenance?: string | null;
  ownerNotificationKind?: string | null;
  ownerNotificationLevel?: OwnerNotificationLevel | null;
}

export type RecentQueueTransitionTargetKind = "qitem" | "slice" | "mission";
export type RecentQueueTransitionScope = { kind: "instance" } | { kind: "rig"; rig: string };

/** 仅从类型化队列状态与 closure 字段派生的紧凑产品事件。人工编写的队列 summary
 *  只用于展示，绝不参与事件归一化。transition_note 与 body 保持排除，
 *  防止自然语言静默变成事件语义。 */
export interface RecentQueueTransition {
  transitionId: number;
  qitemId: string;
  ts: string;
  actorSession: string;
  change: string;
  summary: string | null;
  rig: string;
  targetKind: RecentQueueTransitionTargetKind;
  target: string;
}

interface QueueTransitionRow {
  transition_id: number;
  qitem_id: string;
  ts: string;
  state: string;
  transition_note: string | null;
  actor_session: string;
  closure_reason: string | null;
  closure_target: string | null;
  identity_provenance?: string | null;
  owner_notification_kind?: string | null;
  owner_notification_level?: string | null;
}

interface RecentQueueTransitionRow {
  transition_id: number;
  qitem_id: string;
  ts: string;
  state: string;
  actor_session: string;
  closure_reason: string | null;
  closure_target: string | null;
  tags: string | null;
  summary: string | null;
  previous_state: string | null;
  destination_session: string;
  source_session: string;
}

function sessionRig(session: string, knownRigs: ReadonlySet<string>): string | null {
  if (isHumanSeatSessionRef(session)) return null;
  const parsed = parseSessionName(session);
  return parsed.kind === "canonical" && knownRigs.has(parsed.rig) ? parsed.rig : null;
}

function recentTarget(row: RecentQueueTransitionRow): Pick<RecentQueueTransition, "targetKind" | "target"> {
  let tags: string[] = [];
  try {
    const parsed = row.tags ? JSON.parse(row.tags) : [];
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    // 无效旧版 tag 字段不能把自然语言变成目标；保留 qitem 身份。
  }
  const slice = tags.find((tag) => tag.startsWith("slice:"))?.slice("slice:".length).trim();
  if (slice) return { targetKind: "slice", target: slice };
  const mission = tags.find((tag) => tag.startsWith("mission:"))?.slice("mission:".length).trim();
  if (mission) return { targetKind: "mission", target: mission };
  return { targetKind: "qitem", target: row.qitem_id };
}

function recentChange(row: RecentQueueTransitionRow): string | null {
  if (row.closure_reason === "handed_off_to") {
    return row.closure_target ? `handed off to ${row.closure_target}` : "handed off";
  }
  if (["failed", "denied", "canceled"].includes(row.state)) return row.state;
  if (["denied", "canceled", "escalation"].includes(row.closure_reason ?? "")) return row.closure_reason;
  if (row.state === "done" && row.closure_reason === "no-follow-on") return "completed";
  if (row.state === "in-progress" && row.previous_state === "blocked") return "resumed";
  if (row.state === "in-progress" && row.previous_state === "pending") return "claimed";
  if (row.state === "blocked" && row.previous_state != null && row.previous_state !== "blocked") {
    return row.closure_target ? `blocked on ${row.closure_target}` : "blocked";
  }
  return null;
}

/**
 * 只追加的迁移日志。领域代码绝不能更新或删除这里的行。
 * 此日志是队列状态演进的权威审计轨迹。
 */
export class QueueTransitionLog {
  readonly db: Database.Database;
  /** P21 第 4 节：只检测一次——人工整理迁移的测试数据库（或 067 前后台服务）
   *  可能缺少时代戳列，因此写入器会降级为省略该列，而不是抛错。 */
  private readonly hasIdentityProvenanceColumn: boolean;
  private readonly hasOwnerNotificationColumns: boolean;
  private readonly historySource: string;

  constructor(db: Database.Database) {
    this.db = db;
    this.hasIdentityProvenanceColumn = (
      this.db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>
    ).some((c) => c.name === "identity_provenance");
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    this.hasOwnerNotificationColumns = columns.has("owner_notification_kind") && columns.has("owner_notification_level");
    // 所有历史读取方（包括旧可空 schema）共用一个显式投影。SELECT * 无法将归档表
    // 额外的 archived_at 列与实时表做 union。
    const fields = ["transition_id", "qitem_id", "ts", "state", "transition_note", "actor_session",
      "closure_reason", "closure_target", "identity_provenance", "owner_notification_kind", "owner_notification_level"];
    const sources = ["queue_transitions", "queue_transitions_archive"].flatMap((table) => {
      const available = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
      if (available.size === 0) return [];
      return [`SELECT ${fields.map((field) => available.has(field) ? field : `NULL AS ${field}`).join(", ")} FROM ${table}`];
    });
    this.historySource = `(${sources.join(" UNION ALL ")})`;

  }

  /**
   * 追加一次迁移。设计为在调用方管理的外层 `db.transaction()` 内调用，
   * 使迁移行与产生它的 queue_items UPDATE 保持原子。
   */
  append(input: QueueTransitionInput): QueueTransition {
    const ts = new Date().toISOString();
    const columns = ["qitem_id", "ts", "state", "transition_note", "actor_session", "closure_reason", "closure_target"];
    const values: unknown[] = [
      input.qitemId,
      ts,
      input.state,
      input.transitionNote ?? null,
      input.actorSession,
      input.closureReason ?? null,
      input.closureTarget ?? null,
    ];
    if (this.hasIdentityProvenanceColumn) {
      columns.push("identity_provenance");
      values.push(input.identityProvenance ?? null);
    }
    if (this.hasOwnerNotificationColumns) {
      columns.push("owner_notification_kind", "owner_notification_level");
      values.push(input.ownerNotificationKind ?? null, input.ownerNotificationLevel ?? null);
    }
    const result = this.db
      .prepare(`INSERT INTO queue_transitions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...values);

    const row = this.db
      .prepare("SELECT * FROM queue_transitions WHERE transition_id = ?")
      .get(Number(result.lastInsertRowid)) as QueueTransitionRow;

    return this.rowToTransition(row);
  }

  listForQitem(qitemId: string): QueueTransition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.historySource} WHERE qitem_id = ? ORDER BY transition_id ASC`
      )
      .all(qitemId) as QueueTransitionRow[];
    return rows.map((r) => this.rowToTransition(r));
  }

  /** 有界来源适配器：物化行之前先应用时间窗口和数量限制。 */
  listForQitemWindow(qitemId: string, startedAt: string, endedAt: string, limit: number): QueueTransition[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10001) throw new Error("迁移窗口限制无效");
    const start = new Date(startedAt).toISOString();
    const end = new Date(endedAt).toISOString();
    const rows = this.db.prepare(`SELECT * FROM ${this.historySource} WHERE qitem_id = ? AND ts >= ? AND ts <= ? ORDER BY transition_id ASC LIMIT ?`)
      .all(qitemId, start, end, limit) as QueueTransitionRow[];
    return rows.map((row) => this.rowToTransition(row));
  }

  /** 只跟随已声明 handoff。物化迁移前先限制 family；环通过 UNION 收敛，溢出时显式拒绝。 */
  listForHandoffWindow(qitemId: string, startedAt: string, endedAt: string, limit: number): QueueTransition[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10001) throw new Error("迁移窗口限制无效");
    const start = new Date(startedAt).toISOString();
    const end = new Date(endedAt).toISOString();
    const family = this.db.prepare(`WITH RECURSIVE lineage(id) AS (
      SELECT ? UNION SELECT q.qitem_id FROM queue_items q JOIN lineage l ON q.handed_off_from = l.id
      WHERE q.ts_created <= ? LIMIT 1001
    ) SELECT id FROM lineage`).all(qitemId, end) as Array<{ id: string }>;
    if (family.length > 1000) throw new Error("health_checkpoint_lineage_limit");
    const rows = this.db.prepare(`SELECT * FROM ${this.historySource}
      WHERE qitem_id IN (${family.map(() => "?").join(",")}) AND ts >= ? AND ts <= ?
      ORDER BY transition_id ASC LIMIT ?`).all(...family.map((r) => r.id), start, end, limit) as QueueTransitionRow[];
    return rows.map((row) => this.rowToTransition(row));
  }

  listForActor(actorSession: string, limit = 100): QueueTransition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.historySource} WHERE actor_session = ? ORDER BY transition_id DESC LIMIT ?`
      )
      .all(actorSession, limit) as QueueTransitionRow[];
    return rows.map((r) => this.rowToTransition(r));
  }

  /** 一个拓扑作用域内最新的高信号迁移，按时间顺序返回，最新在末尾。窗口函数先观察
   *  每个 qitem 的完整状态序列，再应用 allowlist，因此只写 note 的同状态写入不能冒充
   *  claim、resume 或 block。 */
  listRecent(scope: RecentQueueTransitionScope, requestedLimit = 20): RecentQueueTransition[] {
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(20, Math.max(1, Math.floor(requestedLimit)))
      : 20;
    const activeRigWhere = archiveWhereClause("archived_at");
    const rigNames = scope.kind === "rig"
      ? [scope.rig]
      : (this.db.prepare(`SELECT name FROM rigs${activeRigWhere ? ` WHERE ${activeRigWhere}` : ""} ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
    if (rigNames.length === 0) return [];
    const knownRigs = new Set(rigNames);
    const sessionPatterns = rigNames.map((rig) => `%@${rig.replace(/%/g, "\\%").replace(/_/g, "\\_")}`);
    const scopeSql = sessionPatterns.map(() => "(q.destination_session LIKE ? ESCAPE '\\' OR q.source_session LIKE ? ESCAPE '\\')").join(" OR ");
    const scopeParams = sessionPatterns.flatMap((pattern) => [pattern, pattern]);
    const rows = this.db.prepare(`
      WITH rig_history AS (
        SELECT
          t.transition_id,
          t.qitem_id,
          t.ts,
          t.state,
          t.actor_session,
          t.closure_reason,
          t.closure_target,
          q.tags,
          q.summary,
          q.destination_session,
          q.source_session,
          LAG(t.state) OVER (
            PARTITION BY t.qitem_id
            ORDER BY t.transition_id
          ) AS previous_state
        FROM ${this.historySource} t
        JOIN queue_items q ON q.qitem_id = t.qitem_id
        WHERE ${scopeSql}
      ), qualifying AS (
        SELECT * FROM rig_history
        WHERE (state = 'in-progress' AND previous_state IN ('pending', 'blocked'))
           OR (state = 'blocked' AND previous_state IS NOT NULL AND previous_state <> 'blocked')
           OR closure_reason = 'handed_off_to'
           OR (state = 'done' AND closure_reason = 'no-follow-on')
           OR state IN ('failed', 'denied', 'canceled')
           OR closure_reason IN ('denied', 'canceled', 'escalation')
      )
      SELECT transition_id, qitem_id, ts, state, actor_session,
             closure_reason, closure_target, tags, summary, previous_state,
             destination_session, source_session
      FROM qualifying
      ORDER BY ts DESC, transition_id DESC
      LIMIT ?
    `).all(...scopeParams, limit) as RecentQueueTransitionRow[];

    return rows.reverse().flatMap((row) => {
      const change = recentChange(row);
      if (!change) return [];
      const rig = sessionRig(row.destination_session, knownRigs)
        ?? sessionRig(row.source_session, knownRigs)
        ?? sessionRig(row.actor_session, knownRigs);
      if (!rig) return [];
      return [{
        transitionId: row.transition_id,
        qitemId: row.qitem_id,
        ts: row.ts,
        actorSession: row.actor_session,
        change,
        summary: row.summary?.trim() || null,
        rig,
        ...recentTarget(row),
      }];
    });
  }

  listRecentForRig(rig: string, requestedLimit = 20): RecentQueueTransition[] {
    return this.listRecent({ kind: "rig", rig }, requestedLimit);
  }

  latestOwnerNotificationForQitem(qitemId: string): QueueTransition | null {
    if (!this.hasOwnerNotificationColumns) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM ${this.historySource}
          WHERE qitem_id = ? AND owner_notification_level IS NOT NULL
          ORDER BY transition_id DESC LIMIT 1`,
      )
      .get(qitemId) as QueueTransitionRow | undefined;
    return row ? this.rowToTransition(row) : null;
  }

  hasOwnerNotificationReceipt(qitemId: string, notificationKey: string): boolean {
    const rows = this.db
      .prepare(
        `SELECT transition_note FROM ${this.historySource}
          WHERE qitem_id = ? AND transition_note LIKE 'slack-owner-notification-posted %'`,
      )
      .all(qitemId) as Array<{ transition_note: string }>;
    return rows.some((row) => row.transition_note.split(/\s+/).includes(`notification_key=${notificationKey}`));
  }

  private rowToTransition(row: QueueTransitionRow): QueueTransition {
    return {
      transitionId: row.transition_id,
      qitemId: row.qitem_id,
      ts: row.ts,
      state: row.state,
      transitionNote: row.transition_note,
      actorSession: row.actor_session,
      closureReason: row.closure_reason as ClosureReason | null,
      closureTarget: row.closure_target,
      identityProvenance: row.identity_provenance ?? null,
      ownerNotificationKind: row.owner_notification_kind ?? null,
      ownerNotificationLevel: OWNER_NOTIFICATION_LEVELS.includes(row.owner_notification_level as OwnerNotificationLevel)
        ? row.owner_notification_level as OwnerNotificationLevel
        : "RECORD",
    };
  }
}
