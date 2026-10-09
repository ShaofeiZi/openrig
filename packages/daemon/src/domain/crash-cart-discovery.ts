// Crash-cart C2——后台服务关闭时的有界直读发现（计划 c015d9ed §C2，架构 a1344201）。
//
// 后台服务关闭（或无法启动）时，cockpit 仍必须显示本主机内容，因为查看始终安全。本模块无需运行
// 后台服务，通过“先复制再读取”（架构 Q1）读取其持久 SQLite 状态。后台服务 DB 使用 WAL 模式，
// 因此崩溃后的 `-wal` 保存最后已提交但尚未重放的 frame，正是必须显示的“工作停止位置”行。
// 我们把 {db, -wal, -shm} 三件套复制到一次性 scratch 目录，并以只读方式打开副本；SQLite
// 在副本上重放 WAL，得到新鲜视图，同时完全不干扰重启后台服务将重新打开的原文件。
// 按构造只读：此处绝不写后台服务状态。
//
// 读取失败关闭：若后台服务仍存活则拒绝（见 assertDaemonDown），绝不与待恢复进程竞争。
// 所有进程/I/O 探针均可注入，使逻辑可做完全隔离的单元测试。

import Database from "better-sqlite3";
import { basename, isAbsolute, join } from "node:path";

/** 拒绝：存活后台服务持有 DB，直接读取不安全，应改走实时读取 API。 */
export class DaemonLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonLiveError";
  }
}

/** 直读路径中的明确失败，例如后台服务 DB 不在解析出的路径。 */
export class CrashCartReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrashCartReadError";
  }
}

/** 后台服务默认 DB basename（`$OPENRIG_HOME/openrig.sqlite`），不是 `main.db`。 */
export const DAEMON_DB_BASENAME = "openrig.sqlite";

/** 后台服务状态文件形状（`$OPENRIG_HOME/daemon.json`），是 DB 路径与存活状态的权威记录。 */
export interface DaemonJson {
  pid: number;
  port: number;
  host?: string;
  /** 后台服务实际打开的精确 DB 路径；优先于重新计算。 */
  db: string;
  startedAt?: string;
}

export interface AssertDaemonDownDeps {
  /** `$OPENRIG_HOME`，daemon.json 所在目录。 */
  openrigHome: string;
  /** 解析 `$OPENRIG_HOME/daemon.json`；缺失/不可解析时返回 undefined，并视为已关闭。 */
  readDaemonJson: (openrigHome: string) => DaemonJson | undefined;
  /** `pid` 对应进程存活时为 true，例如 `process.kill(pid, 0)` 成功。 */
  isProcessAlive: (pid: number) => boolean;
  /** GET `<url>`；任意后台服务响应即返回 true（控制面存活），绝不抛错。 */
  probeHealthz: (url: string) => Promise<boolean>;
  /** `OPENRIG_URL` 覆盖值；设置后也探测其 /healthz，像 getDaemonStatus 一样绕过状态文件。 */
  openrigUrl?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7433;

function stripTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

/**
 * 失败关闭守卫：后台服务存活时抛 DaemonLiveError，否则正常返回。记录的 pid 存活或 /healthz
 * 有响应任一成立，就判定后台服务存活；两项都为否才能继续。该逻辑镜像后台服务自身的存活判断
 *（daemon.json pid + /healthz，并尊重 OPENRIG_URL），使 crash-cart 与 `getDaemonStatus`
 * 对“是否正在运行”不会产生分歧。
 */
export async function assertDaemonDown(deps: AssertDaemonDownDeps): Promise<void> {
  const { openrigHome, readDaemonJson, isProcessAlive, probeHealthz, openrigUrl } = deps;

  // OPENRIG_URL 设置后就是直接后台服务目标，应优先探测；有存活响应即拒绝。
  if (openrigUrl && openrigUrl.trim().length > 0) {
    if (await probeHealthz(`${stripTrailingSlash(openrigUrl.trim())}/healthz`)) {
      throw new DaemonLiveError(`后台服务响应了 OPENRIG_URL ${openrigUrl}——拒绝直接读取`);
    }
  }

  const state = readDaemonJson(openrigHome);
  if (state) {
    if (typeof state.pid === "number" && isProcessAlive(state.pid)) {
      throw new DaemonLiveError(`daemon.json 中的 pid ${state.pid} 仍存活——拒绝直接读取`);
    }
    const host = state.host ?? DEFAULT_HOST;
    const port = state.port ?? DEFAULT_PORT;
    if (await probeHealthz(`http://${host}:${port}/healthz`)) {
      throw new DaemonLiveError(`后台服务响应了 http://${host}:${port}/healthz——拒绝直接读取`);
    }
    return;
  }

  // 有显式目标但没有本地状态时，无关的默认后台服务并不拥有本实例；上方记录的 PID/目标守卫仍优先。
  if (openrigUrl?.trim()) return;
  // 没有显式目标或状态文件时，探测默认地址。
  if (await probeHealthz(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/healthz`)) {
    throw new DaemonLiveError(
      `后台服务响应了默认地址 http://${DEFAULT_HOST}:${DEFAULT_PORT}/healthz——拒绝直接读取`,
    );
  }
}

/** 已解析的后台服务 DB 位置与溯源。`relative` 标记无法可靠定位的状态文件路径，因为独立读取器
 * 不知道后台服务 CWD；调用方必须处理。 */
export interface ResolvedDbPath {
  path: string;
  fromStateFile: boolean;
  relative: boolean;
}

/**
 * 解析后台服务 DB 路径。优先使用 `daemon.json.db`（后台服务实际打开的精确路径），而不是重新计算；
 * 回退到 `$OPENRIG_HOME/openrig.sqlite`。状态文件中的相对路径会被明确标记，而非静默定位错误，
 * 因为它相对于后台服务 CWD 解析，而此处并不知道该 CWD。
 */
export function resolveDaemonDbPath(
  openrigHome: string,
  readDaemonJson: (openrigHome: string) => DaemonJson | undefined,
  configuredDbPath?: string,
): ResolvedDbPath {
  const state = readDaemonJson(openrigHome);
  if (state?.db && state.db.trim().length > 0) {
    return { path: state.db, fromStateFile: true, relative: !isAbsolute(state.db) };
  }
  const path = configuredDbPath ?? join(openrigHome, DAEMON_DB_BASENAME);
  return { path, fromStateFile: false, relative: !isAbsolute(path) };
}

export interface SnapshotDeps {
  /** 复制单个文件，例如 `copyFileSync`。 */
  copyFile: (src: string, dest: string) => void;
  /** 路径存在时为 true，例如 `existsSync`。 */
  exists: (p: string) => boolean;
}

/**
 * 把 `{db, -wal, -shm}` 三件套复制到 `scratchDir`，并返回复制后的 DB 路径。DB 文件必需，
 * 缺失时明确失败；sidecar 仅在存在时复制，正常关机的 DB 可能没有 -wal。后台服务关闭这一前置条件
 *（无并发 writer）保证普通文件复制一致；随后打开副本会在副本上重放 WAL，绝不触碰原文件。
 */
export function snapshotDaemonDb(dbPath: string, scratchDir: string, deps: SnapshotDeps): string {
  if (!deps.exists(dbPath)) {
    throw new CrashCartReadError(`在 ${dbPath} 未找到后台服务 DB——无法先复制再读取`);
  }
  const destDb = join(scratchDir, basename(dbPath));
  deps.copyFile(dbPath, destDb);
  for (const suffix of ["-wal", "-shm"]) {
    if (deps.exists(dbPath + suffix)) deps.copyFile(dbPath + suffix, destDb + suffix);
  }
  return destDb;
}

/**
 * 以只读方式打开已复制的后台服务 DB。副本位于可写 scratch 目录，旁边带有 -wal/-shm，
 * SQLite 会在其上重放 WAL，得到崩溃前最后的新鲜视图。此处只读是安全的，因为副本可丢弃，
 * 且本路径从不打开原文件。
 */
export function openDaemonDbReadonly(copyDbPath: string): Database.Database {
  return new Database(copyDbPath, { readonly: true, fileMustExist: true });
}

// ── 发现读取模型：后台服务关闭时从 DB 重建后台服务侧事实 ──────────────────────────────

/** Header 事实。`stopReason`/`priorUptimeMs` 始终为 null：经来源验证，没有任何地方持久化
 * shutdown/uptime 记录，因此后台服务关闭时诚实返回 null，绝不虚构。 */
export interface CrashCartHeader {
  /** 持久表中的最新写入时间戳（尽力表示“最近活动”）；为空时为 null。 */
  lastActivityAt: string | null;
  /** 后台服务最近一次启动时间（self_host_identity.reconciled_at 每次启动都会前进）；从未启动为 null。 */
  lastBootAt: string | null;
  /** 首次启动时间（self_host_identity.minted_at）。 */
  firstBootAt: string | null;
  hostId: string | null;
  /** 后台服务关闭时不可恢复：没有 shutdown 记录，诚实返回 null。 */
  stopReason: null;
  /** 后台服务关闭时不可恢复：没有持久化 uptime，诚实返回 null。 */
  priorUptimeMs: null;
}

/** 本主机上发现的一个工作组，以及恢复相关计数。 */
export interface RigFound {
  rigId: string;
  rigName: string;
  seatCount: number;
  runningCount: number;
  /** 最新会话经探测可恢复的席位数量（派生出的可恢复分组）。 */
  resumableCount: number;
  /** 工作组持久化的最新 `sessions.last_seen_at`；没有则为 null。实时“最近活动”来自 tmux 观测，
   * 后台服务关闭时不可用，因此这里是诚实的 DB 近似值。 */
  lastActiveAt: string | null;
}

/** 崩溃时一个进行中的队列条目；仅用于展示，故障诊断绝不修改队列状态。 */
export interface StoppedWork {
  qitemId: string;
  destinationSession: string;
  sourceSession: string;
  state: string;
  claimedAt: string | null;
  summary: string | null;
  tsUpdated: string;
}

export interface CrashCartDiscovery {
  header: CrashCartHeader;
  foundOnHost: RigFound[];
  whereWorkStopped: StoppedWork[];
}

/** 从已打开的后台服务 DB 副本读取完整的关闭态发现视图；只读。 */
export function readCrashCartDiscovery(db: Database.Database): CrashCartDiscovery {
  return {
    header: readHeader(db),
    foundOnHost: readFoundOnHost(db),
    whereWorkStopped: readWhereWorkStopped(db),
  };
}

function readHeader(db: Database.Database): CrashCartHeader {
  const id = db
    .prepare("SELECT host_id, minted_at, reconciled_at FROM self_host_identity WHERE singleton = 1")
    .get() as { host_id: string; minted_at: string; reconciled_at: string } | undefined;
  // 读取持久表中的最新写入。ORDER BY 中的 datetime() 会归一化混合时间戳格式
  //（应用写入 ISO-Z，SQLite 默认 `datetime('now')`），使比较按时间先后进行；
  // 返回最新行的原始字符串。
  const act = db
    .prepare(
      `SELECT ts FROM (
         SELECT last_seen_at AS ts FROM sessions
         UNION ALL SELECT created_at FROM sessions
         UNION ALL SELECT created_at FROM events
         UNION ALL SELECT ts_updated FROM queue_items
         UNION ALL SELECT last_seen_at FROM discovered_sessions
         UNION ALL SELECT reconciled_at FROM self_host_identity WHERE singleton = 1
       ) WHERE ts IS NOT NULL ORDER BY datetime(ts) DESC LIMIT 1`,
    )
    .get() as { ts: string } | undefined;
  return {
    lastActivityAt: act?.ts ?? null,
    lastBootAt: id?.reconciled_at ?? null,
    firstBootAt: id?.minted_at ?? null,
    hostId: id?.host_id ?? null,
    stopReason: null,
    priorUptimeMs: null,
  };
}

function readFoundOnHost(db: Database.Database): RigFound[] {
  // 逐工作组统计：席位数 + 按每节点最新会话归并的计数（最大 ULID id，遵循后台服务自己的
  // latest-per-node 约定）+ 最新持久化 last_seen_at。
  const rows = db
    .prepare(
      `SELECT r.id AS rigId, r.name AS rigName,
         (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id) AS seatCount,
         (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id
            AND (SELECT s.status FROM sessions s WHERE s.node_id = n.id ORDER BY s.id DESC LIMIT 1) = 'running'
         ) AS runningCount,
         (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id
            AND (SELECT s.resume_last_probe_status FROM sessions s WHERE s.node_id = n.id ORDER BY s.id DESC LIMIT 1) = 'resumable'
         ) AS resumableCount,
         (SELECT MAX(s.last_seen_at) FROM sessions s JOIN nodes n ON s.node_id = n.id WHERE n.rig_id = r.id) AS lastActiveAt
       FROM rigs r
       WHERE r.archived_at IS NULL
       ORDER BY r.name ASC`,
    )
    .all() as Array<{
    rigId: string;
    rigName: string;
    seatCount: number;
    runningCount: number;
    resumableCount: number;
    lastActiveAt: string | null;
  }>;
  return rows.map((r) => ({
    rigId: r.rigId,
    rigName: r.rigName,
    seatCount: r.seatCount,
    runningCount: r.runningCount,
    resumableCount: r.resumableCount,
    lastActiveAt: r.lastActiveAt ?? null,
  }));
}

export interface LoadCrashCartDiscoveryDeps extends AssertDaemonDownDeps {
  /** 当前 CLI 配置；仅在后台服务未记录自己打开的 DB 时使用。 */
  configuredDbPath?: string;
  /** 复制单个文件，例如 `copyFileSync`。 */
  copyFile: (src: string, dest: string) => void;
  /** 路径存在时为 true，例如 `existsSync`。 */
  exists: (p: string) => boolean;
  /** 为 DB 副本创建全新的一次性 scratch 目录，并返回其路径。 */
  makeScratchDir: () => string;
  /** 删除 scratch 目录（尽力清理）。 */
  removeScratchDir: (dir: string) => void;
  /** 以只读方式打开 DB 副本；默认使用 openDaemonDbReadonly，测试可注入。 */
  openDb?: (copyDbPath: string) => Database.Database;
}

/**
 * 公共 C2 入口：安全读取后台服务关闭时的发现视图。先失败关闭；若后台服务存活，则在接触磁盘前
 * 抛出 DaemonLiveError。随后把 DB 先复制到一次性 scratch 目录再读取视图，并始终清理副本。
 * 全程只读。
 */
export async function loadCrashCartDiscovery(
  deps: LoadCrashCartDiscoveryDeps,
): Promise<{ discovery: CrashCartDiscovery; dbPath: ResolvedDbPath }> {
  // 若后台服务持有 DB，在任何磁盘操作前拒绝。
  await assertDaemonDown(deps);

  const resolved = resolveDaemonDbPath(deps.openrigHome, deps.readDaemonJson, deps.configuredDbPath);
  if (resolved.relative) {
    throw new CrashCartReadError(
      `后台服务 DB 路径 '${resolved.path}' 是相对路径——后台服务 CWD 未知，关闭状态下无法定位`,
    );
  }

  if (!resolved.fromStateFile && !deps.exists(resolved.path)) {
    return { dbPath: resolved, discovery: {
      header: { lastActivityAt: null, lastBootAt: null, firstBootAt: null, hostId: null, stopReason: null, priorUptimeMs: null },
      foundOnHost: [], whereWorkStopped: [],
    } };
  }

  const scratchDir = deps.makeScratchDir();
  try {
    const copyDb = snapshotDaemonDb(resolved.path, scratchDir, {
      copyFile: deps.copyFile,
      exists: deps.exists,
    });
    const db = (deps.openDb ?? openDaemonDbReadonly)(copyDb);
    try {
      return { discovery: readCrashCartDiscovery(db), dbPath: resolved };
    } finally {
      db.close();
    }
  } finally {
    deps.removeScratchDir(scratchDir);
  }
}

function readWhereWorkStopped(db: Database.Database): StoppedWork[] {
  const rows = db
    .prepare(
      `SELECT qitem_id AS qitemId, destination_session AS destinationSession, source_session AS sourceSession,
              state, claimed_at AS claimedAt, summary, ts_updated AS tsUpdated
       FROM queue_items
       WHERE state = 'in-progress'
       ORDER BY datetime(ts_updated) DESC, qitem_id DESC`,
    )
    .all() as Array<{
    qitemId: string;
    destinationSession: string;
    sourceSession: string;
    state: string;
    claimedAt: string | null;
    summary: string | null;
    tsUpdated: string;
  }>;
  return rows.map((r) => ({
    qitemId: r.qitemId,
    destinationSession: r.destinationSession,
    sourceSession: r.sourceSession,
    state: r.state,
    claimedAt: r.claimedAt ?? null,
    summary: r.summary ?? null,
    tsUpdated: r.tsUpdated,
  }));
}
