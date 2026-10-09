// PL-005 Phase B：只读浏览 mission_control_actions 审计历史。
//
// 筛选条件：qitem_id（精确）、action_verb（精确）、actor_session（精确）、
// since/until（acted_at 范围）。通过 before_id + limit 分页。
// 返回 {rows, has_more, next_before_id} 结构，供 UI 分页。
//
// 只读：没有写入器，也没有 UPDATE/DELETE 方法。Phase A 的
// MissionControlActionLog 是唯一写入方，本层只负责查询。

import type Database from "better-sqlite3";
import {
  type MissionControlActionEntry,
  type MissionControlVerb,
  MISSION_CONTROL_VERBS,
} from "./mission-control-action-log.js";

export interface AuditQueryInput {
  qitemId?: string;
  actionVerb?: string;
  actorSession?: string;
  /** ISO 时间戳；包含 acted_at >= since 的记录。 */
  since?: string;
  /** ISO 时间戳；包含 acted_at <= until 的记录。 */
  until?: string;
  /** 默认 50，上限 200。 */
  limit?: number;
  /** 分页游标：返回 action_id < beforeId 的记录。 */
  beforeId?: string;
  /** OPR.0.4.4.19 FR-9 —— 工作范围审批目标筛选器（已钉死 audit_notes_json
   * 结构的读取路径）。它们让 Packet 2 的单查询 UNVERIFIED 标记交叉检查真正生效：
   * 按稳定的工作范围目标（tier + dot-ID + 规范路径）和/或审批范围筛选。 */
  scopeTier?: string;
  scopeId?: string;
  scopePath?: string;
  approvalScope?: string;
}

export interface AuditQueryResult {
  rows: MissionControlActionEntry[];
  hasMore: boolean;
  nextBeforeId: string | null;
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class MissionControlAuditBrowse {
  constructor(private readonly db: Database.Database) {}

  query(input: AuditQueryInput): AuditQueryResult {
    if (input.actionVerb && !MISSION_CONTROL_VERBS.includes(input.actionVerb as MissionControlVerb)) {
      throw new Error(
        `未知 action_verb '${input.actionVerb}'；支持：${MISSION_CONTROL_VERBS.join(", ")}`,
      );
    }
    const limit = clampLimit(input.limit);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.qitemId) {
      where.push("qitem_id = ?");
      params.push(input.qitemId);
    }
    if (input.actionVerb) {
      where.push("action_verb = ?");
      params.push(input.actionVerb);
    }
    if (input.actorSession) {
      where.push("actor_session = ?");
      params.push(input.actorSession);
    }
    // OPR.0.4.4.19 FR-9 —— 通过 SQLite JSON1（随 better-sqlite3 提供）按已钉死的
    // audit_notes_json 结构筛选；audit_notes_json 为 NULL 的记录自然不会匹配。
    if (input.scopeTier) {
      where.push("json_extract(audit_notes_json, '$.scope_tier') = ?");
      params.push(input.scopeTier);
    }
    if (input.scopeId) {
      where.push("json_extract(audit_notes_json, '$.scope_id') = ?");
      params.push(input.scopeId);
    }
    if (input.scopePath) {
      where.push("json_extract(audit_notes_json, '$.scope_path') = ?");
      params.push(input.scopePath);
    }
    if (input.approvalScope) {
      where.push("json_extract(audit_notes_json, '$.approval_scope') = ?");
      params.push(input.approvalScope);
    }
    if (input.since) {
      where.push("acted_at >= ?");
      params.push(input.since);
    }
    if (input.until) {
      where.push("acted_at <= ?");
      params.push(input.until);
    }
    if (input.beforeId) {
      // 查找游标记录的 rowid，使分页使用 SQLite 的单调插入顺序（确定性），而不是
      // ULID action_id（同一毫秒内的尾部随机，无法确定性打破平局）。已归档经验：
      // feedback_ulid_tiebreaker_nondeterministic.md.
      where.push("rowid < (SELECT rowid FROM mission_control_actions WHERE action_id = ?)");
      params.push(input.beforeId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    // 多取一条（limit+1）以判断 hasMore，无需额外 count 查询。
    // 主排序为 acted_at DESC，以 rowid DESC 打破平局（确定性的插入顺序；处理同毫秒
    // 记录时比 ULID action_id 更安全）。
    const sql = `SELECT * FROM mission_control_actions ${whereClause}
       ORDER BY acted_at DESC, rowid DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1) as ActionRow[];
    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const nextBeforeId = hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1]!.action_id : null;
    return {
      rows: trimmed.map(rowToEntry),
      hasMore,
      nextBeforeId,
    };
  }
}

function clampLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_LIMIT;
  if (input < 1) return 1;
  if (input > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(input);
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
