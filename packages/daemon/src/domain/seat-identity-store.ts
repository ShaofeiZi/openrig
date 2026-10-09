import type Database from "better-sqlite3";
import type { SeatIdentityVerdict } from "./types.js";

interface VerdictRow {
  node_id: string;
  verdict: string;
  evidence_source: string | null;
  reason: string | null;
  registered_pane: string | null;
  observed_pid: number | null;
  observed_command: string | null;
  matched_layer: number | null;
  session_name: string | null;
  observed_at: string;
}

function rowToVerdict(row: VerdictRow): SeatIdentityVerdict {
  return {
    nodeId: row.node_id,
    verdict: row.verdict as SeatIdentityVerdict["verdict"],
    evidenceSource: row.evidence_source as SeatIdentityVerdict["evidenceSource"],
    reason: row.reason as SeatIdentityVerdict["reason"],
    evidence: {
      registeredPane: row.registered_pane,
      observedPid: row.observed_pid,
      observedCommand: row.observed_command,
      matchedLayer: row.matched_layer,
    },
    sessionName: row.session_name,
    observedAt: row.observed_at,
  };
}

/**
 * OPR.0.4.3.19——每节点存活身份判决的显式持久化存储（迁移 046
 * `seat_identity_verdicts`）。reconciler 写入，node-inventory 读取。此类保持为表上的轻量
 * 无状态包装，确保存活事实保存在数据库而非瞬时内存状态中（dev-guard 计划评审提醒）。
 *
 * 读取采用防御策略：绕过规范迁移列表的 fixture（没有 `seat_identity_verdicts` 表）得到
 * 空 map/undefined，而不是崩溃；投影降级为“无判决”（绝不降级状态），符合未知时失败开放契约。
 */
export class SeatIdentityStore {
  constructor(private readonly db: Database.Database) {}

  /** upsert 单个节点的判决（每个节点最后写入者获胜）。 */
  upsert(v: SeatIdentityVerdict): void {
    this.db.prepare(`
      INSERT INTO seat_identity_verdicts
        (node_id, verdict, evidence_source, reason, registered_pane, observed_pid, observed_command, matched_layer, session_name, observed_at)
      VALUES (@node_id, @verdict, @evidence_source, @reason, @registered_pane, @observed_pid, @observed_command, @matched_layer, @session_name, @observed_at)
      ON CONFLICT(node_id) DO UPDATE SET
        verdict = excluded.verdict,
        evidence_source = excluded.evidence_source,
        reason = excluded.reason,
        registered_pane = excluded.registered_pane,
        observed_pid = excluded.observed_pid,
        observed_command = excluded.observed_command,
        matched_layer = excluded.matched_layer,
        session_name = excluded.session_name,
        observed_at = excluded.observed_at
    `).run({
      node_id: v.nodeId,
      verdict: v.verdict,
      evidence_source: v.evidenceSource,
      reason: v.reason,
      registered_pane: v.evidence.registeredPane,
      observed_pid: v.evidence.observedPid,
      observed_command: v.evidence.observedCommand,
      matched_layer: v.evidence.matchedLayer,
      session_name: v.sessionName,
      observed_at: v.observedAt,
    });
  }

  /** 读取某工作组全部节点的判决，以 node_id 为键；防御式读取。 */
  getForRig(rigId: string): Map<string, SeatIdentityVerdict> {
    const out = new Map<string, SeatIdentityVerdict>();
    try {
      const rows = this.db.prepare(`
        SELECT v.* FROM seat_identity_verdicts v
        JOIN nodes n ON n.id = v.node_id
        WHERE n.rig_id = ?
      `).all(rigId) as VerdictRow[];
      for (const row of rows) out.set(row.node_id, rowToVerdict(row));
    } catch {
      // 表缺失（不完整 fixture）——降级为无判决。
    }
    return out;
  }

  /**
   * FS-1 W1.2——用一次查询读取所有工作组的判决，键结构为 rigId →（nodeId → verdict）。
   * JOIN 与 `rowToVerdict` 和 `getForRig` 相同，只去掉按工作组的 WHERE。因此，对单个
   * 工作组而言，`getForAllRigs().get(rigId)` 等价于 `getForRig(rigId)`；工作组没有判决时
   * 返回空 map。防御式读取。
   */
  getForAllRigs(): Map<string, Map<string, SeatIdentityVerdict>> {
    const out = new Map<string, Map<string, SeatIdentityVerdict>>();
    try {
      const rows = this.db.prepare(`
        SELECT v.*, n.rig_id as owning_rig_id FROM seat_identity_verdicts v
        JOIN nodes n ON n.id = v.node_id
      `).all() as Array<VerdictRow & { owning_rig_id: string }>;
      for (const row of rows) {
        let m = out.get(row.owning_rig_id);
        if (!m) { m = new Map<string, SeatIdentityVerdict>(); out.set(row.owning_rig_id, m); }
        m.set(row.node_id, rowToVerdict(row));
      }
    } catch {
      // 表缺失（不完整 fixture）——降级为无判决。
    }
    return out;
  }

  /** 读取单个节点的判决，不存在时返回 null；防御式读取。 */
  getForNode(nodeId: string): SeatIdentityVerdict | null {
    try {
      const row = this.db.prepare(
        "SELECT * FROM seat_identity_verdicts WHERE node_id = ?",
      ).get(nodeId) as VerdictRow | undefined;
      return row ? rowToVerdict(row) : null;
    } catch {
      return null;
    }
  }

  /** 删除已不在实时集合中的节点判决，以清理内存/表。 */
  pruneExcept(liveNodeIds: string[]): void {
    try {
      const existing = this.db.prepare(
        "SELECT node_id FROM seat_identity_verdicts",
      ).all() as Array<{ node_id: string }>;
      const live = new Set(liveNodeIds);
      const del = this.db.prepare("DELETE FROM seat_identity_verdicts WHERE node_id = ?");
      for (const r of existing) {
        if (!live.has(r.node_id)) del.run(r.node_id);
      }
    } catch {
      // 表缺失——无需清理。
    }
  }
}

/** 51-09 增量 1——后台服务自身主机身份的持久记录。 */
export interface SelfHostIdentityRecord {
  hostId: string;
  mintedAt: string;
  reconciledAt: string;
}

/**
 * 51-09 增量 1——后台服务自身 self-host id 的轻量持久化存储（迁移 059
 * `self_host_identity`，单例行）。根据架构裁决 cb19867f，它与 seat-identity 基础共址
 *（扩展既有存储，不创建平行身份存储）。reconciler 只生成一次，并在启动时对账；本类仅是
 * 数据库访问接缝，不包含策略——生成/对账决策位于 seat-identity-reconciler.ts。读取采用
 * 防御策略（表缺失 → null），与 SeatIdentityStore 容忍 fixture 的契约一致。
 */
export class SelfHostIdentityStore {
  constructor(private readonly db: Database.Database) {}

  /** 当前 self-host 记录；尚未生成时返回 null。 */
  get(): SelfHostIdentityRecord | null {
    try {
      const row = this.db.prepare(
        "SELECT host_id, minted_at, reconciled_at FROM self_host_identity WHERE singleton = 1",
      ).get() as { host_id: string; minted_at: string; reconciled_at: string } | undefined;
      return row ? { hostId: row.host_id, mintedAt: row.minted_at, reconciledAt: row.reconciled_at } : null;
    } catch {
      return null;
    }
  }

  /** 插入单例 self-host 记录（仅首次启动）。生成时 minted_at == reconciled_at。 */
  mint(hostId: string, nowIso: string): SelfHostIdentityRecord {
    this.db.prepare(
      "INSERT INTO self_host_identity (singleton, host_id, minted_at, reconciled_at) VALUES (1, ?, ?, ?)",
    ).run(hostId, nowIso, nowIso);
    return { hostId, mintedAt: nowIso, reconciledAt: nowIso };
  }

  /** 推进现有单例行的 reconciled_at；永不修改 host_id 和 minted_at。 */
  touchReconciledAt(nowIso: string): void {
    this.db.prepare(
      "UPDATE self_host_identity SET reconciled_at = ? WHERE singleton = 1",
    ).run(nowIso);
  }
}
