import os from "node:os";
import nodePath from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { runAsyncSite } from "./sync-site-wrap.js";

const execFileAsync = promisify(execFile);

/** F1（B12 完成项）：可返回 plain value（测试 stub 保持同步）或 Promise——每个 caller 都会 await；
 *  默认实现为 async，使 per-PID `ps eww` spawn 不再阻塞 event loop（实测：8 次 capture loop 内，
 *  15 分钟累计 burst blocking 28.9 秒）。 */
export type ResolveHomeDirByPid = (pid: number) => Promise<string | undefined> | string | undefined;

export async function defaultResolveHomeDirByPid(pid: number): Promise<string | undefined> {
  try {
    // BSD/macOS `ps` 支持用 `eww` 暴露完整 process environment。若 zrig 增加 Linux daemon
    // target，这里可能需要基于 /proc 的路径。
    const output = (await runAsyncSite("codex_thread_id.resolve_home", async () => {
      const { stdout } = await execFileAsync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf-8" });
      return stdout;
    })).trim();
    if (!output) return undefined;
    const match = output.match(/(?:^|\s)HOME=([^\s]+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function readCodexThreadIdFromCandidateHomes(
  pid: number,
  candidateHomes: Array<string | undefined>,
  exists?: (path: string) => boolean
): string | undefined {
  for (const homeDir of uniqueHomes(candidateHomes)) {
    const threadId = readCodexThreadIdFromLogs(pid, homeDir, exists);
    if (threadId) return threadId;
  }
  return undefined;
}

/**
 * OPR.0.5.3.10（补充）——无需每次调用 PID-home subprocess 的 thread-id 解析。实测放大器：
 * 最近 500 个 slow span 中有 298 个 `codex_thread_id.resolve_home` span（平均 8.24 秒，最长
 * 36.72 秒）——当几乎每个 codex seat 的 log 都位于默认 home 下时，每个 pid、每次 attempt、
 * 每个 tick 都运行一次 `ps eww`。
 *
 * 成本顺序：
 *   1. 先查默认 home——纯 file/sqlite read，零 subprocess。命中即完成。
 *   2. 查询有界、按 PID 索引的已解析非默认 home cache——process 生命周期内 pid 的 HOME 不变。
 *      命中只需 file read。
 *   3. 最后才调用 subprocess resolver——成功结果进入有界 FIFO cache。失败解析绝不缓存：下次
 *      调用可重试（负载下濒死的 `ps` 不能污染 pid）。
 */
export class CodexThreadIdResolver {
  /** 成功解析的有界 (pid,identity)→home cache——包括默认 home（若稳定的默认-home pid 没有
   *  thread log，绝不能每次 poll 都重新运行 `ps eww`）。按 IDENTITY 索引（r2 round-3）：复用的 pid
   *  携带不同 startedAt，因此从结构上 MISS 已退役 occupant 的 entry——不存在可能出错的 read-time
   *  mismatch check；延迟完成的 stale probe 也只写自己的 key，绝不覆盖更新 occupant 的 entry。
   *
   *  SETTLED entry 永不过期（e91d7a94——expiry-herd 修复）：严格在 identity lstart 所在秒结束后
   *  启动的 probe 观测到此（pid、lstart）key 的最终 occupant——该秒过去后，不可能再发生 same-pid
   *  same-second reuse，且 live process 的 HOME 不会变化——所以答案在 key 生命周期内有效，只会
   *  因 identity mismatch（新 key）或 FIFO size eviction 被移除。判定依据是 probe 开始时间，
   *  不是完成时间（orch-lead 22:39Z）：在该秒内开始的 probe 可能观测到已退役 occupant，并在其后
   *  完成。UNSETTLED entry——probe 在歧义秒内开始、identity 无法解析或 caller 无 identity——会在
   *  homeTtlMs 后过期（r2-B1/W-5.3-1）：TTL 是其 staleness bound，也是 same-second collision 的
   *  有限 recovery path。 */
  private readonly homeByKey = new Map<string, { home: string; at: number; settled: boolean }>();
  /** in-flight home resolution，按 pid+IDENTITY 索引（r2 round-3）：已知 identity 绝不能加入属于
   *  不同或无 identity occupant 的 probe——在实测 8–36 秒的 probe 期间，pid 可在 probe 中途复用；
   *  若仅按 pid 合并，会在 completed-cache check 运行前将已退役 occupant 的答案交给新 occupant。
   *  相同（pid、identity）仍合并到一个 subprocess；failure 会 reject 该 key 的所有 waiter，且不缓存。 */
  private readonly inFlightByKey = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly opts: {
      defaultHome?: string;
      resolveHomeDirByPid?: ResolveHomeDirByPid;
      readFromLogs?: (pid: number, homeDir: string) => string | undefined;
      /** 有界 cache size；最早插入者先 evict。默认 256。 */
      maxCachedPids?: number;
      /** UNSETTLED cache entry 的 freshness bound——适用于无 identity caller、无法解析的 identity，
       *  以及在 identity 歧义 lstart 秒内启动的 probe。超过后 pid 会重新 probe；这是 same-second
       *  collision 的有限 recovery path（W-5.3-1）。settled entry 从不查询它。默认 60 秒。
       *  （旧 identityHomeTtlMs tier 已移除——e91d7a94：settled entry 的任何周期性 expiry 都会同步
       *  引发不必要的 probe herd，实测为 1.5 秒内 resolve_home +20。） */
      homeTtlMs?: number;
      /** 可注入 clock（测试用）。 */
      now?: () => number;
    } = {},
  ) {}

  /**
   * 为 `pid` 解析 codex thread id。IDENTITY 必填（S10 follow-on，r1 owed item 3）：identity start
   * time 控制每次 log read，因此已退役 occupant 的 row 绝不会为复用 pid 解析成功。ungated read——
   * S10 在 round 4 前消除、如今仅靠 call-graph discipline 保证安全的类别——只能通过
   * resolveUngatedLegacy 到达，因此新增无 identity call site 会产生编译错误（review-visible pin；
   * 见 codex-thread-id 测试）。
   */
  async resolve(pid: number, identity: string): Promise<string | undefined> {
    return this.resolveInternal(pid, identity);
  }

  /**
   * 显式 ungated escape hatch——读取时不使用 identity start-time gate（复用 pid 可能匹配已退役
   * occupant 的 row）。仅用于真正无 identity 的 caller（测试、没有 census identity 的 adoption
   * 路径）。每个新增无 identity read 都必须明确调用此方法；不得重新将 resolve() identity 改为
   * optional。其 cache entry 按构造永远不会 SETTLED：它以 identity=undefined 委托，因此 minTs 为
   * undefined、settled predicate 为 false，写入的每个 entry 都受 homeTtlMs（60 秒）限制——见上方
   * cache 的 settled-permanence 规则（e91d7a94）。
   */
  async resolveUngatedLegacy(pid: number): Promise<string | undefined> {
    return this.resolveInternal(pid, undefined);
  }

  private async resolveInternal(pid: number, identity: string | undefined): Promise<string | undefined> {
    // r2 round-4：identity start time 控制每次 log read——已退役 occupant 的 row 早于当前
    // occupant start，因此永不匹配。
    const minTs = lstartToMinTs(identity);
    const readFromLogs = this.opts.readFromLogs
      ?? ((p: number, home: string) => readCodexThreadIdFromLogs(p, home, undefined, minTs));
    const defaultHome = this.opts.defaultHome ?? safeUserHomeDir() ?? os.homedir();
    const now = this.opts.now ?? Date.now;
    const ttl = this.opts.homeTtlMs ?? 60_000;

    // 1. 默认 home：无 subprocess。
    const fromDefault = readFromLogs(pid, defaultHome);
    if (fromDefault) return fromDefault;

    // 2. 此（pid、identity）的 fresh cached home：无 subprocess。复用 pid 携带新 identity，因而从
    //    结构上在此 MISS（r1 remedy）；无 identity caller 获得自己的 TTL-bounded slot。cached DEFAULT
    //    表示 subprocess 已回答过一次“default”——第 1 步已覆盖它。
    const key = `${pid}|${identity ?? ""}`;
    const cached = this.homeByKey.get(key);
    if (cached) {
      if (cached.settled || now() - cached.at <= ttl) {
        return cached.home === defaultHome ? undefined : readFromLogs(pid, cached.home);
      }
      this.homeByKey.delete(key);
    }

    // 3. subprocess resolution，按相同（pid、identity）key 合并：只有持有相同 identity 的 caller
    //    共享 probe（r2 round-3——在实测 8–36 秒的 probe 期间，pid 可能中途复用；仅按 pid 合并会
    //    将已退役 occupant 的答案交给新 occupant）。completion 只写自己的 key，因此延迟的 stale
    //    probe 绝不会覆盖更新 occupant 的 entry。
    const inFlight = this.inFlightByKey.get(key);
    const homePromise = inFlight ?? (() => {
      const resolver = this.opts.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
      // settledness 由 probe 开始时间决定（orch-lead 22:39Z）：只有严格在 identity lstart 所在秒
      // 结束后启动的 probe，才保证观测到此 key 的最终 occupant。在该秒内启动的 deferred probe
      // 即使更晚完成，也可能描述已退役 occupant，因此其 entry 保持短 TTL。合并的 waiter 继承原始
      // probe 的 verdict。
      const settled = minTs !== undefined && now() >= (minTs + 1) * 1000;
      const p = Promise.resolve(resolver(pid)).then(
        (home) => {
          this.inFlightByKey.delete(key);
          if (home) this.cacheHome(key, home, settled);
          return home;
        },
        (err) => {
          // 诚实失败：不缓存，下次调用重试。
          this.inFlightByKey.delete(key);
          throw err;
        },
      );
      this.inFlightByKey.set(key, p);
      return p;
    })();
    const home = await homePromise;
    if (!home || home === defaultHome) return undefined;
    return readFromLogs(pid, home);
  }

  private cacheHome(key: string, home: string, settled: boolean): void {
    const max = this.opts.maxCachedPids ?? 256;
    if (!this.homeByKey.has(key) && this.homeByKey.size >= max) {
      const oldest = this.homeByKey.keys().next().value;
      if (oldest !== undefined) this.homeByKey.delete(oldest);
    }
    this.homeByKey.set(key, { home, at: (this.opts.now ?? Date.now)(), settled });
  }
}

// S10 follow-on 第 3 项——REVIEW-VISIBLE pin，放在 src/ 中使 daemon typecheck gate
//（packages/daemon/tsconfig.json 排除 "test"）真正评估它。r1 finding 2026-08-23：此前
// ts-expect-error 注解位于不参与 typecheck 的测试文件中，从未触发。resolve() identity 必须保持必填：
// 若有人重新改为 optional identity——重新引入 round 4 前的 ungated 类——其 Parameters 会多出
// optional slot，`ResolveRequiresIdentity` 解析为 `never`，`true` 不再可赋值，packages/daemon 上的
// `tsc --noEmit` 会失败。resolveUngatedLegacy 是唯一无 identity read 路径。验收（r1）：将
// resolve() 改回 optional identity -> tsc 失败。
type ResolveRequiresIdentity =
  Parameters<CodexThreadIdResolver["resolve"]> extends [pid: number, identity: string] ? true : never;
const _resolveRequiresIdentityPin: ResolveRequiresIdentity = true;
void _resolveRequiresIdentityPin;

function uniqueHomes(candidateHomes: Array<string | undefined>): string[] {
  const homes = candidateHomes.filter((home): home is string => Boolean(home));
  const userHome = safeUserHomeDir();
  if (userHome) homes.push(userHome);
  return [...new Set(homes)];
}

function safeUserHomeDir(): string | undefined {
  try {
    return os.userInfo().homedir;
  } catch {
    return undefined;
  }
}

function readCodexThreadIdFromLogs(
  pid: number,
  homeDir: string,
  exists?: (path: string) => boolean,
  minTs?: number
): string | undefined {
  const loggedIds = new Set<string>();
  for (const dbPath of resolveCodexDbPaths(homeDir, "logs", exists)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        // 严格 start-second gate 保留既有 PID reuse boundary。
        const rows = db.prepare(
          "SELECT DISTINCT thread_id FROM logs WHERE process_uuid LIKE ? AND thread_id IS NOT NULL AND ts > ?"
        ).all(`pid:${pid}:%`, minTs ?? 0) as Array<{ thread_id: string }>;
        for (const row of rows) loggedIds.add(row.thread_id);
      } finally {
        db.close();
      }
    } catch { /* 缺失 log 不提供 process identity。 */ }
  }
  if (!loggedIds.size) return undefined;
  // Native title generation 会在同一 process 中记录另一个 thread。只将 PID-owned ID 连接到 retained
  // CLI conversation；recency 无法识别 TUI。
  const conversations = new Set<string>();
  for (const dbPath of resolveCodexDbPaths(homeDir, "state", exists)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const select = db.prepare("SELECT id FROM threads WHERE id = ? AND source = 'cli' AND rollout_path IS NOT NULL AND rollout_path != ''");
        for (const id of loggedIds) if (select.get(id)) conversations.add(id);
      } finally {
        db.close();
      }
    } catch { /* 缺失 native state 不能证明存在 conversation。 */ }
  }
  // 同一 process 中有多个 retained conversation 时，需要更强的 native signal。
  return conversations.size === 1 ? [...conversations][0] : undefined;
}

/** 将 `ps lstart`（"Sun Aug 23 19:30:00 2026"，本地时间）解析为 epoch 秒。reader 使用严格
 *  gate（`ts > startTs`，r2 round-6）：lstart 没有 subsecond，因此 start 所在秒内 row 的归属
 *  无法判定——B 在同一秒复用 pid 时，已退役 A 可在 ts == B.startTs 写 log。歧义秒 fail closed
 *  （诚实的 INDETERMINATE；真正 current 的 same-second row 会在下一次 poll 解析），其后的 row
 *  正常解析。无法解析 → undefined（caller 回退到 ungated read，而非虚构 gate）。 */
export function lstartToMinTs(identity: string | undefined): number | undefined {
  if (!identity) return undefined;
  const m = identity.match(/^\w{3}\s+(\w{3})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/);
  if (!m) return undefined;
  const parsed = Date.parse(`${m[1]} ${m[2]}, ${m[4]} ${m[3]}`);
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor(parsed / 1000);
}

export function resolveCodexDbPaths(homeDir: string, kind: "logs" | "state", exists?: (path: string) => boolean): string[] {
  const codexDir = nodePath.join(homeDir, ".codex");
  const discovered: Array<{ version: number; path: string }> = [];

  try {
    for (const entry of fs.readdirSync(codexDir)) {
      const match = entry.match(new RegExp(`^${kind}_(\\d+)\\.sqlite$`));
      if (!match) continue;
      discovered.push({
        version: Number(match[1]),
        path: nodePath.join(codexDir, entry),
      });
    }
  } catch {
    // 仅 best effort；回退到下方历史 filename。
  }

  if (discovered.length === 0) {
    discovered.push({ version: kind === "logs" ? 1 : 5, path: nodePath.join(codexDir, kind === "logs" ? "logs_1.sqlite" : "state_5.sqlite") });
  }

  return discovered
    .sort((a, b) => b.version - a.version)
    .map((entry) => entry.path)
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .filter((path) => (exists ?? fs.existsSync)(path));
}
