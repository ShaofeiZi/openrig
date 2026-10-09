// OPR.0.4.6.PI1——pi-runner 核心的密闭单元测试：已提交粘贴的边界（包括延迟多行发送）、
// stdin→RPC 路由（idle→prompt / streaming→steer / 前缀约定）、事件→镜像与事件→活动映射、
// get_state 身份捕获 + sidecar、持久化补偿游标，以及如实报告 Pi 退出。不使用实时 Pi。

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  createRunnerInput, MAX_PI_INPUT_BYTES, RunnerCore, mapPiEvent, parseRunnerArgs,
  prepareRunnerSidecar,
  type RunnerIo,
} from "../src/adapters/pi-runner.js";
import { PI_RUNNER_READY_MARKER, PI_RUNNER_EXIT_MARKER, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

const SESSION = "devpi-a@some-rig";
const SESSION_FILE = "/state/pi/devpi-a@some-rig/sessions/2026_0197.jsonl";

function fakeIo() {
  const rpc: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const appends: string[] = [];
  const activity: Record<string, unknown>[] = [];
  const sidecars: PiRunnerState[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => rpc.push(cmd),
    mirrorLine: (line) => lines.push(line),
    mirrorAppend: (text) => appends.push(text),
    postActivity: (payload) => activity.push(payload),
    writeSidecar: (state) => sidecars.push(state),
    now: () => "2026-07-06T10:00:00Z",
  };
  return { io, rpc, lines, appends, activity, sidecars };
}

function readyCore(f = fakeIo()) {
  const core = new RunnerCore(f.io, { sessionName: SESSION, nodeId: "node-1", launchId: "launch-77" });
  core.start();
  core.handlePiLine(JSON.stringify({
    type: "response", id: "pi-runner-get-state",
    data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" },
  }));
  return { core, ...f };
}

// ── 实际 Node 行编辑器 + 帧化输入 ───────────────────────────────────────────

describe("运行器输入", () => {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  function terminal(onSubmit?: (s: string) => void) {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
      setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const blocks: string[] = [];
    let screen = "";
    output.on("data", chunk => { screen += chunk.toString(); });
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream, s => { blocks.push(s); onSubmit?.(s); });
    return { input, output, editor, blocks, screen: () => screen };
  }

  it.each([1011, 1012, 1023, 2048, 16384])("accepts %i bytes then abort and next", size => {
    const t = terminal();
    try {
      t.input.write(start + "x".repeat(size) + end + "\r");
      t.input.write("/abort\rnext\r");
      expect(t.blocks).toEqual(["x".repeat(size), "/abort", "next"]);
      expect(t.input.setRawMode).toHaveBeenCalledWith(true);
    } finally { t.editor.close(); }
    expect(t.input.isRaw).toBe(false);
  });

  it("暂存延迟粘贴，并保留空白、Unicode 和 CRLF 字节", () => {
    vi.useFakeTimers();
    const t = terminal();
    try {
      t.input.write(start + " \n café\r\n\n日本語 ");
      vi.advanceTimersByTime(60_000);
      expect(t.blocks).toEqual([]);
      t.input.write(end);
      expect(t.blocks).toEqual([]);
      t.input.write("\r");
      expect(t.blocks).toEqual([" \n café\r\n\n日本語 "]);
    } finally { t.editor.close(); vi.useRealTimers(); }
  });

  it("跨单字节分块重新组装 UTF-8 和标记", () => {
    const t = terminal();
    try {
      for (const byte of Buffer.from(start + "café\n日本語" + end)) t.input.write(Buffer.from([byte]));
      expect(t.blocks).toEqual([]);
      t.input.write("\r");
      expect(t.blocks).toEqual(["café\n日本語"]);
    } finally { t.editor.close(); }
  });

  it("保留混合键入/粘贴、光标插入、退格和清行行为", () => {
    const t = terminal();
    try {
      t.input.write("prefix " + start + "paste\n café " + end + " suffix\r");
      t.input.write("ac\u001b[Db\r"); // Node's left-arrow editing.
      t.input.write("removeX\u007f\r");
      t.input.write("clear this\u0015kept\r");
      expect(t.blocks).toEqual(["prefix paste\n café  suffix", "abc", "remove", "kept"]);
    } finally { t.editor.close(); }
  });

  it("在当前核心路由下保持快速提交相互独立", () => {
    const { core, rpc } = readyCore();
    const t = terminal(s => core.handleUserBlock(s));
    try {
      t.input.write(start + "first" + end + "\r");
      core.handlePiLine(JSON.stringify({ type: "agent_start" }));
      t.input.write(start + "second" + end + "\r/followup later\r/abort\r");
      expect(rpc.filter(x => ["prompt", "steer", "follow_up", "abort"].includes(String(x.type)))).toEqual([
        { type: "prompt", message: "first" }, { type: "steer", message: "second" },
        { type: "follow_up", message: "later" }, { type: "abort" },
      ]);
    } finally { t.editor.close(); }
  });

  it("Ctrl-C 取消未完成的粘贴，并使下一次输入仍可到达", () => {
    const t = terminal();
    try {
      t.input.write(start + "unfinished\n/abort\r");
      expect(t.blocks).toEqual([]); // Text in a paste is content, not a command.
      t.input.write("\u0003");
      expect(t.blocks).toEqual(["/abort"]);
      t.input.write(start + "next" + end + "\r");
      expect(t.blocks).toEqual(["/abort", "next"]);
      expect(t.screen()).toContain("输入已清除");
    } finally { t.editor.close(); }
  });

  it("拒绝超大粘贴且不提交前缀；控制状态可恢复", () => {
    const t = terminal();
    try {
      t.input.write("prefix " + start + "x".repeat(MAX_PI_INPUT_BYTES + 1));
      expect(t.screen()).toContain("输入被拒绝");
      expect(t.blocks).toEqual([]);
      t.input.write(end + "\r/abort\rnext\r");
      expect(t.blocks).toEqual(["/abort", "next"]);
      t.input.write(start + "x".repeat(MAX_PI_INPUT_BYTES + 1) + "\u0003next again\r");
      expect(t.blocks.slice(-2)).toEqual(["/abort", "next again"]);
    } finally { t.editor.close(); }
  });

  it("不回显帧标记或提交空输入；EOF 恢复 raw 模式", () => {
    const t = terminal();
    t.input.write("\r" + start + end + "\r");
    expect(t.blocks).toEqual([]);
    expect(t.screen()).not.toContain(start);
    expect(t.screen()).not.toContain(end);
    t.input.write("\u0004");
    expect(t.input.isRaw).toBe(false);
  });

  it("非终端输入使用换行分隔消息", () => {
    const input = new PassThrough(), output = new PassThrough(), blocks: string[] = [];
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream, block => blocks.push(block));
    input.write(" \nraw one\nraw two\n");
    expect(blocks).toEqual(["raw one", "raw two"]);
    input.end(); editor.close();
  });
});

// ── stdin → RPC 路由 ─────────────────────────────────────────────────────────

describe("RunnerCore.handleUserBlock", () => {
  it("idle → RPC prompt", () => {
    const { core, rpc } = readyCore();
    core.handleUserBlock("hello pi");
    expect(rpc.at(-1)).toEqual({ type: "prompt", message: "hello pi" });
  });

  it("streaming → RPC steer（Pi 文档规定的流中投递）", () => {
    const { core, rpc } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handleUserBlock("change course");
    expect(rpc.at(-1)).toEqual({ type: "steer", message: "change course" });
  });

  it("agent_end 后恢复为 prompt", () => {
    const { core, rpc } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    core.handleUserBlock("next task");
    expect(rpc.at(-1)).toEqual({ type: "prompt", message: "next task" });
  });

  it("/abort → RPC abort；/followup → RPC follow_up", () => {
    const { core, rpc } = readyCore();
    core.handleUserBlock("/abort");
    expect(rpc.at(-1)).toEqual({ type: "abort" });
    core.handleUserBlock("/followup after this turn");
    expect(rpc.at(-1)).toEqual({ type: "follow_up", message: "after this turn" });
  });
});

// ── 身份捕获 + sidecar + 补偿游标 ────────────────────────────────────────────

describe("RunnerCore 身份 + sidecar", () => {
  it("get_state 响应 → READY 标记 + sidecar + 带 sessionFile 的 session_identity POST", () => {
    const { lines, activity, sidecars } = readyCore();
    expect(lines.some((l) => l.startsWith(PI_RUNNER_READY_MARKER))).toBe(true);
    const sidecar = sidecars.at(-1)!;
    expect(sidecar).toMatchObject({ ready: true, launchId: "launch-77", sessionFile: SESSION_FILE, sessionId: "0197a2f0" });
    const identity = activity.find((a) => a.eventFamily === "session_identity")!;
    expect(identity).toMatchObject({
      runtime: "pi", sessionName: SESSION, sessionId: "0197a2f0", sessionFile: SESSION_FILE,
    });
  });

  it("start() 带补偿游标时发出含 since 的 get_entries（持久化补偿，FR-5）", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION }, { catchUpSince: "entry-42" });
    core.start();
    expect(f.rpc).toContainEqual({ type: "get_entries", since: "entry-42", id: "pi-runner-catch-up" });
  });

  it("携带条目标识的事件推进 sidecar 游标", () => {
    const { core, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start", entryId: "entry-7" }));
    expect(sidecars.at(-1)!.lastEntryId).toBe("entry-7");
  });

  it("Pi 退出 → EXIT 标记 + sidecar exited + idle 活动（如实且不冻结）", () => {
    const { core, lines, sidecars, activity } = readyCore();
    core.handlePiExit(1);
    expect(lines.some((l) => l.startsWith(PI_RUNNER_EXIT_MARKER))).toBe(true);
    expect(sidecars.at(-1)!.exited).toEqual({ code: 1, at: "2026-07-06T10:00:00Z" });
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "pi_exited" });
  });

  it("逐字镜像非 JSON 的 Pi stdout 噪声，绝不吞掉", () => {
    const { core, lines } = readyCore();
    core.handlePiLine("some stray warning");
    expect(lines).toContain("some stray warning");
  });
});

// ── 事件 → 镜像 / 活动映射 ──────────────────────────────────────────────────

// 数据结构来自真实的 `pi --mode rpc` 0.87.1 运行（OpenRig 子进程参数），该运行从本地
// OpenAI 兼容模拟服务流式返回回复。自 Pi 0.84.0 起，message_update 只携带 `usage`
// 与 `assistantMessageEvent` 增量。
const PI_USAGE = {
  input: 12, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 17,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const PI_REPLY = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "User wants a greeting.", thinkingSignature: "reasoning_content" },
    { type: "text", text: "Hello from the mock server." },
  ],
  api: "openai-completions", provider: "mock", model: "mock-model", usage: PI_USAGE,
  stopReason: "stop", timestamp: 1790281248272, responseId: "chatcmpl-mock",
};
const piUpdate = (assistantMessageEvent: Record<string, unknown>) =>
  ({ type: "message_update", usage: PI_USAGE, assistantMessageEvent });
const PI_REPLY_EVENTS = [
  { type: "message_start", message: { ...PI_REPLY, content: [], stopReason: "pending" } },
  piUpdate({ type: "thinking_start", contentIndex: 0 }),
  piUpdate({ type: "thinking_delta", contentIndex: 0, delta: "User wants a greeting." }),
  piUpdate({ type: "text_start", contentIndex: 1 }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: "Hello" }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: " from the" }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: " mock server." }),
  piUpdate({ type: "thinking_end", contentIndex: 0, content: "User wants a greeting." }),
  piUpdate({ type: "text_end", contentIndex: 1, content: "Hello from the mock server." }),
  { type: "message_end", message: PI_REPLY },
];

describe("mapPiEvent", () => {
  it("agent_start/agent_end 驱动 streaming + running/idle 活动", () => {
    expect(mapPiEvent({ type: "agent_start" })).toMatchObject({
      streaming: true, activity: { hookEvent: "active", subtype: "agent_start" },
    });
    expect(mapPiEvent({ type: "agent_end" })).toMatchObject({
      streaming: false, activity: { hookEvent: "Stop", subtype: "agent_end" },
    });
  });

  it("0.84 之前的 message_update 只追加增量，绝不追加累计消息", () => {
    const partial = { ...PI_REPLY, content: [{ type: "text", text: "Hello from the" }], stopReason: "pending" };
    const legacy = mapPiEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " from the", partial },
    });
    expect(legacy.mirrorAppend).toBe(" from the");
  });

  it("工具执行渲染紧凑单行摘要 + PreToolUse 活动", () => {
    const start = mapPiEvent({ type: "tool_execution_start", toolName: "bash" });
    expect(start.mirrorLines[0]).toContain("bash");
    expect(start.activity).toEqual({ hookEvent: "PreToolUse", subtype: "bash" });
    const failed = mapPiEvent({ type: "tool_execution_end", toolName: "bash", isError: true });
    expect(failed.mirrorLines[0]).toContain("失败");
  });

  it("压缩和重试映射到各自真实状态", () => {
    expect(mapPiEvent({ type: "compaction_start" }).activity).toEqual({ hookEvent: "active", subtype: "compaction" });
    expect(mapPiEvent({ type: "auto_retry_start" }).activity).toEqual({ hookEvent: "active", subtype: "auto_retry" });
  });
});

describe("RunnerCore 助手回复镜像", () => {
  it("从文本增量流式输出 Pi 0.84+ 回复，并在 message_end 时结束该行", () => {
    const f = fakeIo();
    const { core } = readyCore(f);
    let pane = "";
    f.io.mirrorLine = (line) => { pane += `${line}\n`; };
    f.io.mirrorAppend = (text) => { pane += text; };
    for (const event of PI_REPLY_EVENTS) core.handlePiLine(JSON.stringify(event));
    expect(pane).toBe("Hello from the mock server.\n");
  });
});

describe("RunnerCore 助手终止失败", () => {
  const failure = (errorMessage?: unknown, content: unknown[] = []) => ({
    type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage, content },
  });
  const errors = (lines: string[]) => lines.filter(line => line.startsWith("[pi-runner] ERROR"));

  it("显示空原生错误并结束部分文本，且不重放其内容", () => {
    const { core, lines, appends } = readyCore();
    core.handlePiLine(JSON.stringify(failure('400 "field_not_allowed"')));
    expect(errors(lines)).toEqual(['[pi-runner] ERROR 400 "field_not_allowed"']);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify(piUpdate({ type: "text_delta", delta: "Partial answer" })));
    core.handlePiLine(JSON.stringify(failure("connection ended", [{ type: "text", text: "Partial answer" }])));
    expect(appends).toEqual(["Partial answer"]);
    expect(lines.slice(-2)).toEqual(["", "[pi-runner] ERROR connection ended"]);
  });

  it.each([undefined, null, {}, 7, "", " \n\t "])("uses a useful fallback for invalid error detail %j", (detail) => {
    const { core, lines } = readyCore();
    core.handlePiLine(JSON.stringify(failure(detail)));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR 请求失败"]);
  });

  it("忽略格式错误的消息信封，且不输出思考内容或工具参数", () => {
    const { core, lines, appends } = readyCore();
    for (const message of [undefined, null, 7, [], { role: "user", stopReason: "error" }]) {
      core.handlePiLine(JSON.stringify({ type: "message_end", message }));
    }
    core.handlePiLine(JSON.stringify(piUpdate({ type: "thinking_delta", delta: "private-thought" })));
    core.handlePiLine(JSON.stringify(piUpdate({ type: "toolcall_delta", delta: "private-arguments" })));
    core.handlePiLine(JSON.stringify(failure(undefined, [
      { type: "thinking", thinking: "private-thought" }, { type: "toolCall", arguments: "private-arguments" },
    ])));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR 请求失败"]);
    expect(appends).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/private-thought|private-arguments/);
  });

  it("移除终端控制字符、压平换行并限制错误通知长度", () => {
    const { core, lines } = readyCore();
    core.handlePiLine(JSON.stringify(failure("\u001b[2J\u001b]0;title\u0007bad\r\nrequest\u0000\u202e" + "x".repeat(1000))));
    const notice = errors(lines)[0]!;
    expect(notice).toContain("bad request");
    expect(notice).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(notice).not.toContain("title");
    expect(notice.length).toBeLessThanOrEqual(420);
  });

  it("只显示一次独立的重试耗尽提示，并抑制其重复终止通知", () => {
    const { core, lines } = readyCore();
    const retryEnd = { type: "auto_retry_end", success: false, finalError: "busy" };
    core.handlePiLine(JSON.stringify(retryEnd));
    core.handlePiLine(JSON.stringify(retryEnd));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR busy"]);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify(failure("busy")));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: false }));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR busy", "[pi-runner] ERROR busy"]);
  });

  it("为后续成功轮次及更晚的独立失败重置状态", () => {
    const { core, lines, appends, activity, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify(failure("first failure")));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    for (const event of PI_REPLY_EVENTS) core.handlePiLine(JSON.stringify(event));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: true }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(appends.join("")).toBe("Hello from the mock server.");
    expect(errors(lines)).toEqual(["[pi-runner] ERROR first failure"]);
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "agent_end" });
    expect(sidecars.at(-1)).toMatchObject({ ready: true, sessionFile: SESSION_FILE, launchId: "launch-77" });
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: false, finalError: "first failure" }));
    expect(errors(lines)).toHaveLength(2);
  });
});

// ── argv 契约 ───────────────────────────────────────────────────────────────

describe("parseRunnerArgs", () => {
  const base = ["--session-name", SESSION, "--state-root", "/sr", "--cwd", "/work", "--launch-id", "launch-77"];

  it("要求 --launch-id（启动尝试范围，guard 合入）", () => {
    const noLaunch = ["--session-name", SESSION, "--state-root", "/sr", "--cwd", "/work", "--approve"];
    expect(() => parseRunnerArgs(noLaunch)).toThrow(/必须提供 --launch-id/);
  });

  it("要求显式信任标志（BR-5）", () => {
    expect(() => parseRunnerArgs(base)).toThrow(/显式提供 trust 标志/);
    expect(parseRunnerArgs([...base, "--no-approve"]).trust).toBe("no-approve");
    expect(parseRunnerArgs([...base, "--approve"]).trust).toBe("approve");
  });

  it("拒绝同时使用 --session 与 --fork", () => {
    expect(() => parseRunnerArgs([...base, "--approve", "--session", "/a.jsonl", "--fork", "/b.jsonl"]))
      .toThrow(/互斥/);
  });

  it("明确拒绝未知标志", () => {
    expect(() => parseRunnerArgs([...base, "--approve", "--resume"])).toThrow(/未知标志/);
  });
});

// ── FR-5：prepareRunnerSidecar + 游标种子（guard 复审结论合入）───────────────

describe("prepareRunnerSidecar——游标可跨越运行器自身重置", () => {
  function memFsOps(files: Record<string, string>) {
    return {
      files,
      readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
      writeFile: (p: string, c: string) => { files[p] = c; },
      exists: (p: string) => p in files,
    };
  }
  const PATH = "/seat/runner-state.json";
  const prior = JSON.stringify({ ready: true, launchId: "old", lastEntryId: "entry-42", updatedAt: "t" });

  it("覆盖前读取旧游标，将其带入 pending 记录，并在恢复时返回", () => {
    const fs = memFsOps({ [PATH]: prior });
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", true, () => "t2");
    expect(catchUpSince).toBe("entry-42");
    expect(JSON.parse(fs.files[PATH]!)).toEqual({ ready: false, launchId: "launch-9", lastEntryId: "entry-42", updatedAt: "t2" });
  });

  it("fresh/fork（非恢复）不返回补偿游标，但仍保留记录中的游标", () => {
    const fs = memFsOps({ [PATH]: prior });
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", false, () => "t2");
    expect(catchUpSince).toBeUndefined();
    expect(JSON.parse(fs.files[PATH]!).lastEntryId).toBe("entry-42");
  });

  it("旧 sidecar 缺失或不可读 -> pending 不带游标，也不补偿", () => {
    const fs = memFsOps({});
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", true, () => "t2");
    expect(catchUpSince).toBeUndefined();
    expect(JSON.parse(fs.files[PATH]!)).toEqual({ ready: false, launchId: "launch-9", updatedAt: "t2" });
  });

  it("组合场景（guard 红绿用例）：旧游标 -> prepare -> RunnerCore.start 发送含 since 的 get_entries", () => {
    const fs = memFsOps({ [PATH]: prior });
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", true, () => "t2");
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince });
    core.start();
    expect(f.rpc).toContainEqual({ type: "get_entries", since: "entry-42", id: "pi-runner-catch-up" });
  });

  it("种子游标在核心自己的 get_state 后 sidecar 写入中得以保留", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "entry-42" });
    core.start();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" },
    }));
    expect(f.sidecars.at(-1)).toMatchObject({ ready: true, launchId: "launch-9", lastEntryId: "entry-42" });
  });
});

// ── QA 红灯合入：游标从 get_entries 刷新，而非猜测实时事件 ─────────────────

describe("通过 get_entries 刷新游标（QA 红灯，qitem-20260707020922）", () => {
  it("agent_end 触发用于刷新游标的 get_entries 请求", () => {
    const { core, rpc } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(rpc).toContainEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });
  });

  it("刷新响应从最后一条记录推进 lastEntryId 并持久化", () => {
    const { core, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-cursor-refresh",
      data: { entries: [{ id: "e1" }, { id: "e2" }, { id: "e9" }] },
    }));
    expect(sidecars.at(-1)).toMatchObject({ lastEntryId: "e9", launchId: "launch-77" });
  });

  it("补偿响应也推进游标（重启路径）", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "e1" });
    core.start();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-catch-up",
      entries: [{ id: "e2" }, { id: "e3" }],
    }));
    expect(f.sidecars.at(-1)!.lastEntryId).toBe("e3");
  });

  it("空或不含标识的 entries 响应不改变游标（绝不回退）", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "e5" });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-cursor-refresh", data: { entries: [] } }));
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: SESSION_FILE, sessionId: "x" },
    }));
    expect(f.sidecars.at(-1)!.lastEntryId).toBe("e5");
  });
});
