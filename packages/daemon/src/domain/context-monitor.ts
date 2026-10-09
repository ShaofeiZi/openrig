import type Database from "better-sqlite3";
import type { ClaudeCompactionEnforcer } from "./claude-compaction-enforcer.js";
import type { ContextUsageStore } from "./context-usage-store.js";
import {
  isAttentionRequiredReadinessCode,
  type NodeBinding,
  type ReadinessResult,
} from "./runtime-adapter.js";
import type { UsageSamplesStore, ProviderWindowSampleInput } from "./usage-samples-store.js";
import type { ContextUsage } from "./types.js";

/** 默认 polling interval：30 秒。 */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

interface EligibleSession {
  node_id: string;
  session_id: string;
  session_name: string;
  runtime: string | null;
  resume_token: string | null;
  cwd: string | null;
  startup_status: "pending" | "ready" | "attention_required" | "failed" | null;
}

interface ClaudeContextProvisioner {
  ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void;
  checkReady?(binding: NodeBinding): Promise<ReadinessResult>;
}

interface RuntimeReadinessChecker {
  checkReady?(binding: NodeBinding): Promise<ReadinessResult>;
}

/**
 * 轮询已知 managed runtime context source，并持久化最新的 normalized telemetry。仅负责
 * scheduler：不查询、不塑造 response，也不保存 in-memory truth。
 *
 * Slice 27：可选 `compactionEnforcer` 在持久化后的每次 polling tick 中参与，使 policy-driven
 * /compact trigger 基于 operator 在 UI 中看到的同一 observation 触发。未提供 enforcer 时，
 * polling 行为不变。
 */
export class ContextMonitor {
  private db: Database.Database;
  private store: ContextUsageStore;
  private claudeContextProvisioner: ClaudeContextProvisioner | null;
  private compactionEnforcer: ClaudeCompactionEnforcer | null;
  private readinessCheckers: Record<string, RuntimeReadinessChecker | undefined>;
  private usageSamples: UsageSamplesStore | null = null;
  private providerWindowSampler: (() => ProviderWindowSampleInput[]) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activePoll: Promise<void> | null = null;

  constructor(
    db: Database.Database,
    store: ContextUsageStore,
    claudeContextProvisioner?: ClaudeContextProvisioner,
    compactionEnforcer?: ClaudeCompactionEnforcer,
    readinessCheckers?: Record<string, RuntimeReadinessChecker | undefined>,
    usageSamples?: UsageSamplesStore,
    providerWindowSampler?: () => ProviderWindowSampleInput[],
  ) {
    this.db = db;
    this.store = store;
    this.usageSamples = usageSamples ?? null;
    this.providerWindowSampler = providerWindowSampler ?? null;
    this.claudeContextProvisioner = claudeContextProvisioner ?? null;
    this.compactionEnforcer = compactionEnforcer ?? null;
    this.readinessCheckers = readinessCheckers ?? {};
    if (claudeContextProvisioner && !this.readinessCheckers["claude-code"]) {
      this.readinessCheckers["claude-code"] = claudeContextProvisioner;
    }
  }

  /** 发现 active managed Claude session，并轮询其 sidecar 文件。 */
  async pollOnce(): Promise<void> {
    if (this.activePoll) return this.activePoll;
    const poll = this.runPoll();
    this.activePoll = poll;
    try {
      await poll;
    } finally {
      if (this.activePoll === poll) this.activePoll = null;
    }
  }

  private async runPoll(): Promise<void> {
    const sessions = this.getEligibleSessions();
    for (const session of sessions) {
      let observed: ContextUsage | null = null;
      const canReadContextUsage = session.runtime !== "codex" || !!session.resume_token;
      if (canReadContextUsage) {
        try {
          observed = this.readContextUsage(session);
          this.store.persist(session.node_id, observed);
          // 51-08 A1：over-time twin——在同一 tick 中只前进地 append（PM decision 1：piggyback，
          // 无 parallel sampler）。只记录 known sample：unknown 是 query-side judgment，绝不是
          // 存储的零（Option-A bar + BR-2 absent-never-zero）。
          if (this.usageSamples && observed.availability === "known") {
            try {
              this.usageSamples.appendContextSample(
                {
                  nodeId: session.node_id,
                  seatSession: session.session_name,
                  source: observed.source,
                  sampledAt: observed.sampledAt,
                  totalInputTokens: observed.totalInputTokens,
                  totalOutputTokens: observed.totalOutputTokens,
                  usedPercentage: observed.usedPercentage,
                },
                new Date().toISOString(),
              );
            } catch { /* series write 绝不能打断 polling */ }
          }
        } catch {
          observed = null;
          // 单个异常 session 不能令其他 session 的 polling 崩溃
          try {
            this.store.persist(session.node_id, this.store.unknownUsage("parse_error"));
          } catch { /* 放弃此次 session */ }
        }
      }

      await this.normalizeStartupStatus(session);
      await this.maybeAutoCompact(session, observed);
    }
    this.drainProviderWindowSamples();
  }

  /** 51-08 A1：每个 tick drain 一次 provider-window supplier，只前进。与 enforcer seam 保持防御性
   *  一致：supplier fault 永远不会打断 polling。 */
  private drainProviderWindowSamples(): void {
    if (!this.usageSamples || !this.providerWindowSampler) return;
    try {
      const capturedAt = new Date().toISOString();
      for (const sample of this.providerWindowSampler()) {
        this.usageSamples.appendProviderWindowSample(sample, capturedAt);
      }
    } catch { /* series write 绝不能打断 polling */ }
  }

  /**
   * Slice 27——用最新 observation 调用 enforcer。enforcer 负责 policy + dedup + send；
   * ContextMonitor 只转发 data 并吸收 enforcer error，使 trigger-path fault 永远不会令 telemetry
   * polling 崩溃。
   */
  private async maybeAutoCompact(
    session: EligibleSession,
    usage: ContextUsage | null,
  ): Promise<void> {
    if (!this.compactionEnforcer) return;
    if (!usage || usage.availability !== "known") return;
    try {
      await this.compactionEnforcer.maybeAutoCompact({
        sessionName: session.session_name,
        runtime: session.runtime,
        usedPercentage: usage.usedPercentage,
        transcriptPath: usage.transcriptPath,
        sessionId: usage.sessionId,
      });
    } catch {
      // 防御：enforcer 本不应抛错，但这里仍吸收错误，使 polling loop 继续处理其余 session。
    }
  }

  /** 按给定 interval 启动 polling。幂等。 */
  start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.timer) return; // 已在运行
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
    // unref，避免 timer 阻止 process 退出
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** 停止 polling。可在 start 前调用，也可重复调用。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 查询具有可读 context source 的 managed runtime session。 */
  private getEligibleSessions(): EligibleSession[] {
    return this.db.prepare(`
      SELECT
        n.id as node_id,
        s.id as session_id,
        s.session_name,
        n.runtime,
        s.resume_token,
        n.cwd,
        s.startup_status
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE (
          (n.runtime = 'claude-code' AND s.status = 'running')
          OR (n.runtime = 'stub' AND s.status = 'running')
          OR (
            n.runtime = 'codex'
            AND (
              s.resume_token IS NOT NULL
              OR s.startup_status IN ('failed', 'attention_required')
            )
          )
        )
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
        AND COALESCE(b.tmux_session, s.session_name) IS NOT NULL
    `).all() as EligibleSession[];
  }

  private readContextUsage(session: EligibleSession) {
    if (session.runtime === "codex") {
      return this.store.readCodexAndNormalize({
        threadId: session.resume_token,
        sessionName: session.session_name,
      });
    }

    // 只有 claude-code seat 会在 cwd 中配置 Claude context collector。runtime:stub seat 自行提供
    // context sidecar，因此 monitor 通过下方 readAndNormalize 使用它，不向 stub cwd 写入任何
    // Claude 专用收集器配置。
    if (session.runtime === "claude-code") {
      this.claudeContextProvisioner?.ensureContextCollector({
        cwd: session.cwd ?? undefined,
        tmuxSession: session.session_name,
      });
    }
    return this.store.readAndNormalize(session.session_name);
  }

  private async normalizeStartupStatus(session: EligibleSession): Promise<void> {
    const checker = session.runtime ? this.readinessCheckers[session.runtime] : undefined;
    if (!checker?.checkReady) return;
    if (session.startup_status !== "failed" && session.startup_status !== "attention_required") return;

    try {
      const readiness = await checker.checkReady({
        id: `context-monitor:${session.session_id}`,
        nodeId: session.node_id,
        attachmentType: "tmux",
        tmuxSession: session.session_name,
        tmuxWindow: null,
        tmuxPane: null,
        cmuxWorkspace: null,
        cmuxSurface: null,
        updatedAt: "",
        cwd: session.cwd ?? "",
      });
      if (readiness.ready) {
        this.db.prepare(`
          UPDATE sessions
          SET startup_status = 'ready',
              startup_completed_at = ?
          WHERE id = ?
        `).run(new Date().toISOString(), session.session_id);
        return;
      }

      if (isAttentionRequiredReadinessCode(readiness.code)) {
        this.db.prepare(`
          UPDATE sessions
          SET startup_status = 'attention_required'
          WHERE id = ?
        `).run(session.session_id);
      }
    } catch {
      // 只做 best-effort normalization；telemetry polling 仍会成功。
    }
  }
}
