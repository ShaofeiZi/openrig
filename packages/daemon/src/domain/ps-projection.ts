import type Database from "better-sqlite3";
import type { AgentActivity, NodeInventoryEntry, NodeLifecycleState, RigLifecycleState } from "./types.js";
import {
  countAssignedWorkForEntry,
  getNodeInventoryForAllRigs,
  readAssignedWorkBySession,
  type AssignedWorkCounts,
} from "./node-inventory.js";
import { archiveWhereClause, type RigArchiveFilter } from "./rig-repository.js";
import type { SeatActivityService } from "./seat-activity-service.js";
import type { AgentActivityStore } from "./agent-activity-store.js";

export interface PsEntry {
  rigId: string;
  name: string;
  /**
   * `name` 的别名；始终存在且始终等于 `name`。
   *
   * 背景：逐节点 `NodeInventoryEntry` 以 `rigName` 暴露工作组名称，而工作组摘要
   * `PsEntry` 历史上使用 `name`。从工作组摘要 JSON 投影 `.rigName` 的智能体代码
   * 会静默得到 `null`/`undefined`。此别名消除不一致，同时不破坏读取 `.name` 的现有消费方。
   */
  rigName: string;
  nodeCount: number;
  runningCount: number;
  /**
   * Slice 15——`terminal-active` 原语报告 `isActiveWithinWindow === true` 的节点数。
   * 它与 `runningCount` 并列，后者保持 `process-alive` 语义。数据只来自
   * SeatActivityService，绝不来自队列/分派状态。
   */
  activeCount: number;
  /**
   * Slice 15——`has-work-to-do` 原语报告 `hasAssignedWork === true` 的节点数。
   * 由活跃队列项派生，其 `destination_session` 必须匹配节点任一规范坐标。
   * 与 `activeCount` 相互独立（禁止推断契约）。
   */
  hasWorkCount: number;
  status: "running" | "partial" | "stopped";
  /** 始终存在。由逐节点 `lifecycleState`（L2 之后）折叠；空工作组派生为 `stopped`，
   * 绝不是 undefined 或 null。 */
  lifecycleState: RigLifecycleState;
  uptime: string | null;
  latestSnapshot: string | null;
  /** OPR.0.3.3.19——工作组归档时的 ISO 时间戳；活跃时为 null。 */
  archivedAt: string | null;
  /** OPR.0.3.3.19——便捷标志；当且仅当 `archivedAt !== null` 时为 true。 */
  isArchived: boolean;
  /** OPR.0.3.4.9——周期快照下限：调度器是否活跃。 */
  periodicSnapshotActive: boolean;
  /** OPR.0.3.4.9——周期快照间隔（秒）；未启用时为 0。 */
  periodicSnapshotIntervalSeconds: number;
  /** OPR.0.3.4.9——此工作组的 auto-periodic 快照数量。 */
  autoPeriodicSnapshotCount: number;
  /**
   * OPR.0.4.4.21——需要关注的席位数（追加字段；聚合默认视图的 ATTENTION 标志与主机汇总的
   * “K 个需要关注”都读取它）。`seatNeedsAttention` 中任一信号触发时，该席位只计一次。
   * 与 `lifecycleState` 在同一次逐工作组清单遍历中折叠，无额外探测。
   */
  attentionCount: number;
}

/**
 * OPR.0.4.4.21——唯一的工作组汇总关注谓词（一个谓词、一个计数；镜像并扩展 CLI 的逐节点
 * `needsAttention`）。满足以下任一条件时席位需要关注：
 *   - lifecycle 为 `attention_required`
 *   - startup 为 `attention_required`/`failed`；直接按 startupStatus 计数，
 *     此处 `latestError` 可以合法地为 null
 *   - 活跃运行时 hook 报告 `needs_input`（陈旧 hook 从 store 返回 `unknown`，
 *     不贡献计数，绝不猜测）
 *   - 席位被暂挂（存在 `heldReason`）
 *   - 已记录启动错误（存在 `latestError`）
 */
export function seatNeedsAttention(entry: NodeInventoryEntry, activity: AgentActivity | null): boolean {
  return entry.lifecycleState === "attention_required"
    || entry.startupStatus === "attention_required"
    || entry.startupStatus === "failed"
    || activity?.state === "needs_input"
    || entry.heldReason != null
    || entry.latestError != null;
}

/**
 * 把逐节点生命周期状态折叠为工作组级生命周期状态。
 *
 *   attention_required > running > recoverable > stopped；混合状态使用 `degraded`。
 *
 * 规则（L2 之后）：
 *   - 任一节点 attention_required            → attention_required（优先于以下规则）。
 *   - 所有节点 running                       → running。
 *   - 所有节点均未运行，且任一可恢复           → recoverable。
 *   - 所有节点均未运行，且无可恢复项           → stopped。
 *   - running 与未运行混合                    → degraded。
 *   - 空工作组（无节点）                      → stopped。
 *
 * 工作组级 `recoverable` 取决于逐节点可恢复性；后者已经考虑工作组最新可用快照中
 * 是否包含该节点的 resume token。
 */
export function deriveRigLifecycleState(nodeStates: NodeLifecycleState[]): RigLifecycleState {
  if (nodeStates.length === 0) return "stopped";
  if (nodeStates.some((s) => s === "attention_required")) return "attention_required";

  const runningCount = nodeStates.filter((s) => s === "running").length;
  const totalCount = nodeStates.length;

  if (runningCount === totalCount) return "running";
  if (runningCount === 0) {
    const anyRecoverable = nodeStates.some((s) => s === "recoverable");
    return anyRecoverable ? "recoverable" : "stopped";
  }
  return "degraded";
}

/**
 * Slice-05 item-5（D5）——ps 运行汇总唯一的有效运行谓词。仅看
 * `sessions.status='running'` 无法感知判定：tmux 会话在带外被拆除后，席位在数据库中仍保持
 * `status='running'`，原始 SQL 计数便会把已停止席位伪造成运行中。SeatIdentityReconciler
 *（以及 Slice-05 起，live SessionTransport 在 `session_missing` 发送/捕获时）会为此场景记录
 * 适用的 `session_missing` 判定；node-inventory 已在此暴露，并受适用性门控
 *（陈旧判定为 null，即失败开放）。
 *
 * 只排除 `reason === "session_missing"`，即 tmux 会话确实消失。`pane_pid_gone`、
 * `mismatch`、`tmux_unavailable` 以及缺失或不适用（null）的判定都保持运行中：
 * 含糊或非致命的身份信号绝不能伪造 `stopped`（它只在独立轴上把 lifecycle 降为 attention）。
 * runningCount、status 与 activeCount 都经过此唯一谓词，三者不会互相矛盾。
 * 本函数只读取判定，绝不修改 `sessions.status`。
 */
export function isEffectivelyRunning(node: NodeInventoryEntry): boolean {
  if (node.sessionStatus !== "running") return false;
  if (node.identityVerdict?.reason === "session_missing") return false;
  return true;
}

/**
 * 为 `zrig ps` 投影工作组/运行摘要。
 * 汇总所有工作组的节点数、运行数、状态、运行时间与快照年龄。
 */
export class PsProjectionService {
  readonly db: Database.Database;
  private readonly seatActivity: SeatActivityService | null;
  /** OPR.0.4.4.21——为关注谓词的 `needs_input` 信号同步查询 hook 活动。
   * 可选；缺失时该信号贡献 false（如实降级），绝不猜测。 */
  private readonly agentActivity: AgentActivityStore | null;
  private periodicSnapshotActive = false;
  private periodicSnapshotIntervalSeconds = 0;

  constructor(deps: { db: Database.Database; seatActivity?: SeatActivityService; agentActivity?: AgentActivityStore }) {
    this.db = deps.db;
    this.seatActivity = deps.seatActivity ?? null;
    this.agentActivity = deps.agentActivity ?? null;
  }

  setPeriodicSnapshotState(active: boolean, intervalSeconds: number): void {
    this.periodicSnapshotActive = active;
    this.periodicSnapshotIntervalSeconds = intervalSeconds;
  }

  getEntries(filter?: RigArchiveFilter): PsEntry[] {
    // OPR.0.3.3.19——默认在投影层排除已归档工作组，而非由客户端排除。
    // 通过 includeArchived/archivedOnly 显式选择包含。
    const cond = archiveWhereClause("r.archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    const rows = this.db.prepare(`
      SELECT
        r.id as rig_id,
        r.name,
        r.archived_at as archived_at,
        (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id) as node_count,
        (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id AND
          (SELECT status FROM sessions s WHERE s.node_id = n.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) = 'running'
        ) as running_count,
        (SELECT MIN(s.created_at) FROM sessions s
          JOIN nodes n ON n.id = s.node_id
          WHERE n.rig_id = r.id AND s.status = 'running'
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = s.node_id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
        ) as earliest_running_at,
        (SELECT snap.created_at FROM snapshots snap WHERE snap.rig_id = r.id ORDER BY snap.created_at DESC, snap.id DESC LIMIT 1) as latest_snapshot_at,
        (SELECT COUNT(*) FROM snapshots snap WHERE snap.rig_id = r.id AND snap.kind = 'auto-periodic') as auto_periodic_count
      FROM rigs r
      ${where}
      ORDER BY r.name
    `).all() as Array<{
      rig_id: string;
      name: string;
      archived_at: string | null;
      node_count: number;
      running_count: number;
      earliest_running_at: string | null;
      latest_snapshot_at: string | null;
      auto_periodic_count: number;
    }>;

    const now = Date.now();

    // FS-1 W1.2（消除工作组级 N+1）：已分派工作映射在主机范围全局共享，并受不同目标会话数
    //（席位数）限制，因此这里只读取一次，而不是每个工作组执行一次 countNodesWithPendingWork。
    // 每个工作组的 hasWorkCount 随后基于下方已获取的清单，以纯 JS 派生。
    const assignedByDest = readAssignedWorkBySession(this.db);
    // FS-1 W1.2：所有工作组的节点清单在一次批处理中构建（此前每个工作组都有一组
    // getNodeInventory 查询，形成工作组级 N+1），随后按工作组索引。
    const inventoryByRig = getNodeInventoryForAllRigs(this.db);

    return rows.map((r) => {
      // 折叠逐节点状态，派生工作组级 lifecycleState。FS-1 W1.2：上方已一次批量构建
      // 所有工作组的清单（此前每个工作组各执行一组 getNodeInventory 查询，形成 N+1），
      // 此处直接按工作组索引。
      const inventory = inventoryByRig.get(r.rig_id) ?? [];

      // Slice-05 item-5（D5）——如实计算运行状态。原始 SQL 的 `running_count` 是运行基数：
      // 它按 `created_at DESC, id DESC` 选择每个节点的最新会话（“最新会话计数”契约）。
      // 不能从 `inventory` 重新派生该基数，因为 node-inventory 仅按 `id DESC` 选择最新会话；
      // 两种排序不同，当会话 id 与 created_at 不单调时会分歧（既有潜在不一致，与 D5 正交）。
      // 因此只减去 status 为 running 但实际未运行的席位，即携带适用 `session_missing` 判定的席位，
      // 避免把已拆除的 tmux 会话伪造成运行中。减法经过下方 activeCount 门控使用的同一
      // isEffectivelyRunning 谓词，使两个计数不会在存活性上分歧；绝不修改 `sessions.status`。
      const sessionMissingRunning = inventory.filter(
        (n) => n.sessionStatus === "running" && !isEffectivelyRunning(n),
      ).length;
      const effectiveRunningCount = Math.max(0, r.running_count - sessionMissingRunning);

      const status: PsEntry["status"] =
        r.node_count === 0 ? "stopped"
        : effectiveRunningCount === r.node_count ? "running"
        : effectiveRunningCount > 0 ? "partial"
        : "stopped";

      const lifecycleState = deriveRigLifecycleState(inventory.map((e) => e.lifecycleState));

      // Slice 15——`terminal-active` 计数。它是运行中、绑定 tmux 的席位子集，
      // 其最新 SeatActivity 观测必须满足 `isActiveWithinWindow === true`。
      // 只从 activity service 获取，绝不从队列状态派生。
      let activeCount = 0;
      if (this.seatActivity) {
        for (const node of inventory) {
          if (!isEffectivelyRunning(node)) continue;
          if (!node.canonicalSessionName) continue;
          const obs = this.seatActivity.getSeatActivity(node.canonicalSessionName);
          if (obs?.isActiveWithinWindow === true) activeCount++;
        }
      }

      // Slice 15——`has-work-to-do` 计数。节点至少有一个 pending、in-progress 或 blocked qitem，
      // 且目标匹配该节点任一规范坐标时计入。只从队列投影获取，绝不从 tmux 输出派生。
      // Slice 17：这里使用与逐节点清单相同的双 key 解析器和活跃状态映射，
      // 已消除原先仅单 key/仅 pending 的分歧。
      let hasWorkCount = 0;
      for (const node of inventory) {
        if (countAssignedWorkForEntry(node, assignedByDest).assignedWorkCount > 0) hasWorkCount++;
      }

      // OPR.0.4.4.21——在同一次清单遍历中折叠关注状态。hook 活动按会话名称同步查询事件
      //（NodeInventoryEntry 携带 canonicalSessionName，而非 nodeId）；`now` 确保陈旧性如实，
      // 陈旧 hook 返回 `unknown`，不贡献计数。
      let attentionCount = 0;
      const nowDate = new Date(now);
      for (const node of inventory) {
        const activity = this.agentActivity && node.canonicalSessionName
          ? this.agentActivity.getLatestForNode({ sessionName: node.canonicalSessionName, now: nowDate })
          : null;
        if (seatNeedsAttention(node, activity)) attentionCount++;
      }

      return {
        rigId: r.rig_id,
        name: r.name,
        rigName: r.name,
        nodeCount: r.node_count,
        runningCount: effectiveRunningCount,
        activeCount,
        hasWorkCount,
        status,
        lifecycleState,
        uptime: r.earliest_running_at ? formatDuration(now - new Date(r.earliest_running_at + "Z").getTime()) : null,
        latestSnapshot: r.latest_snapshot_at ? formatAge(now - new Date(r.latest_snapshot_at + "Z").getTime()) : null,
        archivedAt: r.archived_at,
        isArchived: r.archived_at !== null,
        periodicSnapshotActive: this.periodicSnapshotActive,
        periodicSnapshotIntervalSeconds: this.periodicSnapshotIntervalSeconds,
        autoPeriodicSnapshotCount: r.auto_periodic_count,
        attentionCount,
      };
    });
  }
}

/**
 * 兼容辅助函数：统计一个规范会话仅 pending 的 qitem。
 * 更宽的已分派工作投影使用下方 countAssignedWorkForSession。
 */
export function countPendingWorkForSession(db: Database.Database, canonicalSessionName: string): number {
  return countAssignedWorkForSession(db, canonicalSessionName).pendingWorkCount;
}

export function countAssignedWorkForSession(
  db: Database.Database,
  canonicalSessionName: string,
): AssignedWorkCounts {
  return readAssignedWorkBySession(db).get(canonicalSessionName) ?? {
    assignedWorkCount: 0,
    pendingWorkCount: 0,
    inProgressWorkCount: 0,
    blockedWorkCount: 0,
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return `${hours}小时 ${remainMinutes}分钟`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}天 ${remainHours}小时`;
}

function formatAge(ms: number): string {
  const dur = formatDuration(ms);
  return `${dur}前`;
}
