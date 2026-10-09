import type Database from "better-sqlite3";
import { parseSessionName, validateSessionName } from "./session-name.js";
import type { SettingsStore } from "./user-settings/settings-store.js";
import {
  type WatchdogJob,
  type WatchdogJobsRepository,
} from "./watchdog-jobs-repository.js";

const POLICY = "idle-gate-qitem";
const REGISTRAR = "daemon@kernel";
const TERMINAL_SESSION_STATUSES = new Set(["superseded", "detached", "exited"]);

export class WatchdogAutoRegistrationError extends Error {
  constructor(
    public readonly code: "target_mismatch" | "missing",
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = "WatchdogAutoRegistrationError";
  }
}

interface TopologyRow {
  node_id: string;
  rig_id: string;
  rig_name: string;
}

interface RawTopologyRow {
  node_id: string;
  rig_id: string;
  rig_name: string | null;
}

interface LatestSessionRow {
  node_id: string;
  session_name: string;
  status: string;
}

export interface WatchdogAutoRegistrationDeps {
  db: Database.Database;
  jobsRepo: WatchdogJobsRepository;
  settingsStore: SettingsStore;
  warn?: (message: string) => void;
}

export function formatWatchdogRegistrationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const details = typeof error === "object" && error !== null && "details" in error
    ? (error as { details?: unknown }).details
    : undefined;
  return details === undefined ? message : `${message}; details=${JSON.stringify(details)}`;
}

/**
 * W2c 的唯一结构接缝：每次创建规范席位都确保其角色绑定 idle-gate job，
 * 启动阶段则只审计既有的类活动席位。核心席位创建与此增量监督层保持失败隔离。
 */
export class WatchdogAutoRegistration {
  private readonly warn: (message: string) => void;

  constructor(private readonly deps: WatchdogAutoRegistrationDeps) {
    this.warn = deps.warn ?? ((message) => console.warn(message));
  }

  /** 具名排除：扁平旧版、非规范及外部席位不能拥有 qitem。 */
  isEligibleSessionName(sessionName: string): boolean {
    return validateSessionName(sessionName) && parseSessionName(sessionName).kind === "canonical";
  }

  /**
   * 发现式移交可能合法认领非规范 tmux 名称。它不符合新角色 job 条件，
   * 但已退役规范目标必须停止投递。终态历史允许后续规范占用者创建新的活动 job；
   * 被操作员停止的行则保持停止。
   */
  reconcileHandover(nodeId: string, sessionName: string): WatchdogJob | null {
    const row = this.deps.db.prepare(
      `SELECT n.id AS node_id, n.rig_id AS rig_id, r.name AS rig_name
         FROM nodes n LEFT JOIN rigs r ON r.id = n.rig_id
        WHERE n.id = ?`,
    ).get(nodeId) as RawTopologyRow | undefined;
    if (!row || row.rig_name === null) {
      throw new WatchdogAutoRegistrationError(
        "target_mismatch",
        `watchdog 移交拓扑缺失：node_id="${nodeId}" session="${sessionName}"`,
        { nodeId, sessionName, actualRig: row?.rig_name ?? null },
      );
    }
    const job = this.deps.jobsRepo.findAutoRegistration(
      POLICY,
      sessionName,
      null,
      this.canonicalAliases(nodeId, row.rig_name, sessionName),
    );
    if (!job || job.state === "stopped") return job;
    this.deps.jobsRepo.markTerminal(job.jobId, "handover_noncanonical_successor");
    return this.deps.jobsRepo.getByIdOrThrow(job.jobId);
  }

  /**
   * B6 创建者裁定——自动注册默认不开启。只有车队显式启用（`auto_register: "all"`）
   * 或席位列在 `opt_in_sessions` 中时才创建新 job。已经拥有 job 的席位无论如何都会继续维护：
   * 既有注册 job 不受默认值切换影响，其别名刷新也不得静默停止。
   */
  private autoRegisterAllowed(sessionName: string): boolean {
    // 在强制接缝处 trim：校验器接受带空白的枚举值（校验的是 trim 后原值），
    // 因此门禁必须比较相同规范化结果；若接受的 " all " 静默表现为 "off"，配置就在说谎。
    const mode = String(this.deps.settingsStore.resolveOne("policies.idle_gate_qitem.auto_register").value ?? "off").trim();
    if (mode === "all") return true;
    const optIn = String(this.deps.settingsStore.resolveOne("policies.idle_gate_qitem.opt_in_sessions").value ?? "");
    return optIn.split(",").map((s) => s.trim()).filter(Boolean).includes(sessionName);
  }

  ensure(nodeId: string, sessionName: string): WatchdogJob | null {
    const topology = this.resolveTopology(nodeId, sessionName);
    if (!topology) return null;
    if (!this.autoRegisterAllowed(sessionName)) {
      const existing = this.deps.jobsRepo.findAutoRegistration(
        POLICY,
        sessionName,
        null,
        this.canonicalAliases(nodeId, topology.rig_name, sessionName),
      );
      if (!existing) return null; // 新席位未选择加入；按裁定不创建 job。
    }
    const cadence = this.resolveCadence();
    return this.deps.jobsRepo.ensureAutoRegistration(
      {
        policy: POLICY,
        specYaml: this.generatedSpec(sessionName, cadence.scan, cadence.activeWake),
        targetSession: sessionName,
        intervalSeconds: cadence.scan,
        scanIntervalSeconds: cadence.scan,
        activeWakeIntervalSeconds: cadence.activeWake,
        registeredBySession: REGISTRAR,
        targetGenerationUuid: null,
      },
      this.canonicalAliases(nodeId, topology.rig_name, sessionName),
    );
  }

  assertCoverage(nodeId: string, sessionName: string): WatchdogJob | null {
    const topology = this.resolveTopology(nodeId, sessionName);
    if (!topology) return null;
    const job = this.deps.jobsRepo.findAutoRegistration(
      POLICY,
      sessionName,
      null,
      this.canonicalAliases(nodeId, topology.rig_name, sessionName),
    );
    if (!job || job.targetSession !== sessionName) {
      // B6——未选择加入的席位没有 job 是裁定后的默认值，并非覆盖失败；
      // 只有已选择加入的席位（或目标已过期的 job）才告警。
      if (!job && !this.autoRegisterAllowed(sessionName)) return null;
      throw new WatchdogAutoRegistrationError(
        "missing",
        `watchdog 自动注册缺失：node_id="${nodeId}" session="${sessionName}"`,
        {
          nodeId,
          sessionName,
          policy: POLICY,
          staleTargetSession: job?.targetSession ?? null,
          staleJobId: job?.jobId ?? null,
          staleState: job?.state ?? null,
        },
      );
    }
    return job;
  }

  /** 启动时审计每个最新类活动席位；绝不创建或删除行。 */
  assertLiveSeatCoverage(): void {
    const rows = this.deps.db.prepare(
      `SELECT node_id, session_name, status
         FROM sessions
        ORDER BY created_at DESC, id DESC`,
    ).all() as LatestSessionRow[];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.node_id)) continue;
      seen.add(row.node_id);
      if (TERMINAL_SESSION_STATUSES.has(row.status)) continue;
      if (!this.isEligibleSessionName(row.session_name)) continue;
      try {
        // B6——assertCoverage 感知门禁：未选择加入且无 job 的席位返回 null
        //（裁定默认值），而不是在每次启动审计时警告。
        this.assertCoverage(row.node_id, row.session_name);
      } catch (error) {
        this.warn(
          `[watchdog-auto-registration] 启动覆盖失败：node_id="${row.node_id}" ` +
          `session="${row.session_name}"：${formatWatchdogRegistrationError(error)}`,
        );
      }
    }
  }

  private resolveTopology(nodeId: string, sessionName: string): TopologyRow | null {
    if (!validateSessionName(sessionName)) return null;
    const parsed = parseSessionName(sessionName);
    if (parsed.kind !== "canonical") return null;
    const row = this.deps.db.prepare(
      `SELECT n.id AS node_id, n.rig_id AS rig_id, r.name AS rig_name
         FROM nodes n LEFT JOIN rigs r ON r.id = n.rig_id
        WHERE n.id = ?`,
    ).get(nodeId) as RawTopologyRow | undefined;
    if (!row || row.rig_name === null || row.rig_name !== parsed.rig) {
      throw new WatchdogAutoRegistrationError(
        "target_mismatch",
        `规范席位拓扑不匹配：node_id="${nodeId}" session="${sessionName}"`,
        { nodeId, sessionName, parsedRig: parsed.rig, actualRig: row?.rig_name ?? null },
      );
    }
    return row as TopologyRow;
  }

  private canonicalAliases(nodeId: string, rigName: string, currentSession: string): string[] {
    const rows = this.deps.db.prepare(
      `SELECT session_name FROM sessions WHERE node_id = ? ORDER BY created_at ASC, id ASC`,
    ).all(nodeId) as Array<{ session_name: string }>;
    return [...new Set([...rows.map((row) => row.session_name), currentSession])].filter((candidate) => {
      if (!validateSessionName(candidate)) return false;
      const parsed = parseSessionName(candidate);
      return parsed.kind === "canonical" && parsed.rig === rigName;
    });
  }

  private resolveCadence(): { scan: number; activeWake: number } {
    return {
      scan: this.deps.settingsStore.resolveOne("policies.idle_gate_qitem.scan_interval_seconds").value as number,
      activeWake: this.deps.settingsStore.resolveOne("policies.idle_gate_qitem.active_wake_interval_seconds").value as number,
    };
  }

  private generatedSpec(sessionName: string, scan: number, activeWake: number): string {
    return `policy: ${POLICY}\n` +
      `generated_by: openrig-daemon\n` +
      `target:\n  session: ${sessionName}\n` +
      `interval_seconds: ${scan}\n` +
      `scan_interval_seconds: ${scan}\n` +
      `active_wake_interval_seconds: ${activeWake}\n`;
  }
}
