import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

export interface ReconcileResult {
  checked: number;
  detached: number;
  errors: { sessionId: string; error: string }[];
}

interface ReconcilerDeps {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
}

// 只有活跃且尚未进入终态的会话才能变为 detached。尤其要注意，superseded 行属于占用者
// 历史；若将其改写为 detached，就会错误地复活为恢复候选，并使下次重启产生歧义。
const SKIP_STATUSES = new Set(["detached", "exited", "superseded"]);

export class Reconciler {
  private db: Database.Database;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;

  constructor(deps: ReconcilerDeps) {
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("Reconciler：sessionRegistry 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("Reconciler：eventBus 必须共享同一个数据库句柄");
    }

    this.db = deps.db;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  async reconcile(rigId: string): Promise<ReconcileResult> {
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    let checked = 0;
    let detached = 0;
    const errors: { sessionId: string; error: string }[] = [];

    for (const session of sessions) {
      if (SKIP_STATUSES.has(session.status)) {
        continue;
      }

      let alive: boolean;
      try {
        // 启动时即使 tmux 服务不可用，对账仍必须将过期行标记为 detached：此调用点明确选择
        // 将传输层缺失视为可分离状态（OPR.0.5.4.2 mini-req 2——适配器不再替调用方折叠该决策）。
        const probe = await this.tmuxAdapter.probeSession(session.sessionName);
        alive = probe.state === "present";
        checked++;
      } catch (err) {
        errors.push({
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!alive) {
        try {
          const txn = this.db.transaction(() => {
            this.sessionRegistry.markDetached(session.id);
            return this.eventBus.persistWithinTransaction({
              type: "session.detached",
              rigId,
              nodeId: session.nodeId,
              sessionName: session.sessionName,
            });
          });
          const persistedEvent = txn();
          this.eventBus.notifySubscribers(persistedEvent);
          detached++;
        } catch (err) {
          errors.push({
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { checked, detached, errors };
  }
}
