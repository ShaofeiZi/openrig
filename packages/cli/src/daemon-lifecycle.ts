import path from "node:path";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import type { DaemonStartLock } from "./daemon-start-lock.js";
import { DAEMON_STOP_WAIT_MS, DAEMON_SHUTDOWN_RECEIPT, type DaemonShutdownReceipt } from "@openrig/daemon/daemon-shutdown";
import { ConfigStore } from "./config-store.js";
import { readLocalOrigin } from "./local-origin.js";
import { OPENRIG_HOME, LEGACY_RIGGED_HOME, readOpenRigEnv } from "./openrig-compat.js";
import {
  ensureDefaultWorkspace,
  ensureOpenRigInstance,
  formatInstanceInitializationConflicts,
  type InitializationFsOps,
  type InitWorkspaceResult,
  type ManagedPathKind,
} from "@openrig/daemon/instance-initialization";

export interface DaemonState {
  pid: number;
  port: number;
  host?: string;
  db: string;
  startedAt: string;
}

/**
 * OPR.0.4.3.21——从增强后的 `/healthz` 正文读取事件循环卡死证据。仅当后台服务
 * 实际回答 healthz 且接入监视器时存在；healthz 超时时缺失，因为卡死的事件循环无法响应，
 * 此时证据为 `reason: "unresponsive"`。
 */
export interface DaemonEventLoopEvidence {
  lagMeanMs: number;
  lagP99Ms: number;
  utilization: number;
  lastTickAgeMs: number;
  healthy: boolean;
}

export interface DaemonStatus {
  /** 裁定 1ae863d2——C3 三态语义（规范实现为 daemon crash-cart-detect.ts，保持同步）：
   *  `stopped` 必须有正向证据（连接被拒绝）；探针超时或其他非拒绝故障均为 `unverified`，
   *  绝不能据此断言后台服务已停止。 */
  state: "running" | "stopped" | "stale" | "unverified";
  /** home 解析诚实性：解析出的 home 缺少后台服务状态，但存在活跃同级 home（或
   *  HOME-MOVED 标记）时设置。调用方必须同时列出两个路径，绝不能断言服务已停止。 */
  siblingHint?: { resolvedHome: string; siblingHome: string };
  port?: number;
  host?: string;
  pid?: number;
  healthy?: boolean;
  /**
   * OPR.0.4.3.21——进程存活且正在监听但不健康的原因。`unresponsive` 表示进程仍在，
   * 但 `/healthz` 超时，是事件循环卡死的诚实信号；`event-loop-starved` 表示 healthz
   * 有响应，但循环延迟/最后 tick 证据越过阈值。健康时缺失。
   */
  reason?: "unresponsive" | "event-loop-starved";
  /** OPR.0.4.3.21——healthz 由监视器回答时的事件循环证据。 */
  eventLoop?: DaemonEventLoopEvidence;
}

export interface GetDaemonStatusOptions {
  /** 观察者可禁用清理；只有匹配的干净关闭才允许移除状态。 */
  cleanupStaleState?: boolean;
}

/** 从状态构建后台服务 HTTP URL；优先用持久化主机，默认使用 127.0.0.1。 */
export function getDaemonUrl(status: DaemonStatus): string {
  return `http://${status.host ?? DEFAULT_HOST}:${status.port}`;
}

/**
 * OPR.0.3.3.04.2（AC-4）：依赖后台服务的流程命令（bootstrap / discover /
 * workspace / workflow）共用的唯一诚实“后台服务未运行”错误。它沿用仓库的
 * “事实 / 后果 / 操作”三段式约定（commands/archive.ts、commands/queue.ts），
 * 让新操作者旅程中的后台服务依赖体验一致，而不是四个相互分叉的裸死路。范围只限于
 * 后台服务未运行路径，不是通用错误框架；后者应是独立切片。
 */
export interface DaemonNotRunningError {
  fact: string;
  consequence: string;
  action: string;
}

export function daemonNotRunningError(): DaemonNotRunningError {
  return {
    fact: "后台服务未运行。",
    consequence: "此命令需要一个正在运行的后台服务。",
    action: "运行 'zrig up'（它会自动启动后台服务），或 'zrig daemon start'。",
  };
}

/**
 * 打印共享的“后台服务未运行”错误并设置失败退出码。传入 `{ json: true }` 时，使用
 * 面向智能体的 `{ error: { fact, consequence, action } }` 包装，与
 * commands/queue.ts 的 JSON 输出一致。
 */

/** B8-1b（形态 73ee4b25）——与认知状态匹配的守卫消息：措辞由探针已知事实决定。
 *  UNVERIFIED/unhealthy 表示“未响应”（停止不等于繁忙）；stopped/stale 表示明确未运行。
 *  保持纯函数，使所有界面共用。 */
export function statusGuardMessage(status: DaemonStatus): DaemonNotRunningError {
  if (status.state === "stopped" || status.state === "stale") {
    return daemonNotRunningError();
  }
  // unverified，或 running-but-unhealthy：我们【不】知道它已宕。
  return {
    fact: "后台服务未响应——它可能繁忙或已停止（状态未经确认）。",
    consequence: "此命令需要一个可响应的后台服务；继续执行的结果将不确定。",
    action: "用 'zrig daemon status' 重新检查。若确认已停止，运行 'zrig up' 或 'zrig daemon start'。",
  };
}

/** B8-1b——唯一预检关口。后台服务运行且健康时返回 true；否则打印与认知状态匹配的
 *  三段式错误，并在存在时附加错误 home 的同级实例提示，设置退出码 1 后返回 false。
 *  取代约 55 处手写且逐字重复的守卫。 */
export function daemonStatusGuard(status: DaemonStatus, opts?: { json?: boolean }): boolean {
  if (status.state === "running" && status.healthy !== false) return true;
  const err = statusGuardMessage(status);
  if (opts?.json) {
    console.log(JSON.stringify({ error: err }));
  } else {
    console.error(`错误： ${err.fact}`);
    console.error(`  ${err.consequence}`);
    console.error(`  ${err.action}`);
  }
  if (status.siblingHint) {
    console.error(`  注意：OPENRIG_HOME 可能有误——解析为 ${status.siblingHint.resolvedHome}，而线上兄弟实例是 ${status.siblingHint.siblingHome}`);
  }
  process.exitCode = 1;
  return false;
}

export function printDaemonNotRunning(opts?: { json?: boolean }): void {
  const err = daemonNotRunningError();
  if (opts?.json) {
    console.log(JSON.stringify({ error: err }));
  } else {
    console.error(`错误： ${err.fact}`);
    console.error(`  ${err.consequence}`);
    console.error(`  ${err.action}`);
  }
  process.exitCode = 1;
}

export interface StartOptions {
  port?: number;
  host?: string;
  db?: string;
  transcriptsEnabled?: boolean;
  transcriptsPath?: string;
  /** 设置后，后台服务启动会幂等地确保默认工作区存在。 */
  workspaceRoot?: string;
  contextRoot?: string;
  skillsRoot?: string;
  topologyRoot?: string;
  // V1 预发布 CLI/daemon 第 1 项——capture-pane 轮转调节项。传入后台服务进程环境，
  // 使轮转 hook 能读取 ConfigStore 文件值，而不只读取 shell 环境。
  transcriptsLines?: number;
  transcriptsPollIntervalSeconds?: number;
  // V0.3.1 slice 05 kernel-rig-as-default——为 true 时，后台服务启动跳过 kernel 自动启动
  // 路径（不实体化 kernel 工作组）。CLI 以 `rig daemon start --no-kernel` 暴露，
  // 并作为 OPENRIG_NO_KERNEL 投影到后台服务进程环境。
  skipKernelBoot?: boolean;
}

export interface LifecycleDeps {
  /** startDaemon 必需；只读生命周期消费者不需要启动能力。 */
  acquireStartLock?: () => DaemonStartLock;
  spawn: (cmd: string, args: string[], opts: {
    env: Record<string, string>;
    stdio: unknown;
    detached: boolean;
  }) => ChildProcess;
  // OPR.0.4.3.21——可选 `json` 让 getDaemonStatus 读取增强后的 /healthz 正文
  //（事件循环证据）。保持可选，使返回 `{ ok }` 的现有 mock 不变；生产 realDeps 会提供它。
  fetch: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>;
  kill: (pid: number, signal: string) => boolean;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  removeFile: (path: string) => void;
  exists: (path: string) => boolean;
  mkdirp: (path: string) => void;
  /** 加法初始化使用的精确生产路径类型。未覆盖冲突的测试可省略并使用旧 exists 接缝。 */
  pathKind?: (path: string) => ManagedPathKind;
  openForAppend: (path: string) => number;
  closeFile?: (fd: number) => void;
  isProcessAlive: (pid: number) => boolean;
  // OPR.0.4.2.1——状态探针有界稳定/重试的可选注入延迟。生产默认使用真实 setTimeout；
  // 测试传入空操作以保持快速。保持可选，避免影响现有依赖、mock 和调用方。
  sleep?: (ms: number) => Promise<void>;
  // 裁定 1ae863d2——home 解析诚实性的可选依赖（保持可选以免影响现有 mock/调用方）：
  // homeDir 覆盖模块加载时的 OPENRIG_DIR，用于扫描同级 home；listDir 列目录
  //（生产为 fs.readdirSync）。
  homeDir?: string;
  listDir?: (path: string) => string[];
}

export const OPENRIG_DIR = OPENRIG_HOME;
export const RIGGED_DIR = OPENRIG_DIR;
export const STATE_FILE = path.join(OPENRIG_DIR, "daemon.json");
export const LOG_FILE = path.join(OPENRIG_DIR, "daemon.log");
export const LEGACY_STATE_FILE = path.join(LEGACY_RIGGED_HOME, "daemon.json");
export const LEGACY_LOG_FILE = path.join(LEGACY_RIGGED_HOME, "daemon.log");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7433;
const DEFAULT_DB = "openrig.sqlite";
// 全新 Linux 主机加载原生模块、执行启动对账并绑定 healthz，可能比已预热开发机更久。
// 保持重试循环有界，但不要在首次启动的余量期内杀死健康后台服务。
const HEALTHZ_RETRIES = 80;
const HEALTHZ_DELAY_MS = 250;
// OPR.0.4.7 slice-05 第 4 项：整个状态健康探针必须位于一个普通 CLI 请求窗口内
//（约 5 秒，与 DaemonClient.timeoutMs 一致）。即时连接错误可在该期限内重试，但每次
// 重试绝不重新分配期限。这样，缓慢但有响应的 /healthz（如 400ms）会被观察到，而不会
// 被误报为 stopped；真实连接拒绝仍会在窗口内失败并得到 stopped。
const STATUS_PROBE_DEADLINE_MS = 5000;
// OPR.0.4.2.1——状态探针有界稳定：单次 /healthz 获取可能撞上重启后的监听器绑定窗口
//（进程已启动但尚未接受连接）。getDaemonStatus 以短退避做严格有界的重试，使状态反映
// /healthz 的实际答案。它只作用于状态探针，不改变 start/stop/checkPid 时序。真实停止时的
// 最坏额外延迟有界为 (ATTEMPTS-1)*DELAY + 单次超时，绝不无限挂起。
const STATUS_PROBE_MAX_ATTEMPTS = 5;
const STATUS_PROBE_RETRY_DELAY_MS = 200;
// 不走状态稳定路径的单次调用方使用的逐探针 /healthz 超时：checkPid 分类、start/stop
// 恢复守卫，以及 startDaemon 自身 HEALTHZ_RETRIES 轮询的每次迭代。它们保留原有固定边界
// 时序（上方稳定期限只用于状态探针），恢复被移除的 HEALTHZ_PROBE_TIMEOUT_MS 曾提供的超时。
const HEALTHZ_PROBE_TIMEOUT_MS = 250;

export type WorkspaceScaffoldResult = InitWorkspaceResult;

const INITIALIZATION_FILE_NAMES = new Set(["config.json", "SPEC.md", "project.yaml", "workspace.yaml", ".gitignore"]);

function lifecycleInitializationFs(deps: LifecycleDeps): InitializationFsOps {
  return {
    pathKind: deps.pathKind ?? ((candidate) => {
      if (!deps.exists(candidate)) return "missing";
      return INITIALIZATION_FILE_NAMES.has(path.basename(candidate)) ? "file" : "directory";
    }),
    mkdirp: deps.mkdirp,
    writeFile: deps.writeFile,
  };
}

export function ensureWorkspaceScaffold(root: string, deps: LifecycleDeps): WorkspaceScaffoldResult {
  return ensureDefaultWorkspace({ root, fs: lifecycleInitializationFs(deps) });
}

class HealthProbeTimeoutError extends Error {
  constructor(url: string) {
    super(`healthz probe timed out for ${url}`);
    this.name = "HealthProbeTimeoutError";
  }
}

function summarizeDaemonStartFailure(healthzUrl: string, logContent: string | null): string {
  const generic = `后台服务启动失败：${healthzUrl} 处的 healthz 未响应`;
  const lines = (logContent ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return generic;

  const recentLines = lines.slice(-20);
  const recentBlock = recentLines.join("\n");

  if (/ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(recentBlock)) {
    const moduleName = /better[-_]?sqlite3/i.test(recentBlock) ? "better-sqlite3" : "后台服务的原生模块";
    const detail = recentLines.find((line) => /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(line))
      ?? recentLines[recentLines.length - 1]!;
    return [
      `后台服务在 Node ${process.version}（${process.execPath}）下启动失败。`,
      `${moduleName} 无法加载，因为它的原生二进制与当前 Node 运行时不匹配。`,
      `最近的后台服务日志：${detail}`,
      "修复：切回安装 @openrig/cli 时所用的 Node 版本，或在当前 node 下重装 @openrig/cli，然后重试 `zrig daemon start`。",
    ].join(" ");
  }

  const detail = [...recentLines].reverse().find((line) => /error|ERR_|failed|exception|cannot|disk full/i.test(line))
    ?? recentLines[recentLines.length - 1]!;
  return `${generic}。最近的后台服务日志：${detail}`;
}

export function resolveCliBaseDir(baseDir: string): string {
  return path.basename(baseDir) === "commands" ? path.resolve(baseDir, "..") : baseDir;
}

/**
 * 纯解析器：存在 monorepo 源时优先使用它（开发检出中 `packages/daemon/dist` 是
 * 事实来源），否则回退到 `packages/cli/daemon` 中的打包/内置副本（npm 安装布局）。
 *
 * 使用此顺序的原因：monorepo 开发检出中两个路径同时存在：
 *   - packages/daemon/dist                ← 由下列命令刷新：
 *                                            `npm run build --workspace
 *                                            @openrig/daemon`（频繁执行；事实来源）
 *   - packages/cli/daemon/dist            ← 只由下列脚本刷新：
 *                                            `scripts/build-package.sh`
 *                                            （较少执行；用于 npm 发布）
 *
 * 若像旧顺序那样优先选择内置副本，开发者重建 `@openrig/daemon` 却未重跑
 * `build-package.sh` 时，`rig daemon start` 会运行过期后台服务。这曾掩盖一个事实：
 * 本地 main 55e01f2e 的 QA 实际拿到的后台服务缺少已交付的 slice-09
 * `/api/rig-mode/*` 路由（qitem-20260518054224）。
 *
 * npm 安装布局中不存在 `packages/daemon/dist`，只有位于 CLI 旁的
 * `packages/cli/daemon` 内置副本；回退逻辑保持该场景不变。
 */
export function resolveDaemonPath(baseDir: string, exists: (p: string) => boolean): string {
  const cliBaseDir = resolveCliBaseDir(baseDir);
  const monorepo = path.resolve(cliBaseDir, "../../daemon");
  if (exists(path.join(monorepo, "dist/index.js"))) return monorepo;
  const bundled = path.resolve(cliBaseDir, "../daemon");
  if (exists(path.join(bundled, "dist/index.js"))) return bundled;
  // 最后回退：返回 monorepo 路径，使调用方得到有意义的错误而不是因 undefined 崩溃。
  // 调用方会在其他位置（doctor / start）校验是否存在，并展示“在 <path> 找不到 daemon dist”。
  return monorepo;
}

export function getDaemonPath(): string {
  return resolveDaemonPath(import.meta.dirname, existsSync);
}

function readState(deps: LifecycleDeps): DaemonState | null {
  const stateFile = resolveLifecycleFile(deps, "daemon.json");
  if (!deps.exists(stateFile)) return null;
  const raw = deps.readFile(stateFile);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DaemonState;
  } catch {
    // daemon.json 畸形——当作无状态处理
    console.error("警告：daemon.json 格式错误；目标身份不可用");
    return null;
  }
}

function resolveLifecycleFile(deps: LifecycleDeps, filename: "daemon.json" | "daemon.log"): string {
  const primary = filename === "daemon.json" ? STATE_FILE : LOG_FILE;
  if (deps.exists(primary)) return primary;

  const legacy = filename === "daemon.json" ? LEGACY_STATE_FILE : LEGACY_LOG_FILE;
  if (deps.exists(legacy)) return legacy;

  return primary;
}

/** 检查 PID 是否为 OpenRig 后台服务。返回值：
 *  - `openrig`——healthz 有响应（无论 ok 与否），说明这是本后台服务；
 *  - `not_openrig`——连接被拒绝，PID 存活但未监听本端口；
 *  - `unresponsive`——PID 存活但 healthz 探针超时；
 *  - `dead`——PID 不存活。 */
async function checkPid(state: DaemonState, deps: LifecycleDeps): Promise<"openrig" | "not_openrig" | "unresponsive" | "dead"> {
  if (!deps.isProcessAlive(state.pid)) return "dead";
  const host = state.host ?? DEFAULT_HOST;
  try {
    await fetchDaemonProbe(deps, `http://${host}:${state.port}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
    // 任何响应（无论 ok 与否）都表示有进程监听本端口，即 OpenRig。
    return "openrig";
  } catch (err) {
    if (err instanceof HealthProbeTimeoutError) return "unresponsive";
    // 连接被拒绝：PID 存活，但不是本后台服务。
    return "not_openrig";
  }
}

function resolveConfiguredDaemonTarget(): { host: string; port: number } {
  try {
    const config = new ConfigStore().resolve();
    return {
      host: config.daemon.host,
      port: config.daemon.port,
    };
  } catch {
    return {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
    };
  }
}

/**
 * 清理清单：不应从操作者 shell 转发到后台服务进程的环境变量前缀和精确名称。
 * 这些终端模拟器、GUI 会话和 cmux 会话变量可能在后台服务分离运行时破坏适配器初始化。
 */
const ENV_SCRUB_PREFIXES = ["CODEX_", "GHOSTTY_", "XPC_", "__CF"];
// S20（OPR.0.5.5.20）——路由重载变量：托管环境可能注入客户端/端点状态，其字节形态
// 与操作者选择加入无法区分。这些变量始终从后台服务环境中清理；绑定意图只通过专用的
// OPENRIG_BIND_HOST 传递（当 opts.host 声明时在下方导出）。未来修改透传规则时：任何同时
// 充当客户端路由状态的环境变量都必须加入此集合。路由状态静默变成绑定策略正是事故类型
//（操作者 baton qitem-20260827070400：父进程丢失 Tailscale 监听器）。
const ROUTING_ENV_SCRUB = new Set(["OPENRIG_HOST", "RIGGED_HOST"]);

const ENV_SCRUB_EXACT = new Set([
  "CMUX_SOCKET_PATH",
  "CMUX_SURFACE_ID",
  "CMUX_WORKSPACE",
  "COLORTERM",
  "COMMAND_MODE",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERMINFO",
]);

export function buildDaemonEnv(
  baseEnv: Record<string, string>,
  opts: {
    port: number;
    /**
     * 操作者显式指定的绑定主机。为 undefined 时，CLI 表示“操作者未选择加入”，使后台服务
     * index.ts 落入默认 loopback + tailscale 自动多绑定路径（缺陷修复切片
     * auth-bearer-tailscale-trust）。已定义时，后台服务走显式主机分支并应用 bearer 不变量。
     * S20：为 undefined 时不存在环境回退。继承的 OPENRIG_HOST/RIGGED_HOST 是路由状态，
     * 由 ROUTING_ENV_SCRUB 清理；shell 级选择加入的前提已经失效，因为注入的路由环境与
     * 选择加入在字节上无法区分。专用 OPENRIG_BIND_HOST 是唯一环境选择入口并允许透传。
     */
    host?: string;
    db: string;
    transcriptsEnabled?: boolean;
    transcriptsPath?: string;
    // V1 预发布 CLI/daemon 第 1 项——从 ConfigStore 投影，使轮转 hook 采用文件中
    // 存储的值，而不只采用继承的 shell 环境。
    transcriptsLines?: number;
    transcriptsPollIntervalSeconds?: number;
    // V0.3.1 slice 05——通过 OPENRIG_NO_KERNEL 环境变量投影，使后台服务
    // startup.ts 的 kernel 启动路径遵守该标志。
    skipKernelBoot?: boolean;
  },
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (ENV_SCRUB_EXACT.has(key)) continue;
    if (ROUTING_ENV_SCRUB.has(key)) continue; // S20：路由环境永不跨越边界，见集合契约。
    // CODEX_HOME 是后台服务拓扑/配置根状态；其他 CODEX_* 值仍是瞬时运行时、认证或
    // 会话状态，继续清理。
    if (key !== "CODEX_HOME" && ENV_SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  // 显式 OPENRIG_* 覆盖值始终优先于继承值。
  env["OPENRIG_PORT"] = String(opts.port);
  if (opts.host !== undefined) {
    // S20——已声明意图导出专用绑定界面和一致的路由值，使席位/消费者路由到后台服务
    // 实际绑定的位置。
    env["OPENRIG_BIND_HOST"] = opts.host;
    env["OPENRIG_HOST"] = opts.host;
  }
  env["OPENRIG_DB"] = opts.db;
  if (opts.transcriptsEnabled !== undefined) {
    env["OPENRIG_TRANSCRIPTS_ENABLED"] = String(opts.transcriptsEnabled);
  }
  if (opts.transcriptsPath) {
    env["OPENRIG_TRANSCRIPTS_PATH"] = opts.transcriptsPath;
  }
  if (opts.transcriptsLines !== undefined) {
    env["OPENRIG_TRANSCRIPTS_LINES"] = String(opts.transcriptsLines);
  }
  if (opts.transcriptsPollIntervalSeconds !== undefined) {
    env["OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"] = String(opts.transcriptsPollIntervalSeconds);
  }
  if (opts.skipKernelBoot) {
    env["OPENRIG_NO_KERNEL"] = "1";
  }

  return env;
}

// ── OPR.0.5.5.20——绑定意图来源与监听器接纳闸门（S20 RED：尚未接线）──

/** 只从专用界面解析操作者绑定意图：--host 标志、从文件读取的 daemon.host 配置键，
 *  或专用 OPENRIG_BIND_HOST 环境变量。由环境解析出的 daemon.host 属于重载路由通道
 * （ENV_MAP 将 daemon.host 映射自 OPENRIG_HOST），绝不构成意图。 */
export function resolveBindIntent(input: {
  flagHost: string | undefined;
  envBindHost: string | undefined;
  configSource: string;
  configHost: string;
}): { explicit: boolean; host: string | undefined } {
  if (input.flagHost !== undefined) return { explicit: true, host: input.flagHost };
  const envBind = input.envBindHost?.trim() || undefined;
  if (envBind) return { explicit: true, host: envBind };
  if (input.configSource === "file") return { explicit: true, host: input.configHost };
  // 来源为 `env` 的 daemon.host 是重载路由通道，不代表意图；`default` 则完全没有声明。
  return { explicit: false, host: undefined };
}

/** 恢复后的接纳/升级闸门：根据后台服务报告的实际绑定模式派生必需监听器集合
 *（default 表示 loopback 加已检测到的 tailscale；explicit 表示恰好为声明主机），
 * 并逐个探测自身 /healthz 来证明。以绑定证据为准，绝不相信配置回显。静默丢失监听器
 *（0.5.3 receipt 回归形态）会明确失败。 */
export async function verifyRequiredListeners(input: {
  bind: { mode: "explicit" | "default"; hosts: string[]; tailscaleDetected: boolean };
  port: number;
  /** 三态探针（r2 修复）：`healthy`、`unhealthy`、`indeterminate`。连接被拒绝或显式
   *  不健康是绑定错误的正向证据；瞬时探针异常属于 indeterminate，绝不变成监听器缺失证据。 */
  probe: (url: string) => Promise<"healthy" | "unhealthy" | "indeterminate">;
}): Promise<
  | { ok: true; verified: string[] }
  | { ok: false; missing: string[]; reason: string }
  | { ok: "indeterminate"; reason: string }
> {
  const required = new Set(input.bind.hosts);
  required.add("127.0.0.1"); // 除 explicit 外，每种模式的下限都要求 loopback。
  if (input.bind.mode === "explicit") {
    required.clear();
    for (const h of input.bind.hosts) required.add(h);
  } else if (input.bind.tailscaleDetected && input.bind.hosts.length < 2) {
    // 0.5.3-receipt 回归形态：默认模式、存在 tailscale，但后台服务只报告一个监听器，
    // 表示 tailscale 监听器被静默丢弃。
    return {
      ok: false,
      missing: ["<tailscale interface>"],
      reason:
        `缺少必需监听器：检测到 tailscale 接口时，默认绑定模式必须同时绑定 loopback 和 tailscale，但后台服务仅报告 [${input.bind.hosts.join(", ")}]；有监听器被静默丢弃（0.5.3 回执回归形态）。`,
    };
  }
  const missing: string[] = [];
  const verified: string[] = [];
  const indeterminate: string[] = [];
  for (const host of required) {
    // 此处不做 catch 合并（r2 发现）：探针自行分类错误；到达此处的异常是接线缺陷，
    // 应直接暴露，不能转换。
    const outcome = await input.probe(`http://${host}:${input.port}/healthz`);
    if (outcome === "healthy") verified.push(host);
    else if (outcome === "unhealthy") missing.push(host);
    else indeterminate.push(host);
  }
  if (indeterminate.length > 0) {
    // indeterminate 的优先级高于 missing：只要有任一监听器无法验证，闸门就没有完整
    // 证据集，不能授权终止进程。
    return {
      ok: "indeterminate",
      reason: `无法检查 ${indeterminate.join(", ")} 的监听器状态（瞬时探测失败）；守卫只依据肯定证据行动，本次不执行操作。`,
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason: `必需监听器未响应 /healthz：${missing.join(", ")}；绑定证据优先于配置回显，已报告主机必须自证。`,
    };
  }
  return { ok: true, verified };
}

class StartupIdentityError extends Error {}
class StartupChildPendingError extends Error {}

export async function startDaemon(opts: StartOptions, deps: LifecycleDeps): Promise<DaemonState> {
  if (!deps.acquireStartLock) throw new Error("启动后台服务需要先取得本地启动预约");
  const lock = deps.acquireStartLock();
  let preserve = false;
  try {
    return await startOwnedDaemon(opts, deps, lock);
  } catch (error) {
    preserve = error instanceof StartupChildPendingError;
    throw error;
  } finally {
    lock.release(preserve);
  }
}

async function startOwnedDaemon(opts: StartOptions, deps: LifecycleDeps, lock: DaemonStartLock): Promise<DaemonState> {
  const port = opts.port ?? DEFAULT_PORT;
  const db = opts.db ?? DEFAULT_DB;
  // 缺陷修复切片 auth-bearer-tailscale-trust：保留“用户显式指定”和“使用默认值”的区别。
  // 操作者从未选择加入时 `opts.host` 为 undefined；此时 healthz 探针仍使用默认 loopback，
  // 但 buildDaemonEnv 绝不能导出 OPENRIG_HOST，使后台服务落入多绑定默认路径
  //（loopback 加 Tailscale 自动检测）。
  const explicitHost = opts.host;
  const probeHost = explicitHost ?? DEFAULT_HOST;

  // 检查是否已在运行。
  const existing = readState(deps);
  if (existing) {
    const pidState = await checkPid(existing, deps);
    if (pidState === "openrig") {
      // 我们自己的后台服务正在运行（可能不健康，但在我们的端口上活着）
      throw new Error(`后台服务已在运行（pid ${existing.pid}，端口 ${existing.port}）`);
    }
    if (pidState === "unresponsive") {
      throw new Error(`既有后台服务进程（pid ${existing.pid}，端口 ${existing.port}）无响应——请先恢复它，再启动新的后台服务。`);
    }
    // "dead" 或 "not_rigged" → 陈旧状态，可安全继续
  } else {
    let recoveredRunning = false;
    try {
      await fetchDaemonProbe(deps, `http://${probeHost}:${port}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
      recoveredRunning = true;
    } catch (err) {
      if (err instanceof HealthProbeTimeoutError) {
        throw new Error(`端口 ${port} 上的后台服务无响应，且缺少后台服务状态——请先恢复它，再启动新的后台服务。`);
      }
    }
    if (recoveredRunning) {
      throw new Error(`后台服务已在端口 ${port} 上运行，但缺少后台服务状态`);
    }
  }
  const daemonEntry = path.join(getDaemonPath(), "dist/index.js");

  const initialization = ensureOpenRigInstance({
    home: OPENRIG_DIR,
    workspaceRoot: opts.workspaceRoot,
    contextRoot: opts.contextRoot,
    skillsRoot: opts.skillsRoot,
    topologyRoot: opts.topologyRoot,
    fs: lifecycleInitializationFs(deps),
  });
  if (!initialization.ok) {
    throw new Error(`zrig 实例初始化被阻止：${formatInstanceInitializationConflicts(initialization)}`);
  }

  const logFd = deps.openForAppend(LOG_FILE);

  let child: ChildProcess;
  try {
    child = deps.spawn(process.execPath, [daemonEntry], {
    env: buildDaemonEnv(process.env as Record<string, string>, {
      port,
      host: explicitHost,
      db,
      transcriptsEnabled: opts.transcriptsEnabled,
      transcriptsPath: opts.transcriptsPath,
      transcriptsLines: opts.transcriptsLines,
      transcriptsPollIntervalSeconds: opts.transcriptsPollIntervalSeconds,
      skipKernelBoot: opts.skipKernelBoot,
    }),
    stdio: ["ignore", logFd, logFd],
    detached: true,
    });
  } finally { deps.closeFile?.(logFd); }

  let childFailure: Error | undefined;
  let rejectExit!: (error: Error) => void;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const failed = new Promise<never>((_, reject) => { rejectExit = reject; });
  // 错误可能在同步发布/清理期间、两个 await 之间到达。
  void failed.catch(() => {});
  const onError = (error: Error): void => {
    childFailure = new Error(`后台服务子进程启动失败：${error.message}`);
    rejectExit(childFailure);
  };
  const onExit = (code: number | null, signal: string | null): void => {
    childFailure = new Error(`后台服务子进程 ${child.pid ?? "unknown"} 在启动完成前退出（code ${code}，signal ${signal ?? "none"}）`);
    rejectExit(childFailure);
    resolveExit();
  };
  child.once("error", onError);
  child.once("exit", onExit);
  child.unref();
  const pid = child.pid;
  const hasExited = (): boolean => child.exitCode != null || child.signalCode != null;
  const assertChild = (): void => {
    if (childFailure) throw childFailure;
    if (!Number.isSafeInteger(pid) || pid! <= 0) throw new Error("启动后台服务后未返回有效的子进程 PID");
    if (hasExited()) throw new Error(`后台服务子进程 ${pid} 在启动完成前退出`);
  };
  const healthzUrl = `http://${probeHost}:${port}/healthz`;
  type StartHealth = { pid?: unknown; bind?: { mode: "explicit" | "default"; hosts: string[]; tailscaleDetected: boolean } };
  const readOwnedHealth = async (url: string): Promise<StartHealth | null> => {
    assertChild();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        failed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HealthProbeTimeoutError(url)), HEALTHZ_PROBE_TIMEOUT_MS);
        }),
        (async () => {
          const res = await deps.fetch(url);
          if (!res.ok) return null;
          let body: StartHealth | null;
          try { body = res.json ? await res.json() as StartHealth : null; }
          catch { throw new StartupIdentityError(`在 ${url} 处无法获取后台服务启动身份：期望子进程 PID ${pid}；健康响应无效`); }
          if (body?.pid !== pid) {
            throw new StartupIdentityError(`在 ${url} 处后台服务启动身份不匹配：期望子进程 PID ${pid}，实际观测到 ${typeof body?.pid === "number" ? body.pid : "unknown"}；状态未发布`);
          }
          assertChild();
          return body;
        })(),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    assertChild();
    lock.recordChild(pid!);
    let healthy = false;
    let lastProbe = "健康端点未响应";
    for (let i = 0; i < HEALTHZ_RETRIES; i++) {
      try {
        const body = await readOwnedHealth(healthzUrl);
        if (body) {
          const bind = body.bind;
          if (!bind || !["explicit", "default"].includes(bind.mode) || !Array.isArray(bind.hosts)
            || bind.hosts.length === 0 || !bind.hosts.every((host) => typeof host === "string" && host.length > 0)
            || typeof bind.tailscaleDetected !== "boolean") {
            throw new StartupIdentityError(`子进程 PID ${pid} 的后台服务启动监听者身份不可用；状态未发布`);
          }
          const gate = await verifyRequiredListeners({ bind, port, probe: async (url) => {
            try { return await readOwnedHealth(url) ? "healthy" : "unhealthy"; }
            catch (error) {
              if (error instanceof StartupIdentityError || childFailure) throw error;
              const code = (error as { code?: string; cause?: { code?: string } }).code
                ?? (error as { cause?: { code?: string } }).cause?.code;
              return code === "ECONNREFUSED" ? "unhealthy" : "indeterminate";
            }
          } });
          if (gate.ok === false) throw new StartupIdentityError(`后台服务子进程 ${pid} 未通过监听者接纳闸门：${gate.reason}`);
          if (gate.ok === true) { healthy = true; break; }
          lastProbe = gate.reason;
        }
      } catch (error) {
        assertChild();
        if (error instanceof StartupIdentityError) throw error;
        lastProbe = error instanceof Error ? error.message : String(error);
      }
      await Promise.race([new Promise((resolve) => setTimeout(resolve, HEALTHZ_DELAY_MS)), failed]);
    }
    if (!healthy) {
      throw new Error(`${summarizeDaemonStartFailure(healthzUrl, deps.readFile(resolveLifecycleFile(deps, "daemon.log")))}。最后一次探测：${lastProbe}`);
    }
    assertChild();
    if (!deps.isProcessAlive(pid!)) throw new Error(`无法确认后台服务子进程 ${pid} 的存活；状态未发布`);
    const state: DaemonState = { pid: pid!, port, host: probeHost, db, startedAt: new Date().toISOString() };
    try {
      deps.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      assertChild();
      // 同步写入器可能比进程存活更久，而退出事件尚未投递。发布后重新检查物理证据。
      if (!deps.isProcessAlive(pid!)) throw new Error(`在状态发布时无法确认后台服务子进程 ${pid} 的存活；未接受本次启动`);
    } catch (error) {
      removeMatchingState(deps, STATE_FILE, state);
      throw error;
    }
    return state;
  } catch (error) {
    // 只能清理本次启动的子进程。保留子进程时也保留预约，防止重试再次运行预绑定初始化。
    // ps 失败不是进程退出证据。该进程是本次尚未回收的子进程：只向该 PID 发信号，
    // 并且只有观察到它自身退出后才释放排他权。
    if (Number.isSafeInteger(pid) && pid! > 0 && !hasExited()) {
      try { deps.kill(pid!, "SIGTERM"); } catch { /* confirm exit below */ }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const gone = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), DAEMON_STOP_WAIT_MS); }),
        ]);
        if (!gone) throw new StartupChildPendingError(`${error instanceof Error ? error.message : error}。子进程 PID ${pid} 的退出未确认；保留启动预约。恢复前请检查 daemon-start.lock 与 daemon.log。`);
      } finally { if (timer) clearTimeout(timer); }
    }
    throw error;
  } finally {
    // 没有 PID 的原生 spawn 失败会在下一轮发出错误。
    if (pid !== undefined || childFailure) child.off("error", onError);
    child.off("exit", onExit);
  }
}

function readShutdownReceipt(deps: LifecycleDeps, stateFile: string) {
  const receiptPath = path.join(path.dirname(stateFile), DAEMON_SHUTDOWN_RECEIPT);
  const raw = deps.readFile(receiptPath);
  let receipt: DaemonShutdownReceipt | undefined;
  try { receipt = JSON.parse(raw ?? "null") ?? undefined; } catch { /* unavailable */ }
  if (receipt?.schema !== "openrig.daemon-shutdown/v1" || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0
    || !Number.isFinite(Date.parse(receipt.startedAt)) || !(Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt))
    || !(Date.parse(receipt.completedAt) <= Date.now()) || typeof receipt.phase !== "string"
    || !Array.isArray(receipt.failures) || !["clean", "failed", "timed-out"].includes(receipt.outcome)) receipt = undefined;
  return { receipt, present: raw !== null || deps.exists(receiptPath), receiptPath };
}

function receiptMatchesState(receipt: DaemonShutdownReceipt | undefined, state: DaemonState, notBefore = Date.parse(state.startedAt)): boolean {
  return receipt?.pid === state.pid && Date.parse(receipt.startedAt) >= notBefore;
}

function isCleanShutdown(receipt: DaemonShutdownReceipt | undefined): boolean {
  return receipt?.outcome === "clean" && receipt.phase === "complete" && receipt.failures.length === 0;
}

function removeMatchingState(deps: LifecycleDeps, stateFile: string, state: DaemonState): void {
  // 并发启动/重新绑定的状态不能被旧 stop/status 操作移除。
  const current = readState(deps);
  if (current?.pid === state.pid && current.startedAt === state.startedAt && current.port === state.port
    && current.host === state.host && current.db === state.db) deps.removeFile(stateFile);
}

export async function stopDaemon(deps: LifecycleDeps): Promise<"stopped" | "no-target"> {
  const state = readState(deps);
  const configured = resolveConfiguredDaemonTarget();
  const explicitUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
  const stateUrl = state ? `http://${state.host ?? DEFAULT_HOST}:${state.port}` : undefined;
  const target = stateUrl ?? explicitUrl?.replace(/\/+$/, "") ?? `http://${configured.host}:${configured.port}`;
  if (stateUrl && explicitUrl && new URL(explicitUrl).origin !== new URL(stateUrl).origin) {
    throw new Error(`无法安全停止：寻址的 ${explicitUrl}/healthz 与本地 PID ${state!.pid} 在 ${stateUrl}/healthz 处不一致；未发送任何信号。`);
  }
  const check = `${target}/healthz`;
  const listener = async (): Promise<"responding" | "refused" | "unavailable"> => {
    try {
      await fetchDaemonProbe(deps, check, HEALTHZ_PROBE_TIMEOUT_MS);
      return "responding";
    } catch (error) {
      return isRefusedError(error) ? "refused" : "unavailable";
    }
  };
  if (!state) {
    const effect = await listener();
    const sibling = findSiblingHome(deps);
    if (effect !== "refused" || sibling) {
      throw new Error(`后台服务状态缺失——无法安全停止。已检查 ${check}；监听者 ${effect}。` +
        (sibling ? ` 解析出的 home ${sibling.resolvedHome}；线上兄弟实例 ${sibling.siblingHome}。` : ""));
    }
    const stateFile = resolveLifecycleFile(deps, "daemon.json");
    if (deps.exists(stateFile)) {
      throw new Error(`后台服务目标状态不可读；drain 完成情况无法核实。已检查 ${check}；监听者拒绝；未发送信号。请检查 ${stateFile}。`);
    }
    const prior = readShutdownReceipt(deps, stateFile);
    if (prior.present && !isCleanShutdown(prior.receipt)) {
      throw new Error(`drain 完成情况无法核实：存在本地关闭证据，但没有记录目标状态；无法把它归因到 ${target}。已检查 ${check}；监听者拒绝。请检查 ${prior.receiptPath}。`);
    }
    // 没有目标不算“干净 drain”结论，包括在更早一次干净停止之后。
    return "no-target";
  }
  const stateFile = resolveLifecycleFile(deps, "daemon.json");

  const pidState = await checkPid(state, deps);
  if (pidState === "not_openrig") {
    throw new Error(`无法安全停止：PID ${state.pid} 存在，但在 ${check} 处身份未确认；未发送信号，状态已保留。`);
  }

  let notBefore = Date.parse(state.startedAt);
  if (pidState !== "dead") {
    notBefore = Date.now();
    deps.kill(state.pid, "SIGTERM");
    // 只发一个信号；目标若已退出，则直接进入相同判定。
    const deadline = Date.now() + DAEMON_STOP_WAIT_MS;
    while (deps.isProcessAlive(state.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const present = deps.isProcessAlive(state.pid);
  const effect = await listener();
  const observation = `目标 ${target}；已检查 ${check}；PID ${state.pid} ${present ? "存在" : "已消失"}；监听者 ${effect}`;
  if (present) {
    throw new Error(`后台服务在 SIGTERM 后 ${DAEMON_STOP_WAIT_MS}ms 内未退出；${observation}` +
      (effect === "responding" ? "（仍在监听）" : "") + "；状态文件已保留。");
  }
  if (effect !== "refused") throw new Error(`后台服务停止结果未获核实：${observation}；状态已保留。`);

  const { receipt, receiptPath } = readShutdownReceipt(deps, stateFile);
  if (!receiptMatchesState(receipt, state, notBefore)) {
    throw new Error(`后台服务进程已停止；${observation}；drain 完成情况未获核实（没有匹配的关闭回执）；状态已保留。请检查 ${path.join(path.dirname(stateFile), "daemon.log")}。`);
  }
  if (!isCleanShutdown(receipt)) {
    throw new Error(`后台服务已停止但关闭不完整：${receipt!.outcome}；phase=${receipt!.phase}；${observation}。待生效项未获核实；状态已保留；请检查 ${receiptPath}。`);
  }
  removeMatchingState(deps, stateFile, state);
  return "stopped";
}

/** 裁定 1ae863d2——正向停止证据分类器，与后台服务 crash-cart-detect 语义同步。
 * 只有连接被拒绝才是强停止证据；超时、中止或其他错误都不能证明后台服务已死。 */
function isRefusedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  const code = (err as Error & { code?: string }).code;
  return cause?.code === "ECONNREFUSED" || code === "ECONNREFUSED" || /refused/i.test(err.message);
}

/** 裁定 1ae863d2——尽力检测错误 home：先查解析 home 中的 HOME-MOVED 标记，否则查找
 * 相邻且活跃的 `.openrig*` home（daemon.json 中 PID 存活）。永不抛错；扫描失败只是不提供提示。 */
function findSiblingHome(deps: LifecycleDeps): DaemonStatus["siblingHint"] {
  try {
    const home = deps.homeDir ?? OPENRIG_DIR;
    const marker = path.join(home, "HOME-MOVED");
    if (deps.exists(marker)) {
      const target = deps.readFile(marker)?.trim();
      if (target) return { resolvedHome: home, siblingHome: target };
    }
    if (!deps.listDir) return undefined;
    const parent = path.dirname(home);
    const self = path.basename(home);
    for (const entry of deps.listDir(parent)) {
      if (!entry.startsWith(".openrig") || entry === self) continue;
      const sibling = path.join(parent, entry);
      const stateFile = path.join(sibling, "daemon.json");
      if (!deps.exists(stateFile)) continue;
      const raw = deps.readFile(stateFile);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { pid?: number };
        if (typeof parsed.pid === "number" && deps.isProcessAlive(parsed.pid)) {
          return { resolvedHome: home, siblingHome: sibling };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // 仅尽力检查。
  }
  return undefined;
}

export async function getDaemonStatus(
  deps: LifecycleDeps,
  options: GetDaemonStatusOptions = {},
): Promise<DaemonStatus> {
  // 设置 OPENRIG_URL 时绕过 daemon.json，直接探测该 URL。
  const openrigUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
  if (openrigUrl) {
    try {
      const res = await probeHealthzWithSettle(deps, `${openrigUrl}/healthz`);
      const ev = await readHealthEvidence(res);
      const url = new URL(openrigUrl);
      return { state: "running", port: Number(url.port) || DEFAULT_PORT, host: url.hostname || DEFAULT_HOST, healthy: ev.healthy, reason: ev.reason, eventLoop: ev.eventLoop };
    } catch (err) {
      // 1ae863d2：拒绝连接表示明确停止；超时/卡死等其他情况均为未验证。
      return isRefusedError(err) ? { state: "stopped" } : { state: "unverified" };
    }
  }

  const state = readState(deps);
  if (!state) {
    const configured = resolveConfiguredDaemonTarget();
    try {
      const res = await probeHealthzWithSettle(deps, `http://${configured.host}:${configured.port}/healthz`);
      const ev = await readHealthEvidence(res);
      return {
        state: "running",
        port: configured.port,
        host: configured.host,
        healthy: ev.healthy,
        reason: ev.reason,
        eventLoop: ev.eventLoop,
      };
    } catch (err) {
      // 1ae863d2：解析出的 home 没有后台服务状态。断言前先查找活跃同级 home 或
      // HOME-MOVED 标记，即错误 home 类别。
      const siblingHint = findSiblingHome(deps);
      if (siblingHint) return { state: "unverified", siblingHint };
      return isRefusedError(err) ? { state: "stopped" } : { state: "unverified" };
    }
  }

  if (!deps.isProcessAlive(state.pid)) {
    // 状态读取不能擦除判断停止失败所需的身份。
    const stateFile = resolveLifecycleFile(deps, "daemon.json");
    const { receipt } = readShutdownReceipt(deps, stateFile);
    if (options.cleanupStaleState !== false && receiptMatchesState(receipt, state) && isCleanShutdown(receipt)) {
      removeMatchingState(deps, stateFile, state);
    }
    return { state: "stale" };
  }

  // 进程存活，继续检查 healthz。
  const host = state.host ?? DEFAULT_HOST;
  let healthy = false;
  let reason: DaemonStatus["reason"];
  let eventLoop: DaemonEventLoopEvidence | undefined;
  try {
    const res = await probeHealthzWithSettle(deps, `http://${host}:${state.port}/healthz`);
    const ev = await readHealthEvidence(res);
    healthy = ev.healthy;
    reason = ev.reason;
    eventLoop = ev.eventLoop;
  } catch {
    // OPR.0.4.3.21——PID 存活但 healthz 超时：这是诚实的事件循环卡死信号。报告
    // “进程存在但不健康”而非 `stopped`，并使用 `unresponsive` 原因，使操作者明确
    // 出问题的是控制平面。
    reason = "unresponsive";
  }

  // PID 存活即为 running；无论健康与否都保留状态文件。
  return { state: "running", port: state.port, host, pid: state.pid, healthy, reason, eventLoop };
}

export function readLogs(deps: LifecycleDeps): string | null {
  const logFile = resolveLifecycleFile(deps, "daemon.log");
  if (!deps.exists(logFile)) return null;
  return deps.readFile(logFile);
}

export function tailLogs(deps: LifecycleDeps, opts: { follow: boolean }): void {
  const logFile = resolveLifecycleFile(deps, "daemon.log");
  if (!deps.exists(logFile)) return;

  const args = opts.follow ? ["-f", logFile] : [logFile];
  const child = deps.spawn("tail", args, {
    env: process.env as Record<string, string>,
    stdio: "inherit" as unknown,
    detached: false,
  });
  child.unref();
}

/**
 * OPR.0.4.3.21——从 healthz 探针结果读取事件循环卡死证据。普通 `{ ok: true }`
 *（mock 或未接监视器的后台服务）表示健康且无证据。增强正文携带 `eventLoop` 块时，
 * 采用其中的 `healthy` 判定；仍能回答 healthz 的饥饿事件循环会报告“进程存在但不健康”，
 * 并附带循环延迟证据。
 */
async function readHealthEvidence(
  res: { ok: boolean; json?: () => Promise<unknown> },
): Promise<{ healthy: boolean; reason?: DaemonStatus["reason"]; eventLoop?: DaemonEventLoopEvidence }> {
  if (!res.ok) return { healthy: false };
  if (!res.json) return { healthy: true };
  try {
    const body = (await res.json()) as { eventLoop?: Partial<DaemonEventLoopEvidence> } | null;
    const el = body?.eventLoop;
    if (el && typeof el.healthy === "boolean" && typeof el.lagMeanMs === "number") {
      const eventLoop: DaemonEventLoopEvidence = {
        lagMeanMs: el.lagMeanMs,
        lagP99Ms: typeof el.lagP99Ms === "number" ? el.lagP99Ms : 0,
        utilization: typeof el.utilization === "number" ? el.utilization : 0,
        lastTickAgeMs: typeof el.lastTickAgeMs === "number" ? el.lastTickAgeMs : 0,
        healthy: el.healthy,
      };
      return el.healthy
        ? { healthy: true, eventLoop }
        : { healthy: false, reason: "event-loop-starved", eventLoop };
    }
  } catch {
    // 正文缺失或不是 JSON：按普通健康处理（res.ok 已为 true）。
  }
  return { healthy: true };
}

async function fetchDaemonProbe(deps: LifecycleDeps, url: string, timeoutMs: number): Promise<{ ok: boolean; json?: () => Promise<unknown> }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      deps.fetch(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HealthProbeTimeoutError(url)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 51-09 增量 3——尽力从 `/healthz` 读取后台服务启动对账后的自身主机 ID，供 CLI 直发
 * 边使用（`From:` 三元组与回复提示自剥离）。身份来源只有一个（附加条件 b）：读取后台服务
 * 暴露的同一 `/healthz` 字段，并使用 send 已解析的同一本地后台服务 `url`，绝无第二条
 * 解析路径。受现有 `HEALTHZ_PROBE_TIMEOUT_MS` 约束，只用一种超时约定，不新增旋钮。
 * C1 开放失败：任何错误、超时或字段缺失都返回 undefined；绝不抛错、不形成后台服务硬依赖，
 * 也不为普通 send 路径引入新失败模式，信封只继续渲染当前的二段形式。
 */
export async function fetchSelfHostId(deps: LifecycleDeps, url: string): Promise<string | undefined> {
  try {
    const base = url.replace(/\/+$/, "");
    const res = await fetchDaemonProbe(deps, `${base}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
    if (!res.ok || !res.json) return undefined;
    const body = (await res.json()) as { selfHostId?: unknown } | null;
    const id = body?.selfHostId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 返回本机自身身份及其来源，供必须在跨机器消息失败前明确展示状态的界面使用。与
 * `fetchSelfHostId` 使用同一开放失败契约：后台服务不可达时返回 undefined，而不引入新失败模式。
 */
export async function fetchSelfHostIdentity(
  deps: LifecycleDeps,
  url: string,
): Promise<{ selfHostId: string; selfHostIdSource?: string } | undefined> {
  try {
    const base = url.replace(/\/+$/, "");
    const res = await fetchDaemonProbe(deps, `${base}/healthz`, HEALTHZ_PROBE_TIMEOUT_MS);
    if (!res.ok || !res.json) return undefined;
    const body = (await res.json()) as { selfHostId?: unknown; selfHostIdSource?: unknown } | null;
    const id = body?.selfHostId;
    if (typeof id !== "string" || id.length === 0) return undefined;
    const source = body?.selfHostIdSource;
    return {
      selfHostId: id,
      ...(typeof source === "string" && source.length > 0 ? { selfHostIdSource: source } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 即使发生故障也解析本实例持久化的身份；绝不从目标端读取。 */
export async function resolveOriginSelfHostId(_deps: LifecycleDeps): Promise<string | undefined> {
  return readLocalOrigin();
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * OPR.0.4.2.1——围绕 fetchDaemonProbe 的状态探针本地有界稳定/重试。单次 /healthz
 * 获取可能撞上重启后的监听器绑定窗口（进程已启动但尚未接受连接），从而产生虚假的
 * down/unhealthy。以短退避进行严格有界的重试，使状态探针反映 /healthz 的实际答案。
 * 构造上有界：真实停止时没有响应，每次尝试都失败，最终错误重新抛出并报告为
 * stopped/unhealthy，绝不掩盖、绝不无限等待。只供 getDaemonStatus 使用；start/stop/checkPid
 * 保持各自时序，start 已有自己的轮询循环。
 */
async function probeHealthzWithSettle(deps: LifecycleDeps, url: string): Promise<{ ok: boolean; json?: () => Promise<unknown> }> {
  const sleep = deps.sleep ?? defaultSleep;
  // 整个状态探针共用一个约 5 秒期限。每次尝试只获得剩余预算，绝不重新分配 5 秒，
  // 因而缓慢但有响应的 /healthz 会在窗口内被观察到。探针超时表示期限已耗尽，立即停止，
  // 不重新分配；只有即时连接错误（重启后绑定窗口）才重试，并同时受尝试次数和期限限制。
  // 真实连接拒绝会耗尽有界重试并重新抛出，报告为 stopped/unhealthy，绝不掩盖。
  const deadline = Date.now() + STATUS_PROBE_DEADLINE_MS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= STATUS_PROBE_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await fetchDaemonProbe(deps, url, remaining);
    } catch (err) {
      lastErr = err;
      if (err instanceof HealthProbeTimeoutError) break; // 期限已耗尽，不再分配新窗口。
      if (attempt < STATUS_PROBE_MAX_ATTEMPTS && Date.now() + STATUS_PROBE_RETRY_DELAY_MS < deadline) {
        await sleep(STATUS_PROBE_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

// V0.3.1 slice 05 kernel-rig-as-default——前向修复 #3 架构项。轮询
// GET /api/kernel/status，直到 kernel_state 进入 ready 或 partial_ready（两个
//“操作者可使用 kernel”的状态），或到达超时。供 `rig daemon start --wait-for-kernel` 使用。
//
// 成功时返回 { ok: true, ... }；失败时返回 { ok: false, ... }，并携带最后观察到的
// kernelState 与 detail，供 CLI 生成三段式错误。
export interface KernelReadyResult {
  ok: boolean;
  kernelState: string | null;
  variant: string | null;
  detail: string | null;
}

export async function waitForKernelReady(
  baseUrl: string,
  timeoutMs: number,
  pollIntervalMs = 500,
): Promise<KernelReadyResult> {
  const deadline = Date.now() + timeoutMs;
  let last: KernelReadyResult = { ok: false, kernelState: null, variant: null, detail: null };
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/kernel/status`);
      if (res.ok) {
        const body = (await res.json()) as {
          kernel_state?: string;
          variant?: string | null;
          detail?: string | null;
        };
        last = {
          ok: body.kernel_state === "ready" || body.kernel_state === "partial_ready",
          kernelState: body.kernel_state ?? null,
          variant: body.variant ?? null,
          detail: body.detail ?? null,
        };
        if (last.ok) return last;
        // 终态但未就绪时不再轮询。
        if (
          body.kernel_state === "auth_blocked" ||
          body.kernel_state === "spec_missing" ||
          body.kernel_state === "bootstrap_failed" ||
          body.kernel_state === "degraded" ||
          body.kernel_state === "skipped"
        ) {
          return last;
        }
      }
    } catch {
      // 瞬时获取失败；继续轮询直到截止时间。
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return last;
}
