// OPR.0.3.4.9——周期快照调度器（崩溃保险底线）。
// 与 seat-activity-service 的定时器模式一致：幂等 start/stop、
// setInterval().unref()，以及按工作组隔离错误。

import type Database from "better-sqlite3";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { ResumeMetadataRefresher } from "./resume-metadata-refresher.js";
import type { ProcessCensus } from "./process-census.js";

export interface PeriodicSnapshotSchedulerDeps {
  db: Database.Database;
  snapshotCapture: SnapshotCapture;
  snapshotRepo: SnapshotRepository;
  // OPR.0.4.3.20 FR-4——每次周期快照序列化前刷新实时的逐席位恢复台账。
  // 可选；缺失时与此前一样不刷新。
  sessionRegistry?: SessionRegistry;
  resumeMetadataRefresher?: ResumeMetadataRefresher;
  /** OPR.0.5.3.10 mini-req 2——每个 tick 只为所有工作组和席位做一次进程清点。
   *  缺失时使用 refresher 自己的 lister，即 slice 前行为。 */
  processCensus?: ProcessCensus;
}

export class PeriodicSnapshotScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private deps: PeriodicSnapshotSchedulerDeps;
  private retentionKeep: number = 10;
  private running = false;

  constructor(deps: PeriodicSnapshotSchedulerDeps) {
    this.deps = deps;
  }

  start(intervalMs: number, retentionKeep: number = 10): void {
    if (this.timer) return;
    this.retentionKeep = Math.max(1, retentionKeep);
    this.timer = setInterval(() => {
      if (this.running) return;
      void this.tick();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isActive(): boolean {
    return this.timer !== null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const runningRigs = this.getRunningNonArchivedRigs();
      // OPR.0.5.3.10 mini-req 2——整个 tick 共享一次周期作用域的清点；
      // 各工作组延迟共享它，没有 Codex 发现的 tick 完全不会启动 `ps`。
      const tickListProcesses = this.deps.processCensus?.cycleLister();
      for (const rigId of runningRigs) {
        try {
          // OPR.0.4.3.20 FR-4——序列化前刷新实时 token，并使用独立 try/catch，
          // 保证刷新抛错绝不会跳过快照（守卫注意事项：不要把 refresh + capture
          // 包进同一个 try/catch）。
          if (this.deps.resumeMetadataRefresher && this.deps.sessionRegistry) {
            try {
              // fillNullOnly：常规快照刷新只填充 null token，绝不清除已有 token
              //（rev1-r2 修复——为 FR-6 保留 stale-present）。
              await this.deps.resumeMetadataRefresher.refresh(
                this.deps.sessionRegistry.getLatestLiveSessions(rigId),
                { fillNullOnly: true, ...(tickListProcesses ? { listProcesses: tickListProcesses } : {}) },
              );
            } catch { /* 尽力刷新——下方仍会写入快照 */ }
          }
          this.deps.snapshotCapture.captureSnapshot(rigId, "auto-periodic");
          this.deps.snapshotRepo.pruneSnapshotsByKind(rigId, "auto-periodic", this.retentionKeep);
        } catch {
          // 按工作组隔离错误：单个工作组失败绝不中止整个 tick。
        }
      }
    } finally {
      this.running = false;
    }
  }

  private getRunningNonArchivedRigs(): string[] {
    // 每节点最新会话语义：仅当按 created_at DESC、id DESC 排序的最新会话
    // status='running' 时，节点才算运行中。与 ps-projection.ts:116-118 一致；
    // 较旧 running + 较新 exited 表示节点并未运行。
    const rows = this.deps.db.prepare(
      `SELECT DISTINCT r.id FROM rigs r
       JOIN nodes n ON n.rig_id = r.id
       WHERE r.archived_at IS NULL
         AND (SELECT s.status FROM sessions s WHERE s.node_id = n.id
              ORDER BY s.created_at DESC, s.id DESC LIMIT 1) = 'running'`
    ).all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
