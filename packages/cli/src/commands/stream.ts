import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig stream` —— 协作原语 L1 命令（PL-004 A 阶段）。
 *
 * 后端为 `/api/stream`。只通过后台服务 HTTP API 操作。
 * 不触碰 POC 的 `rigx-stream-proto` 文件系统状态。
 */

export interface StreamDeps extends StatusDeps {
  fetchImpl?: typeof fetch;
}

interface WatchedStreamItem {
  tsEmitted: string;
  sourceSession: string;
  body: string;
  [key: string]: unknown;
}

async function withClient<T>(
  deps: StreamDeps,
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

function isWatchedStreamItem(value: unknown): value is WatchedStreamItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.tsEmitted === "string"
    && typeof item.sourceSession === "string"
    && typeof item.body === "string";
}

function printWatchData(data: string, json: boolean): void {
  try {
    const item = JSON.parse(data) as unknown;
    if (!isWatchedStreamItem(item)) return;
    if (json) console.log(JSON.stringify(item));
    else console.log(`[${item.tsEmitted} ${item.sourceSession}] ${item.body}`);
  } catch {
    // 后台服务每行 data 发出一个 JSON 项。忽略畸形帧。
  }
}

async function consumeWatch(body: ReadableStream<Uint8Array>, json: boolean): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeLines = (flush: boolean): void => {
    const lines = buffer.split("\n");
    buffer = flush ? "" : (lines.pop() ?? "");
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("data:")) printWatchData(line.slice(5).trim(), json);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeLines(false);
    }
    buffer += decoder.decode();
    if (buffer) {
      buffer += "\n";
      consumeLines(true);
    }
  } finally {
    reader.releaseLock();
  }
}

export function streamCommand(depsOverride?: StreamDeps): Command {
  const cmd = new Command("stream").description("协作 L1 —— 只追加的 intake 流");
  const getDeps = (): StreamDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .command("emit")
    .description("追加一个流条目")
    .requiredOption("--source <session>", "源会话（例如 velocity-driver@openrig-velocity-claude）")
    .requiredOption("--body <text>", "流条目正文")
    .option("--hint-destination <session>", "提示预期的目标席位")
    .option("--hint-type <type>", "提示类型（例如 review、handoff、idea）")
    .option("--hint-urgency <urgency>", "提示紧急度（routine、urgent、critical）")
    .option("--hint-tags <tags>", "逗号分隔的提示标签")
    .option("--format <fmt>", "观察正文格式")
    .option("--interrupt", "把条目标记为可打断")
    .option("--id <streamItemId>", "幂等的 stream_item_id（未提供则跳过）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: {
      source: string;
      body: string;
      hintDestination?: string;
      hintType?: string;
      hintUrgency?: string;
      hintTags?: string;
      format?: string;
      interrupt?: boolean;
      id?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const tags = opts.hintTags ? opts.hintTags.split(",").map((s) => s.trim()).filter(Boolean) : null;
      await withClient(deps, async (client) => {
        const res = await client.post<Record<string, unknown>>("/api/stream/emit", {
          streamItemId: opts.id,
          sourceSession: opts.source,
          body: opts.body,
          ...(opts.format ? { format: opts.format } : {}),
          hintDestination: opts.hintDestination ?? null,
          hintType: opts.hintType ?? null,
          hintUrgency: opts.hintUrgency ?? null,
          hintTags: tags,
          interrupt: opts.interrupt ?? false,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("list")
    .description("按时间顺序列出流条目")
    .option("--source <session>", "按源会话过滤")
    .option("--hint-destination <session>", "按提示目标过滤")
    .option("--tag <tag>", "按精确提示标签过滤")
    .option("--since <iso>", "包含此 ISO 时间戳及之后发出的条目")
    .option("--until <iso>", "包含此 ISO 时间戳及之前发出的条目")
    .option("--limit <n>", "结果上限", "100")
    .option("--after <sortKey>", "游标分页——返回此排序键之后的条目")
    .option("--include-archived", "包含已归档条目")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: {
      source?: string;
      hintDestination?: string;
      tag?: string;
      since?: string;
      until?: string;
      limit: string;
      after?: string;
      includeArchived?: boolean;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.source) params.set("sourceSession", opts.source);
      if (opts.hintDestination) params.set("hintDestination", opts.hintDestination);
      if (opts.tag) params.set("hintTag", opts.tag);
      if (opts.since) params.set("since", opts.since);
      if (opts.until) params.set("until", opts.until);
      if (opts.limit) params.set("limit", opts.limit);
      if (opts.after) params.set("afterSortKey", opts.after);
      if (opts.includeArchived) params.set("includeArchived", "true");
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/stream/list?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("watch")
    .description("监视流（初始回放 + 实时条目）")
    .option("--json", "每行输出一个 StreamItem JSON 对象")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        try {
          const res = await (deps.fetchImpl ?? fetch)(`${client.baseUrl}/api/stream/sse`, {
            headers: { Accept: "text/event-stream" },
          });
          if (!res.ok) {
            console.error(`监视失败（HTTP ${res.status}）`);
            process.exitCode = res.status >= 500 ? 2 : 1;
            return;
          }
          if (!res.body) {
            console.error("监视失败：缺少响应体");
            process.exitCode = 2;
            return;
          }
          await consumeWatch(res.body, opts.json ?? false);
        } catch (err) {
          console.error(`监视出错：${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 2;
        }
      });
    });

  cmd
    .command("show <streamItemId>")
    .description("按 id 取单个流条目")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (streamItemId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/stream/${encodeURIComponent(streamItemId)}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("archive <streamItemId>")
    .description("软归档一个流条目（审计行保留）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (streamItemId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/stream/${encodeURIComponent(streamItemId)}/archive`, {});
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
