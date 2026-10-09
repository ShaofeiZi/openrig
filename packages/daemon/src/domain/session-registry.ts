import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { randomUUID } from "node:crypto";

const ulid = monotonicFactory();
import type { Session, Binding } from "./types.js";
import { validateSessionName } from "./session-name.js";
import { formatWatchdogRegistrationError } from "./watchdog-auto-registration.js";

// GHOST-STAGE atom-B（P12 3548d8eb）——占用者代次任期。
export type OccupantKind = "initial" | "handover" | "adopt" | "fresh";
export interface OccupantTenure {
  id: string;
  nodeId: string;
  generationOrdinal: number;
  generationUuid: string;
  kind: OccupantKind;
  nativeSessionIdAtBoot: string | null;
  bootAt: string;
}
interface OccupantTenureRow {
  id: string;
  node_id: string;
  generation_ordinal: number;
  generation_uuid: string;
  kind: string;
  native_session_id_at_boot: string | null;
  boot_at: string;
}

interface BindingFields {
  attachmentType?: "tmux" | "external_cli";
  tmuxSession?: string;
  tmuxWindow?: string;
  tmuxPane?: string;
  externalSessionName?: string;
  cmuxWorkspace?: string;
  cmuxSurface?: string;
}

/** Resume-token provenance 优先级（OPR.0.4.0.22；adoption rung 由 OPR.0.4.3.20 FR-3
 *  增加）。高 rank 胜出；低 rank 写入绝不覆盖高 rank persisted token。
 *  operator/attested（有意设置）> hook（运行时自报）> adoption
 *  （在 reconcile/adopt/bind boundary capture）> scrape（pane）。adoption 有意低于 hook：live
 *  runtime hook self-report 比 adoption-time snapshot 更新，因此 hook 必须能 refresh adoption token
 *  （FR-3 §2.4——不要在 adoption 时冻结 token，以免重新引入 survive slice 要消除的 staleness）。 */
export const RESUME_PROVENANCE_RANK: Record<string, number> = {
  scrape: 0,
  adoption: 1,
  hook: 2,
  operator: 3,
};

/** OPR.0.4.3.20 FR-4——每个 node 最新的 live session；resume-metadata refresher 所需 shape
 *  （结构兼容 ResumeRefreshSession）。 */
export interface LatestLiveSession {
  nodeId: string;
  sessionId: string;
  sessionName: string;
  status: string;
  runtime: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  cwd: string | null;
}

export interface WatchdogRegistrationObserver {
  ensure(nodeId: string, sessionName: string): unknown;
  assertCoverage(nodeId: string, sessionName: string): unknown;
  isEligibleSessionName?(sessionName: string): boolean;
  reconcileHandover?(nodeId: string, sessionName: string): unknown;
}

export class SessionRegistry {
  readonly db: Database.Database;
  private watchdogRegistrationObserver?: WatchdogRegistrationObserver;
  constructor(db: Database.Database, watchdogRegistrationObserver?: WatchdogRegistrationObserver) {
    this.db = db;
    this.watchdogRegistrationObserver = watchdogRegistrationObserver;
  }

  setWatchdogRegistrationObserver(observer: WatchdogRegistrationObserver): void {
    this.watchdogRegistrationObserver = observer;
  }

  registerSession(
    nodeId: string,
    sessionName: string,
    kind: OccupantKind = "initial",
    reservedGeneration?: string | null,
  ): Session {
    if (!validateSessionName(sessionName)) {
      throw new Error(
        `无效 session name "${sessionName}"：必须匹配 legacy r{NN}-{suffix} 或 canonical {pod}-{member}@{rig} 格式，允许字符为 a-z、A-Z、0-9、-、_、.、@`
      );
    }

    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)"
      )
      .run(id, nodeId, sessionName);
    this.mintOccupantTenureBestEffort(nodeId, kind, reservedGeneration); // atom-B：生成此 occupant generation
    this.observeWatchdogRegistration(nodeId, sessionName, kind);
    return this.rowToSession(
      this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow
    );
  }

  /** 注册 claimed session——跳过命名 validation，设置 origin='claimed'、startup_status='ready'。 */
  registerClaimedSession(
    nodeId: string,
    sessionName: string,
    kind: OccupantKind = "adopt",
    reservedGeneration?: string | null,
  ): Session {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO sessions (id, node_id, session_name, status, origin, startup_status) VALUES (?, ?, ?, 'running', 'claimed', 'ready')"
      )
      .run(id, nodeId, sessionName);
    this.mintOccupantTenureBestEffort(nodeId, kind, reservedGeneration); // atom-B：生成此 occupant generation
    this.observeWatchdogRegistration(nodeId, sessionName, kind);

    return this.rowToSession(
      this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow
    );
  }

  /**
   * atom-B——为 node 生成（或继续）occupant-generation tenure。RELAUNCH 是 CONTINUATION：若同一
   * native session id 已为此 node 记录，则返回现有 tenure，不生成新 generation。新 occupant
   *（initial/handover/adopt，或新的/未知 native session）用 fresh generation_uuid 生成下一个
   * generation_ordinal。append-only——ledger 永不修改。（Relaunch 也会因不再次调用 register verb
   * 而自然继续；这里的 native-session dedup 是 re-register 的安全网。）
   */
  /** atom-B——在 register verb 时生成 occupant tenure，但实行 FAIL-ISOLATED：session registration
   *  （核心操作）不得因增量 occupant-generation ledger 写入失败而终止（如 DB 尚未运行 migration
   *  060）。失败时显著记录 log（每个 process 一次——production 中缺失 ledger table 是可见 defect），
   *  并让 register 成功；generation-scoped consumer 降级为显著 pending，绝不静默出错。需要 tenure
   *  的直接 caller 使用会抛错的 `mintOccupantTenure`。 */
  private mintOccupantTenureBestEffort(
    nodeId: string,
    kind: OccupantKind,
    reservedGeneration?: string | null,
  ): void {
    try {
      this.mintOccupantTenure(nodeId, kind, null, reservedGeneration);
    } catch (e) {
      if (!SessionRegistry.tenureMintWarned) {
        SessionRegistry.tenureMintWarned = true;
        // 可归因（node_id + kind/verb），使 mint failure 可从 log 追踪（orch note 1）；每个 process
        // 只记录一次，避免刷屏 stale-migration DB，但首次失败会固定 node。
        console.warn(
          `[session-registry] node_id="${nodeId}"（kind=${kind}）的 occupant-tenure 生成失败：${(e as Error).message}——` +
            `registration 继续，但此 node 无法使用 generation-scoped ghost-stage protection。` +
            `请确保已运行 migration 060_occupant_tenures。（此 process 将抑制后续 mint failure。）`,
        );
      }
    }
  }
  private static tenureMintWarned = false;

  private observeWatchdogRegistration(nodeId: string, sessionName: string, kind: OccupantKind): void {
    const observer = this.watchdogRegistrationObserver;
    if (!observer) return;
    if (observer.isEligibleSessionName?.(sessionName) === false) {
      if (kind === "handover" && observer.reconcileHandover) {
        this.runWatchdogEnsure(nodeId, sessionName, () => observer.reconcileHandover!(nodeId, sessionName));
      }
      return;
    }
    this.runWatchdogEnsure(nodeId, sessionName, () => observer.ensure(nodeId, sessionName));
    try {
      observer.assertCoverage(nodeId, sessionName);
    } catch (error) {
      console.warn(
        `[session-registry] node_id="${nodeId}" 的 watchdog coverage 失败 ` +
        `session="${sessionName}"：${formatWatchdogRegistrationError(error)}`,
      );
    }
  }

  private runWatchdogEnsure(nodeId: string, sessionName: string, ensure: () => unknown): void {
    try {
      ensure();
    } catch (error) {
      if (!SessionRegistry.watchdogEnsureWarned) {
        SessionRegistry.watchdogEnsureWarned = true;
        console.warn(
          `[session-registry] node_id="${nodeId}" 的 watchdog auto-registration 失败 ` +
          `session="${sessionName}": ${formatWatchdogRegistrationError(error)} ` +
          `（此 process 将抑制后续 ensure failure）`,
        );
      }
    }
  }
  private static watchdogEnsureWarned = false;

  /** 在 managed process 启动前预留其将携带的 generation。capability probe 为只读：ledger 失败或
   *  缺失时返回 null，launch 继续且不伪造 state。 */
  reserveOccupantGeneration(): string | null {
    try {
      this.db.prepare("SELECT 1 FROM occupant_tenures LIMIT 1").get();
      return randomUUID();
    } catch {
      return null;
    }
  }

  /** 仅当此精确 generation 已为此精确 node 注册时为 true。ledger fault 时抛错，使 caller 可保留
   *  独立 generation_resolver_error verdict。 */
  isOccupantGenerationRegistered(nodeId: string, generationUuid: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM occupant_tenures WHERE node_id = ? AND generation_uuid = ? LIMIT 1",
    ).get(nodeId, generationUuid));
  }

  mintOccupantTenure(
    nodeId: string,
    kind: OccupantKind,
    nativeSessionIdAtBoot?: string | null,
    reservedGeneration?: string | null,
  ): OccupantTenure {
    if (nativeSessionIdAtBoot != null && nativeSessionIdAtBoot !== "") {
      const existing = this.db
        .prepare(
          "SELECT * FROM occupant_tenures WHERE node_id = ? AND native_session_id_at_boot = ? ORDER BY generation_ordinal DESC LIMIT 1"
        )
        .get(nodeId, nativeSessionIdAtBoot) as OccupantTenureRow | undefined;
      if (existing) return this.rowToTenure(existing); // continuation——不生成新 generation
    }
    const nextOrdinal =
      (((this.db
        .prepare("SELECT MAX(generation_ordinal) AS m FROM occupant_tenures WHERE node_id = ?")
        .get(nodeId) as { m: number | null }).m) ?? 0) + 1;
    const id = ulid();
    const generationUuid = reservedGeneration || randomUUID();
    this.db
      .prepare(
        "INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind, native_session_id_at_boot) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, nodeId, nextOrdinal, generationUuid, kind, nativeSessionIdAtBoot ?? null);
    return this.rowToTenure(
      this.db.prepare("SELECT * FROM occupant_tenures WHERE id = ?").get(id) as OccupantTenureRow
    );
  }

  /** node 的 live（最新）occupant generation，或 null。consumer 将 entry 的 minting
   *  generation_uuid 与其比较，以 gate stale-generation state（ghost-stage defect）。 */
  currentOccupantTenure(nodeId: string): OccupantTenure | null {
    const row = this.db
      .prepare("SELECT * FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1")
      .get(nodeId) as OccupantTenureRow | undefined;
    return row ? this.rowToTenure(row) : null;
  }

  /** ghost-stage（b）：当前支撑 session name 的 node 所对应 live occupant generation_uuid；UNKNOWN
   *  时为 null（无 session row / 无 node / 无 tenure——consumer 将 null 视为 UNKNOWN，绝不匹配
   *  stale generation）。这是 compaction enforcer 的 gen-scoped stage gate 所用 resolver。永不抛错
   *  （错误 lookup 返回 null）。 */
  currentOccupantGenerationForSession(sessionName: string): string | null {
    try {
      const row = this.db
        .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1")
        .get(sessionName) as { node_id: string } | undefined;
      if (!row) return null;
      return this.currentOccupantTenure(row.node_id)?.generationUuid ?? null;
    } catch {
      return null; // 任意 lookup failure 时为 UNKNOWN（例如 DB 没有 tenure ledger）
    }
  }

  private rowToTenure(row: OccupantTenureRow): OccupantTenure {
    return {
      id: row.id,
      nodeId: row.node_id,
      generationOrdinal: row.generation_ordinal,
      generationUuid: row.generation_uuid,
      kind: row.kind as OccupantKind,
      nativeSessionIdAtBoot: row.native_session_id_at_boot,
      bootAt: row.boot_at,
    };
  }

  updateStatus(sessionId: string, status: string): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, last_seen_at = datetime('now') WHERE id = ?")
      .run(status, sessionId);
  }

  updateStartupStatus(sessionId: string, status: "pending" | "ready" | "attention_required" | "failed", completedAt?: string): void {
    if (completedAt) {
      this.db
        .prepare("UPDATE sessions SET startup_status = ?, startup_completed_at = ? WHERE id = ?")
        .run(status, completedAt, sessionId);
    } else {
      this.db
        .prepare("UPDATE sessions SET startup_status = ? WHERE id = ?")
        .run(status, sessionId);
    }
  }

  // OPR.0.4.0.22——resume-token provenance 优先级。有意的 operator/attested set 具有权威性，
  // 优先于 runtime hook、adoption-boundary capture 与 pane scrape（hook > adoption > scrape）。
  // 低 rank 写入绝不能覆盖高 rank persisted token。
  //
  // OPR.0.4.3.20 FR-3——validity-before-rank guard：空或全 whitespace token 表示 SKIP，绝不写入。
  // “Flakiness = missing = no-write，而不是 bad write。”此检查在 rank comparison 前运行，因此没有
  // caller（flaky hook、adoption capture 或 scrape）能用空值替换有效 stored token，即使来源
  // provenance 更高。
  //
  // 返回是否真正写入：UPDATE 时为 `true`，空 token skip 或低 rank no-op 时为 `false`。只做
  // set-and-forget 的 caller 可忽略；adoption-capture 路径会使用它，避免 provenance guard 拒绝后
  // audit event 仍错误声称已完成 capture write。
  updateResumeToken(sessionId: string, type: string, token: string, provenance?: "hook" | "scrape" | "operator" | "adoption"): boolean {
    if (typeof token !== "string" || token.trim().length === 0) return false;
    if (provenance) {
      const existing = this.db.prepare(
        "SELECT resume_provenance FROM sessions WHERE id = ?"
      ).get(sessionId) as { resume_provenance: string | null } | undefined;
      const existingProv = existing?.resume_provenance ?? null;
      if (existingProv) {
        const existingRank = RESUME_PROVENANCE_RANK[existingProv] ?? -1;
        const newRank = RESUME_PROVENANCE_RANK[provenance] ?? -1;
        if (newRank < existingRank) return false; // 低 rank 不能覆盖高 rank
      }
    }
    const prov = provenance ?? null;
    // OPR.0.4.3.20 FR-6——stamp-on-verify（+ equal-value-refresh）：从 live state（重新）派生
    // token 本身就是 verification，因此每次成功写入都 refresh freshness marker，并将最后 probe
    // 标为 `resumable`，即使 token value 未改变（重新验证但未变化的 token 不得看似 untouched）。
    // plan 读取这些字段以计算 present/stale。
    this.db
      .prepare(
        "UPDATE sessions SET resume_type = ?, resume_token = ?, resume_provenance = COALESCE(?, resume_provenance), " +
          "resume_last_verified = datetime('now'), resume_last_probe_status = 'resumable' WHERE id = ?",
      )
      .run(type, token, prov, sessionId);
    return true;
  }

  /** 保留已尝试但未验证的 resume target。
   *
   * Attention outcome 包括 live chooser prompt、runner exit 与 readiness timeout，因此到达其中任一
   * 都不能证明 token 可 resume。只填充空 session row：并发 hook/operator write 是更强 evidence，
   * 必须胜出。 */
  recordResumeAttempt(sessionId: string, type: string, token: string): boolean {
    const normalizedType = type.trim();
    const normalizedToken = token.trim();
    if (!normalizedType || !normalizedToken) return false;
    const result = this.db
      .prepare(
        "UPDATE sessions SET resume_type = ?, resume_token = ?, resume_provenance = NULL, " +
          "resume_last_verified = NULL, resume_last_probe_status = NULL " +
          "WHERE id = ? AND (resume_token IS NULL OR trim(resume_token) = '') " +
          "AND resume_provenance IS NULL AND resume_last_verified IS NULL AND resume_last_probe_status IS NULL",
      )
      .run(normalizedType, normalizedToken, sessionId);
    return result.changes > 0;
  }

  /** OPR.0.4.3.20 FR-6——记录 live resume-probe outcome，但不清除 token。`resumable` 时盖
   *  freshness marker（equal-value-refresh）；`not_resumable` / `inconclusive` 时将现有 token 标为
   *  stale，使 restore plan 将其呈现为 `stale/unverified — re-verify`（绝不静默变成 null）。这替代
   *  旧 clear-on-not-resumable 行为（§2.1b）——token 保持原位；FR-7 blank/fresh rollback 在 restore
   *  时捕获真正无法 resume 的 token。 */
  markResumeProbeResult(sessionId: string, status: "resumable" | "not_resumable" | "inconclusive"): void {
    if (status === "resumable") {
      this.db
        .prepare("UPDATE sessions SET resume_last_verified = datetime('now'), resume_last_probe_status = 'resumable' WHERE id = ?")
        .run(sessionId);
      return;
    }
    this.db
      .prepare("UPDATE sessions SET resume_last_probe_status = ? WHERE id = ?")
      .run(status, sessionId);
  }

  /** OPR.0.4.0.22——将 canonical session name 解析为设置 resume token 所需 context：最新 session
   *  row + 其 node runtime + 当前 resume provenance。无匹配 session 时返回 null。 */
  findResumeContextByName(sessionName: string): {
    sessionId: string;
    nodeId: string;
    rigId: string;
    runtime: string | null;
    currentProvenance: string | null;
  } | null {
    const row = this.db.prepare(
      `SELECT s.id as session_id, s.node_id, n.rig_id, n.runtime, s.resume_provenance
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.session_name = ?
       ORDER BY s.created_at DESC, s.id DESC LIMIT 1`
    ).get(sessionName) as {
      session_id: string;
      node_id: string;
      rig_id: string;
      runtime: string | null;
      resume_provenance: string | null;
    } | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      nodeId: row.node_id,
      rigId: row.rig_id,
      runtime: row.runtime,
      currentProvenance: row.resume_provenance ?? null,
    };
  }

  clearResumeToken(sessionId: string): void {
    // OPR.0.4.3.20 FR-6——同时将 verification-freshness 列设为 null，使已清空 slot 不携带 orphan
    // freshness。注意：§2.1b 后 refresher validate 路径会 mark-stale 而非清除，因此 live 路径中没有
    // in-tree caller；为 explicit-clear caller/test 保留。
    this.db
      .prepare("UPDATE sessions SET resume_type = NULL, resume_token = NULL, resume_provenance = NULL, resume_last_verified = NULL, resume_last_probe_status = NULL WHERE id = ?")
      .run(sessionId);
  }

  markDetached(sessionId: string): void {
    this.updateStatus(sessionId, "detached");
  }

  markSuperseded(sessionId: string): void {
    this.updateStatus(sessionId, "superseded");
  }

  clearBinding(nodeId: string): void {
    this.db.prepare("DELETE FROM bindings WHERE node_id = ?").run(nodeId);
  }

  getSessionsForRig(rigId: string): Session[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s
         JOIN nodes n ON s.node_id = n.id
         WHERE n.rig_id = ?
         ORDER BY s.created_at`
      )
      .all(rigId) as SessionRow[];

    return rows.map((r) => this.rowToSession(r));
  }

  /** OPR.0.4.3.20 FR-4——每个 node 最新的 session，筛选为 live status（running / idle /
   *  unknown），并带 resume-metadata refresher 所需字段。从 rig-teardown 提升，使 teardown
   *  pre-down 路径与 FR-4 periodic/manual snapshot refresh 调用同一 query（无重复）。 */
  getLatestLiveSessions(rigId: string): LatestLiveSession[] {
    const rows = this.db.prepare(`
      SELECT n.id as node_id, s.id as session_id, s.session_name, s.status, n.runtime, n.cwd, s.resume_type, s.resume_token
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
      WHERE n.rig_id = ?
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
        AND s.status IN ('running', 'idle', 'unknown')
    `).all(rigId) as Array<{ node_id: string; session_id: string; session_name: string; status: string; runtime: string | null; cwd: string | null; resume_type: string | null; resume_token: string | null }>;

    return rows.map((r) => ({
      nodeId: r.node_id,
      sessionId: r.session_id,
      sessionName: r.session_name,
      status: r.status,
      runtime: r.runtime,
      resumeType: r.resume_type,
      resumeToken: r.resume_token,
      cwd: r.cwd,
    }));
  }

  getBindingForNode(nodeId: string): Binding | null {
    const row = this.db
      .prepare("SELECT * FROM bindings WHERE node_id = ?")
      .get(nodeId) as BindingRow | undefined;

    return row ? this.rowToBinding(row) : null;
  }

  updateBinding(nodeId: string, fields: BindingFields): Binding {
    // atomic upsert：整个 read-modify-write 位于同一 transaction 内
    const upsert = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM bindings WHERE node_id = ?")
        .get(nodeId) as BindingRow | undefined;

      if (existing) {
        // partial update：只覆盖已提供字段
        this.db
          .prepare(
            `UPDATE bindings SET
              attachment_type = ?,
              tmux_session = ?,
              tmux_window = ?,
              tmux_pane = ?,
              external_session_name = ?,
              cmux_workspace = ?,
              cmux_surface = ?,
              updated_at = datetime('now')
            WHERE node_id = ?`
          )
          .run(
            fields.attachmentType ?? existing.attachment_type ?? "tmux",
            fields.tmuxSession ?? existing.tmux_session,
            fields.tmuxWindow ?? existing.tmux_window,
            fields.tmuxPane ?? existing.tmux_pane,
            fields.externalSessionName ?? existing.external_session_name,
            fields.cmuxWorkspace ?? existing.cmux_workspace,
            fields.cmuxSurface ?? existing.cmux_surface,
            nodeId
          );
      } else {
        const id = ulid();
        this.db
          .prepare(
            `INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_window, tmux_pane, external_session_name, cmux_workspace, cmux_surface)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            nodeId,
            fields.attachmentType ?? "tmux",
            fields.tmuxSession ?? null,
            fields.tmuxWindow ?? null,
            fields.tmuxPane ?? null,
            fields.externalSessionName ?? null,
            fields.cmuxWorkspace ?? null,
            fields.cmuxSurface ?? null
          );
      }
    });

    upsert();

    return this.rowToBinding(
      this.db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeId) as BindingRow
    );
  }

  // -- 数据库行到领域对象的映射器 --

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      nodeId: row.node_id,
      sessionName: row.session_name,
      status: row.status,
      resumeType: row.resume_type ?? null,
      resumeToken: row.resume_token ?? null,
      // OPR.0.4.3.20 FR-6——携带 provenance + verification freshness，使 snapshot 的 serialized
      // session（及 getSessionsForRig）在 restore plan 中呈现 token state。pre-45 row 可为 null/降级。
      resumeProvenance: row.resume_provenance ?? null,
      resumeLastVerified: row.resume_last_verified ?? null,
      resumeLastProbeStatus: row.resume_last_probe_status ?? null,
      restorePolicy: row.restore_policy ?? "resume_if_possible",
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      origin: (row.origin === "claimed" ? "claimed" : "launched"),
      startupStatus: (row.startup_status as Session["startupStatus"]) ?? "pending",
      startupCompletedAt: row.startup_completed_at ?? null,
    };
  }

  private rowToBinding(row: BindingRow): Binding {
    return {
      id: row.id,
      nodeId: row.node_id,
      attachmentType: (row.attachment_type as Binding["attachmentType"]) ?? "tmux",
      tmuxSession: row.tmux_session,
      tmuxWindow: row.tmux_window,
      tmuxPane: row.tmux_pane,
      externalSessionName: row.external_session_name ?? null,
      cmuxWorkspace: row.cmux_workspace,
      cmuxSurface: row.cmux_surface,
      updatedAt: row.updated_at,
    };
  }
}

// -- 原始 DB row 类型（snake_case）--

interface SessionRow {
  id: string;
  node_id: string;
  session_name: string;
  status: string;
  resume_type: string | null;
  resume_token: string | null;
  restore_policy: string | null;
  last_seen_at: string | null;
  created_at: string;
  origin: string;
  startup_status: string | null;
  startup_completed_at: string | null;
  // OPR.0.4.3.20 FR-3/FR-6——续接台账来源和验证新鲜度。
  resume_provenance?: string | null;
  resume_last_verified?: string | null;
  resume_last_probe_status?: string | null;
}

interface BindingRow {
  id: string;
  node_id: string;
  attachment_type: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  external_session_name: string | null;
  cmux_workspace: string | null;
  cmux_surface: string | null;
  updated_at: string;
}
