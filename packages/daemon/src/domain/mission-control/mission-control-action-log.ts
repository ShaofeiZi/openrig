// PL-005 阶段 A：Mission Control 操作日志（只追加）。
//
// 负责向 mission_control_actions 插入记录。API 表面只允许追加：只暴露 `record()`，
// 不提供 UPDATE/DELETE/remove 方法。直接 SQL 虽可修改数据，但违反此领域边界强制执行的
// 契约（依据 PRD § Q5 + slice IMPL）。
//
// 该模式镜像 PL-004 阶段 C 的 WatchdogHistoryLog、阶段 A 的 QueueTransitionLog
// 以及阶段 D 的 WorkflowStepTrailLog。

import type Database from "better-sqlite3";
import { ulid } from "ulid";

export const MISSION_CONTROL_VERBS = [
  "approve",
  "deny",
  "route",
  "annotate",
  "hold",
  "drop",
  "handoff",
  // OPR.0.4.4.19 FR-7——resolve：人工在表面上对 leg-1 停放 qitem 的回答
  //（人工席位上的 state=blocked）。非关闭操作：只能从 blocked → in-progress；
  // 决策文本写入 queue_transitions。
  "resolve",
] as const;

export type MissionControlVerb = (typeof MISSION_CONTROL_VERBS)[number];

export interface MissionControlActionRecordInput {
  actionVerb: MissionControlVerb;
  qitemId: string | null;
  actorSession: string;
  actedAt: string;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  reason?: string | null;
  annotation?: string | null;
  notifyAttempted?: boolean;
  notifyResult?: string | null;
  auditNotes?: Record<string, unknown> | null;
  /** P21 时代戳：`actorSession` 的身份来源。传输关口写入 `transport:v1`；
   *  缺失/null 表示 claimed 时代（验证前），绝不重新标注。 */
  identityProvenance?: string | null;
}

export interface MissionControlActionEntry {
  actionId: string;
  actionVerb: MissionControlVerb;
  qitemId: string | null;
  actorSession: string;
  actedAt: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  reason: string | null;
  annotation: string | null;
  notifyAttempted: boolean;
  notifyResult: string | null;
  auditNotes: Record<string, unknown> | null;
  identityProvenance: string | null;
}

interface ActionRow {
  action_id: string;
  action_verb: string;
  qitem_id: string | null;
  actor_session: string;
  acted_at: string;
  before_state_json: string | null;
  after_state_json: string | null;
  reason: string | null;
  annotation: string | null;
  notify_attempted: number;
  notify_result: string | null;
  audit_notes_json: string | null;
  identity_provenance?: string | null;
}

export class MissionControlActionLogError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MissionControlActionLogError";
  }
}

/** 防御性检测增量列：早于迁移 065 的测试工具数据库没有 identity_provenance，
 *  因此写入器会降级为省略该字段，而不是抛错。 */
function hasIdentityProvenanceColumn(db: Database.Database): boolean {
  try {
    return db.prepare("PRAGMA table_info(mission_control_actions)").all()
      .some((row) => (row as { name?: string }).name === "identity_provenance");
  } catch {
    return false;
  }
}

export class MissionControlActionLog {
  private readonly hasProvenanceCol: boolean;
  constructor(private readonly db: Database.Database) {
    this.hasProvenanceCol = hasIdentityProvenanceColumn(db);
  }

  /**
   * 追加一条操作记录。校验动词专属必填字段
   *（annotate → annotation；hold/drop → reason）。设计为可在调用方管理的外层事务中组合，
   * 原子四步移交的写入契约会使用此能力。
   */
  record(input: MissionControlActionRecordInput): MissionControlActionEntry {
    if (!MISSION_CONTROL_VERBS.includes(input.actionVerb)) {
      throw new MissionControlActionLogError(
        "verb_unknown",
        `未知 action_verb '${input.actionVerb}'；阶段 A v1 支持：${MISSION_CONTROL_VERBS.join(", ")}`,
        { actionVerb: input.actionVerb, supported: [...MISSION_CONTROL_VERBS] },
      );
    }
    if (input.actionVerb === "annotate" && !input.annotation) {
      throw new MissionControlActionLogError(
        "annotation_required",
        `action_verb=annotate requires annotation`,
        { actionVerb: input.actionVerb },
      );
    }
    if ((input.actionVerb === "hold" || input.actionVerb === "drop") && !input.reason) {
      throw new MissionControlActionLogError(
        "reason_required",
        `action_verb=${input.actionVerb} requires reason`,
        { actionVerb: input.actionVerb },
      );
    }
    const actionId = ulid();
    const baseCols = [
      actionId,
      input.actionVerb,
      input.qitemId ?? null,
      input.actorSession,
      input.actedAt,
      input.beforeState ? JSON.stringify(input.beforeState) : null,
      input.afterState ? JSON.stringify(input.afterState) : null,
      input.reason ?? null,
      input.annotation ?? null,
      input.notifyAttempted ? 1 : 0,
      input.notifyResult ?? null,
      input.auditNotes ? JSON.stringify(input.auditNotes) : null,
    ];
    if (this.hasProvenanceCol) {
      this.db
        .prepare(
          `INSERT INTO mission_control_actions (
             action_id, action_verb, qitem_id, actor_session, acted_at,
             before_state_json, after_state_json, reason, annotation,
             notify_attempted, notify_result, audit_notes_json, identity_provenance
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...baseCols, input.identityProvenance ?? null);
    } else {
      this.db
        .prepare(
          `INSERT INTO mission_control_actions (
             action_id, action_verb, qitem_id, actor_session, acted_at,
             before_state_json, after_state_json, reason, annotation,
             notify_attempted, notify_result, audit_notes_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...baseCols);
    }
    return {
      actionId,
      actionVerb: input.actionVerb,
      qitemId: input.qitemId ?? null,
      actorSession: input.actorSession,
      actedAt: input.actedAt,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      reason: input.reason ?? null,
      annotation: input.annotation ?? null,
      notifyAttempted: Boolean(input.notifyAttempted),
      notifyResult: input.notifyResult ?? null,
      auditNotes: input.auditNotes ?? null,
      identityProvenance: input.identityProvenance ?? null,
    };
  }

  listRecent(limit = 50): MissionControlActionEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mission_control_actions
         ORDER BY acted_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as ActionRow[];
    return rows.map(rowToEntry);
  }

  listForQitem(qitemId: string, limit = 50): MissionControlActionEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mission_control_actions WHERE qitem_id = ?
         ORDER BY acted_at DESC, rowid DESC LIMIT ?`,
      )
      .all(qitemId, limit) as ActionRow[];
    return rows.map(rowToEntry);
  }

  listForActor(actorSession: string, limit = 50): MissionControlActionEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mission_control_actions WHERE actor_session = ?
         ORDER BY acted_at DESC, rowid DESC LIMIT ?`,
      )
      .all(actorSession, limit) as ActionRow[];
    return rows.map(rowToEntry);
  }

  countAll(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM mission_control_actions`)
      .get() as { n: number };
    return row.n;
  }
}

function rowToEntry(row: ActionRow): MissionControlActionEntry {
  return {
    actionId: row.action_id,
    actionVerb: row.action_verb as MissionControlVerb,
    qitemId: row.qitem_id,
    actorSession: row.actor_session,
    actedAt: row.acted_at,
    beforeState: row.before_state_json
      ? (JSON.parse(row.before_state_json) as Record<string, unknown>)
      : null,
    afterState: row.after_state_json
      ? (JSON.parse(row.after_state_json) as Record<string, unknown>)
      : null,
    reason: row.reason,
    annotation: row.annotation,
    notifyAttempted: row.notify_attempted !== 0,
    notifyResult: row.notify_result,
    auditNotes: row.audit_notes_json
      ? (JSON.parse(row.audit_notes_json) as Record<string, unknown>)
      : null,
    identityProvenance: row.identity_provenance ?? null,
  };
}
