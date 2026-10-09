// OPR.0.4.6.02 C3 —— `rig terminal` 命令族（TUI-1 不透明动词 +
// 操作者的终端提供方接入入口）。三个子命令都打向同一个规范的后台服务编排器
// （`/api/terminal/...`）：
//
//   zrig terminal open <view> [--provider herdr|cmux] [--json]
//   zrig terminal views [--json]
//   zrig terminal status [--provider herdr|cmux] [--json]
//
// `<view>` 在后台服务端解析：一个工作组名（按工作组派生） | `mission:<id>` |
// `slice:<id>`（派生） | 一个已保存视图 id。结果是同一份
// `{ opened, absent, degraded }` 划分，在此处与路由 JSON 中逐字节一致（arch Q3）。
//
// 退出语义（PRD / arch Q3）：带具名结果的部分打开是成功并附说明 → 退出 0；
// 零窗格打开（没有任何平铺：视图未知、提供方宕机、每个席位缺席/降级）→ 非零。
// `views`/`status` 除非后台服务不可达，否则始终退出 0。

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TerminalDeps extends StatusDeps {}

/** 同一份共享的打开结果形状（对应后台服务的 `OpenViewResult`）。 */
interface OpenViewResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: { seat: string; host: string | null; reason: string }[];
  degraded: { seat: string; host: string; reason: string }[];
  pages: number;
  error?: string;
  code?: string;
  notes?: string[];
}

async function withClient<T>(
  deps: TerminalDeps,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return undefined;
  const client = deps.clientFactory(getDaemonUrl(status));
  return fn(client);
}

/** 打印朴素的后台服务响应（views/status）。JSON = 紧凑；人类 = 美化。 */
function printResult(json: boolean, body: unknown, status: number): void {
  console.log(json ? JSON.stringify(body) : JSON.stringify(body, null, 2));
  if (status >= 400) process.exitCode = status >= 500 ? 2 : 1;
}

/** 人类格式的诚实部分打开结果（opened/absent/degraded，逐一具名）。 */
function humanOpen(r: OpenViewResult): string {
  const lines: string[] = [];
  const tiled = r.opened.length;
  lines.push(
    tiled > 0
      ? `已在 ${r.provider} 平铺 ${tiled} 个窗格${r.pages > 1 ? `，跨 ${r.pages} 页` : ""}。`
      : `未在 ${r.provider} 中打开任何窗格。`,
  );
  if (r.error) lines.push(`  提供方：${r.error}${r.code ? `（${r.code}）` : ""}`);
  for (const seat of r.opened) lines.push(`  ● ${seat}`);
  for (const a of r.absent) lines.push(`  ○ ${a.seat} — 缺席：${a.reason}`);
  for (const d of r.degraded) lines.push(`  ▲ ${d.seat} — 跳过（${d.host}）：${d.reason}`);
  for (const n of r.notes ?? []) lines.push(`  注：${n}`);
  return lines.join("\n");
}

/** 打开退出规则：至少平铺一个窗格才退出 0（带具名结果的部分打开算成功）。 */
function printOpen(json: boolean, r: OpenViewResult, status: number): void {
  if (json) {
    console.log(JSON.stringify(r));
  } else {
    console.log(humanOpen(r));
  }
  // 4xx/5xx（输入错误 / 视图未知 / 服务宕机）或零窗格打开即为失败。
  if (status >= 400 || r.opened.length === 0) {
    process.exitCode = status >= 500 ? 2 : 1;
  }
}

export function terminalCommand(depsOverride?: TerminalDeps): Command {
  const cmd = new Command("terminal").description(
    "把 zrig 视图（智能体终端）作为窗格打开到终端提供方（herdr / cmux）",
  );

  const getDeps = (): TerminalDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("open")
    .argument("<view>", "工作组名、mission:<id>、slice:<id> 或已保存视图 id")
    .description("把视图中每个运行中的智能体打开为交互式终端窗格")
    .option("--provider <name>", "终端提供方：herdr（默认）或 cmux（尽力而为）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (view: string, opts: { provider?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const body = { view, ...(opts.provider ? { provider: opts.provider } : {}) };
        const res = await client.post<OpenViewResult>("/api/terminal/open", body);
        printOpen(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("views")
    .description("列出已保存视图 + 可作为派生视图打开的工作组")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/terminal/views");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("status")
    .description("显示终端提供方可用性 + 存活状态（doctor）")
    .option("--provider <name>", "限定到一个提供方（herdr / cmux）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { provider?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const path = opts.provider
          ? `/api/terminal/status?provider=${encodeURIComponent(opts.provider)}`
          : "/api/terminal/status";
        const res = await client.get<unknown>(path);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
