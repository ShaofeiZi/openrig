import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Pod } from "./types.js";

interface PodOptions {
  summary?: string;
  continuityPolicyJson?: string;
}

interface PodRow {
  id: string;
  rig_id: string;
  namespace: string;
  label: string;
  summary: string | null;
  continuity_policy_json: string | null;
  created_at: string;
}

/**
 * pod 的 CRUD 仓库；pod 是工作组内部的有界上下文域。
 * @param db - 共享数据库句柄
 */
export class PodRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * 在工作组中创建一个 pod。
   * @param rigId - 父工作组 id
   * @param label - 人类可读的 pod 标签
   * @param opts - 可选的摘要与连续性策略 JSON
   * @returns 已创建的 Pod
   */
  createPod(rigId: string, namespace: string, label: string, opts?: PodOptions): Pod {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO pods (id, rig_id, namespace, label, summary, continuity_policy_json) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, rigId, namespace, label, opts?.summary ?? null, opts?.continuityPolicyJson ?? null);

    return this.rowToPod(
      this.db.prepare("SELECT * FROM pods WHERE id = ?").get(id) as PodRow
    );
  }

  /**
   * 按 id 获取 pod。
 * @param podId - pod 标识符
   * @returns 找到时返回 Pod，否则返回 null
   */
  getPod(podId: string): Pod | null {
    const row = this.db.prepare("SELECT * FROM pods WHERE id = ?").get(podId) as PodRow | undefined;
    return row ? this.rowToPod(row) : null;
  }

  /** 按工作组与作者声明的 namespace 获取 pod；未找到时返回 null。 */
  getPodByNamespace(rigId: string, namespace: string): Pod | null {
    const row = this.db.prepare("SELECT * FROM pods WHERE rig_id = ? AND namespace = ?").get(rigId, namespace) as PodRow | undefined;
    return row ? this.rowToPod(row) : null;
  }

  /**
   * 获取工作组中的全部 pod。
   * @param rigId - 工作组 id
   * @returns 按创建时间排序的 Pod 数组
   */
  getPodsForRig(rigId: string): Pod[] {
    const rows = this.db
      .prepare("SELECT * FROM pods WHERE rig_id = ? ORDER BY created_at")
      .all(rigId) as PodRow[];
    return rows.map((r) => this.rowToPod(r));
  }

  /**
   * 按 id 删除 pod。
   * 引用该 pod_id 的节点会把 pod_id 设为 NULL（ON DELETE SET NULL）。
   * @param podId - pod 标识符
   */
  deletePod(podId: string): void {
    this.db.prepare("DELETE FROM pods WHERE id = ?").run(podId);
  }

  // -- 连续性状态操作 --

  getContinuityStatesForRig(rigId: string): import("./types.js").ContinuityState[] {
    const podIds = this.db.prepare("SELECT id FROM pods WHERE rig_id = ?").all(rigId) as { id: string }[];
    if (podIds.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT * FROM continuity_state WHERE pod_id IN (${podIds.map(() => "?").join(",")})`
    ).all(...podIds.map((p) => p.id)) as Array<{ pod_id: string; node_id: string; status: string; artifacts_json: string | null; last_sync_at: string | null; updated_at: string }>;
    return rows.map((r) => ({
      podId: r.pod_id,
      nodeId: r.node_id,
      status: r.status as "healthy" | "degraded" | "restoring",
      artifactsJson: r.artifacts_json,
      lastSyncAt: r.last_sync_at,
      updatedAt: r.updated_at,
    }));
  }

  updateContinuityState(podId: string, nodeId: string, status: "healthy" | "degraded" | "restoring", artifactsJson?: string): void {
    this.db.prepare(
      `INSERT INTO continuity_state (pod_id, node_id, status, artifacts_json, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(pod_id, node_id) DO UPDATE SET status = ?, artifacts_json = ?, updated_at = datetime('now')`
    ).run(podId, nodeId, status, artifactsJson ?? null, status, artifactsJson ?? null);
  }

  private rowToPod(row: PodRow): Pod {
    return {
      id: row.id,
      rigId: row.rig_id,
      namespace: row.namespace,
      label: row.label,
      summary: row.summary,
      continuityPolicyJson: row.continuity_policy_json,
      createdAt: row.created_at,
    };
  }
}
