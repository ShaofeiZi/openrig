// OPR.0.5.1.1——stub runtime adapter 与 pane 承载的 stub-runner 进程之间共享的纯契约
//（A5/ContextMonitor 收口）。
//
// 此处所有内容都无副作用（常量 + readiness sidecar 结构 + 字符串/argv 构建器），因此 pane
// 承载的 runner 入口可以导入，而不会把后台服务依赖带入 pane 进程；adapter 测试也能隔离断言
// 命令构造。镜像已验证的 pi-runner-protocol 形态（OPR.0.4.6.PI1）：带自调用守卫的 Pi 形
// node 脚本 runner。
//
// 契约摘要：
// - adapter 在席位的 tmux pane 内启动 `node <runnerEntry> …`。
// - runner 写入 readiness sidecar `<cwd>/.openrig/stub/state.json`，并向 pane 输出 READY
//   标记；后台服务只读取 runner 生成的 surface（sidecar）来判断 readiness，绝不使用 pane
//   启发式规则。
// - 第 4 步范围：runner 就绪并持久化 readiness sidecar。四个 seed 行为
//   {compaction, slow_output, mid_turn_death, restore} 与 ctx% context sidecar 在后续增量
//   （A5 第 5–8 项）落地。

import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

// ── Readiness sidecar 布局 ───────────────────────────────────────────────────
// <cwd>/.openrig/stub/state.json → runner 的 readiness sidecar（后台服务的权威活性来源；
// 不同于后续增量中由 ContextUsageStore 消费、位于 <OPENRIG_HOME>/context/ 下的 ctx%
// 上下文伴随文件）。

export const STUB_READINESS_SIDECAR_SUBPATH = nodePath.join(".openrig", "stub", "state.json");

/** 托管 cwd 为 `cwd` 的席位对应 readiness sidecar 的绝对路径。 */
export function stubSeatSidecarPath(cwd: string): string {
  return nodePath.join(cwd, STUB_READINESS_SIDECAR_SUBPATH);
}

// ── 场景解析出的行为脚本 ─────────────────────────────────────────────────────
// <cwd>/.openrig/stub/script.json → runner 执行的逐席位行为脚本（pane 输出 + hook/行为触发；
// PRD §4.2）。场景 harness（51-02）将其放入托管 cwd；独立 stub 席位没有该文件，runner 会
// 回退到内置 DEFAULT_STUB_SCRIPT。采用 cwd 约定而非启动标志，使启动命令在 fresh/resume
// 之间保持字节稳定。

export const STUB_SCRIPT_SUBPATH = nodePath.join(".openrig", "stub", "script.json");

/** 托管 cwd 为 `cwd` 的席位对应场景行为脚本的绝对路径
 *（缺失 = runner 使用 DEFAULT_STUB_SCRIPT）。 */
export function stubSeatScriptPath(cwd: string): string {
  return nodePath.join(cwd, STUB_SCRIPT_SUBPATH);
}

// ── Pane 标记（runner 生成；adapter 只查找这些标记，绝不判断 harness UI）────────

export const STUB_RUNNER_READY_MARKER = "[stub-runner] READY";
export const STUB_RUNNER_EXIT_MARKER = "[stub-runner] EXITED";
export const STUB_RUNNER_ERROR_MARKER = "[stub-runner] ERROR";

// ── Readiness sidecar 结构 ──────────────────────────────────────────────────

export interface StubRunnerState {
  /** runner 启动后为 true；后台服务的正向 readiness 信号。 */
  ready: boolean;
  /** 启动尝试范围（Pi 先例）：adapter 为每次尝试铸造 launchId 并传入 --launch-id；runner
   * 在每次 sidecar 写入时盖上该值，使旧 runner 实例的持久产物绝不能让新启动误绿。此字段
   * 可选，使最小手写 fixture 仍可解析。 */
  launchId?: string;
  /** stub 进程退出时设置；如实表示席位未运行。 */
  exited?: { code: number | null; at?: string };
  /** 最近一次 sidecar 写入的 ISO 时间戳（可选元数据）。 */
  updatedAt?: string;
}

/** 解析 readiness sidecar。只要求 `ready: boolean`（最小 `{"ready": true}` fixture 有效）；
 * 其他内容均为可选元数据。 */
export function parseStubRunnerState(raw: string): StubRunnerState | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    if (typeof state.ready !== "boolean") return null;
    return parsed as unknown as StubRunnerState;
  } catch {
    return null;
  }
}

// ── 命令构造 ─────────────────────────────────────────────────────────────────

export interface StubRunnerLaunchOpts {
  /** 已编译 runner 入口（daemon dist）的绝对路径。 */
  runnerEntryPath: string;
  /** 席位的 canonical session 名称（身份）。 */
  sessionName: string;
  /** 托管工作目录（readiness sidecar 根目录）。 */
  cwd: string;
  /** 盖在 runner sidecar 写入上的启动尝试范围。 */
  launchId: string;
  /** 席位已解析的启动姿态——在 fresh 与 resume 路径的命令中都可按字节观察
   *（floor 是可用性默认值）。 */
  posture: "floor" | "full_bypass";
  /** restore 路径使用的准确 resume token（之前的 session 标记）。 */
  resumeToken?: string;
}

/** 输入席位 tmux pane 的命令。边界之后的一切（sidecar 写入、行为模拟、mirror）由 runner 所有。 */
export function buildStubRunnerCommand(opts: StubRunnerLaunchOpts): string {
  const parts = [
    "node",
    shellQuote(opts.runnerEntryPath),
    "--session-name", shellQuote(opts.sessionName),
    "--cwd", shellQuote(opts.cwd),
    "--launch-id", shellQuote(opts.launchId),
    "--posture", shellQuote(opts.posture),
  ];
  if (opts.resumeToken) {
    parts.push("--session", shellQuote(opts.resumeToken));
  }
  return parts.join(" ");
}
