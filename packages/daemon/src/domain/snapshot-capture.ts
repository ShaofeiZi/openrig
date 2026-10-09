import type Database from "better-sqlite3";
import {
  deriveActiveOccupantsByNode,
  deriveActiveSessionIdByNode,
  deriveRehydrateOccupantsByNode,
  deriveRehydrateSessionIdByNode,
} from "./active-occupant.js";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { PersistedEvent } from "./types.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { Snapshot, SnapshotData } from "./types.js";
import { RigNotFoundError } from "./errors.js";
import { readFreshOccupantRelations } from "./fresh-occupant-relation.js";

interface SnapshotCaptureDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  snapshotRepo: SnapshotRepository;
  checkpointStore: CheckpointStore;
}

export class SnapshotCapture {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private snapshotRepo: SnapshotRepository;
  private checkpointStore: CheckpointStore;

  constructor(deps: SnapshotCaptureDeps) {
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("SnapshotCapture：rigRepo 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("SnapshotCapture：sessionRegistry 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("SnapshotCapture：eventBus 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.snapshotRepo.db) {
      throw new Error("SnapshotCapture：snapshotRepo 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.checkpointStore.db) {
      throw new Error("SnapshotCapture：checkpointStore 必须共享同一个数据库句柄");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.snapshotRepo = deps.snapshotRepo;
    this.checkpointStore = deps.checkpointStore;
  }

  captureSnapshot(rigId: string, kind: string, opts?: { intendedNodeIds?: string[] }): Snapshot {
    // 1. 获取工作组及其节点、边和绑定。
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      throw new RigNotFoundError(rigId);
    }

    // 2. 获取带恢复元数据的会话。
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    // 2b. OPR.0.5.7.1 D1 —— 通过实时无快照预览也使用的唯一共享派生逻辑
    // （active-occupant.ts），显式捕获 ACTIVE-OCCUPANT 关系，避免同级路径发生漂移。
    const recorded = kind === "auto-rehydrate" ? readFreshOccupantRelations(this.db, rigId) : {};
    const activeSessionIdByNode = kind === "auto-rehydrate"
      ? deriveRehydrateSessionIdByNode(sessions, rig.nodes.map((n) => n.id), recorded)
      : deriveActiveSessionIdByNode(sessions, rig.nodes.map((n) => n.id));
    const activeOccupantsByNode = kind === "auto-rehydrate"
      ? deriveRehydrateOccupantsByNode(sessions, rig.nodes.map((n) => n.id), recorded)
      : deriveActiveOccupantsByNode(sessions, rig.nodes.map((n) => n.id));

    const requestedRoster = opts?.intendedNodeIds;
    const materializedRoster = requestedRoster ? null : this.materializedRoster(rigId);
    const intendedNodeIds = requestedRoster ?? materializedRoster ?? rig.nodes.map((node) => node.id);
    const allNodeIds = new Set(rig.nodes.map((node) => node.id));
    if (
      new Set(intendedNodeIds).size !== intendedNodeIds.length
      || intendedNodeIds.some((nodeId) => !allNodeIds.has(nodeId))
    ) {
      throw new Error("快照的预期名册必须包含属于目标工作组的唯一节点 ID");
    }

    // 3. 以映射形式获取检查点（每个节点取最新一条）。
    const checkpoints = this.checkpointStore.getCheckpointsForRig(rigId);

    // 4. 获取 pod、连续性状态和启动上下文。
    const podRows = this.db.prepare("SELECT * FROM pods WHERE rig_id = ?")
      .all(rigId) as Array<{ id: string; rig_id: string; namespace: string; label: string; summary: string | null; continuity_policy_json: string | null; created_at: string }>;
    const podIds = podRows.map((p) => p.id);
    const continuityRows = podIds.length > 0
      ? this.db.prepare(`SELECT * FROM continuity_state WHERE pod_id IN (${podIds.map(() => "?").join(",")})`)
          .all(...podIds) as Array<{ pod_id: string; node_id: string; status: string; artifacts_json: string | null; last_sync_at: string | null; updated_at: string }>
      : [];

    const nodeStartupContext: Record<string, import("./types.js").NodeStartupSnapshot | null> = {};
    for (const node of rig.nodes) {
      const ctx = this.db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?")
        .get(node.id) as { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string; runtime: string } | undefined;
      nodeStartupContext[node.id] = ctx ? {
        projectionEntries: JSON.parse(ctx.projection_entries_json),
        resolvedStartupFiles: JSON.parse(ctx.resolved_files_json),
        startupActions: JSON.parse(ctx.startup_actions_json),
        runtime: ctx.runtime,
      } : null;
    }

    // 4b. 若存在服务记录，则从中获取环境回执。
    const servicesRecord = this.rigRepo.getServicesRecord(rigId);
    let envReceipt: import("./types.js").EnvReceipt | null = null;
    if (servicesRecord?.latestReceiptJson) {
      try {
        envReceipt = JSON.parse(servicesRecord.latestReceiptJson);
      } catch { /* receipt_only——没有可用检查点。 */ }
    }

    // 5. 组装 SnapshotData。
    const data: SnapshotData = {
      rig: rig.rig,
      nodes: rig.nodes,
      edges: rig.edges,
      sessions,
      activeSessionIdByNode,
      activeOccupantsByNode,
      topologyRoster: {
        version: 1,
        source: requestedRoster
          ? "operator_explicit"
          : materializedRoster
            ? "materialized_topology"
            : "legacy_current_nodes",
        intendedNodeIds,
      },
      checkpoints,
      pods: podRows.map((p) => ({ id: p.id, rigId: p.rig_id, namespace: p.namespace, label: p.label, summary: p.summary, continuityPolicyJson: p.continuity_policy_json, createdAt: p.created_at })),
      continuityStates: continuityRows.map((r) => ({ podId: r.pod_id, nodeId: r.node_id, status: r.status as "healthy" | "degraded" | "restoring", artifactsJson: r.artifacts_json, lastSyncAt: r.last_sync_at, updatedAt: r.updated_at })),
      nodeStartupContext,
      envReceipt,
    };

    // 5. 原子操作：在同一事务中持久化快照与事件。
    const txn = this.db.transaction(() => {
      const snapshot = this.snapshotRepo.createSnapshot(rigId, kind, data);
      const persistedEvent = this.eventBus.persistWithinTransaction({
        type: "snapshot.created",
        rigId,
        snapshotId: snapshot.id,
        kind,
      });
      return { snapshot, persistedEvent };
    });

    const { snapshot, persistedEvent } = txn();

    // 6. 提交后通知订阅方（尽力而为）。
    this.eventBus.notifySubscribers(persistedEvent);

    return snapshot;
  }

  private materializedRoster(rigId: string): string[] | null {
    const row = this.db.prepare(
      "SELECT payload FROM events WHERE rig_id = ? AND type = 'topology.roster_recorded' ORDER BY seq DESC LIMIT 1",
    ).get(rigId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload) as { intendedNodeIds?: unknown };
      if (!Array.isArray(parsed.intendedNodeIds) || !parsed.intendedNodeIds.every((id) => typeof id === "string")) {
        throw new Error("最新拓扑名册事件没有字符串 intendedNodeIds 数组");
      }
      return parsed.intendedNodeIds;
    } catch (error) {
      throw new Error(`无法从格式错误的权威拓扑名册捕获快照：${(error as Error).message}`);
    }
  }
}
