import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { EventBus } from "./event-bus.js";
import { RigNotFoundError } from "./errors.js";
import type { ResumeMetadataRefresher } from "./resume-metadata-refresher.js";
import fs from "node:fs";
import nodePath from "node:path";
import { removeManagedBlocksFromFile, DEFAULT_CLAUDE_MANAGED_BLOCK_FILE } from "./managed-blocks.js";
import { stopTranscriptRotation } from "./transcript-rotation.js";

export interface TeardownResult {
  rigId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
}

interface TeardownOptions {
  delete?: boolean;
  /** 为未来优雅停止支持保留。目前是 no-op，因为 tmux kill-session 已立即执行，
   *  没有可跳过的优雅停止。 */
  force?: boolean;
  snapshot?: boolean;
}

interface TeardownDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  snapshotCapture: SnapshotCapture;
  eventBus: EventBus;
  resumeMetadataRefresher?: ResumeMetadataRefresher;
  serviceOrchestrator?: import("./service-orchestrator.js").ServiceOrchestrator;
}

interface LatestNodeSession {
  nodeId: string;
  sessionId: string;
  sessionName: string;
  status: string;
  runtime: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  cwd: string | null;
}

/**
 * 优雅关闭工作组：终止 tmux 会话、清除绑定并把会话标记为 exited。
 * 可选择在拆除前拍摄快照，也可选择删除工作组记录。
 */
export class RigTeardownOrchestrator {
  readonly db: Database.Database;
  private deps: TeardownDeps;

  constructor(deps: TeardownDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("RigTeardownOrchestrator：rigRepo 必须共享同一个数据库句柄");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("RigTeardownOrchestrator：sessionRegistry 必须共享同一个数据库句柄");
    if (deps.db !== deps.eventBus.db) throw new Error("RigTeardownOrchestrator：eventBus 必须共享同一个数据库句柄");
    if (deps.db !== deps.snapshotCapture.db) throw new Error("RigTeardownOrchestrator：snapshotCapture 必须共享同一个数据库句柄");
    this.db = deps.db;
    this.deps = deps;
  }

  async teardown(rigId: string, opts?: TeardownOptions): Promise<TeardownResult> {
    // 1. 校验工作组。
    const rig = this.deps.rigRepo.getRig(rigId);
    if (!rig) throw new RigNotFoundError(rigId);

    const guard = this.deps.tmuxAdapter.deliveryGuard;
    const ids = rig.nodes.map(node => node.id);
    if (guard && ids.some(id => !guard.ownsLifecycle(id))) return guard.lifecycle(ids, () => this.teardown(rigId, opts));
    const result: TeardownResult = {
      rigId, sessionsKilled: 0, snapshotId: null,
      deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [],
    };

    // 2. 获取每个节点的最新会话。
    const liveSessions = this.getLatestLiveSessions(rigId);

    // 3. 检查是否已停止。
    if (liveSessions.length === 0) {
      this.cleanupManagedGuidanceFiles(rigId);
      result.alreadyStopped = true;
      // 即使没有智能体会话在运行，仍要拆除服务。
      if (this.deps.serviceOrchestrator) {
        try { await this.deps.serviceOrchestrator.teardown(rigId); } catch { /* 尽力而为 */ }
      }
      // 若请求删除，则直接进入删除步骤。
      if (opts?.delete) {
        this.atomicDelete(rigId);
        result.deleted = true;
      } else {
        this.deps.eventBus.emit({ type: "rig.stopped", rigId });
      }
      return result;
    }

    // 4. 拆除前自动拍摄快照（始终尝试，尽力而为）。
    try {
      if (this.deps.resumeMetadataRefresher) {
        await this.deps.resumeMetadataRefresher.refresh(liveSessions);
      }
      const snap = this.deps.snapshotCapture.captureSnapshot(rigId, "auto-pre-down");
      result.snapshotId = snap.id;
    } catch (err) {
      result.errors.push(`快照失败：${(err as Error).message}`);
      // 尽力而为——快照失败时仍继续拆除。
    }

    // 5. 终止每个存活会话。
    let killFailures = 0;
    for (const session of liveSessions) {
      // V1 预发布 CLI/后台服务第 1 项：终止 tmux 会话前先停止轮转定时器，
      // 使 capture-pane 不再探测已死目标。幂等：没有已注册定时器时静默 no-op。
      stopTranscriptRotation(session.sessionName);
      const killResult = await this.deps.tmuxAdapter.killSession(session.sessionName);

      if (killResult.ok || (killResult as { code?: string }).code === "session_not_found") {
        // 成功或已不存在——原子更新数据库。
        this.atomicNodeCleanup(session);
        this.cleanupManagedGuidanceFileForNode(rigId, session.runtime, session.cwd);
        result.sessionsKilled++;
      } else {
        // 真正的终止失败——不更新此节点。
        result.errors.push(`终止会话 '${session.sessionName}' 失败：${(killResult as { message?: string }).message ?? "未知错误"}`);
        killFailures++;
      }
    }
    this.cleanupManagedGuidanceFiles(rigId);

    // 5b. 若服务存在，则拆除服务。
    if (this.deps.serviceOrchestrator) {
      try {
        await this.deps.serviceOrchestrator.teardown(rigId);
      } catch (err) {
        result.errors.push(`服务拆除警告：${(err as Error).message}`);
        // 尽力而为——继续拆除工作组。
      }
    }

    // 6. 按需删除；终止失败会阻止删除。
    if (opts?.delete) {
      if (killFailures > 0) {
        result.errors.push("工作组删除被阻止：部分会话无法终止");
        result.deleted = false;
        result.deleteBlocked = true;
      } else {
        try {
          this.atomicDelete(rigId);
          result.deleted = true;
        } catch (err) {
          result.errors.push(`工作组删除失败：${(err as Error).message}`);
          result.deleted = false;
        }
      }
    } else {
      // 发出 stopped 事件。
      this.deps.eventBus.emit({ type: "rig.stopped", rigId });
    }

    return result;
  }

  /** 原子地把会话标记为 exited、清除绑定并持久化事件。 */
  private atomicNodeCleanup(session: LatestNodeSession): void {
    const tx = this.db.transaction(() => {
      this.deps.sessionRegistry.updateStatus(session.sessionId, "exited");
      this.deps.sessionRegistry.clearBinding(session.nodeId);
    });
    tx();
  }

  /** 原子删除工作组并持久化 rig.deleted 事件。 */
  private atomicDelete(rigId: string): void {
    let persistedSeq = 0;
    let persistedAt = "";
    const tx = this.db.transaction(() => {
      const event = this.deps.eventBus.persistWithinTransaction({ type: "rig.deleted", rigId });
      persistedSeq = event.seq;
      persistedAt = event.createdAt;
      this.deps.rigRepo.deleteRig(rigId);
    });
    tx();
    this.deps.eventBus.notifySubscribers({
      type: "rig.deleted", rigId, seq: persistedSeq, createdAt: persistedAt,
    });
  }

  /** 获取每个节点的最新会话，并只保留存活状态。OPR.0.4.3.20 FR-4——委托给共享的
   *  SessionRegistry 方法，使拆除前路径与周期/手动快照刷新共用同一个查询。 */
  private getLatestLiveSessions(rigId: string): LatestNodeSession[] {
    return this.deps.sessionRegistry.getLatestLiveSessions(rigId);
  }

  private cleanupManagedGuidanceFiles(rigId: string): void {
    const rows = this.db.prepare(`
      SELECT DISTINCT runtime, cwd
      FROM nodes
      WHERE rig_id = ?
    `).all(rigId) as Array<{ runtime: string | null; cwd: string | null }>;
    for (const row of rows) {
      this.cleanupManagedGuidanceFileForNode(rigId, row.runtime, row.cwd);
    }
  }

  private cleanupManagedGuidanceFileForNode(rigId: string, runtime: string | null, cwd: string | null): void {
    if (!runtime || !cwd) {
      return;
    }
    // #25：只清理工作组选中的 Claude 文件，另一个文件绝不触碰。
    const targetPath = runtime === "claude-code"
      ? nodePath.join(cwd, this.deps.rigRepo.getRigClaudeManagedBlockFile(rigId) ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE)
      : runtime === "codex"
        ? nodePath.join(cwd, "AGENTS.md")
        : null;
    if (!targetPath) {
      return;
    }
    removeManagedBlocksFromFile({
      exists: (path) => fs.existsSync(path),
      readFile: (path) => fs.readFileSync(path, "utf-8"),
      writeFile: (path, content) => fs.writeFileSync(path, content, "utf-8"),
      deleteFile: (path) => fs.unlinkSync(path),
    }, targetPath);
  }
}
