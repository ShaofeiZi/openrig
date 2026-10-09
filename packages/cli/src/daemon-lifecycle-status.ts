import Database from "better-sqlite3";
import { join } from "node:path";
import { OPENRIG_HOME, readOpenRigEnv } from "./openrig-compat.js";

/** 后台服务的生命周期记录（mig-061），由 CLI 侧读取以渲染状态。 */
export interface DaemonLifecycleRecord {
  bootEpoch: string;
  startedAt: string;
  lastHeartbeatAt: string | null;
  stoppedAt: string | null;
}

export interface LifecycleDescription {
  /** clean-shutdown = 已写入 stopped_at；no-clean-shutdown = 未写入（崩溃/
   *  kill-9/断电）；unknown = 完全无记录（P7 之前的后台服务或从未启动过）。 */
  kind: "clean-shutdown" | "no-clean-shutdown" | "unknown";
  /** 最佳“最后可见”时间：干净退出则用 stopped_at，否则用最后心跳，再否则用启动时间。 */
  lastSeen: string | null;
  stoppedAt: string | null;
}

/**
 * P7 渲染分类——纯函数。存在 stopped_at 表示后台服务标记了干净退出；
 * 【缺失】（但有启动记录）才是关键情形：后台服务没来得及记录干净停止就死了，
 * 因此我们渲染为“未记录到干净退出，最后可见 T”，而不是干巴巴的“未运行”。
 */
export function describeLifecycle(record: DaemonLifecycleRecord | null): LifecycleDescription {
  if (!record) return { kind: "unknown", lastSeen: null, stoppedAt: null };
  if (record.stoppedAt) {
    return { kind: "clean-shutdown", lastSeen: record.stoppedAt, stoppedAt: record.stoppedAt };
  }
  return {
    kind: "no-clean-shutdown",
    lastSeen: record.lastHeartbeatAt ?? record.startedAt,
    stoppedAt: null,
  };
}

/**
 * 直接只读地从后台服务的 SQLite 库读取 daemon_lifecycle 单例。
 * 这是崩溃后仍能存活的读取路径：pid 已死时后台服务不应答 HTTP、daemon.json 也被删了，
 * 但 SQLite 行仍在。若库/表缺失或不可读则返回 null（→ “unknown”）。
 */
/** 后台服务库路径，解析方式与后台服务自身一致（D15）：
 *  优先显式指定的 OPENRIG_DB/RIGGED_DB，否则用 OPENRIG_HOME/openrig.sqlite。
 *  绝不按当前工作目录相对解析。 */
export function resolveLifecycleDbPath(): string {
  return readOpenRigEnv("OPENRIG_DB", "RIGGED_DB") || join(OPENRIG_HOME, "openrig.sqlite");
}

/** 从解析出的库路径读取并分类生命周期记录（崩溃后仍可读）。 */
export function readLifecycleDescription(): LifecycleDescription {
  return describeLifecycle(readDaemonLifecycle(resolveLifecycleDbPath()));
}

export function readDaemonLifecycle(dbPath: string): DaemonLifecycleRecord | null {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(`SELECT boot_epoch, started_at, last_heartbeat_at, stopped_at FROM daemon_lifecycle WHERE singleton = 1`)
      .get() as
      | { boot_epoch: string; started_at: string; last_heartbeat_at: string | null; stopped_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      bootEpoch: row.boot_epoch,
      startedAt: row.started_at,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      stoppedAt: row.stopped_at ?? null,
    };
  } catch {
    return null; // 无库/无表/被锁定 → unknown，绝不让 `rig status` 本身崩溃
  } finally {
    try {
      db?.close();
    } catch {
      /* 尽力而为 */
    }
  }
}
