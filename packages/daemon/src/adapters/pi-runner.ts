// OPR.0.4.6.PI1——pane 承载的 pi-runner（daemon dist 中的已编译入口）。
//
// runner 让 Pi 席位表现得像普通 OpenRig tmux 席位，同时底层全部保持结构化 RPC：
//
//   pane stdin（rig send/人工输入）        ──▶ RPC prompt/steer/follow_up
//   pi RPC 事件（类型化 JSONL）            ──▶ (a) 人类可读的 pane 镜像
//                                             (b) 向后台服务 POST activity +
//                                                 session_identity
//                                             (c) runner-state.json 伴随文件
//
// BR-1：activity/session 身份只从 Pi 的类型化事件 + get_state 派生，绝不抓取 pane。
// BR-3：pi 子进程使用默认拒绝的环境 allowlist。BR-5：trust 标志始终显式。诚实失败：
// 已终止 pi 进程会输出 EXIT/ERROR 标记，并在 sidecar 中记录 `exited`，绝不静默冻结 pane。
//
// 只导入 Node 内置模块 + pi-runner-protocol，使编译入口无需后台服务依赖也能以
// `node <dist>/adapters/pi-runner.js` 运行。

import fs from "node:fs";
import nodePath from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  piSeatPaths, buildPiChildArgs, buildPiChildEnv, buildPendingRunnerState, parsePiRunnerState,
  PI_RUNNER_READY_MARKER, PI_RUNNER_EXIT_MARKER, PI_RUNNER_ERROR_MARKER,
  type PiRunnerState,
} from "./pi-runner-protocol.js";

// ── 已提交输入边界 ───────────────────────────────────────────────────────────
// canonical TTY 缓冲区可能在 Node 看到粘贴结束符前溢出。使用 Node 的 raw mode 行编辑器，
// 此处只处理粘贴 framing。
export const MAX_PI_INPUT_BYTES = 1024 * 1024;

export function createRunnerInput(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  onSubmit: (block: string) => void,
): readline.Interface {
  const reject = () => output.write(
    "[pi-runner] 输入被拒绝：最多 1048576 个 UTF-8 字节；请发送更短的消息。Ctrl-C 可清除未完成输入。\n",
  );
  const submit = (block: string) => {
    if (Buffer.byteLength(block) > MAX_PI_INPUT_BYTES) reject();
    else if (block.trim()) onSubmit(block);
  };
  // pipe 没有内核行长度限制或终端编辑；每一行就是一条消息。
  if (!input.isTTY || !output.isTTY) {
    return readline.createInterface({ input, crlfDelay: Infinity }).on("line", submit);
  }

  const keys = new PassThrough();
  const editor = readline.createInterface({
    input: keys, output, terminal: true, prompt: "", historySize: 0, crlfDelay: Infinity,
  });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let paste: string | null = null;
  let pasteBytes = 0;
  let discarded = false;
  const setLine = (line: string, cursor: number) => {
    // Node 文档要求同时修改 rl.line 与 rl.cursor。已安装类型定义将其标为 readonly，因此通过
    // 一个显式接缝为两者赋值。
    Object.assign(editor, { line, cursor });
    editor.prompt(true);
  };
  const clear = () => setLine("", 0);
  const submitLine = () => {
    const line = editor.line;
    clear();
    submit(line);
  };
  const writeEditingText = (text: string) => {
    for (let index = 0; index < text.length; index++) {
      const rest = text.slice(index);
      if (rest.startsWith("\u001b[D")) {
        setLine(editor.line, Math.max(0, editor.cursor - 1));
        index += 2;
      } else if (rest.startsWith("\u001b[C")) {
        setLine(editor.line, Math.min(editor.line.length, editor.cursor + 1));
        index += 2;
      } else if (text[index] === "\u007f" || text[index] === "\b") {
        if (editor.cursor > 0) {
          setLine(
            editor.line.slice(0, editor.cursor - 1) + editor.line.slice(editor.cursor),
            editor.cursor - 1,
          );
        }
      } else if (text[index] === "\u0015") {
        setLine(editor.line.slice(editor.cursor), 0);
      } else if (text[index] === "\r" || text[index] === "\n") {
        if (text[index] === "\r" && text[index + 1] === "\n") index += 1;
        submitLine();
      } else if (text[index] === "\u0004") {
        editor.close();
      } else {
        const character = text[index]!;
        setLine(
          editor.line.slice(0, editor.cursor) + character + editor.line.slice(editor.cursor),
          editor.cursor + character.length,
        );
      }
    }
  };
  const consume = (text: string) => {
    if (paste === null) {
      // Node 24 不再为合成 TTY 流解释部分编辑控制序列；在 framing 层同步应用最小的
      // 光标、删除、提交与 EOF 语义，使真实终端与隔离测试行为一致。
      writeEditingText(text);
    } else if (!discarded) {
      pasteBytes += Buffer.byteLength(text);
      if (pasteBytes > MAX_PI_INPUT_BYTES) {
        paste = "";
        discarded = true;
        clear();
        reject();
      } else paste += text;
    }
  };
  const receive = (chunk: Buffer) => {
    pending += decoder.write(chunk);
    while (pending) {
      const marker = paste === null ? "\u001b[200~" : "\u001b[201~";
      const boundary = pending.indexOf(marker);
      const interrupt = pending.indexOf("\u0003");
      const at = boundary < 0 ? interrupt : interrupt < 0 ? boundary : Math.min(boundary, interrupt);
      if (at < 0) {
        // 只保留可能被拆分的 marker；普通编辑按键交给 Node。
        let tail = Math.min(marker.length - 1, pending.length);
        while (tail && !marker.startsWith(pending.slice(-tail))) tail--;
        consume(pending.slice(0, pending.length - tail));
        pending = pending.slice(pending.length - tail);
        break;
      }
      consume(pending.slice(0, at));
      pending = pending.slice(at + (at === interrupt ? 1 : marker.length));
      if (at === interrupt) {
        paste = null;
        discarded = false;
        clear();
        output.write("\n[pi-runner] 输入已清除\n");
        onSubmit("/abort");
      } else if (paste === null) {
        paste = "";
        pasteBytes = 0;
        discarded = false;
      } else {
        if (!discarded) {
          const line = editor.line.slice(0, editor.cursor) + paste + editor.line.slice(editor.cursor);
          if (Buffer.byteLength(line) > MAX_PI_INPUT_BYTES) { clear(); reject(); }
          else {
            // rl.write(text) 会把粘贴内容中的换行当作提交。通过这些公开编辑字段插入完整字面
            // 粘贴内容，而不提交。
            setLine(line, editor.cursor + paste.length);
          }
        }
        paste = null;
      }
    }
  };
  const wasRaw = input.isRaw;
  const end = () => editor.close();
  input.setRawMode(true);
  output.write("\u001b[?2004h");
  input.on("data", receive);
  input.once("end", end);
  editor.on("line", submit);
  editor.once("close", () => {
    input.removeListener("data", receive);
    input.removeListener("end", end);
    input.setRawMode(wasRaw);
    input.pause();
    keys.destroy();
    output.write("\u001b[?2004l");
  });
  return editor;
}

// ── Pi event → mirror + activity 映射（纯逻辑、可隔离测试）──────────────────

export interface MirrorAndActivity {
  /** 要输出到 pane 的行（已是人类可读文本）。 */
  mirrorLines: string[];
  /** 追加到当前镜像行的原始文本（流式增量）。 */
  mirrorAppend?: string;
  /** 事件可映射时对应的 Activity POST payload（hookEvent/subtype）。 */
  activity?: { hookEvent: string; subtype: string | null };
  /** 事件携带时对应的流式状态转换。 */
  streaming?: boolean;
  /** 类型化终端失败；core 会合并其重试耗尽通知。 */
  errorNotice?: string;
}

function errorNotice(detail: unknown): string {
  const text = typeof detail === "string"
    ? stripVTControlCharacters(detail).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim()
    : "";
  return `${PI_RUNNER_ERROR_MARKER} ${text.slice(0, 400) || "请求失败"}`;
}

export function mapPiEvent(event: Record<string, unknown>): MirrorAndActivity {
  const type = typeof event.type === "string" ? event.type : "";
  switch (type) {
    case "agent_start":
      return { mirrorLines: [], activity: { hookEvent: "active", subtype: "agent_start" }, streaming: true };
    case "agent_end":
      return { mirrorLines: [""], activity: { hookEvent: "Stop", subtype: "agent_end" }, streaming: false };
    case "turn_start":
    case "turn_end":
    case "message_start":
      return { mirrorLines: [] };
    case "message_update": {
      // Pi 把助手文本流式输出为 `assistantMessageEvent` text_delta 记录。只镜像 delta：Pi 0.84.0
      // 从 RPC message_update 中移除了累积 `message`，而旧版 Pi 会将它与同一 delta 一起发送，
      // 追加它会重复不断增长的文本。Thinking 与工具调用参数 delta 不进入 pane；工具调用从
      // tool_execution_* 获取自己的单行摘要。
      const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
      const delta = update?.type === "text_delta" && typeof update.delta === "string" ? update.delta : "";
      return delta ? { mirrorLines: [], mirrorAppend: delta } : { mirrorLines: [] };
    }
    case "message_end": {
      // 消息文本已通过 message_update 追加流式传输；此处结束该行。（mapPiEvent 无状态，
      // 因此假设的 update 未携带内容情形属于 VM 校准后续项，不在此静默猜测。）
      const message = event.message as Record<string, unknown> | undefined;
      return {
        mirrorLines: [""],
        ...(message?.role === "assistant" && message.stopReason === "error"
          ? { errorNotice: errorNotice(message.errorMessage) } : {}),
      };
    }
    case "tool_execution_start": {
      const tool = typeof event.toolName === "string" ? event.toolName : (typeof event.name === "string" ? event.name : "tool");
      return { mirrorLines: [`  ⚙ ${tool} …`], activity: { hookEvent: "PreToolUse", subtype: tool } };
    }
    case "tool_execution_end": {
      const tool = typeof event.toolName === "string" ? event.toolName : (typeof event.name === "string" ? event.name : "tool");
      const failed = event.isError === true || event.error != null;
      return { mirrorLines: [`  ⚙ ${tool} ${failed ? "失败" : "完成"}`] };
    }
    case "queue_update":
      return { mirrorLines: [] };
    case "compaction_start":
      return { mirrorLines: ["[pi] 正在压缩上下文…"], activity: { hookEvent: "active", subtype: "compaction" } };
    case "compaction_end":
      return { mirrorLines: ["[pi] 上下文压缩完成"] };
    case "auto_retry_start":
      return { mirrorLines: ["[pi] 瞬态错误——正在重试"], activity: { hookEvent: "active", subtype: "auto_retry" } };
    case "auto_retry_end":
      return event.success === false
        ? { mirrorLines: [""], errorNotice: errorNotice(event.finalError) }
        : { mirrorLines: [] };
    case "extension_error": {
      const message = typeof event.message === "string" ? event.message : "扩展错误";
      return { mirrorLines: [`${PI_RUNNER_ERROR_MARKER} 扩展：${message}`] };
    }
    default:
      return { mirrorLines: [] };
  }
}

// ── Runner core（注入 effect；拥有协议状态）─────────────────────────────────

export interface RunnerIo {
  /** 向 pi stdin 写入一条 JSONL 命令。 */
  sendRpc(cmd: Record<string, unknown>): void;
  /** 向 pane 输出完整一行。 */
  mirrorLine(line: string): void;
  /** 向当前 pane 行追加原始文本（流式增量）。 */
  mirrorAppend(text: string): void;
  /** 向后台服务 activity endpoint 发出无需等待响应的 POST。 */
  postActivity(payload: Record<string, unknown>): void;
  /** 持久化 runner-state sidecar。 */
  writeSidecar(state: PiRunnerState): void;
  now(): string;
}

const GET_STATE_ID = "pi-runner-get-state";
const CATCH_UP_ID = "pi-runner-catch-up";
const CURSOR_REFRESH_ID = "pi-runner-cursor-refresh";

export class RunnerCore {
  private streaming = false;
  private sessionFile: string | undefined;
  private sessionId: string | undefined;
  private lastEntryId: string | undefined;
  private ready = false;
  private assistantErrorShown = false;

  constructor(
    private io: RunnerIo,
    private identity: { sessionName: string; nodeId?: string; launchId?: string; generation?: string },
    private opts: { catchUpSince?: string } = {},
  ) {
    // 持久游标从继承值初始化（FR-5），使当前实例自己的 sidecar 写入在较新条目取代它之前，
    // 绝不会将其退化为 undefined。
    this.lastEntryId = opts.catchUpSince;
  }

  /** 启动身份捕获；pi RPC 流建立后调用一次。 */
  start(): void {
    this.io.sendRpc({ type: "get_state", id: GET_STATE_ID });
    if (this.opts.catchUpSince) {
      // 持久追赶游标（FR-5）：重放上一 runner 实例尚未投影的 session 条目。只做 mirror；
      // activity 状态仅为实时信号。
      this.io.sendRpc({ type: "get_entries", since: this.opts.catchUpSince, id: CATCH_UP_ID });
    }
  }

  /** 来自 pi stdout 的一条 LF 分隔 JSONL 记录。 */
  handlePiLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
      record = parsed as Record<string, unknown>;
    } catch {
      // pi stdout 上的非 JSON 噪声——原样镜像，避免隐藏信息。
      this.io.mirrorLine(line);
      return;
    }

    if (record.type === "response") {
      this.handleResponse(record);
      return;
    }
    this.handleEvent(record);
  }

  /** 来自 pane stdin 的一个聚合粘贴块。 */
  handleUserBlock(block: string): void {
    if (block === "/abort") {
      this.io.sendRpc({ type: "abort" });
      this.io.mirrorLine("[pi-runner] 已发送 abort");
      return;
    }
    if (block.startsWith("/followup ")) {
      const message = block.slice("/followup ".length);
      this.io.sendRpc({ type: "follow_up", message });
      this.io.mirrorLine(`你（后续）▸ ${message}`);
      return;
    }
    if (this.streaming) {
      // 流中：steer 在当前轮次工具调用后、下一次模型调用前投递（Pi 的文档语义）。
      this.io.sendRpc({ type: "steer", message: block });
      this.io.mirrorLine(`你（引导）▸ ${block}`);
      return;
    }
    this.io.sendRpc({ type: "prompt", message: block });
    this.io.mirrorLine(`你 ▸ ${block}`);
  }

  /** Pi 进程退出——如实、明确、持久。 */
  handlePiExit(code: number | null): void {
    this.ready = false;
    this.io.mirrorLine(`${PI_RUNNER_EXIT_MARKER} pi 已退出（退出码 ${code ?? "未知"}）`);
    this.writeSidecar({ exited: { code, at: this.io.now() } });
    this.io.postActivity(this.activityPayload("Stop", "pi_exited"));
  }

  private handleResponse(record: Record<string, unknown>): void {
    if (record.id === GET_STATE_ID) {
      const data = (record.data ?? record.state ?? record) as Record<string, unknown>;
      const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : undefined;
      const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
      this.sessionFile = sessionFile ?? this.sessionFile;
      this.sessionId = sessionId ?? this.sessionId;
      this.ready = true;
      this.writeSidecar({});
      this.io.mirrorLine(`${PI_RUNNER_READY_MARKER} session=${this.sessionFile ?? "未知"}`);
      this.io.postActivity({
        eventFamily: "session_identity",
        sessionName: this.identity.sessionName,
        nodeId: this.identity.nodeId ?? null,
        generation: this.identity.generation ?? null,
        runtime: "pi",
        hookEvent: "SessionStart",
        sessionId: this.sessionId ?? "unknown",
        sessionFile: this.sessionFile ?? null,
        occurredAt: this.io.now(),
      });
      return;
    }
    if (record.id === CURSOR_REFRESH_ID || record.id === CATCH_UP_ID) {
      const data = (record.data ?? record) as Record<string, unknown>;
      const entries = Array.isArray(data.entries) ? data.entries : (Array.isArray(record.entries) ? record.entries : []);
      const last = entries.at(-1);
      const lastId = last !== null && typeof last === "object" && typeof (last as Record<string, unknown>).id === "string"
        ? (last as Record<string, unknown>).id as string
        : undefined;
      if (lastId) {
        this.lastEntryId = lastId;
        this.writeSidecar({});
      }
      return;
    }
    // 其他响应（prompt 已接受等）——展示错误。
    if (record.success === false || record.error != null) {
      const message = typeof record.error === "string" ? record.error : "请求失败";
      this.io.mirrorLine(`${PI_RUNNER_ERROR_MARKER} rpc: ${message}`);
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const message = event.message as Record<string, unknown> | undefined;
    if (event.type === "agent_start" || (event.type === "message_start" && message?.role === "assistant")) {
      this.assistantErrorShown = false;
    }
    // 持久游标：任何携带 session-entry id 的事件都会推进它。
    const entryId = typeof event.entryId === "string" ? event.entryId : (typeof event.id === "string" ? event.id : undefined);
    if (entryId) {
      this.lastEntryId = entryId;
      this.writeSidecar({});
    }

    const mapped = mapPiEvent(event);
    if (mapped.streaming !== undefined) this.streaming = mapped.streaming;
    if (event.type === "agent_end") {
      // QA RED fold（qitem-20260707020922）：实时事件不可靠地携带 session-entry id，导致持久
      // 游标断粮（真实运行中 lastEntryId 一直为 null）。每个完成轮次后从事实源刷新：get_entries
      // 返回带稳定 id 的追加顺序条目；响应处理器从尾部推进游标。
      this.io.sendRpc({ type: "get_entries", id: CURSOR_REFRESH_ID });
    }
    if (mapped.mirrorAppend) this.io.mirrorAppend(mapped.mirrorAppend);
    for (const line of mapped.mirrorLines) this.io.mirrorLine(line);
    if (mapped.errorNotice) {
      // Pi 在重试耗尽时可能再次报告同一失败消息。即使 finalError 缺失也保留第一条有效细节；
      // 在下一条 assistant 消息/智能体轮次重置，而不是在 agent_end 重置。
      if (event.type !== "auto_retry_end" || !this.assistantErrorShown) {
        this.io.mirrorLine(mapped.errorNotice);
      }
      this.assistantErrorShown = true;
    }
    if (mapped.activity) {
      this.io.postActivity(this.activityPayload(mapped.activity.hookEvent, mapped.activity.subtype));
    }
  }

  private activityPayload(hookEvent: string, subtype: string | null): Record<string, unknown> {
    return {
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      generation: this.identity.generation ?? null,
      runtime: "pi",
      hookEvent,
      subtype,
      occurredAt: this.io.now(),
    };
  }

  private writeSidecar(patch: Partial<PiRunnerState>): void {
    this.io.writeSidecar({
      ready: this.ready,
      // 启动尝试范围：每次写入都盖章，使后台服务能区分当前 runner 实例的事实与陈旧产物。
      launchId: this.identity.launchId,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      lastEntryId: this.lastEntryId,
      updatedAt: this.io.now(),
      ...patch,
    });
  }
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

interface RunnerArgs {
  sessionName: string;
  stateRoot: string;
  cwd: string;
  launchId: string;
  model?: string;
  trust: "approve" | "no-approve";
  sessionFile?: string;
  forkRef?: string;
}

export function parseRunnerArgs(argv: string[]): RunnerArgs {
  const args: Partial<RunnerArgs> & { trust?: "approve" | "no-approve" } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} 需要一个值`);
      return value;
    };
    switch (flag) {
      case "--session-name": args.sessionName = next(); break;
      case "--state-root": args.stateRoot = next(); break;
      case "--cwd": args.cwd = next(); break;
      case "--launch-id": args.launchId = next(); break;
      case "--model": args.model = next(); break;
      case "--session": args.sessionFile = next(); break;
      case "--fork": args.forkRef = next(); break;
      case "--approve": args.trust = "approve"; break;
      case "--no-approve": args.trust = "no-approve"; break;
      default: throw new Error(`未知标志：${flag}`);
    }
  }
  if (!args.sessionName) throw new Error("必须提供 --session-name");
  if (!args.stateRoot) throw new Error("必须提供 --state-root");
  if (!args.cwd) throw new Error("必须提供 --cwd");
  if (!args.launchId) throw new Error("必须提供 --launch-id（启动尝试范围）");
  if (!args.trust) throw new Error("必须显式提供 trust 标志：--approve 或 --no-approve");
  if (args.sessionFile && args.forkRef) throw new Error("--session 与 --fork 互斥");
  return args as RunnerArgs;
}

function resolveActivityEndpoint(env: NodeJS.ProcessEnv): { baseUrl: string; token: string } | null {
  let baseUrl = env.OPENRIG_URL?.trim() || null;
  let token = env.OPENRIG_ACTIVITY_HOOK_TOKEN?.trim() || null;
  if (!baseUrl && env.OPENRIG_PORT) {
    baseUrl = `http://${env.OPENRIG_HOST?.trim() || "127.0.0.1"}:${env.OPENRIG_PORT.trim()}`;
  }
  if (!baseUrl || !token) {
    try {
      const home = env.OPENRIG_HOME?.trim() || nodePath.join(process.env.HOME ?? "", ".openrig");
      const parsed = JSON.parse(fs.readFileSync(nodePath.join(home, "activity-endpoint.json"), "utf8"));
      if (!baseUrl && typeof parsed.baseUrl === "string") baseUrl = parsed.baseUrl;
      if (!token && typeof parsed.token === "string") token = parsed.token;
    } catch {
      // 缺失/格式错误——activity POST 为空操作；sidecar + mirror 仍可工作。
    }
  }
  return baseUrl && token ? { baseUrl, token } : null;
}

/** runner 侧 sidecar 握手，为隔离测试抽出（守卫重新裁定，qitem-20260707013815）：先读取
 * 旧记录的持久游标，再盖启动范围 pending 记录；写入会向前携带游标，使链中任何重置都无法清除。
 * `catchUpSince` 只在 resuming 时公开：fresh/fork session 没有需要追赶的先前投影。 */
export function prepareRunnerSidecar(
  fsOps: { readFile(p: string): string; writeFile(p: string, c: string): void; exists(p: string): boolean },
  runnerStatePath: string,
  launchId: string,
  resuming: boolean,
  now: () => string,
): { catchUpSince: string | undefined } {
  let prior: PiRunnerState | null = null;
  try {
    prior = fsOps.exists(runnerStatePath) ? parsePiRunnerState(fsOps.readFile(runnerStatePath)) : null;
  } catch { /* 旧 sidecar 不可读——视为缺失。 */ }
  try {
    fsOps.writeFile(runnerStatePath, JSON.stringify(buildPendingRunnerState(launchId, now(), prior)));
  } catch { /* 尽力而为；adapter 会预写等价的 pending 记录。 */ }
  return { catchUpSince: resuming ? prior?.lastEntryId : undefined };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: RunnerArgs;
  try {
    args = parseRunnerArgs(argv);
  } catch (err) {
    console.error(`${PI_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const paths = piSeatPaths(args.stateRoot, args.sessionName);
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });

  const { catchUpSince } = prepareRunnerSidecar(
    {
      readFile: (p) => fs.readFileSync(p, "utf8"),
      writeFile: (p, c) => fs.writeFileSync(p, c),
      exists: (p) => fs.existsSync(p),
    },
    paths.runnerStatePath,
    args.launchId,
    !!args.sessionFile,
    () => new Date().toISOString(),
  );

  const endpoint = resolveActivityEndpoint(process.env);
  const childEnv = buildPiChildEnv(process.env as Record<string, string | undefined>, {
    agentDir: paths.agentDir,
    sessionsDir: paths.sessionsDir,
    model: args.model,
  });
  const childArgs = buildPiChildArgs({
    sessionsDir: paths.sessionsDir,
    sessionName: args.sessionName,
    model: args.model,
    trust: args.trust,
    sessionFile: args.sessionFile,
    forkRef: args.forkRef,
  });

  console.log(`[pi-runner] 正在启动 pi --mode rpc（席位 ${args.sessionName}）`);
  console.log(`[pi-runner] 请正常发送文本；前缀："/followup <text>" 在当前轮次后排队，"/abort" 取消`);

  const child = spawn("pi", childArgs, {
    cwd: args.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const io: RunnerIo = {
    sendRpc: (cmd) => {
      try { child.stdin.write(`${JSON.stringify(cmd)}\n`); } catch { /* 由退出处理器报告。 */ }
    },
    mirrorLine: (line) => process.stdout.write(`${line}\n`),
    mirrorAppend: (text) => process.stdout.write(text),
    postActivity: (payload) => {
      if (!endpoint || typeof fetch !== "function") return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      fetch(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => { /* 尽力而为——绝不阻塞循环。 */ }).finally(() => clearTimeout(timeout));
    },
    writeSidecar: (state) => {
      try {
        fs.writeFileSync(paths.runnerStatePath, JSON.stringify(state));
      } catch { /* 尽力而为；adapter 回退到 pane 标记。 */ }
    },
    now: () => new Date().toISOString(),
  };

  const core = new RunnerCore(io, {
    sessionName: args.sessionName, nodeId: process.env.OPENRIG_NODE_ID, launchId: args.launchId,
    // 携带发出事件的 tenure；绝不从后续后台服务读取或 Pi 事件推断。
    generation: process.env.OPENRIG_OCCUPANT_GENERATION,
  }, { catchUpSince });

  readline.createInterface({ input: child.stdout }).on("line", (line) => core.handlePiLine(line));
  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    if (line.trim()) process.stdout.write(`[pi:err] ${line}\n`);
  });
  const input = createRunnerInput(process.stdin, process.stdout, (block) => core.handleUserBlock(block));

  child.on("error", (err) => {
    console.error(`${PI_RUNNER_ERROR_MARKER} 启动 pi 失败：${err.message}`);
    core.handlePiExit(null);
    input.close();
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    core.handlePiExit(code);
    input.close();
    process.exitCode = code ?? 1;
  });

  core.start();
}

// 已编译入口守卫：仅在直接执行时运行 main()，测试导入时不运行。直接执行时，import.meta.url
// 等于 process.argv[1] 的文件 URL。
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    // pathToFileURL 处理百分号编码（空格等）的方式与 import.meta.url 一致；手工构造的
    // `file://${path}` 字符串做不到。
    return import.meta.url === pathToFileURL(nodePath.resolve(entry)).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void main();
}
