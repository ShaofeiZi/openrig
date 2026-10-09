import fs from "node:fs";
import { Command } from "commander";
import { DaemonClient, DaemonConnectionError, DaemonTimeoutError, DaemonResponseError } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { sessionRigOf, isHumanSeatSessionRef } from "../session-name.js";
import { realDeps } from "./daemon.js";
import { enumArg, positiveIntArg } from "../cli-error.js";
import type { StatusDeps } from "./status.js";
import { resolveContextRef } from "../context-resolve.js";
import { shellQuote } from "../cross-host-executor.js";
import { omittedReadField, readView } from "../read-view.js";

/**
 * `rig queue`——协同原语 L3/inbox/outbox 命令（PL-004 Phase A）。
 *
 * 后台为 `/api/queue`。只通过后台服务 HTTP API 操作。
 * 不触碰 POC 的 `rigx-queue-proto` 文件系统状态。
 *
 * hot-potato 严格拒绝在后台服务侧执行：不带 `--closure-reason` 的
 * `update --state done` 会以退出码 1 返回结构化错误，列出 6 个合法 closure reason。
 */

export interface DeliveryVerifyDeps {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface QueueDeps extends StatusDeps {
  deliveryVerify?: DeliveryVerifyDeps;
}

export interface VerifiedDeliveryResult {
  outcome: "posted" | "transport-failed" | "never-posted" | "still-pending" | "indeterminate";
  /** null 表示目前无法判定 connector 是否签收。 */
  connectorAccepted: boolean | null;
  /** connector 回执永远无法证明有人已读这条消息。 */
  humanReadership: "unknown";
  detail?: string;
  nextAction: string | null;
}

export async function waitForDeliveryOutcome(
  client: Pick<DaemonClient, "get">,
  qitemId: string,
  deps: DeliveryVerifyDeps = {},
): Promise<VerifiedDeliveryResult> {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const intervalMs = deps.intervalMs ?? 500;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const started = now();
  for (;;) {
    try {
      const response = await client.get<Record<string, unknown>>(`/api/queue/${encodeURIComponent(qitemId)}`);
      if (response.status !== 200) throw new Error(`回执查询返回 HTTP ${response.status}`);
      const outcome = response.data.deliveryOutcome;
      if (outcome === "posted") {
        return { outcome, connectorAccepted: true, humanReadership: "unknown", nextAction: null };
      }
      if (outcome === "transport-failed" || outcome === "never-posted") {
        return {
          outcome,
          connectorAccepted: false,
          humanReadership: "unknown",
          detail: typeof response.data.deliveryFailureDetail === "string" ? response.data.deliveryFailureDetail : undefined,
          nextAction: `zrig queue show ${qitemId} --json`,
        };
      }
    } catch (error) {
      return {
        outcome: "indeterminate",
        connectorAccepted: null,
        humanReadership: "unknown",
        detail: `无法读取投递回执：${(error as Error).message}`,
        nextAction: `zrig queue show ${qitemId} --json`,
      };
    }
    if (now() - started >= timeoutMs) {
      return {
        outcome: "still-pending",
        connectorAccepted: null,
        humanReadership: "unknown",
        detail: `${timeoutMs}ms 内没有拿到终态 connector 回执；持久化的 qitem 保持完好`,
        nextAction: `zrig queue show ${qitemId} --json`,
      };
    }
    await sleep(intervalMs);
  }
}

async function withClient<T>(
  deps: QueueDeps,
  fn: (client: DaemonClient) => Promise<T>,
  attemptWhenProbeUnconfirmed = false,
  // D14——在传输失败输出里点名跨主机目标。
  hostContext?: string,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  // RULING 1ae863d2——状态是三态：只在有确凿证据（stopped/stale）时硬阻断。
  // UNVERIFIED（timeout/ wedged /wrong-home）仍继续向配置的目标发请求，由目标裁定——
  // 绝不武断判定为 down。
  const positiveDown = status.state === "stopped" || status.state === "stale";
  if (positiveDown || (status.state === "running" && status.healthy === false)) {
    if (!attemptWhenProbeUnconfirmed) {
      // B8-1b：唯一一处认知匹配的闸门同时渲染两个分支。
      daemonStatusGuard(status);
      return undefined;
    }
  }
  if (status.state === "unverified" && status.siblingHint) {
    console.error(`注意：OPENRIG_HOME 可能不对——解析到 ${status.siblingHint.resolvedHome}，存活的同级 ${status.siblingHint.siblingHome}`);
  }
  const baseUrl = status.state === "running" && status.port !== undefined
    ? getDaemonUrl(status)
    : new DaemonClient().baseUrl;
  const client = deps.clientFactory(baseUrl);
  // D14（accept-and-drop 家族 #6）：抛错的传输必须响亮地失败——分类后的错误 +
  // 主机上下文打到 stderr、非零退出码——绝不静默退出。
  try {
    return await fn(client);
  } catch (err) {
    if (err instanceof DaemonConnectionError || err instanceof DaemonTimeoutError || err instanceof DaemonResponseError) {
      // D14 + B8 调和（既有的 main 冲突，在 B8 A/B 时发现）：D14 上下文行在这里打印，
      // 然后带类型的错误重新抛出，让共享的 runProgram 渲染负责三段式 fact/consequence/action
      // + io 退出（响应完整性契约）。一个渲染权威，分层上下文——绝不吞掉退出码。
      const where = hostContext ? `（路由到主机 '${hostContext}'）` : "";
      console.error(`queue 传输失败${where}：${err.message}`);
      console.error("若请求可能已到达某个后台服务，写入结果即为不确定——重试前先按 ID 对账。");
    }
    throw err;
  }
}

function printResult(json: boolean, body: unknown, status: number): void {
  if (json) {
    console.log(JSON.stringify(body));
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
  if (status >= 400) process.exitCode = status >= 500 ? 2 : 1;
}

// OPR.0.4.3.03——`rig queue show` 正文预览。
//
// 默认 `show` 渲染有界正文预览，而不是把整个 qitem 正文倒进智能体上下文；
// `--full` 才退回完整正文。这个界是码点数计数（delivery-set，可调），
// 按 IMPL-SPEC §2.3-2.4。
const SHOW_BODY_PREVIEW_MAX_CODEPOINTS = 512;

function wakeDurationSeconds(value: string): number {
  const match = /^(\d+)(s|m|h)?$/i.exec(value.trim());
  if (!match) throw new Error("唤醒时长必须是正整数，可带 s、m 或 h 后缀");
  const amount = Number.parseInt(match[1]!, 10);
  const factor = match[2]?.toLowerCase() === "h" ? 3600 : match[2]?.toLowerCase() === "m" ? 60 : 1;
  const seconds = amount * factor;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("唤醒时长必须为正");
  return seconds;
}

export interface BodyPreview {
  preview: string;
  bodyBytes: number;
  bodyTruncated: boolean;
}

// 多字节安全的有界预览（IMPL-SPEC §2.3-2.4）。预览是前 N 个码点：
// `Array.from(body)` 按码点切分（绝不把代理对/多字节字符切开），所以切片天然多字节安全，
// 绝不会吐出半个/非法 UTF-8 序列。`bodyTruncated` 按码点数判断（codePointCount > N）。
// `bodyBytes` 是完整正文诚实的真实 UTF-8 字节总长（绝不是截断后的大小）。
export function previewBody(
  body: string,
  maxCodePoints = SHOW_BODY_PREVIEW_MAX_CODEPOINTS
): BodyPreview {
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const codePoints = Array.from(body);
  if (codePoints.length <= maxCodePoints) {
    return { preview: body, bodyBytes, bodyTruncated: false };
  }
  return {
    preview: codePoints.slice(0, maxCodePoints).join(""),
    bodyBytes,
    bodyTruncated: true,
  };
}

function isRecordWithStringBody(v: unknown): v is Record<string, unknown> & { body: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).body === "string"
  );
}

// OPR.0.3.2.21.FR-4(a)——正文输入解析。接受三种形态：
//   --body "<text>"               内联（遗留；原始多行内容易被反引号污染）
//   --body-file <path>            从文件路径读正文内容
//                                 （消灭反引号污染这一类问题）
//   --body-file - 或 --body -     从 stdin 读正文（便于管道）
//
// --body / --body-file 二者必须恰好提供一个；否则解析器抛出三段式
// fact/consequence/action 错误。
//
// stdinReader 是依赖注入的，测试可以替换它而不动 process.stdin。
// 默认从 process.stdin 按 UTF-8 读到 EOF。
export interface ResolveBodyOpts {
  body?: string;
  bodyFile?: string;
}

export async function defaultStdinReader(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    if (process.stdin.isTTY) {
      // stdin 没有接管道；立即解析为空，而不是在 TTY 上永远阻塞等数据。
      // 空正文随后流向后台服务的内容校验（正文契约归 queue-repository）；
      // CLI 本地不因空 stdin 报错。
      resolve("");
    }
  });
}

export async function resolveQueueBody(
  opts: ResolveBodyOpts,
  stdinReader: () => Promise<string> = defaultStdinReader,
): Promise<string> {
  const hasInline = opts.body !== undefined && opts.body !== "";
  const hasFile = opts.bodyFile !== undefined && opts.bodyFile !== "";
  if (hasInline && hasFile) {
    const err = new Error("--body 与 --body-file 互斥。") as Error & { fact?: string; consequence?: string; action?: string };
    err.fact = "同时传了 --body 和 --body-file；正文来源有歧义。";
    err.consequence = "queue 命令未执行；未联系后台服务。";
    err.action = "--body 与 --body-file 二者只传一个。";
    throw err;
  }
  if (!hasInline && !hasFile) {
    const err = new Error("缺少必需的正文输入。") as Error & { fact?: string; consequence?: string; action?: string };
    err.fact = "既没传 --body，也没传 --body-file。";
    err.consequence = "queue 命令未执行；未联系后台服务。";
    err.action = "用 --body \"<文本>\" 或 --body-file <路径> 传入正文（用 - 表示 stdin）。";
    throw err;
  }
  if (hasInline) {
    if (opts.body === "-") return requireNonEmptyResolvedBody(await stdinReader(), "stdin (--body -)");
    return opts.body!;
  }
  // hasFile 路径
  if (opts.bodyFile === "-") return requireNonEmptyResolvedBody(await stdinReader(), "stdin (--body-file -)");
  const absPath = opts.bodyFile!;
  if (!fs.existsSync(absPath)) {
    const err = new Error(`--body-file 路径不存在：${absPath}`) as Error & { fact?: string; consequence?: string; action?: string };
    err.fact = `--body-file 路径不存在：${absPath}`;
    err.consequence = "queue 命令未执行；未联系后台服务。";
    err.action = "检查路径；传绝对路径；或用 --body-file - 从 stdin 读。";
    throw err;
  }
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    const err = new Error(`--body-file 路径不是普通文件：${absPath}`) as Error & { fact?: string; consequence?: string; action?: string };
    err.fact = `--body-file 路径不是普通文件：${absPath}`;
    err.consequence = "queue 命令未执行；未联系后台服务。";
    err.action = "传一个可读文件的路径（不是目录、指向目录的软链或块设备）。用 --body-file - 从 stdin 读。";
    throw err;
  }
  return requireNonEmptyResolvedBody(fs.readFileSync(absPath, "utf8"), `--body-file ${absPath}`);
}

function requireNonEmptyResolvedBody(body: string, source: string): string {
  if (Buffer.byteLength(body, "utf8") > 0) return body;
  const err = new Error(`${source} 解析为 0 字节。`) as Error & { fact?: string; consequence?: string; action?: string };
  err.fact = `${source} 解析为 0 字节；空正文不是合法的隐式 queue 载荷。`;
  err.consequence = "协同命令未执行，未联系后台服务，也没有任何内容被持久化。";
  err.action = source.startsWith("stdin")
    ? "向 stdin 管道送入非空内容，或用 --body-file <路径> 传一个非空文件。"
    : "给文件加上内容，或换一个非空正文来源。";
  throw err;
}

function emitBodyResolveError(err: Error & { fact?: string; consequence?: string; action?: string }, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { fact: err.fact ?? err.message, consequence: err.consequence ?? "", action: err.action ?? "" } }, null, 2));
  } else {
    process.stderr.write(`错误：${err.fact ?? err.message}\n${err.consequence ?? ""}\n${err.action ?? ""}\n`);
  }
  process.exitCode = 1;
}

function resolveCurrentSession(explicit: string | undefined, optionName: string): string | undefined {
  const session = explicit ?? readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
  if (session) return session;

  console.error(`未设置 OPENRIG_SESSION_NAME 时必须提供 --${optionName}`);
  process.exitCode = 1;
  return undefined;
}

function extractRigName(sessionName: string): string | undefined {
  // OPR.0.4.6.MH1 FR-8：共享解析契约（贪婪的第一个 @ 前的 rig）。
  return sessionRigOf(sessionName);
}

/**
 * OPR.0.4.6.MH3 D-3（C3）：把 queue 目标操作数 + 可选的显式 `--host` 解析进带外请求信封
 * （BR-1——离开 CLI 的会话串保持两段 `member@rig`；主机走 `hostId`；三段串绝不离开 CLI 边界）。
 *
 * queue 的解析规则（架构裁定——刻意与交互式动词的"已注册才剥"规则不同）：
 * queue 目标按构造就是只能用规范名（后台服务的 validateRig 会拒绝任何非规范解析），
 * 所以在人 seat 分类之后无条件剥离——敲错的主机会响亮地报错并点名该主机
 * （unknown-host），而不是给出误导性的 rig 形状的 `unknown_destination_rig`：
 *
 *   1. 先做人 seat 分类（已交付的原型）：人 seat 引用绝不被捕获。
 *      `RESERVED_HOST_IDS`（kernel/host/local）保证没有已注册主机会遮蔽
 *      人 seat 的 `@kernel`/`@host` 家族。
 *   2. 少于两个 `@` → 普通两段会话，原样放行。
 *   3. 两个或以上 `@` → 在最后一个 `@` 处切分；尾段是主机限定词，剥离进 `hostId`；
 *      其余部分是目标会话。
 *
 * D-2（仅显式）：queue 动词绝不查持久化的主机选择——跨主机路由只通过
 * `--host <id>` 或带主机限定词的目标形态发生。同时用不同主机命名二者是结构化
 * 歧义错误，绝不静默挑一个优先级。
 */
export type QueueHostResolution =
  | { ok: true; destination: string; hostId?: string }
  | { ok: false; error: string; message: string };

export function resolveQueueHostDestination(
  destination: string,
  explicitHost?: string,
): QueueHostResolution {
  if (isHumanSeatSessionRef(destination)) {
    return { ok: true, destination, hostId: explicitHost };
  }
  const atCount = destination.split("@").length - 1;
  if (atCount < 2) {
    return { ok: true, destination, hostId: explicitHost };
  }
  const lastAt = destination.lastIndexOf("@");
  const head = destination.slice(0, lastAt);
  const tail = destination.slice(lastAt + 1);
  if (!tail) {
    return {
      ok: false,
      error: "invalid_host_qualified_destination",
      message: `目标 '${destination}' 以空主机段结尾——用 member@rig@<host>（或去掉末尾的 '@'）`,
    };
  }
  if (explicitHost !== undefined && explicitHost !== tail) {
    return {
      ok: false,
      error: "host_qualifier_conflict",
      message: `--host ${explicitHost} 与带主机限定词的目标 '${destination}'（主机 '${tail}'）冲突——只命名一个主机（去掉标志或去掉限定词）`,
    };
  }
  return { ok: true, destination: head, hostId: tail };
}

/** 以本项目三段式风格发出 D-3 解析错误（本地、联系后台服务之前）。 */
function emitHostResolutionError(res: { error: string; message: string }, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ error: res.error, message: res.message }));
  } else {
    console.error(res.message);
  }
  process.exitCode = 1;
}

const QUEUE_HOST_OPTION_HELP =
  "OPR.0.4.6.MH3：把这次 queue 写入路由到一台已注册的远程主机（见 zrig host ls）。仅显式——queue 动词绝不跟随持久化的 'zrig host select' 选择。等价于带主机限定词的目标形态 member@rig@<host>。";

export function queueCommand(depsOverride?: QueueDeps): Command {
  const cmd = new Command("queue").description("协同 L3——自有工作队列 + inbox/outbox");
  const getDeps = (): QueueDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .command("create")
    .description("创建一个新 qitem")
    .option("--source <session>", "（已废弃，忽略）source 从 seat 环境推导（X-OpenRig-Session）；P21 I3 让 create 路由从传输头推导它")
    .requiredOption("--destination <session>", "目标会话（拥有该工作的 seat）")
    .option("--body <text>", "内联 qitem 正文（用 - 从 stdin 读；与 --body-file 互斥）")
    .option("--body-file <path>", "从文件路径读 qitem 正文（用 - 表示 stdin；与 --body 互斥）。消灭多行正文的反引号 shell 污染这一类问题。")
    .option("--body-context <ref>", "把一个 context pack 按其类路径 ref 快照进 qitem 正文（解析出的内容随交接 + body-context:<ref> 溯源标签一起携带）。与 --body / --body-file 互斥。")
    .option("--mission <id>", "一等 mission 作用域；翻译成 mission:<id> 标签（与 --tags 组合）")
    .option("--slice <id>", "一等 slice 作用域；翻译成 slice:<id> 标签（与 --tags 组合）")
    .option("--gate <role>", "OPR.0.4.3.16：把此项标记为 gate qitem；翻译成 gate:<role> 标签（role 例如 guard | spec-review | pm-lead | qa | human）。idle-gate 看门狗读这个谓词。与 --tags 组合。")
    .option("--priority <priority>", "优先级：routine | urgent | critical", "routine")
    .option("--tier <tier>", "tier（例如 fast、routine、deep、critical）——驱动 SLA")
    .option("--tags <tags>", "逗号分隔的标签（与 --mission、--slice 组合）")
    .option("--expires-at <iso>", "qitem 过期的 ISO 时间戳")
    .option("--id <qitemId>", "幂等的 qitem_id（不传则跳过）")
    .option("--target-repo <name>", "PL-007：带类型的 repo 作用域（必须匹配源 rig 的 RigSpec.workspace.repos[] 里的某个 repo）")
    .option("--summary <text>", "简短的人读主题，显示在 needs-you 视图。目标是人时，--body-file 是完整的决策简报或更新；技术续述留在所属智能体行和证据里。")
    .option("--human-intent <intent>", "decision（默认）或 update：一次安静的信息投递，绝不是审批请求")
    .option("--human-detail-file <path>", "一条显式撰写的补充跟帖回复；完整的行动/选项放在 --body-file 里")
    .option("--evidence-ref <path>", "OPR.0.4.4.19 FR-5：指向人要评判的持久化产物（例如 PROOF.md 路径）。此项路由给人时由后台服务要求；否则可选。")
    .option("--host <id>", QUEUE_HOST_OPTION_HELP)
    .option("--no-nudge", "抑制默认的目标 nudge（冷队列）")
    .option("--verify", "持久化后有界等待既有网关投递回执；绝不重试 create，也绝不声称有人已读")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: {
      source?: string;
      destination: string;
      body?: string;
      bodyFile?: string;
      bodyContext?: string;
      mission?: string;
      slice?: string;
      gate?: string;
      priority: string;
      tier?: string;
      tags?: string;
      expiresAt?: string;
      id?: string;
      targetRepo?: string;
      humanIntent?: string;
      humanDetailFile?: string;
      summary?: string;
      evidenceRef?: string;
      host?: string;
      nudge?: boolean;
      verify?: boolean;
      json?: boolean;
    }) => {
      // OPR.0.4.6.MH3 D-3（C3）：在 CLI 边界解析主机限定词——三段形态绝不离开 CLI；
      // 请求携带两段目标 + 带外 hostId 信封（BR-1）。
      const hostResolved = resolveQueueHostDestination(opts.destination, opts.host);
      if (!hostResolved.ok) {
        emitHostResolutionError(hostResolved, opts.json ?? false);
        return;
      }
      // Atom 6b：--body-context 把一个 pack ref 的全部内容快照为正文
      // （快照规则），在下面的 withClient 内向后台服务库解析。
      // 与本地 --body / --body-file 来源互斥。
      if (opts.bodyContext !== undefined && (opts.body !== undefined || opts.bodyFile !== undefined)) {
        console.error("--body-context 与 --body / --body-file 互斥（正文来源三选一）。");
        process.exitCode = 1;
        return;
      }
      // OPR.0.3.2.21.FR-4(a)——在联系后台服务之前先解析本地正文，
      // 让缺失/歧义的正文快速、本地失败。
      let resolvedBody = "";
      if (opts.bodyContext === undefined) {
        try {
          resolvedBody = await resolveQueueBody({ body: opts.body, bodyFile: opts.bodyFile });
        } catch (err) {
          emitBodyResolveError(err as Error & { fact?: string; consequence?: string; action?: string }, opts.json ?? false);
          return;
        }
      }
      // OPR.0.4.1.18（FR-7，先警告后要求的宽限期）：每个新 qitem 都应带 summary
      // （它喂给 Story 节点 + 帮人快速扫读）。打到 stderr 警告，好让 --json 的 stdout 保持干净——
      // 但不硬性中断省略它的既有调用方；硬性要求是未来的加固。
      if (!opts.summary) {
        process.stderr.write(
          "警告：调用 zrig queue create 时未带 --summary。传 --summary <文本> 可设置新 qitem 简短的人读摘要；否则 Story 节点回退到有界正文预览。好的摘要是一两句平实的话，让人在 needs-you 视图里快速扫读——这项工作是什么、为什么需要这个 seat，而不是 --body 里的智能体黑话。继续执行（pre-18 调用方豁免）。\n"
        );
      }
      // P21 I3 调和：source 从 seat 环境推导（X-OpenRig-Session）——--source
      // 已废弃且被忽略，没有 body sourceSession。校验环境，否则后台服务返回 400 actor_required
      // （没有 seat 身份可记录；P18 已退役 401 拒绝）。
      if (!resolveCurrentSession(undefined, "source")) return;
      const deps = getDeps();
      // OPR.0.3.2.21.FR-4(b)——一等 --mission / --slice 标志翻译成规范的
      // mission:<id> / slice:<id> 标签。与 --tags 组合（任何标志派生的标签前置；
      // 显式 --tags 追加）。去重，使得同时传 --mission X 和 --tags mission:X 只产生一个 mission:X 标签。
      const fromTagsArg = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const fromFlags: string[] = [];
      if (opts.mission) fromFlags.push(`mission:${opts.mission}`);
      if (opts.slice) fromFlags.push(`slice:${opts.slice}`);
      // OPR.0.4.3.16——一等 --gate <role> 盖一个 gate:<role> 标签
      // （idle-gate 看门狗读的 queue-gate 谓词）。与 --mission/--slice 同样的
      // 形式化 + 去重。
      if (opts.gate) fromFlags.push(`gate:${opts.gate}`);
      // Atom 6b 快照溯源：记录正文来自哪里，好让交接保持可审计，即便之后 pack 被编辑。
      if (opts.bodyContext) fromFlags.push(`body-context:${opts.bodyContext}`);
      const merged = [...fromFlags, ...fromTagsArg];
      const seen = new Set<string>();
      const dedupedTags = merged.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true; });
      const tags = dedupedTags.length > 0 ? dedupedTags : undefined;
      await withClient(deps, async (client) => {
        // Atom 6b：在库上解析 --body-context（全有或全无——缺一个成员就在创建
        // qitem 之前中止）。解析出的内容就是正文（一次快照）；ref 作为溯源标签携带，
        // 好让之后的库编辑永不改写这次交接的历史。
        if (opts.bodyContext !== undefined) {
          try {
            resolvedBody = (await resolveContextRef(client, opts.bodyContext)).text;
          } catch (err) {
            console.error((err as Error).message);
            process.exitCode = 1;
            return;
          }
        }
        const res = await client.post<Record<string, unknown>>("/api/queue/create", {
          qitemId: opts.id,
          destinationSession: hostResolved.destination,
          body: resolvedBody,
          humanIntent: opts.humanIntent,
          humanDetail: opts.humanDetailFile ? await resolveQueueBody({ bodyFile: opts.humanDetailFile }) : undefined,
          summary: opts.summary,
          evidenceRef: opts.evidenceRef,
          priority: opts.priority,
          tier: opts.tier,
          tags,
          expiresAt: opts.expiresAt,
          targetRepo: opts.targetRepo,
          nudge: opts.nudge,
          // OPR.0.4.6.MH3 FR-1：带外主机信封（纯本地写入时省略——本地路径保持逐字节一致）。
          ...(hostResolved.hostId !== undefined ? { hostId: hostResolved.hostId } : {}),
        });
        if (opts.verify && res.status < 400) {
          const created = res.data;
          const qitemId = typeof created.qitemId === "string" ? created.qitemId : null;
          const delivery = qitemId
            ? await waitForDeliveryOutcome(client, qitemId, deps.deliveryVerify)
            : {
                outcome: "indeterminate" as const,
                connectorAccepted: null,
                humanReadership: "unknown" as const,
                detail: "create 响应未含 qitem id；无法关联投递",
                nextAction: null,
              };
          printResult(opts.json ?? false, { ...created, qitemId, persisted: true, delivery }, res.status);
          return;
        }
        printResult(opts.json ?? false, res.data, res.status);
      }, hostResolved.hostId !== undefined, hostResolved.hostId);
    });

  cmd
    .command("claim <qitemId>")
    .description("认领一个 qitem（pending → in-progress）；按 tier 计算 closure_required_at")
    .option("--destination <session>", "（已废弃，忽略）认领者从 seat 环境推导（X-OpenRig-Session）；P21 I3 让 claim 路由从传输头推导它")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (qitemId: string, opts: { destination?: string; json?: boolean }) => {
      // P21 I3 调和：认领者从 seat 环境推导——--destination 已废弃且被忽略，
      // 没有 body claim。校验环境（头来源），否则后台服务返回 400 actor_required
      // （没有 seat 身份可记录；P18 已退役 401 拒绝）。
      if (!resolveCurrentSession(undefined, "destination")) return;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/claim`, {});
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("unclaim <qitemId>")
    .description("释放已认领的 qitem（in-progress → pending）")
    .option("--destination <session>", "（已废弃，忽略）释放者从 seat 环境推导（X-OpenRig-Session）；unclaim 路由从传输头推导它")
    .option("--reason <text>", "unclaim 的原因", "manual")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (qitemId: string, opts: { destination?: string; reason: string; json?: boolean }) => {
      // P21 I3 调和：释放者从 seat 环境推导——--destination 已废弃且被忽略，
      // 没有 body claim。校验环境，否则后台服务返回 400 actor_required
      // （没有 seat 身份可记录；P18 已退役 401 拒绝）。
      if (!resolveCurrentSession(undefined, "destination")) return;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/unclaim`, {
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("update <qitemId>")
    .description("追加一条 note 和/或变更 qitem 状态。不带 --state 的 note 绝不改变行状态。state=done 必须带 --closure-reason（六选一：handed_off_to, blocked_on, denied, canceled, no-follow-on, escalation）。closure ≠ acceptance：handed_off_to 记录已交付到下一阶段；acceptance 是下一阶段对它自己 qitem 的裁定，不是本次 closure。")
    .option("--actor <session>", "（已废弃，忽略）actor 从 seat 环境推导（X-OpenRig-Session）；P21 I3 让 update 路由从传输头推导它")
    .option("--state <state>", "新状态：pending | in-progress | done | blocked | failed | denied | canceled | handed-off")
    .option("--reopen", "显式承认一次有意的终态→活跃修复；要求 --state 和 --note")
    .option("--closure-reason <reason>", "state=done 时必填；state=canceled 时也可用 'superseded'（配 --closure-target = 后继项）记录一次取代，区别于放弃式 cancel")
    .option("--closure-target <target>", "handed_off_to、blocked_on、escalation、superseded 时必填")
    .option("--blocked-on <blocker>", "state=blocked 时：阻塞者——一个 qitem id（必须存在且存活）、一个人 seat（FR-6 park；要求 summary + evidence_ref），或带类型的非 qitem 闸门 'fold:<what>' / 'auth:<what>' / 'external:<what>'")
    .option("--wake-watchdog <jobId>", "state=blocked 时：挂一个已存在的、指向行属主的存活 watchdog id")
    .option("--wake-after <duration>", "state=blocked 时：原子地武装一个定时器（例如 90s、15m、2h）", wakeDurationSeconds)
    .option("--summary <text>", "OPR.0.4.4.19 FR-6：park 时持久化到该条目的摘要（仅人 seat park）")
    .option("--evidence-ref <path>", "OPR.0.4.4.19 FR-6：park 时持久化到该条目的持久化产物指针（仅人 seat park）")
    .option("--note <text>", "进审计日志的迁移 note")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (qitemId: string, opts: {
      actor?: string;
      state?: string;
      reopen?: boolean;
      closureReason?: string;
      closureTarget?: string;
      blockedOn?: string;
      wakeWatchdog?: string;
      wakeAfter?: number;
      summary?: string;
      evidenceRef?: string;
      note?: string;
      json?: boolean;
    }) => {
      // P21 I3 调和：actor 从 seat 环境推导（X-OpenRig-Session，由 DaemonClient 盖章）——
      // --actor 已废弃且被忽略，没有 body actorSession。校验环境（头来源），否则后台服务返回
      // 400 actor_required（没有 seat 身份可记录；P18 已退役 401 拒绝）。与 `resolve` 一致。
      if (!resolveCurrentSession(undefined, "actor")) return;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/update`, {
          state: opts.state,
          reopen: opts.reopen,
          closureReason: opts.closureReason,
          closureTarget: opts.closureTarget,
          blockedOn: opts.blockedOn,
          wakeWatchdogId: opts.wakeWatchdog,
          wakeAfterSeconds: opts.wakeAfter,
          summary: opts.summary,
          evidenceRef: opts.evidenceRef,
          transitionNote: opts.note,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // OPR.0.4.4.19 FR-6——一等 park 入口（C5 leg 1）。一个动词，两种阻塞者：
  // --on 接一个 qitem id（今天已交付的 blocked-on 用法，不需要新东西）或一个人 seat 会话
  // （leg-1 park——summary + evidence_ref 由后台服务校验器强制）。它是同一条 update 写入路径的
  // 瘦客户端——强制在后台服务域层，绝不只在动词里。park 是非终态的：属主保留这个 potato，
  // 不涉及任何 closure_reason。
  cmd
    .command("block <qitemId>")
    .description("把一个 qitem park 为 HELD，并带续作和唤醒。选一个 watchdog id、定时器或存活阻塞者。")
    .requiredOption("--on <blocker>", "阻塞者：一个存活的阻塞 qitem、带类型闸门，或人 seat 会话")
    .option("--actor <session>", "（已废弃，忽略）actor 从 seat 环境推导（X-OpenRig-Session）；park 走同一条 P21 I3 从头推导的 update 路由")
    .option("--summary <text>", "所欠决策的平实摘要（人 seat park 必填，除非条目上已有）")
    .option("--evidence-ref <path>", "人要评判的持久化产物（人 seat park 必填，除非条目上已有）")
    .option("--note <text>", "进审计日志的迁移 note")
    .option("--continuation <text>", "恢复时做什么。被推迟/不紧迫的工作区归属工作应放进 mission/slice")
    .option("--wake-watchdog <jobId>", "挂一个已存在的、指向被 park 属主的存活 watchdog id")
    .option("--wake-after <duration>", "park 时原子地武装一个定时器（例如 90s、15m、2h）", wakeDurationSeconds)
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
每一行有意的 HELD 都应写明它的续作和一个存活唤醒：
  --wake-watchdog <jobId>  挂一个存活 watchdog id
  --wake-after <duration>  park 时原子地武装定时器
  --on qitem-…             存活阻塞者的解决本身即唤醒

HELD 只用于必须留在队列上等待的行。归属某个被推迟/不紧迫工作区的工作，
应放进它的 mission/slice。`)
    .action(async (qitemId: string, opts: {
      on: string;
      actor?: string;
      summary?: string;
      evidenceRef?: string;
      note?: string;
      continuation?: string;
      wakeWatchdog?: string;
      wakeAfter?: number;
      json?: boolean;
    }) => {
      // P21 I3 调和：actor 从 seat 环境推导（X-OpenRig-Session）——--actor 已废弃且被忽略，
      // 没有 body actorSession。校验环境，否则后台服务返回 400 actor_required（没有 seat 身份可记录）。与 `resolve` 一致。
      if (!resolveCurrentSession(undefined, "actor")) return;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/update`, {
          state: "blocked",
          blockedOn: opts.on,
          summary: opts.summary,
          evidenceRef: opts.evidenceRef,
          wakeWatchdogId: opts.wakeWatchdog,
          wakeAfterSeconds: opts.wakeAfter,
          transitionNote: opts.continuation ? `continuation: ${opts.continuation}` : (opts.note ?? `parked on ${opts.on}`),
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // OPR.0.4.4.19 FR-7——resolve 动作的 CLI 包装器：后台服务写入路径的薄客户端。
  // ONE 写入路径（POST /api/mission-control/action，verb=resolve）。它的存在是为了
  // 让 proof 行走和 relay 会话在 Packet-2 表面交付之前就能脚本化；创始人的路径是
  // 表面/feed 卡片调用同一个端点。裁决回到被 PARK 的属主（同一条目上 blocked →
  // in-progress）——绝不 closure，绝不换属主。
  cmd
    .command("resolve <qitemId>")
    .description("裁决一个 leg-1 park 的 qitem（state=blocked 在人 seat 上）：把决策文本持久记录进 queue_transitions，解除 park blocked -> in-progress，并 nudge 属主。非 closure。")
    .requiredOption("--decision <text>", "人的决策文本（非空；落到 transition_note + 审计行）")
    .option("--actor <session>", "（已废弃，忽略）resolver 从 seat 环境推导（X-OpenRig-Session）")
    .option("--bearer <token>", "mission-control 写入闸门的 operator bearer token（或设 OPENRIG_AUTH_BEARER_TOKEN；未配置 bearer 的 loopback 后台服务不需要）")
    .option("--no-notify", "跳过尽力而为的属主 nudge（解除 park 仍会提交）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (qitemId: string, opts: {
      decision: string;
      actor?: string;
      bearer?: string;
      notify?: boolean;
      json?: boolean;
    }) => {
      // P21：resolver 从 seat 环境推导（X-OpenRig-Session，由 DaemonClient 盖章）——
      // --actor 已废弃且被忽略。预检查校验环境（头来源）；否则后台服务返回 400 actor_required
      // （没有 seat 身份可记录；P18 已退役 401 拒绝）。
      if (!resolveCurrentSession(undefined, "actor")) return;
      const deps = getDeps();
      const bearer = opts.bearer ?? process.env.OPENRIG_AUTH_BEARER_TOKEN;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(
          "/api/mission-control/action",
          {
            verb: "resolve",
            qitemId,
            // P21：没有 body actorSession——后台服务从传输头推导 resolver。
            decision: opts.decision,
            notify: opts.notify,
          },
          bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined,
        );
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("handoff <qitemId>")
    .description("事务性交接：把 source 关闭为 handed-off + 创建一个归属 --to 的新 qitem")
    .option("--from <session>", "（已废弃，忽略）交出的 seat 从 seat 环境推导（X-OpenRig-Session）；P21 I3 让 handoff 路由从传输头推导它")
    .requiredOption("--to <session>", "接收新 qitem 的目标 seat")
    .option("--body <text>", "内联新 qitem 正文（用 - 从 stdin 读；与 --body-file 互斥）。两者都不传则保留 source 正文。")
    .option("--body-file <path>", "从文件路径读新 qitem 正文（用 - 表示 stdin；与 --body 互斥）。消灭反引号 shell 污染这一类问题。")
    .option("--note <text>", "迁移 note")
    .option("--priority <priority>", "覆盖新 qitem 的优先级")
    .option("--tier <tier>", "覆盖新 qitem 的 tier")
    .option("--tags <tags>", "新 qitem 的逗号分隔标签")
    .option("--gate <role>", "OPR.0.4.3.16：把新 qitem 标记为 gate 工作；翻译成 gate:<role> 标签（例如 guard | spec-review）。idle-gate 看门狗读这个谓词。与 --tags 组合。")
    .option("--target-repo <name>", "PL-007：新 qitem 的带类型 repo 作用域")
    .option("--summary <text>", "OPR.0.4.1.18：给新 qitem 写一两句简短人读摘要——它是什么、为什么是这个 seat，可在 needs-you 视图扫读（--body 仍是事实来源）。缺失时警告。")
    .option("--evidence-ref <path>", "OPR.0.4.4.19 FR-5：新 qitem 的持久化产物指针。新 qitem 路由给人时由后台服务要求；否则可选。")
    .option("--host <id>", QUEUE_HOST_OPTION_HELP)
    .option("--no-nudge", "抑制对新目标的默认 nudge")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (qitemId: string, opts: {
      from?: string;
      to: string;
      body?: string;
      bodyFile?: string;
      note?: string;
      priority?: string;
      tier?: string;
      tags?: string;
      gate?: string;
      targetRepo?: string;
      summary?: string;
      evidenceRef?: string;
      host?: string;
      nudge?: boolean;
      json?: boolean;
    }) => {
      // P21 I3 调和：交出的 seat 从 seat 环境推导（X-OpenRig-Session）——--from 已废弃且被忽略，
      // 没有 body fromSession。校验环境，否则后台服务返回 400 actor_required
      // （没有 seat 身份可记录；P18 已退役 401 拒绝）。
      if (!resolveCurrentSession(undefined, "from")) return;
      // slice-08 OPR.0.4.7.8——正文输入对齐。只在提供了正文来源时才通过已交付的
      // resolveQueueBody 解析；两者都不传时保留今天的 source 正文默认（POST body 未定义）。
      // 都传/非法则在联系后台服务之前拒绝，与 create 对齐。
      let resolvedBody: string | undefined;
      if (opts.body !== undefined || opts.bodyFile !== undefined) {
        try {
          resolvedBody = await resolveQueueBody({ body: opts.body, bodyFile: opts.bodyFile });
        } catch (err) {
          emitBodyResolveError(err as Error & { fact?: string; consequence?: string; action?: string }, opts.json ?? false);
          return;
        }
      }
      // OPR.0.4.6.MH3 D-3（C3）：主机限定词在 CLI 边界解析
      // （只作用于目标 --to；--from 保持原样）。
      const hostResolved = resolveQueueHostDestination(opts.to, opts.host);
      if (!hostResolved.ok) {
        emitHostResolutionError(hostResolved, opts.json ?? false);
        return;
      }
      // OPR.0.4.1.18（FR-7）：对作者警告——handoff 写了一个新 qitem，所以它应带自己的
      // summary。打到 stderr 警告；不硬性中断。
      if (!opts.summary) {
        process.stderr.write(
          "警告：调用 zrig queue handoff 时未带 --summary。传 --summary <文本> 可设置新 qitem 简短的人读摘要；否则 Story 节点回退到有界正文预览。好的摘要是一两句平实的话，让人在 needs-you 视图里快速扫读——这项工作是什么、为什么需要这个 seat，而不是 --body 里的智能体黑话。继续执行。\n"
        );
      }
      const deps = getDeps();
      // OPR.0.4.3.16——--gate <role> 盖一个 gate:<role> 标签（与 --tags 组合，去重）。
      // 守门 code-review + spec-review handoff 用它，好让 idle-gate 看门狗的谓词有生产者。
      const explicitTags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const gateTags = opts.gate ? [`gate:${opts.gate}`] : [];
      const mergedTags = [...gateTags, ...explicitTags];
      const seenTags = new Set<string>();
      const dedupedTags = mergedTags.filter((t) => { if (seenTags.has(t)) return false; seenTags.add(t); return true; });
      const tags = dedupedTags.length > 0 ? dedupedTags : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/handoff`, {
          toSession: hostResolved.destination,
          body: resolvedBody,
          summary: opts.summary,
          evidenceRef: opts.evidenceRef,
          transitionNote: opts.note,
          priority: opts.priority,
          tier: opts.tier,
          tags,
          targetRepo: opts.targetRepo,
          nudge: opts.nudge,
          ...(hostResolved.hostId !== undefined ? { hostId: hostResolved.hostId } : {}),
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("handoff-and-complete <qitemId>")
    .description(
      "原子关闭（state=done，closure_reason=handed_off_to）+ 创建归属 --to 的新 qitem。handoff 的变体，会彻底终止 source qitem。"
    )
    .option("--from <session>", "（已废弃，忽略）交出的 seat 从 seat 环境推导（X-OpenRig-Session）；P21 I3 让 handoff 路由从传输头推导它")
    .requiredOption("--to <session>", "接收新 qitem 的目标 seat")
    .option("--body <text>", "内联新 qitem 正文（用 - 从 stdin 读；与 --body-file 互斥）。两者都不传则保留 source 正文。")
    .option("--body-file <path>", "从文件路径读新 qitem 正文（用 - 表示 stdin；与 --body 互斥）。消灭反引号 shell 污染这一类问题。")
    .option("--note <text>", "迁移 note")
    .option("--priority <priority>", "覆盖新 qitem 的优先级")
    .option("--tier <tier>", "覆盖新 qitem 的 tier")
    .option("--tags <tags>", "新 qitem 的逗号分隔标签")
    .option("--gate <role>", "OPR.0.4.3.16：把新 qitem 标记为 gate 工作；翻译成 gate:<role> 标签（例如 guard | spec-review）。idle-gate 看门狗读这个谓词。与 --tags 组合。")
    .option("--target-repo <name>", "PL-007：新 qitem 的带类型 repo 作用域")
    .option("--summary <text>", "OPR.0.4.1.18：给新 qitem 写一两句简短人读摘要——它是什么、为什么是这个 seat，可在 needs-you 视图扫读（--body 仍是事实来源）。缺失时警告。")
    .option("--evidence-ref <path>", "OPR.0.4.4.19 FR-5：新 qitem 的持久化产物指针。新 qitem 路由给人时由后台服务要求；否则可选。")
    .option("--host <id>", QUEUE_HOST_OPTION_HELP)
    .option("--no-nudge", "抑制对新目标的默认 nudge")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (qitemId: string, opts: {
      from?: string;
      to: string;
      body?: string;
      bodyFile?: string;
      note?: string;
      priority?: string;
      tier?: string;
      tags?: string;
      gate?: string;
      targetRepo?: string;
      summary?: string;
      evidenceRef?: string;
      host?: string;
      nudge?: boolean;
      json?: boolean;
    }) => {
      // P21 I3 调和：交出的 seat 从 seat 环境推导（X-OpenRig-Session）——--from 已废弃且被忽略，
      // 没有 body fromSession。校验环境，否则后台服务返回 400 actor_required
      // （没有 seat 身份可记录；P18 已退役 401 拒绝）。
      if (!resolveCurrentSession(undefined, "from")) return;
      // slice-08 OPR.0.4.7.8——正文输入对齐（与 handoff 同一契约）：
      // 只在提供正文来源时解析；两者都不传时不保留 source 正文默认；
      // 都传/非法在联系后台服务之前拒绝。
      let resolvedBody: string | undefined;
      if (opts.body !== undefined || opts.bodyFile !== undefined) {
        try {
          resolvedBody = await resolveQueueBody({ body: opts.body, bodyFile: opts.bodyFile });
        } catch (err) {
          emitBodyResolveError(err as Error & { fact?: string; consequence?: string; action?: string }, opts.json ?? false);
          return;
        }
      }
      // OPR.0.4.6.MH3 D-3（C3）：与 handoff 相同的边界解析。
      const hostResolved = resolveQueueHostDestination(opts.to, opts.host);
      if (!hostResolved.ok) {
        emitHostResolutionError(hostResolved, opts.json ?? false);
        return;
      }
      // OPR.0.4.1.18（FR-7）：对作者警告——handoff 写了一个新 qitem，所以它应带自己的
      // summary。打到 stderr 警告；不硬性中断。
      if (!opts.summary) {
        process.stderr.write(
          "警告：调用 zrig queue handoff 时未带 --summary。传 --summary <文本> 可设置新 qitem 简短的人读摘要；否则 Story 节点回退到有界正文预览。好的摘要是一两句平实的话，让人在 needs-you 视图里快速扫读——这项工作是什么、为什么需要这个 seat，而不是 --body 里的智能体黑话。继续执行。\n"
        );
      }
      const deps = getDeps();
      // OPR.0.4.3.16——--gate <role> 盖一个 gate:<role> 标签（与 --tags 组合，去重）。
      // 守门 code-review + spec-review handoff 用它，好让 idle-gate 看门狗的谓词有生产者。
      const explicitTags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
      const gateTags = opts.gate ? [`gate:${opts.gate}`] : [];
      const mergedTags = [...gateTags, ...explicitTags];
      const seenTags = new Set<string>();
      const dedupedTags = mergedTags.filter((t) => { if (seenTags.has(t)) return false; seenTags.add(t); return true; });
      const tags = dedupedTags.length > 0 ? dedupedTags : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/handoff-and-complete`, {
          toSession: hostResolved.destination,
          body: resolvedBody,
          summary: opts.summary,
          evidenceRef: opts.evidenceRef,
          transitionNote: opts.note,
          priority: opts.priority,
          tier: opts.tier,
          tags,
          targetRepo: opts.targetRepo,
          nudge: opts.nudge,
          ...(hostResolved.hostId !== undefined ? { hostId: hostResolved.hostId } : {}),
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("whoami")
    .description("从后台服务视角显示调用者的队列位置")
    .option("--session <session>", "调用者的会话名（默认 OPENRIG_SESSION_NAME）")
    .option("--recent-limit <n>", "包含多少条近期活跃 qitem", "25")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { session?: string; recentLimit: string; json?: boolean }) => {
      const session = resolveCurrentSession(opts.session, "session");
      if (!session) return;
      const deps = getDeps();
      const params = new URLSearchParams({
        session,
        recentLimit: opts.recentLimit,
      });
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/whoami?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("fallback <qitemId>")
    .description("把一个 qitem 改路由到兜底目标（例如 seat 不可达）")
    .requiredOption("--destination <session>", "兜底目标 seat")
    .option("--reason <text>", "fallback 的原因", "manual")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (qitemId: string, opts: { destination: string; reason: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/fallback`, {
          fallbackDestination: opts.destination,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("show <qitemId>")
    .description("显示一个 qitem 及其派生的等待状态（有界预览；--full 看完整正文）")
    .option("--full", "完整原始记录；可能很大（无损 JSON 用 --full --json）")
    .option("--json", "带完整度、原始字节大小和精确完整命令的 JSON 预览")
    .action(async (qitemId: string, opts: { full?: boolean; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/${encodeURIComponent(qitemId)}`);
        const json = opts.json ?? false;
        const item = res.data;
        // --full 是今天完整 item 形状的纯透传（兼容契约——正文与 0.4.3.0 之前逐字节一致）。
        // 错误响应 / 非对象负载也透传，那里没有字符串正文可预览。
        if (opts.full || res.status >= 400 || !isRecordWithStringBody(item)) {
          printResult(json, item, res.status);
          return;
        }
        const { preview, bodyBytes, bodyTruncated } = previewBody(item.body);
        // 只追加：保持 `body` 原位（现在是预览），加上诚实的大小 + 截断标志。
        // 对象其余部分不变。
        const fullCommand = `zrig queue show ${shellQuote(qitemId)} --full --json`;
        const view = readView(item, fullCommand, bodyTruncated ? [omittedReadField("body (after preview)", item.body.slice(preview.length))] : []);
        const transformed = { ...item, body: preview, bodyBytes, bodyTruncated, readView: view };
        printResult(json, transformed, res.status);
        if (!json && bodyTruncated) {
          console.log(`…（有界预览——完整正文 ${bodyBytes} 字节；完整记录 ${view.fullJsonBytes} 个 JSON 字节：${fullCommand}）`);
        }
      });
    });

  cmd
    .command("transitions <qitemId>")
    .description("显示一个 qitem 只追加的迁移日志")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (qitemId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/${encodeURIComponent(qitemId)}/transitions`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("list")
    .description("列出 qitem（默认：active + 紧凑 + 当前 rig；类似 'docker ps'）")
    .option("-a, --all", "包含已关闭/已完成历史（类似 'docker ps -a'）")
    .option("-A, --all-rigs", "跨 rig 宽度（类似 'kubectl get --all-namespaces'）")
    .option("--full", "显示每个条目的完整字段（body、chain-of-record）")
    .option("--owned", "收窄到指派给你的义务（仅 destination）")
    .option("--mine", "收窄到你是 source 或 destination 的条目，包括你撰写但不拥有的行")
    .option("-o <format>", "输出格式：json", enumArg(["json"]))
    .option("--destination <session>", "按目标会话过滤")
    .option("--source <session>", "按来源会话过滤")
    .option("--state <state>", "按状态过滤（多个用逗号分隔）")
    .option("--target-repo <name>", "PL-007：按 target_repo 过滤 qitem（精确匹配）")
    .option("--limit <n>", "结果上限", positiveIntArg, 100)
    .option("--json", "JSON 输出（紧凑；完整字段用 --full --json）")
    .addHelpText("after", `
默认：你当前 rig 里的活跃条目，紧凑摘要（类似 'docker ps'）。
当前 rig 从 OPENRIG_SESSION_NAME 的 @<rig> 后缀推导。

四个正交轴（docker/kubectl 模式）：
  -a, --all         包含已关闭/已完成历史（状态轴）
  -A, --all-rigs    跨 rig 宽度（作用域轴）
  --full            包含 body + chain-of-record（字段轴）
  -o json           JSON 输出（紧凑；完整用 --full -o json）

活跃状态：pending、in-progress、blocked。
历史（-a 增加）：done、canceled、handed-off、failed、denied。
用 --state <states> 显式选择特定状态。

深度：'zrig queue show <qitemId>' 预览一条 body；加 --full 看完整记录。
前沿来源：'zrig queue list' 是默认状态表面。

示例：
  zrig queue list                          你 rig 里的活跃条目（紧凑）
  zrig queue list -a                       包含你 rig 里的已关闭历史
  zrig queue list -A                       所有 rig 的活跃条目
  zrig queue list -a -A                    所有 rig 的全部
  zrig queue list --full                   带 body/chain 的活跃条目
  zrig queue list -o json                  紧凑 JSON（同 --json）
  zrig queue list --full -o json           完整 JSON（带 body/chain）
  zrig queue list --owned                  指派给你的义务（仅 destination）
  zrig queue list --mine                   你拥有或撰写的条目（source 或 destination 的并集）
  zrig queue list --state pending          你 rig 里仅 pending 条目
  zrig queue list --full --all --all-rigs  完整 firehose（0.4.0 之前的默认）`)
    .action(async (opts: {
      all?: boolean;
      allRigs?: boolean;
      full?: boolean;
      owned?: boolean;
      mine?: boolean;
      o?: string;
      destination?: string;
      source?: string;
      state?: string;
      targetRepo?: string;
      limit: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      const sessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
      if (opts.owned && !sessionName) {
        console.error("无法使用 --owned：已检查 OPENRIG_SESSION_NAME 和 RIGGED_SESSION_NAME，但两个调用者 seat 身份都未设置。把其中一个设为规范的 seat@rig 地址，或用 --destination <session>。");
        process.exitCode = 1;
        return;
      }
      const hasExplicitScope = !!(opts.destination || opts.source || opts.owned);

      if (opts.owned && sessionName) {
        params.set("destinationSession", sessionName);
      } else if (opts.mine && sessionName) {
        params.set("as", sessionName);
      } else if (!opts.allRigs && !hasExplicitScope) {
        const rigName = sessionName ? extractRigName(sessionName) : undefined;
        if (rigName) {
          params.set("rig", rigName);
        }
      }

      if (!opts.all) {
        params.set("activeOnly", "1");
      }
      if (!opts.full) {
        params.set("compact", "1");
      }
      if (opts.destination) params.set("destinationSession", opts.destination);
      if (opts.source) params.set("sourceSession", opts.source);
      if (opts.state) params.set("state", opts.state);
      if (opts.targetRepo) params.set("targetRepo", opts.targetRepo);
      if (opts.limit) params.set("limit", String(opts.limit));
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/list?${params.toString()}`);
        const useJson = opts.json || opts.o === "json";
        printResult(useJson, res.data, res.status);
      });
    });

  cmd
    .command("overdue")
    .description("列出超过 closure_required_at 截止时间的 in-progress qitem（当前 rig，有界，默认不带 body）")
    .option("--rig <name>", "收窄到某个 rig（默认：从 OPENRIG_SESSION_NAME 推导的当前 rig）")
    .option("-A, --all-rigs", "跨 rig 宽度（默认仅当前 rig）")
    .option("--full", "包含每个条目的完整字段（body、chain-of-record）")
    .option("--limit <n>", "结果上限", positiveIntArg, 50)
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", "\n默认：你当前 rig 里已逾期的条目，紧凑（无 body），按截止时间最新在前。\n用 --full 看 body，-A 看所有 rig，--rig <name> 指向另一个 rig。")
    .action(async (opts: { rig?: string; allRigs?: boolean; full?: boolean; limit?: number; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      // rig 作用域：显式 --rig 优先；否则当前 rig 默认，除非 -A（镜像 `list`）。
      if (opts.rig) {
        params.set("rig", opts.rig);
      } else if (!opts.allRigs) {
        const sessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
        const rigName = sessionName ? extractRigName(sessionName) : undefined;
        if (rigName) params.set("rig", rigName);
      }
      if (!opts.full) params.set("compact", "1"); // 默认不带 body
      if (opts.limit) params.set("limit", String(opts.limit));
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/overdue?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("undelivered")
    .description("列出 create 路径 nudge 失败的 PENDING qitem（投递从未到达目标；当前 rig，有界，默认不带 body）")
    .option("--rig <name>", "收窄到某个 rig（默认：从 OPENRIG_SESSION_NAME 推导的当前 rig）")
    .option("-A, --all-rigs", "跨 rig 宽度（默认仅当前 rig）")
    .option("--full", "包含每个条目的完整字段（body、chain-of-record）")
    .option("--limit <n>", "结果上限", positiveIntArg, 50)
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", "\n暴露 create 路径上的投递滞留：nudge 记录了 failed:<reason>、又没有别的东西去对账的 pending 行。只读；发送方以为投递成功，但目标从未被唤醒。\n用 --full 看 body，-A 看所有 rig，--rig <name> 指向另一个 rig。")
    .action(async (opts: { rig?: string; allRigs?: boolean; full?: boolean; limit?: number; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.rig) {
        params.set("rig", opts.rig);
      } else if (!opts.allRigs) {
        const sessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
        const rigName = sessionName ? extractRigName(sessionName) : undefined;
        if (rigName) params.set("rig", rigName);
      }
      if (!opts.full) params.set("compact", "1");
      if (opts.limit) params.set("limit", String(opts.limit));
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/undelivered?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- inbox 子命令 ----

  cmd
    .command("inbox-drop <destinationSession>")
    .description("把一个邮箱式条目投进目标的 inbox")
    // P18：sender 从 seat 环境推导（X-OpenRig-Session，由传输盖章），不是一个标志。
    // --sender 已废弃且被忽略（保留为可选，好让既有调用方不破坏）。
    .option("--sender <session>", "（已废弃，忽略）sender 从已认证的 seat 环境推导")
    .option("--body <text>", "内联 inbox 正文（用 - 从 stdin 读；与 --body-file 互斥）。")
    .option("--body-file <path>", "从文件路径读 inbox 正文（用 - 表示 stdin；与 --body 互斥）。消灭反引号 shell 污染这一类问题。")
    .option("--tags <tags>", "逗号分隔的标签")
    .option("--urgency <urgency>", "routine | urgent | critical", "routine")
    .option("--audit <pointer>", "审计指针引用")
    .option("--id <inboxId>", "幂等的 inbox_id")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (destinationSession: string, opts: {
      sender?: string; // P18：已废弃且被忽略（sender 从 seat 环境推导）
      body?: string;
      bodyFile?: string;
      tags?: string;
      urgency: string;
      audit?: string;
      id?: string;
      json?: boolean;
    }) => {
      // slice-08 OPR.0.4.7.8——inbox-drop 总是通过已交付的 resolveQueueBody 解析 body
      // （这里没有 source-body 默认）：两者都不传和都传都在联系后台服务之前拒绝；
      // --body -/--body-file - 读 stdin。
      let resolvedBody: string;
      try {
        resolvedBody = await resolveQueueBody({ body: opts.body, bodyFile: opts.bodyFile });
      } catch (err) {
        emitBodyResolveError(err as Error & { fact?: string; consequence?: string; action?: string }, opts.json ?? false);
        return;
      }
      const deps = getDeps();
      const tags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      await withClient(deps, async (client) => {
        // P18：sender 是传输推导的身份头（由 DaemonClient 从 seat 环境盖一次章），
        // 不是 body 声明/标志——后台服务会忽略任何 body 里提供的 sender。
        const res = await client.post<unknown>("/api/queue/inbox/drop", {
          inboxId: opts.id,
          destinationSession,
          body: resolvedBody,
          tags,
          urgency: opts.urgency,
          auditPointer: opts.audit,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("inbox-absorb <inboxId>")
    .description("把一条 pending 的 inbox 条目吸收进接收者的主队列")
    .requiredOption("--receiver <session>", "接收者会话（必须与 destination 匹配）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (inboxId: string, opts: { receiver: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/inbox/${encodeURIComponent(inboxId)}/absorb`, {
          receiverSession: opts.receiver,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("inbox-deny <inboxId>")
    .description("拒绝一条 pending 的 inbox 条目，并记录原因")
    .requiredOption("--receiver <session>", "接收者会话（必须与 destination 匹配）")
    .requiredOption("--reason <text>", "拒绝原因")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (inboxId: string, opts: { receiver: string; reason: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/queue/inbox/${encodeURIComponent(inboxId)}/deny`, {
          receiverSession: opts.receiver,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("inbox-pending <destinationSession>")
    .description("列出某个目标 seat 的 pending inbox 条目")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (destinationSession: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams({ destinationSession });
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/inbox/pending?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- Outbox 子命令 ----

  cmd
    .command("outbox-record")
    .description("在发送者的 outbox 里记录一次出站派发")
    .option("--sender <session>", "（已废弃，忽略）sender 从 seat 环境推导（X-OpenRig-Session）；P21 I3 让 outbox-record 路由从传输头推导它")
    .requiredOption("--destination <session>", "目标会话")
    .option("--body <text>", "内联 outbox 正文（用 - 从 stdin 读；与 --body-file 互斥）。")
    .option("--body-file <path>", "从文件路径读 outbox 正文（用 - 表示 stdin；与 --body 互斥）。消灭反引号 shell 污染这一类问题。")
    .option("--tags <tags>", "逗号分隔的标签")
    .option("--urgency <urgency>", "routine | urgent | critical", "routine")
    .option("--audit <pointer>", "审计指针引用")
    .option("--id <outboxId>", "幂等的 outbox_id")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: {
      sender?: string;
      destination: string;
      body?: string;
      bodyFile?: string;
      tags?: string;
      urgency: string;
      audit?: string;
      id?: string;
      json?: boolean;
    }) => {
      // slice-08 OPR.0.4.7.8——outbox-record 总是通过已交付的 resolveQueueBody 解析 body
      // （没有 source-body 默认）：两者都不传和都传都在联系后台服务之前拒绝；
      // --body -/--body-file - 读 stdin。
      let resolvedBody: string;
      try {
        resolvedBody = await resolveQueueBody({ body: opts.body, bodyFile: opts.bodyFile });
      } catch (err) {
        emitBodyResolveError(err as Error & { fact?: string; consequence?: string; action?: string }, opts.json ?? false);
        return;
      }
      // P21 I3 调和：sender 从 seat 环境推导（X-OpenRig-Session）——--sender 已废弃且被忽略，
      // 没有 body senderSession。校验环境，否则后台服务返回 400 actor_required
      // （没有 seat 身份可记录；P18 已退役 401 拒绝）。
      if (!resolveCurrentSession(undefined, "sender")) return;
      const deps = getDeps();
      const tags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/queue/outbox/record", {
          outboxId: opts.id,
          destinationSession: opts.destination,
          body: resolvedBody,
          tags,
          urgency: opts.urgency,
          auditPointer: opts.audit,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("outbox-list <senderSession>")
    .description("列出某个发送者 seat 的 outbox 条目")
    .option("--limit <n>", "结果上限", "100")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (senderSession: string, opts: { limit: string; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams({ senderSession, limit: opts.limit });
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/queue/outbox/list?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
