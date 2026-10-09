// OPR.0.4.6.PI1——Pi runtime 适配器、恢复适配器和运行器协议构建器的密闭测试。
// 不使用实时 Pi：launch/resume/fork 命令构造、sidecar 驱动的令牌捕获、信任标志姿态，
// 以及默认拒绝的环境变量允许列表（BR-3），均由纯逻辑或模拟实现支撑。实时路径由 VM
// 证明契约覆盖。

import nodePath from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { PiRuntimeAdapter, type PiAdapterFsOps } from "../src/adapters/pi-runtime-adapter.js";
import { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import {
  piSeatPaths, buildPiRunnerCommand, buildPiChildArgs, buildPiChildEnv,
  providerFromModel, parsePiRunnerState, buildPendingRunnerState, PI_RUNNER_READY_MARKER,
} from "../src/adapters/pi-runner-protocol.js";

const STATE_ROOT = "/openrig-home/state/pi";
const RUNNER = "/daemon-dist/adapters/pi-runner.js";
const SESSION = "devpi-a@some-rig";
const SESSION_FILE = `${STATE_ROOT}/${SESSION}/sessions/2026-07-06T10-00-00_0197a2f0.jsonl`;
const PI_FLOOR_EFFECT = {
  runtime: "pi",
  axis: "resource_trust",
  state: "observed",
  value: "no-approve",
} as const;

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
  hasSession?: (target: string) => Promise<boolean>;
  getPaneCommand?: (target: string) => Promise<string | null>;
}) {
  return {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => ""),
    hasSession: overrides?.hasSession ?? vi.fn(async () => true),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "node"),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
  } as unknown as TmuxAdapter;
}

/** 提取适配器键入窗格的 --launch-id 值（运行器会将其标记到 sidecar 写入中）。 */
function launchIdFrom(cmd: string): string {
  const m = /--launch-id '([^']+)'/.exec(cmd);
  if (!m) throw new Error("typed command carries no --launch-id");
  return m[1]!;
}

/** 内存文件系统。`files` 将绝对路径映射到内容。 */
function memFs(files: Record<string, string> = {}): PiAdapterFsOps & { files: Record<string, string>; dirs: Set<string> } {
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p),
    mkdirp: (p) => { dirs.add(p); },
    listFiles: () => [],
  };
}

function readyState(sessionFile: string = SESSION_FILE, launchId?: string): string {
  return JSON.stringify({ ready: true, launchId, sessionFile, sessionId: "0197a2f0", updatedAt: "2026-07-06T10:00:01Z" });
}

function adapterWith(fs: PiAdapterFsOps, tmux: TmuxAdapter, trust?: "approve" | "no-approve") {
  return new PiRuntimeAdapter({
    tmux, fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER,
    trustPosture: trust, sleep: async () => {},
  });
}

// ── 协议构建器 ───────────────────────────────────────────────────────────────

describe("pi-runner-protocol", () => {
  it("从 stateRoot + sessionName 派生席位状态布局", () => {
    const p = piSeatPaths(STATE_ROOT, SESSION);
    expect(p.agentDir).toBe(nodePath.join(STATE_ROOT, SESSION, "agent"));
    expect(p.sessionsDir).toBe(nodePath.join(STATE_ROOT, SESSION, "sessions"));
    expect(p.runnerStatePath).toBe(nodePath.join(STATE_ROOT, SESSION, "runner-state.json"));
  });

  it("构建带显式信任标志（BR-5）且不含 @file 参数的窗格命令", () => {
    const cmd = buildPiRunnerCommand({
      runnerEntryPath: RUNNER, sessionName: SESSION, stateRoot: STATE_ROOT,
      cwd: "/work", trust: "no-approve", model: "zai/glm-5.2", launchId: "launch-1",
    });
    expect(cmd).toContain(`node '${RUNNER}'`);
    expect(cmd).toContain("--launch-id 'launch-1'");
    expect(cmd).toContain("--no-approve");
    expect(cmd).toContain("--model 'zai/glm-5.2'");
    // 没有参数以 "@" 开头（Pi 的 @file 形式）。值内部含 "@" 没有问题——
    // 规范会话名（pod-member@rig）始终带有一个。
    expect(cmd).not.toMatch(/ '@| @/);
  });

  it("恢复时传递 --session，分叉时传递 --fork，绝不同时传递", () => {
    const resume = buildPiRunnerCommand({
      runnerEntryPath: RUNNER, sessionName: SESSION, stateRoot: STATE_ROOT,
      cwd: "/work", trust: "approve", sessionFile: SESSION_FILE, launchId: "launch-1",
    });
    expect(resume).toContain(`--session '${SESSION_FILE}'`);
    expect(resume).not.toContain("--fork");
    expect(resume).not.toContain("--resume"); // the picker is forbidden in managed paths

    const fork = buildPiRunnerCommand({
      runnerEntryPath: RUNNER, sessionName: SESSION, stateRoot: STATE_ROOT,
      cwd: "/work", trust: "approve", forkRef: SESSION_FILE, launchId: "launch-1",
    });
    expect(fork).toContain(`--fork '${SESSION_FILE}'`);
    expect(fork).not.toContain("--session ");
  });

  it("构建带 rpc 模式、显式 --session-dir、--name 与 trust 的 Pi 子进程 argv", () => {
    const args = buildPiChildArgs({
      sessionsDir: "/seat/sessions", sessionName: SESSION, trust: "no-approve", model: "kimi-coding/k2p7",
    });
    expect(args).toEqual([
      "--mode", "rpc",
      "--session-dir", "/seat/sessions",
      "--name", SESSION,
      "--no-approve",
      "--model", "kimi-coding/k2p7",
    ]);
  });

  it("子进程 argv 中 --session 优先于 --fork（上游互斥）", () => {
    const args = buildPiChildArgs({
      sessionsDir: "/s", sessionName: SESSION, trust: "approve",
      sessionFile: "/a.jsonl", forkRef: "/b.jsonl",
    });
    expect(args).toContain("--session");
    expect(args).not.toContain("--fork");
  });

  it("从 provider/id 模型声明中解析 provider", () => {
    expect(providerFromModel("zai/glm-5.2")).toBe("zai");
    expect(providerFromModel("kimi-coding/k2p7")).toBe("kimi-coding");
    expect(providerFromModel("glm-5.2")).toBeNull();
    expect(providerFromModel(undefined)).toBeNull();
  });

  it("如实拒绝格式错误的 runner-state JSON", () => {
    expect(parsePiRunnerState("not json")).toBeNull();
    expect(parsePiRunnerState("[]")).toBeNull();
    expect(parsePiRunnerState(JSON.stringify({ ready: "yes", updatedAt: "t" }))).toBeNull();
    expect(parsePiRunnerState(readyState())).toMatchObject({ ready: true, sessionFile: SESSION_FILE });
  });
});

describe("buildPiChildEnv——默认拒绝的允许列表（BR-3）", () => {
  const source = {
    PATH: "/usr/bin", HOME: "/home/seat", TERM: "xterm",
    AWS_SECRET_ACCESS_KEY: "leak-me", OPENRIG_ACTIVITY_HOOK_TOKEN: "secret",
    GITHUB_TOKEN: "leak-me-too", ZAI_API_KEY: "zai-key", KIMI_API_KEY: "kimi-key",
    OPENROUTER_API_KEY: "or-key",
  };

  it("保留托管身份及实例/上下文来源，不保留环境中的 OpenRig 设置", () => {
    const managed = {
      OPENRIG_NODE_ID: "node-17", OPENRIG_SESSION_NAME: SESSION,
      OPENRIG_HOME: "/private/instance", OPENRIG_URL: "http://127.0.0.1:17433",
      OPENRIG_HOST: "127.0.0.1", OPENRIG_PORT: "17433",
      OPENRIG_RUNTIME: "pi", OPENRIG_OCCUPANT_GENERATION: "generation-current",
      OPENRIG_SHARED_DOCS_ROOT: "/private/context",
    };
    const env = buildPiChildEnv({
      ...source, ...managed, OPENRIG_UNREVIEWED_SETTING: "exclude",
      OPENRIG_TERMINAL_BEARER_TOKEN: "exclude", OPENAI_API_KEY: "exclude",
      BASH_ENV: "/untrusted/startup", ENV: "/untrusted/startup", NODE_OPTIONS: "--inspect",
      TMUX: "/some/socket", TMUX_PANE: "%7", RIGGED_SESSION_NAME: "stale@other",
    }, { agentDir: "/seat/agent", sessionsDir: "/seat/sessions", model: "openrouter/example" });
    expect(env).toMatchObject(managed);
    expect(env.OPENROUTER_API_KEY).toBe("or-key");
    for (const name of ["OPENRIG_UNREVIEWED_SETTING", "OPENRIG_TERMINAL_BEARER_TOKEN",
      "OPENRIG_ACTIVITY_HOOK_TOKEN", "OPENAI_API_KEY", "ZAI_API_KEY", "KIMI_API_KEY",
      "BASH_ENV", "ENV", "NODE_OPTIONS", "TMUX", "TMUX_PANE", "RIGGED_SESSION_NAME"]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("不虚构缺失或为空的托管身份", () => {
    const opts = { agentDir: "/seat/agent", sessionsDir: "/seat/sessions" };
    expect(buildPiChildEnv({}, opts)).not.toHaveProperty("OPENRIG_SESSION_NAME");
    expect(buildPiChildEnv({}, opts)).not.toHaveProperty("OPENRIG_NODE_ID");
    expect(buildPiChildEnv({ OPENRIG_SESSION_NAME: "" }, opts).OPENRIG_SESSION_NAME).toBe("");
  });

  it("只传递基线变量 + 席位隔离根目录，不传递其他内容", () => {
    const env = buildPiChildEnv(source, { agentDir: "/seat/agent", sessionsDir: "/seat/sessions" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.PI_CODING_AGENT_DIR).toBe("/seat/agent");
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBe("/seat/sessions");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("OPENRIG_ACTIVITY_HOOK_TOKEN");
    // 未声明 provider——两个密钥都不跨越边界。
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
  });

  it("只传递已声明 provider 的密钥变量", () => {
    const env = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "zai/glm-5.2" });
    expect(env.ZAI_API_KEY).toBe("zai-key");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");

    const kimi = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "kimi-coding/k2p7" });
    expect(kimi.KIMI_API_KEY).toBe("kimi-key");
    expect(kimi).not.toHaveProperty("ZAI_API_KEY");
  });

  it("openrouter 只传递 OPENROUTER_API_KEY", () => {
    const env = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "openrouter/z-ai/glm-4.6" });
    expect(env.OPENROUTER_API_KEY).toBe("or-key");
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
  });

  it("未知或自定义 provider 不透传环境密钥（其配置路径为 models.json）", () => {
    const env = buildPiChildEnv(source, { agentDir: "/a", sessionsDir: "/s", model: "ollama/qwen2.5-coder" });
    expect(env).not.toHaveProperty("ZAI_API_KEY");
    expect(env).not.toHaveProperty("KIMI_API_KEY");
  });
});

// ── PiRuntimeAdapter ─────────────────────────────────────────────────────────

describe("PiRuntimeAdapter.launchHarness", () => {
  const binding = { tmuxSession: SESSION, cwd: "/work", model: "zai/glm-5.2" } as never;

  it("全新启动：键入运行器命令，然后从 sidecar 捕获会话文件", async () => {
    const fs = memFs();
    const sendText = vi.fn(async (_t: string, text: string) => {
      // 运行器“启动”，并在适配器轮询前写入带启动标记的 sidecar。
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      expect(text).toContain("--no-approve"); // default trust posture, explicit
      expect(text).toContain("--model 'zai/glm-5.2'");
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));

    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toEqual({ ok: true, resumeToken: SESSION_FILE, resumeType: "pi_session_file", appliedLaunch: PI_FLOOR_EFFECT });
    // 席位隔离目录已创建。
    expect(fs.dirs.has(piSeatPaths(STATE_ROOT, SESSION).agentDir)).toBe(true);
    expect(fs.dirs.has(piSeatPaths(STATE_ROOT, SESSION).sessionsDir)).toBe(true);
  });

  it("端到端遵循显式 approve 姿态", async () => {
    const fs = memFs();
    let cmd = "";
    const sendText = vi.fn(async (_t: string, text: string) => {
      cmd = text;
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }), "approve");
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(true);
    expect(cmd).toContain("--approve");
    expect(cmd).not.toContain("--no-approve");
  });

  it("拒绝同时使用 resumeToken 与 forkSource", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness(binding, {
      name: SESSION, resumeToken: SESSION_FILE, forkSource: { kind: "native_id", value: "/x.jsonl" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/互斥/);
  });

  it("恢复：校验令牌结构，要求文件存在，并返回同一个令牌", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      expect(text).toContain(`--session '${SESSION_FILE}'`);
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: SESSION_FILE });
    expect(result).toEqual({ ok: true, resumeToken: SESSION_FILE, resumeType: "pi_session_file", appliedLaunch: PI_FLOOR_EFFECT });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("使用格式错误令牌恢复时，在接触窗格前校验失败", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: "relative/path.jsonl" });
    expect(result.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("恢复时会话文件缺失则返回 retry_fresh（等待决策路径）", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: SESSION_FILE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recovery).toBe("retry_fresh");
  });

  it("分叉：使用 --fork 并返回新的子会话文件，绝不返回父文件", async () => {
    const parent = "/somewhere/parent_0196.jsonl";
    const child = `${STATE_ROOT}/${SESSION}/sessions/child_0197.jsonl`;
    const fs = memFs();
    const sendText = vi.fn(async (_t: string, text: string) => {
      expect(text).toContain(`--fork '${parent}'`);
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(child, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: parent },
    });
    expect(result).toEqual({ ok: true, resumeToken: child, resumeType: "pi_session_file", appliedLaunch: PI_FLOOR_EFFECT });
  });

  it("运行器将父文件报告为会话时分叉失败（分叉后令牌规则）", async () => {
    const parent = `${STATE_ROOT}/${SESSION}/sessions/parent_0196.jsonl`;
    const fs = memFs();
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(parent, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: parent },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/父 session 文件/);
  });

  it("v1 分叉拒绝非 native_id 的引用类型", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "artifact_path", value: "/x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/native_id/);
  });

  it("运行器在就绪前退出时，携带窗格证据报告 attention_required", async () => {
    const fs = memFs();
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = JSON.stringify({
        ready: false, launchId: launchIdFrom(text), updatedAt: "t", exited: { code: 1, at: "t" },
      });
      return { ok: true as const };
    });
    const capturePaneContent = vi.fn(async () => "[pi-runner] ERROR pi exited: bad provider config");
    const adapter = adapterWith(fs, mockTmux({ sendText, capturePaneContent }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.evidence).toContain("bad provider config");
    }
  });
});

describe("PiRuntimeAdapter.checkReady / readSessionFile", () => {
  const binding = { tmuxSession: SESSION, cwd: "/work" } as never;

  it("sidecar 表示 ready 时判定为就绪", async () => {
    const fs = memFs({ [piSeatPaths(STATE_ROOT, SESSION).runnerStatePath]: readyState() });
    const adapter = adapterWith(fs, mockTmux());
    expect(await adapter.checkReady(binding)).toEqual({ ready: true });
  });

  it("sidecar 缺失时通过运行器自己的窗格标记判定为就绪", async () => {
    const capturePaneContent = vi.fn(async () => `banner\n${PI_RUNNER_READY_MARKER} session=x\n`);
    const adapter = adapterWith(memFs(), mockTmux({ capturePaneContent }));
    expect((await adapter.checkReady(binding)).ready).toBe(true);
  });

  it("sidecar 记录退出时判定为未就绪 + runner_exited", async () => {
    const fs = memFs({
      [piSeatPaths(STATE_ROOT, SESSION).runnerStatePath]: JSON.stringify({ ready: false, updatedAt: "t", exited: { code: 2, at: "t" } }),
    });
    const adapter = adapterWith(fs, mockTmux());
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("runner_exited");
  });

  it("将 sidecar 暴露为恢复令牌捕获存储（piRunnerStateStore 结构）", () => {
    const fs = memFs({ [piSeatPaths(STATE_ROOT, SESSION).runnerStatePath]: readyState() });
    const adapter = adapterWith(fs, mockTmux());
    expect(adapter.readSessionFile(SESSION)).toEqual({ ok: true, sessionFile: SESSION_FILE });
    expect(adapter.readSessionFile("missing@rig")).toEqual({ ok: false, reason: "missing_sidecar" });
  });

  it("损坏的 sidecar 报告 parse_error", () => {
    const fs = memFs({ [piSeatPaths(STATE_ROOT, SESSION).runnerStatePath]: "corrupt{" });
    const adapter = adapterWith(fs, mockTmux());
    expect(adapter.readSessionFile(SESSION)).toEqual({ ok: false, reason: "parse_error" });
  });
});

// ── PiResumeAdapter ──────────────────────────────────────────────────────────

describe("PiResumeAdapter", () => {
  function resumeAdapter(fs: ReturnType<typeof memFs>, tmux: TmuxAdapter) {
    return new PiResumeAdapter(tmux, fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, {
      pollMs: 1, maxWaitMs: 5, sleep: async () => {},
    });
  }

  it("canResume：仅接受 pi_session_file + token", () => {
    const a = resumeAdapter(memFs(), mockTmux());
    expect(a.canResume("pi_session_file", SESSION_FILE)).toBe(true);
    expect(a.canResume("pi_session_file", null)).toBe(false);
    expect(a.canResume("codex_id", SESSION_FILE)).toBe(false);
  });

  it("会话文件缺失 -> retry_fresh（映射到等待决策，绝不静默全新启动）", async () => {
    const a = resumeAdapter(memFs(), mockTmux());
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("retry_fresh");
  });

  it("恢复：键入运行器 --session 命令，并通过 sidecar 确认", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      expect(text).toContain(`--session '${SESSION_FILE}'`);
      expect(text).not.toContain("--resume");
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toEqual({ ok: true, appliedLaunch: PI_FLOOR_EFFECT });
  });

  it("运行器报告与请求不同的会话文件时如实失败", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[piSeatPaths(STATE_ROOT, SESSION).runnerStatePath] = readyState("/other/file.jsonl", launchIdFrom(text));
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/未报告所请求的 session 文件/);
  });

  it("Enter 失败时用 C-c 清理已键入命令（镜像 codex-resume）", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendKeys = vi.fn(async (_t: string, keys: string[]): Promise<TmuxResult> =>
      keys[0] === "Enter"
        ? { ok: false as const, code: "send_failed", message: "enter failed" }
        : { ok: true as const });
    const a = resumeAdapter(fs, mockTmux({ sendKeys }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    expect(sendKeys.mock.calls.some((c) => c[1]?.[0] === "C-c")).toBe(true);
  });
});

// ── 过期工件范围（guard 合入，代码审查 qitem-20260707011908）────────────────
// 持久化 runner-state.json 与窗格 READY/EXIT 回滚内容在停止或崩溃后仍存在；
// 启动、恢复和就绪检查绝不能消费先前实例的工件。

describe("启动尝试范围——过期工件永不计入", () => {
  const binding = { tmuxSession: SESSION, cwd: "/work" } as never;
  const OLD_FILE = `${STATE_ROOT}/${SESSION}/sessions/OLD_0100.jsonl`;
  const NEW_FILE = `${STATE_ROOT}/${SESSION}/sessions/NEW_0200.jsonl`;
  const statePath = piSeatPaths(STATE_ROOT, SESSION).runnerStatePath;

  it("全新启动忽略预先存在的 ready sidecar，并返回新启动的令牌", async () => {
    const fs = memFs({ [statePath]: readyState(OLD_FILE, "stale-launch") });
    const sendText = vi.fn(async (_t: string, text: string) => {
      // 启动前重置必须已经用标记为本次尝试的 pending 记录替换过期记录。
      const pending = JSON.parse(fs.files[statePath]!);
      expect(pending).toMatchObject({ ready: false, launchId: launchIdFrom(text) });
      // 随后“运行器”使用新文件报告本次尝试 ready。
      fs.files[statePath] = readyState(NEW_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toEqual({ ok: true, resumeToken: NEW_FILE, resumeType: "pi_session_file", appliedLaunch: PI_FLOOR_EFFECT });
  });

  it("全新启动忽略预先存在的 exited sidecar（不立即进入 attention_required）", async () => {
    const fs = memFs({
      [statePath]: JSON.stringify({ ready: false, launchId: "stale-launch", updatedAt: "t", exited: { code: 1, at: "t" } }),
    });
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = readyState(NEW_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(true);
  });

  it("ready sidecar 不含本次尝试的 launchId 时绝不完成启动", async () => {
    // “运行器”写入带不同 launch id 的 ready 记录（例如竞争中的旧实例）——轮询必须超时，
    // 不能接受它。
    const fs = memFs();
    const sendText = vi.fn(async () => {
      fs.files[statePath] = readyState(OLD_FILE, "some-other-launch");
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/超时/);
  });

  it("checkReady：过期 ready sidecar + 窗格已回到 shell -> runner_exited，绝不 ready", async () => {
    const fs = memFs({ [statePath]: readyState(SESSION_FILE, "stale-launch") });
    const adapter = adapterWith(fs, mockTmux({ getPaneCommand: vi.fn(async () => "zsh") }));
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("runner_exited");
  });

  it("checkReady：过期 READY 回滚内容 + 窗格位于 shell -> runner_exited，绝不 ready", async () => {
    const adapter = adapterWith(memFs(), mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => `old output\n${PI_RUNNER_READY_MARKER} session=${SESSION_FILE}\n$ `),
    }));
    const result = await adapter.checkReady(binding);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("runner_exited");
  });
});

describe("PiResumeAdapter——过期工件范围", () => {
  const statePath = piSeatPaths(STATE_ROOT, SESSION).runnerStatePath;

  function resumeAdapter(fs: ReturnType<typeof memFs>, tmux: TmuxAdapter) {
    return new PiResumeAdapter(tmux, fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, {
      pollMs: 1, maxWaitMs: 5, sleep: async () => {},
    });
  }

  it("预先存在的 ready sidecar（即使指向请求文件）也绝不让恢复假绿", async () => {
    // 来自该席位上一次运行同一会话文件的过期记录。
    const fs = memFs({ [SESSION_FILE]: "jsonl", [statePath]: readyState(SESSION_FILE, "stale-launch") });
    const sendText = vi.fn(async () => ({ ok: true as const })); // new runner never reports
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/超时/);
    // 且过期记录在键入前已被 pending 记录覆盖。
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("绝不采用过期 READY 窗格标记（同一文件）", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const capturePaneContent = vi.fn(async () => `${PI_RUNNER_READY_MARKER} session=${SESSION_FILE}`);
    const a = resumeAdapter(fs, mockTmux({ capturePaneContent }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
  });

  it("仅当本次尝试的 sidecar 已 ready 且指向请求文件时才恢复", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toEqual({ ok: true, appliedLaunch: PI_FLOOR_EFFECT });
  });

  it("本次尝试的 sidecar ready 但无 sessionFile 时不构成证明（不可选匹配）", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl" });
    const sendText = vi.fn(async (_t: string, text: string) => {
      fs.files[statePath] = JSON.stringify({ ready: true, launchId: launchIdFrom(text), updatedAt: "t" });
      return { ok: true as const };
    });
    const a = resumeAdapter(fs, mockTmux({ sendText }));
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/未报告所请求的 session 文件/);
  });
});

// ── FR-5 持久化游标可跨越启动范围重置（guard 复审结论，
// qitem-20260707013815) ──────────────────────────────────────────────────────

describe("持久化补偿游标可跨越启动尝试重置", () => {
  const statePath = piSeatPaths(STATE_ROOT, SESSION).runnerStatePath;
  const priorWithCursor = JSON.stringify({
    ready: true, launchId: "stale-launch", sessionFile: SESSION_FILE,
    lastEntryId: "entry-42", updatedAt: "t",
  });

  it("buildPendingRunnerState 只延续游标（其余全部重置）", () => {
    const prior = parsePiRunnerState(priorWithCursor)!;
    const pending = buildPendingRunnerState("launch-2", "t2", prior);
    expect(pending).toEqual({ ready: false, launchId: "launch-2", lastEntryId: "entry-42", updatedAt: "t2" });
    expect(buildPendingRunnerState("launch-2", "t2", null).lastEntryId).toBeUndefined();
  });

  it("适配器恢复预写入在 pending 重置中保留 lastEntryId", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl", [statePath]: priorWithCursor });
    const sendText = vi.fn(async (_t: string, text: string) => {
      const pending = JSON.parse(fs.files[statePath]!);
      expect(pending).toMatchObject({ ready: false, launchId: launchIdFrom(text), lastEntryId: "entry-42" });
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const adapter = adapterWith(fs, mockTmux({ sendText }));
    const result = await adapter.launchHarness(
      { tmuxSession: SESSION, cwd: "/work" } as never,
      { name: SESSION, resumeToken: SESSION_FILE },
    );
    expect(result.ok).toBe(true);
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("PiResumeAdapter 预写入在 pending 重置中保留 lastEntryId", async () => {
    const fs = memFs({ [SESSION_FILE]: "jsonl", [statePath]: priorWithCursor });
    const sendText = vi.fn(async (_t: string, text: string) => {
      const pending = JSON.parse(fs.files[statePath]!);
      expect(pending).toMatchObject({ ready: false, launchId: launchIdFrom(text), lastEntryId: "entry-42" });
      fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
      return { ok: true as const };
    });
    const a = new PiResumeAdapter(mockTmux({ sendText }), fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, {
      pollMs: 1, maxWaitMs: 5, sleep: async () => {},
    });
    const result = await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
    expect(result).toEqual({ ok: true, appliedLaunch: PI_FLOOR_EFFECT });
    expect(sendText).toHaveBeenCalledOnce();
  });

  // OPR.0.4.8.2：Pi 恢复资源信任姿态（资源信任，而非权限策略）。直接固定
  // PiResumeAdapter 调用点，使 pi-resume.ts 不会在纯 piTrust 辅助函数仍为绿色时回退。
  // 关闭时保持已配置/no-approve 信任；启用 YOLO 时强制 --approve。
  it("PiResumeAdapter 恢复信任：关闭 -> --no-approve；启用（YOLO）-> --approve", async () => {
    async function resumeCmd(): Promise<string> {
      const fs = memFs({ [SESSION_FILE]: "jsonl" });
      let cmd = "";
      const sendText = vi.fn(async (_t: string, text: string) => {
        cmd = text;
        fs.files[statePath] = readyState(SESSION_FILE, launchIdFrom(text));
        return { ok: true as const };
      });
      const a = new PiResumeAdapter(mockTmux({ sendText }), fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, {
        pollMs: 1, maxWaitMs: 5, sleep: async () => {},
      });
      await a.resume(SESSION, "pi_session_file", SESSION_FILE, "/work");
      return cmd;
    }
    try {
      delete process.env.OPENRIG_YOLO;
      const off = await resumeCmd();
      expect(off).toContain("--no-approve");
      expect(off).not.toContain("--approve"); // "--no-approve" does not contain the "--approve" token

      process.env.OPENRIG_YOLO = "1";
      const on = await resumeCmd();
      expect(on).toContain("--approve");
      expect(on).not.toContain("--no-approve");
    } finally {
      delete process.env.OPENRIG_YOLO;
    }
  });
});
