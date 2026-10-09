import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `zrig view` —— 协作原语 L5（视图）命令（PL-004 B 阶段）。
 *
 * 后端为 `/api/views`。内置 7 个视图（recently-active、founder、pod-load、
 * escalations、held、activity、pickup）+ 自定义视图注册。
 * `escalations` 同时携带 escalation 已关闭的行与 S01 唤醒梯中
 * 仍开启的聚合升级（操作者层级的交付底线）。
 */

export interface ViewDeps extends StatusDeps {}

async function withClient<T>(
  deps: ViewDeps,
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

export function viewCommand(depsOverride?: ViewDeps): Command {
  const cmd = new Command("view").description(
    "协作 L5 —— 由后台服务支撑的协作状态视图",
  );
  const getDeps = (): ViewDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .command("list")
    .description("列出内置 + 自定义视图")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/views/list");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("show <viewName>")
    .description(
      "运行一个视图（内置或自定义）。内置视图：recently-active、founder、pod-load、escalations、held、activity、pickup",
    )
    .option("--rig <rig>", "按工作组名过滤（匹配 destination_session 或 source_session @<rig>）")
    .option("--limit <n>", "结果行数上限", "100")
    .option("--mission <id>", "执行视图的任务目标范围（默认取最新的 release-* 任务目标）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (viewName: string, opts: { rig?: string; limit: string; mission?: string; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.rig) params.set("rig", opts.rig);
      if (opts.limit) params.set("limit", opts.limit);
      if (opts.mission) params.set("mission", opts.mission);
      const query = params.toString();
      await withClient(deps, async (client) => {
        const path = `/api/views/${encodeURIComponent(viewName)}${query ? `?${query}` : ""}`;
        const res = await client.get<unknown>(path);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("register")
    .description("注册或更新一个自定义视图")
    .requiredOption("--name <name>", "自定义视图名（不得与内置名冲突）")
    .requiredOption("--definition <sql>", "SQL 定义（由操作者提供；不做分类法校验）")
    .requiredOption("--session <session>", "注册该视图的操作者会话")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { name: string; definition: string; session: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/views/custom/register", {
          viewName: opts.name,
          definition: opts.definition,
          registeredBySession: opts.session,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
