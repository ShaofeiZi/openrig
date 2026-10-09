import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { HostEntry } from "./host-registry.js";

/**
 * 跨主机命令的结构化结果。区分 SSH 层失败（连不到远程 shell）
 * 与远程命令失败（连上了远程 shell，但命令本身返回非零）。
 * 这个区分是承重的：把两者都笼统归为“failed”，会掩盖
 * “去修你的 SSH”与“去修你远程的 rig 后台服务”之间的运维差异。
 */
export type CrossHostResult =
  | { ok: true; failedStep: "none"; stdout: string; stderr: string; remoteExitCode: 0 }
  | { ok: false; failedStep: "ssh-unreachable"; sshStderr: string }
  | { ok: false; failedStep: "permission-gate"; sshStderr: string; hint?: string }
  | { ok: false; failedStep: "remote-daemon-unreachable"; stdout: string; stderr: string; remoteExitCode: number }
  | { ok: false; failedStep: "remote-command-failed"; stdout: string; stderr: string; remoteExitCode: number }
  // D13 —— 远程 shell 解析不到该命令（exit 127 / command not found）：
  // 单列一个步骤并给出教学提示，绝不笼统归为 remote-command-failed。
  | { ok: false; failedStep: "remote-command-not-found"; stdout: string; stderr: string; remoteExitCode: number; hint: string };

export type { FailedStep } from "./cross-host-types.js";

/**
 * 可替换的 spawn 函数，便于测试。默认直接用 Node 的
 * `child_process.spawn`。测试注入一个返回可控“类进程”对象的 mock。
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
) => ChildProcess;

export interface RunCrossHostCommandOpts {
  /** 可选 stdin，写入被拉起的 ssh 进程（转发到远程 stdin）。 */
  stdin?: string;
  /** 注入非默认的 spawn 函数（测试用）。 */
  spawn?: SpawnFn;
  /** 底层 ssh 调用的连接超时秒数。默认：10。 */
  connectTimeoutSeconds?: number;
  /**
   * A2（P23）HTTP/SSH 来源对齐：来源的身份三元组（member@rig@selfHostId），由调用方
   * 用 seat 环境变量 + 本机 selfHostId 拼出（上游三元组逐字保留，绝不重新盖章）。
   * 存在时，会在远程 `sh -lc` 命令行【内部】加上前缀 `OPENRIG_SESSION_NAME=<三元组>`，
   * 使远程的 DaemonClient 盖上【来源】身份（与 A4 的 HTTP 头一致）——
   * 否则 SSH 中继会解析出【自己的】seat，削弱归因。缺省 ⇒ 不加前缀（字节不变）。
   * 这是派生出来的来源，绝不是调用方自报的身份声明。
   */
  originTriple?: string;
}

/**
 * 通过单跳 ssh 运行远程 rig 命令。返回一个结构化结果，
 * 把 dossier 中命名的每种失败模式映射到不同的 `failedStep` 值。
 *
 * 重要：本函数【不】把远程 `--verify` 语义折叠进 SSH 退出码。
 * 传了 `--verify` 的调用方会原样拿到远程命令的 stdout
 * （其中含 `Verified: yes`/`no`）；验证以远程 rig 为准。
 * SSH 成功（exit 0）只表示“我们连上了远程 shell 并跑了命令”，
 * 而不表示“验证通过”。
 */
export async function runCrossHostCommand(
  host: HostEntry,
  argv: readonly string[],
  opts: RunCrossHostCommandOpts = {},
): Promise<CrossHostResult> {
  if (host.transport !== "ssh") {
    return {
      ok: false,
      failedStep: "ssh-unreachable",
      sshStderr: `主机 '${host.id}'：传输方式 '${host.transport}' 不是 ssh；请对该主机改用 HTTP 传输`,
    };
  }
  const sshHost = host;
  if (argv.length === 0) {
    return {
      ok: false,
      failedStep: "ssh-unreachable",
      sshStderr: "内部错误：传给 runCrossHostCommand 的 argv 为空",
    };
  }

  const sshOpts: string[] = [];
  if (host.user) {
    sshOpts.push("-l", host.user);
  }
  const connectTimeout = opts.connectTimeoutSeconds ?? 10;
  sshOpts.push("-o", `ConnectTimeout=${connectTimeout}`);
  // 不加 BatchMode——运维人员合理地可能用密码/交互式认证。
  // 尊重 ~/.ssh/config 的默认值。

  // D13 —— ssh 默认用【非登录】shell 运行远程命令（运维 PATH 缺失 → 在
  // nvm/npm-global 安装下 `rig` 以 127 退出）。改用 `sh -lc` 运行，
  // 让运维自己的登录 PATH 解析到它——一次 exec、零配置；POSIX 到处都有 `sh`。
  // A2（P23）：调用方提供来源三元组时，在 sh -lc 命令行【内部】加上前缀
  // `OPENRIG_SESSION_NAME=<三元组>`，使远程 rig 推导【来源】身份，而非它自己的 seat。
  // 该前缀走与 argv 相同的 shellQuote 层；缺省 ⇒ 与 D13 相比字节不变。
  const quotedArgv = argv.map(shellQuote).join(" ");
  const innerCommand = opts.originTriple
    ? `OPENRIG_SESSION_NAME=${shellQuote(opts.originTriple)} ${quotedArgv}`
    : quotedArgv;
  const remoteCommandLine = `sh -lc ${shellQuote(innerCommand)}`;
  const fullArgs = [...sshOpts, sshHost.target, remoteCommandLine];

  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const child = spawn("ssh", fullArgs);

  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.write(opts.stdin);
    child.stdin.end();
  } else if (child.stdin) {
    child.stdin.end();
  }

  let stdout = "";
  let stderr = "";
  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    });
  }

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code: number | null) => resolve(code ?? -1));
    child.on("error", (err: Error) => {
      stderr += `\n[spawn 错误] ${err.message}`;
      resolve(-1);
    });
  });

  return classifyResult(exitCode, stdout, stderr);
}

/**
 * 把拉起的 ssh 退出码 + stderr 特征映射为结构化结果。
 *
 * - exit 0 → 成功。
 * - exit 255 → SSH 层失败。若 stderr 命中已知的权限/认证门槛
 *   （Permission denied、Keychain、主机密钥校验），归类为
 *   `permission-gate`，并附上针对所报 SSH 错误的引导。
 *   否则归类为 `ssh-unreachable`。
 * - 其他任何非零 → ssh 成功但远程 rig 命令失败。
 *   若远程 stderr 命中“后台服务未运行”特征，归类为
 *   `remote-daemon-unreachable`；否则 `remote-command-failed`。
 */
export function classifyResult(exitCode: number, stdout: string, stderr: string): CrossHostResult {
  if (exitCode === 0) {
    return { ok: true, failedStep: "none", stdout, stderr, remoteExitCode: 0 };
  }
  if (exitCode === 255 || exitCode === -1) {
    if (looksLikePermissionGate(stderr)) {
      return {
        ok: false,
        failedStep: "permission-gate",
        sshStderr: stderr,
        hint: "请检查已登记的主机/用户与该 SSH 错误。若是认证错误，确认本进程中目标密钥、agent 或 Keychain 可用；若是主机密钥或签名算法错误，与主机方确认期望的指纹或支持的密钥类型；请保持主机校验开启。",
      };
    }
    return { ok: false, failedStep: "ssh-unreachable", sshStderr: stderr };
  }
  // D13 —— 解析失败单列一个响亮类别（127 或 not-found 特征）。
  if (exitCode === 127 || /command not found/i.test(stderr)) {
    return {
      ok: false,
      failedStep: "remote-command-not-found",
      stdout,
      stderr,
      remoteExitCode: exitCode,
      hint: "远程登录 PATH 解析不到 `rig`。请检查远程安装（登录 profile 里的 nvm/npm-global）；若 profile 无法承载，hosts.yaml 的 rigPath 覆盖是最后的逃生通道。",
    };
  }
  if (looksLikeDaemonUnreachable(stderr) || looksLikeDaemonUnreachable(stdout)) {
    return {
      ok: false,
      failedStep: "remote-daemon-unreachable",
      stdout,
      stderr,
      remoteExitCode: exitCode,
    };
  }
  return {
    ok: false,
    failedStep: "remote-command-failed",
    stdout,
    stderr,
    remoteExitCode: exitCode,
  };
}

const PERMISSION_GATE_PATTERNS = [
  /Permission denied/i,
  /Host key verification failed/i,
  /Keychain/i,
  /Could not request authentication agent/i,
  /no mutual signature algorithm/i,
];

// OPR.0.4.4.18：导出本函数，使 `rig file` 能用【同一】特征归类 rsync stderr
// （按架构裁决：单一分类来源——绝不复制第二份模式）。行为不变。
export function looksLikePermissionGate(stderr: string): boolean {
  return PERMISSION_GATE_PATTERNS.some((re) => re.test(stderr));
}

const DAEMON_UNREACHABLE_PATTERNS = [
  /Daemon not running/i,
  /Failed to fetch .* from daemon/i,
  /ECONNREFUSED.*localhost/i,
];

function looksLikeDaemonUnreachable(text: string): boolean {
  return DAEMON_UNREACHABLE_PATTERNS.some((re) => re.test(text));
}

/**
 * 单引号 shell 转义。把输入包在单引号里，并通过 `'\''`
 * 转义其中的单引号。可安全地作为单个参数传给远程 POSIX shell。
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
