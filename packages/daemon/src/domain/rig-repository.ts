import type Database from "better-sqlite3";
import { resolveActiveOccupantRow } from "./active-occupant.js";
import { resolve } from "node:path";
import { ulid } from "ulid";
import { deriveComposeProjectName } from "./compose-project-name.js";
import type { ClaudeManagedBlockFile } from "./managed-blocks.js";
import type {
  Rig,
  Node,
  Edge,
  Binding,
  NodeWithBinding,
  RigWithRelations,
  RigServicesRecord,
  RigServicesRecordInput,
  Snapshot,
  SnapshotData,
  SessionSourceSpec,
} from "./types.js";

/**
 * 独立辅助函数：返回工作组的最新快照，其中至少一个持久会话携带非 null 的
 * `resume_token`；否则返回 null。
 *
 * node-inventory 与 ps-projection 在 L1 冷启动后用它派生
 * `lifecycleState=recoverable`。它不同于按 kind 过滤的 `findLatestAutoPreDown`。
 */
interface SnapshotRow { id: string; rig_id: string; kind: string; status: string; data: string; created_at: string }

/** 共享的行 → 可用 Snapshot 映射（解析与“至少一个 resume token”可用性规则的单一事实来源）。
 * 单工作组读取与 FS-1 W1.2 全工作组批量读取都使用它，使两者语义逐字节一致。 */
function snapshotFromRowIfUsable(row: SnapshotRow): Snapshot | null {
  let data: SnapshotData;
  try {
    data = JSON.parse(row.data) as SnapshotData;
  } catch {
    return null;
  }

  // OPR.0.5.7.1——可用性取决于占用者事实，而非任意历史行：当且仅当至少一个节点解析为
  // 携带 token 的活跃占用者时，快照才可用（执行流程消费同一套四级判定）。存在但为 null、
  // key 缺失或悬空关系均不计入；非占用者历史行上的 token 绝不能被读作可恢复。
  const sessions = data.sessions ?? [];
  const nodeIds = [...new Set(sessions.map((s) => s.nodeId))];
  const hasResolvedOccupantToken = nodeIds.some((nodeId) => {
    const resolution = resolveActiveOccupantRow(sessions, data.activeSessionIdByNode, nodeId);
    return resolution.kind === "resolved"
      && typeof resolution.session.resumeToken === "string"
      && resolution.session.resumeToken.length > 0;
  });
  if (!hasResolvedOccupantToken) return null;

  return {
    id: row.id,
    rigId: row.rig_id,
    kind: row.kind,
    status: row.status,
    data,
    createdAt: row.created_at,
  };
}

export function findLatestUsableSnapshot(db: Database.Database, rigId: string): Snapshot | null {
  const row = db.prepare(
    "SELECT * FROM snapshots WHERE rig_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
  ).get(rigId) as SnapshotRow | undefined;
  if (!row) return null;
  return snapshotFromRowIfUsable(row);
}

/**
 * FS-1 W1.2——`findLatestUsableSnapshot` 的全工作组批量形式：一次查询取得每个工作组
 * 的最新快照（同样按 `created_at DESC, id DESC` 排序），再逐条通过共享的
 * `snapshotFromRowIfUsable` 映射。没有可用快照的工作组不出现在 map 中
 *（调用方默认使用 null）。使用 arch-D1.1 同级审计候选索引 `snapshots(rig_id, created_at)`。
 */
export function findLatestUsableSnapshotsForAllRigs(db: Database.Database): Map<string, Snapshot> {
  const rows = db.prepare(`
    SELECT s.* FROM snapshots s
    WHERE s.id = (
      SELECT s2.id FROM snapshots s2 WHERE s2.rig_id = s.rig_id
      ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1
    )
  `).all() as SnapshotRow[];
  const out = new Map<string, Snapshot>();
  for (const row of rows) {
    const snap = snapshotFromRowIfUsable(row);
    if (snap) out.set(row.rig_id, snap);
  }
  return out;
}

/**
 * OPR.0.3.3.19——工作组归档读取过滤器。后台服务默认读取排除已归档工作组，
 * 显式模式可选择纳入；对应 stream-items 的 `--include-archived` 先例（stream-store.list）。
 */
export interface RigArchiveFilter {
  /** 同时包含活跃和已归档工作组。 */
  includeArchived?: boolean;
  /** 只返回已归档工作组。 */
  archivedOnly?: boolean;
}

/**
 * 针对某列的归档过滤 SQL 条件片段（例如 "archived_at" 或别名 "r.archived_at"）。
 * 不应用过滤时返回 null（includeArchived 表示包含全部）；默认排除已归档项。
 */
export function archiveWhereClause(col: string, filter?: RigArchiveFilter): string | null {
  if (filter?.archivedOnly) return `${col} IS NOT NULL`;
  if (filter?.includeArchived) return null;
  return `${col} IS NULL`;
}

interface NodeOptions {
  role?: string;
  runtime?: string;
  model?: string;
  codexConfigProfile?: string;
  /** OPR.0.4.8.3 接缝 B：逐席位 permission_policy 引用（builtin:<name> 或 spec 相对路径）。 */
  permissionPolicy?: string;
  cwd?: string;
  surfaceHint?: string;
  workspace?: string;
  restorePolicy?: string;
  packageRefs?: string[];
  podId?: string;
  agentRef?: string;
  profile?: string;
  label?: string;
  sessionSource?: SessionSourceSpec;
  resolvedSpecName?: string;
  resolvedSpecVersion?: string;
  resolvedSpecHash?: string;
}

export class RigRepository {
  readonly db: Database.Database;
  /** OPR.0.5.6.24——创建即启用（advisor 裁定的出生属性原则）：保护机制与工作组在同一操作中创建。
   * 在启动时接线；保持可选，使仓库构造不依赖它。 */
  onRigCreated?: (rig: Rig) => void;
  constructor(db: Database.Database) {
    this.db = db;
  }

  createRig(name: string): Rig {
    const id = ulid();
    this.db
      .prepare("INSERT INTO rigs (id, name) VALUES (?, ?)")
      .run(id, name);

    const rig = this.rowToRig(
      this.db.prepare("SELECT * FROM rigs WHERE id = ?").get(id) as RigRow
    );
    this.onRigCreated?.(rig);
    return rig;
  }

  /**
   * PL-007 Workspace Primitive——把类型化 workspace 块持久化到 rigs 行，以 JSON 存储在
   * `workspace_json`（迁移 038）。传入 null 可清除。绕过规范迁移列表的旧测试 fixture
   * 没有此列；这种情况下 setter 不执行操作（调用方契约为“尽力持久化”）。Whoami / node-inventory
   * 读取此列，在 cwd 旁呈现工作组 workspace 块。
   */
  setRigWorkspace(rigId: string, workspace: import("./types.js").WorkspaceSpec | null): void {
    if (!this.hasRigColumn("workspace_json")) return;
    const json = workspace ? JSON.stringify(workspace) : null;
    this.db.prepare("UPDATE rigs SET workspace_json = ?, updated_at = ? WHERE id = ?")
      .run(json, new Date().toISOString(), rigId);
  }

  /** PL-007——读取工作组已持久化的 workspace 块。 */
  getRigWorkspace(rigId: string): import("./types.js").WorkspaceSpec | null {
    if (!this.hasRigColumn("workspace_json")) return null;
    const row = this.db.prepare("SELECT workspace_json FROM rigs WHERE id = ?")
      .get(rigId) as { workspace_json: string | null } | undefined;
    if (!row || !row.workspace_json) return null;
    try {
      return JSON.parse(row.workspace_json) as import("./types.js").WorkspaceSpec;
    } catch {
      return null;
    }
  }

  /** OPR.0.4.8.3 接缝 B——持久化工作组附加的 permission_policy 引用（builtin:<name> 或
   * spec 相对自定义路径）；传入 null 清除。对应 setRigWorkspace（迁移 056）。 */
  setRigPermissionPolicy(rigId: string, permissionPolicy: string | null): void {
    if (!this.hasRigColumn("permission_policy")) return;
    this.db.prepare("UPDATE rigs SET permission_policy = ?, updated_at = ? WHERE id = ?")
      .run(permissionPolicy ?? null, new Date().toISOString(), rigId);
  }

  /** OPR.0.4.8.3 接缝 B——读取持久化的工作组级 permission_policy 引用；无值时为 null。 */
  getRigPermissionPolicy(rigId: string): string | null {
    if (!this.hasRigColumn("permission_policy")) return null;
    const row = this.db.prepare("SELECT permission_policy FROM rigs WHERE id = ?")
      .get(rigId) as { permission_policy: string | null } | undefined;
    return row?.permission_policy ?? null;
  }

  /** #25——持久化工作组选定的 Claude 托管块文件（迁移 085）；使用默认 CLAUDE.md 时为 null。
   * 对应 setRigPermissionPolicy。 */
  setRigClaudeManagedBlockFile(rigId: string, file: ClaudeManagedBlockFile | null): void {
    if (!this.hasRigColumn("claude_managed_block_file")) return;
    this.db.prepare("UPDATE rigs SET claude_managed_block_file = ?, updated_at = ? WHERE id = ?")
      .run(file ?? null, new Date().toISOString(), rigId);
  }

  /** #25——工作组选定的 Claude 托管块文件；使用默认值时为 null。 */
  getRigClaudeManagedBlockFile(rigId: string): ClaudeManagedBlockFile | null {
    if (!this.hasRigColumn("claude_managed_block_file")) return null;
    const row = this.db.prepare("SELECT claude_managed_block_file FROM rigs WHERE id = ?")
      .get(rigId) as { claude_managed_block_file: ClaudeManagedBlockFile | null } | undefined;
    return row?.claude_managed_block_file ?? null;
  }

  /** 接缝 B Guard-F1——持久化工作组级已解析附件来源（迁移 058）。declaringDir 是原始声明
   * RigSpec 目录；消费方绝不能依据无关操作根目录重新解析原始相对引用。
   * 对 058 之前的 fixture 数据库不执行操作。 */
  setRigPolicyProvenance(
    rigId: string,
    provenance: {
      origin: "builtin" | "custom" | "deliberate_none";
      resolvedTarget: string | null;
      declaringDir: string | null;
      launchPosture: "floor" | "full_bypass";
    },
  ): void {
    if (!this.hasRigColumn("rig_policy_launch_posture")) return;
    this.db.prepare(
      "UPDATE rigs SET rig_policy_origin = ?, rig_policy_resolved_target = ?, rig_policy_declaring_dir = ?, rig_policy_launch_posture = ?, updated_at = ? WHERE id = ?",
    ).run(provenance.origin, provenance.resolvedTarget, provenance.declaringDir, provenance.launchPosture, new Date().toISOString(), rigId);
  }

  /** 接缝 B Guard-F1——读取工作组级已解析附件来源；没有时为 null。 */
  getRigPolicyProvenance(rigId: string): {
    origin: "builtin" | "custom" | "deliberate_none";
    resolvedTarget: string | null;
    declaringDir: string | null;
    launchPosture: "floor" | "full_bypass";
    /** 同时返回原始工作组引用（056），用于重新校验。 */
    rigRef: string | null;
  } | null {
    if (!this.hasRigColumn("rig_policy_launch_posture")) return null;
    const row = this.db.prepare(
      "SELECT permission_policy, rig_policy_origin, rig_policy_resolved_target, rig_policy_declaring_dir, rig_policy_launch_posture FROM rigs WHERE id = ?",
    ).get(rigId) as {
      permission_policy: string | null;
      rig_policy_origin: string | null;
      rig_policy_resolved_target: string | null;
      rig_policy_declaring_dir: string | null;
      rig_policy_launch_posture: string | null;
    } | undefined;
    if (!row || row.rig_policy_origin == null || row.rig_policy_launch_posture == null) return null;
    return {
      origin: row.rig_policy_origin as "builtin" | "custom" | "deliberate_none",
      resolvedTarget: row.rig_policy_resolved_target,
      declaringDir: row.rig_policy_declaring_dir,
      launchPosture: row.rig_policy_launch_posture as "floor" | "full_bypass",
      rigRef: row.permission_policy,
    };
  }

  /** OPR.0.4.8.3 接缝 B（R2，dev-guard 裁定）——持久化节点已解析的策略附件来源；
   * 重启后稳定，包含 origin、resolved target、declaring dir 与 launch posture。
   * 在打包支线确定规范路径前（PM lane c76c7153），builtin 携带 resolvedTarget=null，
   * 绝不回显 `builtin:<name>`。对 057 之前的 fixture 数据库不执行操作。 */
  setNodePolicyProvenance(
    nodeId: string,
    provenance: {
      origin: "builtin" | "custom" | "deliberate_none";
      resolvedTarget: string | null;
      declaringDir: string | null;
      launchPosture: "floor" | "full_bypass";
    },
  ): void {
    if (!this.hasNodeColumn("policy_launch_posture")) return;
    this.db.prepare(
      "UPDATE nodes SET policy_origin = ?, policy_resolved_target = ?, policy_declaring_dir = ?, policy_launch_posture = ? WHERE id = ?",
    ).run(provenance.origin, provenance.resolvedTarget, provenance.declaringDir, provenance.launchPosture, nodeId);
  }

  /** 接缝 B（R2）——读取节点已持久化的策略来源；未附加或数据库早于 057 时为 null。
   * 恢复消费方无需 spec 即可从中重新派生 posture。 */
  getNodePolicyProvenance(nodeId: string): {
    origin: "builtin" | "custom" | "deliberate_none";
    resolvedTarget: string | null;
    declaringDir: string | null;
    launchPosture: "floor" | "full_bypass";
    /** 节点自身的原始引用（成员级；附件来自工作组时为 null）。 */
    nodeRef: string | null;
  } | null {
    if (!this.hasNodeColumn("policy_launch_posture")) return null;
    const row = this.db.prepare(
      "SELECT permission_policy, policy_origin, policy_resolved_target, policy_declaring_dir, policy_launch_posture FROM nodes WHERE id = ?",
    ).get(nodeId) as {
      permission_policy: string | null;
      policy_origin: string | null;
      policy_resolved_target: string | null;
      policy_declaring_dir: string | null;
      policy_launch_posture: string | null;
    } | undefined;
    if (!row || row.policy_origin == null || row.policy_launch_posture == null) return null;
    return {
      origin: row.policy_origin as "builtin" | "custom" | "deliberate_none",
      resolvedTarget: row.policy_resolved_target,
      declaringDir: row.policy_declaring_dir,
      launchPosture: row.policy_launch_posture as "floor" | "full_bypass",
      nodeRef: row.permission_policy,
    };
  }

  /** PL-007——对 rigs 执行防御性列探测；旧测试 fixture 缺少迁移 038 的 workspace_json。 */
  private hasRigColumn(columnName: string): boolean {
    try {
      return this.db.prepare("PRAGMA table_info(rigs)").all()
        .some((row) => (row as { name?: string }).name === columnName);
    } catch {
      return false;
    }
  }

  addNode(rigId: string, logicalId: string, opts?: NodeOptions): Node {
    // podId 的同工作组守卫
    if (opts?.podId) {
      const pod = this.db.prepare("SELECT rig_id FROM pods WHERE id = ?").get(opts.podId) as { rig_id: string } | undefined;
      if (!pod) throw new Error(`未找到 Pod：${opts.podId}`);
      if (pod.rig_id !== rigId) throw new Error("Pod 属于另一个工作组");
    }

    const id = ulid();
    if (this.hasNodeColumn("codex_config_profile") && this.hasNodeColumn("permission_policy")) {
      // OPR.0.4.8.3 接缝 B：两个由 ALTER 添加的可选列均存在（迁移 022 + 055；055 在 022 后运行，
      // 因此存在 permission_policy 列就意味着存在 codex_config_profile 列）。
      this.db
        .prepare(
          `INSERT INTO nodes (id, rig_id, logical_id, role, runtime, model, codex_config_profile, permission_policy, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          rigId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.codexConfigProfile ?? null,
          opts?.permissionPolicy ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    } else if (this.hasNodeColumn("codex_config_profile")) {
      this.db
        .prepare(
          `INSERT INTO nodes (id, rig_id, logical_id, role, runtime, model, codex_config_profile, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          rigId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.codexConfigProfile ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO nodes (id, rig_id, logical_id, role, runtime, model, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          rigId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    }

    if (opts?.sessionSource && this.hasNodeColumn("session_source_json")) {
      this.db.prepare("UPDATE nodes SET session_source_json = ? WHERE id = ?")
        .run(JSON.stringify(opts.sessionSource), id);
    }

    return this.rowToNode(
      this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow
    );
  }

  /** S5（OPR.0.5.4.7）——首个受支持的 nodes.model 写入（此前清单只能插入；KI-5.3-9）。
   * 每次托管 resume/继任启动都在调用时读取 node.model，因此此 UPDATE 完成 set-model 的
   * 持久化部分。返回是否有行发生变化。 */
  setNodeModel(nodeId: string, model: string): boolean {
    const result = this.db
      .prepare("UPDATE nodes SET model = ? WHERE id = ?")
      .run(model, nodeId);
    return result.changes > 0;
  }

  addEdge(rigId: string, sourceId: string, targetId: string, kind: string): Edge {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, rigId, sourceId, targetId, kind);

    return this.rowToEdge(
      this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow
    );
  }

  getRig(rigId: string): RigWithRelations | null {
    const rigRow = this.db
      .prepare("SELECT * FROM rigs WHERE id = ?")
      .get(rigId) as RigRow | undefined;

    if (!rigRow) return null;

    const nodeRows = this.db
      .prepare("SELECT * FROM nodes WHERE rig_id = ? ORDER BY created_at")
      .all(rigId) as NodeRow[];

    const edgeRows = this.db
      .prepare("SELECT * FROM edges WHERE rig_id = ?")
      .all(rigId) as EdgeRow[];

    const nodes: NodeWithBinding[] = nodeRows.map((row) => {
      const bindingRow = this.db
        .prepare("SELECT * FROM bindings WHERE node_id = ?")
        .get(row.id) as BindingRow | undefined;

      return {
        ...this.rowToNode(row),
        binding: bindingRow ? this.rowToBinding(bindingRow) : null,
      };
    });

    return {
      rig: this.rowToRig(rigRow),
      nodes,
      edges: edgeRows.map((r) => this.rowToEdge(r)),
    };
  }

  listRigs(filter?: RigArchiveFilter): Rig[] {
    const cond = archiveWhereClause("archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM rigs ${where} ORDER BY created_at`)
      .all() as RigRow[];
    return rows.map((r) => this.rowToRig(r));
  }

  /**
   * 返回此工作组至少包含一个非 null resume token 的最新快照；无可用快照时返回 null。
   * 生命周期投影用它派生 `recoverable` 状态。
   */
  findLatestUsableSnapshot(rigId: string): Snapshot | null {
    return findLatestUsableSnapshot(this.db, rigId);
  }

  findRigsByName(name: string): Rig[] {
    const rows = this.db
      .prepare("SELECT * FROM rigs WHERE name = ? ORDER BY created_at")
      .all(name) as RigRow[];
    return rows.map((r) => this.rowToRig(r));
  }

  getRigSummaries(filter?: RigArchiveFilter): Array<{ id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null; hasServices: boolean; archivedAt: string | null }> {
    const cond = archiveWhereClause("r.archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    const rows = this.db.prepare(`
      SELECT
        r.id,
        r.name,
        r.archived_at AS archived_at,
        (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id) AS node_count,
        EXISTS(SELECT 1 FROM rig_services rs WHERE rs.rig_id = r.id) AS has_services,
        ls.id AS latest_snapshot_id,
        ls.created_at AS latest_snapshot_at
      FROM rigs r
      LEFT JOIN snapshots ls ON ls.id = (
        SELECT s2.id FROM snapshots s2
        WHERE s2.rig_id = r.id
        ORDER BY s2.created_at DESC, s2.id DESC
        LIMIT 1
      )
      ${where}
      ORDER BY r.created_at
    `).all() as Array<{ id: string; name: string; archived_at: string | null; node_count: number; has_services: number; latest_snapshot_id: string | null; latest_snapshot_at: string | null }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nodeCount: r.node_count,
      hasServices: r.has_services === 1,
      latestSnapshotAt: r.latest_snapshot_at,
      latestSnapshotId: r.latest_snapshot_id,
      archivedAt: r.archived_at,
    }));
  }

  /**
   * OPR.0.3.3.19——软归档工作组：设置 `archived_at`。保留 rigs 行、拓扑行和快照；
   * 这不是删除路径，与 deleteRig 对比。工作组已归档时返回 false。
   */
  archiveRig(rigId: string): boolean {
    const result = this.db
      .prepare("UPDATE rigs SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL")
      .run(rigId);
    return result.changes > 0;
  }

  /** OPR.0.3.3.19——撤销归档：清除 `archived_at`。未归档时返回 false。 */
  unarchiveRig(rigId: string): boolean {
    const result = this.db
      .prepare("UPDATE rigs SET archived_at = NULL, updated_at = datetime('now') WHERE id = ? AND archived_at IS NOT NULL")
      .run(rigId);
    return result.changes > 0;
  }

  deleteRig(rigId: string): void {
    this.db.prepare("DELETE FROM rigs WHERE id = ?").run(rigId);
  }

  deleteNode(nodeId: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
  }

  setServicesRecord(rigId: string, record: RigServicesRecordInput): RigServicesRecord {
    const now = new Date().toISOString();
    const composeFile = resolve(record.rigRoot, record.composeFile);
    const rig = this.db.prepare("SELECT name FROM rigs WHERE id = ?").get(rigId) as { name: string } | undefined;
    if (!rig) throw new Error(`未找到工作组：${rigId}`);
    const projectName = record.projectName ?? deriveComposeProjectName(rig.name);
    this.db.prepare(`
      INSERT INTO rig_services (
        rig_id,
        kind,
        spec_json,
        rig_root,
        compose_file,
        project_name,
        latest_receipt_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rig_id) DO UPDATE SET
        kind = excluded.kind,
        spec_json = excluded.spec_json,
        rig_root = excluded.rig_root,
        compose_file = excluded.compose_file,
        project_name = excluded.project_name,
        latest_receipt_json = excluded.latest_receipt_json,
        updated_at = excluded.updated_at
    `).run(
      rigId,
      record.kind,
      record.specJson,
      record.rigRoot,
      composeFile,
      projectName,
      record.latestReceiptJson ?? null,
      now,
      now,
    );

    const stored = this.db.prepare("SELECT * FROM rig_services WHERE rig_id = ?").get(rigId) as RigServicesRow | undefined;
    if (!stored) throw new Error(`无法持久化工作组 ${rigId} 的服务记录`);
    return this.rowToServicesRecord(stored);
  }

  getServicesRecord(rigId: string): RigServicesRecord | null {
    const row = this.db.prepare("SELECT * FROM rig_services WHERE rig_id = ?").get(rigId) as RigServicesRow | undefined;
    return row ? this.rowToServicesRecord(row) : null;
  }

  updateServicesReceipt(rigId: string, latestReceiptJson: string | null): RigServicesRecord | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE rig_services
      SET latest_receipt_json = ?, updated_at = ?
      WHERE rig_id = ?
    `).run(latestReceiptJson, now, rigId);

    if (result.changes === 0) return null;
    return this.getServicesRecord(rigId);
  }

  // -- 数据库行到 domain 对象的映射 --

  private rowToRig(row: RigRow): Rig {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToNode(row: NodeRow): Node {
    return {
      id: row.id,
      rigId: row.rig_id,
      logicalId: row.logical_id,
      role: row.role,
      runtime: row.runtime,
      model: row.model,
      codexConfigProfile: row.codex_config_profile ?? null,
      permissionPolicy: row.permission_policy ?? null,
      cwd: row.cwd,
      surfaceHint: row.surface_hint ?? null,
      workspace: row.workspace ?? null,
      restorePolicy: row.restore_policy ?? null,
      packageRefs: row.package_refs ? JSON.parse(row.package_refs) as string[] : [],
      podId: row.pod_id ?? null,
      agentRef: row.agent_ref ?? null,
      profile: row.profile ?? null,
      label: row.label ?? null,
      sessionSource: row.session_source_json
        ? JSON.parse(row.session_source_json) as SessionSourceSpec
        : null,
      resolvedSpecName: row.resolved_spec_name ?? null,
      resolvedSpecVersion: row.resolved_spec_version ?? null,
      resolvedSpecHash: row.resolved_spec_hash ?? null,
      occupantLifecycle: row.occupant_lifecycle as Node["occupantLifecycle"] ?? null,
      continuityOutcome: row.continuity_outcome as Node["continuityOutcome"] ?? null,
      handoverResult: row.handover_result as Node["handoverResult"] ?? null,
      previousOccupant: row.previous_occupant ?? null,
      handoverAt: row.handover_at ?? null,
      createdAt: row.created_at,
    };
  }

  private rowToEdge(row: EdgeRow): Edge {
    return {
      id: row.id,
      rigId: row.rig_id,
      sourceId: row.source_id,
      targetId: row.target_id,
      kind: row.kind,
      createdAt: row.created_at,
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

  private rowToServicesRecord(row: RigServicesRow): RigServicesRecord {
    return {
      rigId: row.rig_id,
      kind: row.kind as "compose",
      specJson: row.spec_json,
      rigRoot: row.rig_root,
      composeFile: row.compose_file,
      projectName: row.project_name,
      latestReceiptJson: row.latest_receipt_json ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private hasNodeColumn(columnName: string): boolean {
    return this.db.prepare("PRAGMA table_info(nodes)").all()
      .some((row) => (row as { name?: string }).name === columnName);
  }
}

// -- 原始数据库行类型（snake_case） --

interface RigRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  id: string;
  rig_id: string;
  logical_id: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  codex_config_profile?: string | null;
  permission_policy?: string | null;
  cwd: string | null;
  surface_hint: string | null;
  workspace: string | null;
  restore_policy: string | null;
  package_refs: string | null;
  pod_id: string | null;
  agent_ref: string | null;
  profile: string | null;
  label: string | null;
  session_source_json?: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
  resolved_spec_hash: string | null;
  occupant_lifecycle: string | null;
  continuity_outcome: string | null;
  handover_result: string | null;
  previous_occupant: string | null;
  handover_at: string | null;
  created_at: string;
}

interface EdgeRow {
  id: string;
  rig_id: string;
  source_id: string;
  target_id: string;
  kind: string;
  created_at: string;
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

interface RigServicesRow {
  rig_id: string;
  kind: string;
  spec_json: string;
  rig_root: string;
  compose_file: string;
  project_name: string;
  latest_receipt_json: string | null;
  created_at: string;
  updated_at: string;
}
