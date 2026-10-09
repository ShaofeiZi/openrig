import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { RestoreSnapshotSelection, RestoreSnapshotSummary, Snapshot, SnapshotData } from "./types.js";

export type RestoreSnapshotSelectionOutcome =
  | { ok: true; snapshot: Snapshot; selection: RestoreSnapshotSelection }
  | { ok: false; code: "snapshot_not_found" | "snapshot_wrong_rig" | "snapshot_unusable" | "no_usable_snapshot"; message: string };

interface ListOptions {
  kind?: string;
  limit?: number;
}

export class SnapshotRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  createSnapshot(rigId: string, kind: string, data: SnapshotData): Snapshot {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)"
      )
      .run(id, rigId, kind, JSON.stringify(data));

    return this.rowToSnapshot(
      this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as SnapshotRow
    );
  }

  getSnapshot(id: string): Snapshot | null {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE id = ?")
      .get(id) as SnapshotRow | undefined;
    return row ? this.rowToSnapshot(row) : null;
  }

  findLatestAutoPreDown(rigId: string): Snapshot | null {
    const row = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE rig_id = ? AND kind = 'auto-pre-down' ORDER BY created_at DESC LIMIT 1"
      )
      .get(rigId) as SnapshotRow | undefined;
    return row ? this.rowToSnapshot(row) : null;
  }

  /**
   * 返回最新快照，其持久化 `data` 必须包含 `RestoreOrchestrator.restore` 预校验要求的
   * 最小结构 metadata。
   *
   * OPR.0.3.4.9 方案 Y：优先选择崩溃保险层 {auto-pre-down, auto-periodic} 中最新的一项。
   * 较新的 auto-periodic 胜过陈旧 auto-pre-down（崩溃修复）；真正更新的 auto-pre-down
   * 仍然胜出（保留优雅周期）。manual、pre_restore 和 auto-rehydrate 继续位于该层之下。
   *
   * SQL 按 `(kind IN ('auto-pre-down','auto-periodic')) DESC, created_at DESC, id DESC` 排序。
   * 内存循环逐个校验候选，跳过 JSON 损坏或拓扑 metadata 缺失的快照，返回第一条可用记录；
   * 没有可用快照时返回 null。
   *
   * 与 `findLatestUsableSnapshot`（rig-repository.ts，L2）不同：后者要求至少一个已持久化 resume
   * token，供生命周期投影消费。本辅助函数只要求 `RestoreOrchestrator.restore` 实际检查的结构
   * metadata，因此只有 terminal 或没有 resume token 的工作组仍可解析。
   */
  findLatestRestoreUsable(rigId: string): Snapshot | null {
    const rows = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE rig_id = ? ORDER BY (kind IN ('auto-pre-down', 'auto-periodic')) DESC, created_at DESC, id DESC"
      )
      .all(rigId) as SnapshotRow[];

    for (const row of rows) {
      let data: SnapshotData;
      try {
        data = JSON.parse(row.data) as SnapshotData;
      } catch {
        continue;
      }
      if (!isRestoreUsableSnapshotData(data)) continue;
      return this.rowToSnapshot(row);
    }
    return null;
  }

  /** 解析精确或按策略排序的恢复来源，并返回在任何恢复变更前解释该决策所需的证据。 */
  selectRestoreUsable(rigId: string, snapshotId?: string, nowMs: number = Date.now()): RestoreSnapshotSelectionOutcome {
    let snapshot: Snapshot | null;
    if (snapshotId) {
      snapshot = this.getSnapshot(snapshotId);
      if (!snapshot) return { ok: false, code: "snapshot_not_found", message: `未找到快照 ${snapshotId}` };
      if (snapshot.rigId !== rigId) {
        return { ok: false, code: "snapshot_wrong_rig", message: `快照 ${snapshotId} 属于工作组 ${snapshot.rigId}，不是 ${rigId}` };
      }
      if (!isRestoreUsableSnapshotData(snapshot.data)) {
        return { ok: false, code: "snapshot_unusable", message: `快照 ${snapshotId} 的结构不满足恢复要求` };
      }
    } else {
      snapshot = this.findLatestRestoreUsable(rigId);
      if (!snapshot) return { ok: false, code: "no_usable_snapshot", message: `工作组 ${rigId} 没有可用快照` };
    }

    const newer = this.listSnapshots(rigId)
      .filter((candidate) => candidate.id !== snapshot!.id)
      .filter((candidate) => Date.parse(sqliteUtc(candidate.createdAt)) > Date.parse(sqliteUtc(snapshot!.createdAt)))
      .find((candidate) => isRestoreUsableSnapshotData(candidate.data));
    const mode = snapshotId ? "explicit" as const : "automatic" as const;
    return {
      ok: true,
      snapshot,
      selection: {
        ...summarizeSnapshot(snapshot, nowMs),
        mode,
        rationale: mode === "explicit"
          ? "操作者选择了这个确切的可恢复快照"
          : "自动崩溃保障排序优先选择 auto-pre-down/auto-periodic，其次选择最新可用快照",
        newerUsableAlternative: newer ? summarizeSnapshot(newer, nowMs) : null,
      },
    };
  }

  getLatestSnapshot(rigId: string): Snapshot | null {
    const row = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE rig_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(rigId) as SnapshotRow | undefined;
    return row ? this.rowToSnapshot(row) : null;
  }

  listSnapshots(rigId: string, opts?: ListOptions): Snapshot[] {
    let sql = "SELECT * FROM snapshots WHERE rig_id = ?";
    const params: unknown[] = [rigId];

    if (opts?.kind) {
      sql += " AND kind = ?";
      params.push(opts.kind);
    }

    sql += " ORDER BY created_at DESC";

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as SnapshotRow[];
    return rows.map((r) => this.rowToSnapshot(r));
  }

  pruneSnapshots(rigId: string, keepCount: number): number {
    // 找出要保留的最新 N 个 ID。
    const keepers = this.db
      .prepare(
        "SELECT id FROM snapshots WHERE rig_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(rigId, keepCount) as { id: string }[];

    const keepIds = new Set(keepers.map((r) => r.id));

    // 删除该工作组的其余快照。
    const all = this.db
      .prepare("SELECT id FROM snapshots WHERE rig_id = ?")
      .all(rigId) as { id: string }[];

    const toDelete = all.filter((r) => !keepIds.has(r.id));

    if (toDelete.length === 0) return 0;

    const placeholders = toDelete.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM snapshots WHERE id IN (${placeholders})`)
      .run(...toDelete.map((r) => r.id));

    return toDelete.length;
  }

  /** OPR.0.3.4.9——按 kind 限定的保留策略。保留指定 kind 最新的 `keepCount` 行，
   * 只删除该 kind 的较旧行，绝不触碰其他 kind。硬下限：keepCount >= 1，不会清理为零。 */
  pruneSnapshotsByKind(rigId: string, kind: string, keepCount: number): number {
    const effectiveKeep = Math.max(1, keepCount);
    const keepers = this.db
      .prepare(
        "SELECT id FROM snapshots WHERE rig_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(rigId, kind, effectiveKeep) as { id: string }[];

    const keepIds = new Set(keepers.map((r) => r.id));

    const all = this.db
      .prepare("SELECT id FROM snapshots WHERE rig_id = ? AND kind = ?")
      .all(rigId, kind) as { id: string }[];

    const toDelete = all.filter((r) => !keepIds.has(r.id));
    if (toDelete.length === 0) return 0;

    const placeholders = toDelete.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM snapshots WHERE id IN (${placeholders})`)
      .run(...toDelete.map((r) => r.id));

    return toDelete.length;
  }

  private rowToSnapshot(row: SnapshotRow): Snapshot {
    return {
      id: row.id,
      rigId: row.rig_id,
      kind: row.kind,
      status: row.status,
      data: JSON.parse(row.data) as SnapshotData,
      createdAt: row.created_at,
    };
  }
}

function sqliteUtc(value: string): string {
  return /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z";
}

export function summarizeSnapshot(snapshot: Snapshot, nowMs: number = Date.now()): RestoreSnapshotSummary {
  return {
    snapshotId: snapshot.id,
    kind: snapshot.kind,
    createdAt: snapshot.createdAt,
    ageMs: Math.max(0, nowMs - Date.parse(sqliteUtc(snapshot.createdAt))),
  };
}

interface SnapshotRow {
  id: string;
  rig_id: string;
  kind: string;
  status: string;
  data: string;
  created_at: string;
}

// 校验 `SnapshotData` 是否包含 `RestoreOrchestrator.restore` 预校验要求的最小结构 metadata。
//
// 按 L3b orch 修订：针对实际 SnapshotData 校验。不存在 `data.bindings[]` 字段，`Session`
// 也没有 `runtime` 字段（runtime 位于 node）。不要求 resume token，没有 token 的工作组仍可恢复。
//
// 必需结构：
//   - id 非空的 rig
//   - nodes 数组（可为空，恢复流程能处理空拓扑）
//   - edges 数组（可为空）
//   - sessions 数组（可为空，`validatePreRestore` 接受空数组）
//   - checkpoints 对象
//
// sessions 非空时，每个 session 必须具有非空 sessionName 与 nodeId，供恢复期间解析节点关联。
// 不检查 session.runtime，因为 Session 上不存在该字段（orch 修订）。
export function isRestoreUsableSnapshotData(data: unknown): data is SnapshotData {
  if (!data || typeof data !== "object") return false;
  const d = data as SnapshotData;
  if (!d.rig || typeof d.rig.id !== "string" || d.rig.id.length === 0) return false;
  if (!Array.isArray(d.nodes)) return false;
  if (!Array.isArray(d.edges)) return false;
  if (!Array.isArray(d.sessions)) return false;
  if (!d.checkpoints || typeof d.checkpoints !== "object") return false;
  const nodeIds = new Set<string>();
  for (const node of d.nodes) {
    if (!node || typeof node !== "object") return false;
    if (typeof node.id !== "string" || node.id.length === 0) return false;
    if (typeof node.logicalId !== "string" || node.logicalId.length === 0) return false;
    if (nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
  }
  for (const s of d.sessions) {
    if (!s || typeof s !== "object") return false;
    if (typeof s.sessionName !== "string" || s.sessionName.length === 0) return false;
    if (typeof s.nodeId !== "string" || s.nodeId.length === 0) return false;
  }
  if (d.topologyRoster !== undefined) {
    const roster = d.topologyRoster;
    const allowedSources = new Set(["materialized_topology", "operator_explicit", "legacy_current_nodes"]);
    if (roster.version !== 1 || !allowedSources.has(roster.source) || !Array.isArray(roster.intendedNodeIds)) return false;
    if (!roster.intendedNodeIds.every((nodeId) => typeof nodeId === "string" && nodeId.length > 0)) return false;
    if (new Set(roster.intendedNodeIds).size !== roster.intendedNodeIds.length) return false;
    if (roster.intendedNodeIds.some((nodeId) => !nodeIds.has(nodeId))) return false;
  }
  if (d.activeOccupantsByNode !== undefined) {
    if (!d.activeOccupantsByNode || typeof d.activeOccupantsByNode !== "object" || Array.isArray(d.activeOccupantsByNode)) return false;
    const intendedNodeIds = d.topologyRoster?.intendedNodeIds ?? [...nodeIds];
    if (intendedNodeIds.some((nodeId) => !(nodeId in d.activeOccupantsByNode!))) return false;
    if (Object.keys(d.activeOccupantsByNode).some((nodeId) => !nodeIds.has(nodeId))) return false;
    const sessionsById = new Map(d.sessions.map((session) => [session.id, session]));
    for (const [nodeId, state] of Object.entries(d.activeOccupantsByNode)) {
      if (!state || typeof state !== "object") return false;
      if (state.kind === "absent") continue;
      if (state.kind === "resolved" && typeof state.sessionId === "string" && state.sessionId.length > 0) {
        if (sessionsById.get(state.sessionId)?.nodeId !== nodeId) return false;
        continue;
      }
      if (state.kind === "ambiguous" && Array.isArray(state.candidateIds)) {
        if (state.candidateIds.length < 2 || new Set(state.candidateIds).size !== state.candidateIds.length) return false;
        if (state.candidateIds.some((id) => typeof id !== "string" || id.length === 0 || sessionsById.get(id)?.nodeId !== nodeId)) return false;
        continue;
      }
      return false;
    }
  }
  return true;
}
