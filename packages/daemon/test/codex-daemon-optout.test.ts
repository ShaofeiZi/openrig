import { mockShellCommand } from "./helpers/shell-command-mock.js";
import fs from "node:fs";
import nodePath from "node:path";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { buildCodexResumeCore } from "../src/domain/native-resume-probe.js";
import { codexDaemonSupportProbe, probeCodexDaemonSupport, type CodexDaemonSupport, type CodexDaemonSupportDetector } from "../src/domain/codex-daemon-support.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #69——使用共享 app-server daemon 的 Codex 版本可以在其中运行 tool shell，因此某个 seat 的 tool
// 可能继承另一 seat 的 OpenRig identity。受支持 binary 的每条路径都必须带 --no-daemon 启动；
// 明确为 legacy 的 binary 保持当前 invocation；无法判定的 binary 不得假装隔离而启动。

const SUPPORTED_HELP = [
  "Codex CLI",
  "",
  "Usage: codex [OPTIONS] [PROMPT]",
  "       codex [OPTIONS] <COMMAND> [ARGS]",
  "",
  "Options:",
  "      --no-alt-screen  Disable alternate screen mode",
  "      --no-daemon      Run without the shared background server, even if it is already running",
  "",
].join("\n");
const LEGACY_HELP = SUPPORTED_HELP.split("\n").filter((line) => !line.includes("--no-daemon")).join("\n");

const supported: CodexDaemonSupport = { kind: "supported" };
const legacy: CodexDaemonSupport = { kind: "legacy" };
const unknown: CodexDaemonSupport = { kind: "unknown", detail: "codex --help 执行失败：spawn codex ENOENT" };

// 所有 process 接缝均为 fake。这里不运行真实 Codex、shell、tmux、startup 或 database。
const processMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execSync: vi.fn<() => string>(() => { throw new Error("Unexpected synchronous process execution"); }),
}));
vi.mock("node:child_process", () => processMocks);
beforeEach(() => {
  processMocks.execFile.mockReset();
  processMocks.execSync.mockReset().mockImplementation(() => { throw new Error("Unexpected synchronous process execution"); });
});

function mockTmux(): TmuxAdapter {
  return mockShellCommand({
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter);
}

const mockFs = (): CodexAdapterFsOps => ({
  readFile: () => { throw new Error("not found"); },
  writeFile: () => {},
  exists: () => false,
  mkdirp: () => {},
  listFiles: () => [],
});

const binding = (): NodeBinding => ({
  id: "b1", nodeId: "n1", tmuxSession: "r01-qa", tmuxWindow: null, tmuxPane: null,
  cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project dir", model: "gpt-5.5",
});

const sentCommands = (tmux: TmuxAdapter) =>
  (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1]));

type LaunchKind = "fresh" | "fork" | "resume";
async function launch(kind: LaunchKind, support: CodexDaemonSupport | undefined) {
  const tmux = mockTmux();
  const detectDaemonSupport = vi.fn<CodexDaemonSupportDetector>(async () => support!);
  const adapter = new CodexRuntimeAdapter({
    tmux, fsOps: mockFs(), listProcesses: () => [], sleep: async () => {},
    ...(support ? { detectDaemonSupport } : {}),
  });
  const opts = kind === "fork"
    ? { name: "dev-qa@test-rig", forkSource: { kind: "native_id" as const, value: "parent thread" } }
    : kind === "resume"
      ? { name: "dev-qa@test-rig", resumeToken: "sess 456" }
      : { name: "dev-qa@test-rig" };
  const result = await adapter.launchHarness(binding(), opts);
  return { result, commands: sentCommands(tmux), detectDaemonSupport };
}

describe("#69 probeCodexDaemonSupport", () => {
  it("对一次 help 运行分类：列出 flag、缺少 flag、失败、非 Codex 输出", async () => {
    const runHelp = vi.fn(async () => SUPPORTED_HELP);
    expect(await probeCodexDaemonSupport(runHelp)).toEqual({ kind: "supported" });
    expect(runHelp).toHaveBeenCalledTimes(1);

    expect(await probeCodexDaemonSupport(async () => LEGACY_HELP)).toEqual({ kind: "legacy" });

    const failed = await probeCodexDaemonSupport(async () => { throw new Error("spawn codex ENOENT"); });
    expect(failed.kind).toBe("unknown");
    expect(failed.kind === "unknown" && failed.detail).toMatch(/ENOENT/);

    const odd = await probeCodexDaemonSupport(async () => "zsh: command not found: codex");
    expect(odd.kind).toBe("unknown");
  });

  it("其他 CLI 的 help 即使列出 --no-daemon，也属于 unknown 而非 supported", async () => {
    const other = "Other CLI\n\nUsage: other [OPTIONS]\n\nOptions:\n      --no-daemon  Run in the foreground\n";
    expect((await probeCodexDaemonSupport(async () => other)).kind).toBe("unknown");
    expect((await probeCodexDaemonSupport(async () => other.replace("Usage: other", "Usage: codex-other"))).kind).toBe("unknown");
  });

  it("不会把其他文本中的 --no-daemon 误认为 option", async () => {
    const mention = `${LEGACY_HELP}\n  agents  Browse sessions (use codex --no-daemon-free mode)\n`;
    expect(await probeCodexDaemonSupport(async () => mention)).toEqual({ kind: "legacy" });
    expect(await probeCodexDaemonSupport(async () => `${LEGACY_HELP}\n --no-daemon-free`)).toEqual({ kind: "legacy" });
    expect(await probeCodexDaemonSupport(async () => `${LEGACY_HELP}\n --no-daemon`)).toEqual({ kind: "supported" });
  });
});

describe("#69 CodexRuntimeAdapter.launchHarness 在支持时退出共享 daemon", () => {
  for (const kind of ["fresh", "fork", "resume"] as const) {
    it(`${kind}：supported 在 codex 后紧接 --no-daemon；legacy 不变；每次 launch 探测一次`, async () => {
      const baseline = await launch(kind, undefined);
      const legacyRun = await launch(kind, legacy);
      const supportedRun = await launch(kind, supported);

      expect(baseline.commands).toHaveLength(1);
      expect(baseline.commands[0]).toMatch(/^codex /);
      expect(legacyRun.commands).toEqual(baseline.commands);
      expect(supportedRun.commands).toEqual([baseline.commands[0]!.replace(/^codex /, "codex --no-daemon ")]);
      expect(supportedRun.detectDaemonSupport).toHaveBeenCalledTimes(1);
      expect(supportedRun.detectDaemonSupport).toHaveBeenCalledWith("/project dir");
      expect(legacyRun.detectDaemonSupport).toHaveBeenCalledTimes(1);
    });

    it(`${kind}：support unknown 时以 actionable message 失败，且不发送任何内容`, async () => {
      const run = await launch(kind, unknown);
      expect(run.result.ok).toBe(false);
      expect(!run.result.ok && run.result.error).toMatch(/--no-daemon/);
      expect(!run.result.ok && run.result.error).toMatch(/ENOENT/);
      expect(run.commands).toEqual([]);
    });
  }
});

describe("#69 CodexResumeAdapter（旧版 restore 路径）", () => {
  async function resume(support: CodexDaemonSupport | undefined) {
    const tmux = mockTmux();
    const detectDaemonSupport = vi.fn<CodexDaemonSupportDetector>(async () => support!);
    const adapter = new CodexResumeAdapter(tmux, { sleep: async () => {}, maxWaitMs: 0, ...(support ? { detectDaemonSupport } : {}) });
    const result = await adapter.resume("r01-qa", "codex_id", "sess 456", "/project", null, undefined, "gpt-5.5");
    return { result, commands: sentCommands(tmux), detectDaemonSupport };
  }

  it("supported 增加 --no-daemon，legacy 不变，unknown 不发送并失败", async () => {
    const baseline = await resume(undefined);
    const legacyRun = await resume(legacy);
    const supportedRun = await resume(supported);
    const unknownRun = await resume(unknown);

    expect(baseline.commands).toHaveLength(1);
    expect(legacyRun.commands).toEqual(baseline.commands);
    expect(supportedRun.commands).toEqual([baseline.commands[0]!.replace(/^codex /, "codex --no-daemon ")]);
    expect(supportedRun.detectDaemonSupport).toHaveBeenCalledTimes(1);
    expect(supportedRun.detectDaemonSupport).toHaveBeenCalledWith("/project");
    expect(unknownRun.result).toMatchObject({ ok: false, code: "resume_failed" });
    expect(!unknownRun.result.ok && unknownRun.result.message).toMatch(/--no-daemon/);
    expect(unknownRun.commands).toEqual([]);
  });
});

describe("#69 buildCodexResumeCore", () => {
  it("只在要求时增加 opt-out；默认值（展示命令）字节级一致", () => {
    const plain = buildCodexResumeCore("tok", null);
    expect(plain).toBe("codex -s workspace-write resume 'tok'");
    expect(buildCodexResumeCore("tok", null, false, undefined, undefined, undefined, undefined, true))
      .toBe("codex --no-daemon -s workspace-write resume 'tok'");
  });
});

describe("#69 生产接线", () => {
  it("startup 将真实 daemon-support probe 接入两个 Codex launch adapter", () => {
    const source = fs.readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    const resumeLine = source.split("\n").find((line) => line.includes("new CodexResumeAdapter("))!;
    const runtimeLine = source.split("\n").find((line) => line.includes("new CodexRuntimeAdapter("))!;
    expect(resumeLine).toContain("detectDaemonSupport");
    expect(runtimeLine).toContain("detectDaemonSupport");
  });
});

describe("#69 使用 fake executor 的生产 detector", () => {
  type HelpCallback = (error: Error | null, stdout: string) => void;
  const launchPath = "./bin:/usr/bin:/bin";
  const cwd = "/seat space's";
  const kinds = ["fresh", "fork", "resume", "restore", "last"] as const;

  function fixture(kind: typeof kinds[number], detectDaemonSupport?: CodexDaemonSupportDetector,
    posture: "floor" | "full_bypass" = "floor", profile?: string) {
    const tmux = mockTmux();
    const model = "model's name";
    const adapter = new CodexRuntimeAdapter({
      tmux, fsOps: mockFs(), listProcesses: () => [], sleep: async () => {},
      launchPath, detectDaemonSupport, verifyProfilePreflight: async () => ({ ok: true }),
    });
    const restore = new CodexResumeAdapter(tmux, {
      launchPath, detectDaemonSupport, sleep: async () => {}, maxWaitMs: 0, exec: async () => "",
    });
    const run = () => kind === "restore" || kind === "last"
      ? restore.resume("r01-qa", kind === "last" ? "codex_last" : "codex_id", "thread's id", cwd, profile, posture, model)
      : adapter.launchHarness({ ...binding(), cwd, model, launchPosture: posture, codexConfigProfile: profile }, {
          name: "dev-qa@test-rig",
          ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent's id" } }
            : kind === "resume" ? { resumeToken: "thread's id" } : {}),
        });
    return { run, commands: () => sentCommands(tmux) };
  }

  for (const kind of kinds) {
    for (const posture of ["floor", "full_bypass"] as const) {
      it(`${kind}/${posture}：cwd/PATH parity、一次 probe、legacy byte、model 与 profile 均保留`, async () => {
        let help = LEGACY_HELP;
        processMocks.execFile.mockImplementation((file, args, options, callback: HelpCallback) => {
          expect(file).toBe("codex");
          expect(args).toEqual(["--help"]);
          expect(options.cwd).toBe(cwd);
          expect(options.env.PATH).toBe(launchPath);
          expect(nodePath.resolve(options.cwd, options.env.PATH.split(":")[0], file)).toBe("/seat space's/bin/codex");
          expect(options.timeout).toBe(10_000);
          expect(options.killSignal).toBe("SIGKILL");
          callback(null, help);
        });
        const baseline = fixture(kind, undefined, posture, "profile's name");
        await baseline.run();
        const actual = fixture(kind, codexDaemonSupportProbe(launchPath), posture, "profile's name");
        await actual.run();
        expect(actual.commands()).toEqual(baseline.commands());
        expect(processMocks.execFile).toHaveBeenCalledTimes(1);
        help = SUPPORTED_HELP;
        await actual.run(); // 相同 adapter、相同 PATH：重新评估 upgrade。
        expect(processMocks.execFile).toHaveBeenCalledTimes(2);
        expect(actual.commands()[1]).toBe(baseline.commands()[0]!.replace(" codex ", " codex --no-daemon "));
        expect(actual.commands()[1]).toContain("env PATH='./bin:/usr/bin:/bin'");
        expect(processMocks.execSync).not.toHaveBeenCalled();
      });
    }

    it(`${kind}：生产 timeout 在任何 launch send 前拒绝`, async () => {
      processMocks.execFile.mockImplementation((_file, _args, options, callback: HelpCallback) => {
        expect(options.timeout).toBe(200);
        callback(Object.assign(new Error("killed"), { killed: true }), "");
      });
      const actual = fixture(kind, codexDaemonSupportProbe(launchPath, 200));
      const result = await actual.run();
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain("200 ms 后超时");
      expect(actual.commands()).toEqual([]);
      expect(processMocks.execFile).toHaveBeenCalledTimes(1);
    });
  }

  it("help executor 仍 pending 时允许无关 timer 运行", async () => {
    let complete: HelpCallback | undefined;
    let settled = false;
    // 针对旧实现的 RED 运行只会在此受控停顿后返回。
    processMocks.execSync.mockImplementationOnce(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
      return LEGACY_HELP;
    });
    processMocks.execFile.mockImplementation((_file, _args, _options, callback: HelpCallback) => { complete = callback; });
    const pending = codexDaemonSupportProbe(launchPath)(cwd).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(complete).toBeTypeOf("function");
    complete!(null, LEGACY_HELP);
    expect(await pending).toEqual({ kind: "legacy" });
    expect(processMocks.execSync).not.toHaveBeenCalled();
  });

  it("在 deadline 时拒绝，不等待 callback，也不接受迟到 help", async () => {
    vi.useFakeTimers();
    try {
      let complete: HelpCallback | undefined;
      processMocks.execFile.mockImplementation((_file, _args, _options, callback: HelpCallback) => { complete = callback; });
      let observed: CodexDaemonSupport | undefined;
      const pending = codexDaemonSupportProbe(launchPath, 200)(cwd).then((value) => { observed = value; return value; });
      await vi.advanceTimersByTimeAsync(199);
      expect(complete).toBeTypeOf("function");
      expect(observed).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(observed).toEqual({ kind: "unknown", detail: "codex --help 执行失败：200 ms 后超时" });
      complete!(null, SUPPORTED_HELP);
      expect(await pending).toEqual(observed);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["success", "error", "throw"])("提前 %s 后清除 deadline", async (outcome) => {
    vi.useFakeTimers();
    try {
      processMocks.execFile.mockImplementation((_file, _args, _options, callback: HelpCallback) => {
        if (outcome === "throw") throw new Error("invalid spawn");
        callback(outcome === "error" ? new Error("not available") : null, SUPPORTED_HELP);
      });
      const result = await codexDaemonSupportProbe(launchPath, 200)(cwd);
      expect(result.kind).toBe(outcome === "success" ? "supported" : "unknown");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("将 executable 缺失错误报告为 unknown", async () => {
    processMocks.execFile.mockImplementation((_file, _args, _options, callback: HelpCallback) => {
      callback(new Error("spawn codex ENOENT"), "");
    });
    expect(await codexDaemonSupportProbe(launchPath)(cwd)).toEqual({ kind: "unknown", detail: "codex --help 执行失败：spawn codex ENOENT" });
  });
});
