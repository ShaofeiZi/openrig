import Database from "better-sqlite3";
import { join } from "node:path";
import os from "node:os";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { resolveCodexDbPaths } from "./codex-thread-id.js";
import type { ContextUsage, ContextUnknownReason } from "./types.js";
import {
  contextUsageDirectory,
  legacyContextUsageDirectory,
  telemetrySidecarPath,
} from "./telemetry-state-paths.js";

/** freshness threshold：早于此阈值的 sample 在 compact display 中视为 stale。 */
export const FRESHNESS_THRESHOLD_MS = 600_000; // PM spec 规定为 10 分钟

export interface ContextUsageStoreOpts {
  stateDir: string;
  codexHomeDir?: string | null;
  // GHOST-STAGE（c-id）：解析 node 的 live occupant boot time（atom-B tenure），使当前 occupant
  // boot 前采样的 reading（前一 generation）被拒绝，而不是驱动 threshold。null = UNKNOWN → gate
  // 不生效（note-2）。
  resolveOccupantBootAt?: (nodeId: string) => string | null;
}

interface SidecarRaw {
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    current_usage?: unknown;
  };
  session_id?: string;
  session_name?: string;
  /** status-line collector 继承的 managed seat generation。使 consumer 能区分 canonical occupant
   *  与 launch-time --name alias 到同一 seat 的 retained predecessor。 */
  occupant_generation?: string;
  transcript_path?: string;
  sampled_at?: string;
}

interface ContextUsageRow {
  node_id: string;
  session_id: string | null;
  session_name: string | null;
  availability: string;
  reason: string | null;
  source: string | null;
  used_percentage: number | null;
  remaining_percentage: number | null;
  context_window_size: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  current_usage: string | null;
  transcript_path: string | null;
  sampled_at: string | null;
  updated_at: string;
}

interface CodexThreadRow {
  id: string;
  rollout_path: string;
}

interface CodexTokenUsageRaw {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface CodexTokenCountEvent {
  timestamp?: string;
  payload?: {
    type?: string;
    info?: {
      last_token_usage?: CodexTokenUsageRaw;
      model_context_window?: number;
    };
  };
}

export class ContextUsageStore {
  readonly db: Database.Database;
  private stateDir: string;
  private codexHomeDir: string | null;

  private readonly resolveOccupantBootAt?: (nodeId: string) => string | null;
  constructor(db: Database.Database, opts: ContextUsageStoreOpts) {
    this.db = db;
    this.stateDir = opts.stateDir;
    this.codexHomeDir = opts.codexHomeDir ?? safeHomeDir();
    this.resolveOccupantBootAt = opts.resolveOccupantBootAt;
  }

  /**
   * GHOST-STAGE（c-id）：此 reading 是否来自 node live occupant 之前的 generation？严格早于当前
   * occupant boot 时刻采样的 reading 属于已退役 tenure（handover 后 mixed-gen window 中 frozen-88%
   * 样本；由于名称被复用，session_mismatch 无法捕获）。boot time 为 UNKNOWN 或 reading 无 sampled_at
   * 时返回 false——gate 不生效（note-2：绝不将 unknown 视为 stale），剩余 guard 为
   * session_mismatch + freshness。Date.parse 可容忍 collector ISO sampled_at 与 SQLite
   * datetime('now') boot_at 之间的格式差异。
   */
  private isPriorGenerationReading(nodeId: string, sampledAt: string | null): boolean {
    if (!sampledAt) return false;
    const bootAt = this.resolveOccupantBootAt?.(nodeId) ?? null;
    if (!bootAt) return false;
    const sampled = Date.parse(sampledAt);
    const boot = Date.parse(bootAt);
    if (Number.isNaN(sampled) || Number.isNaN(boot)) return false;
    return sampled < boot;
  }

  /** 获取 session 的 sidecar 文件路径。 */
  getSidecarPath(sessionName: string): string {
    return telemetrySidecarPath(contextUsageDirectory(this.stateDir), sessionName);
  }

  /**
   * GHOST-STAGE（e）Class-A 2a：移除 retiring occupant 按 name 索引的 context sidecar，使同名
   * successor 不会读取 predecessor 的 frozen telemetry sample（“gen-1 88% 再次作为 live threshold
   * flag 出现”的样本）。按时序保证安全——cutover seam（OccupantInvalidator）在
   * SeatHandoverService.commit() 内、successor 写入自身 sidecar 之前调用。文件缺失 = no-op；
   * best-effort（残留由下游 freshness gate 捕获）。注意：这是 disk sidecar（按 name 索引）；
   * context_usage DB table 按 node_id 索引且已有 session_mismatch gate，因此此处无需 invalidation。
   */
  invalidateOccupantSidecar(sessionName: string): void {
    const filePath = this.getSidecarPath(sessionName);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      /* best-effort——stale 残留仍由下游 isFresh gate 拦截 */
    }
  }

  /** 读取并解析 sidecar JSON 文件。返回 discriminated result。 */
  readSidecar(sessionName: string): { ok: true; data: SidecarRaw } | { ok: false; reason: "missing_sidecar" | "parse_error" } {
    const canonical = this.readSidecarAt(this.getSidecarPath(sessionName));
    if (canonical.ok || canonical.reason !== "missing_sidecar") return canonical;
    return this.readSidecarAt(
      telemetrySidecarPath(legacyContextUsageDirectory(this.stateDir), sessionName),
    );
  }

  private readSidecarAt(filePath: string): { ok: true; data: SidecarRaw } | { ok: false; reason: "missing_sidecar" | "parse_error" } {
    try {
      if (!existsSync(filePath)) return { ok: false, reason: "missing_sidecar" };
      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content) as SidecarRaw;
      return { ok: true, data: parsed };
    } catch {
      return { ok: false, reason: "parse_error" };
    }
  }

  /** 一步读取 sidecar 并 normalize 为 ContextUsage。 */
  readAndNormalize(sessionName: string): ContextUsage {
    const result = this.readSidecar(sessionName);
    if (!result.ok) return this.unknownUsage(result.reason);
    return this.normalizeSample(result.data);
  }

  /** 读取 thread 最新的 Codex token_count event 并 normalize。 */
  readCodexAndNormalize(input: { threadId: string | null | undefined; sessionName: string }): ContextUsage {
    const threadId = input.threadId?.trim();
    if (!threadId) return this.unknownUsage("no_data");

    const thread = this.readCodexThread(threadId);
    if (!thread?.rollout_path) return this.unknownUsage("no_data");

    const tokenEvent = this.readLatestCodexTokenCount(thread.rollout_path);
    if (!tokenEvent) return this.unknownUsage("no_data");

    return this.normalizeCodexTokenCount({
      event: tokenEvent,
      sessionName: input.sessionName,
      threadId,
      transcriptPath: thread.rollout_path,
    });
  }

  /** 解析显式选择的 native thread，即使其尚未出现首个 token count。 */
  readCodexTranscriptPath(threadId: string): string | null {
    return this.readCodexThread(threadId)?.rollout_path ?? null;
  }

  /** 将 raw sidecar data normalize 为 ContextUsage record。 */
  normalizeSample(raw: SidecarRaw | null): ContextUsage {
    if (!raw) {
      return this.unknownUsage("missing_sidecar");
    }

    const cw = raw.context_window;
    if (!cw || typeof cw.used_percentage !== "number") {
      return this.unknownUsage("parse_error");
    }

    const sampledAt = raw.sampled_at ?? null;
    const fresh = sampledAt ? this.isFresh(sampledAt) : false;

    return {
      availability: "known",
      reason: null,
      source: "claude_statusline_json",
      usedPercentage: cw.used_percentage ?? null,
      remainingPercentage: cw.remaining_percentage ?? null,
      contextWindowSize: cw.context_window_size ?? null,
      totalInputTokens: cw.total_input_tokens ?? null,
      totalOutputTokens: cw.total_output_tokens ?? null,
      currentUsage: this.normalizeCurrentUsage(cw.current_usage),
      transcriptPath: raw.transcript_path ?? null,
      sessionId: raw.session_id ?? null,
      sessionName: raw.session_name ?? null,
      sampledAt,
      fresh,
    };
  }

  /** 将 Codex token_count JSONL event normalize 为 ContextUsage。 */
  private normalizeCodexTokenCount(input: {
    event: CodexTokenCountEvent;
    sessionName: string;
    threadId: string;
    transcriptPath: string;
  }): ContextUsage {
    const info = input.event.payload?.info;
    const usage = info?.last_token_usage;
    const contextWindowSize = info?.model_context_window;

    if (!usage || typeof contextWindowSize !== "number" || contextWindowSize <= 0) {
      return this.unknownUsage("parse_error");
    }

    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
    const totalTokens = typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : (inputTokens ?? 0) + (outputTokens ?? 0);
    const usedPercentage = clampPercentage(Math.round((totalTokens / contextWindowSize) * 100));
    const remainingPercentage = clampPercentage(100 - usedPercentage);
    const sampledAt = input.event.timestamp ?? null;

    return {
      availability: "known",
      reason: null,
      source: "codex_token_count_jsonl",
      usedPercentage,
      remainingPercentage,
      contextWindowSize,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      currentUsage: this.normalizeCurrentUsage({
        last_token_usage: usage,
        model_context_window: contextWindowSize,
      }),
      transcriptPath: input.transcriptPath,
      sessionId: input.threadId,
      sessionName: input.sessionName,
      sampledAt,
      fresh: sampledAt ? this.isFresh(sampledAt) : false,
    };
  }

  /** 持久化 node 的 context usage record。执行 upsert。 */
  persist(nodeId: string, usage: ContextUsage): void {
    this.db.prepare(`
      INSERT INTO context_usage (
        node_id, session_id, session_name, availability, reason, source,
        used_percentage, remaining_percentage, context_window_size,
        total_input_tokens, total_output_tokens, current_usage,
        transcript_path, sampled_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(node_id) DO UPDATE SET
        session_id = excluded.session_id,
        session_name = excluded.session_name,
        availability = excluded.availability,
        reason = excluded.reason,
        source = excluded.source,
        used_percentage = excluded.used_percentage,
        remaining_percentage = excluded.remaining_percentage,
        context_window_size = excluded.context_window_size,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        current_usage = excluded.current_usage,
        transcript_path = excluded.transcript_path,
        sampled_at = excluded.sampled_at,
        updated_at = datetime('now')
    `).run(
      nodeId,
      usage.sessionId,
      usage.sessionName,
      usage.availability,
      usage.reason,
      usage.source,
      usage.usedPercentage,
      usage.remainingPercentage,
      usage.contextWindowSize,
      usage.totalInputTokens,
      usage.totalOutputTokens,
      usage.currentUsage,
      usage.transcriptPath,
      usage.sampledAt,
    );
  }

  /** 获取单个 node 的 context usage。感知 session：session 不匹配时返回 unknown。 */
  getForNode(nodeId: string, currentSessionName: string | null): ContextUsage {
    if (!currentSessionName) return this.unknownUsage("not_managed");

    const row = this.db.prepare("SELECT * FROM context_usage WHERE node_id = ?").get(nodeId) as ContextUsageRow | undefined;
    if (!row) return this.unknownUsage("no_data");

    // Session mismatch guard：防止 stale cross-session inheritance
    if (row.session_name && row.session_name !== currentSessionName) {
      return this.unknownUsage("session_mismatch");
    }

    // GHOST-STAGE（c-id）：generation guard。handover 时名称会复用，因此即使 table 仍保存 retiree
    // pre-boot reading（mixed-gen window），session_mismatch 也会通过。拒绝 live occupant boot 前的
    // reading → insufficient-data，只评估 current-gen。
    if (this.isPriorGenerationReading(nodeId, row.sampled_at)) {
      return this.unknownUsage("stale_generation");
    }

    return this.rowToUsage(row);
  }

  /** 批量获取多个 node 的 context usage。每个 entry 都感知 session。 */
  getForNodes(entries: Array<{ nodeId: string; currentSessionName: string | null }>): Map<string, ContextUsage> {
    const result = new Map<string, ContextUsage>();
    if (entries.length === 0) return result;

    const nodeIds = entries.map((e) => e.nodeId);
    const sessionMap = new Map(entries.map((e) => [e.nodeId, e.currentSessionName]));

    const rows = this.db.prepare(
      `SELECT * FROM context_usage WHERE node_id IN (${nodeIds.map(() => "?").join(",")})`
    ).all(...nodeIds) as ContextUsageRow[];

    const rowMap = new Map(rows.map((r) => [r.node_id, r]));

    for (const entry of entries) {
      if (!entry.currentSessionName) {
        result.set(entry.nodeId, this.unknownUsage("not_managed"));
        continue;
      }

      const row = rowMap.get(entry.nodeId);
      if (!row) {
        result.set(entry.nodeId, this.unknownUsage("no_data"));
        continue;
      }

      if (row.session_name && row.session_name !== entry.currentSessionName) {
        result.set(entry.nodeId, this.unknownUsage("session_mismatch"));
        continue;
      }

      // GHOST-STAGE（c-id）：generation guard——见 getForNode。拒绝 pre-boot（prior-gen）reading。
      if (this.isPriorGenerationReading(entry.nodeId, row.sampled_at)) {
        result.set(entry.nodeId, this.unknownUsage("stale_generation"));
        continue;
      }

      result.set(entry.nodeId, this.rowToUsage(row));
    }

    return result;
  }

  /** 用诚实原因创建 unknown ContextUsage。 */
  unknownUsage(reason: ContextUnknownReason): ContextUsage {
    return {
      availability: "unknown",
      reason,
      source: null,
      usedPercentage: null,
      remainingPercentage: null,
      contextWindowSize: null,
      totalInputTokens: null,
      totalOutputTokens: null,
      currentUsage: null,
      transcriptPath: null,
      sessionId: null,
      sessionName: null,
      sampledAt: null,
      fresh: false,
    };
  }

  /** 检查 sample timestamp 是否 fresh。 */
  private isFresh(sampledAt: string): boolean {
    try {
      const age = Date.now() - new Date(sampledAt).getTime();
      return age < FRESHNESS_THRESHOLD_MS;
    } catch {
      return false;
    }
  }

  /** 将 DB row 转换为 ContextUsage，并应用 freshness 判断。 */
  private rowToUsage(row: ContextUsageRow): ContextUsage {
    const fresh = row.sampled_at ? this.isFresh(row.sampled_at) : false;
    return {
      availability: row.availability as ContextUsage["availability"],
      reason: row.reason as ContextUsage["reason"],
      source: row.source as ContextUsage["source"],
      usedPercentage: row.used_percentage,
      remainingPercentage: row.remaining_percentage,
      contextWindowSize: row.context_window_size,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      currentUsage: row.current_usage,
      transcriptPath: row.transcript_path,
      sessionId: row.session_id,
      sessionName: row.session_name,
      sampledAt: row.sampled_at,
      fresh,
    };
  }

  private normalizeCurrentUsage(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private readCodexThread(threadId: string): CodexThreadRow | null {
    for (const dbPath of this.resolveCodexStateDbPaths()) {
      try {
        const codexDb = new Database(dbPath, { readonly: true });
        try {
          const row = codexDb.prepare(
            "SELECT id, rollout_path FROM threads WHERE id = ? LIMIT 1",
          ).get(threadId) as CodexThreadRow | undefined;
          if (row?.rollout_path) return row;
        } finally {
          codexDb.close();
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private resolveCodexStateDbPaths(): string[] {
    return this.codexHomeDir ? resolveCodexDbPaths(this.codexHomeDir, "state") : [];
  }

  private readLatestCodexTokenCount(rolloutPath: string): CodexTokenCountEvent | null {
    let content: string;
    try {
      content = this.readTail(rolloutPath, 4_000_000);
    } catch {
      return null;
    }

    const lines = content.trimEnd().split("\n").reverse();
    for (const line of lines) {
      if (!line.includes("\"token_count\"")) continue;
      try {
        const parsed = JSON.parse(line) as CodexTokenCountEvent;
        if (parsed.payload?.type === "token_count") return parsed;
      } catch {
        continue;
      }
    }

    return null;
  }

  private readTail(filePath: string, maxBytes: number): string {
    const stat = statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      return buffer.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  }
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function safeHomeDir(): string | null {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}
