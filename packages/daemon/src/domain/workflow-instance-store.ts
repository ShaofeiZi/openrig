// PL-004 Phase D：工作流 instance store。
//
// 负责 workflow_instances 的 CRUD。frontier tracking 使用 current_frontier_json
//（序列化后的 qitem_id JSON 数组）。无需文件系统 reconciliation 即可跨后台服务重启存活：
// list/getById 直接查询 SQLite。

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type {
  WorkflowFailureOccurrence,
  WorkflowFrontierBinding,
  WorkflowInstance,
  WorkflowInstanceStatus,
} from "./workflow-types.js";

interface InstanceRow {
  instance_id: string;
  workflow_name: string;
  workflow_version: string;
  created_by_session: string;
  created_at: string;
  status: string;
  current_frontier_json: string;
  current_step_id: string | null;
  hop_count: number;
  fallback_synthesis: string | null;
  last_continuation_decision_json: string | null;
  completed_at: string | null;
  /** OPR.0.4.6.WF1 FR-5——乐观并发 version（migration 049）。row 层可选：
   *  未应用 migration 的旧版 fixture 读取为 undefined，并映射到 0。 */
  version?: number;
  /** OPR.0.4.6.WF5 FR-4（migration 051）——与 version 相同，在 row 层可选；
   *  旧版 fixture 映射到 0。 */
  resume_count?: number;
  hops_baseline?: number;
  /** OPR.0.4.6.FAC1（migration 052）——与 version 相同，在 row 层可选；
   *  旧版 fixture 映射到 null（未绑定）。 */
  bound_rig?: string | null;
  lifecycle_operation_key?: string | null;
  compiled_input_digest?: string | null;
  lifecycle_binding_json?: string | null;
}

/** 防御性 column probe（沿用 detectQueueColumn 模式）。旧测试 fixture 会绕过 canonical migration
 *  列表，因此 version column（migration 049）可能缺失；guard 在这种情况下退化为旧版无守卫 update。
 *  production 始终执行 migration。 */
function detectInstanceColumn(db: Database.Database, columnName: string): boolean {
  try {
    return db
      .prepare("PRAGMA table_info(workflow_instances)")
      .all()
      .some((row) => (row as { name?: string }).name === columnName);
  } catch {
    return false;
  }
}

export interface CreateWorkflowInstanceInput {
  workflowName: string;
  workflowVersion: string;
  createdBySession: string;
  initialFrontier?: string[];
  /** R2：在 instantiate 时设置的持久 current-step binding。 */
  currentStepId?: string;
  /**
   * OPR.0.4.6.FAC1：此 instance 绑定的工作组名称，已由 runtime 解析：
   * targetRig override ?? spec.target.rig。null/缺失表示未绑定，与当前行为逐字节一致。
   */
  boundRig?: string | null;
  lifecycle?: {
    operationKey: string;
    compiledInputDigest: string;
    binding: Record<string, unknown>;
  };
}

export class WorkflowInstanceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowInstanceError";
  }
}

export class WorkflowInstanceStore {
  private readonly hasVersionColumn: boolean;
  private readonly hasResumeColumns: boolean;
  private readonly hasBoundRigColumn: boolean;
  private readonly hasLifecycleColumns: boolean;
  private readonly hasFrontierBindingsTable: boolean;
  private readonly hasFailureOccurrencesTable: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hasVersionColumn = detectInstanceColumn(db, "version");
    this.hasResumeColumns = detectInstanceColumn(db, "resume_count");
    this.hasBoundRigColumn = detectInstanceColumn(db, "bound_rig");
    this.hasLifecycleColumns = detectInstanceColumn(db, "lifecycle_operation_key");
    this.hasFrontierBindingsTable = tableExists(db, "workflow_frontier_bindings");
    this.hasFailureOccurrencesTable = tableExists(db, "workflow_failure_occurrences");
  }

  create(input: CreateWorkflowInstanceInput): WorkflowInstance {
    const instanceId = ulid();
    const createdAt = this.now().toISOString();
    const frontier = input.initialFrontier ?? [];
    // OPR.0.4.6.FAC1：bound_rig 使用与 version/resume 相同的防御性 column probe。
    // 未应用 migration 052 的旧 fixture 保留旧版 INSERT；production 始终执行 migration。
    const boundRigCol = this.hasBoundRigColumn ? ", bound_rig" : "";
    const boundRigVal = this.hasBoundRigColumn ? ", ?" : "";
    const lifecycleCols = this.hasLifecycleColumns
      ? ", lifecycle_operation_key, compiled_input_digest, lifecycle_binding_json"
      : "";
    const lifecycleVals = this.hasLifecycleColumns ? ", ?, ?, ?" : "";
    const params: unknown[] = [
      instanceId,
      input.workflowName,
      input.workflowVersion,
      input.createdBySession,
      createdAt,
      JSON.stringify(frontier),
      input.currentStepId ?? null,
    ];
    if (this.hasBoundRigColumn) params.push(input.boundRig ?? null);
    if (this.hasLifecycleColumns) {
      params.push(
        input.lifecycle?.operationKey ?? null,
        input.lifecycle?.compiledInputDigest ?? null,
        input.lifecycle ? JSON.stringify(input.lifecycle.binding) : null,
      );
    }
    this.db
      .prepare(
        `INSERT INTO workflow_instances (
           instance_id, workflow_name, workflow_version, created_by_session,
           created_at, status, current_frontier_json, current_step_id, hop_count${boundRigCol}${lifecycleCols}
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0${boundRigVal}${lifecycleVals})`,
      )
      .run(...(params as never[]));
    return this.getByIdOrThrow(instanceId);
  }

  getById(instanceId: string): WorkflowInstance | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_instances WHERE instance_id = ?`)
      .get(instanceId) as InstanceRow | undefined;
    return row ? rowToInstance(row) : null;
  }

  getByIdOrThrow(instanceId: string): WorkflowInstance {
    const inst = this.getById(instanceId);
    if (!inst) {
      throw new WorkflowInstanceError(
        "instance_not_found",
        `未找到 workflow instance ${instanceId}`,
        { instanceId },
      );
    }
    return inst;
  }

  getByLifecycleOperationKey(operationKey: string): WorkflowInstance | null {
    if (!this.hasLifecycleColumns) return null;
    const row = this.db
      .prepare(`SELECT * FROM workflow_instances WHERE lifecycle_operation_key = ?`)
      .get(operationKey) as InstanceRow | undefined;
    return row ? rowToInstance(row) : null;
  }

  /** 调用方在同一 transaction 中封装 cache/binding/receipt/event；不会重写 packet 或 trail。 */
  reviseLifecycle(instanceId: string, expectedVersion: number, workflowVersion: string, digest: string, binding: Record<string, unknown>): void {
    const result = this.db.prepare("UPDATE workflow_instances SET workflow_version = ?, compiled_input_digest = ?, lifecycle_binding_json = ?, version = version + 1 WHERE instance_id = ? AND version = ?")
      .run(workflowVersion, digest, JSON.stringify(binding), instanceId, expectedVersion);
    if (result.changes !== 1) throw new WorkflowInstanceError("instance_version_conflict", "revision 期间 instance 已推进；请重新检查。", { instanceId, expectedVersion });
  }

  bindFrontierPacket(input: {
    instanceId: string;
    packetId: string;
    stepId: string;
    branchDrive?: number;
    hopCount?: number;
    hopsBaseline?: number;
  }): WorkflowFrontierBinding {
    if (!this.hasFrontierBindingsTable) {
      throw new WorkflowInstanceError("frontier_bindings_unavailable", "按 packet 寻址的 workflow state 需要 migration 079");
    }
    const createdAt = this.now().toISOString();
    this.db.prepare(
      `INSERT INTO workflow_frontier_bindings
       (instance_id, packet_id, step_id, branch_drive, hop_count, hops_baseline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.instanceId,
      input.packetId,
      input.stepId,
      input.branchDrive ?? 0,
      input.hopCount ?? 0,
      input.hopsBaseline ?? 0,
      createdAt,
    );
    return this.getFrontierBinding(input.instanceId, input.packetId)!;
  }

  removeFrontierBinding(instanceId: string, packetId: string): void {
    if (!this.hasFrontierBindingsTable) return;
    this.db.prepare(`DELETE FROM workflow_frontier_bindings WHERE instance_id = ? AND packet_id = ?`)
      .run(instanceId, packetId);
  }

  getFrontierBinding(instanceId: string, packetId: string): WorkflowFrontierBinding | null {
    if (!this.hasFrontierBindingsTable) return null;
    const row = this.db.prepare(
      `SELECT * FROM workflow_frontier_bindings WHERE instance_id = ? AND packet_id = ?`,
    ).get(instanceId, packetId) as FrontierBindingRow | undefined;
    return row ? rowToFrontierBinding(row) : null;
  }

  listFrontierBindings(instanceId: string): WorkflowFrontierBinding[] {
    if (!this.hasFrontierBindingsTable) return [];
    const rows = this.db.prepare(
      `SELECT * FROM workflow_frontier_bindings WHERE instance_id = ? ORDER BY created_at, packet_id`,
    ).all(instanceId) as FrontierBindingRow[];
    return rows.map(rowToFrontierBinding);
  }

  recordFailureOccurrence(input: {
    instanceId: string;
    failedPacketId: string;
    stepId: string;
    branchDrive?: number;
    hopCount?: number;
    hopsBaseline?: number;
    failureReason?: string | null;
  }): WorkflowFailureOccurrence {
    if (!this.hasFailureOccurrencesTable) {
      throw new WorkflowInstanceError("failure_occurrences_unavailable", "branch-local workflow recovery 需要 migration 079");
    }
    const failedAt = this.now().toISOString();
    this.db.prepare(
      `INSERT INTO workflow_failure_occurrences
       (occurrence_id, instance_id, failed_packet_id, step_id, branch_drive,
        hop_count, hops_baseline, failure_reason, status, failed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)`,
    ).run(
      input.failedPacketId,
      input.instanceId,
      input.failedPacketId,
      input.stepId,
      input.branchDrive ?? 0,
      input.hopCount ?? 0,
      input.hopsBaseline ?? 0,
      input.failureReason ?? null,
      failedAt,
    );
    return this.getFailureOccurrence(input.instanceId, input.failedPacketId)!;
  }

  getFailureOccurrence(instanceId: string, occurrenceId: string): WorkflowFailureOccurrence | null {
    if (!this.hasFailureOccurrencesTable) return null;
    const row = this.db.prepare(
      `SELECT * FROM workflow_failure_occurrences WHERE instance_id = ? AND occurrence_id = ?`,
    ).get(instanceId, occurrenceId) as FailureOccurrenceRow | undefined;
    return row ? rowToFailureOccurrence(row) : null;
  }

  listFailureOccurrences(instanceId: string, status?: "unresolved" | "resolved"): WorkflowFailureOccurrence[] {
    if (!this.hasFailureOccurrencesTable) return [];
    const rows = status
      ? this.db.prepare(`SELECT * FROM workflow_failure_occurrences WHERE instance_id = ? AND status = ? ORDER BY failed_at, occurrence_id`).all(instanceId, status)
      : this.db.prepare(`SELECT * FROM workflow_failure_occurrences WHERE instance_id = ? ORDER BY failed_at, occurrence_id`).all(instanceId);
    return (rows as FailureOccurrenceRow[]).map(rowToFailureOccurrence);
  }

  resolveFailureOccurrence(instanceId: string, occurrenceId: string, redrivePacketId: string, resumeDecision?: string): void {
    if (!this.hasFailureOccurrencesTable) return;
    const info = this.db.prepare(
      `UPDATE workflow_failure_occurrences
       SET status = 'resolved', redrive_packet_id = ?, resume_decision = ?, resolved_at = ?
       WHERE instance_id = ? AND occurrence_id = ? AND status = 'unresolved'`,
    ).run(redrivePacketId, resumeDecision ?? null, this.now().toISOString(), instanceId, occurrenceId);
    if (info.changes === 0) {
      throw new WorkflowInstanceError(
        "failure_occurrence_not_unresolved",
        `failure occurrence ${occurrenceId} 在 instance ${instanceId} 中不是 unresolved 状态`,
        { instanceId, occurrenceId },
      );
    }
  }

  listByStatus(status: WorkflowInstanceStatus): WorkflowInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_instances WHERE status = ? ORDER BY created_at ASC`,
      )
      .all(status) as InstanceRow[];
    return rows.map(rowToInstance);
  }

  listAll(): WorkflowInstance[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflow_instances ORDER BY created_at ASC`)
      .all() as InstanceRow[];
    return rows.map(rowToInstance);
  }

  /**
   * 原子更新 frontier + status。需要与其他 mutation 组合时，由调用方负责放入 transaction
   *（例如 workflow-projector 会把它合并到 close + create + frontier-update transaction 中）。
   */
  updateFrontier(
    instanceId: string,
    nextFrontier: string[],
    nextStatus: WorkflowInstanceStatus,
    opts: {
      bumpHopCount?: boolean;
      lastContinuationDecision?: Record<string, unknown> | null;
      fallbackSynthesis?: string | null;
      completedAt?: string | null;
      /**
       * R2：显式指定下一个 current_step_id。提供时覆盖该 column；传入 `clear` 可写为 NULL。
       * 省略时保留 current_step_id，例如 waiting 时复用 frontier packet。
       */
      currentStepId?: string | "preserve" | "clear";
      /**
       * OPR.0.4.6.WF1 FR-5——乐观并发 guard。提供时，UPDATE 增加 `WHERE version = ?` 条件，
       * 并执行 `version = version + 1`；若修改 0 行，则抛出结构化 `instance_version_conflict`，
       * 点明 expected/actual，调用方 transaction 整体回滚。省略时使用旧版无守卫行为：
       * 不读取 version，也不递增；projector 始终提供该值。
       */
      expectedVersion?: number;
      /**
       * OPR.0.4.6.WF5 FR-4——resume stamp：在 frontier rebind 时原子设置已记录的 redrive count
       * 与 livelock-rail hops baseline；只有 resume() 会传入。
       */
      resumeStamp?: { resumeCount: number; hopsBaseline: number };
    } = {},
  ): void {
    const setHop = opts.bumpHopCount ? "hop_count = hop_count + 1, " : "";
    const setResume =
      opts.resumeStamp && this.hasResumeColumns
        ? `resume_count = ${Number(opts.resumeStamp.resumeCount)}, hops_baseline = ${Number(opts.resumeStamp.hopsBaseline)}, `
        : "";
    const guardVersion = opts.expectedVersion !== undefined && this.hasVersionColumn;
    const setVersion = guardVersion ? "version = version + 1, " : "";
    const versionWhere = guardVersion ? " AND version = ?" : "";
    let currentStepClause = "";
    let currentStepValue: string | null | undefined;
    if (opts.currentStepId === "preserve" || opts.currentStepId === undefined) {
      currentStepClause = "";
      currentStepValue = undefined;
    } else if (opts.currentStepId === "clear") {
      currentStepClause = "current_step_id = NULL, ";
    } else {
      currentStepClause = "current_step_id = ?, ";
      currentStepValue = opts.currentStepId;
    }
    const sql = `UPDATE workflow_instances SET
           ${setVersion}${setHop}${setResume}${currentStepClause}status = ?, current_frontier_json = ?,
           last_continuation_decision_json = COALESCE(?, last_continuation_decision_json),
           fallback_synthesis = COALESCE(?, fallback_synthesis),
           completed_at = COALESCE(?, completed_at)
         WHERE instance_id = ?${versionWhere}`;
    const stmt = this.db.prepare(sql);
    const params: unknown[] = [];
    if (currentStepValue !== undefined) params.push(currentStepValue);
    params.push(
      nextStatus,
      JSON.stringify(nextFrontier),
      opts.lastContinuationDecision ? JSON.stringify(opts.lastContinuationDecision) : null,
      opts.fallbackSynthesis ?? null,
      opts.completedAt ?? null,
      instanceId,
    );
    if (guardVersion) params.push(opts.expectedVersion);
    const info = stmt.run(...(params as never[]));
    if (guardVersion && info.changes === 0) {
      const current = this.getById(instanceId);
      throw new WorkflowInstanceError(
        "instance_version_conflict",
        `workflow instance ${instanceId} 被并发推进：预期 version ${opts.expectedVersion}，实际为 ${current ? current.version : "（instance 缺失）"}；失败 writer 的 transaction 已整体回滚，请读取当前状态后重新 project`,
        {
          instanceId,
          expectedVersion: opts.expectedVersion,
          actualVersion: current?.version ?? null,
        },
      );
    }
  }
}

function rowToInstance(row: InstanceRow): WorkflowInstance {
  return {
    instanceId: row.instance_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    createdBySession: row.created_by_session,
    createdAt: row.created_at,
    status: row.status as WorkflowInstanceStatus,
    currentFrontier: JSON.parse(row.current_frontier_json) as string[],
    currentStepId: row.current_step_id,
    hopCount: row.hop_count,
    fallbackSynthesis: row.fallback_synthesis,
    lastContinuationDecision: row.last_continuation_decision_json
      ? (JSON.parse(row.last_continuation_decision_json) as Record<string, unknown>)
      : null,
    completedAt: row.completed_at,
    version: row.version ?? 0,
    resumeCount: row.resume_count ?? 0,
    hopsBaseline: row.hops_baseline ?? 0,
    boundRig: row.bound_rig ?? null,
    lifecycleOperationKey: row.lifecycle_operation_key ?? null,
    compiledInputDigest: row.compiled_input_digest ?? null,
    lifecycleBinding: row.lifecycle_binding_json
      ? (JSON.parse(row.lifecycle_binding_json) as Record<string, unknown>)
      : null,
  };
}

interface FrontierBindingRow {
  instance_id: string;
  packet_id: string;
  step_id: string;
  branch_drive: number;
  hop_count: number;
  hops_baseline: number;
  created_at: string;
}

interface FailureOccurrenceRow {
  occurrence_id: string;
  instance_id: string;
  failed_packet_id: string;
  step_id: string;
  branch_drive: number;
  hop_count: number;
  hops_baseline: number;
  failure_reason: string | null;
  status: "unresolved" | "resolved";
  redrive_packet_id: string | null;
  resume_decision: string | null;
  failed_at: string;
  resolved_at: string | null;
}

function rowToFrontierBinding(row: FrontierBindingRow): WorkflowFrontierBinding {
  return {
    instanceId: row.instance_id,
    packetId: row.packet_id,
    stepId: row.step_id,
    branchDrive: row.branch_drive,
    hopCount: row.hop_count,
    hopsBaseline: row.hops_baseline,
    createdAt: row.created_at,
  };
}

function rowToFailureOccurrence(row: FailureOccurrenceRow): WorkflowFailureOccurrence {
  return {
    occurrenceId: row.occurrence_id,
    instanceId: row.instance_id,
    failedPacketId: row.failed_packet_id,
    stepId: row.step_id,
    branchDrive: row.branch_drive,
    hopCount: row.hop_count,
    hopsBaseline: row.hops_baseline,
    failureReason: row.failure_reason,
    status: row.status,
    redrivePacketId: row.redrive_packet_id,
    resumeDecision: row.resume_decision,
    failedAt: row.failed_at,
    resolvedAt: row.resolved_at,
  };
}

function tableExists(db: Database.Database, tableName: string): boolean {
  try {
    return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) !== undefined;
  } catch {
    return false;
  }
}
