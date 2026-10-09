import type Database from "better-sqlite3";

/** 后台服务生命周期记录（mig-061 单例）——当前启动 epoch 的 started / last-seen / stopped。
 *  与身份记录（059）相互独立。 */
export interface DaemonLifecycleRecord {
  bootEpoch: string;
  startedAt: string;
  lastHeartbeatAt: string | null;
  stoppedAt: string | null;
}

interface Row {
  boot_epoch: string;
  started_at: string;
  last_heartbeat_at: string | null;
  stopped_at: string | null;
}

/**
 * P7——daemon_lifecycle 单例的访问器。每次写入都是单条语句，即各自独立的隐式 SQLite
 * 事务（架构要求：“独立的小事务”）。心跳只允许未停止记录，且 stop 对每个 epoch 都是终态，
 * 因此停止后的游离 tick 绝不会推进 last-seen（写入顺序锁定项）。
 */
export class DaemonLifecycleStore {
  constructor(private readonly db: Database.Database) {}

  /** 新启动：创建新 epoch、设置 started_at，并清除上次运行的 heartbeat 与 stopped_at；
   *  新 epoch 绝不能显示上次运行的停止状态。 */
  recordBoot(bootEpoch: string, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO daemon_lifecycle (singleton, boot_epoch, started_at, last_heartbeat_at, stopped_at)
           VALUES (1, ?, ?, NULL, NULL)
         ON CONFLICT(singleton) DO UPDATE SET
           boot_epoch = excluded.boot_epoch,
           started_at = excluded.started_at,
           last_heartbeat_at = NULL,
           stopped_at = NULL`,
      )
      .run(bootEpoch, nowIso);
  }

  /** 仅在未停止时推进 last-seen；stopped_at 之后的游离 tick 绝不能移动 last-seen，
   *  因为 stopped_at 对每个 epoch 都是终态。 */
  recordHeartbeat(nowIso: string): void {
    this.db
      .prepare(`UPDATE daemon_lifecycle SET last_heartbeat_at = ? WHERE singleton = 1 AND stopped_at IS NULL`)
      .run(nowIso);
  }

  /** 干净关闭标记——只为匹配的 epoch 且尚未停止的记录设置 stopped_at；
   *  每个 epoch 只能进入一次停止终态。 */
  recordStop(bootEpoch: string, nowIso: string): void {
    this.db
      .prepare(`UPDATE daemon_lifecycle SET stopped_at = ? WHERE singleton = 1 AND boot_epoch = ? AND stopped_at IS NULL`)
      .run(nowIso, bootEpoch);
  }

  get(): DaemonLifecycleRecord | null {
    const row = this.db
      .prepare(`SELECT boot_epoch, started_at, last_heartbeat_at, stopped_at FROM daemon_lifecycle WHERE singleton = 1`)
      .get() as Row | undefined;
    if (!row) return null;
    return {
      bootEpoch: row.boot_epoch,
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      stoppedAt: row.stopped_at ?? null,
    };
  }
}
