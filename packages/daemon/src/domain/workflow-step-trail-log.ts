// PL-004 Phase D：工作流步骤轨迹日志（仅追加）。
//
// 负责写入 workflow_step_trails。API 表面仅追加，只暴露 `record()`，不暴露
// UPDATE/DELETE/remove。
// 方法；直接 SQL 虽能修改，但违反契约。此领域边界按 PRD § L4 工作流运行时强制执行该规则。
//
// 结构与 Phase C 的 WatchdogHistoryLog 和 Phase A 的
// QueueTransitionLog.

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { WorkflowExitKind, WorkflowStepTrailEntry } from "./workflow-types.js";

export interface WorkflowStepTrailRecordInput {
  instanceId: string;
  stepId: string;
  stepRole: string;
  closedAt: string;
  closureReason: WorkflowExitKind;
  closureEvidence?: Record<string, unknown> | null;
  actorSession: string;
/** 终态关闭（`done`、`failed`、`waiting`）时为 null。 */
  nextQitemId?: string | null;
  priorQitemId: string;
}

interface TrailRow {
  trail_id: string;
  instance_id: string;
  step_id: string;
  step_role: string;
  closed_at: string;
  closure_reason: string;
  closure_evidence_json: string | null;
  actor_session: string;
  next_qitem_id: string | null;
  prior_qitem_id: string;
}

export class WorkflowStepTrailLog {
  constructor(private readonly db: Database.Database) {}

  /**
 * 追加一条步骤轨迹并返回持久化记录。可组合在调用方管理的外层事务中
 * （workflow-projector 使用它实现事务式记录契约）。
   */
  record(input: WorkflowStepTrailRecordInput): WorkflowStepTrailEntry {
    const trailId = ulid();
    this.db
      .prepare(
        `INSERT INTO workflow_step_trails (
           trail_id, instance_id, step_id, step_role, closed_at,
           closure_reason, closure_evidence_json, actor_session,
           next_qitem_id, prior_qitem_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trailId,
        input.instanceId,
        input.stepId,
        input.stepRole,
        input.closedAt,
        input.closureReason,
        input.closureEvidence ? JSON.stringify(input.closureEvidence) : null,
        input.actorSession,
        input.nextQitemId ?? null,
        input.priorQitemId,
      );
    return {
      trailId,
      instanceId: input.instanceId,
      stepId: input.stepId,
      stepRole: input.stepRole,
      closedAt: input.closedAt,
      closureReason: input.closureReason,
      closureEvidence: input.closureEvidence ?? null,
      actorSession: input.actorSession,
      nextQitemId: input.nextQitemId ?? null,
      priorQitemId: input.priorQitemId,
    };
  }

  listForInstance(instanceId: string, limit = 50): WorkflowStepTrailEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_step_trails WHERE instance_id = ?
         ORDER BY closed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(instanceId, limit) as TrailRow[];
    return rows.map(rowToEntry);
  }

  countForInstance(instanceId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM workflow_step_trails WHERE instance_id = ?`)
      .get(instanceId) as { n: number };
    return row.n;
  }
}

function rowToEntry(row: TrailRow): WorkflowStepTrailEntry {
  return {
    trailId: row.trail_id,
    instanceId: row.instance_id,
    stepId: row.step_id,
    stepRole: row.step_role,
    closedAt: row.closed_at,
    closureReason: row.closure_reason as WorkflowExitKind,
    closureEvidence: row.closure_evidence_json
      ? (JSON.parse(row.closure_evidence_json) as Record<string, unknown>)
      : null,
    actorSession: row.actor_session,
    nextQitemId: row.next_qitem_id,
    priorQitemId: row.prior_qitem_id,
  };
}
