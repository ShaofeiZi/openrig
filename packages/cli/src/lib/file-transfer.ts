// OPR.0.4.4.18 —— `rig file copy` 核心：路径语法、FR-4 安全墙、
// 封闭的 rsync argv 构造器，以及结果分类。
//
// 安全单元（plan §3 + §7a/§7a-2，经三轮评审放行）：五层独立防线，所有拒绝都发生在
// 任何 spawn【之前】——
//   1. 语法（fail-closed）：当且仅当路径带显式 `<hostId>:` 限定符时才算远程；
//      不从 cwd/env/session 推断（FR-2）。本地前缀转义（`/ ./ ../ ~`）；形如 id 的冒号前缀
//      【必须】能解析，否则大声失败（N18-1）；前导连字符的操作数直接拒绝，并教用户用
//      `./` 转义（G18-P1 主防线）。
//   2. 归一化：本地路径做 ~ 展开 + path.resolve，被检查与传输的是【解析后】形态；
//      远程路径在归一化【之前】就拒绝任何原始 '..' 段（G18-C1：归一化会在绝对路径里折叠
//      '..'，所以归一化后再查是死代码），随后 '.'/'//' 折叠为发布形态。
//   3. 远程字符集墙（G18-P3——取代对 --protect-args 的钉死：本平台 rsync 是 OPENRSYNC，
//      拒绝 -s；在 macOS 上绝不可假设与 GNU 对等）：远程路径必须【绝对】（arch Q5）且匹配
//      ^[A-Za-z0-9._/-]+$——每个允许字符对 POSIX shell 都是惰性的，ssh 唤起的远程 shell
//      没有任何东西可解释：无分词（排除空格）、无 glob（排除 *?[]）、无展开（排除 ~ $）、
//      无元字符。拒绝时要【教】用户（点名违规字符 + 变通办法；arch note，N18-2 可复议）。
//   4. `--` 操作数钉（G18-P1 双保险）：构造器【总是】在两个路径操作数前放 `--`——
//      即使未来某个调用方绕过了拒绝，形似 flag 的路径也绝不会被解析成选项。
//   5. 本地【不经过 shell】：用 argv 数组 spawn("rsync", argv)；-e ssh 字符串只由
//      注册表字段（user 经过形态检查）构造。
//   删除类 flag 不可达（已做属性测试，含 `-s`/--protect-args【缺席】一致性钉）。
//
// 拒绝墙（FR-4，arch 认可的【短而封闭的命名清单】——扩充=一次裁决，绝不是不断增长的黑名单）：
// 本地侧拒绝解析后落在 ~/.openrig（运行中的工作组状态——崩溃安全类）、~/.ssh、~/.codex、
// ~/.claude（凭证/共享单例类）之下的路径；远程侧拒绝任何【包含】这些点目录段的路径
//（宁可保守过宽：/srv/backup/.ssh/x 仍是凭证目录；误报是大声+可复议的，漏报才是损坏类）。

import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { loadHostRegistry, resolveHost, type SshHostEntry } from "./../host-registry.js";
import { looksLikePermissionGate } from "./../cross-host-executor.js";
import { getDefaultOpenRigPath, getOpenRigHome } from "./../openrig-compat.js";

// ── grammar ────────────────────────────────────────────────────────────────

export type ParsedFileArg =
  | { kind: "local"; path: string }
  | { kind: "remote"; hostId: string; path: string };

export type FileArgParse = { ok: true; arg: ParsedFileArg } | { ok: false; error: string };

const HOST_ID_SHAPE = /^[A-Za-z0-9_-]+$/;
const SSH_USER_SHAPE = /^[A-Za-z0-9._-]+$/;
export const REMOTE_PATH_CHARSET = /^[A-Za-z0-9._/-]+$/;

/** FR-4 的短而封闭的命名拒绝清单（点目录段）。 */
export const DENIED_SEGMENTS = [".openrig", ".ssh", ".codex", ".claude"] as const;

export function parseFilePathArg(raw: string): FileArgParse {
  if (raw === "") return { ok: false, error: "空路径操作数" };
  if (raw.startsWith("-")) {
    // G18-P1 主防线：形似 flag 的操作数直接拒绝；`./` 转义才是正确指向这类文件的方式。
    return {
      ok: false,
      error: `路径操作数 '${raw}' 以 '-' 开头，可能被误认成选项。若这是一个真实本地文件，请用 ./ 前缀指向它（./${raw}）。`,
    };
  }
  // 本地前缀转义：无论有没有冒号，这些【总是】本地路径（N18-1）。
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("~")) {
    return { ok: true, arg: { kind: "local", path: raw } };
  }
  const colon = raw.indexOf(":");
  if (colon >= 0) {
    const prefix = raw.slice(0, colon);
    const rest = raw.slice(colon + 1);
    if (HOST_ID_SHAPE.test(prefix)) {
      // 形如 id 的前缀：这就是主机限定符——它必须能解析，否则命令大声失败
      //（fail-closed；绝不静默回落到本地）。
      if (rest === "") return { ok: false, error: `'${prefix}:' 后缺少远程路径——应为 ${prefix}:<绝对路径>` };
      return { ok: true, arg: { kind: "remote", hostId: prefix, path: rest } };
    }
    // 非 id 形态的前缀（含 '/'、为空等）：沿用 scp 的实际行为——整个操作数是本地路径。
    return { ok: true, arg: { kind: "local", path: raw } };
  }
  return { ok: true, arg: { kind: "local", path: raw } };
}

// ── 拒绝边界与规范化 ──────────────────────────────────────────────────────

function expandLocalTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export type PathCheck = { ok: true; normalizedPath: string } | { ok: false; error: string };

/** 本地侧：~ 展开、resolve（遍历在此折叠），然后对【解析后】形态做拒绝检查。
 *  rsync 收到的就是这个解析后形态。 */
export function checkLocalPath(raw: string): PathCheck {
  const resolved = path.resolve(expandLocalTilde(raw));
  const home = os.homedir();
  const activeOpenRigHome = path.resolve(getOpenRigHome());
  const activeHostsRegistry = path.resolve(getDefaultOpenRigPath("hosts.yaml"));
  if (resolved === activeHostsRegistry) {
    return {
      ok: false,
      error: `已拒绝：'${raw}' 解析到当前主机注册表（${activeHostsRegistry}）——v0 里注册表本身不是拷贝的源/目标。这是 FR-4 默认拒绝墙（zrig 运行态；扩充需一次裁决）。`,
    };
  }
  for (const segment of DENIED_SEGMENTS) {
    const deniedRoot = path.join(home, segment);
    if (resolved === deniedRoot || resolved.startsWith(deniedRoot + path.sep)) {
      return {
        ok: false,
        error: `已拒绝：'${raw}' 解析进 ${deniedRoot}——${segment === ".openrig" ? "zrig 运行态（含主机注册表）v0 里不是拷贝源/目标（崩溃安全）" : "凭证/智能体主目录不是拷贝的源/目标"}。这是 FR-4 默认拒绝墙（短而封闭的清单；扩充需一次裁决）。`,
      };
    }
  }
  if (
    activeOpenRigHome !== path.join(home, ".openrig") &&
    (resolved === activeOpenRigHome || resolved.startsWith(activeOpenRigHome + path.sep))
  ) {
    return {
      ok: false,
      error: `已拒绝：'${raw}' 解析进当前 OPENRIG_HOME（${activeOpenRigHome}）——zrig 运行态 v0 里不是拷贝源/目标（崩溃安全）。这是 FR-4 默认拒绝墙（短而封闭的清单；扩充需一次裁决）。`,
    };
  }
  return { ok: true, normalizedPath: resolved };
}

/** 远程侧：posix 归一化，然后过墙——仅绝对路径（arch Q5）、不残留遍历、
 *  shell 惰性字符集（G18-P3）、以及拒绝段清单。报错要【教】用户（违规字符 + 变通办法）。 */
export function checkRemotePath(raw: string, hostId: string): PathCheck {
  const charsetViolation = [...raw].find((ch) => !REMOTE_PATH_CHARSET.test(ch));
  if (charsetViolation !== undefined) {
    const shown = charsetViolation === " " ? "空格" : `'${charsetViolation}'`;
    return {
      ok: false,
      error: `已拒绝：给 '${hostId}' 的远程路径含 ${shown}，它不在 v0 远程路径字符集 [A-Za-z0-9._/-] 内。v0 从构造上让远程路径对 shell 惰性${charsetViolation === " " ? "——请改用不含空格的暂存路径，到远端再改名" : ""}。（v0 保守；放宽需一次裁决。）`,
    };
  }
  if (!raw.startsWith("/")) {
    return { ok: false, error: `已拒绝：v0 远程路径【只接受绝对路径】（主机 '${hostId}' 收到 '${raw}'）——远程 ~/相对路径解析会夹带远程侧语义。请写完整路径。` };
  }
  // G18-C1（防护代码评审）：在归一化【之前】就检查【原始】路径里的 '..'——
  // posix.normalize 会在绝对路径中完全折叠 '..'
  //（/srv/../../etc/passwd → /etc/passwd），所以归一化后再查“残留 ..”是死代码，
  // 而向上越界会静默逃逸。在“仅绝对路径”的语法里，'..' 段永远用不上；
  // 任何 '..' 都直接拒绝（不区分良性/越界——远程符号链接使得从本端无法合理判断）。
  if (raw.split("/").includes("..")) {
    return { ok: false, error: `已拒绝：远程路径 '${raw}' 含 '..' 遍历段（FR-4）。远程路径只接受绝对路径——请写不含 '..' 的最终路径。` };
  }
  const normalized = path.posix.normalize(raw);
  for (const part of normalized.split("/")) {
    if ((DENIED_SEGMENTS as readonly string[]).includes(part)) {
      return {
        ok: false,
        error: `已拒绝：远程路径 '${raw}' 含被拒目录段 '${part}'（凭证/工作组状态类；按设计宁保守过宽——FR-4 的短封闭清单）。`,
      };
    }
  }
  return { ok: true, normalizedPath: normalized };
}

// ── planning ────────────────────────────────────────────────────────────────

export interface CopySide {
  kind: "local" | "remote";
  /** 规范化路径（本地已解析 / 远程按 POSIX 规范化）。 */
  path: string;
  /** 仅远程侧存在。 */
  host?: SshHostEntry;
}

export interface CopyPlan {
  src: CopySide;
  dst: CopySide;
  dryRun: boolean;
}

export type PlanResult = { ok: true; plan: CopyPlan } | { ok: false; error: string; code: string };

export interface PlanDeps {
  registryLoader?: typeof loadHostRegistry;
}

function resolveRemoteSide(hostId: string, rawPath: string, deps: PlanDeps): { ok: true; side: CopySide } | { ok: false; error: string; code: string } {
  const loader = deps.registryLoader ?? loadHostRegistry;
  const reg = loader();
  if (!reg.ok) return { ok: false, error: reg.error, code: "registry_error" };
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) return { ok: false, error: resolved.error, code: "unknown_host" };
  if (resolved.host.transport !== "ssh") {
    return {
      ok: false,
      error: `主机 '${hostId}' 使用传输 '${resolved.host.transport}'——v0 文件传输仅支持 ssh/rsync。请为该主机注册一条 ssh 条目，或改用其他方式移动文件。`,
      code: "unsupported_transport",
    };
  }
  if (resolved.host.user !== undefined && !SSH_USER_SHAPE.test(resolved.host.user)) {
    return { ok: false, error: `注册表条目 '${hostId}' 的 user 字段不在 [A-Za-z0-9._-] 内——拒绝把它放到 ssh 命令行上`, code: "invalid_registry_user" };
  }
  const pathCheck = checkRemotePath(rawPath, hostId);
  if (!pathCheck.ok) return { ok: false, error: pathCheck.error, code: "denied_path" };
  return { ok: true, side: { kind: "remote", path: pathCheck.normalizedPath, host: resolved.host } };
}

/** 校验整个调用——这里的【每次】拒绝都发生在任何 spawn【之前】
 *（fail-closed 集合；测试里用 spawn-spy 断言）。 */
export function planFileCopy(rawSrc: string, rawDst: string, opts: { dryRun?: boolean } & PlanDeps = {}): PlanResult {
  const srcParse = parseFilePathArg(rawSrc);
  if (!srcParse.ok) return { ok: false, error: srcParse.error, code: "bad_operand" };
  const dstParse = parseFilePathArg(rawDst);
  if (!dstParse.ok) return { ok: false, error: dstParse.error, code: "bad_operand" };

  if (srcParse.arg.kind === "remote" && dstParse.arg.kind === "remote") {
    return { ok: false, error: "v0 不支持 remote 到 remote；请先拉取再推送（两次显式传输——绝不通过本主机静默中转）", code: "remote_to_remote" };
  }

  const sides: CopySide[] = [];
  for (const parsed of [srcParse.arg, dstParse.arg]) {
    if (parsed.kind === "remote") {
      const side = resolveRemoteSide(parsed.hostId, parsed.path, opts);
      if (!side.ok) return { ok: false, error: side.error, code: side.code };
      sides.push(side.side);
    } else {
      const check = checkLocalPath(parsed.path);
      if (!check.ok) return { ok: false, error: check.error, code: "denied_path" };
      sides.push({ kind: "local", path: check.normalizedPath });
    }
  }
  return { ok: true, plan: { src: sides[0]!, dst: sides[1]!, dryRun: opts.dryRun === true } };
}

// ── 闭合的 argv 构建器 ─────────────────────────────────────────────────────

function sideOperand(side: CopySide): string {
  if (side.kind === "local") return side.path;
  return `${side.host!.target}:${side.path}`;
}

/** rsync 参数【唯一】的组装处。属性（有测试断言）：
 *  永不存在删除类 flag；没有 -s/--protect-args（GNU rsync 与 openrsync 之间 argv 一致
 *  ——G18-P3 缺席钉）；`--`【总是】在两个路径操作数之前；选项位置固定。 */
export function buildRsyncArgv(plan: CopyPlan): string[] {
  const argv = ["--archive", "--itemize-changes", "--stats"];
  if (plan.dryRun) argv.push("--dry-run");
  const remote = plan.src.kind === "remote" ? plan.src : plan.dst.kind === "remote" ? plan.dst : null;
  if (remote) {
    const sshParts = ["ssh", "-o", "ConnectTimeout=10"];
    if (remote.host!.user) sshParts.push("-l", remote.host!.user);
    argv.push("-e", sshParts.join(" "));
  }
  argv.push("--", sideOperand(plan.src), sideOperand(plan.dst));
  return argv;
}

// ── execution + classification ──────────────────────────────────────────────

export type FileCopyFailedStep = "none" | "rsync-missing" | "permission-gate" | "ssh-unreachable" | "remote-command-failed";

export interface FileCopyResult {
  ok: boolean;
  failedStep: FileCopyFailedStep;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 可用时从 rsync --stats 解析。 */
  bytesTransferred?: number;
  filesTransferred?: number;
  hint?: string;
}

type SpawnFn = typeof nodeSpawn;

const CONNECTION_FAILURE_PATTERNS = [
  /connection refused/i,
  /connection timed out/i,
  /connection unexpectedly closed/i,
  /could not resolve hostname/i,
  /no route to host/i,
  /operation timed out/i,
];

function parseStats(stdout: string): { bytesTransferred?: number; filesTransferred?: number } {
  const bytes = stdout.match(/Total transferred file size:\s*([\d,.]+)\s*bytes/i);
  const files = stdout.match(/Number of (?:regular )?files transferred:\s*([\d,.]+)/i);
  const num = (m: RegExpMatchArray | null) => (m ? Number(m[1]!.replace(/[,.](?=\d{3})/g, "").replace(/,/g, "")) : undefined);
  return { bytesTransferred: num(bytes), filesTransferred: num(files) };
}

/** rsync 的错误分类就是执行器分类去掉 remote-daemon-unreachable
 *  （rsync 不需要 daemon——arch 裁决 2）。 */
export function classifyRsyncResult(exitCode: number | null, stdout: string, stderr: string): FileCopyResult {
  if (exitCode === 0) {
    return { ok: true, failedStep: "none", exitCode, stdout, stderr, ...parseStats(stdout) };
  }
  if (looksLikePermissionGate(stderr)) {
    return {
      ok: false,
      failedStep: "permission-gate",
      exitCode,
      stdout,
      stderr,
      hint: "请检查注册的主机/用户与 SSH 报错。若是认证错误，确认本进程中所需密钥、agent 或 Keychain 是否可用；若是主机密钥或签名算法错误，请与主机负责人确认期望的指纹或支持的密钥类型；请保持主机校验开启。",
    };
  }
  if (exitCode === 255 || CONNECTION_FAILURE_PATTERNS.some((re) => re.test(stderr))) {
    return { ok: false, failedStep: "ssh-unreachable", exitCode, stdout, stderr };
  }
  return { ok: false, failedStep: "remote-command-failed", exitCode, stdout, stderr };
}

export async function runFileCopy(plan: CopyPlan, deps: { spawn?: SpawnFn } = {}): Promise<FileCopyResult> {
  const argv = buildRsyncArgv(plan);
  const spawn = deps.spawn ?? nodeSpawn;
  const child = spawn("rsync", argv, { stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  let spawnFailed: NodeJS.ErrnoException | null = null;
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
  });

  const exitCode: number | null = await new Promise((resolve) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnFailed = err;
      resolve(null);
    });
    child.on("close", (code: number | null) => resolve(code));
  });

  if (spawnFailed !== null && (spawnFailed as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      ok: false,
      failedStep: "rsync-missing",
      exitCode: null,
      stdout,
      stderr,
      hint: "本机未安装 rsync。macOS：`brew install rsync`（或用与你系统自带相当或更新的 openrsync）；Linux：安装 rsync 包。",
    };
  }
  return classifyRsyncResult(exitCode, stdout, stderr);
}
