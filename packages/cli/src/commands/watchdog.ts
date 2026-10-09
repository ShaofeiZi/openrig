import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { positiveIntArg } from "../cli-error.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig watchdog` —— 协调原语 Watchdog（PL-004 Phase C）。
 *
 * 由 `/api/watchdog` 支撑。仅通过后台服务 HTTP API 操作。
 *
 * 依据 PRD § Watchdog：调度器为后台服务原生，并入监督树。
 * Phase D 在 Phase C 看门狗策略之外纳入 workflow-keepalive。
 */

export interface WatchdogDeps extends StatusDeps {}

async function withClient<T>(
  deps: WatchdogDeps,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return undefined;
  const client = deps.clientFactory(getDaemonUrl(status));
  return fn(client);
}

function printResult(json: boolean, body: unknown, status: number): void {
  if (json) {
    console.log(JSON.stringify(body));
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
  if (status >= 400) process.exitCode = status >= 500 ? 2 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactWatchdogJob(job: Record<string, unknown>): Record<string, unknown> {
  return {
    jobId: job.jobId,
    policy: job.policy,
    targetSession: job.targetSession,
    intervalSeconds: job.intervalSeconds,
    lastEvaluationAt: job.lastEvaluationAt,
    lastFireAt: job.lastFireAt,
    actionable: job.actionable,
    lastActionableAt: job.lastActionableAt,
    state: job.state,
    registeredAt: job.registeredAt,
    terminalReason: job.terminalReason,
    bindingState: job.bindingState,
  };
}

export function watchdogCommand(depsOverride?: WatchdogDeps): Command {
  const cmd = new Command("watchdog").description(
    "协调看门狗——后台服务原生调度器，用于提醒、产物闸门、工作流健康、空闲闸门与上下文用量",
  );
  const getDeps = (): WatchdogDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("register")
    .description(
      "注册一个看门狗；queue block --wake-watchdog 会挂上其作业 id。" +
      "上下文会话记录实测 113K–153K tokens/MB。余量即保护，因为绑定提示的消费方" +
      "只在回合边界行动",
    )
    .option("--spec <path>", "YAML 规范文件路径（context-usage-threshold 可省略）")
    .requiredOption("--policy <policy>", "策略名（可选值：periodic-reminder、artifact-pool-ready、edge-artifact-required、workflow-keepalive、idle-gate-qitem、context-usage-threshold）")
    .requiredOption("--target-session <session>", "规范的 <member>@<rig> 目标")
    .requiredOption("--interval-seconds <n>", "评估间隔（正整数）")
    .requiredOption("--registered-by <session>", "注册方会话（供审计）")
    .option("--threshold-bytes <n>", "（context-usage-threshold）会话记录字节阈值")
    .option("--threshold-mb <n>", "（context-usage-threshold）会话记录阈值，十进制 MB")
    .option("--watched-file <path>", "（context-usage-threshold）显式指定会话记录文件；缺省回退到已记录的上下文路径")
    .option("--requires-job <jobId>", "（context-usage-threshold）要求同占用者此前某作业的回执")
    .option("--message <text>", "（context-usage-threshold）触发阈值时投递的消息")
    .option("--active-wake-interval-seconds <n>", "（pool-ready 专用）存在可执行产物时的唤醒节奏")
    .option("--scan-interval-seconds <n>", "（pool-ready 专用）产物池扫描节奏")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", "\n会话记录密度随会话形态变化；不要把上下文阈值调到贴近上下文墙。\n\n返回的作业 id 可挂到一次有意驻留上：zrig queue block <qitemId> --on <blocker> --continuation <what-resumes> --wake-watchdog <jobId>")
    .action(async (opts: {
      spec?: string;
      policy: string;
      targetSession: string;
      intervalSeconds: string;
      registeredBy: string;
      activeWakeIntervalSeconds?: string;
      scanIntervalSeconds?: string;
      thresholdBytes?: string;
      thresholdMb?: string;
      watchedFile?: string;
      requiresJob?: string;
      message?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      let specYaml: string;
      const isContextUsageThreshold = opts.policy === "context-usage-threshold";
      if (!opts.spec && !isContextUsageThreshold) {
        console.error("除非 --policy 为 context-usage-threshold，否则必须提供 --spec");
        process.exitCode = 1;
        return;
      }
      if (opts.thresholdBytes !== undefined && opts.thresholdMb !== undefined) {
        console.error("--threshold-bytes 与 --threshold-mb 只能用其一");
        process.exitCode = 1;
        return;
      }
      const thresholdBytes = opts.thresholdBytes !== undefined
        ? Number(opts.thresholdBytes)
        : opts.thresholdMb !== undefined
          ? Number(opts.thresholdMb) * 1_000_000
          : undefined;
      if (
        isContextUsageThreshold &&
        thresholdBytes !== undefined &&
        (!Number.isInteger(thresholdBytes) || thresholdBytes <= 0)
      ) {
        console.error("上下文阈值必须解析为正整数字节数");
        process.exitCode = 1;
        return;
      }
      if (isContextUsageThreshold && !opts.spec && thresholdBytes === undefined) {
        console.error("省略 --spec 时，上下文阈值必须提供 --threshold-bytes 或 --threshold-mb");
        process.exitCode = 1;
        return;
      }
      const watchedFilePath = opts.watchedFile ? resolve(opts.watchedFile) : undefined;
      if (opts.spec) {
        try {
          specYaml = readFileSync(opts.spec, "utf-8");
        } catch (err) {
          console.error(`读取规范文件 ${opts.spec} 失败：${err instanceof Error ? err.message : err}`);
          process.exitCode = 1;
          return;
        }
      } else {
        specYaml = [
          "policy: context-usage-threshold",
          "target:",
          `  session: ${JSON.stringify(opts.targetSession)}`,
          ...(opts.message ? [`message: ${JSON.stringify(opts.message)}`] : []),
          "context:",
          `  threshold_bytes: ${thresholdBytes}`,
          ...(watchedFilePath ? [`  watched_file: ${JSON.stringify(watchedFilePath)}`] : []),
          ...(opts.requiresJob ? [`  requires: ${JSON.stringify(opts.requiresJob)}`] : []),
          "",
        ].join("\n");
      }
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/watchdog/register", {
          policy: opts.policy,
          specYaml,
          targetSession: opts.targetSession,
          intervalSeconds: Number.parseInt(opts.intervalSeconds, 10),
          activeWakeIntervalSeconds: opts.activeWakeIntervalSeconds
            ? Number.parseInt(opts.activeWakeIntervalSeconds, 10)
            : undefined,
          scanIntervalSeconds: opts.scanIntervalSeconds
            ? Number.parseInt(opts.scanIntervalSeconds, 10)
            : undefined,
          watchedFilePath,
          thresholdBytes,
          requiresJobId: opts.requiresJob,
          registeredBySession: opts.registeredBy,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("list")
    .description("列出看门狗作业（默认：active + 紧凑 + 至多 100 条）")
    .option("-a, --all", "包含已停止与终态历史")
    .option("--full", "显示每个作业的完整字段")
    .option("--limit <n>", "结果上限（默认：100，除非 --full）", positiveIntArg)
    .option("--json", "供智能体使用的 JSON 输出（除非 --full 否则紧凑）")
    .addHelpText("after", `
默认：active 作业、紧凑字段、至多 100 条记录。
用 --all 查看已停止/终态历史，用 --full 查看每个作业的完整字段。
0.5.8 之前的完整数组仍可通过：zrig watchdog list --all --full 获取`)
    .action(async (opts: { all?: boolean; full?: boolean; limit?: number; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/watchdog/list");
        if (res.status >= 400 || !Array.isArray(res.data)) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        const byState = opts.all
          ? res.data
          : res.data.filter((job) => isRecord(job) && job.state === "active");
        const limit = opts.limit ?? (opts.full ? undefined : 100);
        if (limit !== undefined && byState.length > limit) {
          console.error(
            `共 ${byState.length} 个匹配的看门狗作业，仅显示前 ${limit} 条；` +
            "用 --full 查看全部 active 作业，或 --all --full 查看完整历史。",
          );
        }
        const bounded = limit === undefined
          ? byState
          : [...byState]
              .sort((a, b) =>
                Number(isRecord(b) && b.actionable === true) -
                Number(isRecord(a) && a.actionable === true))
              .slice(0, limit);
        const body = opts.full
          ? bounded
          : bounded.map((job) => isRecord(job) ? compactWatchdogJob(job) : job);
        printResult(opts.json ?? false, body, res.status);
      });
    });

  cmd
    .command("show <jobId>")
    .description("查看一个看门狗作业")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/watchdog/${encodeURIComponent(jobId)}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("status <jobId>")
    .description("查看一个看门狗作业 + 近期评估历史")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/watchdog/${encodeURIComponent(jobId)}/status`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("stop <jobId>")
    .description("停止一个看门狗作业（操作者停止；调度器将跳过它）")
    .option("--reason <text>", "停止原因（自由文本；记入 terminal_reason）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (jobId: string, opts: { reason?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/watchdog/${encodeURIComponent(jobId)}/stop`, {
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
