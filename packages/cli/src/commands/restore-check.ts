import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { getOpenRigHome, isFixtureScopedHome, readOpenRigEnv } from "../openrig-compat.js";
import { ConfigStore } from "../config-store.js";
import { realDeps } from "./daemon.js";

// daemon.port 默认值（config-store.ts 中的 DEFAULT_CONFIG）。当 fixture 目标
// 是从文件/环境解析而来、且不等于该值时，即视为"分叉"。
const DEFAULT_DAEMON_PORT = 7433;

interface FixtureLeak {
  fixtureHome: string;
  /** 分叉的后台服务目标（端口号，或泄露的 OPENRIG_URL）。 */
  target: string | number;
  source: string;
}

/**
 * OPR.0.4.3.12——检测带分叉后台服务目标、泄露的 fixture 作用域 home。
 * 把纯路径谓词 `isFixtureScopedHome`（来自 openrig-compat，不依赖 ConfigStore）
 * 与此处的 ConfigStore 分叉目标确认组合（restore-check 位于两者下游，
 * 因此无 import 环）。只有两者同时成立才返回 null 之外的值，
 * 从而真实 home 下合法的非默认端口绝不会误触守卫。
 */
function detectFixtureLeak(): FixtureLeak | null {
  const fixtureHome = getOpenRigHome();
  if (!isFixtureScopedHome(fixtureHome)) return null;

  // 泄露的 OPENRIG_URL 会把状态探针直接指向 fixture。
  const leakedUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
  if (leakedUrl) {
    return { fixtureHome, target: leakedUrl, source: "env (OPENRIG_URL)" };
  }

  // 否则确认从 fixture 的 config.json / OPENRIG_PORT 解析出的分叉
  // daemon.port（source !== "default" 且 value !== 7433）。
  let resolved: { value: string | number | boolean; source: string } | undefined;
  try {
    resolved = new ConfigStore().resolveWithSource("daemon.port");
  } catch {
    resolved = undefined;
  }
  if (resolved && resolved.source !== "default" && resolved.value !== DEFAULT_DAEMON_PORT) {
    return { fixtureHome, target: resolved.value as number, source: resolved.source };
  }
  return null;
}

/**
 * 为检测到的 fixture 泄露构造诚实的、不可变的双 home 结果——
 * 而不是发出阻断性的 `rig daemon start` / `scope:"host"` 包。
 * 同时点名 fixture home（及其分叉目标/来源）与真实默认 home（及默认端口），
 * 并给出不可变的补救建议。
 */
function fixtureLeakResult(leak: FixtureLeak): RestoreCheckResult {
  const realHome = join(homedir(), ".openrig");
  const evidence =
    `restore-check 在 fixture 作用域的 OPENRIG_HOME（${leak.fixtureHome}）下运行，` +
    `其后的后台服务目标分叉（${leak.source} = ${leak.target}）。真实默认 home 为 ${realHome} ` +
    `（daemon.port ${DEFAULT_DAEMON_PORT}）。真实内核未被探测——这是泄露的测试 fixture，` +
    `而非主机宕机。`;
  const remediation =
    `取消泄露的 OPENRIG_HOME / OPENRIG_PORT / OPENRIG_URL（或重新指向 ${realHome}），` +
    `然后重跑：zrig restore-check`;
  return localRestoreResult({
    verdict: "unknown",
    checks: [{ check: "home.fixture-scoped", status: "yellow", evidence, remediation }],
    repairPacket: [{
      step: 1,
      command: remediation,
      rationale: "fixture 作用域的 OPENRIG_HOME 泄露进了真实内核恢复命令",
      safe: true,      // 不可变：取消环境变量/重新指向，不启动后台服务
      blocking: false,
    }],
    recovery: {
      status: "unknown",
      summary:
        `恢复状态未检查：本次调用使用的是 fixture 作用域 home ` +
        `（${leak.fixtureHome}），而非真实默认 home（${realHome}）。清除泄露的 ` +
        `zrig 主目录/目标环境变量后重跑，即可检查真实内核。`,
      actions: [],
      blocked: [],
      unknown: [],
    },
  });
}

export interface RestoreCheckDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => DaemonClient;
}

interface CheckEntry {
  check: string;
  status: "green" | "yellow" | "red";
  evidence: string;
  remediation: string;
}

interface RepairStep {
  step: number;
  command: string;
  rationale: string;
  safe: boolean;
  blocking: boolean;
}

interface ReadinessAssertion {
  status: "ready" | "ready_with_caveats" | "not_ready" | "unknown";
  reason: string;
  blockingRigCount: number;
  caveatRigCount: number;
  unknownRigCount: number;
}

interface ContinuityAssertion {
  status: "proven" | "not_proven" | "partial" | "not_applicable";
  evidence: string;
  provenCapabilities: string[];
  unprovenCapabilities: string[];
}

interface RigRestoreRollup {
  rigId: string;
  rigName: string;
  status: "ready" | "ready_with_caveats" | "not_ready" | "unknown";
  verdict: "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
  expectedNodes: number;
  runningReadyNodes: number;
  blockedNodes: number;
  caveatNodes: number;
  blockingChecks: CheckEntry[];
  caveatChecks: CheckEntry[];
}

interface HostInfraAssertion {
  status: "not_inspected" | "not_declared" | "declared" | "unknown";
  evidence: string;
}

interface RecoveryAction {
  scope: "rig";
  rigId: string;
  rigName: string;
  action: "restore_from_latest_snapshot";
  command: string;
  reason: string;
  safe: boolean;
  blocking: boolean;
}

interface RecoveryIssue {
  scope: "host" | "rig";
  rigId?: string;
  rigName?: string;
  reason: string;
}

interface RecoveryPlan {
  status: "not_needed" | "actionable" | "blocked" | "unknown";
  summary: string;
  actions: RecoveryAction[];
  blocked: RecoveryIssue[];
  unknown: RecoveryIssue[];
}

interface RestoreCheckResult {
  verdict: "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
  readiness: ReadinessAssertion;
  continuity: ContinuityAssertion;
  rigs: RigRestoreRollup[];
  hostInfra: HostInfraAssertion;
  recovery: RecoveryPlan;
  counts: { red: number; yellow: number; green: number };
  // OPR.0.4.0.29 FR-8——按 5 个真实枚举类别拆分就绪置信度。
  classCounts?: {
    ready: number;
    ready_with_caveats: number;
    not_ready: number;
    attention_required: number;
    unknown: number;
  };
  checks: CheckEntry[];
  repairPacket: RepairStep[] | null;
}

const STATUS_SYMBOLS: Record<string, string> = {
  green: "✓",
  yellow: "⚠",
  red: "✗",
};

const STATUS_COLORS: Record<string, string> = {
  green: "",
  yellow: "",
  red: "",
};

export function restoreCheckCommand(depsOverride?: RestoreCheckDeps): Command {
  const cmd = new Command("restore-check")
    .description("检查各运行中工作组的恢复就绪度")
    .addHelpText("after", `
示例：
  zrig restore-check                    检查所有工作组
  zrig restore-check --rig openrig-pm    检查一个工作组
  zrig restore-check --no-queue         跳过队列文件检查
  zrig restore-check --no-hooks         跳过 hook 检查
  zrig restore-check --json             供智能体使用的 JSON 输出

退出码：
  0  可恢复（或带注意事项可恢复）
  1  不可恢复（发现红色阻断项）
  2  未知 / 探测错误`);

  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON 输出（默认紧凑摘要；用 --full --json 获取完整细节）")
    .option("--full", "展示逐席位完整细节（今日默认）")
    .option("--ready", "在 not-ready 之外额外展示 ready 席位细节")
    .option("--rig <name>", "仅检查一个工作组")
    .option("--no-queue", "跳过队列文件检查")
    .option("--no-hooks", "跳过 hook 检查")
    .addHelpText("after", `
默认：紧凑摘要，含逐工作组就绪度计数与仅 NOT-READY 席位。
ready 席位会计数，但为节省 token 省略其细节。

用 --full 获取今日完整的逐席位细节（全部检查、修复包等）。
用 --ready 在 not-ready 之外加入 ready 席位细节。
用 --full --json 获取完整 JSON 洪流。

就绪类别：ready、ready_with_caveats、not_ready、attention_required、unknown。

示例：
  zrig restore-check                       紧凑摘要（计数 + not-ready）
  zrig restore-check --json                紧凑 JSON 摘要
  zrig restore-check --full               逐席位完整细节
  zrig restore-check --full --json        完整 JSON（洪流）
  zrig restore-check --ready               输出中包含 ready 席位
  zrig restore-check --rig my-rig         仅检查一个工作组`)
    .action(async (opts: { json?: boolean; full?: boolean; ready?: boolean; rig?: string; queue?: boolean; hooks?: boolean }) => {
      const deps = getDepsF();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        // OPR.0.4.3.12——fixture home 隔离守卫。带分叉后台服务目标的泄露
        // fixture OPENRIG_HOME 会让 getDaemonStatus 探错端口
        // （connection-refused），并把真实内核误报为宕机。检测到这一精确泄露后
        // 诚实地响应（点名两个 home、不可变），而不是发出阻断性的
        // `rig daemon start` / `scope:"host"` 主机修复包。仅在检测到
        // fixture 作用域 home + 分叉目标时触发，从而下方针对真实 home 的
        // 后台服务宕机契约保持不变。
        const leak = detectFixtureLeak();
        if (leak) {
          const result = fixtureLeakResult(leak);
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printHuman(result);
          }
          process.exitCode = 2;
          return;
        }

        // 后台服务宕机——产出结构化的 not_restorable 结果
        const result = localRestoreResult({
          verdict: "not_restorable",
          checks: [{
            check: "daemon.reachable",
            status: "red",
            evidence: "后台服务未运行",
            remediation: "用以下命令启动后台服务：zrig daemon start",
          }],
          repairPacket: [{
            step: 1,
            command: "用以下命令启动后台服务：zrig daemon start",
            rationale: "后台服务未运行",
            safe: false,  // 可变：启动一个后台服务进程
            blocking: true,
          }],
          recovery: {
            status: "blocked",
            summary: "在后台服务运行起来之前，无法给出精确的工作组恢复动作。",
            actions: [],
            blocked: [{
              scope: "host",
              reason: "后台服务未运行；无法检查工作组状态以做恢复规划。",
            }],
            unknown: [],
          },
        });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printHuman(result);
        }
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      try {
        const params = new URLSearchParams();
        // 默认紧凑；--full 退出。--ready 保持紧凑，在 not-ready 行之外
        // 增加 ready 席位细节（ready=1）——它不是完整洪流
        // （OPR.0.4.0.29 FR-2 / 前向修复更正）。
        if (!opts.full) params.set("compact", "1");
        if (opts.ready) params.set("ready", "1");
        if (opts.rig) params.set("rig", opts.rig);
        if (opts.queue === false) params.set("noQueue", "true");
        if (opts.hooks === false) params.set("noHooks", "true");
        const query = params.toString();
        const path = `/api/restore-check${query ? `?${query}` : ""}`;

        const response = await client.get<RestoreCheckResult>(path);

        if (response.status >= 500) {
          const result = localRestoreResult({
            verdict: "unknown",
            checks: [{
              check: "probe.error",
              status: "red",
              evidence: `后台服务返回 HTTP ${response.status}`,
              remediation: "用以下命令查看后台服务日志：zrig daemon logs",
            }],
            repairPacket: [{
              step: 1,
              command: "用以下命令查看后台服务日志：zrig daemon logs",
              rationale: `后台服务返回 HTTP ${response.status}`,
              safe: true,
              blocking: true,
            }],
            recovery: {
              status: "unknown",
              summary: `由于后台服务返回 HTTP ${response.status}，无法检查恢复状态。`,
              actions: [],
              blocked: [],
              unknown: [{
                scope: "host",
                reason: `后台服务返回 HTTP ${response.status}`,
              }],
            },
          });
          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printHuman(result);
          }
          process.exitCode = 2;
          return;
        }

        const result = response.data;

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (opts.full) {
          printHuman(result);
        } else {
          printCompact(result);
        }

        // 退出码：0 表示 restorable/restorable_with_caveats；1 表示 not_restorable；2 表示 unknown
        if (result.verdict === "not_restorable") {
          process.exitCode = 1;
        } else if (result.verdict === "unknown") {
          process.exitCode = 2;
        }
      } catch (err) {
        console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
        console.error("修复：用以下命令检查后台服务状态：zrig daemon status");
        process.exitCode = 2;
      }
    });

  return cmd;
}

function printHuman(result: RestoreCheckResult): void {
  const verdictLabel = result.verdict.replace(/_/g, " ").toUpperCase();
  console.log(`恢复检查 — ${verdictLabel}`);
  console.log(`${result.counts.green} 绿 | ${result.counts.yellow} 黄 | ${result.counts.red} 红`);
  const readinessLabel = result.readiness.status.replace(/_/g, " ");
  console.log(`就绪度：${readinessLabel}（${result.readiness.reason}）`);
  console.log(`连续性：${result.continuity.status.replace(/_/g, " ")}`);
  if (result.hostInfra) {
    console.log(`主机引导/自启动：${result.hostInfra.status} — ${result.hostInfra.evidence}`);
  }
  console.log(`恢复：${result.recovery.status.replace(/_/g, " ").toUpperCase()}`);
  console.log(result.recovery.summary);
  for (const action of result.recovery.actions) {
    console.log(`  动作：${action.command}`);
  }
  for (const issue of result.recovery.blocked) {
    console.log(`  阻断：${issue.reason}`);
  }
  for (const issue of result.recovery.unknown) {
    console.log(`  未知：${issue.reason}`);
  }
  if (result.rigs && result.rigs.length > 0) {
    console.log();
    console.log("逐工作组摘要：");
    console.log(`${"工作组".padEnd(24)} ${"状态".padEnd(16)} ${"就绪".padEnd(9)} ${"阻断".padEnd(8)} 注意事项`);
    for (const rig of result.rigs) {
      console.log(
        `${rig.rigName.slice(0, 24).padEnd(24)} ${rig.status.padEnd(16)} ` +
        `${`${rig.runningReadyNodes}/${rig.expectedNodes}`.padEnd(9)} ${String(rig.blockedNodes).padEnd(8)} ${rig.caveatNodes}`
      );
    }
  }
  console.log();

  for (const check of result.checks) {
    const sym = STATUS_SYMBOLS[check.status] ?? "?";
    console.log(`  ${sym} ${check.check}：${check.evidence}`);
    if (check.remediation) {
      console.log(`    修复：${check.remediation}`);
    }
  }

  if (result.repairPacket && result.repairPacket.length > 0) {
    const blockers = result.repairPacket.filter((s) => s.blocking).length;
    const caveats = result.repairPacket.filter((s) => !s.blocking).length;
    console.log();
    console.log(`修复步骤：${result.repairPacket.length}（${blockers} 阻断，${caveats} 注意事项）`);
    if (blockers > 0) {
      console.log("恢复前请先解决阻断步骤。");
    }
  } else if (result.counts.red > 0) {
    console.log();
    console.log("发现阻断项。恢复前请先解决红色项。");
  } else if (result.counts.yellow > 0) {
    console.log();
    console.log("可恢复，但有注意事项。黄色项不阻断，但值得过目。");
  }
}

function printCompact(result: RestoreCheckResult): void {
  const verdictLabel = result.verdict.replace(/_/g, " ").toUpperCase();
  console.log(`恢复检查 — ${verdictLabel}`);
  console.log(`${result.counts.green} 绿 | ${result.counts.yellow} 黄 | ${result.counts.red} 红`);
  const readinessLabel = result.readiness.status.replace(/_/g, " ");
  console.log(`就绪度：${readinessLabel}`);
  // FR-8：按类别拆分就绪置信度（5 个真实枚举类别）。
  if (result.classCounts) {
    const cc = result.classCounts;
    console.log(
      `类别：${cc.ready} ready | ${cc.ready_with_caveats} ready_with_caveats | ` +
      `${cc.not_ready} not_ready | ${cc.attention_required} attention_required | ${cc.unknown} unknown`
    );
  }

  if (result.rigs && result.rigs.length > 0) {
    console.log();
    console.log(`${"工作组".padEnd(24)} ${"状态".padEnd(18)} ${"就绪".padEnd(9)} ${"阻断".padEnd(8)} 注意事项`);
    for (const rig of result.rigs) {
      console.log(
        `${rig.rigName.slice(0, 24).padEnd(24)} ${rig.status.padEnd(18)} ` +
        `${`${rig.runningReadyNodes}/${rig.expectedNodes}`.padEnd(9)} ${String(rig.blockedNodes).padEnd(8)} ${rig.caveatNodes}`
      );
    }
  }

  // 路由已把 `checks` 限定到正确集合：默认仅 not-ready，
  // 或 --ready（ready=1）时全部席位（含 ready 细节）。
  // 原样渲染它返回的内容——这里不要重新过滤。
  if (result.checks.length > 0) {
    console.log();
    for (const check of result.checks) {
      const sym = STATUS_SYMBOLS[check.status] ?? "?";
      console.log(`  ${sym} ${check.check}：${check.evidence}`);
      if (check.remediation) {
        console.log(`    修复：${check.remediation}`);
      }
    }
  }

  if (result.recovery && result.recovery.status !== "not_needed") {
    console.log();
    console.log(`恢复：${result.recovery.status.replace(/_/g, " ").toUpperCase()}`);
    console.log(result.recovery.summary);
    for (const action of result.recovery.actions) {
      console.log(`  动作：${action.command}`);
    }
    for (const issue of result.recovery.blocked) {
      console.log(`  阻断：${issue.reason}`);
    }
  }

  if (result.counts.red > 0) {
    console.log();
    console.log("用 --full 查看完整细节。用 --ready 包含 ready 席位信息。");
  }
}

function localRestoreResult(input: {
  verdict: RestoreCheckResult["verdict"];
  checks: CheckEntry[];
  repairPacket: RepairStep[] | null;
  recovery: RecoveryPlan;
}): RestoreCheckResult {
  const red = input.checks.filter((c) => c.status === "red").length;
  const yellow = input.checks.filter((c) => c.status === "yellow").length;
  const green = input.checks.filter((c) => c.status === "green").length;
  const unknown = input.verdict === "unknown";

  return {
    verdict: input.verdict,
    readiness: {
      status: unknown ? "unknown" : "not_ready",
      reason: unknown ? "unknown_probe_state" : "blockers_present",
      blockingRigCount: 0,
      caveatRigCount: 0,
      unknownRigCount: 0,
    },
    continuity: {
      status: "not_proven",
      evidence: "restore-check v1 不校验严格的同会话/同 provider 上下文恢复。",
      provenCapabilities: [],
      unprovenCapabilities: ["provider_session_resume", "context_window_preservation", "interrupted_work_functional_resume"],
    },
    rigs: [],
    hostInfra: {
      status: "unknown",
      evidence: "未能检查主机引导/自启动来源，因为 restore-check 未收到后台服务路由证据",
    },
    counts: { red, yellow, green },
    checks: input.checks,
    repairPacket: input.repairPacket,
    recovery: input.recovery,
  };
}
