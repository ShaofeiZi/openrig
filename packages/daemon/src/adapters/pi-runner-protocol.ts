// OPR.0.4.6.PI1——Pi runtime adapter、Pi resume adapter 与 pane 承载的 pi-runner 进程
// 之间共享的纯契约。
//
// 此处所有内容都无副作用（常量 + 字符串/argv/env 构建器 + runner-state sidecar 结构），
// 因此 runner 入口可以导入它，而不会把后台服务依赖带入 pane 进程；adapter/resume 测试也能
// 隔离断言命令构造。
//
// 契约摘要（PRD FR-2/FR-3/FR-5/FR-7）：
// - adapter 在席位的 tmux pane 内启动 `node <runnerEntry> …`。
// - runner 以席位范围的 PI_CODING_AGENT_DIR/PI_CODING_AGENT_SESSION_DIR 和默认拒绝的环境
//   allowlist（BR-3）启动 `pi --mode rpc`。
// - 每次托管启动都携带显式 trust 标志（BR-5）；环境中的 `ask` 在 RPC 模式下会静默跳过，
//   从不会询问。
// - runner 根据 RPC `get_state` 持久化 `runner-state.json`（sidecar），并向 pane 输出 READY
//   标记；后台服务只读取 runner 生成的界面，绝不使用 Pi TUI 启发式规则（BR-1）。

import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

// ── 席位状态布局 ────────────────────────────────────────────────────────────
// <stateRoot>/<sessionName>/agent     → PI_CODING_AGENT_DIR (auth.json, models.json, skills, …)
// <stateRoot>/<sessionName>/sessions  → PI_CODING_AGENT_SESSION_DIR（另有显式 --session-dir；标志优先）
// <stateRoot>/<sessionName>/runner-state.json → runner 的 session 身份 sidecar

export interface PiSeatPaths {
  seatRoot: string;
  agentDir: string;
  sessionsDir: string;
  runnerStatePath: string;
}

export function piSeatPaths(stateRoot: string, sessionName: string): PiSeatPaths {
  const seatRoot = nodePath.join(stateRoot, sessionName);
  return {
    seatRoot,
    agentDir: nodePath.join(seatRoot, "agent"),
    sessionsDir: nodePath.join(seatRoot, "sessions"),
    runnerStatePath: nodePath.join(seatRoot, "runner-state.json"),
  };
}

// ── Pane 标记（由 runner 生成；adapter 只查找这些标记，绝不判断 Pi UI）────────────

export const PI_RUNNER_READY_MARKER = "[pi-runner] READY";
export const PI_RUNNER_EXIT_MARKER = "[pi-runner] EXITED";
export const PI_RUNNER_ERROR_MARKER = "[pi-runner] ERROR";

// ── 运行器状态伴随文件 ─────────────────────────────────────────────────────

export interface PiRunnerState {
  ready: boolean;
  /** 启动尝试范围（守卫 fold，code-review qitem-20260707011908）：adapter 为每次尝试铸造
   * launchId，预写携带它的 pending sidecar，并将 --launch-id 传给 runner；runner 在每次
   * sidecar 写入时都盖上该值。Readiness/resume 轮询忽略 launchId 不同的所有状态；旧 runner
   * 实例的持久产物绝不能让新启动误绿，也不能因陈旧退出而误失败。 */
  launchId?: string;
  /** 来自 RPC get_state 的绝对 session 文件路径——resume token。 */
  sessionFile?: string;
  /** 来自 get_state 的 UUIDv7 session id——展示/回退元数据。 */
  sessionId?: string;
  /** 持久追赶游标：最后投影到 bus 的 session-entry id。 */
  lastEntryId?: string;
  /** 最近一次 sidecar 写入的 ISO 时间戳。 */
  updatedAt: string;
  /** pi 进程退出时设置；如实表示席位未运行。 */
  exited?: { code: number | null; at: string };
}

/** 每个写入方为新尝试重置 sidecar 时使用的启动范围 pending 记录。它有意携带之前的
 * lastEntryId：持久追赶游标（FR-5）必须跨陈旧产物重置保留；清除它会破坏 resume 时的
 * get_entries-since（守卫重新裁定，qitem-20260707013815）。旧记录中的其他所有内容正是重置
 * 要隔离掉的陈旧状态。 */
export function buildPendingRunnerState(
  launchId: string,
  updatedAt: string,
  prior: PiRunnerState | null,
): PiRunnerState {
  return {
    ready: false,
    launchId,
    lastEntryId: prior?.lastEntryId,
    updatedAt,
  };
}

export function parsePiRunnerState(raw: string): PiRunnerState | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    if (typeof state.ready !== "boolean" || typeof state.updatedAt !== "string") return null;
    return parsed as unknown as PiRunnerState;
  } catch {
    return null;
  }
}

// ── Provider 环境透传（BR-3/FR-7）────────────────────────────────────────────
// 默认拒绝：只有基础变量、托管身份/实例定位符和已声明 provider 的 key 可传入 Pi。扩展此映射
// 必须经过评审，绝不是便利性修改。自定义/本地 provider 改为通过席位托管的 models.json 配置 key
//（不从环境透传其变量）。

export const PI_PROVIDER_ENV_VARS: Record<string, string> = {
  // 只转发模型已声明 provider 的 API key。
  "openrouter": "OPENROUTER_API_KEY",
  "zai": "ZAI_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
};

// 进程基础需求。不包含主机凭据族或 shell 自定义。
export const PI_ENV_BASELINE_VARS = ["PATH", "HOME", "TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR"] as const;

// NodeLauncher 为 fresh 与 resumed 席位都提供身份和实例路由。Pi 的 shell 工具继承此子环境：
// 丢弃这些值会使普通 whoami/send/queue 解析为非托管调用方或另一个实例。也保留已提供的
// runtime/generation 与 legacy context-root 来源；绝不合成身份或转发任意 OPENRIG_* 设置/token。
const PI_ENV_OPENRIG_VARS = [
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION",
  "OPENRIG_HOME", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT", "OPENRIG_SHARED_DOCS_ROOT",
] as const;

/** Model 声明：Pi 接受 `--model provider/id`。provider 段（第一个 "/" 之前）选择要透传的
 * 环境变量（若有）。 */
export function providerFromModel(model: string | undefined): string | null {
  const trimmed = model?.trim() ?? "";
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null;
  return trimmed.slice(0, slash);
}

/** 为 pi 子进程构建默认拒绝的环境（BR-3）。`source` 是 runner 自身环境；只有 allowlist 中的
 * 名称能跨越边界。 */
export function buildPiChildEnv(
  source: Record<string, string | undefined>,
  opts: { agentDir: string; sessionsDir: string; model?: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...PI_ENV_BASELINE_VARS, ...PI_ENV_OPENRIG_VARS]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.PI_CODING_AGENT_DIR = opts.agentDir;
  env.PI_CODING_AGENT_SESSION_DIR = opts.sessionsDir;
  const provider = providerFromModel(opts.model);
  const providerVar = provider ? PI_PROVIDER_ENV_VARS[provider] : undefined;
  if (providerVar && source[providerVar] !== undefined) {
    env[providerVar] = source[providerVar]!;
  }
  return env;
}

// ── 命令构造 ─────────────────────────────────────────────────────────────────

export interface PiRunnerLaunchOpts {
  /** 已编译 runner 入口（daemon dist）的绝对路径。 */
  runnerEntryPath: string;
  /** 席位的 canonical session 名称（身份 + sidecar key）。 */
  sessionName: string;
  /** 席位状态根目录（piSeatPaths 从此 <stateRoot> 派生）。 */
  stateRoot: string;
  /** Pi session 的托管工作目录。 */
  cwd: string;
  /** 可选 `provider/id` model 声明（FR-7）。 */
  model?: string;
  /** 显式 trust 姿态——必需，绝不取环境默认值（BR-5）。 */
  trust: "approve" | "no-approve";
  /** 要 resume 的准确 session 文件（FR-6），与 forkRef 互斥。 */
  sessionFile?: string;
  /** 通过 CLI --fork 进行 fork 的来源 session 文件路径或 id（FR-6）。 */
  forkRef?: string;
  /** 盖在每次 runner sidecar 写入上的启动尝试范围。 */
  launchId: string;
}

/** 输入席位 tmux pane 的命令。边界之后的一切（pi spawn、env allowlist、RPC、mirror、sidecar）
 * 由 runner 所有。 */
export function buildPiRunnerCommand(opts: PiRunnerLaunchOpts): string {
  const parts = [
    "node",
    shellQuote(opts.runnerEntryPath),
    "--session-name", shellQuote(opts.sessionName),
    "--state-root", shellQuote(opts.stateRoot),
    "--cwd", shellQuote(opts.cwd),
    "--launch-id", shellQuote(opts.launchId),
    `--${opts.trust}`,
  ];
  if (opts.model?.trim()) {
    parts.push("--model", shellQuote(opts.model.trim()));
  }
  if (opts.sessionFile) {
    parts.push("--session", shellQuote(opts.sessionFile));
  }
  if (opts.forkRef) {
    parts.push("--fork", shellQuote(opts.forkRef));
  }
  return parts.join(" ");
}

/** RUNNER 启动的 `pi` 子进程 argv（argv 风格，不经过 shell）。根据 Pi 文档中的优先级，显式
 * `--session-dir` 优先于环境变量；两者都设置，使某一层回归时隔离仍然成立。 */
export function buildPiChildArgs(opts: {
  sessionsDir: string;
  sessionName: string;
  model?: string;
  trust: "approve" | "no-approve";
  sessionFile?: string;
  forkRef?: string;
}): string[] {
  const args = [
    "--mode", "rpc",
    "--session-dir", opts.sessionsDir,
    "--name", opts.sessionName,
    `--${opts.trust}`,
  ];
  if (opts.model?.trim()) {
    args.push("--model", opts.model.trim());
  }
  if (opts.sessionFile) {
    // 精确文件 resume——绝不使用 --resume（交互式选择器；托管路径中禁止，PRD FR-6）。
    args.push("--session", opts.sessionFile);
  } else if (opts.forkRef) {
    // 带 parentSession 链接的完整 session fork——使用 CLI --fork，而非 RPC fork
    //（后者按活跃 session 的 entryId 操作，是另一种操作）。
    args.push("--fork", opts.forkRef);
  }
  return args;
}
