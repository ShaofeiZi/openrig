// Slice-17 mini-req 7 — 裸 rig 前门（创始人，架构强化）。
//
// 裸 `rig`（无参数）打开 TUI，k9s 风格，TTY 感知：
//   - 守卫同时检查 stdin 和 stdout 的 isTTY——任一管道/重定向意味着
//     有脚本参与，因此前门不拥有调用，走正常 commander 用法路径
//     （打印用法，快速退出，绝不挂起——`echo x | rig` 不得阻塞）；
//   - 第一印象降级：transport、cwd/读取、命令/PATH 和强制执行保持
//     不同的类型化轴；TUI 初始化失败保持简洁；
//   - `--help`、`--version` 和每个子命令都是参数，因此它们自然
//     被排除在裸调用之外，行为不变。
import { BUILD_INFO } from "./build-info.js";
import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  DaemonClient,
  DaemonConnectionError,
  DaemonResponseError,
  DaemonTimeoutError,
} from "./client.js";

interface FrontDoorPermissionDiagnostic {
  transport: { state: "healthy" | "connect" | "timeout" | "response"; detail?: string };
  cwdRead: { state: "visible" | "denied" | "unknown" };
  commandPath: { state: "available" | "missing" | "unknown" };
  enforcement: {
    axis: "permission" | "sandbox" | "resource_trust" | "not_applicable";
    state: "aligned" | "drift" | "unknown";
    expected: string | null;
    effective: string | { defaultMode: string } | null;
    sourcePath: string | null;
    reason?: string;
  };
  observedAt: string;
}

export type FrontDoorProbeResult =
  | { state: "ready" }
  | { state: "diagnostic"; diagnostic: FrontDoorPermissionDiagnostic };

type LegacyTransportProbeResult = { state: "connect" | "timeout" | "response"; message: string };

interface FrontDoorProbeClient {
  get(path: string, options?: { timeoutMs?: number }): Promise<{ status: number; data: unknown }>;
}

function transportDiagnostic(state: "connect" | "timeout" | "response", detail?: string): FrontDoorPermissionDiagnostic {
  return {
    transport: { state, ...(detail ? { detail } : {}) },
    cwdRead: { state: "unknown" },
    commandPath: { state: "unknown" },
    enforcement: {
      axis: "not_applicable",
      state: "unknown",
      expected: null,
      effective: null,
      sourcePath: null,
      reason: "transport_unavailable",
    },
    observedAt: new Date().toISOString(),
  };
}

/** Monorepo 优先、打包回退的 TUI 入口解析——与 resolveDaemonPath 完全相同的模式
 *  （见 daemon-lifecycle.ts）：开发检出的 `packages/tui/dist` 是真相来源；
 *  npm 安装布局在 cli 旁边附带打包副本。null = 未找到（调用方降级）。 */
export function resolveTuiPath(baseDir: string, exists: (p: string) => boolean = existsSync): string | null {
  const cliBaseDir = path.basename(baseDir) === "commands" ? path.resolve(baseDir, "..") : baseDir;
  const monorepo = path.join(path.resolve(cliBaseDir, "../../tui"), "dist/main.js");
  if (exists(monorepo)) return monorepo;
  const bundled = path.join(path.resolve(cliBaseDir, "../tui"), "dist/main.js");
  if (exists(bundled)) return bundled;
  return null;
}

export const USAGE_LINES = [
  "zrig — 中文控制平面",
  "",
  "  zrig              打开任务控制中心（仅交互式终端）",
  "  zrig tui          打开任务控制中心（裸 `zrig` 的显式别名）",
  "  zrig --help       完整命令列表",
  "  zrig up <rig>     启动工作组",
  "  zrig ps           列出活跃席位",
];

export interface FrontDoorIo {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
  exit?: (code: number) => void;
  /** 类型化的后台服务/当前席位探测（遗留布尔值仍接受，用于注入调用方）。 */
  probeDaemon?: () => Promise<boolean | FrontDoorProbeResult | LegacyTransportProbeResult>;
  /** 启动 TUI，并以其退出码完成 Promise。 */
  launchTui?: () => Promise<number>;
}

function envValue(env: NodeJS.ProcessEnv, current: string, legacy: string): string | undefined {
  return env[current]?.trim() || env[legacy]?.trim() || undefined;
}

/**
 * 受管席位请求严格的当前席位诊断。非受管 shell
 * 保持廉价的仅健康路径。传输类别保持不同。
 */
export async function probeFrontDoor(input: {
  client?: FrontDoorProbeClient;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<FrontDoorProbeResult> {
  const client = input.client ?? new DaemonClient(undefined, { timeoutMs: 1500 });
  const env = input.env ?? process.env;
  const nodeId = envValue(env, "OPENRIG_NODE_ID", "RIGGED_NODE_ID");
  const sessionName = envValue(env, "OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
  const identityQuery = nodeId
    ? `nodeId=${encodeURIComponent(nodeId)}`
    : sessionName
      ? `sessionName=${encodeURIComponent(sessionName)}`
      : null;
  const path = identityQuery
    ? `/api/whoami?${identityQuery}&compact=1&diagnostics=permission`
    : "/healthz";
  try {
    const res = await client.get(path, { timeoutMs: 1500 });
    if (res.status < 200 || res.status >= 300) {
      return { state: "diagnostic", diagnostic: transportDiagnostic("response", `后台服务返回 HTTP ${res.status}`) };
    }
    if (!identityQuery) return { state: "ready" };
    const identity = (res.data as { identity?: { runtime?: string; agentRef?: string } } | null)?.identity;
    // 基础设施终端没有要诊断的 harness 权限配置。
    // 这允许 TUI；它不会重新标记未知诊断。
    if (identity?.runtime === "terminal" && identity.agentRef === "builtin:terminal") return { state: "ready" };
    const diagnostic = (res.data as { permissionDrift?: FrontDoorPermissionDiagnostic } | null)?.permissionDrift;
    if (!diagnostic) {
      return { state: "diagnostic", diagnostic: transportDiagnostic("response", "后台服务响应省略了权限诊断") };
    }
    if (
      diagnostic.transport.state === "healthy"
      && diagnostic.cwdRead.state === "visible"
      && diagnostic.commandPath.state === "available"
      && diagnostic.enforcement.state === "aligned"
    ) {
      return { state: "ready" };
    }
    return { state: "diagnostic", diagnostic };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof DaemonTimeoutError) return { state: "diagnostic", diagnostic: transportDiagnostic("timeout", detail) };
    if (error instanceof DaemonResponseError) return { state: "diagnostic", diagnostic: transportDiagnostic("response", detail) };
    if (error instanceof DaemonConnectionError) return { state: "diagnostic", diagnostic: transportDiagnostic("connect", detail) };
    return { state: "diagnostic", diagnostic: transportDiagnostic("response", detail) };
  }
}

function normalizeProbe(result: boolean | FrontDoorProbeResult | LegacyTransportProbeResult): FrontDoorProbeResult {
  if (result === true) return { state: "ready" };
  if (result === false) return { state: "diagnostic", diagnostic: transportDiagnostic("connect", "无法连接到 zrig 后台服务") };
  switch (result.state) {
    case "ready":
    case "diagnostic":
      return result;
    case "connect":
    case "timeout":
    case "response":
      return { state: "diagnostic", diagnostic: transportDiagnostic(result.state, result.message) };
  }
}

function renderDiagnostic(diagnostic: FrontDoorPermissionDiagnostic): string {
  const label = diagnostic.enforcement.axis === "resource_trust"
    ? "resource trust"
    : diagnostic.enforcement.axis;
  const effective = typeof diagnostic.enforcement.effective === "object" && diagnostic.enforcement.effective !== null
    ? diagnostic.enforcement.effective.defaultMode
    : diagnostic.enforcement.effective;
  const parts = [
    `transport: ${diagnostic.transport.state}`,
    `cwd/read: ${diagnostic.cwdRead.state}`,
    `command/PATH: ${diagnostic.commandPath.state}`,
    `${label}: ${diagnostic.enforcement.state.toUpperCase()}`,
  ];
  if (diagnostic.transport.detail) parts.push(`detail=${diagnostic.transport.detail}`);
  if (diagnostic.enforcement.expected) parts.push(`expected=${diagnostic.enforcement.expected}`);
  if (effective) parts.push(`effective=${effective}`);
  if (diagnostic.enforcement.sourcePath) parts.push(`source=${diagnostic.enforcement.sourcePath}`);
  if (diagnostic.enforcement.reason) parts.push(`reason=${diagnostic.enforcement.reason}`);
  return parts.join(" · ");
}

function diagnosticVerdict(diagnostic: FrontDoorPermissionDiagnostic): string {
  if (diagnostic.transport.state !== "healthy") return `TRANSPORT_${diagnostic.transport.state.toUpperCase()}`;
  if (diagnostic.cwdRead.state !== "visible") return `CWD_READ_${diagnostic.cwdRead.state.toUpperCase()}`;
  if (diagnostic.commandPath.state !== "available") return `COMMAND_PATH_${diagnostic.commandPath.state.toUpperCase()}`;
  if (diagnostic.enforcement.state === "drift") return "PERMISSION_DRIFT";
  return "UNKNOWN_EFFECTIVE";
}

async function defaultLaunchTui(): Promise<number> {
  const entry = resolveTuiPath(import.meta.dirname);
  if (!entry) throw new Error("任务控制 TUI 未安装（此 CLI 旁边没有 tui/dist/main.js）");
  return await new Promise<number>((resolve, reject) => {
    const sharedKernel = envValue(process.env, "OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME") === "operator-human@kernel";
    const child = spawn(process.execPath, [entry, ...(sharedKernel ? ["--instance", "kernel"] : [])], { stdio: "inherit", env: { ...process.env,
      OPENRIG_URL: new DaemonClient().baseUrl,
      OPENRIG_TUI_CLI_ENTRY: path.join(import.meta.dirname, "bin-wrapper.js"),
      OPENRIG_TUI_CLI_IDENTITY: `${BUILD_INFO.semver ?? "version unstamped"} · ${BUILD_INFO.commit ?? "commit unstamped"}${BUILD_INFO.dirty === true ? " · dirty" : ""}` } });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

/**
 * 拥有的任务控制路径，提取出来使 `rig tui` 成为裸 `rig` 所做事情的真正别名
 * （不是镜像）：探测后台服务，然后要么启动 TUI 并以其代码退出，
 * 要么打印友好的第一印象降级。由 runFrontDoor（裸 `rig`）和
 * `tui` 子命令共享——一个启动路径，无重复。
 */
export async function openMissionControl(io: FrontDoorIo = {}): Promise<void> {
  const err = io.err ?? ((l: string) => process.stderr.write(l + "\n"));
  const exit = io.exit ?? ((c: number) => process.exit(c));
  const probe = io.probeDaemon ?? probeFrontDoor;
  const launch = io.launchTui ?? defaultLaunchTui;

  const probeResult = normalizeProbe(await probe());
  // 后台服务宕机/不可达状态正是故障诊断 TUI 要渲染的——后台服务宕机时裸
  // `rig` 必须到达驾驶舱，而不是退出（BLOCKER 1：否则整个指挥器从其
  // 入口点不可达）。因此当 transport 不健康时（connect → 宕机，
  // timeout → 未验证），启动 TUI：它自己的 `rig crash-cart --json` 探测
  // 做出诚实的已确认宕机 vs 未验证区分，并渲染驾驶舱或无法验证屏幕。
  // 带有健康 transport 的诊断（后台服务已启动但 cwd/命令/权限漂移）通常是
  // 真正的第一印象降级——保持简洁诊断 + 退出。狭窄例外是
  // Codex 沙箱观察间隙：命名配置文件刻意保持未解析，已采用的
  // 代次可能短暂没有启动观察。两者都不是漂移的证据，在缺失证据上阻塞
  // 只读控制平面会使 TUI 从健康受管席位不可达。保持每个已证明或设置派生的
  // 强制执行问题不启动。
  const launchObservationGap = probeResult.state === "diagnostic"
    && probeResult.diagnostic.transport.state === "healthy"
    && probeResult.diagnostic.cwdRead.state === "visible"
    && probeResult.diagnostic.commandPath.state === "available"
    && probeResult.diagnostic.enforcement.axis === "sandbox"
    && probeResult.diagnostic.enforcement.state === "unknown"
    && (
      probeResult.diagnostic.enforcement.reason === "named_profile_unresolved"
      || probeResult.diagnostic.enforcement.reason === "applied_launch_unknown"
    );
  const shouldLaunchTui =
    probeResult.state === "ready"
    || (probeResult.state === "diagnostic" && probeResult.diagnostic.transport.state !== "healthy")
    || launchObservationGap;
  if (!shouldLaunchTui) {
    for (const line of USAGE_LINES) err(line);
    err("");
    err(`运行时姿态：${diagnosticVerdict(probeResult.diagnostic)}`);
    err(renderDiagnostic(probeResult.diagnostic));
    exit(1);
    return;
  }
  try {
    const code = await launch();
    exit(code);
  } catch (e) {
    // 第一印象降级：消息，绝不堆栈
    for (const line of USAGE_LINES) err(line);
    err("");
    err(`任务控制中心无法启动：${e instanceof Error ? e.message : String(e)}`);
    exit(1);
  }
}

/**
 * 当前门拥有调用时返回 true（TUI 已启动或降级消息已打印 + 请求退出）；
 * false 则穿透到正常 commander 程序（有参数或非 TTY 流）。
 */
export async function runFrontDoor(argv: readonly string[], io: FrontDoorIo = {}): Promise<boolean> {
  if (argv.length > 2) return false; // 任何参数 → 正常 CLI，不变
  const stdinIsTTY = io.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = io.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdinIsTTY || !stdoutIsTTY) return false; // 有脚本参与 → 用法路径，快速退出

  await openMissionControl(io);
  return true;
}
