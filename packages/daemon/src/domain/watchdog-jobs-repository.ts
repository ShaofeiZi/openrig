import type Database from "better-sqlite3";
import { ulid } from "ulid";

/**
 * 看门狗任务仓库（PL-004 Phase C，并在 Phase D 扩展）。
 *
 * 负责对 `watchdog_jobs` 的所有读写。这里只做持久化，不涉及 event-bus、调度器或
 * 策略分发；由调度器与策略引擎组合使用。
 *
 * 接受的策略值包括编排器批准的 Phase C 集合，以及后台服务原生的工作流、空闲门禁
 * 和上下文用量条件：
 *   - periodic-reminder (Phase C)
 *   - artifact-pool-ready (Phase C)
 *   - edge-artifact-required (Phase C)
 *   - workflow-keepalive (Phase D)
 *   - idle-gate-qitem
 *   - context-usage-threshold
 *
 * PHASE_C_POLICIES 作为弃用别名保留给仍引用它的调用方；新代码使用
 * PHASE_D_POLICIES。
 */

export const PHASE_D_POLICIES = [
  "periodic-reminder",
  "artifact-pool-ready",
  "edge-artifact-required",
  "workflow-keepalive",
  // OPR.0.4.3.16 —— 空闲席位门禁看门狗。由数据库 queue_items 和共享仲裁
  // SeatActivityService 判定源支撑，在启动时通过 WatchdogPolicyEngine
  // additionalPolicies 注入（与 workflow-keepalive 相同）。
  "idle-gate-qitem",
  "context-usage-threshold",
  // OPR.0.5.6.24 F-14 —— 单一工作组级 parked-owner 消费者：将已领取的开放义务与
  // 经仲裁的空闲判定关联，每个停放阶段只唤醒一次。与 idle-gate-qitem 一样通过
  // additionalPolicies 注入。
  "parked-owner-consumer",
  // OPR.0.5.6.1 AM-F1 —— 按裁定在此基础设施上承载交付规则引擎的两个计时分支
  // （不引入第三套定时器）：一次性的离开升级延迟，以及重复的 C/D 摘要窗口刷新。
  // 与 parked-owner-consumer 一样通过 additionalPolicies 注入。
  "delivery-deferral",
  "delivery-digest-flush",
] as const;

/** 自 Phase D 起弃用，请使用 PHASE_D_POLICIES。 */
export const PHASE_C_POLICIES = PHASE_D_POLICIES;

export type WatchdogPolicyName = (typeof PHASE_D_POLICIES)[number];

export type WatchdogJobState = "active" | "stopped" | "terminal";

export interface WatchdogJob {
  jobId: string;
  policy: WatchdogPolicyName;
  specYaml: string;
  targetSession: string;
  intervalSeconds: number;
  activeWakeIntervalSeconds: number | null;
  scanIntervalSeconds: number | null;
  lastEvaluationAt: string | null;
  lastFireAt: string | null;
  actionable: boolean;
  lastActionableAt: string | null;
  state: WatchdogJobState;
  registeredBySession: string;
  registeredAt: string;
  terminalReason: string | null;
  /** (e/Class-B) 启用此任务的占用者 atom-B 代际；null 表示 UNKNOWN/迁移 063 前。 */
  registeredByGeneration: string | null;
  /** (i-c) 可选的目标占用者代次，此唤醒与其绑定；null 表示按角色绑定，即向当时占用该席位名的
   * 对象触发。只有非 null 值才让任务进入触发时代次守卫。 */
  targetGeneration: string | null;
  /** transcript 字节条件状态；其他策略中为 null。 */
  watchedFilePath: string | null;
  /** 使 watchedFilePath 合格的占用者代际。 */
  watchedFileGeneration: string | null;
  /** 所生成 transcript 绑定的可见生命周期。 */
  bindingState: "pending-binding" | "bound" | null;
  thresholdBytes: number | null;
  requiresJobId: string | null;
  /** 最近一次触发此阈值的占用者代际。 */
  lastFiredGeneration: string | null;
}

export interface RegisterWatchdogJobInput {
  policy: string;
  specYaml: string;
  targetSession: string;
  intervalSeconds: number;
  activeWakeIntervalSeconds?: number | null;
  scanIntervalSeconds?: number | null;
  registeredBySession: string;
  /** (i-c) 可选：此唤醒绑定的占用者代次。省略/null 表示按角色绑定，这是常见情况，仍向当时占用
   * 席位的对象触发。非 null 值启用触发时代次守卫。 */
  targetGenerationUuid?: string | null;
  watchedFilePath?: string | null;
  thresholdBytes?: number | null;
  requiresJobId?: string | null;
}

export type EnsureAutoRegistrationInput = RegisterWatchdogJobInput;

interface JobRow {
  job_id: string;
  policy: string;
  spec_yaml: string;
  target_session: string;
  interval_seconds: number;
  active_wake_interval_seconds: number | null;
  scan_interval_seconds: number | null;
  last_evaluation_at: string | null;
  last_fire_at: string | null;
  actionable: number;
  last_actionable_at: string | null;
  state: string;
  registered_by_session: string;
  registered_at: string;
  terminal_reason: string | null;
  registered_by_generation_uuid?: string | null;
  target_generation_uuid?: string | null;
  watched_file_path?: string | null;
  watched_file_generation_uuid?: string | null;
  threshold_bytes?: number | null;
  requires_job_id?: string | null;
  last_fired_generation_uuid?: string | null;
}

export class WatchdogJobsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WatchdogJobsError";
  }
}

/** 防御性检测新增列（对应 queue-repository 的 detectQueueColumn）：数据库早于迁移
 * 063 的测试夹具缺少代际列，因此写入方降级而非抛错。 */
function detectWatchdogColumn(db: Database.Database, columnName: string): boolean {
  try {
    return db.prepare("PRAGMA table_info(watchdog_jobs)").all()
      .some((row) => (row as { name?: string }).name === columnName);
  } catch {
    return false;
  }
}

export class WatchdogJobsRepository {
  private readonly hasGenColumn: boolean;
  private readonly hasTargetGenColumn: boolean;
  private readonly hasContextUsageColumns: boolean;
  private readonly hasWatchedFileGenerationColumn: boolean;
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
    // GHOST-STAGE（e/Class-B）：解析登记任务时占用者的 atom-B 代次，使任务携带登记它的代次。
    // null/缺失表示 UNKNOWN，列保持 NULL，切换时的代次谓词永远不会匹配它，未知项绝不被删除。
    // 由启动流程注入 SessionRegistry。
    private readonly resolveOccupantGeneration?: (sessionName: string) => string | null,
  ) {
    this.hasGenColumn = detectWatchdogColumn(db, "registered_by_generation_uuid");
    this.hasTargetGenColumn = detectWatchdogColumn(db, "target_generation_uuid");
    this.hasContextUsageColumns = detectWatchdogColumn(db, "last_fired_generation_uuid");
    this.hasWatchedFileGenerationColumn = detectWatchdogColumn(db, "watched_file_generation_uuid");
  }

  register(input: RegisterWatchdogJobInput): WatchdogJob {
    if (!PHASE_D_POLICIES.includes(input.policy as WatchdogPolicyName)) {
      throw new WatchdogJobsError(
        "policy_unknown",
        `未知看门狗策略“${input.policy}”；Phase D v1 支持：${PHASE_D_POLICIES.join(", ")}`,
        { policy: input.policy, supported: [...PHASE_D_POLICIES] },
      );
    }
    if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds <= 0) {
      throw new WatchdogJobsError(
        "interval_invalid",
        `interval_seconds 必须是正整数（收到 ${input.intervalSeconds}）`,
        { intervalSeconds: input.intervalSeconds },
      );
    }
    if (!input.targetSession || !input.targetSession.includes("@")) {
      throw new WatchdogJobsError(
        "target_session_invalid",
        `target_session 必须是规范的“<member>@<rig>”（收到“${input.targetSession}”）`,
        { targetSession: input.targetSession },
      );
    }
    const isContextUsageThreshold = input.policy === "context-usage-threshold";
    if (isContextUsageThreshold && !this.hasContextUsageColumns) {
      throw new WatchdogJobsError(
        "context_usage_schema_missing",
        "context-usage-threshold 需要迁移 074_context_usage_watchdog",
      );
    }
    if (
      isContextUsageThreshold &&
      (!Number.isInteger(input.thresholdBytes) || (input.thresholdBytes ?? 0) <= 0)
    ) {
      throw new WatchdogJobsError(
        "threshold_invalid",
        `threshold_bytes 必须是正整数（收到 ${String(input.thresholdBytes)}）`,
      );
    }
    const generatedContinuityJob =
      input.registeredBySession === "daemon@kernel" &&
      input.specYaml.includes("generated_by: continuity-policy-materializer") &&
      /continuity_mode: (managed-compaction|apprentice-handover)/.test(input.specYaml);
    if (isContextUsageThreshold && !input.watchedFilePath && !generatedContinuityJob) {
      throw new WatchdogJobsError(
        "watched_file_unresolved",
        `无法为 ${input.targetSession} 解析 transcript 文件`,
        { targetSession: input.targetSession },
      );
    }
    if (isContextUsageThreshold && input.requiresJobId && !this.getById(input.requiresJobId)) {
      throw new WatchdogJobsError(
        "requires_job_not_found",
        `所需看门狗任务 ${input.requiresJobId} 不存在`,
        { requiresJobId: input.requiresJobId },
      );
    }
    const jobId = ulid();
    const registeredAt = this.now().toISOString();
    // (e/Class-B)：写入登记时占用者的代次，使切换可停止这一代登记的任务；陈旧唤醒进入继任者
    // 上下文就是幽灵问题。无法解析或迁移 063 前为 NULL。
    const registeredByGeneration = this.hasGenColumn
      ? (this.resolveOccupantGeneration?.(input.registeredBySession) ?? null)
      : null;
    // (i-c) 可选目标代次：由调用方提供，NULL 表示按角色绑定。仅在 066 列存在时存储；
    // 066 之前的数据库会将该可选能力静默降级为按角色绑定。066 蕴含 063（增量顺序）。
    const targetGenerationUuid = this.hasTargetGenColumn ? (input.targetGenerationUuid ?? null) : null;
    const watchedFileGeneration = isContextUsageThreshold && input.watchedFilePath
      ? (this.resolveOccupantGeneration?.(input.targetSession) ?? null)
      : null;
    const columns = [
      "job_id", "policy", "spec_yaml", "target_session", "interval_seconds",
      "active_wake_interval_seconds", "scan_interval_seconds", "state",
      "registered_by_session", "registered_at",
    ];
    const values: unknown[] = [
      jobId, input.policy, input.specYaml, input.targetSession, input.intervalSeconds,
      input.activeWakeIntervalSeconds ?? null, input.scanIntervalSeconds ?? null, "active",
      input.registeredBySession, registeredAt,
    ];
    if (this.hasGenColumn) {
      columns.push("registered_by_generation_uuid");
      values.push(registeredByGeneration);
    }
    if (this.hasTargetGenColumn) {
      columns.push("target_generation_uuid");
      values.push(targetGenerationUuid);
    }
    if (this.hasContextUsageColumns) {
      columns.push(
        "watched_file_path",
        "threshold_bytes",
        "requires_job_id",
        "last_fired_generation_uuid",
      );
      values.push(
        isContextUsageThreshold ? input.watchedFilePath : null,
        isContextUsageThreshold ? input.thresholdBytes : null,
        isContextUsageThreshold ? (input.requiresJobId ?? null) : null,
        null,
      );
    }
    if (this.hasWatchedFileGenerationColumn) {
      columns.push("watched_file_generation_uuid");
      values.push(watchedFileGeneration);
    }
    this.db
      .prepare(
        `INSERT INTO watchdog_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...values);
    return this.getByIdOrThrow(jobId);
  }

  /** 在指定席位占用者代际期间采样的 transcript 路径。 */
  findTranscriptPath(
    targetSession: string,
    occupantGeneration = this.resolveOccupantGeneration?.(targetSession) ?? null,
  ): string | null {
    if (!occupantGeneration) return null;
    const row = this.db
      .prepare(
        `SELECT usage.transcript_path
           FROM sessions AS session
           JOIN occupant_tenures AS tenure
             ON tenure.node_id = session.node_id
            AND tenure.generation_uuid = ?
           JOIN context_usage AS usage
             ON usage.node_id = session.node_id
          WHERE session.session_name = ?
            AND usage.session_name = ?
            AND usage.transcript_path IS NOT NULL
            AND usage.transcript_path != ''
            AND usage.sampled_at IS NOT NULL
            AND julianday(usage.sampled_at) >= julianday(tenure.boot_at)
          ORDER BY session.id DESC
          LIMIT 1`,
      )
      .get(occupantGeneration, targetSession, targetSession) as { transcript_path: string } | undefined;
    return row?.transcript_path ?? null;
  }

  recordWatchedFileBinding(jobId: string, watchedFilePath: string, occupantGeneration: string): void {
    if (!this.hasWatchedFileGenerationColumn) {
      throw new WatchdogJobsError(
        "context_usage_generation_schema_missing",
        "context-usage-threshold 代际绑定需要迁移 075_context_usage_watchdog_generation",
      );
    }
    this.db
      .prepare(
        `UPDATE watchdog_jobs
            SET watched_file_path = ?, watched_file_generation_uuid = ?
          WHERE job_id = ?`,
      )
      .run(watchedFilePath, occupantGeneration, jobId);
  }

  recordThresholdFire(jobId: string, occupantGeneration: string, firedAt: string): void {
    if (!this.hasContextUsageColumns) {
      throw new WatchdogJobsError(
        "context_usage_schema_missing",
        "context-usage-threshold 需要迁移 074_context_usage_watchdog",
      );
    }
    this.db
      .prepare(
        `UPDATE watchdog_jobs
         SET last_fired_generation_uuid = ?, last_evaluation_at = ?, last_fire_at = ?
         WHERE job_id = ?`,
      )
      .run(occupantGeneration, firedAt, firedAt, jobId);
  }

  /**
   * 确保后台服务所有、按角色绑定的自动登记元组恰好有一条非终态记录。stopped 是
   * 操作员主动退出，因此与 active 一样持久；仅含终态历史时会被替换。表中没有唯一
   * 约束，所以必须检查每条匹配记录。
   */
  ensureAutoRegistration(
    input: EnsureAutoRegistrationInput,
    historicalTargetSessions: string[] = [input.targetSession],
  ): WatchdogJob {
    const existing = this.findAutoRegistration(
      input.policy,
      input.targetSession,
      input.targetGenerationUuid ?? null,
      historicalTargetSessions,
    );
    if (existing) {
      this.db.prepare(
        `UPDATE watchdog_jobs
            SET spec_yaml = ?, target_session = ?, interval_seconds = ?,
                active_wake_interval_seconds = ?, scan_interval_seconds = ?
          WHERE job_id = ?`,
      ).run(
        input.specYaml,
        input.targetSession,
        input.intervalSeconds,
        input.activeWakeIntervalSeconds ?? null,
        input.scanIntervalSeconds ?? null,
        existing.jobId,
      );
      return this.getByIdOrThrow(existing.jobId);
    }
    return this.register(input);
  }

  /**
   * 在节点所有历史会话别名中解析唯一一条 active/stopped 角色绑定记录。持久化状态
   * 刻意采用闭集；未知值既不是可运行任务，也不是操作员主动退出。
   */
  findAutoRegistration(
    policy: string,
    targetSession: string,
    targetGenerationUuid: string | null,
    historicalTargetSessions: string[] = [targetSession],
  ): WatchdogJob | null {
    const rows = this.listAliasTuples(policy, historicalTargetSessions, targetGenerationUuid);
    const invalid = rows.filter((row) =>
      row.state !== "active" && row.state !== "stopped" && row.state !== "terminal"
    );
    if (invalid.length > 0) {
      throw new WatchdogJobsError(
        "auto_registration_state_invalid",
        `auto_registration_state_invalid：${policy}/${targetSession} 的自动登记存在无效持久化状态`,
        {
          policy,
          targetSession,
          targetGenerationUuid,
          rows: invalid.map((row) => ({ jobId: row.jobId, state: row.state })),
        },
      );
    }
    const nonterminal = rows.filter((row) => row.state === "active" || row.state === "stopped");
    if (nonterminal.length > 1) {
      throw new WatchdogJobsError(
        "auto_registration_ambiguous",
        `${policy}/${targetSession} 的自动登记有歧义：存在 ${nonterminal.length} 条非终态记录`,
        {
          policy,
          targetSession,
          targetGenerationUuid,
          rows: nonterminal.map((row) => ({ jobId: row.jobId, state: row.state })),
        },
      );
    }
    return nonterminal[0] ?? null;
  }

  /** 精确策略/席位/代际元组的所有记录，包括历史。 */
  listExactTuple(
    policy: string,
    targetSession: string,
    targetGenerationUuid: string | null,
  ): WatchdogJob[] {
    const targetClause = this.hasTargetGenColumn
      ? "target_generation_uuid IS ?"
      : targetGenerationUuid === null
        ? "1 = 1"
        : "0 = 1";
    const params = this.hasTargetGenColumn
      ? [policy, targetSession, targetGenerationUuid]
      : [policy, targetSession];
    const rows = this.db.prepare(
      `SELECT * FROM watchdog_jobs
       WHERE policy = ? AND target_session = ? AND ${targetClause}
       ORDER BY registered_at ASC, job_id ASC`,
    ).all(...params) as JobRow[];
    return rows.map(rowToJob);
  }

  private listAliasTuples(
    policy: string,
    targetSessions: string[],
    targetGenerationUuid: string | null,
  ): WatchdogJob[] {
    const aliases = [...new Set(targetSessions)];
    if (aliases.length === 0) return [];
    const targetClause = this.hasTargetGenColumn
      ? "target_generation_uuid IS ?"
      : targetGenerationUuid === null
        ? "1 = 1"
        : "0 = 1";
    const placeholders = aliases.map(() => "?").join(", ");
    const params = this.hasTargetGenColumn
      ? [policy, ...aliases, targetGenerationUuid]
      : [policy, ...aliases];
    const rows = this.db.prepare(
      `SELECT * FROM watchdog_jobs
       WHERE policy = ? AND target_session IN (${placeholders}) AND ${targetClause}
       ORDER BY registered_at ASC, job_id ASC`,
    ).all(...params) as JobRow[];
    return rows.map(rowToJob);
  }

  getById(jobId: string): WatchdogJob | null {
    const row = this.db
      .prepare(`SELECT * FROM watchdog_jobs WHERE job_id = ?`)
      .get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  getByIdOrThrow(jobId: string): WatchdogJob {
    const job = this.getById(jobId);
    if (!job) {
      throw new WatchdogJobsError(
        "job_not_found",
        `未找到看门狗任务 ${jobId}`,
        { jobId },
      );
    }
    return job;
  }

  listAll(): WatchdogJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_jobs ORDER BY registered_at ASC`)
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  listActive(): WatchdogJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_jobs WHERE state = 'active' ORDER BY registered_at ASC`)
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  recordEvaluation(jobId: string, evaluatedAt: string, fired: boolean): void {
    if (fired) {
      this.db
        .prepare(
          `UPDATE watchdog_jobs SET last_evaluation_at = ?, last_fire_at = ? WHERE job_id = ?`,
        )
        .run(evaluatedAt, evaluatedAt, jobId);
    } else {
      this.db
        .prepare(`UPDATE watchdog_jobs SET last_evaluation_at = ? WHERE job_id = ?`)
        .run(evaluatedAt, jobId);
    }
  }

  /** 所有者调整持久提醒计划时保留任务身份。 */
  updateSchedule(jobId: string, specYaml: string, intervalSeconds: number, lastEvaluationAt: string | null): void {
    this.db.prepare(`UPDATE watchdog_jobs SET spec_yaml = ?, interval_seconds = ?, last_evaluation_at = ?
      WHERE job_id = ? AND state = 'active'`).run(specYaml, intervalSeconds, lastEvaluationAt, jobId);
  }

  /**
   * R1 修复：写入可操作状态机列。对应 POC 引擎的 `state.actionable` 与
   * `state.last_actionable_at`。策略引擎在每次有意义的评估后调用：
   *   - newActionable=false（跳过）：清除 actionable 与 last_actionable_at。
   *   - newActionable=true 且无 preserveLastActionableAt：把 last_actionable_at
   *     标记为 evaluatedAt（新近变为可操作）。
   *   - newActionable=true 且设置 preserveLastActionableAt：保留首次可操作时间戳
   *     （延续可操作窗口）。
   */
  setActionable(
    jobId: string,
    newActionable: boolean,
    evaluatedAt: string,
    preserveLastActionableAt: string | null = null,
  ): void {
    if (!newActionable) {
      this.db
        .prepare(
          `UPDATE watchdog_jobs SET actionable = 0, last_actionable_at = NULL WHERE job_id = ?`,
        )
        .run(jobId);
      return;
    }
    const stamp = preserveLastActionableAt ?? evaluatedAt;
    this.db
      .prepare(
        `UPDATE watchdog_jobs SET actionable = 1, last_actionable_at = ? WHERE job_id = ?`,
      )
      .run(stamp, jobId);
  }

  /**
   * OPR.0.5.8.1 S2 —— 记录任务最近一次成功唤醒所针对的条件。
   *
   * 仅在交付返回 `ok` 后由引擎调用。按“已经告知”抑制的策略必须把回执绑定到确已
   * 告知的证据；若在尝试时就记录，一次传输失败会造成无限静默。每个任务只覆盖
   * 一个值，绝不追加。
   */
  recordConditionReceipt(jobId: string, receipt: string): void {
    this.db
      .prepare(`UPDATE watchdog_jobs SET last_fired_condition = ? WHERE job_id = ?`)
      .run(receipt, jobId);
  }

  markTerminal(jobId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE watchdog_jobs SET state = 'terminal', terminal_reason = ? WHERE job_id = ?`,
      )
      .run(reason, jobId);
  }

  stop(jobId: string, reason = "operator_stopped"): WatchdogJob {
    const existing = this.getByIdOrThrow(jobId);
    if (existing.state === "terminal") {
      throw new WatchdogJobsError(
        "job_terminal",
        `无法停止看门狗任务 ${jobId}：状态已是 terminal`,
        { jobId, state: existing.state },
      );
    }
    if (existing.state === "stopped") return existing;
    this.db
      .prepare(`UPDATE watchdog_jobs SET state = 'stopped', terminal_reason = ? WHERE job_id = ?`)
      .run(reason, jobId);
    return this.getByIdOrThrow(jobId);
  }

  /**
   * GHOST-STAGE（e/Class-B）：席位切换时，停止所有由退役代际登记且已启用
   * （state='active'）的任务；故障样本是陈旧唤醒进入继任者上下文，继任者会自行
   * 重新启用。范围按代际而非名称限定（继任者共享席位名，按名称停止会误杀其任务）。
   * NULL/空代际永不匹配（UNKNOWN ≠ retired，note-2）。返回停止数。通过
   * terminal_reason 可审计，不做硬删除，记录保留供取证。迁移 063 前数据库不操作。
   */
  dropArmedByRegisteringGeneration(generationUuid: string): number {
    if (!this.hasGenColumn || !generationUuid) return 0;
    const res = this.db
      .prepare(
        `UPDATE watchdog_jobs SET state = 'stopped', terminal_reason = 'registering generation retired (seat handover)'
         WHERE state = 'active' AND registered_by_generation_uuid = ?`,
      )
      .run(generationUuid);
    return res.changes;
  }
}

function rowToJob(row: JobRow): WatchdogJob {
  return {
    jobId: row.job_id,
    policy: row.policy as WatchdogPolicyName,
    specYaml: row.spec_yaml,
    targetSession: row.target_session,
    intervalSeconds: row.interval_seconds,
    activeWakeIntervalSeconds: row.active_wake_interval_seconds,
    scanIntervalSeconds: row.scan_interval_seconds,
    lastEvaluationAt: row.last_evaluation_at,
    lastFireAt: row.last_fire_at,
    actionable: row.actionable !== 0,
    lastActionableAt: row.last_actionable_at,
    state: row.state as WatchdogJobState,
    registeredBySession: row.registered_by_session,
    registeredAt: row.registered_at,
    terminalReason: row.terminal_reason,
    registeredByGeneration: row.registered_by_generation_uuid ?? null,
    targetGeneration: row.target_generation_uuid ?? null,
    watchedFilePath: row.watched_file_path ?? null,
    watchedFileGeneration: row.watched_file_generation_uuid ?? null,
    bindingState: row.policy === "context-usage-threshold"
      ? (row.watched_file_path && row.watched_file_generation_uuid ? "bound" : "pending-binding")
      : null,
    thresholdBytes: row.threshold_bytes ?? null,
    requiresJobId: row.requires_job_id ?? null,
    lastFiredGeneration: row.last_fired_generation_uuid ?? null,
  };
}
