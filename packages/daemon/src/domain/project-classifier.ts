import type { IdentityProvenance } from "../routes/require-sender-identity.js";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { EventBus } from "./event-bus.js";
import type { ClassifierLeaseManager } from "./classifier-lease-manager.js";

/**
 * 项目分类器（PL-004 阶段 B；L2 Project / Classifier 写入路径）。
 * 0.6.0 S02 P1：结果绑定 lease id，并在写事务内校验；包含四个可空标签字段与版本绑定
 *（迁移 086）。
 *
 * 根据 PRD § L2 与 slice IMPL § Guard Checkpoint Focus item 1+2+4：
 * - 通过 classifier-lease-manager 校验 lease（单写入方契约）。
 * - 通过 stream_item_id 的 UNIQUE 约束保证幂等（重复投影 → 409）。
 * - 后台服务不强制分类字段的 taxonomy；这些字段由智能体裁定。
 *   后台服务只负责契约（lease、幂等与 reclaim）。
 * - 行提交后发出 project.classified 事件。
 *
 * 结构对应阶段 A 的 stream-store.ts（单类、原子事务、先持久化事件再通知），不使用 Hono。
 */

export interface ProjectClassification {
  projectId: string;
  streamItemId: string;
  classificationType: string | null;
  classificationUrgency: string | null;
  classificationMaturity: string | null;
  classificationConfidence: string | null;
  classificationDestination: string | null;
  action: string | null;
  /** 0.6.0 S02 字段（迁移 086）。NULL 表示 unknown；086 之前的行为 NULL。 */
  area: string | null;
  scopeRef: string | null;
  duplicateOfStreamItemId: string | null;
  /** 仅当分类器明确声明时才为 true / false；null 表示 unknown，绝不等同于 false。 */
  needsHuman: boolean | null;
  /** 结果绑定（086）：生成标签时使用的 lease 与版本。 */
  leaseId: string | null;
  classifierVersion: string | null;
  taxonomyVersion: string | null;
  candidateSetVersion: string | null;
  classifierSession: string;
  tsProjected: string;
  identityProvenance: IdentityProvenance | null;
}

export interface ProjectClassifyInput {
  identityProvenance?: IdentityProvenance;
  streamItemId: string;
  classifierSession: string;
  /** 必填（S02 P1）：计算此结果时使用的 lease。 */
  leaseId: string;
  /**
   * 可选的 attempt-ledger 绑定；在同一事务中标记为 `written`。
   * 手工分类（不绑定 ledger）时省略。
   */
  attemptId?: string;
  /** 与 attemptId 一起必填：产出此结果的 begin() 所返回的 executionId。 */
  executionId?: string;
  classificationType?: string;
  classificationUrgency?: string;
  classificationMaturity?: string;
  classificationConfidence?: string;
  classificationDestination?: string;
  action?: string;
  area?: string;
  scopeRef?: string;
  duplicateOfStreamItemId?: string;
  needsHuman?: boolean | null;
  classifierVersion?: string;
  taxonomyVersion?: string;
  candidateSetVersion?: string;
}

export interface ProjectListOptions {
  classifierSession?: string;
  classificationDestination?: string;
  area?: string;
  scopeRef?: string;
  /** "true" | "false" | "unknown"（NULL）。 */
  needsHuman?: "true" | "false" | "unknown";
  limit?: number;
}

interface ProjectClassificationRow {
  project_id: string;
  stream_item_id: string;
  classification_type: string | null;
  classification_urgency: string | null;
  classification_maturity: string | null;
  classification_confidence: string | null;
  classification_destination: string | null;
  action: string | null;
  area: string | null;
  scope_ref: string | null;
  duplicate_of_stream_item_id: string | null;
  needs_human: number | null;
  lease_id: string | null;
  classifier_version: string | null;
  taxonomy_version: string | null;
  candidate_set_version: string | null;
  classifier_session: string;
  ts_projected: string;
  identity_provenance: IdentityProvenance | null;
}

export class ProjectClassifierError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export class ProjectClassifier {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly leaseManager: ClassifierLeaseManager;
  private readonly now: () => Date;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    leaseManager: ClassifierLeaseManager,
    opts?: { now?: () => Date },
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.leaseManager = leaseManager;
    this.now = opts?.now ?? (() => new Date());
  }

  /**
   * 投影一个 stream item：分类由智能体编写，幂等与 lease 由后台服务强制。
   *
   * 1. 校验调用方持有活跃 lease（委托 leaseManager）。
   * 2. 插入 project_classifications 行（stream_item_id 的 UNIQUE 约束捕获重复投影，
   *    并把约束违例映射为明确的 `idempotency_violation` 错误）。
   * 3. 发出 project.classified 事件。
   */
  classify(input: ProjectClassifyInput): ProjectClassification {
    validateClassifyInput(input);
    const projectId = ulid();
    const tsProjected = this.now().toISOString();

    // S02 P1：所有决定结果能否写入的检查都在写事务内部执行，避免 lease 在检查与插入之间
    // 被替换或过期时放过迟到结果。
    const txn = this.db.transaction(() => {
      // Lease 必须活跃、属于同一会话、id 相同且未过期。
      this.leaseManager.requireActiveHolder(input.classifierSession, input.leaseId);

      // R1 修复（BLOCKER 1）：检查 stream_item_id 是否存在。迁移 028 中的 L1→L2 FK
      // 是纵深防御，但 SQLite FK 违例只会暴露晦涩错误字符串。在此预检可生成明确的结构化错误
      //（`unknown_stream_item`），供路由映射为 400 类状态。
      if (!this.streamItemExists(input.streamItemId)) {
        throw new ProjectClassifierError(
          "unknown_stream_item",
          `stream_item_id ${input.streamItemId} does not exist in stream_items; emit it first via 'rig stream emit' or check the id`,
          { streamItemId: input.streamItemId },
        );
      }
      if (input.duplicateOfStreamItemId !== undefined && !this.streamItemExists(input.duplicateOfStreamItemId)) {
        throw new ProjectClassifierError(
          "invalid_duplicate_of",
          `duplicateOfStreamItemId ${input.duplicateOfStreamItemId} does not exist in stream_items`,
          { duplicateOfStreamItemId: input.duplicateOfStreamItemId },
        );
      }

      // 首次写入胜出（保持不变）：第二次分类返回明确的 409。
      const existing = this.db
        .prepare(`SELECT * FROM project_classifications WHERE stream_item_id = ?`)
        .get(input.streamItemId) as ProjectClassificationRow | undefined;
      if (existing) {
        throw new ProjectClassifierError(
          "idempotency_violation",
          `stream_item_id ${input.streamItemId} is already projected as project_id ${existing.project_id} by ${existing.classifier_session}`,
          { existingProjectId: existing.project_id, existingClassifier: existing.classifier_session },
        );
      }

      if (input.attemptId !== undefined) this.bindAttemptWritten(input);

      this.db
        .prepare(
          `INSERT INTO project_classifications (
            project_id, stream_item_id,
            classification_type, classification_urgency, classification_maturity,
            classification_confidence, classification_destination, action,
            area, scope_ref, duplicate_of_stream_item_id, needs_human,
            lease_id, classifier_version, taxonomy_version, candidate_set_version,
            classifier_session, ts_projected, identity_provenance
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          projectId,
          input.streamItemId,
          input.classificationType ?? null,
          input.classificationUrgency ?? null,
          input.classificationMaturity ?? null,
          input.classificationConfidence ?? null,
          input.classificationDestination ?? null,
          input.action ?? null,
          input.area ?? null,
          input.scopeRef ?? null,
          input.duplicateOfStreamItemId ?? null,
          input.needsHuman === true ? 1 : input.needsHuman === false ? 0 : null,
          input.leaseId,
          input.classifierVersion ?? null,
          input.taxonomyVersion ?? null,
          input.candidateSetVersion ?? null,
          input.classifierSession,
          tsProjected,
          input.identityProvenance ?? null,
        );

      return this.eventBus.persistWithinTransaction({
        type: "project.classified",
        projectId,
        streamItemId: input.streamItemId,
        classifierSession: input.classifierSession,
        classificationType: input.classificationType ?? null,
        classificationDestination: input.classificationDestination ?? null,
      });
    });

    const persisted = txn();
    this.eventBus.notifySubscribers(persisted);
    return this.getByIdOrThrow(projectId);
  }

  private streamItemExists(streamItemId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM stream_items WHERE stream_item_id = ? LIMIT 1`).get(streamItemId) !== undefined;
  }

  /**
   * attempt 必须在此 lease 下处于进行中，针对当前 item，并使用结果所声明的同一
   * classifier/taxonomy 版本。在分类事务内标记为 `written`，使 ledger 与行绝不分歧。
   */
  private bindAttemptWritten(input: ProjectClassifyInput): void {
    const attempt = this.db
      .prepare(`SELECT * FROM classification_attempts WHERE attempt_id = ?`)
      .get(input.attemptId) as
      | { attempt_id: string; stream_item_id: string; status: string; execution_id: string; lease_id: string; classifier_version: string; taxonomy_version: string }
      | undefined;
    if (attempt && attempt.execution_id !== input.executionId) {
      throw new ProjectClassifierError("attempt_superseded", "this execution was superseded by a newer execution of the attempt", {
        attemptId: input.attemptId,
      });
    }
    if (
      !attempt ||
      attempt.status !== "in_flight" ||
      attempt.lease_id !== input.leaseId ||
      attempt.stream_item_id !== input.streamItemId ||
      attempt.classifier_version !== input.classifierVersion ||
      attempt.taxonomy_version !== input.taxonomyVersion
    ) {
      throw new ProjectClassifierError("attempt_mismatch", "attemptId is not in flight for this item, lease and versions", {
        attemptId: input.attemptId,
        attemptStatus: attempt?.status ?? null,
      });
    }
    this.db
      .prepare(`UPDATE classification_attempts SET status = 'written', retry_after = NULL, updated_at = ? WHERE attempt_id = ?`)
      .run(this.now().toISOString(), attempt.attempt_id);
  }

  getById(projectId: string): ProjectClassification | null {
    const row = this.db
      .prepare(`SELECT * FROM project_classifications WHERE project_id = ?`)
      .get(projectId) as ProjectClassificationRow | undefined;
    return row ? this.rowToProject(row) : null;
  }

  getByStreamItemId(streamItemId: string): ProjectClassification | null {
    const row = this.db
      .prepare(`SELECT * FROM project_classifications WHERE stream_item_id = ?`)
      .get(streamItemId) as ProjectClassificationRow | undefined;
    return row ? this.rowToProject(row) : null;
  }

  list(opts?: ProjectListOptions): ProjectClassification[] {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.classifierSession) {
      conditions.push("classifier_session = ?");
      params.push(opts.classifierSession);
    }
    if (opts?.classificationDestination) {
      conditions.push("classification_destination = ?");
      params.push(opts.classificationDestination);
    }
    if (opts?.area) {
      conditions.push("area = ?");
      params.push(opts.area);
    }
    if (opts?.scopeRef) {
      conditions.push("scope_ref = ?");
      params.push(opts.scopeRef);
    }
    if (opts?.needsHuman === "true") conditions.push("needs_human = 1");
    else if (opts?.needsHuman === "false") conditions.push("needs_human = 0");
    else if (opts?.needsHuman === "unknown") conditions.push("needs_human IS NULL");
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM project_classifications ${where} ORDER BY ts_projected DESC LIMIT ?`,
      )
      .all(...params) as ProjectClassificationRow[];
    return rows.map((r) => this.rowToProject(r));
  }

  private getByIdOrThrow(projectId: string): ProjectClassification {
    const p = this.getById(projectId);
    if (!p) {
      throw new ProjectClassifierError(
        "project_not_found",
        `project ${projectId} not found after write`,
      );
    }
    return p;
  }

  private rowToProject(row: ProjectClassificationRow): ProjectClassification {
    return {
      projectId: row.project_id,
      streamItemId: row.stream_item_id,
      classificationType: row.classification_type,
      classificationUrgency: row.classification_urgency,
      classificationMaturity: row.classification_maturity,
      classificationConfidence: row.classification_confidence,
      classificationDestination: row.classification_destination,
      action: row.action,
      area: row.area ?? null,
      scopeRef: row.scope_ref ?? null,
      duplicateOfStreamItemId: row.duplicate_of_stream_item_id ?? null,
      needsHuman: row.needs_human === 1 ? true : row.needs_human === 0 ? false : null,
      leaseId: row.lease_id ?? null,
      classifierVersion: row.classifier_version ?? null,
      taxonomyVersion: row.taxonomy_version ?? null,
      candidateSetVersion: row.candidate_set_version ?? null,
      classifierSession: row.classifier_session,
      tsProjected: row.ts_projected,
      identityProvenance: row.identity_provenance ?? null,
    };
  }
}

/** 被消费的可选字符串字段：提供时必须是 string，不能是 null/number/object。 */
const OPTIONAL_STRING_FIELDS = [
  "attemptId", "executionId",
  "classificationType", "classificationUrgency", "classificationMaturity",
  "classificationConfidence", "classificationDestination", "action",
  "area", "scopeRef", "duplicateOfStreamItemId",
  "classifierVersion", "taxonomyVersion", "candidateSetVersion",
] as const;
/** ID 与版本也不得为空白；自由文本标签字段可为任意字符串。 */
const NON_BLANK_FIELDS = new Set<string>([
  "attemptId", "executionId", "scopeRef", "duplicateOfStreamItemId",
  "classifierVersion", "taxonomyVersion", "candidateSetVersion",
]);

/**
 * 只检查被消费字段的结构（S02 P1）。标签值仍由智能体裁定；后台服务在执行任何 SQL 前，
 * 检查代码实际依赖的内容。除 needsHuman（boolean、null 表示 unknown，或省略）外，
 * 其他字段均为字符串或省略。
 */
function validateClassifyInput(input: ProjectClassifyInput): void {
  const raw = input as unknown as Record<string, unknown>;
  if (input.identityProvenance !== undefined && !["transport:v1", "relay:v1", "claimed:v1", "origin-unknown:v1"].includes(input.identityProvenance)) {
    throw new ProjectClassifierError("invalid_field", "unknown identity provenance", { field: "identityProvenance" });
  }
  for (const field of ["streamItemId", "classifierSession"] as const) {
    if (typeof raw[field] !== "string" || (raw[field] as string).trim() === "") {
      throw new ProjectClassifierError("invalid_field", `${field} must be a non-empty string`, { field });
    }
  }
  if (typeof input.leaseId !== "string" || input.leaseId.trim() === "") {
    throw new ProjectClassifierError(
      "lease_id_required",
      "leaseId is required: bind the result to the lease it was computed under (rig project lease-acquire returns it)",
    );
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || (NON_BLANK_FIELDS.has(field) && value.trim() === "")) {
      throw new ProjectClassifierError(
        "invalid_field",
        `${field} must be ${NON_BLANK_FIELDS.has(field) ? "a non-empty string" : "a string"} when supplied`,
        { field },
      );
    }
  }
  if (input.needsHuman !== undefined && input.needsHuman !== null && typeof input.needsHuman !== "boolean") {
    throw new ProjectClassifierError("invalid_needs_human", "needsHuman must be true, false or null (unknown)");
  }
  if (input.duplicateOfStreamItemId !== undefined && input.duplicateOfStreamItemId === input.streamItemId) {
    throw new ProjectClassifierError("invalid_duplicate_of", "an item cannot be a duplicate of itself");
  }
  if (input.scopeRef !== undefined && !input.candidateSetVersion) {
    throw new ProjectClassifierError(
      "candidate_set_version_required",
      "scopeRef must be bound to the scope candidate-set version it was chosen from",
    );
  }
  if (input.attemptId !== undefined && (!input.classifierVersion || !input.taxonomyVersion)) {
    throw new ProjectClassifierError(
      "attempt_versions_required",
      "a result bound to an attemptId must carry classifierVersion and taxonomyVersion",
    );
  }
  if (input.attemptId !== undefined && input.executionId === undefined) {
    throw new ProjectClassifierError(
      "execution_id_required",
      "a result bound to an attemptId must carry the executionId returned by its begin()",
    );
  }
}
