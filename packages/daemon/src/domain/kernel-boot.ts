// V0.3.1 切片 05 kernel-rig-as-default——kernel 自动启动路径。
//
// 按 IMPL-PRD §6.1 组合进 rig daemon 启动流程：探测 runtime 认证状态，选择一种变体
//（dual / claude-only / codex-only），然后在后台触发进程内 bootstrap 流程。
// 遇到以下情况时会直接安全返回：
//   - 设置了 OPENRIG_NO_KERNEL=1（操作方选择退出或测试 fixture）
//   - 数据库中已经存在名为 `kernel` 的受管 rig
//   - 两个 runtime 都未认证（终态 auth_blocked）
//   - 选定变体的 spec 文件缺失
//
// 前向修复 #3 的架构修订（IMPL-PRD §16 已修订）：不等待 bootstrap Promise，而是立即
// 返回 KernelBootTracker，让 createDaemon 可以结束、server.ts 可以绑定 healthz。因此，
// 异常的 kernel agent 不再阻塞 daemon HTTP surface 启动；操作方看到的是
//“daemon 已就绪；kernel <state>”，而不是“daemon 启动失败”。

import nodePath from "node:path";
import { existsSync } from "node:fs";
import type { RigRepository } from "./rig-repository.js";
import type { BootstrapOrchestrator } from "./bootstrap-orchestrator.js";
import type { EventBus } from "./event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import { KernelBootTracker } from "./kernel-boot-tracker.js";

export type RuntimeAuthStatus = "ok" | "unavailable";

export interface RuntimeProbeResult {
  claudeCode: RuntimeAuthStatus;
  codex: RuntimeAuthStatus;
}

export interface KernelBootDeps {
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  bootstrapOrchestrator: BootstrapOrchestrator;
  /** daemon specs 目录的绝对路径。参数化后测试可以注入 fixture 根目录；生产调用点解析到
   *  随包发布的 `packages/daemon/specs/` 位置。 */
  specsDir: string;
  /** 传给 BootstrapOrchestrator.bootstrap 的 cwdOverride。Kernel 成员应在操作方环境而非
   *  daemon 安装树中运行；没有该覆盖时，bootstrap 路径会以“cwd 位于 zrig 安装目录内”为由
   *  拒绝。生产调用点传入解析后的 workspace.root 设置，测试则注入 fixture 路径。 */
  cwdOverride: string;
  /** Runtime 认证探针——默认执行真实 shell 命令，测试会注入替代实现。 */
  probeRuntimes?: () => Promise<RuntimeProbeResult>;
  /** 日志接收器；默认使用 console.log/warn，使 daemon stdout/stderr 携带启动轨迹。 */
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** degraded timer 覆盖值（毫秒）。前向修复 #3 默认为 90 秒；测试传入较小值以快速覆盖
   *  timer 路径。 */
  degradedTimeoutMs?: number;
}

/** 入口点。此函数具有幂等性，每次 daemon 启动时调用都是安全的。它会立即返回 tracker，
 *  bootstrap（若触发）则在后台运行。调用方不应等待 tracker 内部的 bootstrap Promise，
 *  这正是架构解耦的目的。可通过 getStatus() 和 /api/kernel/status 路由观察 tracker 状态。 */
export async function bootKernelIfNeeded(deps: KernelBootDeps): Promise<KernelBootTracker> {
  const log = deps.log ?? defaultLog;
  const tracker = new KernelBootTracker({
    eventBus: deps.eventBus,
    sessionRegistry: deps.sessionRegistry,
    rigRepo: deps.rigRepo,
    degradedTimeoutMs: deps.degradedTimeoutMs,
  });

  // 1. 通过 --no-kernel 选择退出（CLI flag 映射为 OPENRIG_NO_KERNEL）。
  // VITEST 环境还会直接跳过真实 runtime 探测路径，避免 daemon 组合测试因 shell 执行
  // claude/codex CLI 而阻塞 5 秒以上。真实生产探针约 100 毫秒即可完成；这是显式的测试
  // 快速通道，免得每个测试文件都要记得设置 OPENRIG_NO_KERNEL=1。若注入
  // deps.probeRuntimes，则不自动跳过：kernel-boot 自身的单元测试会注入快速、确定性的探针，
  // 并明确要求覆盖完整逻辑。
  const probeInjected = typeof deps.probeRuntimes === "function";
  if (process.env["OPENRIG_NO_KERNEL"] === "1" || (process.env["VITEST"] === "true" && !probeInjected)) {
    const reason = process.env["OPENRIG_NO_KERNEL"] === "1" ? "OPENRIG_NO_KERNEL=1" : "VITEST=true";
    log("info", `kernel-boot：${reason}——跳过 kernel 自动启动`);
    tracker.setSkipped(reason);
    return tracker;
  }

  // 2. 已受管时直接返回。若存在名为 `kernel` 的 rig（例如来自先前启动，或由操作方迁移的
  // substrate kernel），内置路径不会介入。
  if (kernelAlreadyManaged(deps.rigRepo)) {
    log("info", "kernel-boot：kernel rig 已受管；跳过内置启动");
    tracker.setSkipped("kernel rig 已受管");
    return tracker;
  }

  // 3. 探测 runtime 认证状态以选择变体。
  const probe = await (deps.probeRuntimes ?? defaultProbeRuntimes)();

  if (probe.claudeCode === "unavailable" && probe.codex === "unavailable") {
    const msg = authBlockMessage();
    log("error", msg);
    tracker.setAuthBlocked(msg);
    return tracker;
  }

  const variant = selectVariant(probe);
  const specPath = nodePath.join(deps.specsDir, "rigs/launch/kernel", variant);

  if (!existsSync(specPath)) {
    log("warn", `kernel-boot：${specPath} 缺少 spec——跳过`);
    tracker.setSpecMissing(specPath);
    return tracker;
  }

  // 4. 通过进程内 bootstrap 流程冷启动——只触发，不等待。
  log("info", `kernel-boot：正在从 ${variant} 启动 kernel rig`);
  const bootstrapPromise = deps.bootstrapOrchestrator.bootstrap({
    mode: "apply",
    sourceRef: specPath,
    sourceKind: "rig_spec",
    autoApprove: true,
    cwdOverride: deps.cwdOverride,
  });
  tracker.startBooting(variant, bootstrapPromise);
  return tracker;
}

/** 数据库中已存在名为 `kernel` 的 rig 时返回 true。 */
export function kernelAlreadyManaged(rigRepo: RigRepository): boolean {
  const rigs = rigRepo.listRigs();
  return rigs.some((r) => r.name === "kernel");
}

/** 根据认证探针结果选择 rig 变体。 */
export function selectVariant(probe: RuntimeProbeResult): string {
  if (probe.claudeCode === "ok" && probe.codex === "ok") return "rig.yaml";
  if (probe.claudeCode === "ok") return "rig-claude-only.yaml";
  if (probe.codex === "ok") return "rig-codex-only.yaml";
  // 两者均 unavailable 时，调用方应在到达此处前直接返回；防御性默认值用于收窄类型。
  return "rig.yaml";
}

/** 默认认证探针——通过 shell 调用 runtime CLI。 */
export async function defaultProbeRuntimes(): Promise<RuntimeProbeResult> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  async function tryProbe(cmd: string): Promise<RuntimeAuthStatus> {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 5000 });
      const out = `${stdout}\n${stderr}`.toLowerCase();
      // 保守解析：只要出现任何 CLI 自认为未认证的迹象，就把 runtime 标记为 unavailable。
      // 后续可以进一步收紧解析规则。
      if (out.includes("not logged") || out.includes("not authenticated") || out.includes("login required")) {
        return "unavailable";
      }
      return "ok";
    } catch {
      return "unavailable";
    }
  }

  const [claudeCode, codex] = await Promise.all([
    tryProbe("claude auth status"),
    tryProbe("codex login status"),
  ]);

  return { claudeCode, codex };
}

/** 认证阻塞路径使用的诚实三段式错误信息，遵循 IMPL-PRD §6.3 和
 *  building-agent-software skill 规范。 */
export function authBlockMessage(): string {
  return [
    "错误：Kernel rig 无法启动——没有已认证的 AI runtime。",
    "原因：Kernel rig 要求 Claude Code 或 Codex 至少有一个已认证，但两者当前都不可用。",
    "修复：运行 `claude auth login` 认证 Claude Code，或运行 `codex login` 认证 Codex，然后再次运行 `zrig daemon start`（或 `zrig setup`）。",
  ].join("\n");
}

function defaultLog(level: "info" | "warn" | "error", message: string): void {
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.log(message);
}
