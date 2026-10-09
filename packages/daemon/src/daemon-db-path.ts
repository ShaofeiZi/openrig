import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 解析现有路径组成部分，包括末尾的悬空 symlink，同时保留尚未创建的尾部。SQLite 路径在首次
 * 启动时通常尚不存在，因此仅靠 realpathSync 无法回答包含关系问题。 */
function resolveForContainment(path: string, seen = new Set<string>()): string {
  const absolute = resolve(path);
  if (seen.has(absolute)) throw new Error(`解析 ${path} 时遇到 symlink 循环`);
  seen.add(absolute);
  try {
    return realpathSync(absolute);
  } catch (realpathError) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolute);
    } catch (lstatError) {
      if ((realpathError as NodeJS.ErrnoException).code !== "ENOENT" ||
          (lstatError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw realpathError;
      }
      const parent = dirname(absolute);
      return parent === absolute
        ? absolute
        : join(resolveForContainment(parent, seen), basename(absolute));
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      return resolveForContainment(resolve(dirname(absolute), target), seen);
    }
    // 路径存在，但 realpath 无法确认其身份（例如 EACCES 或 ENOTDIR）。若把它视为缺失尾部，
    // 就会错误地让未经验证的路径成为权威。
    throw realpathError;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * D15——解析后台服务的 SQLite 路径。显式 OPENRIG_DB/RIGGED_DB 优先（操作员对该路径负责）；
 * 否则数据库锚定在 OPENRIG_HOME 下，绝不使用裸的 CWD 相对文件名。
 *
 * 2026-08-07 事故：入口把 `dbPath` 默认为裸的 "openrig.sqlite"，它相对于进程 CWD 解析；
 * 因此即使用隔离 OPENRIG_HOME 启动后台服务，仍可能打开共享 fleet 数据库（即 CWD 中的文件）。
 * 将默认值锚定到 OPENRIG_HOME，可使主目录隔离的后台服务也隔离其数据库；这正是设置
 * OPENRIG_HOME 的目的。
 */
export function resolveDaemonDbPath(explicitDb: string | undefined | null, openrigHome: string): string {
  if (explicitDb && explicitDb.length > 0) {
    return explicitDb;
  }
  const dbPath = join(openrigHome, "openrig.sqlite");
  const resolvedHome = resolveForContainment(openrigHome);
  const resolvedDb = resolveForContainment(dbPath);
  if (!isWithin(resolvedHome, resolvedDb)) {
    throw new Error(
      `拒绝使用解析后位于 OPENRIG_HOME 之外的隐式数据库：${dbPath} 解析为 ${resolvedDb}，` +
      `不在 ${resolvedHome} 内。若要明确授权分离路径配置，请显式设置 OPENRIG_DB。`,
    );
  }
  return dbPath;
}
