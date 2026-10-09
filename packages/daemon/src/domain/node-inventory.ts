import type { CaptureObserver, ObservedBinding } from "./capture-observer.js";
import type Database from "better-sqlite3";
import { resolveActiveOccupantRow } from "./active-occupant.js";
import type { NodeInventoryEntry, NodeDetailEntry, NodeDetailPeer, NodeDetailEdge, NodeDetailCompactSpec, NodeRestoreOutcome, NodeOriented, NodeLifecycleState, Binding, RestoreResult, NodeRecoveryGuidance, Snapshot, WorkspaceSpec, SeatIdentityVerdict, SeatIdentityVerdictKind, AgentActivity, SeatActivity } from "./types.js";
import { identityVerdictDownranksRunning } from "./types.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { buildOrientedMap } from "./startup-proof.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { ContextUsageStore } from "./context-usage-store.js";
import type { TranscriptStore } from "./transcript-store.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { SeatActivityService } from "./seat-activity-service.js";
import { deriveDisplayActivity } from "./activity-taxonomy.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { probeSessionActivity, mapPaneState } from "./session-transport.js";
import type { StructuralObservation } from "./seat-structural-activity-service.js";
import { findLatestUsableSnapshot, findLatestUsableSnapshotsForAllRigs } from "./rig-repository.js";
import { resolveNodeWorkspace } from "./workspace/workspace-resolver.js";
import { deriveCanonicalSessionName } from "./session-name.js";
import { buildNativeResumeCommand, buildCodexResumeCore } from "./native-resume-probe.js";

// -- SQL 结果行类型 --

interface InventoryRow {
  node_id: string;
  rig_id: string;
  rig_name: string;
  logical_id: string;
  pod_id: string | null;
  pod_namespace: string | null;
  role: string | null;
  runtime: string | null;
  model: string | null;
  codex_config_profile: string | null;
  agent_ref: string | null;
  profile: string | null;
  cwd: string | null;
  restore_policy: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
  resolved_spec_hash: string | null;
  occupant_lifecycle: string | null;
  continuity_outcome: string | null;
  handover_result: string | null;
  previous_occupant: string | null;
  handover_at: string | null;
  // 最新会话字段；没有会话时可能为 null。
  session_name: string | null;
  session_status: string | null;
  startup_status: string | null;
  resume_type: string | null;
  resume_token: string | null;
  startup_completed_at: string | null;
  binding_attachment_type: string | null;
  binding_tmux_pane: string | null;
}

interface EventRow {
  seq: number;
  rig_id: string;
  node_id: string;
  type: string;
  payload: string;
  created_at: string;
}

interface StartupContextRow {
  node_id: string;
  projection_entries_json: string;
  resolved_files_json: string;
  startup_actions_json: string;
  runtime: string;
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

// -- 辅助函数 --

function computeResumeCommand(runtime: string | null, resumeToken: string | null, codexConfigProfile?: string | null): string | null {
  return buildNativeResumeCommand(runtime, resumeToken, null, codexConfigProfile);
}

function computeRecoveryGuidance(input: {
  runtime: string | null;
  resumeToken: string | null;
  cwd: string | null;
  sessionName: string | null;
  codexConfigProfile?: string | null;
}): NodeRecoveryGuidance | null {
  const { runtime, resumeToken, cwd, sessionName, codexConfigProfile } = input;

  if (runtime === "claude-code") {
    const commands: string[] = [];
    const notes: string[] = [];

    if (resumeToken) {
      const cmd = buildNativeResumeCommand(runtime, resumeToken, sessionName);
      if (cmd) commands.push(cmd);
    }
    if (cwd) {
      commands.push(`cd ${cwd}`);
    }
    commands.push("claude --resume");

    if (sessionName) {
      notes.push(`查找会话名称：${sessionName}`);
    }
    notes.push("请选择完整会话选项，不要选择摘要。");

    return {
      summary: resumeToken
        ? "先尝试 Claude 原生恢复；需要时再回退到工作区本地选择器。"
        : "没有已存储的 Claude 恢复 token。请使用工作区本地 Claude 选择器回退。",
      commands,
      notes,
    };
  }

  if (runtime === "codex") {
    const commands: string[] = [];
    const notes: string[] = [];

    if (resumeToken) {
      commands.push(buildCodexResumeCore(resumeToken, codexConfigProfile));
    }
    if (cwd) {
      commands.push(`cd ${cwd}`);
    }
    if (!resumeToken) {
      commands.push(buildCodexResumeCore("", codexConfigProfile, true));
    }

    notes.push("请结合工作区和近期提示词文本识别正确会话。");
    if (codexConfigProfile) {
      notes.push(`保留 Codex 配置 profile：${codexConfigProfile}`);
    }
    if (sessionName) {
      notes.push(`如果已捕获身份锚点，选择器中可能包含：${sessionName}`);
    }

    return {
      summary: resumeToken
        ? "先尝试 Codex 原生恢复；除非存在命名配置 profile，否则托管启动会显式设置 -s workspace-write 底线参数。"
        : "没有已存储的 Codex 恢复 token。请尝试 codex -s workspace-write resume --last；除非存在命名配置 profile，否则托管启动会显式设置 -s workspace-write 底线参数。",
      commands,
      notes,
    };
  }

  return null;
}

function deriveNodeKind(runtime: string | null): "agent" | "infrastructure" {
  return runtime === "terminal" ? "infrastructure" : "agent";
}

/**
 * 根据会话/恢复事实与工作组最新可用快照派生每节点生命周期状态。
 *
 * 优先级（L2 后）：
 *   attention_required  — restoreOutcome=failed 且 tmux 会话仍存活
 *                         （Claude 恢复提示场景的 v0 代理，L3 会重新审视）。
 *   running             — sessionStatus=running。
 *   recoverable         — 会话未运行，且最新可用快照为此节点提供非 null 恢复 token。
 *   detached            — 其他全部情况（无会话、已退出、detached 且无恢复 token）。
 *
 * 上游权限/I/O 失败（L1 失败关闭）不改变 sessionStatus，因此投影保持诚实，不会误判有歧义的
 * 探测失败。
 */
export function deriveNodeLifecycleState(input: {
  sessionStatus: string | null;
  /** 启动待关注状态是实时席位状态，与恢复历史无关。 */
  startupStatus?: string | null;
  restoreOutcome: NodeRestoreOutcome;
  nodeId: string;
  usableSnapshot: Snapshot | null;
  /** OPR.0.4.3.19——此节点持久化的存活身份判决。`mismatch`/`pane_missing` 会把
   * `running` 会话降为 `attention_required`，避免假绿；`verified`、`tmux_unavailable`
   * 和缺失判决不改变投影。 */
  identityVerdict?: SeatIdentityVerdictKind | null;
}): NodeLifecycleState {
  // L3：显式 `attention_required` 结果（Claude 恢复选择提示）和 L2 代理（failed + tmux
  // 会话存活）都显示为 lifecycleState=attention_required。
  if (
    input.startupStatus === "attention_required"
    || input.restoreOutcome === "attention_required"
    || (input.restoreOutcome === "failed" && input.sessionStatus === "running")
  ) {
    return "attention_required";
  }
  if (input.sessionStatus === "running") {
    // OPR.0.4.3.19——`running` 会话只有在窗格进程身份已验证（或尚未观察）时才投影为
    // `running`。显式 mismatch/pane-missing 判决会降为 attention_required，使死亡、孤立或
    // 被占用的窗格绝不会显示为健康绿色。
    if (identityVerdictDownranksRunning(input.identityVerdict)) return "attention_required";
    return "running";
  }
  if (input.usableSnapshot) {
    // OPR.0.5.7.1——可恢复性跟随已解析占用者（执行流程消费的同一四路阶梯），绝不使用
    // 第一条匹配行。恢复流程会拒绝的历史行 token 不能让界面显示为 recoverable。
    const resolution = resolveActiveOccupantRow(
      input.usableSnapshot.data.sessions ?? [],
      input.usableSnapshot.data.activeSessionIdByNode,
      input.nodeId,
    );
    if (
      resolution.kind === "resolved"
      && typeof resolution.session.resumeToken === "string"
      && resolution.session.resumeToken.length > 0
    ) {
      return "recoverable";
    }
  }
  return "detached";
}

function deriveOccupantLifecycle(
  row: InventoryRow,
  identityVerdict?: SeatIdentityVerdictKind | null,
): NodeInventoryEntry["occupantLifecycle"] {
  if (row.occupant_lifecycle) {
    return row.occupant_lifecycle as NodeInventoryEntry["occupantLifecycle"];
  }
  // OPR.0.4.3.19——派生的 `active` 占用者要求窗格身份已验证或尚未观察，与
  // lifecycleState 门禁一致。
  if (row.session_status === "running" && !identityVerdictDownranksRunning(identityVerdict)) {
    return "active";
  }
  return "unknown";
}

function deriveContinuityOutcome(
  row: InventoryRow,
  restoreOutcome: NodeRestoreOutcome,
): NodeInventoryEntry["continuityOutcome"] {
  if (row.continuity_outcome) {
    return row.continuity_outcome as NodeInventoryEntry["continuityOutcome"];
  }
  if (restoreOutcome === "n-a") return null;
  // L3：`attention_required` 和 `operator_recovered` 是恢复尝试结果，不能直接映射到
  // ContinuityOutcome 词汇（"resumed"|"rebuilt"|"forked"|"fresh"|"failed"）。
  // 此处显示为 null；lifecycleState 投影会直接通过 restoreOutcome 处理。
  if (restoreOutcome === "attention_required") return null;
  if (restoreOutcome === "operator_recovered") return "resumed";
  // OPR.0.3.4.2：显式 fresh-prime 属于 fresh 连续性；awaiting-decision 表示没有会话，
  // 因而不存在连续性结果，返回 null；restoreOutcome 字段保留其独立术语。
  if (restoreOutcome === "fresh-primed") return "fresh";
  if (restoreOutcome === "awaiting-decision") return null;
  return restoreOutcome;
}

// FS-1 W1.3 S1——将恢复结果派生提升为每个工作组只执行一次。旧结构在
// buildInventoryEntry 内对每个节点调用 deriveRestoreOutcome(db, rigId, nodeId)，每次都获取
// 并解析该工作组的全部恢复事件（每轮 K 个节点 × E 个事件，是主要 W3 残余开销）。现在通过
// 一次 seq 降序遍历构建 nodeId→outcome map，buildInventoryEntry 只做 O(1) 查找。
// OPR.0.3.4.11 + 0.4.0.16：在 restore.completed、restore.subset_completed 和
// restore.outcome_reconciled 之间取每节点最新结果；reconciled 结构不同，使用顶层 nodeId/to，
// 而不是 result.nodes[]。
// 结构上保证逐字节一致：旧版逐节点读取器返回 seq 降序中第一条引用该节点的事件。单次
// seq 降序遍历仅在节点尚无结果时赋值，因此同样由第一条、即 seq 最大的事件获胜，包括
// 新 reconcile 覆盖旧 failure。提供 rigId 时使用原单工作组过滤 WHERE rig_id=?；省略时一次
// 扫描全部工作组。节点只会被自身工作组事件引用，所以每节点结果相同。
// [代码评审核心：仅在 absent 时赋值是承重语义，它保证第一条/最新事件获胜。]
function buildRestoreOutcomeMap(db: Database.Database, rigId?: string): Map<string, NodeRestoreOutcome> {
  const stmt = db.prepare(
    `SELECT type, payload, seq FROM events WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled')${rigId ? " AND rig_id = ?" : ""} ORDER BY seq DESC`
  );
  const rows = (rigId ? stmt.all(rigId) : stmt.all()) as { type: string; payload: string; seq: number }[];
  const map = new Map<string, NodeRestoreOutcome>();
  for (const row of rows) {
    try {
      if (row.type === "restore.outcome_reconciled") {
        const event = JSON.parse(row.payload) as { nodeId: string; to: string };
        if (!map.has(event.nodeId)) map.set(event.nodeId, mapStatus(event.to));
        continue;
      }
      const event = JSON.parse(row.payload) as { result: RestoreResult };
      for (const nodeResult of event.result.nodes) {
        if (!map.has(nodeResult.nodeId)) map.set(nodeResult.nodeId, mapStatus(nodeResult.status));
      }
    } catch {
      continue;
    }
  }
  return map;
}

function mapStatus(status: string): NodeRestoreOutcome {
  if (status === "resumed") return "resumed";
  if (status === "failed") return "failed";
  if (status === "rebuilt") return "rebuilt";
  if (status === "fresh") return "fresh";
  if (status === "fresh-primed") return "fresh-primed";
  if (status === "awaiting-decision") return "awaiting-decision";
  if (status === "attention_required") return "attention_required";
  if (status === "operator_recovered") return "operator_recovered";
  if (status === "checkpoint_written") return "rebuilt";
  if (status === "fresh_no_checkpoint") return "fresh";
  return "n-a";
}

function deriveHeldReason(db: Database.Database, rigId: string, nodeId: string, sessionStatus: string | null): string | null {
  if (sessionStatus === "running") return null;

  const heldRow = db.prepare(
    "SELECT seq, payload FROM events WHERE node_id = ? AND type = 'node.held' ORDER BY seq DESC LIMIT 1"
  ).get(nodeId) as { seq: number; payload: string } | undefined;
  if (!heldRow) return null;

  // 若后续工作组范围恢复事件包含此节点，则当前 held 已被取代。restore.completed /
  // restore.subset_completed 属于工作组范围（无顶层 nodeId），因此按 rig_id 查询并解析
  // payload 判断是否包含节点。
  const laterRestoreRows = db.prepare(
    "SELECT payload FROM events WHERE rig_id = ? AND type IN ('restore.completed', 'restore.subset_completed') AND seq > ? ORDER BY seq DESC"
  ).all(rigId, heldRow.seq) as { payload: string }[];
  for (const row of laterRestoreRows) {
    try {
      const event = JSON.parse(row.payload) as { result: { nodes: Array<{ nodeId: string }> } };
      if (event.result?.nodes?.some((n) => n.nodeId === nodeId)) return null;
    } catch { continue; }
  }

  try {
    const parsed = JSON.parse(heldRow.payload) as { reason?: string };
    return parsed.reason ?? null;
  } catch {
    return null;
  }
}

function getLatestError(db: Database.Database, rigId: string, nodeId: string): string | null {
  const row = db.prepare(
    "SELECT payload FROM events WHERE rig_id = ? AND node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1"
  ).get(rigId, nodeId) as { payload: string } | undefined;

  if (!row) return null;

  try {
    const event = JSON.parse(row.payload) as { error?: string };
    return event.error ?? null;
  } catch {
    return null;
  }
}

/**
 * 将持久化投影条目映射到 installedResources 结构。startup-orchestrator 持久化：
 * { category, effectiveId, sourceSpec, sourcePath, resourcePath, absolutePath, mergeStrategy, target }；
 * 此处规范化为 { id, category, targetPath }。
 */
function mapProjectionEntries(entries: unknown[]): Array<{ id: string; category: string; targetPath: string }> {
  return entries.map((e: unknown) => {
    const entry = e as Record<string, string>;
    return {
      id: entry.effectiveId ?? entry.id ?? "",
      category: entry.category ?? "",
      targetPath: entry.target ?? entry.targetPath ?? "",
    };
  });
}

/**
 * OPR.0.4.3.19 rev1-r2 B1——把持久身份判决限定到当前 binding。判决表仅以 node_id 为键，
 * 因此重新 binding/启动后（相同 node_id，新会话 + 新窗格），已存判决描述的是不再绑定的
 * 旧窗格。若用于新窗格会形成假绿窗口：过期 `verified` 会抑制新占位/孤立窗格应触发的降级；
 * 过期 `mismatch` 又会把健康新窗格降级。
 *
 * 判决只有在针对当前 binding 计算时才适用：
 *   verdict.sessionName === row.session_name  AND
 *   verdict.evidence.registeredPane === row.tmux_pane
 * 否则返回 null，投影将其视为缺失（失败开放：运行中席位保持不变，绝不降级）。这维持
 * rev1-r1 的失败开放纪律：把过期判决视为缺失不会降级，只有匹配当前 binding 的
 * mismatch/pane_missing 才会降级。
 */
function applicableVerdict(
  verdict: SeatIdentityVerdict | null,
  row: Pick<InventoryRow, "session_name" | "binding_tmux_pane">,
): SeatIdentityVerdict | null {
  if (!verdict) return null;
  if (verdict.sessionName !== row.session_name) return null;
  if (verdict.evidence.registeredPane !== row.binding_tmux_pane) return null;
  return verdict;
}

// -- 公共 API --

/**
 * 获取工作组的规范节点清单；CLI、UI 和 MCP 共用的唯一事实源。
 */
export function getNodeInventory(db: Database.Database, rigId: string): NodeInventoryEntry[] {
  // 整个投影只解析一次工作组最新可用快照，使每节点可恢复性检查共享同一事实源，避免 N 次额外查询。
  const usableSnapshot = findLatestUsableSnapshot(db, rigId);
  // PL-007：每次投影只加载一次工作组类型化 workspace 块（若有声明），使每节点 kind 解析
  // 共享一次解析。
  const workspaceSpec = readRigWorkspaceJson(db, rigId);
  // OPR.0.4.3.19：每次投影只读取一次持久化的每节点存活身份判决。该操作使用低成本索引，
  // 并能防御表缺失；它为下方 running/active 绿色状态派生设门禁。
  const identityVerdicts = new SeatIdentityStore(db).getForRig(rigId);
  // FS-1 W1.3 S1/S2——每工作组只构建一次每节点 restore-outcome + oriented 读取；此前在
  // rows.map 内逐节点查询。工作组范围 restore map 等于原 WHERE rig_id=? 过滤；oriented map
  // 是节点范围/全局。
  const restoreOutcomes = buildRestoreOutcomeMap(db, rigId);
  const orienteds = buildOrientedMap(db);

  const rows = queryInventoryRows(db, rigId);

  return rows.map((row) =>
    buildInventoryEntry(db, row, { usableSnapshot, workspaceSpec, identityVerdicts, restoreOutcomes, orienteds }),
  );
}

/**
 * FS-1 W1.2——共享清单行查询。它从旧版内联 `getNodeInventory` SELECT 逐字提取，确保单
 * 工作组和全部工作组路径执行完全相同的查询。
 *   - 提供 `rigId` → 单工作组（`WHERE n.rig_id = ?`、`ORDER BY n.created_at`），与旧版
 *     逐工作组读取逐字节一致。
 *   - 省略 `rigId` → 一次读取全部工作组（无 WHERE；`ORDER BY n.rig_id, n.created_at`，
 *     使 JS 分组保留每个工作组的 `created_at` 顺序，与逐工作组顺序完全一致）。
 * 最新会话子查询（`s2.node_id = n.id ORDER BY id DESC LIMIT 1`）使用 W1.1 索引
 *（051，idx_sessions_node_created_id）。
 */
function runInventoryRowQuery(db: Database.Database, whereClause: string, orderClause: string, params: readonly string[]): InventoryRow[] {
  // 将节点与最新会话（最大 ULID = session.id 字符串比较最大值）及工作组名称联接。
  const hasCodexConfigProfile = db.prepare("PRAGMA table_info(nodes)").all()
    .some((row) => (row as { name?: string }).name === "codex_config_profile");
  const codexConfigProfileSelect = hasCodexConfigProfile
    ? "n.codex_config_profile"
    : "NULL";
  const stmt = db.prepare(`
    SELECT
      n.id as node_id,
      n.rig_id,
      r.name as rig_name,
      n.logical_id,
      n.pod_id,
      p.namespace as pod_namespace,
      n.role,
      n.runtime,
      n.model,
      ${codexConfigProfileSelect} as codex_config_profile,
      n.agent_ref,
      n.profile,
      n.cwd,
      n.restore_policy,
      n.resolved_spec_name,
      n.resolved_spec_version,
      n.resolved_spec_hash,
      n.occupant_lifecycle,
      n.continuity_outcome,
      n.handover_result,
      n.previous_occupant,
      n.handover_at,
      s.session_name,
      s.status as session_status,
      s.startup_status,
      s.resume_type,
      s.resume_token,
      s.startup_completed_at,
      b.attachment_type as binding_attachment_type,
      b.tmux_pane as binding_tmux_pane
    FROM nodes n
    JOIN rigs r ON r.id = n.rig_id
    LEFT JOIN pods p ON p.id = n.pod_id
    LEFT JOIN sessions s ON s.node_id = n.id
      AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
    LEFT JOIN bindings b ON b.node_id = n.id
    ${whereClause}
    ORDER BY ${orderClause}
  `);
  return stmt.all(...params) as InventoryRow[];
}

// 单工作组（WHERE n.rig_id=?）或全部工作组（无 WHERE）。SQL/顺序与旧版内联读取逐字节
// 一致，既有单工作组调用方不变。
function queryInventoryRows(db: Database.Database, rigId?: string): InventoryRow[] {
  return runInventoryRowQuery(
    db,
    rigId ? "WHERE n.rig_id = ?" : "",
    rigId ? "n.created_at" : "n.rig_id, n.created_at",
    rigId ? [rigId] : [],
  );
}

// 限定到工作组 ID 集合；每个 IN 值都以参数绑定，并保留逐工作组 created_at 顺序
//（与全部工作组路径使用相同 ORDER BY）。调用方保证列表非空；空集合会让
// getNodeInventoryForRigs 提前返回，不执行查询。
function queryInventoryRowsForRigs(db: Database.Database, rigIds: readonly string[]): InventoryRow[] {
  const placeholders = rigIds.map(() => "?").join(", ");
  return runInventoryRowQuery(db, `WHERE n.rig_id IN (${placeholders})`, "n.rig_id, n.created_at", rigIds);
}

/** 构建清单行时使用的逐工作组设置上下文。FS-1 W1.2：单工作组
 *（`getNodeInventory`）和全部工作组（`getNodeInventoryForAllRigs`）路径都通过此函数
 * 构建条目，因此输出在结构上逐字节一致。合并只改变获取上下文和行的方式（逐工作组或批量），
 * 不改变条目派生方式。 */
interface InventoryBuildContext {
  usableSnapshot: Snapshot | null;
  workspaceSpec: WorkspaceSpec | null;
  identityVerdicts: Map<string, SeatIdentityVerdict>;
  // FS-1 W1.3 S1/S2——以 node_id 为键、每工作组批量一次的逐节点读取。每次投影只构建
  // 一次（单工作组路径限定工作组，批量路径覆盖全部工作组），此处 O(1) 查找，不再逐节点查询。
  restoreOutcomes: Map<string, NodeRestoreOutcome>;
  orienteds: Map<string, NodeOriented>;
}

function buildInventoryEntry(
  db: Database.Database,
  row: InventoryRow,
  ctx: InventoryBuildContext,
): NodeInventoryEntry {
  const { usableSnapshot, workspaceSpec, identityVerdicts, restoreOutcomes, orienteds } = ctx;
  // FS-1 W1.3 S1——在每工作组一次的 restore-outcome map 中 O(1) 查找；与旧版逐节点
  // deriveRestoreOutcome 逐字节一致。没有恢复事件引用节点时为 "n-a"，与旧版回退一致。
  const restoreOutcome = restoreOutcomes.get(row.node_id) ?? "n-a";
  // OPR.0.4.3.19 rev1-r2 B1——持久判决仅以 node_id 为键，因此重新绑定/启动后（同节点、
  // 新会话 + 新窗格），旧窗格的过期 `verified` 判决在下一次 5 秒对账前可能被用于新窗格，
  // 抑制应有降级并形成新的占位/孤立假绿；过期 `mismatch` 也可能错误降级健康新窗格。
  // 读取时把适用性作为承重条件：存储判决只有在针对当前 binding 计算时才适用，即
  // sessionName === 最新会话，且 registeredPane === 当前 binding 窗格。否则视为缺失 null。
  // 过期判决采用失败开放，不会自行降级运行中席位；只有匹配的 mismatch/pane_missing 会降级。
  const identityVerdict = applicableVerdict(identityVerdicts.get(row.node_id) ?? null, row);
  const lifecycleState = deriveNodeLifecycleState({
    sessionStatus: row.session_status,
    startupStatus: row.startup_status,
    restoreOutcome,
    nodeId: row.node_id,
    usableSnapshot,
    identityVerdict: identityVerdict?.verdict ?? null,
  });
  return {
    nodeId: row.node_id,
    rigId: row.rig_id,
    rigName: row.rig_name,
    logicalId: row.logical_id,
    podId: row.pod_id,
    podNamespace: row.pod_namespace,
    // OPR.0.4.6.FAC1：席位侧角色维度（nodes.role，在 pod-member spec 中声明），是工作流
    // binding 层的候选过滤器。null 表示无角色，永不进行角色解析。
    role: row.role,
    canonicalSessionName: row.session_name,
    attachmentType: (row.binding_attachment_type as NodeInventoryEntry["attachmentType"]) ?? null,
    nodeKind: deriveNodeKind(row.runtime),
    runtime: row.runtime,
    sessionStatus: row.session_status,
    startupStatus: row.startup_status as NodeInventoryEntry["startupStatus"],
    restoreOutcome,
    // FS-1 W1.3 S2——在舰队批量 oriented map 中 O(1) 查找；与旧版逐节点 deriveOriented
    // 逐字节一致。节点没有证明事件时为 "n-a"，对应 deriveOriented 的无挑战分支。
    oriented: orienteds.get(row.node_id) ?? "n-a",
    lifecycleState,
    occupantLifecycle: deriveOccupantLifecycle(row, identityVerdict?.verdict ?? null),
    continuityOutcome: deriveContinuityOutcome(row, restoreOutcome),
    handoverResult: row.handover_result as NodeInventoryEntry["handoverResult"] ?? null,
    previousOccupant: row.previous_occupant,
    handoverAt: row.handover_at,
    tmuxAttachCommand: row.binding_attachment_type === "tmux" && row.session_name ? `tmux attach -t ${row.session_name}` : null,
    resumeCommand: computeResumeCommand(row.runtime, row.resume_token, row.codex_config_profile),
    // OPR.0.4.0.26：LIST 载荷不再逐节点内联 recoveryGuidance。它会在所有节点间重复约
    // 47KB 模板散文，且没有节点列表消费者读取。完整指导改在单节点详情路径
    //（getNodeDetail / GET /api/rigs/:rigId/nodes/:logicalId）重新计算，只是迁移位置，未丢失。
    recoveryGuidance: null,
    latestError: row.startup_status === "ready" ? null : getLatestError(db, row.rig_id, row.node_id),
    // 扩展字段。
    model: row.model,
    agentRef: row.agent_ref,
    profile: row.profile,
    codexConfigProfile: row.codex_config_profile,
    resolvedSpecName: row.resolved_spec_name,
    resolvedSpecVersion: row.resolved_spec_version,
    resolvedSpecHash: row.resolved_spec_hash,
    cwd: row.cwd,
    restorePolicy: row.restore_policy,
    resumeType: row.resume_type,
    resumeToken: row.resume_token,
    startupCompletedAt: row.startup_completed_at,
    // PL-007 Workspace Primitive——根据 cwd 和工作组类型化 workspace 块派生的逐节点
    // 工作区摘要；工作组未声明 workspace 时为 null。
    workspace: resolveNodeWorkspace({ spec: workspaceSpec, cwd: row.cwd }),
    // OPR.0.4.3.19——存活身份判决（第三维）。从未观察时为 null；mismatch/missing 时携带证据。
    identityVerdict,
    heldReason: deriveHeldReason(db, row.rig_id, row.node_id, row.session_status),
  };
}

/** FS-1 W1.2——`readRigWorkspaceJson` 的全工作组批量形式：一次查询生成
 * `rigId → WorkspaceSpec`。没有 workspace 或格式错误的工作组不出现在结果中；调用方默认
 * 为 null，与 `readRigWorkspaceJson` 返回 null 逐字节一致。 */
function readAllRigWorkspaceJson(db: Database.Database): Map<string, WorkspaceSpec> {
  const out = new Map<string, WorkspaceSpec>();
  try {
    const rows = db.prepare("SELECT id, workspace_json FROM rigs").all() as Array<{ id: string; workspace_json: string | null }>;
    for (const row of rows) {
      if (!row.workspace_json) continue;
      try { out.set(row.id, JSON.parse(row.workspace_json) as WorkspaceSpec); } catch { /* 格式错误 → 缺失 → 调用方取 null，与逐工作组路径一致。 */ }
    }
  } catch { /* 列/表缺失 → 空结果 → 调用方取 null，与逐工作组防御路径一致。 */ }
  return out;
}

/**
 * FS-1 W1.2——消除工作组级 N+1。使用与工作组数量无关的有界查询集构建全部工作组清单：
 * 三次批量设置读取（快照/workspace/身份判决）+ 一次全部工作组节点 SELECT，并按 rig_id 分组。
 * 每个条目都通过逐工作组 `getNodeInventory` 使用的同一个 `buildInventoryEntry` 构建，因此
 * `getNodeInventoryForAllRigs(db).get(rigId)` 与 `getNodeInventory(db, rigId)` 逐字节一致。
 * 合并只改变上下文和行的获取方式（批量或逐工作组），不改变条目派生方式。
 * `buildInventoryEntry` 内的逐节点读取仍使用 047 索引；它们不是此处移除的工作组级 N+1。
 */
// 共享批量构建器——全部工作组和限定工作组路径的公共主体。一次构建舰队设置 map，并恰好
// 执行一次舰队启动方向扫描 buildOrientedMap 和一次恢复结果扫描 buildRestoreOutcomeMap；
// 随后通过同一个 buildInventoryEntry 为每个给定行构建条目，按 rig_id 分组并保留每工作组
// created_at 顺序。`rows` 决定范围（全部工作组或指定集合）；条目派生完全一致，因此无论由
// 哪个调用方运行，同一工作组的条目都逐字节一致。
function buildInventoryMapFromRows(db: Database.Database, rows: InventoryRow[]): Map<string, NodeInventoryEntry[]> {
  const snapshotByRig = findLatestUsableSnapshotsForAllRigs(db);
  const workspaceByRig = readAllRigWorkspaceJson(db);
  const verdictsByRig = new SeatIdentityStore(db).getForAllRigs();
  // FS-1 W1.3 S1/S2——逐节点读取只构建一次（O(1) 次查询，而非 O(nodes)）。restore map
  // 不限定工作组：nodeId 只会被自身工作组的恢复事件引用，所以每节点值与单工作组路径一致。
  const restoreOutcomes = buildRestoreOutcomeMap(db); // one fleet restore-outcome scan
  const orienteds = buildOrientedMap(db);             // one fleet startup-orientation scan
  const out = new Map<string, NodeInventoryEntry[]>();
  for (const row of rows) {
    const entry = buildInventoryEntry(db, row, {
      usableSnapshot: snapshotByRig.get(row.rig_id) ?? null,
      workspaceSpec: workspaceByRig.get(row.rig_id) ?? null,
      identityVerdicts: verdictsByRig.get(row.rig_id) ?? new Map(),
      restoreOutcomes,
      orienteds,
    });
    let list = out.get(row.rig_id);
    if (!list) { list = []; out.set(row.rig_id, list); }
    list.push(entry);
  }
  return out;
}

export function getNodeInventoryForAllRigs(db: Database.Database): Map<string, NodeInventoryEntry[]> {
  return buildInventoryMapFromRows(db, queryInventoryRows(db));
}

// slice-04——只为选定的工作组集合构建清单，例如摘要实际返回的工作组，因而逐节点折叠不会
// 扩大到调用方已排除的工作组（例如 archived）。共享构建器仍只执行一次舰队启动方向和一次
// 舰队恢复结果扫描。空集合返回空 Map，不扫描，也不会生成无效 `IN ()`。
// getNodeInventoryForRigs(db, {r}).get(r) 与全部工作组路径中 r 的条目列表逐字节一致。
export function getNodeInventoryForRigs(db: Database.Database, rigIds: ReadonlySet<string>): Map<string, NodeInventoryEntry[]> {
  if (rigIds.size === 0) return new Map();
  return buildInventoryMapFromRows(db, queryInventoryRowsForRigs(db, [...rigIds]));
}

/** PL-007——防御性读取 `rigs.workspace_json` 中工作组的类型化 workspace 块。绕过规范迁移
 * 列表的旧测试 fixture 可能尚未应用迁移 038，因此列缺失时干净地返回 null。 */
function readRigWorkspaceJson(db: Database.Database, rigId: string): WorkspaceSpec | null {
  try {
    const row = db.prepare("SELECT workspace_json FROM rigs WHERE id = ?")
      .get(rigId) as { workspace_json: string | null } | undefined;
    if (!row || !row.workspace_json) return null;
    return JSON.parse(row.workspace_json) as WorkspaceSpec;
  } catch {
    return null;
  }
}

/**
 * 获取节点详细信息，包括启动文件、资源和事件。适配器依赖可选；提供时使用实时
 * listInstalled，否则回退到启动上下文中的投影条目。
 */
export function getNodeDetail(
  db: Database.Database,
  rigId: string,
  logicalId: string,
  opts?: {
    adapters?: Record<string, RuntimeAdapter>;
    /** 预先解析的已安装资源，来自 adapter.listInstalled()，由路由层提供。 */
    installedResourcesOverride?: Array<{ id: string; category: string; targetPath: string }>;
  },
): NodeDetailEntry | null {
  // 先获取清单条目。
  const allEntries = getNodeInventory(db, rigId);
  const entry = allEntries.find((e) => e.logicalId === logicalId);
  if (!entry) return null;

  // 查找节点 ID。
  const nodeRow = db.prepare(
    "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?"
  ).get(rigId, logicalId) as { id: string } | undefined;
  if (!nodeRow) return null;
  const nodeId = nodeRow.id;

  // Binding。
  const bindingRow = db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeId) as BindingRow | undefined;
  const binding: Binding | null = bindingRow ? {
    id: bindingRow.id,
    nodeId,
    attachmentType: (bindingRow.attachment_type as Binding["attachmentType"]) ?? "tmux",
    tmuxSession: bindingRow.tmux_session,
    tmuxWindow: bindingRow.tmux_window,
    tmuxPane: bindingRow.tmux_pane,
    externalSessionName: bindingRow.external_session_name ?? null,
    cmuxWorkspace: bindingRow.cmux_workspace,
    cmuxSurface: bindingRow.cmux_surface,
    updatedAt: bindingRow.updated_at,
  } : null;

  // 启动上下文。
  const ctxRow = db.prepare(
    "SELECT * FROM node_startup_context WHERE node_id = ?"
  ).get(nodeId) as StartupContextRow | undefined;

  const startupFiles = ctxRow ? JSON.parse(ctxRow.resolved_files_json) : [];
  const startupActions = ctxRow ? JSON.parse(ctxRow.startup_actions_json) : [];
  const projectionEntries = ctxRow ? JSON.parse(ctxRow.projection_entries_json) : [];

  // 已安装资源：override（来自异步适配器调用）优先于投影回退。
  let installedResources: NodeDetailEntry["installedResources"];
  if (opts?.installedResourcesOverride) {
    installedResources = opts.installedResourcesOverride;
  } else if (opts?.adapters?.[entry.runtime ?? ""] && binding) {
    // 适配器可用时，调用方应已通过异步 listInstalled 预解析。若调用方传入适配器但没有
    // override，则为兼容测试尝试同步调用。
    try {
      const adapter = opts.adapters[entry.runtime ?? ""]!;
      const nodeBinding = { ...binding, cwd: entry.cwd ?? "." };
      const resources = adapter.listInstalled(nodeBinding) as unknown;
      // 同时处理同步测试 mock 与真实适配器 Promise。
      if (Array.isArray(resources)) {
        installedResources = (resources as Array<{ effectiveId: string; category: string; installedPath: string }>).map((r) => ({
          id: r.effectiveId,
          category: r.category,
          targetPath: r.installedPath,
        }));
      } else {
        // 异步结果——回退到投影。
        installedResources = mapProjectionEntries(projectionEntries);
      }
    } catch {
      installedResources = mapProjectionEntries(projectionEntries);
    }
  } else {
    // 投影回退。
    installedResources = mapProjectionEntries(projectionEntries);
  }

  // 近期事件（此节点最近 20 条）。
  const eventRows = db.prepare(
    "SELECT * FROM events WHERE node_id = ? ORDER BY seq DESC LIMIT 20"
  ).all(nodeId) as EventRow[];

  const recentEvents = eventRows.map((r) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload); } catch { /* 保持空对象。 */ }
    return {
      type: r.type,
      createdAt: r.created_at,
      payload,
    };
  });

  // 基础设施启动命令。
  let infrastructureStartupCommand: string | null = null;
  if (entry.nodeKind === "infrastructure" && startupActions.length > 0) {
    const sendTextAction = startupActions.find((a: { type: string }) => a.type === "send_text");
    if (sendTextAction) {
      infrastructureStartupCommand = sendTextAction.value;
    }
  }

  // 同级节点：同一工作组中的其他节点。
  const peers: NodeDetailPeer[] = allEntries
    .filter((e) => e.logicalId !== logicalId)
    .map((e) => ({
      logicalId: e.logicalId,
      canonicalSessionName: e.canonicalSessionName,
      attachmentType: e.attachmentType,
      runtime: e.runtime,
    }));

  // 此节点的出边与入边。
  const edgeRows = db.prepare(
    "SELECT e.kind, e.source_id, e.target_id, src.logical_id as src_logical, tgt.logical_id as tgt_logical " +
    "FROM edges e " +
    "JOIN nodes src ON src.id = e.source_id " +
    "JOIN nodes tgt ON tgt.id = e.target_id " +
    "WHERE e.rig_id = ? AND (e.source_id = ? OR e.target_id = ?)"
  ).all(rigId, nodeId, nodeId) as Array<{ kind: string; source_id: string; target_id: string; src_logical: string; tgt_logical: string }>;

  const nodeSessionMap = new Map(allEntries.map((e) => [e.logicalId, e.canonicalSessionName]));
  const outgoing: NodeDetailEdge[] = [];
  const incoming: NodeDetailEdge[] = [];
  for (const row of edgeRows) {
    if (row.source_id === nodeId) {
      outgoing.push({ kind: row.kind, to: { logicalId: row.tgt_logical, sessionName: nodeSessionMap.get(row.tgt_logical) ?? null } });
    }
    if (row.target_id === nodeId) {
      incoming.push({ kind: row.kind, from: { logicalId: row.src_logical, sessionName: nodeSessionMap.get(row.src_logical) ?? null } });
    }
  }

  // 紧凑 spec 摘要。
  const compactSpec: NodeDetailCompactSpec = {
    name: entry.resolvedSpecName,
    version: entry.resolvedSpecVersion,
    profile: entry.profile,
    skillCount: installedResources.filter((r) => r.category === "skill" || r.category === "skills").length,
    guidanceCount: installedResources.filter((r) => r.category === "guidance" || r.category === "guidance_merge").length,
  };

  return {
    ...entry,
    // OPR.0.4.0.26：LIST 省略 recoveryGuidance 以保持精简；单节点详情根据条目的恢复字段
    // 重新计算完整指导。这只是移动逐节点说明的位置，并未丢失信息。
    recoveryGuidance: computeRecoveryGuidance({
      runtime: entry.runtime,
      resumeToken: entry.resumeToken,
      cwd: entry.cwd,
      sessionName: entry.canonicalSessionName,
      codexConfigProfile: entry.codexConfigProfile,
    }),
    binding,
    startupFiles,
    startupActions,
    installedResources,
    recentEvents,
    infrastructureStartupCommand,
    peers,
    edges: { outgoing, incoming },
    transcript: { enabled: false, path: null, tailCommand: null }, // populated by route handler
    compactSpec,
  };
}

/**
 * 上下文感知包装器：返回附带上下文用量的清单。所有读取共用一个后台服务拥有的
 * ContextUsageStore。
 */
export function getNodeInventoryWithContext(
  db: Database.Database,
  rigId: string,
  contextUsageStore: ContextUsageStore,
  transcriptStore?: Pick<TranscriptStore, "getIngestHealth">,
): NodeInventoryEntry[] {
  const entries = getNodeInventory(db, rigId);

  // 查找节点 ID，供批量读取。
  const nodeRows = db.prepare(
    "SELECT id, logical_id FROM nodes WHERE rig_id = ?"
  ).all(rigId) as Array<{ id: string; logical_id: string }>;
  const nodeIdByLogicalId = new Map(nodeRows.map((r) => [r.logical_id, r.id]));

  const contextEntries = entries.map((e) => ({
    nodeId: nodeIdByLogicalId.get(e.logicalId) ?? "",
    currentSessionName: e.canonicalSessionName,
  }));

  const contextMap = contextUsageStore.getForNodes(contextEntries);

  return entries.map((e) => {
    const nodeId = nodeIdByLogicalId.get(e.logicalId) ?? "";
    const usage = contextMap.get(nodeId) ?? contextUsageStore.unknownUsage("no_data");
    // OPR.0.4.0.26：从 LIST 的 contextUsage 移除较重的 `currentUsage` blob。它是逐节点
    // 序列化用量载荷，在大型舰队中约 79KB，且节点列表消费者均不读取。保留全部标量，
    // 因而环形图/表格/过滤器消费者不受影响。完整 currentUsage 仍保留在详情/whoami 路径
    //（getNodeDetailWithContext、whoami）中。
    const transcriptIngest = transcriptStore && e.canonicalSessionName
      ? {
          ...transcriptStore.getIngestHealth(e.rigName, e.canonicalSessionName),
          runtime: e.runtime,
        }
      : undefined;
    return {
      ...e,
      contextUsage: { ...usage, currentUsage: null },
      ...(transcriptIngest ? { transcriptIngest } : {}),
    };
  });
}

/**
 * 上下文感知包装器：返回附带上下文用量的节点详情。
 */
export function getNodeDetailWithContext(
  db: Database.Database,
  rigId: string,
  logicalId: string,
  contextUsageStore: ContextUsageStore,
  opts?: Parameters<typeof getNodeDetail>[3],
): NodeDetailEntry | null {
  const detail = getNodeDetail(db, rigId, logicalId, opts);
  if (!detail) return null;

  const nodeRow = db.prepare(
    "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?"
  ).get(rigId, logicalId) as { id: string } | undefined;

  if (nodeRow) {
    detail.contextUsage = contextUsageStore.getForNode(nodeRow.id, detail.canonicalSessionName);
  } else {
    detail.contextUsage = contextUsageStore.unknownUsage("no_data");
  }

  return detail;
}

/**
 * Slice 15——填充每节点的 `terminalActive` + `hasAssignedWork`。
 *
 * 两项正交增强独立计算（遵循 IMPL-PRD §2.3 的非推断契约）：
 *   - `terminalActive`：从 SeatActivityService 读取（tmux 信号）
 *   - 已分配工作计数：destination_session 匹配席位任一规范坐标的 pending、in-progress
 *     和 blocked queue_items
 *
 * 纯函数且同步，使每次请求都会获取此投影的 `zrig ps` 与 UI 保持低开销。两项增强不会读取
 * 对方的数据源。
 */
export function attachTerminalActivityAndWork(
  entries: NodeInventoryEntry[],
  deps: { db: Database.Database; seatActivity?: SeatActivityService },
): NodeInventoryEntry[] {
  const seatActivity = deps.seatActivity ?? null;
  const assignedByDest = readAssignedWorkBySession(deps.db);
  return entries.map((entry) => {
    let terminalActive: boolean | null | undefined = undefined;
    // 架构裁决 3a947fb1（FR-7 增量）：从同一观察中同时投影原始 lastActivityAt 事实与
    // terminalActive，遵循诚实缺失阶梯（有观察 → 值；无观察 → null；无服务 → undefined）。
    // 不增加 ageSeconds 同级字段；年龄由渲染器根据此事实和读取者时钟派生（C3）。
    let lastActivityAt: string | null | undefined = undefined;
    if (seatActivity && entry.canonicalSessionName) {
      const obs = seatActivity.getSeatActivity(entry.canonicalSessionName);
      terminalActive = obs ? obs.isActiveWithinWindow : null;
      lastActivityAt = obs ? obs.lastActivityAt : null;
    }
    // S19——来自唯一事实源的仲裁分类状态，通过单一桥预先派生显示值；消费者只渲染，
    // 绝不重新仲裁。
    let activityState: NodeInventoryEntry["activityState"] = undefined;
    // 按能力检查：不带 S19 接口的局部注入替身保持分类前结构 undefined，而不是伪造 null
    // 事实源结果。
    if (seatActivity && entry.canonicalSessionName && typeof seatActivity.getSeatStateBySession === "function") {
      const arb = seatActivity.getSeatStateBySession(entry.canonicalSessionName);
      activityState = arb
        ? {
            activity: arb.activity,
            display: deriveDisplayActivity(arb.activity, arb.needsInput),
            needsInput: arb.needsInput,
            decidedBy: arb.decidedBy,
            seq: arb.seq,
            lastSwap: arb.lastSwap,
          }
        : null;
    }
    const work = countAssignedWorkForEntry(entry, assignedByDest);
    return {
      ...entry,
      terminalActive,
      lastActivityAt,
      activityState,
      hasAssignedWork: work.assignedWorkCount > 0,
      ...work,
    };
  });
}

/**
 * QA baseline-deep-dogfood BLOCKING-A2（qitem-20260518063900-85745917）：已采用/实时会话
 * 工作组不会显示已分配队列工作，因为旧版查找只用 canonicalSessionName 匹配
 * destination_session。
 *
 * 对托管席位，canonicalSessionName 等于规范形式 `{pod}-{member}@{rig}`，由
 * deriveCanonicalSessionName 在物化时设置；队列操作者也用该形式寻址，所以单键查找有效。
 *
 * 对已采用席位，canonicalSessionName 是原始 tmux 会话名，即采用者选择的任意名称，例如
 * `my-existing-claude`。操作者通过 `zrig queue create --destination` 使用规范形式
 *（逻辑 `{pod}-{member}@{rig}`）寻址已采用席位，所以单键查找会漏掉。
 *
 * 同时按两种形式解析：
 *   1. entry.canonicalSessionName（覆盖托管席位 + 按原始名称采用的席位）
 *   2. 从 logicalId + rigName 派生的 `{pod}-{member}@{rig}`（覆盖按规范名称寻址的已采用席位）
 *
 * logicalId 是感知 pod 的 `pod.member` 形式，以点分隔。规范会话形式把点替换为连字符，
 * 以符合 deriveCanonicalSessionName 约定；例如工作组 `openrig-velocity` 中的
 * `redo.driver-2` 会变成 `redo-driver-2@openrig-velocity`。
 *
 * 对不同 destination_session 键求和，避免两种形式相同时重复计数；托管席位的
 * canonicalSessionName 已等于派生规范形式。
 */
export interface AssignedWorkCounts {
  assignedWorkCount: number;
  pendingWorkCount: number;
  inProgressWorkCount: number;
  blockedWorkCount: number;
}

export function countAssignedWorkForEntry(
  entry: NodeInventoryEntry,
  assignedByDest: Map<string, AssignedWorkCounts>,
): AssignedWorkCounts {
  const keys = new Set<string>();
  if (entry.canonicalSessionName) keys.add(entry.canonicalSessionName);
  const derived = deriveCanonicalFromEntry(entry);
  if (derived) keys.add(derived);
  const total: AssignedWorkCounts = {
    assignedWorkCount: 0,
    pendingWorkCount: 0,
    inProgressWorkCount: 0,
    blockedWorkCount: 0,
  };
  for (const key of keys) {
    const counts = assignedByDest.get(key);
    if (!counts) continue;
    total.assignedWorkCount += counts.assignedWorkCount;
    total.pendingWorkCount += counts.pendingWorkCount;
    total.inProgressWorkCount += counts.inProgressWorkCount;
    total.blockedWorkCount += counts.blockedWorkCount;
  }
  return total;
}

/** 导出函数（OPR.0.4.6.FAC1）：为清单条目派生规范坐标 `{pod}-{member}@{rig}`。binding
 * 层的唯一字符串规则（平局判定键和记录目标）精确复用此双键派生，绝不另起平行实现。 */
export function deriveCanonicalFromEntry(entry: NodeInventoryEntry): string | null {
  if (!entry.rigName || !entry.logicalId) return null;
  const dotIdx = entry.logicalId.indexOf(".");
  if (dotIdx <= 0 || dotIdx === entry.logicalId.length - 1) return null;
  const pod = entry.logicalId.slice(0, dotIdx);
  const member = entry.logicalId.slice(dotIdx + 1);
  return deriveCanonicalSessionName(pod, member, entry.rigName);
}

export function readAssignedWorkBySession(db: Database.Database): Map<string, AssignedWorkCounts> {
  const rows = db.prepare(`
    SELECT destination_session,
      COUNT(*) as assigned_count,
      SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN state = 'in-progress' THEN 1 ELSE 0 END) as in_progress_count,
      SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) as blocked_count
    FROM queue_items
    WHERE state IN ('pending', 'in-progress', 'blocked')
    GROUP BY destination_session
  `).all() as Array<{
    destination_session: string;
    assigned_count: number;
    pending_count: number;
    in_progress_count: number;
    blocked_count: number;
  }>;
  const out = new Map<string, AssignedWorkCounts>();
  for (const r of rows) {
    out.set(r.destination_session, {
      assignedWorkCount: r.assigned_count,
      pendingWorkCount: r.pending_count,
      inProgressWorkCount: r.in_progress_count,
      blockedWorkCount: r.blocked_count,
    });
  }
  return out;
}

export async function attachAgentActivity(
  entries: NodeInventoryEntry[],
  deps: {
    tmuxAdapter: TmuxAdapter;
    activityStore?: AgentActivityStore;
    /** 5b82324b——缓存的结构化窗格观察（SeatStructuralActivityService）。只读且无 capture：
     * 在默认路径把结构运动提升为 ACTIVITY 信号，使实时但无 hook/hook 过期的席位不再显示
     * `unknown`。缺失时保持 5b 之前的行为。 */
    structuralActivity?: { getStructuralActivity(sessionName: string): StructuralObservation | null };
    /** ACTIVITY D1+D2——缓存的运动观察（SeatActivityService，以 1Hz 读取 tmux
     * `#{window_activity}`）。与 `structuralActivity` 一样只读且无 capture。
     *
     * 此信号已按席位计算并渲染在独立 `TERMINAL` 列和 UI 自身的活动折叠中；从 slice 15
     * 起，activity-visuals.ts 在 `terminalActive === true` 时返回
     * `{state: "running", source: "terminal_activity"}`。ACTIVITY 是唯一从未读取它的
     * 消费者，因此 Web UI 可能显示席位在工作，而 `zrig ps` 却把同一席位标为 `unknown`。
     * 缺失时保持修复前行为。 */
    seatActivity?: { getSeatActivity(sessionName: string): SeatActivity | null };
    now?: Date;
    // OPR.0.4.3 healthz-wedge 放大修复：默认走低成本路径。逐节点 tmux
    // `capturePaneContent` 回退（probeSessionActivity）会在 CLI `zrig ps --nodes` 扇出和
    // graph/nodes 轮询下放大为舰队级进程风暴。它只用于无 hook 席位（getLatestForNode 返回
    // null），且只为这些席位增加基于窗格启发式的 `needs_input`。SeatActivityService 快照
    //（terminalActive）已以更高 UI 优先级提供 running/idle，getLatestForNode 则提供 hook 活动
    //（包括 hook-needs_input）。因此低成本默认值跳过 capture，发出诚实的
    // `unknown/no_runtime_hook` 占位；running/idle 在渲染时来自快照。设置
    // `captureFallback: true`（通过 ?full=/?refresh=）才启用逐节点 tmux capture；
    // needs-input 界面（useNeedsInputSeats、节点详情）会显式请求。
    captureFallback?: boolean;
    captureObserver?: Pick<CaptureObserver, "record">;
    observationBinding?: (entry: NodeInventoryEntry) => Omit<ObservedBinding, "sessionName">;
  },
): Promise<NodeInventoryEntry[]> {
  const sampledAt = deps.now ?? new Date();
  const captureFallback = deps.captureFallback ?? false;
  return Promise.all(entries.map(async (entry) => {
    // ACTIVITY D1+D2——运动读取只解析一次，并应用到下方每个出口。
    const motion = entry.canonicalSessionName
      ? deps.seatActivity?.getSeatActivity(entry.canonicalSessionName) ?? null
      : null;

    /**
     * 新鲜度在此读取时决定：用原始 `lastActivityAt` 对照请求时钟，绝不能只依赖缓存的
     * `isActiveWithinWindow` 布尔值。
     *
     * 原因（dev50-guard 对 29ad1b2b9 的 HOLD）：`SeatActivityService.pollSeat` 在 tmux 错误时
     * 会先返回 null，而不会替换或删除缓存记录；`pollAllRunningTmuxSeats` 只清除数据库中不再
     * 运行的席位。因此，数据库仍标为 running 但 tmux 读取持续失败的席位会永久保留最后观察，
     * 包括 `true`。信任该布尔值会把不可用观察变成肯定的存活声明：检测工具失效后，ACTIVITY
     * 仍会无限期报告 `running`。
     *
     * 这会从未防护方向破坏该阶梯自身的不伪造规则。下方三个门禁会阻止 motion 根据沉默伪造
     * `idle`，却都不能阻止失效缓存伪造 `running`。安静的席位与已无法观察的席位是不同状态，
     * 只有原始时间戳能区分。
     *
     * 当事实无法计算年龄（缺失或无法解析）时失败关闭：无法计算年龄的肯定值与长期失效值无法
     * 区分，因此不能成为存活声明。
     *
     * 阈值使用席位自身的 `silenceWindowSeconds`，与服务轮询时相同；此处不创造第二个阈值。
     * 年龄为负（原始事实略早于请求时钟）时仍判为存活，保留 pollSeat 有意提供的时钟偏差容忍。
     */
    const motionRunning = (() => {
      if (motion?.isActiveWithinWindow !== true) return false;
      const rawMs = motion.lastActivityAt ? Date.parse(motion.lastActivityAt) : Number.NaN;
      if (!Number.isFinite(rawMs)) return false;
      const ageSeconds = (sampledAt.getTime() - rawMs) / 1000;
      return ageSeconds < motion.silenceWindowSeconds;
    })();

    /**
     * ACTIVITY D1+D2——一条优先级规则，应用于阶梯每个出口：
     *
     *     needs_input > running > MOTION > idle / unknown
     *
     * 实时运动会把 `idle` 或 `unknown` 判决提升，但绝不改动 `needs_input` 或已有 `running`
     * 判决，也绝不伪造 `idle`。这种不对称性就是完整安全论据，也是缺陷两部分各自所需的规则：
     *
     *   D1（Codex → unknown）是覆盖问题。Codex 席位没有 hook，结构匹配器又按 Claude 形态
     *     检查固定 8 行尾部窗口，因此较高的 Codex 页脚会把真实工作行挤出视野，使席位降为
     *     `unknown`。Motion 是窗格字节事实，能覆盖所有运行时，无需为每个 provider 写匹配器。
     *   D2（Claude → idle）是优先级问题。停止后恢复的席位仍可能把过期肯定 `idle` hook 作为
     *     最新记录；旧版提前返回会在查询其他来源前把它视为权威。即使后续有完美 motion 源也会
     *     输给它。因此 motion 必须高于肯定 idle hook，而不只是高于缺失 hook。
     *
     * `needs_input` 优先于 motion 的原因：motion 无法区分“工作中”和“在提示处等待”，每秒重绘
     * 都会让窗口保持新鲜。若 motion 高于 needs_input 文本判决，请求权限的席位会被改标为
     * `running`，暂存监视器反而会跳过真正受阻的席位。
     *
     * motion 永不产生 `idle` 的原因：安静窗口不能证明智能体空闲，席位可能长时间思考而不输出。
     * 从沉默派生 `idle` 只是通过重标默认值来满足“非 unknown”，会腐蚀封闭联合类型而非改善
     * 信号。因此沉默时保持原判决不变。
     */
    const withMotion = (activity: AgentActivity): AgentActivity => {
      if (!motionRunning) return activity;
      if (activity.state !== "idle" && activity.state !== "unknown") return activity;
      return {
        state: "running",
        reason: "window_activity_motion",
        evidenceSource: "terminal_activity",
        sampledAt: motion!.lastObservedAt,
        // 得出该判决的原始 `#{window_activity}` 时间戳；读取者可用自己的时钟计算年龄，
        // 直接判断为何此席位显示为 running。
        evidence: motion!.lastActivityAt ?? null,
        runtime: entry.runtime ?? null,
      };
    };

    const hookActivity = deps.activityStore?.getLatestForNode({
      sessionName: entry.canonicalSessionName,
      now: sampledAt,
    });
    // 新鲜肯定 hook（running/needs_input/idle）具有权威性，但肯定 `idle` hook 现在让位于实时
    // motion（D2）；running/needs_input hook 不变。
    if (hookActivity && hookActivity.state !== "unknown") {
      return {
        ...entry,
        agentActivity: withMotion(hookActivity),
      };
    }

    // Hook 缺失或 unknown/stale 时查询缓存的结构观察。该读取无需 capture：窗格捕获已在后台
    // SeatStructuralActivityService tick 中完成，绝不在此执行，从而维持 healthz-wedge 不逐请求
    // capture 的不变量。结构 motion 判决是存活信号，会覆盖缺失/过期 hook（约束 2：存活性高于
    // hook 到达年龄），使无 hook、Codex 或刚结束轮次的席位在默认路径拥有真实 ACTIVITY；这正是
    // 本修复针对的舰队盲区。结构判别依据 spinner 形态、Esc 中断提示、空闲提示等结构，绝不用
    // 动词白名单。
    const structural = entry.canonicalSessionName
      ? deps.structuralActivity?.getStructuralActivity(entry.canonicalSessionName)
      : null;
    if (structural && structural.state !== "unknown") {
      return {
        ...entry,
        agentActivity: withMotion({
          state: mapPaneState(structural.state),
          reason: structural.reason,
          evidenceSource: "pane_heuristic",
          sampledAt: structural.observedAt,
          evidence: structural.evidence,
        }),
      };
    }

    // 没有肯定 hook，也没有结构判决。若存在 stale/unknown hook，则原样诚实返回，绝不只凭
    // 到达年龄把它提升为空闲席位判决。实时 motion 会提升它；在本舰队这是常见情况而非例外：
    // 每个席位的 hook 当前都会到达，随后因无法解析占用者 generation 而降为 unknown。因此，
    // 阻隔工作中席位与真实标签的是被降级的 hook，而非肯定 idle hook。
    if (hookActivity) {
      return {
        ...entry,
        agentActivity: withMotion(hookActivity),
      };
    }

    if (!captureFallback) {
      // 低成本默认值——不执行逐节点 tmux capture。无 hook 席位基于窗格启发式的 needs_input
      // 仍需 ?full/?refresh；running 现在来自上方无 capture 的 motion 读取，因此只有真正沉默
      // 的席位才会到达诚实的 `unknown` 占位。
      return {
        ...entry,
        agentActivity: withMotion({
          state: "unknown",
          reason: "no_runtime_hook",
          evidenceSource: "session_registry",
          sampledAt: sampledAt.toISOString(),
          evidence: null,
          fallback: true,
        }),
      };
    }

    return {
      ...entry,
      agentActivity: withMotion(await probeSessionActivity({
      sessionName: entry.canonicalSessionName,
      runtime: entry.runtime,
      attachmentType: entry.attachmentType,
      tmuxAdapter: deps.tmuxAdapter,
      now: sampledAt,
      captureObserver: deps.captureObserver,
      binding: deps.captureObserver ? deps.observationBinding?.(entry) : undefined,
    })),
    };
  }));
}
