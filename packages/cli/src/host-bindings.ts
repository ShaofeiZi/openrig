import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getDefaultOpenRigPath } from "./openrig-compat.js";

/**
 * 学习得到的主机身份 sidecar——hosts.yaml 的 `known_hosts`。
 *
 * `hosts.yaml` 是手工维护的（运维人员的 `~/.ssh/config`）；本文件则是机器学习来的
 * （在我们已有的探测中，从 `/healthz` 的 `selfHostId` 做首次接触 TOFU），
 * 且可随意丢弃——删掉它即可重新学习。注册表写入路径会规范重写 hosts.yaml 并丢掉
 * 运维人员的注释，因此学习到的绑定绝不写回那里；它们存放在这里，以注册表条目的
 * 别名（`id`）为键。
 *
 * 失败语义（known_hosts 的教训——损坏的绑定必须大声报错）：
 * - 别名首次观测：静默绑定（TOFU）。
 * - 之后观测到【不一致】：绝不再静默覆盖已存绑定；矛盾会记录在该绑定上，并被每个读取方
 *   （host ls 标志、doctor 行、解析警告）暴露出来。主机的 self-id 只生成一次、永不换钥，
 *   因此观测变化意味着真正的换钥或错误登记——两者都值得大声暴露。
 * - 缺失保持 fail-open：未绑定的别名仍与今天一样可解析。
 */
export interface HostBinding {
  hostId: string;
  firstObservedAt: string;
  lastObservedAt: string;
  /** 与已存绑定【矛盾】的后续观测——保留可见，绝不采纳。 */
  conflict?: { hostId: string; observedAt: string };
}

export interface HostBindingsFile {
  version: 1;
  /** 以注册表条目的别名（`HostEntry.id`）为键。 */
  bindings: Record<string, HostBinding>;
}

export function defaultHostBindingsPath(): string {
  return getDefaultOpenRigPath("host-bindings.json");
}

/** 加载 sidecar。按契约 fail-open：缺失、不可读或损坏 → 空绑定
 *  （损坏的 sidecar 绝不能破坏解析；删掉它即可重新学习）。 */
export function loadHostBindings(path: string = defaultHostBindingsPath()): HostBindingsFile {
  const empty: HostBindingsFile = { version: 1, bindings: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return empty;
    // 声明了非 1 的 version 是【未来】的 sidecar 形状——当作不可读（空、fail-open），
    // 而不是用 v1 的眼光误解析 v2 字段。缺省 version 视为 v1
    // （本代码写出的文件总会带它；手工删减过的文件仍保持可读）。
    const version = (parsed as { version?: unknown }).version;
    if (version !== undefined && version !== 1) return empty;
    const bindings = (parsed as { bindings?: unknown }).bindings;
    if (!bindings || typeof bindings !== "object") return empty;
    const out: Record<string, HostBinding> = {};
    for (const [alias, b] of Object.entries(bindings as Record<string, unknown>)) {
      if (!b || typeof b !== "object") continue;
      const bb = b as Record<string, unknown>;
      if (typeof bb["hostId"] !== "string" || bb["hostId"].length === 0) continue;
      out[alias] = {
        hostId: bb["hostId"],
        firstObservedAt: typeof bb["firstObservedAt"] === "string" ? bb["firstObservedAt"] : "",
        lastObservedAt: typeof bb["lastObservedAt"] === "string" ? bb["lastObservedAt"] : "",
        ...(bb["conflict"] && typeof bb["conflict"] === "object"
          && typeof (bb["conflict"] as Record<string, unknown>)["hostId"] === "string"
          ? {
              conflict: {
                hostId: (bb["conflict"] as Record<string, string>)["hostId"]!,
                observedAt: typeof (bb["conflict"] as Record<string, unknown>)["observedAt"] === "string"
                  ? (bb["conflict"] as Record<string, string>)["observedAt"]!
                  : "",
              },
            }
          : {}),
      };
    }
    return { version: 1, bindings: out };
  } catch {
    return empty;
  }
}

// r1 B4 后续（F2）—— 读-改-写需要并发保护：15 个席位并发运行
// send/capture/doctor，交错写入可能抹掉兄弟进程的绑定——
// 对 BINDING 而言无害（TOFU 会重新学习），但对 CONFLICT 记录则不然：
// 丢失它正是 known_hosts 教训所禁止的“静默”。保护方式：基于 mkdir 的建议锁
// （在所有平台上都是原子的），跨 load→mutate→rename 持有，带有限次忙等重试
// 与陈旧锁接管。若在预算内拿不到锁，写入就【不加保护】地继续（fail-open——
// 可用性优先于极罕见的丢失；下一次矛盾观测会重新记录冲突）。
const LOCK_RETRIES = 40;
const LOCK_RETRY_MS = 5;
// 已知隐患（r1 F2 评审，未为此实现）：陈旧接管后，原持有者仍自以为持锁，
// 于是它的 release 会 rmdir 掉【新】持有者的锁——理论上会级联。风险低：
// 临界区完全同步（循环无法抢占它），且 2s 比正常持有时间大约长三个数量级——
// 但这台机器曾跑过 loadavg 9-11、卡顿达数分钟，所以隐患不为零。
// 用 token 校验释放的修法对“自愈缓存上的 fail-open 建议锁”而言属于过度工程。
const LOCK_STALE_MS = 2_000;

function acquireLock(lockDir: string): boolean {
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) rmdirSync(lockDir);
      } catch {
        /* 被并发抢走——重试 */
      }
      const until = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < until) { /* 有限忙等：同步 API，亚毫秒切片 */ }
    }
  }
  return false;
}

function releaseLock(lockDir: string): void {
  try { rmdirSync(lockDir); } catch { /* 尽力而为 */ }
}

export type HostObservationOutcome =
  | { outcome: "bound"; binding: HostBinding }
  | { outcome: "confirmed"; binding: HostBinding }
  /** 未改动已存绑定；矛盾已记录其上。 */
  | { outcome: "conflict"; binding: HostBinding };

/**
 * 为注册表别名 `alias` 记录一次 `observedHostId` 观测（TOFU + 大声报冲突）。
 * 通过“先写临时文件再 rename”持久化，保证崩溃的写入者绝不会留下残缺文件。
 */
export function recordHostObservation(args: {
  alias: string;
  observedHostId: string;
  now?: () => Date;
  path?: string;
}): HostObservationOutcome {
  const path = args.path ?? defaultHostBindingsPath();
  const at = (args.now ?? (() => new Date()))().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const lockDir = `${path}.lock`;
  const locked = acquireLock(lockDir);
  try {
    return recordUnderLock(args.alias, args.observedHostId, at, path);
  } finally {
    if (locked) releaseLock(lockDir);
  }
}

function recordUnderLock(alias: string, observedHostId: string, at: string, path: string): HostObservationOutcome {
  const file = loadHostBindings(path);
  const existing = file.bindings[alias];

  let result: HostObservationOutcome;
  if (!existing) {
    const binding: HostBinding = { hostId: observedHostId, firstObservedAt: at, lastObservedAt: at };
    file.bindings[alias] = binding;
    result = { outcome: "bound", binding };
  } else if (existing.hostId === observedHostId) {
    const binding: HostBinding = { ...existing, lastObservedAt: at };
    // 在记录过冲突之后再次观测到【原始】id，并不会清除冲突——
    // 身份反复横跳比稳定的矛盾更令人警惕，而不是更轻。
    file.bindings[alias] = binding;
    result = { outcome: "confirmed", binding };
  } else {
    const binding: HostBinding = { ...existing, conflict: { hostId: observedHostId, observedAt: at } };
    file.bindings[alias] = binding;
    result = { outcome: "conflict", binding };
  }

  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
  return result;
}

/** 一行同时点出两个 id，供所有大声暴露面（ls 标志详情、doctor 行、解析警告）共用，
 *  使运维人员在各处读到同样的故事。 */
export function describeBindingConflict(alias: string, binding: HostBinding): string {
  return `主机 '${alias}'：观测到的 self-id '${binding.conflict?.hostId}' 与已学习绑定 '${binding.hostId}' 矛盾——主机的 self-id 只生成一次，因此这是换钥或错误登记。若换钥是合法的，请在 ${defaultHostBindingsPath()} 中删除 '${alias}' 条目以重新学习（TOFU）。`;
}
