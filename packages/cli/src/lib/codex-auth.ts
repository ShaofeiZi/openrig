// OPR.0.4.1.29 —— rig auth 密钥安全核心（CLI 本地 / 不经过后台服务）。
//
// 本模块直接操作运维人员 CODEX_HOME 下的 Codex 认证文件，且只被 `rig auth` CLI 命令调用——
// 它【绝不】触碰后台服务，因此 token 绝无可能进入后台服务队列 / SSE 流 / SQLite / 事件日志
//（“不入队/不流式”是【构造上】成立的）。
//
// 密钥不变量（不可妥协）：任何 auth/refresh/access token 的值都【绝不】出现在、或被用于拼接任何
// 面向人的字符串。函数返回结构化、非密钥的结果对象
//（是否存在 / 模式 / 可否解析 / 登录态 / 名字 / 计数）；认证【文件】是按文件整体快照
//（受模式保护的字节拷贝），绝不读入某个会被打印的值。CODEX_HOME 默认为 $HOME/.codex，
// 可被环境变量覆盖（测试把它指向 fixture）；不内置任何个人/运维路径。
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** 严格的 profile 名白名单：字母数字开头，其后为 [A-Za-z0-9._-]，1..64 字符。排除 /、\、~、
 *  前导点、空白、控制符与 shell 元字符。fail closed。 */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateProfileName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 64 && PROFILE_NAME_RE.test(name);
}

export interface CodexAuthPaths {
  /** Codex 状态目录——CODEX_HOME 或 $HOME/.codex。 */
  codexHome: string;
  /** 已保存 profile 的目录（0700）。 */
  profileDir: string;
  /** Codex CLI 读取的当前认证文件（0600）。 */
  activeAuth: string;
  /** 产品原生的席位到 profile 元数据注册表（0600）。 */
  registryPath: string;
}

/** 从环境变量映射（默认为 process.env）解析 Codex 路径；优先使用 CODEX_HOME，否则使用 $HOME/.codex。 */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): CodexAuthPaths {
  const codexHome =
    typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0
      ? env.CODEX_HOME
      : path.join(env.HOME ?? "", ".codex");
  return {
    codexHome,
    profileDir: path.join(codexHome, "auth-profiles"),
    activeAuth: path.join(codexHome, "auth.json"),
    registryPath: path.join(codexHome, "auth-seat-registry.tsv"),
  };
}

// --- 密钥安全的 fs 辅助函数（内容绝不读入任何返回/打印值） ---

function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  const st = lstatSafe(p);
  return st !== null && st.isDirectory();
}

function isFile(p: string): boolean {
  const st = lstatSafe(p);
  return st !== null && st.isFile();
}

/** 当且仅当该路径不存在/无法 stat 时返回八进制权限串（例如 "600"）。 */
function fileModeOctal(p: string): string | null {
  const st = lstatSafe(p);
  if (st === null) return null;
  return (st.mode & 0o777).toString(8).padStart(3, "0");
}

/** 仅当 profile 文件存在、是普通文件（不是可能把访问重定向到 profile 目录外的符号链接）、
 * 链接数为 1（硬链接会共享可能位于 profile 目录外的 inode），且直接位于 profileDir 中时，
 * 才视为安全。 */
function isSafeProfileFile(p: string, profileDir: string): boolean {
  const st = lstatSafe(p);
  if (st === null || st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return false;
  return path.dirname(p) === profileDir;
}

/** 当且仅当 `dir` 的真实解析结果位于 realpath(codexHome) 内时返回 true。realpath 会追踪链上的
 * 每个符号链接，因此指向外部的符号链接父目录（例如 auth-profiles）会解析到边界外并被拒绝；
 * 仅做字面 startsWith 判断会受骗。任一路径无法解析时返回 false。 */
function realDirContained(dir: string, codexHome: string): boolean {
  try {
    const root = fs.realpathSync(codexHome);
    const resolved = fs.realpathSync(dir);
    return resolved === root || resolved.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

/** 即将写入密钥字节的目标，仅在不存在，或为链接数为 1 的普通文件（非符号链接）时才可安全替换。
 * 符号链接会重定向写入；硬链接（nlink>1）会共享可能位于 CODEX_HOME 外的 inode；
 * 经由任一者写入都会把密钥字节泄漏到边界外。 */
function destReplaceable(p: string): boolean {
  const st = lstatSafe(p);
  if (st === null) return true;
  return !st.isSymbolicLink() && st.isFile() && st.nlink === 1;
}

/** 以 fd 为先，将 `source` 复制到 `dest`（OPR.0.4.3.23 密钥边界 B1 加固）。
 * 它封堵了基于路径复制留下的先检查后使用缺口：先由 lstat 守卫检查，再由复制操作重新解析
 * 源路径时，窗口期内的 inode 置换（例如崩溃，或同一认证主目录上的另一合法工作组并发操作）
 * 可能重定向读取，导致读取错误 inode、获得撕裂文件，或短暂留下权限宽于 0600 的临时文件
 *（CERT FIO45-C）。基于路径的预检查无法消除此竞态，因此权威校验移到已打开的 fd 上：
 *   (1) 源：使用 O_NOFOLLOW 调用 openSync（最终路径组件被换成符号链接时失败关闭），随后在
 *       fd 上执行 fstat 并校验已打开的 inode（普通文件且 nlink === 1；硬链接会共享可能位于
 *       边界外的 inode）。调用方传入此前的 lstat 时，还要确认 dev/ino 仍匹配，证明窗口期内
 *       inode 未被置换。字节直接从 fd 读取；打开后绝不再次解析源路径。
 *   (2) 目标：使用 O_CREAT|O_EXCL 调用 openSync 创建临时文件，确保获得全新 inode，绝非
 *       既有硬链接或符号链接；创建时即设为 0600，消除先创建后 chmod 的窗口。随后在 fd 上
 *       fchmod，将权限固定为 0600 而不受 umask 影响，再写入源字节、fsync，最后仅以
 *       renameSync 原子发布（若在重命名前崩溃，原目标仍保持字节完整；该优势必须保留）。
 * 临时文件与 dest 位于同一目录，确保重命名不跨设备。密钥字节只会在瞬时字节缓冲区中进入
 * JS 内存；绝不打印，并在 `finally` 中擦除。调用方仍须确认 dest 的父目录位于边界内且 dest
 * 可替换；lstat 预检查保留为低成本快速失败，fd 校验才是权威层。导出该函数供 fd 优先和
 * 崩溃安全泄漏排查测试使用。 */
export function copyOntoFresh(
  source: string,
  dest: string,
  expectSrc?: { dev: number; ino: number },
): boolean {
  const tmp = `${dest}.tmp-${process.pid}`;
  // 最终路径组件被换成符号链接时，O_NOFOLLOW 会让打开操作失败关闭。此处不使用
  // O_CLOEXEC：它在 macOS Node 中未定义，@types/node 也没有该声明；且该 fd 的同步生命周期内
  // 不会启动子进程，所以 close-on-exec 在这里不起作用。
  const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
  let srcFd = -1;
  let destFd = -1;
  let data: Buffer | null = null;
  try {
    try {
      fs.rmSync(tmp, { force: true }); // clear any stale temp so the O_EXCL create below succeeds
    } catch {
      /* 忽略 */
    }
    // (1) fd 优先读取源：先打开，再在 fd 上校验；绝不重新解析源路径。
    srcFd = fs.openSync(source, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(srcFd);
    if (!st.isFile() || st.nlink !== 1) return false; // authoritative: regular file, single link
    if (expectSrc && (st.dev !== expectSrc.dev || st.ino !== expectSrc.ino)) return false; // swapped in the window
    const size = st.size;
    data = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(srcFd, data, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read !== size) return false; // torn/truncated read (the source changed under us) → fail safe
    // (2) fd 优先创建目标临时文件：全新 inode（O_EXCL）、创建即为 0600、复制字节、fsync、原子重命名。
    destFd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, 0o600);
    fs.fchmodSync(destFd, 0o600); // pin 0600 on the fd regardless of umask (no path chmod window)
    let written = 0;
    while (written < size) {
      written += fs.writeSync(destFd, data, written, size - written);
    }
    fs.fsyncSync(destFd); // durability before the sole atomic publish
    fs.closeSync(destFd);
    destFd = -1;
    fs.renameSync(tmp, dest); // atomic dir-entry swap; any old dest inode is unlinked, never written
    return true;
  } catch {
    return false;
  } finally {
    if (srcFd >= 0) {
      try {
        fs.closeSync(srcFd);
      } catch {
        /* 忽略 */
      }
    }
    if (destFd >= 0) {
      try {
        fs.closeSync(destFd);
      } catch {
        /* 忽略 */
      }
    }
    if (data) data.fill(0); // scrub the secret bytes out of the transient JS buffer
    try {
      fs.rmSync(tmp, { force: true }); // remove any orphan temp (no-op after a successful rename)
    } catch {
      /* 忽略 */
    }
  }
}

function countProfiles(profileDir: string): number {
  try {
    return fs.readdirSync(profileDir).filter((n) => n.endsWith(".json") && isFile(path.join(profileDir, n))).length;
  } catch {
    return 0;
  }
}

/** 当且仅当字符串包含控制字符（<=0x1f 或 0x7f）时返回 true，其中包括会破坏 TSV 行的
 * 制表符、换行符和 CR。允许空格、连字符、`@`、`/` 等可打印字符。这里有意不使用正则。 */
function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

export interface CodexAuthDeps {
  /** 只根据退出码解析 Codex 登录状态，绝不读取外部命令的 stdout/stderr，因为未来任何 Codex
   * 版本都可能在其中打印令牌。默认启动 `codex login status`、忽略 stdio 并映射退出码。
   * 可注入实现，以支持密闭测试。 */
  loginStatus?: (codexHome: string) => "logged_in" | "not_logged_in" | "unavailable";
}

/** 默认登录状态探测：只读取退出码，绝不捕获输出（stdio: ignore，不存在泄漏路径）。 */
function defaultLoginStatus(codexHome: string): "logged_in" | "not_logged_in" | "unavailable" {
  const r = spawnSync("codex", ["login", "status"], {
    stdio: "ignore",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  if (r.error) return "unavailable";
  return r.status === 0 ? "logged_in" : "not_logged_in";
}

export interface AuthStatusResult {
  codexHome: string;
  codexHomePresent: boolean;
  profileDirPresent: boolean;
  activeAuthPresent: boolean;
  activeAuthMode: string | null;
  activeAuthModeSafe: boolean | "unknown";
  profileCount: number;
  loginStatus: "logged_in" | "not_logged_in" | "unavailable";
}

/** 报告认证文件是否存在、权限模式、安全性、profile 数量和登录状态；绝不读取令牌内容。 */
export function authStatus(paths: CodexAuthPaths, deps: CodexAuthDeps = {}): AuthStatusResult {
  const activeAuthPresent = isFile(paths.activeAuth);
  const activeAuthMode = activeAuthPresent ? fileModeOctal(paths.activeAuth) : null;
  return {
    codexHome: paths.codexHome,
    codexHomePresent: isDir(paths.codexHome),
    profileDirPresent: isDir(paths.profileDir),
    activeAuthPresent,
    activeAuthMode,
    activeAuthModeSafe: activeAuthMode === null ? "unknown" : activeAuthMode === "600",
    profileCount: countProfiles(paths.profileDir),
    loginStatus: (deps.loginStatus ?? defaultLoginStatus)(paths.codexHome),
  };
}

export type AuthValidateResult =
  | { ok: true; name: string; path: string; mode: string }
  | {
      ok: false;
      reason: "invalid_profile" | "missing_profile" | "unsafe_path" | "unsafe_permissions" | "malformed_json" | "parse_check_unavailable";
    };

/** 校验已保存 profile：名称白名单 → 安全的普通文件 → 0600 → JSON 可解析。解析仅在内存中
 * 进行且结果会丢弃；失败时返回固定原因，绝不返回 JSON.parse 错误，因为其消息可能包含文件片段，
 * 即泄漏密钥。 */
export function authValidate(paths: CodexAuthPaths, name: string): AuthValidateResult {
  if (!validateProfileName(name)) return { ok: false, reason: "invalid_profile" };
  const target = path.join(paths.profileDir, `${name}.json`);
  if (lstatSafe(target) === null) return { ok: false, reason: "missing_profile" };
  // 必须是安全的普通文件（无符号链接/硬链接），且 profile 目录真实解析在 CODEX_HOME 内。
  if (!isSafeProfileFile(target, paths.profileDir) || !realDirContained(paths.profileDir, paths.codexHome)) {
    return { ok: false, reason: "unsafe_path" };
  }
  if (fileModeOctal(target) !== "600") return { ok: false, reason: "unsafe_permissions" };
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch {
    return { ok: false, reason: "parse_check_unavailable" };
  }
  try {
    JSON.parse(content);
  } catch {
    // 有意忽略错误对象，因为其消息可能回显文件内容（密钥）。
    return { ok: false, reason: "malformed_json" };
  }
  return { ok: true, name, path: target, mode: "600" };
}

export type AuthSaveResult =
  | { ok: true; name: string; path: string; mode: string }
  | { ok: false; reason: "invalid_profile" | "not_configured" | "unsafe_path" | "io_error" };

/** 将当前认证文件快照为命名 profile（0700 profile 目录中的 0600 文件）。通过 copyFileSync
 * 逐字节复制，内容不进入 JS 内存；结果只报告名称、路径和权限模式。 */
export function authSave(paths: CodexAuthPaths, name: string): AuthSaveResult {
  if (!validateProfileName(name)) return { ok: false, reason: "invalid_profile" };
  const srcStat = lstatSafe(paths.activeAuth);
  if (srcStat === null || !srcStat.isFile()) return { ok: false, reason: "not_configured" };
  const target = path.join(paths.profileDir, `${name}.json`);
  // 在 mkdir/chmod 前拒绝符号链接 profile 目录，避免沿链接离开 CODEX_HOME，
  // 也避免修改外部目标的权限模式。
  const pdStat = lstatSafe(paths.profileDir);
  if (pdStat !== null && pdStat.isSymbolicLink()) return { ok: false, reason: "unsafe_path" };
  try {
    fs.mkdirSync(paths.profileDir, { recursive: true });
    fs.chmodSync(paths.profileDir, 0o700);
  } catch {
    return { ok: false, reason: "io_error" };
  }
  // 父目录必须真实解析在 CODEX_HOME 内，以抵御符号链接 auth-profiles 父目录；现有目标也不得是
  // 符号链接、硬链接或非普通文件，避免经由位于 CODEX_HOME 外的 inode 写入密钥字节。
  if (!realDirContained(paths.profileDir, paths.codexHome)) return { ok: false, reason: "unsafe_path" };
  if (!destReplaceable(target)) return { ok: false, reason: "unsafe_path" };
  // 传入此前的 lstat，使 copyOntoFresh 可确认已打开 fd 仍是检查时的同一 inode（dev/ino）；
  // 若当前认证文件在先检查后使用窗口中被置换，则安全失败。
  if (!copyOntoFresh(paths.activeAuth, target, { dev: srcStat.dev, ino: srcStat.ino })) return { ok: false, reason: "io_error" };
  return { ok: true, name, path: target, mode: "600" };
}

export type AuthSwitchResult =
  | { ok: true; name: string; activePath: string; mode: string; note: string }
  | { ok: false; reason: "invalid_profile" | "missing_profile" | "unsafe_path" | "unsafe_permissions" | "io_error" };

/** 激活已保存 profile（以 0600 复制到当前认证文件）。若现有当前文件不安全，则拒绝放宽权限。
 * 逐字节复制，不回显内容。 */
export function authSwitch(paths: CodexAuthPaths, name: string): AuthSwitchResult {
  if (!validateProfileName(name)) return { ok: false, reason: "invalid_profile" };
  const source = path.join(paths.profileDir, `${name}.json`);
  const srcStat = lstatSafe(source);
  if (srcStat === null) return { ok: false, reason: "missing_profile" };
  if (!isSafeProfileFile(source, paths.profileDir)) return { ok: false, reason: "unsafe_path" };
  // 目标守卫：若当前认证文件是符号链接、非普通文件或硬链接（nlink>1），复制操作可能经由
  // 位于 CODEX_HOME 外的 inode 写入所选 profile 的密钥字节，因此必须拒绝。符号链接的
  // isFile() 为 false，旧的 isFile 门控检查会静默漏掉这两类情况。
  if (!destReplaceable(paths.activeAuth)) return { ok: false, reason: "unsafe_path" };
  if (isFile(paths.activeAuth)) {
    const m = fileModeOctal(paths.activeAuth);
    if (m !== null && m !== "600") return { ok: false, reason: "unsafe_permissions" };
  }
  try {
    fs.mkdirSync(paths.codexHome, { recursive: true });
  } catch {
    return { ok: false, reason: "io_error" };
  }
  if (!realDirContained(paths.codexHome, paths.codexHome)) return { ok: false, reason: "unsafe_path" };
  // dev/ino 连续性：已打开 profile fd 必须仍是检查时的 inode；窗口期内发生置换则安全失败。
  if (!copyOntoFresh(source, paths.activeAuth, { dev: srcStat.dev, ino: srcStat.ino })) return { ok: false, reason: "io_error" };
  return {
    ok: true,
    name,
    activePath: paths.activeAuth,
    mode: "600",
    note: "运行中的 Codex 会话不会原地切换账号；请重启受影响的席位以加载新 profile。",
  };
}

/** 列出已保存 profile 名称（profile 目录中的安全普通 *.json 文件）并排序，不读取内容。
 * 拒绝经由符号链接或树外 profile 目录列举（返回 []），因此被重定向的父目录绝不会暴露
 * CODEX_HOME 外的文件名。 */
export function authList(paths: CodexAuthPaths): string[] {
  if (!realDirContained(paths.profileDir, paths.codexHome)) return [];
  try {
    return fs
      .readdirSync(paths.profileDir)
      .filter((n) => n.endsWith(".json") && isSafeProfileFile(path.join(paths.profileDir, n), paths.profileDir))
      .map((n) => n.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

// --- Auth-B：席位 → profile 元数据注册表（产品原生；按 orch D2 不含 resume_token）---

/** 在命令输出与文档中均已声明：席位标签只是元数据，绝不是“账号正在运行”的证明。 */
export const SEAT_REGISTRY_DISCLAIMER =
  "席位标签仅为元数据；它们【不能】证明某个运行中的会话确实在使用该账号/profile。";

// 共 6 列，不含 resume_token（输出界面最不适合保存密钥级令牌）。
const SEAT_COLUMNS = ["seat", "rig", "runtime", "cwd", "auth_profile", "updated_ts"] as const;
const SEAT_HEADER = SEAT_COLUMNS.join("\t");
const SEAT_TAB_COUNT = SEAT_COLUMNS.length - 1;

export interface SeatRow {
  seat: string;
  rig: string;
  runtime: string;
  cwd: string;
  authProfile: string;
  updatedTs: string;
}

export interface SeatSetFields {
  seat: string;
  rig: string;
  runtime: string;
  cwd?: string;
  authProfile?: string;
}

function isSafeRegistryFile(p: string): boolean {
  const st = lstatSafe(p);
  return st !== null && !st.isSymbolicLink() && st.isFile();
}

/** 拒绝空值和任何控制字符，包括会破坏 TSV 的制表符、换行符和 CR。 */
function validRegistryField(v: string): boolean {
  return v.length > 0 && !hasControlChar(v);
}

function rawRegistryLines(registryPath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(registryPath, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  let first = true;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (first) {
      first = false; // skip header
      continue;
    }
    out.push(line);
  }
  return out;
}

function rowMalformed(line: string): boolean {
  const tabs = (line.match(/\t/g) ?? []).length;
  if (tabs !== SEAT_TAB_COUNT) return true;
  return line.split("\t")[0] === "";
}

function parseRow(line: string): SeatRow {
  // 调用方先通过 rowMalformed 筛选，保证 6 个字段；`?? ""` 用于满足严格索引。
  const f = line.split("\t");
  return {
    seat: f[0] ?? "",
    rig: f[1] ?? "",
    runtime: f[2] ?? "",
    cwd: f[3] ?? "",
    authProfile: f[4] ?? "",
    updatedTs: f[5] ?? "",
  };
}

export type SeatSetResult =
  | { ok: true; seat: string; registryPath: string; mode: string; disclaimer: string }
  | { ok: false; reason: "invalid_seat" | "invalid_rig" | "invalid_runtime" | "invalid_cwd" | "invalid_profile" | "unsafe_path" | "io_error" };

/** 原子更新或插入席位元数据行（临时文件 + 重命名）。丢弃既有畸形行，而不重新输出伪造元数据。
 * `now` 可注入，以支持确定性测试。 */
export function authSeatSet(
  paths: CodexAuthPaths,
  fields: SeatSetFields,
  now: () => string = () => new Date().toISOString(),
): SeatSetResult {
  if (!validRegistryField(fields.seat)) return { ok: false, reason: "invalid_seat" };
  if (!validRegistryField(fields.rig)) return { ok: false, reason: "invalid_rig" };
  if (fields.runtime !== "codex") return { ok: false, reason: "invalid_runtime" }; // v0 whitelist
  const cwd = fields.cwd && fields.cwd.length > 0 ? fields.cwd : "unknown";
  if (!validRegistryField(cwd)) return { ok: false, reason: "invalid_cwd" };
  const profile = fields.authProfile && fields.authProfile.length > 0 ? fields.authProfile : "unknown";
  if (profile !== "unknown" && !validateProfileName(profile)) return { ok: false, reason: "invalid_profile" };

  if (lstatSafe(paths.registryPath) !== null && !isSafeRegistryFile(paths.registryPath)) {
    return { ok: false, reason: "unsafe_path" };
  }
  const kept = rawRegistryLines(paths.registryPath)
    .filter((l) => !rowMalformed(l))
    .filter((l) => l.split("\t")[0] !== fields.seat);
  const newRow = [fields.seat, fields.rig, "codex", cwd, profile, now()].join("\t");
  const body = [SEAT_HEADER, ...kept, newRow].join("\n") + "\n";

  const tmp = `${paths.registryPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(paths.registryPath), { recursive: true });
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, paths.registryPath);
    fs.chmodSync(paths.registryPath, 0o600);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略 */
    }
    return { ok: false, reason: "io_error" };
  }
  return { ok: true, seat: fields.seat, registryPath: paths.registryPath, mode: "600", disclaimer: SEAT_REGISTRY_DISCLAIMER };
}

/** 列出格式正确的席位行，跳过畸形行。 */
export function authSeatsList(paths: CodexAuthPaths): SeatRow[] {
  return rawRegistryLines(paths.registryPath)
    .filter((l) => !rowMalformed(l))
    .map(parseRow);
}

export type SeatShowResult = { ok: true; row: SeatRow } | { ok: false; reason: "invalid_seat" | "missing_seat" | "unsafe_path" };

export function authSeatShow(paths: CodexAuthPaths, seat: string): SeatShowResult {
  if (!validRegistryField(seat)) return { ok: false, reason: "invalid_seat" };
  if (lstatSafe(paths.registryPath) !== null && !isSafeRegistryFile(paths.registryPath)) {
    return { ok: false, reason: "unsafe_path" };
  }
  const row = authSeatsList(paths).find((r) => r.seat === seat);
  return row ? { ok: true, row } : { ok: false, reason: "missing_seat" };
}

export interface SeatsReport {
  registryPresent: boolean;
  registryMode: string | null;
  registryModeSafe: boolean | "unknown";
  total: number;
  known: number;
  unknown: number;
  malformed: number;
}

export function authSeatsReport(paths: CodexAuthPaths): SeatsReport {
  const present = isFile(paths.registryPath);
  const mode = present ? fileModeOctal(paths.registryPath) : null;
  let total = 0;
  let known = 0;
  let unknown = 0;
  let malformed = 0;
  for (const line of rawRegistryLines(paths.registryPath)) {
    if (rowMalformed(line)) {
      malformed += 1;
      continue;
    }
    total += 1;
    const profile = line.split("\t")[4];
    if (!profile || profile === "unknown") unknown += 1;
    else known += 1;
  }
  return {
    registryPresent: present,
    registryMode: mode,
    registryModeSafe: mode === null ? "unknown" : mode === "600",
    total,
    known,
    unknown,
    malformed,
  };
}
