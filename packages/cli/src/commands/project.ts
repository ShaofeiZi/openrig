import { prepareWorker, runProjectWake, type WakeOptions } from "./project-worker.js";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { experimentStatus, setExperiment, readBounded, JevRun, streamDecision, classifyCapture } from "./project-jev.js";
import fs from "node:fs";

/**
 * `rig project`——协调原语 L2（分类器）命令（PL-004 Phase B）。
 *
 * 协调走 `/api/projects`；可选的实验配置/provider 处理在调用者本地进行。
 *
 * 按 PRD § L2：分类判断归智能体；后台服务强制租约 + 幂等 + 回收契约。
 */

export interface ProjectDeps extends StatusDeps {
  workerRead?: (file: string) => string;
  experimentEnv?: NodeJS.ProcessEnv;
  experimentFetch?: typeof fetch;
}

async function withClient<T>(
  deps: ProjectDeps,
  fn: (client: DaemonClient) => Promise<T>
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

export function projectCommand(depsOverride?: ProjectDeps): Command {
  const cmd = new Command("project").description(
    "协调 L2——以智能体为后端的分类器，由后台服务强制租约 + 幂等 + 回收",
  );
  const getDeps = (): ProjectDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  const experimental = cmd.command("experimental").description("可选的 Jev 实验；仅供参考、有限前台运行，默认关闭");
  for (const verb of ["enable", "disable", "status"] as const) {
    experimental.command(verb).requiredOption("--config <file>", "显式的本地实验 JSON；不含凭据")
      .option("--max-requests <n>", "每次前台运行的最大请求数，1..20")
      .option("--timeout-ms <n>", "单请求截止时间，1000..30000")
      .option("--json", "以 JSON 输出")
      .action(opts => {
        try {
          if (verb !== "status") setExperiment(opts.config, verb === "enable", {
            ...(opts.maxRequests !== undefined ? {maxRequests: Number(opts.maxRequests)} : {}),
            ...(opts.timeoutMs !== undefined ? {timeoutMs: Number(opts.timeoutMs)} : {}),
          });
          printResult(true, experimentStatus(opts.config), 200);
        } catch (error) { printResult(true, {error: "experiment_config", message: error instanceof Error ? error.message : "不可用"}, 400); }
      });
  }
  experimental.command("capture").description("对选定的已归档 capture 做分类；绝不抓取活终端，也不改动其判定")
    .requiredOption("--config <file>", "显式的实验配置")
    .requiredOption("--input <file>", "已有的 shadow JSONL 归档（最大 8 MiB）")
    .requiredOption("--output <file>", "新的参考性 JSONL 结果文件；绝不覆盖输入")
    .option("--json", "以 JSON 输出")
    .action(async opts => {
      let run: JevRun | undefined, fd: number | undefined;
      try {
        const deps = getDeps(), status = experimentStatus(opts.config, deps.workerRead);
        if (!status.enabled) { printResult(true, status, 200); return; }
        run = new JevRun(opts.config, deps.workerRead, deps.experimentEnv, deps.experimentFetch);
        const rows = readBounded(opts.input, 8 * 1024 * 1024).split("\n").filter(Boolean);
        fd = fs.openSync(opts.output, "wx", 0o600);
        process.once("SIGINT", run.stop); process.once("SIGTERM", run.stop);
        let inspected = 0, unavailable = 0;
        for (const line of rows.slice(0, run.config.maxRequests)) {
          if (run.stopped()) break;
          const result = await classifyCapture(run, JSON.parse(line));
          fs.writeFileSync(fd, JSON.stringify(result) + "\n"); inspected++;
          if (result.status === "unavailable" || result.result?.status === "unavailable") unavailable++;
        }
        printResult(true, {...run.status(), inspected, unavailable, remaining: rows.length - inspected, output: opts.output}, run.status().reason || unavailable ? 409 : 200);
      } catch { printResult(true, {error: "capture_experiment_unavailable", message: "不自动重试；已存在的输出保留已完成结果。"}, 409); }
      finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (run) { process.removeListener("SIGINT", run.stop); process.removeListener("SIGTERM", run.stop); }
      }
    });

  for (const verb of ["candidates", "wake"] as const) {
    cmd.command(verb)
      .description(verb === "wake" ? "运行一次有界占用者唤醒，带源绑定决策或显式 Jev 实验；不注册" : "读取当前源绑定候选与占用者可用的条目 ID")
      .requiredOption("--project <id>", "选定的已配置项目")
      .requiredOption("--taxonomy <file>", "占用者自有的分类法/问题 YAML")
      .requiredOption("--classifier-version <version>", "分类器版本")
      .requiredOption("--evidence-epoch <epoch>", "负责人授权的证据纪元；候选变化不会重试终态尝试")
      .option("--decisions <file>", "绑定到 candidateSetVersion 与每条 bodyHash 的 JSON 决策")
      .option("--experiment <file>", "可选实验 Jev 配置；在一次有界唤醒中替代 --decisions")
      .option("--limit <count>", "每次有界唤醒的条目数（1..100）", "20")
      .option("--json", "以 JSON 输出")
      .action(async (opts: WakeOptions & {experiment?: string}) => {
        let run: JevRun | undefined;
        try {
          if (opts.experiment) {
            if (verb !== "wake" || opts.decisions) throw Error("--experiment 仅用于 wake，不能与 --decisions");
            const deps = getDeps(), status = experimentStatus(opts.experiment, deps.workerRead);
            if (!status.enabled) { printResult(true, status, 200); return; }
            run = new JevRun(opts.experiment, deps.workerRead, deps.experimentEnv, deps.experimentFetch);
            opts.limit = String(Math.min(Number(opts.limit), run.config.maxRequests));
            process.once("SIGINT", run.stop); process.once("SIGTERM", run.stop);
          }
        await withClient(getDeps(), async client => {
          try {
            const result = verb === "wake" ? await runProjectWake(client, opts, getDeps().workerRead, run ? {
              decide: prepared => streamDecision(run!, prepared), signal: run.controller.signal,
              shouldStop: run.stopped, timeoutMs: run.config.timeoutMs,
            } : undefined) : await prepareWorker(client, opts, getDeps().workerRead);
            console.log(JSON.stringify(run ? {...result, experiment: run.status()} : result));
            if ("result" in result && ["unavailable", "lease_lost"].includes(result.result.state)) process.exitCode = 1;
            if (run?.status().reason) process.exitCode = 1;
          } catch (error) { printResult(true, {error: "worker_unavailable", message: error instanceof Error ? error.message : "不可用", phase: "prepare", nextWakeAt: new Date(Date.now() + 60_000).toISOString()}, 409); }
        });
        } catch (error) { printResult(true, {error: "experiment_unavailable", message: error instanceof Error ? error.message : "不可用"}, 409); }
        finally { if (run) { process.removeListener("SIGINT", run.stop); process.removeListener("SIGTERM", run.stop); } }
      });
  }
  for (const verb of ["shadow-status", "shadow-drain", "shadow-stop"] as const) {
    cmd.command(verb).description("检查、排空或停止显式配置的私有 shadow sink；绝不启用抓取")
      .action(async () => withClient(getDeps(), async client => {
        const result = verb === "shadow-status" ? await client.get("/api/projects/shadow") : await client.post(`/api/projects/shadow/${verb === "shadow-stop" ? "stop" : "drain"}`);
        printResult(true, result.data, result.status);
      }));
  }

  // ---- 租约生命周期 ----

  cmd
    .command("lease-acquire")
    .description("为调用者获取活动的分类器租约")
    .requiredOption("--session <session>", "分类器会话名")
    .option(
      "--evaluate-deadness-first",
      "获取前先调用 evaluateDeadness，清理任何 TTL 过期或持有者已死的陈旧租约（按 PRD § L2 deadness-detection）",
    )
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { session: string; evaluateDeadnessFirst?: boolean; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/lease/acquire", {
          classifierSession: opts.session,
          evaluateDeadnessFirst: opts.evaluateDeadnessFirst,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("lease-heartbeat")
    .description("为活动的分类器租约发送心跳（延长 TTL）")
    .requiredOption("--lease-id <id>", "租约 ID")
    .requiredOption("--session <session>", "分类器会话名")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { leaseId: string; session: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/lease/heartbeat", {
          leaseId: opts.leaseId,
          classifierSession: opts.session,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("lease-show")
    .description("展示当前活动的分类器租约")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/projects/lease");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- 操作人员动词：回收 ----

  cmd
    .command("reclaim-classifier")
    .description(
      "操作人员动词：回收活动的分类器租约。用 --if-dead 在持有者仍存活时拒绝。",
    )
    .requiredOption("--session <session>", "将持有新租约的会话")
    .option("--if-dead", "仅当存活检查报告当前持有者已死时才回收")
    .option("--reason <text>", "回收原因（自由文本；记录在 classifier_leases.reclaim_reason）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { session: string; ifDead?: boolean; reason?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/reclaim-classifier", {
          byClassifierSession: opts.session,
          ifDead: opts.ifDead,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- 投影一条流条目 ----

  cmd
    .command("classify <streamItemId>")
    .description(
      "投影一条带分类字段的流条目（按 stream_item_id 幂等；需要活动租约）",
    )
    .requiredOption("--session <session>", "分类器会话名（必须持有活动租约）")
    .requiredOption("--lease-id <id>", "计算本结果时使用的租约 ID（来自 lease-acquire）；已替换或过期的租约会被拒绝")
    .option("--attempt-id <id>", "在同一事务中标为已写入的 attempt 台账 ID（手工分类时省略）")
    .option("--execution-id <id>", "attempt begin 时的执行 ID（与 --attempt-id 同用必需；被取代的执行会被拒绝）")
    .option("--type <type>", "分类类型（例如 idea、bug、feature-request）")
    .option("--urgency <urgency>", "分类紧急度（例如 normal、high、critical）")
    .option("--maturity <maturity>", "分类成熟度（例如 concept、drafted、ratified）")
    .option("--confidence <confidence>", "分类置信度（例如 low、medium、high）")
    .option("--destination <destination>", "分类目的地（下游 slice/席位）")
    .option("--action <action>", "动作类型（例如 create、advance）")
    .option("--area <area>", "产品领域标签")
    .option("--scope-ref <id>", "任务目标/slice 范围 id（需要 --candidate-set-version）")
    .option("--duplicate-of <streamItemId>", "本条所重复的更早的流条目")
    .option("--needs-human <value>", "true | false（未知时省略；未知不等于 false）")
    .option("--classifier-version <v>", "产生该标签的分类器版本")
    .option("--taxonomy-version <v>", "该标签使用的分类法版本")
    .option("--candidate-set-version <v>", "该标签从中选择的范围/名册候选集版本")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (streamItemId: string, opts: {
      session: string;
      leaseId: string;
      attemptId?: string;
      executionId?: string;
      area?: string;
      scopeRef?: string;
      duplicateOf?: string;
      needsHuman?: string;
      classifierVersion?: string;
      taxonomyVersion?: string;
      candidateSetVersion?: string;
      type?: string;
      urgency?: string;
      maturity?: string;
      confidence?: string;
      destination?: string;
      action?: string;
      json?: boolean;
    }) => {
      if (opts.needsHuman !== undefined && opts.needsHuman !== "true" && opts.needsHuman !== "false") {
        console.error("--needs-human 必须是 true 或 false；未知时省略");
        process.exitCode = 1;
        return;
      }
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/project", {
          streamItemId,
          classifierSession: opts.session,
          leaseId: opts.leaseId,
          attemptId: opts.attemptId,
          executionId: opts.executionId,
          area: opts.area,
          scopeRef: opts.scopeRef,
          duplicateOfStreamItemId: opts.duplicateOf,
          needsHuman: opts.needsHuman === undefined ? undefined : opts.needsHuman === "true",
          classifierVersion: opts.classifierVersion,
          taxonomyVersion: opts.taxonomyVersion,
          candidateSetVersion: opts.candidateSetVersion,
          classificationType: opts.type,
          classificationUrgency: opts.urgency,
          classificationMaturity: opts.maturity,
          classificationConfidence: opts.confidence,
          classificationDestination: opts.destination,
          action: opts.action,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- 列表 + 展示 ----

  cmd
    .command("list")
    .description("列出项目分类，可带过滤")
    .option("--session <session>", "按分类器会话过滤")
    .option("--destination <destination>", "按分类目的地过滤")
    .option("--area <area>", "按领域过滤")
    .option("--scope-ref <id>", "按范围引用过滤")
    .option("--needs-human <value>", "过滤：true | false | unknown")
    .option("--limit <n>", "结果条数上限", "100")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { session?: string; destination?: string; area?: string; scopeRef?: string; needsHuman?: string; limit: string; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.session) params.set("classifierSession", opts.session);
      if (opts.destination) params.set("classificationDestination", opts.destination);
      if (opts.area) params.set("area", opts.area);
      if (opts.scopeRef) params.set("scopeRef", opts.scopeRef);
      if (opts.needsHuman) params.set("needsHuman", opts.needsHuman);
      if (opts.limit) params.set("limit", opts.limit);
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/projects/list?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("show <projectId>")
    .description("展示一条项目分类")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (projectId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/projects/${encodeURIComponent(projectId)}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
