// OPR.0.3.4.4 —— 只读恢复计划预览。
//
// `zrig up --existing <rig> --plan` 宣称“仅预览、不执行”，但 rig_name 路径曾绕过
// 计划门禁并产生修改（重建会话、把 detached 改为 running、替换人工恢复的 pane）。
// 本模块是两个恢复路由（`/api/up` 的 rig_name 与 Explorer 的 `/api/rigs/:id/up`）
// 在 plan=true 时共用的只读预览：它根据快照/会话数据计算每个席位的预期恢复动作，
// 不触碰任何状态——不调用 restoreOrchestrator.restore()，不创建、终止、替换或恢复
// 会话，也不捕获快照（自动 rehydrate 捕获本身是修改，此处仅报告“将会发生”），
// 同时不写入投影。

import type Database from "better-sqlite3";
import { resolveActiveOccupantRow, resolveActiveSnapshotSession, deriveRehydrateSessionIdByNode, activeOccupantAmbiguityError, type ActiveOccupantResolution } from "./active-occupant.js";
import type { RigWithRelations, Snapshot } from "./types.js";

  /** OPR.0.4.3.20 FR-6 —— 当前令牌的最近验证时间早于该阈值时显示为 `stale`
   * （基于时长的陈旧判断，无需探测即可得到“运行中变陈旧”信号）。这是交付默认值；
   * 精确数值由 PM 确认。 */
export const RESUME_FRESHNESS_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  /** OPR.0.4.3.20 FR-6 —— 恢复计划中逐席位的令牌真实状态。 */
export type ResumeTokenState = "present" | "missing" | "stale" | "unverified";

export interface RestorePlanPreviewNode {
  logicalId: string;
  /** 同意版本，而不是猜测的原生对话 ID。 */
  occupantSessionId?: string | null;
  hasHistory?: boolean;
  /** slice-02 词汇，用作预测：应用模式将会执行什么。 */
  intendedAction: "resume-original" | "fresh-primed" | "awaiting-decision";
  reason?: string;
  // OPR.0.4.3.20 FR-6——逐席位令牌状态和新鲜度（只读预测）。
  /** present = 已验证且新鲜；missing = 无令牌；stale = 探测失败或最近验证时间已超过
   * 新鲜度阈值；unverified = 令牌存在但从未验证。stale/unverified 令牌绝不会造成静默恢复失败；
   * 操作人员会在此看到状态，并可在恢复前重新验证。 */
  tokenState: ResumeTokenState;
  /** 令牌来源：adoption / hook / operator / scrape（没有时为 null）。 */
  provenance?: string | null;
  /** 最近确认令牌仍有效的时间（SQLite UTC 时间戳；null 表示从未确认）。 */
  lastVerified?: string | null;
  /** 席位没有可续接令牌时为 true，此时恢复需要显式 `--fresh`。该事实会在此呈现，
   * 绝不会伪装成静默 fresh-prime。 */
  freshRequired: boolean;
  /** 操作人员在恢复时应预期的运行时提示（Claude 会话选择器、Codex 认证/更新）；
   * 这是预测，而非意外插曲。 */
  runtimePrompt?: string;
}

export interface RestorePlanPreview {
  status: "plan";
  mode: "restore";
  rigId: string;
  rigName: string;
  /** 应用模式将从中恢复的快照；若会改为捕获当前状态的 auto-rehydrate 快照，则为 null。 */
  snapshot: { id: string; kind: string; createdAt: string } | null;
  /** 应用模式会先捕获 auto-rehydrate 快照时为 true；这里只报告而不执行，计划模式零写入。 */
  wouldCaptureCurrentState: boolean;
  nodes: RestorePlanPreviewNode[];
  /** 始终为 false，这是此预览存在的契约。 */
  mutated: false;
}

export interface PreviewSessionRow {
  nodeId: string;
  restorePolicy: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  // OPR.0.4.3.20 FR-6——来源和验证新鲜度。版本 45 之前的行与旧快照允许为 null/降级，
  // 显示为 unverified，绝不导致崩溃。
  resumeProvenance?: string | null;
  resumeLastVerified?: string | null;
  resumeLastProbeStatus?: string | null;
  /** 行 ID（ULID）。选择由共享的活跃占用者解析（active-occupant.ts）完成，与恢复执行
   * 使用同一事实来源，绝不通过最新 ID 推断。 */
  id: string;
  /** 会话状态：占用者判定阶梯的 legacy/uniquely-running 输入，也是实时拟捕获推导的输入。 */
  status: string | null;
}

/** OPR.0.4.3.20 FR-6——计算席位令牌状态（只读）。令牌存在但探测失败
 *（`not_resumable`/`inconclusive`），或最近验证时间超过新鲜度阈值时，状态为 `stale`；
 * 必须呈现该状态，绝不能静默置为 null。 */
function tokenStateFor(
  latest: PreviewSessionRow | null,
  nowMs: number,
): { tokenState: ResumeTokenState; provenance: string | null; lastVerified: string | null } {
  if (!latest || !latest.resumeToken) {
    return { tokenState: "missing", provenance: null, lastVerified: null };
  }
  const provenance = latest.resumeProvenance ?? null;
  const lastVerified = latest.resumeLastVerified ?? null;
  const probe = latest.resumeLastProbeStatus ?? null;
  if (probe === "not_resumable" || probe === "inconclusive") {
    return { tokenState: "stale", provenance, lastVerified };
  }
  if (!probe && !lastVerified) {
    return { tokenState: "unverified", provenance, lastVerified };
  }
  if (lastVerified) {
    const verifiedMs = parseSqliteUtcMs(lastVerified);
    if (!Number.isNaN(verifiedMs) && nowMs - verifiedMs > RESUME_FRESHNESS_THRESHOLD_MS) {
      return { tokenState: "stale", provenance, lastVerified };
    }
  }
  return { tokenState: "present", provenance, lastVerified };
}

/** 将 SQLite `datetime('now')` 值（"YYYY-MM-DD HH:MM:SS"，UTC，无时区标记）解析为
 * epoch 毫秒。无法解析时返回 NaN 并跳过时间检查；不可解析的时间戳绝不按时长判为 stale。 */
function parseSqliteUtcMs(value: string): number {
  return new Date(value.replace(" ", "T") + "Z").getTime();
}

/** OPR.0.4.3.20 FR-6——预测续接将遇到的运行时提示，使其成为操作人员预期步骤，
 * 而不是终端中的意外。仅当席位会尝试续接（有令牌）时有意义。 */
function runtimePromptFor(runtime: string | null, tokenState: ResumeTokenState): string | undefined {
  if (tokenState === "missing") return undefined;
  if (runtime === "claude-code") return "预计会出现 Claude 会话选择器（完整会话续接）";
  if (runtime === "codex") return "预计续接前会进行 Codex 认证/更新检查";
  return undefined;
}

/** 预测单个席位的恢复动作：镜像编排器的启动前分类（OPR.0.3.4.2），但不触碰任何状态。
 * 列入 fresh 的席位（操作 B，`--fresh <seat>`）会在任何续接令牌逻辑之前预测为
 * `fresh-primed`，与应用模式有意跳过续接完全一致。 */
function intendedActionFor(resolution: ActiveOccupantResolution<PreviewSessionRow>, freshRequested: boolean): { intendedAction: RestorePlanPreviewNode["intendedAction"]; reason?: string } {
  // OPR.0.5.7.1——权威关系损坏的优先级高于 --fresh，与执行流程在 fresh 检查前明确失败
  // 完全一致：--fresh 无法覆盖 A1 歧义。
  if (resolution.kind === "ambiguous") {
    return {
      intendedAction: "awaiting-decision",
      reason: activeOccupantAmbiguityError(resolution.candidateIds, resolution.detail),
    };
  }
  if (freshRequested) {
    return {
      intendedAction: "fresh-primed",
      reason: "已列入 --fresh；应用时会有意跳过恢复（操作 B）",
    };
  }
  const occupant = resolution.kind === "resolved" ? resolution.session : null;
  const policy = occupant?.restorePolicy ?? "resume_if_possible";
  const sourceRecorded = !!occupant?.resumeType && occupant.resumeType !== "none";
  if (policy === "resume_if_possible" && sourceRecorded && occupant?.resumeToken) {
    return { intendedAction: "resume-original" };
  }
  if (policy === "resume_if_possible" && occupant && (!sourceRecorded || !occupant.resumeToken)) {
    return {
      intendedAction: "awaiting-decision",
      reason: "前任占用者没有可用的原生恢复身份；未明确选择全新启动前不会启动会话。",
    };
  }
  return { intendedAction: "fresh-primed" };
}

/** 收集预览用于预测的会话行：存在快照时使用其中捕获的会话，否则使用 auto-rehydrate
 * 捕获本应快照的实时行。这里只执行只读 SELECT；捕获本身会产生变更，绝不在此执行。 */
export function collectPreviewSessionRows(
  db: Database.Database,
  rig: RigWithRelations,
  snapshot: Snapshot | null,
): PreviewSessionRow[] {
  if (snapshot) {
    return (snapshot.data.sessions ?? []).map((s) => ({
      nodeId: s.nodeId,
      restorePolicy: s.restorePolicy ?? null,
      resumeType: s.resumeType ?? null,
      resumeToken: s.resumeToken ?? null,
      // OPR.0.4.3.20 FR-6——对版本 45 之前序列化的快照降级为 null。
      resumeProvenance: s.resumeProvenance ?? null,
      resumeLastVerified: s.resumeLastVerified ?? null,
      resumeLastProbeStatus: s.resumeLastProbeStatus ?? null,
      id: s.id,
      status: s.status ?? null,
    }));
  }
  const nodeIds = rig.nodes.map((n) => n.id);
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, node_id, restore_policy, resume_type, resume_token, resume_provenance, resume_last_verified, resume_last_probe_status, status FROM sessions WHERE node_id IN (${placeholders})`
  ).all(...nodeIds) as Array<{ id: string; node_id: string; restore_policy: string | null; resume_type: string | null; resume_token: string | null; resume_provenance: string | null; resume_last_verified: string | null; resume_last_probe_status: string | null; status: string | null }>;
  return rows.map((r) => ({
    nodeId: r.node_id,
    restorePolicy: r.restore_policy,
    resumeType: r.resume_type,
    resumeToken: r.resume_token,
    resumeProvenance: r.resume_provenance,
    resumeLastVerified: r.resume_last_verified,
    resumeLastProbeStatus: r.resume_last_probe_status,
    id: r.id,
    status: r.status,
  }));
}

export function buildRestorePlanPreview(
  rig: RigWithRelations,
  snapshot: Snapshot | null,
  sessionRows: PreviewSessionRow[],
  freshLogicalIds?: string[],
  nowMs: number = Date.now(),
  recorded: Record<string, string | null> = {},
): RestorePlanPreview {
  // OPR.0.5.7.1——解析所使用的关系：预览快照时使用快照自身关系；实时无快照时，
  // 使用 SnapshotCapture 所用的同一套拟捕获推导（共享辅助函数，两个相邻路径不会漂移）。
  const relationMap = snapshot
    ? snapshot.data.activeSessionIdByNode
    : deriveRehydrateSessionIdByNode(sessionRows, rig.nodes.map((n) => n.id), recorded);
  const nodes: RestorePlanPreviewNode[] = rig.nodes.map((node) => {
    const freshRequested = freshLogicalIds?.includes(node.logicalId) ?? false;
    const resolution = snapshot
      ? resolveActiveSnapshotSession(snapshot.data, node.id)
      : sessionRows.some((row) => row.nodeId === node.id)
        ? resolveActiveOccupantRow(sessionRows, relationMap, node.id)
        : { kind: "none" as const };
    const { intendedAction, reason } = intendedActionFor(resolution, freshRequested);
    // OPR.0.4.3.20 FR-6——逐席位只读令牌状态，仅从已解析的占用者推导，绝不读取历史行。
    const occupant = resolution.kind === "resolved" ? resolution.session : null;
    const { tokenState, provenance, lastVerified } = tokenStateFor(occupant, nowMs);
    const runtimePrompt = runtimePromptFor(node.runtime, tokenState);
    return {
      logicalId: node.logicalId,
      occupantSessionId: occupant?.id ?? null,
      hasHistory: sessionRows.some((row) => row.nodeId === node.id),
      intendedAction,
      ...(reason ? { reason } : {}),
      tokenState,
      ...(provenance ? { provenance } : {}),
      ...(lastVerified ? { lastVerified } : {}),
      // 没有可续接令牌时，恢复需要显式 --fresh，绝不静默处理。关系损坏时不能 fresh；
      // A1 歧义在解决前不可恢复，因此 --fresh 不能作为补救手段。
      freshRequired: resolution.kind === "ambiguous" ? false : tokenState === "missing",
      ...(runtimePrompt ? { runtimePrompt } : {}),
    };
  });
  return {
    status: "plan",
    mode: "restore",
    rigId: rig.rig.id,
    rigName: rig.rig.name,
    snapshot: snapshot ? { id: snapshot.id, kind: snapshot.kind, createdAt: snapshot.createdAt } : null,
    wouldCaptureCurrentState: snapshot === null,
    nodes,
    mutated: false,
  };
}
