import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readLogs,
  tailLogs,
  getDaemonPath,
  resolveDaemonPath,
  buildDaemonEnv,
  ensureWorkspaceScaffold,
  daemonNotRunningError,
  printDaemonNotRunning,
  STATE_FILE,
  LOG_FILE,
  OPENRIG_DIR,
  type LifecycleDeps,
  type DaemonState,
} from "../src/daemon-lifecycle.js";

afterEach(() => vi.useRealTimers());

function cleanReceipt(pid: number): string {
  const now = new Date().toISOString();
  return JSON.stringify({ schema: "openrig.daemon-shutdown/v1", pid, startedAt: now, completedAt: now, outcome: "clean", phase: "complete", failures: [] });
}

function neverFetch(): Promise<{ ok: boolean }> {
  return new Promise(() => {});
}

function startupHealth() {
  return { ok: true, json: async () => ({ pid: 12345, bind: { mode: "explicit", hosts: ["127.0.0.1"], tailscaleDetected: false } }) };
}

function mockDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null as number | null, signalCode: null, unref: vi.fn() });
  return {
    acquireStartLock: () => ({ recordChild: vi.fn(), release: vi.fn() }),
    spawn: vi.fn(() => child as unknown as ChildProcess),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0, "SIGTERM"); return true; }),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => child.exitCode === null),
    ...overrides,
  };
}

function startableDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  let spawned = false;
  const deps = mockDeps(overrides);
  const spawn = deps.spawn;
  deps.spawn = vi.fn((...args) => { spawned = true; return spawn(...args); });
  deps.fetch = overrides?.fetch ?? vi.fn(async () => {
    if (!spawned) throw new Error("refused");
    return startupHealth();
  });
  return deps;
}

function writtenState(deps: LifecycleDeps): DaemonState {
  const call = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => (c[0] as string).endsWith("daemon.json")
  );
  if (!call) throw new Error("daemon.json was not written");
  return JSON.parse(call[1] as string) as DaemonState;
}

describe("Daemon Lifecycle", () => {
  // Test 1：start 解析绝对 daemon 路径（非 cwd 相对）
  it("getDaemonPath 解析以 daemon 结尾的绝对路径", () => {
    const daemonPath = getDaemonPath();
    expect(path.isAbsolute(daemonPath)).toBe(true);
    expect(daemonPath).toMatch(/daemon$/);
  });

  // Test 2：start 构造精确 spawn 命令与正确 env/redirect
  it("start：以 node、daemon entry、env、日志重定向构造 spawn", async () => {
    const deps = startableDeps();
    await startDaemon({ port: 7433, db: "openrig.sqlite" }, deps);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    expect(spawnMock).toHaveBeenCalledOnce();

    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toContain("daemon");
    expect(args[0]).toContain("dist/index.js");
    expect(opts.env).toMatchObject({
      OPENRIG_PORT: "7433",
      OPENRIG_DB: "openrig.sqlite",
    });
    expect(opts.detached).toBe(true);
  });

  it("start：spawn 前初始化 canonical 实例与已配置的 workspace", async () => {
    const created = new Set<string>();
    const written = new Map<string, string>();
    const deps = startableDeps({
      exists: vi.fn((p: string) => created.has(p) || written.has(p)),
      mkdirp: vi.fn((p: string) => { created.add(p); }),
      writeFile: vi.fn((p: string, content: string) => { written.set(p, content); }),
    });
    await startDaemon({
      port: 7433,
      db: "openrig.sqlite",
      workspaceRoot: "/tmp/openrig-workspace",
      contextRoot: "/tmp/openrig-context",
      skillsRoot: "/tmp/openrig-skills",
      topologyRoot: "/tmp/openrig-topology",
    }, deps);

    for (const root of [
      path.join(OPENRIG_DIR, "state"),
      "/tmp/openrig-context",
      path.join("/tmp/openrig-context", "system"),
      "/tmp/openrig-skills",
      path.join(OPENRIG_DIR, "specs"),
      "/tmp/openrig-topology",
      path.join(OPENRIG_DIR, "plugins"),
      path.join(OPENRIG_DIR, "run"),
      path.join(OPENRIG_DIR, "logs"),
      path.join(OPENRIG_DIR, "transcripts"),
      path.join(OPENRIG_DIR, "backups"),
      path.join(OPENRIG_DIR, "secrets"),
    ]) {
      expect(created.has(root), root).toBe(true);
    }
    expect(written.get(path.join(OPENRIG_DIR, "config.json"))).toBe("{}\n");
    expect(created.has("/tmp/openrig-workspace")).toBe(true);
    expect(created.has(path.join("/tmp/openrig-workspace", "missions"))).toBe(true);
    expect(created.has(path.join("/tmp/openrig-workspace", "exhaust"))).toBe(true);
    expect(written.get(path.join("/tmp/openrig-workspace", "SPEC.md"))).toContain("intent: 将此项目的持久工作组织为 mission 和 slice");
    expect(written.get(path.join("/tmp/openrig-workspace", "project.yaml"))).toContain("schema: openrig.project/v0alpha1");
    expect(written.get(path.join("/tmp/openrig-workspace", "workspace.yaml"))).toContain("schema: openrig.workspace/v0alpha1");
    expect(written.get(path.join("/tmp/openrig-workspace", ".gitignore"))).toContain("/exhaust/");
  });

  it("start：任何写入或 spawn 前拒绝精确的用户自有类型冲突", async () => {
    const conflict = "/tmp/openrig-context";
    const deps = startableDeps({
      pathKind: vi.fn((candidate: string) => candidate === conflict ? "file" : "missing"),
    });

    await expect(startDaemon({ contextRoot: conflict }, deps)).rejects.toThrow(
      `${conflict}：预期 directory，实际为 file`,
    );
    expect(deps.mkdirp).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  // Test 3：start 等待 healthz，写入 daemon.json（pid+port+db+startedAt）
  it("start：healthz 后把 pid、port、db、startedAt 写入 daemon.json", async () => {
    const deps = startableDeps();
    const result = await startDaemon({ port: 8000, db: "test.sqlite" }, deps);

    expect(result.pid).toBe(12345);
    expect(result.port).toBe(8000);
    expect(result.db).toBe("test.sqlite");
    expect(result.startedAt).toBeDefined();

    const state = writtenState(deps);
    expect(state.pid).toBe(12345);
    expect(state.port).toBe(8000);
    expect(state.db).toBe("test.sqlite");
    expect(state.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // Test 4：start 已在运行 -> 报错
  it("start：已在运行 -> 抛错", async () => {
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 99, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" });
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
    });

    await expect(startDaemon({}, deps)).rejects.toThrow(/已在运行|已在端口/);
  });

  it("start：无 daemon.json 但恢复出运行中的 daemon -> 抛错而非 spawn 重复实例", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://127.0.0.1:7433/healthz");
        return { ok: true };
      }),
    });

    await expect(startDaemon({}, deps)).rejects.toThrow(/已在运行|已在端口/);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  // Test 5：stop 从 daemon.json 读 pid，发 SIGTERM，删除 daemon.json
  it("stop：读 pid、发 SIGTERM、删除 daemon.json", async () => {
    const state: DaemonState = { pid: 555, port: 7433, db: "openrig.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return p.endsWith("daemon-shutdown.json") ? cleanReceipt(555) : null;
      }),
      fetch: vi.fn().mockResolvedValueOnce({ ok: true }).mockRejectedValue(new Error("refused")),
      isProcessAlive: vi.fn()
        .mockReturnValueOnce(true)   // first check: alive
        .mockReturnValueOnce(false), // after kill: dead
    });

    await stopDaemon(deps);

    expect(deps.kill).toHaveBeenCalledWith(555, "SIGTERM");
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  // Test 6：stop 未运行 -> 干净消息（不抛错）
  it("stop：未运行 -> 不抛错", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    });

    // 不应抛错
    await expect(stopDaemon(deps)).resolves.toBe("no-target");
  });

  it("stop：无 daemon.json 但恢复出运行中的 daemon -> 抛诚实错误", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://127.0.0.1:7433/healthz");
        return { ok: true };
      }),
    });

    await expect(stopDaemon(deps)).rejects.toThrow(/状态缺失|无法安全停止/);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  // Test 7：status 从 daemon.json 读 port，报 running 带 port
  it("status：运行中的 daemon（pid 存活 + healthz ok）-> { state: 'running', port, pid }", async () => {
    const state: DaemonState = { pid: 777, port: 9000, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => ({ ok: true })),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running");
    expect(status.port).toBe(9000);
    expect(status.pid).toBe(777);
    // 必然已检查 healthz
    expect(deps.fetch).toHaveBeenCalledWith("http://127.0.0.1:9000/healthz");
  });

  // Test 8: status stopped (no daemon.json) -> reports stopped
  it("status：无 daemon.json -> { state: 'stopped' }", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stopped");
  });

  // OPR.0.4.2.1 —— daemon-status 探测必须在重启后监听器绑定窗口内
  // 收敛一次瞬时的 /healthz 失败（有界重试），并如实报告 /healthz 的真实应答，
  // 而非误报 'down'/'unhealthy'。复现（RED）+ 回归守卫（不得掩盖真实宕机）。
  it("OPR.0.4.2.1 status：pid 存活、探测失败一次后 /healthz 应答 -> running + healthy（绑定窗口稳定）", async () => {
    const state: DaemonState = { pid: 777, port: 9000, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    let calls = 0;
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(state) : null)),
      isProcessAlive: vi.fn(() => true),
      sleep: async () => {},
      fetch: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("connect ECONNREFUSED"); // listener not yet accepting
        return { ok: true };
      }),
    });
    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running");
    expect(status.healthy).toBe(true); // settled to the real answer, not a transient false-negative
    expect((deps.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2); // retried
  });

  it("OPR.0.4.2.1 status：无 daemon.json、探测失败一次后 /healthz 应答 -> running，而非 stopped", async () => {
    let calls = 0;
    const deps = mockDeps({
      exists: vi.fn(() => false),
      sleep: async () => {},
      fetch: vi.fn(async () => { calls++; if (calls === 1) throw new Error("ECONNREFUSED"); return { ok: true }; }),
    });
    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running"); // NOT a false "stopped"
  });

  it("OPR.0.4.2.1 回归：真实宕机（探测恒失败、无状态）-> HARD-BOUNDED 重试后 stopped", async () => {
    let calls = 0;
    const deps = mockDeps({
      exists: vi.fn(() => false),
      sleep: async () => {},
      fetch: vi.fn(async () => { calls++; throw new Error("ECONNREFUSED"); }),
    });
    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stopped"); // bounded budget expires -> honestly stopped, never masked
    expect(calls).toBeLessThanOrEqual(8); // hard cap — no unbounded hammering / hang
  });

  it("OPR.0.4.2.1 回归：pid 存活但 healthz 不应答 -> running + healthy:false（不误报 healthy）", async () => {
    const state: DaemonState = { pid: 777, port: 9000, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(state) : null)),
      isProcessAlive: vi.fn(() => true),
      sleep: async () => {},
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    });
    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running"); // pid alive
    expect(status.healthy).toBe(false); // never answered -> honestly unhealthy, not falsely healthy
  });

  it("status：无 daemon.json 但已配置的 healthz 应答 -> running 但无 pid", async () => {
    const savedPort = process.env["OPENRIG_PORT"];
    const savedHost = process.env["OPENRIG_HOST"];
    process.env["OPENRIG_PORT"] = "7555";
    process.env["OPENRIG_HOST"] = "127.0.0.1";
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        fetch: vi.fn(async (url: string) => {
          expect(url).toBe("http://127.0.0.1:7555/healthz");
          return { ok: true };
        }),
      });

      const status = await getDaemonStatus(deps);
      expect(status).toEqual({
        state: "running",
        host: "127.0.0.1",
        port: 7555,
        healthy: true,
      });
    } finally {
      if (savedPort === undefined) delete process.env["OPENRIG_PORT"];
      else process.env["OPENRIG_PORT"] = savedPort;
      if (savedHost === undefined) delete process.env["OPENRIG_HOST"];
      else process.env["OPENRIG_HOST"] = savedHost;
    }
  });

  // 当 status 读取对应的 shutdown 未被确认时，必须保留目标身份。
  it("status：陈旧且无 shutdown 回执 -> 保留未核实目标", async () => {
    const state: DaemonState = { pid: 888, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => false),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stale");
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  // Test 10：start --port flag 存入 daemon.json 并转发到 env
  it("start：自定义 port 存入 daemon.json 并转发到 spawn env", async () => {
    const deps = startableDeps();
    await startDaemon({ port: 9999 }, deps);

    const state = writtenState(deps);
    expect(state.port).toBe(9999);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    const env = spawnMock.mock.calls[0]![2].env;
    expect(env.OPENRIG_PORT).toBe("9999");
  });

  // Test 11：从不同 cwd 调用 start -> 仍解析正确 daemon 路径
  it("getDaemonPath 与 cwd 无关，保持稳定", () => {
    const path1 = getDaemonPath();
    // 模拟不同 cwd：只需证明路径是绝对的且基于 import.meta
    //（cwd 不影响 import.meta.dirname 的 path.resolve）
    expect(path.isAbsolute(path1)).toBe(true);
    expect(path1).toContain("daemon");
  });

  // Test 12: logs reads daemon.log content
  it("readLogs：文件存在时返回 daemon.log 内容", () => {
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === LOG_FILE),
      readFile: vi.fn((p: string) => {
        if (p === LOG_FILE) return "line1\nline2\n";
        return null;
      }),
    });

    const content = readLogs(deps);
    expect(content).toBe("line1\nline2\n");
  });

  // Test 13: logs no log file -> returns null
  it("readLogs：无日志文件 -> 返回 null", () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
    });

    const content = readLogs(deps);
    expect(content).toBeNull();
  });

  // Test 14：CLI 委派：daemon status 命令使用注入的依赖
  it("daemonCommand(deps) status 以注入的 deps 调用 getDaemonStatus", async () => {
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");

    const deps = mockDeps({
      exists: vi.fn(() => false), // no daemon.json + no healthy daemon -> stopped
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    });

    const program = new Command();
    program.addCommand(daemonCommand(deps));

    // Capture console output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await program.parseAsync(["node", "rig", "daemon", "status"]);
    } finally {
      console.log = origLog;
    }

    // deps.exists 已被调用（证明委派经注入的 deps 发生）
    expect(deps.exists).toHaveBeenCalled();
    // 输出应反映已停止状态
    expect(logs.join("\n")).toMatch(/已停止/);
  });

  it("daemonCommand status：daemon 恢复时无状态则省略 pid", async () => {
    const savedPort = process.env["OPENRIG_PORT"];
    const savedHost = process.env["OPENRIG_HOST"];
    process.env["OPENRIG_PORT"] = "7555";
    process.env["OPENRIG_HOST"] = "127.0.0.1";
    try {
      const { daemonCommand } = await import("../src/commands/daemon.js");
      const { Command } = await import("commander");
      const deps = mockDeps({
        exists: vi.fn(() => false),
        fetch: vi.fn(async () => ({ ok: true })),
      });

      const program = new Command();
      program.addCommand(daemonCommand(deps));

      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));

      try {
        await program.parseAsync(["node", "rig", "daemon", "status"]);
      } finally {
        console.log = origLog;
      }

      const output = logs.join("\n");
      expect(output).toContain("后台服务运行于端口 7555");
      expect(output).not.toContain("pid undefined");
    } finally {
      if (savedPort === undefined) delete process.env["OPENRIG_PORT"];
      else process.env["OPENRIG_PORT"] = savedPort;
      if (savedHost === undefined) delete process.env["OPENRIG_HOST"];
      else process.env["OPENRIG_HOST"] = savedHost;
    }
  });

  it("daemonCommand stop 暴露 missing-state 恢复错误，而非声称成功", async () => {
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");
    const deps = mockDeps({
      exists: vi.fn(() => false),
      fetch: vi.fn(async () => ({ ok: true })),
    });

    const program = new Command();
    program.addCommand(daemonCommand(deps));

    const logs: string[] = [];
    const origErr = console.error;
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    console.error = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await program.parseAsync(["node", "rig", "daemon", "stop"]);
    } finally {
      console.error = origErr;
    }

    expect(logs.join("\n")).toMatch(/状态缺失|无法安全停止/);
    expect(process.exitCode).toBe(1);
    process.exitCode = savedExitCode;
  });

  it("S4b RED：被寻址的 OPENRIG_URL 监听器仍在时 daemon stop 拒绝报成功", async () => {
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");
    const savedUrl = process.env.OPENRIG_URL;
    const savedExitCode = process.exitCode;
    process.env.OPENRIG_URL = "http://127.0.0.1:7555";
    process.exitCode = undefined;
    const state: DaemonState = { pid: 555, port: 7433, db: "openrig.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : null),
      isProcessAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      fetch: vi.fn(async () => ({ ok: true })),
    });
    const program = new Command();
    program.addCommand(daemonCommand(deps));
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => out.push(args.join(" "));
    console.error = (...args: unknown[]) => err.push(args.join(" "));
    try {
      await program.parseAsync(["node", "rig", "daemon", "stop"]);
      expect(process.exitCode).toBe(1);
      expect(out.join("\n")).not.toContain("后台服务已停止");
      expect(err.join("\n")).toContain("http://127.0.0.1:7555");
      expect(err.join("\n")).toMatch(/healthz|health check/i);
      expect(err.join("\n")).toMatch(/无法安全停止|未发送任何信号/);
      expect(deps.kill).not.toHaveBeenCalled();
    } finally {
      console.log = origLog;
      console.error = origErr;
      process.exitCode = savedExitCode;
      if (savedUrl === undefined) delete process.env.OPENRIG_URL;
      else process.env.OPENRIG_URL = savedUrl;
    }
  });

  it("S4b RED：忽略 SIGTERM 的 daemon 报告 target、health check 与仍在监听的效果", async () => {
    vi.useFakeTimers();
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");
    const savedUrl = process.env.OPENRIG_URL;
    const savedExitCode = process.exitCode;
    process.env.OPENRIG_URL = "http://127.0.0.1:7555";
    process.exitCode = undefined;
    const state: DaemonState = { pid: 555, port: 7555, db: "openrig.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : null),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => ({ ok: true })),
    });
    const program = new Command();
    program.addCommand(daemonCommand(deps));
    const out: string[] = [];
    const err: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => out.push(args.join(" "));
    console.error = (...args: unknown[]) => err.push(args.join(" "));
    try {
      const stop = program.parseAsync(["node", "rig", "daemon", "stop"]);
      await vi.runAllTimersAsync();
      await stop;
      expect(process.exitCode).toBe(1);
      expect(out.join("\n")).not.toContain("后台服务已停止");
      expect(err.join("\n")).toContain("http://127.0.0.1:7555");
      expect(err.join("\n")).toMatch(/healthz|health check/i);
      expect(err.join("\n")).toMatch(/仍在监听/);
    } finally {
      console.log = origLog;
      console.error = origErr;
      vi.useRealTimers();
      process.exitCode = savedExitCode;
      if (savedUrl === undefined) delete process.env.OPENRIG_URL;
      else process.env.OPENRIG_URL = savedUrl;
    }
  });

  it("S4b RED：daemon stop 仅在被寻址 target 验证为 down 后才打印成功", async () => {
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");
    const savedUrl = process.env.OPENRIG_URL;
    const savedExitCode = process.exitCode;
    process.env.OPENRIG_URL = "http://127.0.0.1:7555";
    process.exitCode = undefined;
    const state: DaemonState = { pid: 555, port: 7555, db: "openrig.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify(state) : p.endsWith("daemon-shutdown.json") ? cleanReceipt(555) : null),
      isProcessAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      fetch,
    });
    const program = new Command();
    program.addCommand(daemonCommand(deps));
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => out.push(args.join(" "));
    try {
      await program.parseAsync(["node", "rig", "daemon", "stop"]);
      expect(process.exitCode).toBeUndefined();
      expect(out.join("\n")).toContain("后台服务已停止");
      expect(fetch.mock.calls.length).toBeGreaterThan(1);
      expect(fetch).toHaveBeenLastCalledWith("http://127.0.0.1:7555/healthz");
    } finally {
      console.log = origLog;
      process.exitCode = savedExitCode;
      if (savedUrl === undefined) delete process.env.OPENRIG_URL;
      else process.env.OPENRIG_URL = savedUrl;
    }
  });

  // Test 15：start 在缺失时创建 ~/.openrig 目录
  it("start：缺失时创建 OPENRIG_DIR", async () => {
    const deps = startableDeps();
    await startDaemon({ port: 7433 }, deps);

    expect(deps.mkdirp).toHaveBeenCalledWith(OPENRIG_DIR);
  });

  // Test 16：logs --follow 把 follow flag 传给 tailLogs
  it("tailLogs：以 follow=true 调用时触发 follow 行为", () => {
    const spawnFn = vi.fn(() => ({ pid: 1, unref: vi.fn(), on: vi.fn() }) as unknown as ChildProcess);
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === LOG_FILE),
      spawn: spawnFn,
    });

    tailLogs(deps, { follow: true });

    // 应在日志文件上 spawn tail -f
    expect(spawnFn).toHaveBeenCalledOnce();
    const [cmd, args] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe("tail");
    expect(args).toContain("-f");
    expect(args).toContain(LOG_FILE);
  });

  // Test 17：pid 存活 + healthz 失败 -> running 且 healthy=false，daemon.json 保留
  it("status：pid 存活但 healthz 失败 -> running、healthy=false、状态保留", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running");
    expect(status.healthy).toBe(false);
    expect(status.pid).toBe(999);
    expect(status.port).toBe(7433);
    // daemon.json 绝不能删除——stop 仍需要 pid
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  it("status：挂起的 healthz 探测有界地判定为 unhealthy，而非永久挂起", async () => {
    vi.useFakeTimers();
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(() => neverFetch()),
    });

    const statusPromise = getDaemonStatus(deps);
    await vi.runAllTimersAsync();
    const status = await statusPromise;

    expect(status.state).toBe("running");
    expect(status.healthy).toBe(false);
    vi.useRealTimers();
  });

  // Test 18：stop 一个不会死的进程 -> 抛错，daemon.json 保留
  it("stop：进程熬过 SIGTERM -> 抛错，daemon.json 不删除", async () => {
    const state: DaemonState = { pid: 111, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true), // never dies
    });

    await expect(stopDaemon(deps)).rejects.toThrow(/未退出/);
    expect(deps.kill).toHaveBeenCalledWith(111, "SIGTERM");
    // daemon.json 绝不能删除——进程仍在运行
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  // Test 19：start 遇到陈旧 PID（pid 存活但 healthz 失败）-> 允许启动（PID 复用安全）
  it("start：陈旧 PID（存活但非 rig）-> 继续启动新 daemon", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    let fetchCount = 0;
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      // 首次 fetch（校验已有 PID）：失败 -> 陈旧 PID
      // 后续 fetch（轮询新 daemon 的 healthz）：成功
      fetch: vi.fn(async () => {
        fetchCount++;
        if (fetchCount === 1) throw new Error("connection refused");
        return startupHealth();
      }),
    });

    const result = await startDaemon({ port: 7433 }, deps);
    expect(result.pid).toBe(12345); // new daemon spawned
  });

  it("start：既有 pid 上 healthz 探测挂起时抛 unresponsive 错误，而非 spawn 第二个 daemon", async () => {
    vi.useFakeTimers();
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(() => neverFetch()),
    });

    const startPromise = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await startPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/无响应/);
    expect(deps.spawn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // 被复用的 PID 绝不能收到信号，也不能擦除未决的 stop 身份。
  it("stop：陈旧 PID（存活但非 rig）-> 保留状态，不杀死", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
    });

    await expect(stopDaemon(deps)).rejects.toThrow(/身份未确认/);
    expect(deps.kill).not.toHaveBeenCalled();
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  it("stop：healthz 探测挂起时仍发 SIGTERM 并报告不可用的最终探测", async () => {
    vi.useFakeTimers();
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
      fetch: vi.fn(() => neverFetch()),
    });

    const stopPromise = expect(stopDaemon(deps)).rejects.toThrow(/未获核实.*监听者 unavailable/);
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(deps.kill).toHaveBeenCalledWith(999, "SIGTERM");
    expect(deps.removeFile).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Test 21：畸形 daemon.json -> 视为 stopped，不崩溃
  it("畸形 daemon.json -> getDaemonStatus 返回 stopped", async () => {
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return "NOT VALID JSON {{{";
        return null;
      }),
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stopped");
  });

  // Test 22：畸形 daemon.json -> startDaemon 继续（视为无状态）
  it("畸形 daemon.json -> startDaemon 正常继续", async () => {
    const deps = startableDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return "GARBAGE";
        return null;
      }),
    });

    const result = await startDaemon({ port: 7433 }, deps);
    expect(result.pid).toBe(12345);
  });

  // Test 23：start 遇到 unhealthy rig daemon（healthz 非 ok 应答）-> 阻断启动
  it("start：unhealthy 的 rig daemon（healthz 应答）-> 抛 already running", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      // healthz 应答（即便非 ok）→ port 归我们 → rig
      fetch: vi.fn(async () => ({ ok: false })),
    });

    await expect(startDaemon({ port: 7433 }, deps)).rejects.toThrow(/已在运行|已在端口/);
  });

  // Test 24：stop 遇到 unhealthy rig daemon -> 仍发 SIGTERM（那是我们的进程）
  it("stop：unhealthy 的 rig daemon -> 发 SIGTERM", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return p.endsWith("daemon-shutdown.json") ? cleanReceipt(999) : null;
      }),
      isProcessAlive: vi.fn()
        .mockReturnValueOnce(true)  // checkPid: alive
        .mockReturnValueOnce(false), // after kill: dead
      // healthz responds (non-ok) → still rig
      fetch: vi.fn().mockResolvedValueOnce({ ok: false }).mockRejectedValue(new Error("refused")),
    });

    await stopDaemon(deps);
    expect(deps.kill).toHaveBeenCalledWith(999, "SIGTERM");
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  // Test 25：start 用 process.execPath spawn，而非裸 "node"
  it("start：以 process.execPath 作为 Node 二进制 spawn", async () => {
    const deps = startableDeps();
    await startDaemon({ port: 7433, db: "openrig.sqlite" }, deps);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    const [cmd] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
  });

  it("start：healthz 始终不应答时内联呈现 native 模块运行时不匹配", async () => {
    vi.useFakeTimers();
    const deps = mockDeps({
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
      readFile: vi.fn((p: string) => {
        if (p === LOG_FILE) {
          return [
            "Error: The module '/tmp/better_sqlite3.node'",
            "was compiled against a different Node.js version using",
            "NODE_MODULE_VERSION 127. This version of Node.js requires",
            "NODE_MODULE_VERSION 141. Please try re-compiling or re-installing",
            "the module (for instance, using `npm rebuild` or `npm install`).",
            "code: 'ERR_DLOPEN_FAILED'",
          ].join("\n");
        }
        return null;
      }),
    });

    const startPromise = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await startPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/better-sqlite3|native module|node/i);
    expect(error.message).toContain(process.version);
    expect(error.message).toContain(process.execPath);
    vi.useRealTimers();
  });

  it("start：因其他原因启动崩溃时呈现最近一行 daemon 日志", async () => {
    vi.useFakeTimers();
    const deps = mockDeps({
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
      readFile: vi.fn((p: string) => {
        if (p === LOG_FILE) {
          return [
            "Booting daemon...",
            "Error: SQLite schema migration failed: disk full",
          ].join("\n");
        }
        return null;
      }),
    });

    const startPromise = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await startPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/disk full/i);
    vi.useRealTimers();
  });

  // Test 26: OPENRIG_URL set → getDaemonStatus bypasses daemon.json
  it("status：设置 OPENRIG_URL -> 直接探测 URL，忽略 daemon.json", async () => {
    const prev = process.env["OPENRIG_URL"];
    process.env["OPENRIG_URL"] = "http://127.0.0.1:7455";
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        readFile: vi.fn(() => null),
        fetch: vi.fn(async () => ({ ok: true })),
      });

      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("running");
      expect(status.port).toBe(7455);
      expect(status.healthy).toBe(true);
      // 从未读取 daemon.json
      expect(deps.readFile).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env["OPENRIG_URL"];
      else process.env["OPENRIG_URL"] = prev;
    }
  });

  // Test 27: OPENRIG_URL set but unreachable → stopped
  it("status：设置 OPENRIG_URL 但不可达 -> stopped", async () => {
    const prev = process.env["OPENRIG_URL"];
    process.env["OPENRIG_URL"] = "http://127.0.0.1:9999";
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        readFile: vi.fn(() => null),
        fetch: vi.fn(async () => { throw new Error("connection refused"); }),
      });

      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("stopped");
    } finally {
      if (prev === undefined) delete process.env["OPENRIG_URL"];
      else process.env["OPENRIG_URL"] = prev;
    }
  });

  it("createIsProcessAlive 把 zombie 进程视为已死", async () => {
    const { createIsProcessAlive } = await import("../src/commands/daemon.js");
    const isAlive = createIsProcessAlive({
      signalCheck: () => true,
      readProcessState: () => "Z",
    });

    expect(isAlive(123)).toBe(false);
  });

  it("createIsProcessAlive 保持非 zombie 进程存活", async () => {
    const { createIsProcessAlive } = await import("../src/commands/daemon.js");
    const isAlive = createIsProcessAlive({
      signalCheck: () => true,
      readProcessState: () => "S",
    });

    expect(isAlive(123)).toBe(true);
  });
});

describe("resolveDaemonPath", () => {
  // QA BLOCKING qitem-20260518054224——resolver 此前偏好打包（vendored）副本，
  // 导致 monorepo 开发流程在 packages/cli/daemon 未经 scripts/build-package.sh 重新组装时，
  // 跑的是陈旧的打包 daemon。修复后 resolver 在存在时优先选 monorepo 源码（packages/daemon），
  // 确保 `node packages/cli/dist/bin-wrapper.js daemon start` 在开发中始终启动 daemon 的
  // 真实来源。

  it("packages/daemon/dist/index.js 存在时返回 monorepo 源码路径（DEV——两路径并存）", () => {
    // 模拟 monorepo checkout：两条路径都有 dist/index.js
    //（vendored bundle 经 scripts/build-package.sh 装配 + 源码
    // daemon 经 @openrig/daemon 构建）。解析器选源码。
    const exists = (p: string) => p.endsWith("daemon/dist/index.js");
    const result = resolveDaemonPath("/repo/packages/cli/dist", exists);
    expect(result).toBe(path.resolve("/repo/packages/cli/dist", "../../daemon"));
  });

  it("仅 ../daemon/dist 存在时回退到打包路径（NPM-INSTALL——单路径）", () => {
    // Simulates `npm install -g @openrig/cli` layout:
    //   node_modules/@openrig/cli/{dist,daemon,ui}
    // Only ../daemon (sibling to cli/dist) exists; ../../daemon doesn't.
    const exists = (p: string) => {
      // monorepo path absent; bundled present
      if (p === path.resolve("/install/cli/dist", "../../daemon", "dist/index.js")) return false;
      if (p === path.resolve("/install/cli/dist", "../daemon", "dist/index.js")) return true;
      return false;
    };
    const result = resolveDaemonPath("/install/cli/dist", exists);
    expect(result).toBe(path.resolve("/install/cli/dist", "../daemon"));
  });

  it("即使什么都不存在也返回 monorepo 路径，便于调用方呈现清晰错误", () => {
    const exists = () => false;
    const result = resolveDaemonPath("/repo/packages/cli/dist", exists);
    expect(result).toBe(path.resolve("/repo/packages/cli/dist", "../../daemon"));
  });
});

describe("startDaemon env sanitization", () => {
  it("startDaemon 保留 Codex config root，但剔除瞬态 CODEX runtime/session 变量", async () => {
    // Pollute process.env temporarily
    const saved: Record<string, string | undefined> = {};
    const pollutants: Record<string, string> = {
      GHOSTTY_BIN_DIR: "/bad",
      TERM_PROGRAM: "ghostty",
      CMUX_WORKSPACE: "workspace:1",
      CMUX_PANEL_ID: "panel:7",
      CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
      CODEX_HOME: "/Users/tester/.codex-custom",
      CODEX_CI: "1",
      CODEX_THREAD_ID: "thread-123",
      COMMAND_MODE: "unix2003",
      __CFBundleIdentifier: "com.test",
    };
    for (const [k, v] of Object.entries(pollutants)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      const deps = startableDeps();
      await startDaemon({ port: 7433, host: "127.0.0.1", db: "/tmp/test.db" }, deps);

      const spawnCall = (deps.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const spawnEnv = spawnCall![2].env as Record<string, string>;

      // Scrubbed vars must NOT be in spawn env
      expect(spawnEnv["GHOSTTY_BIN_DIR"]).toBeUndefined();
      expect(spawnEnv["TERM_PROGRAM"]).toBeUndefined();
      expect(spawnEnv["CMUX_WORKSPACE"]).toBeUndefined();
      expect(spawnEnv["CODEX_CI"]).toBeUndefined();
      expect(spawnEnv["CODEX_THREAD_ID"]).toBeUndefined();
      expect(spawnEnv["COMMAND_MODE"]).toBeUndefined();
      expect(spawnEnv["__CFBundleIdentifier"]).toBeUndefined();

      // workspace 绑定命令所需的 cmux 上下文应保留
      expect(spawnEnv["CMUX_PANEL_ID"]).toBe("panel:7");
      expect(spawnEnv["CMUX_BUNDLED_CLI_PATH"]).toBe("/Applications/cmux.app/Contents/Resources/bin/cmux");

      // 核心变量必须存在
      expect(spawnEnv["HOME"]).toBeDefined();
      // CODEX_HOME is topology/config-root state consumed by the daemon; unlike
      // every other CODEX_* runtime/auth/session value, it must cross this boundary.
      expect(spawnEnv["CODEX_HOME"]).toBe("/Users/tester/.codex-custom");
      expect(spawnEnv["OPENRIG_PORT"]).toBe("7433");
    } finally {
      // Restore process.env
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("buildDaemonEnv", () => {
  it("仅保留 CODEX_HOME，因为它是 topology/config-root 状态", () => {
    const result = buildDaemonEnv({
      CODEX_HOME: "/Users/tester/.codex-custom",
      CODEX_CI: "1",
      CODEX_THREAD_ID: "thread-123",
      CODEX_SESSION_ID: "session-456",
      CODEX_AUTH_TOKEN: "transient-auth",
    }, { port: 7433, db: "/tmp/test.db" });

    expect(result["CODEX_HOME"]).toBe("/Users/tester/.codex-custom");
    expect(result["CODEX_CI"]).toBeUndefined();
    expect(result["CODEX_THREAD_ID"]).toBeUndefined();
    expect(result["CODEX_SESSION_ID"]).toBeUndefined();
    expect(result["CODEX_AUTH_TOKEN"]).toBeUndefined();
  });

  it("剔除 terminal/GUI 变量并保留核心变量", () => {
    const baseEnv: Record<string, string> = {
      HOME: "/Users/tester",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      USER: "tester",
      SHELL: "/bin/zsh",
      COLORTERM: "truecolor",
      COMMAND_MODE: "unix2003",
      CODEX_CI: "1",
      CODEX_THREAD_ID: "thread-123",
      GHOSTTY_BIN_DIR: "/Applications/Ghostty.app/bin",
      GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/resources",
      GHOSTTY_SHELL_FEATURES: "cursor,title",
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.0",
      TERMINFO: "/Applications/Ghostty.app/terminfo",
      XPC_FLAGS: "0x0",
      XPC_SERVICE_NAME: "0",
      __CFBundleIdentifier: "com.cmuxterm.app",
      __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
      CMUX_BUNDLE_ID: "com.cmuxterm.app",
      CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
      CMUX_PANEL_ID: "panel:1",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      CMUX_TAB_ID: "tab:1",
      CMUX_WORKSPACE: "workspace:1",
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:3",
      LANG: "en_US.UTF-8",
    };

    const result = buildDaemonEnv(baseEnv, { port: 7433, host: "127.0.0.1", db: "/tmp/test.db" });

    // Core vars preserved
    expect(result["HOME"]).toBe("/Users/tester");
    expect(result["PATH"]).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(result["USER"]).toBe("tester");
    expect(result["SHELL"]).toBe("/bin/zsh");
    expect(result["LANG"]).toBe("en_US.UTF-8");

    // OPENRIG_* set from opts
    expect(result["OPENRIG_PORT"]).toBe("7433");
    expect(result["OPENRIG_HOST"]).toBe("127.0.0.1");
    expect(result["OPENRIG_DB"]).toBe("/tmp/test.db");

    // Scrubbed vars absent
    expect(result["COLORTERM"]).toBeUndefined();
    expect(result["COMMAND_MODE"]).toBeUndefined();
    expect(result["CODEX_CI"]).toBeUndefined();
    expect(result["CODEX_THREAD_ID"]).toBeUndefined();
    expect(result["GHOSTTY_BIN_DIR"]).toBeUndefined();
    expect(result["GHOSTTY_RESOURCES_DIR"]).toBeUndefined();
    expect(result["GHOSTTY_SHELL_FEATURES"]).toBeUndefined();
    expect(result["TERM_PROGRAM"]).toBeUndefined();
    expect(result["TERM_PROGRAM_VERSION"]).toBeUndefined();
    expect(result["TERMINFO"]).toBeUndefined();
    expect(result["XPC_FLAGS"]).toBeUndefined();
    expect(result["XPC_SERVICE_NAME"]).toBeUndefined();
    expect(result["__CFBundleIdentifier"]).toBeUndefined();
    expect(result["__CF_USER_TEXT_ENCODING"]).toBeUndefined();
    expect(result["CMUX_SOCKET_PATH"]).toBeUndefined();
    expect(result["CMUX_WORKSPACE"]).toBeUndefined();
    expect(result["CMUX_SURFACE_ID"]).toBeUndefined();

    // workspace 绑定命令所需的 cmux 上下文已保留
    expect(result["CMUX_BUNDLE_ID"]).toBe("com.cmuxterm.app");
    expect(result["CMUX_BUNDLED_CLI_PATH"]).toBe("/Applications/cmux.app/Contents/Resources/bin/cmux");
    expect(result["CMUX_PANEL_ID"]).toBe("panel:1");
    expect(result["CMUX_TAB_ID"]).toBe("tab:1");
    expect(result["CMUX_WORKSPACE_ID"]).toBe("workspace:1");
  });

  it("显式 opts 覆盖 base env 中继承的 OPENRIG_*", () => {
    const baseEnv: Record<string, string> = {
      HOME: "/Users/tester",
      PATH: "/usr/bin",
      OPENRIG_PORT: "9999",
      OPENRIG_DB: "/old/path.db",
    };

    const result = buildDaemonEnv(baseEnv, { port: 7433, host: "127.0.0.1", db: "/new/path.db" });

    expect(result["OPENRIG_PORT"]).toBe("7433");
    expect(result["OPENRIG_DB"]).toBe("/new/path.db");
  });

  // bug-fix slice auth-bearer-tailscale-trust forward-fix:
  // Default-product-launch must NOT export OPENRIG_HOST so daemon's
  // index.ts falls through to the loopback+tailscale multi-bind path.
  describe("auth-bearer-tailscale-trust: explicit-vs-default host signal", () => {
    it("opts.host 未定义时省略 OPENRIG_HOST（default-product-launch）", () => {
      const baseEnv: Record<string, string> = { HOME: "/Users/tester", PATH: "/usr/bin" };
      const result = buildDaemonEnv(baseEnv, {
        port: 7433,
        db: "/tmp/test.db",
        // host intentionally omitted — operator never set it (default path)
      });
      expect(result["OPENRIG_HOST"]).toBeUndefined();
      // port + db still flow through
      expect(result["OPENRIG_PORT"]).toBe("7433");
      expect(result["OPENRIG_DB"]).toBe("/tmp/test.db");
    });

    it("opts.host 显式时设置 OPENRIG_HOST（用户显式选择）", () => {
      const baseEnv: Record<string, string> = { HOME: "/Users/tester", PATH: "/usr/bin" };
      const result = buildDaemonEnv(baseEnv, {
        port: 7433,
        host: "0.0.0.0",
        db: "/tmp/test.db",
      });
      expect(result["OPENRIG_HOST"]).toBe("0.0.0.0");
    });

    it("S20：继承的 OPENRIG_HOST 被清除——shell-env-wins 前提已死（路由 env 与 opt-in 字节不可区分；operator baton qitem-20260827070400）。Opt-in 走 OPENRIG_BIND_HOST", () => {
      // The old pin encoded the dead-premise design this slice re-grounds: an
      // inherited OPENRIG_HOST was treated as operator opt-in, and a managed
      // environment's injected routing value silently became single-bind policy
      // (the parent lost its Tailscale listener). The dedicated surface carries
      // the same opt-in unambiguously:
      const baseEnv: Record<string, string> = {
        HOME: "/Users/tester",
        PATH: "/usr/bin",
        OPENRIG_HOST: "0.0.0.0",
      };
      const scrubbed = buildDaemonEnv(baseEnv, { port: 7433, db: "/tmp/test.db" });
      expect(scrubbed["OPENRIG_HOST"]).toBeUndefined();
      const optedIn = buildDaemonEnv({ ...baseEnv, OPENRIG_BIND_HOST: "0.0.0.0" }, { port: 7433, db: "/tmp/test.db" });
      expect(optedIn["OPENRIG_BIND_HOST"]).toBe("0.0.0.0"); // the dedicated channel still wins
    });
  });

  // Slice 22 founder-walk-vm-populated-env 前向修复 #1：该 slice 刻意放弃 `--openrig-home`
  // CLI flag，改用 process-env 模式（每次 `rig` 调用经 shell 获得自己的 OPENRIG_HOME）。
  // slice 的"完全隔离状态"主张依赖模块加载时遵守 env 契约——具体即 getOpenRigHome() 返回
  // 当前 env 值（而非硬编码默认），且 getDefaultOpenRigPath 把它串入派生路径。模块级常量
  //（OPENRIG_DIR / STATE_FILE / LOG_FILE）只是这些函数在加载时的单次快照。
  //
  // 这些回归测试按留存的 feedback_poc_regression_must_discriminate，用区分值判别子证明函数契约。
  describe("slice 22: OPENRIG_HOME env contract for per-process state isolation", () => {
    it("getOpenRigHome 尊重 process.env.OPENRIG_HOME（不同值产出不同路径）", async () => {
      const { getOpenRigHome } = await import("../src/openrig-compat.js");
      const saved = process.env["OPENRIG_HOME"];
      try {
        process.env["OPENRIG_HOME"] = "/Users/example/.openrig-blank";
        const blank = getOpenRigHome();
        process.env["OPENRIG_HOME"] = "/Users/example/.openrig-populated";
        const populated = getOpenRigHome();
        expect(blank).toBe("/Users/example/.openrig-blank");
        expect(populated).toBe("/Users/example/.openrig-populated");
        expect(blank).not.toBe(populated);
      } finally {
        if (saved === undefined) delete process.env["OPENRIG_HOME"];
        else process.env["OPENRIG_HOME"] = saved;
      }
    });

    it("getDefaultOpenRigPath 把 env 解析出的 OPENRIG_HOME 串入派生路径（daemon.json + log）", async () => {
      const { getDefaultOpenRigPath } = await import("../src/openrig-compat.js");
      const saved = process.env["OPENRIG_HOME"];
      try {
        process.env["OPENRIG_HOME"] = "/Users/example/.openrig-blank";
        const blankState = getDefaultOpenRigPath("daemon.json");
        const blankLog = getDefaultOpenRigPath("daemon.log");
        process.env["OPENRIG_HOME"] = "/Users/example/.openrig-populated";
        const populatedState = getDefaultOpenRigPath("daemon.json");
        const populatedLog = getDefaultOpenRigPath("daemon.log");
        expect(blankState).toBe("/Users/example/.openrig-blank/daemon.json");
        expect(populatedState).toBe("/Users/example/.openrig-populated/daemon.json");
        expect(blankLog).toBe("/Users/example/.openrig-blank/daemon.log");
        expect(populatedLog).toBe("/Users/example/.openrig-populated/daemon.log");
        expect(blankState).not.toBe(populatedState);
        expect(blankLog).not.toBe(populatedLog);
      } finally {
        if (saved === undefined) delete process.env["OPENRIG_HOME"];
        else process.env["OPENRIG_HOME"] = saved;
      }
    });

    it("空 OPENRIG_HOME 回退到 homedir 默认值（而非字面空串）", async () => {
      const { getOpenRigHome } = await import("../src/openrig-compat.js");
      const { homedir } = await import("node:os");
      const saved = process.env["OPENRIG_HOME"];
      try {
        process.env["OPENRIG_HOME"] = "";
        const result = getOpenRigHome();
        expect(result).toBe(`${homedir()}/.openrig`);
      } finally {
        if (saved === undefined) delete process.env["OPENRIG_HOME"];
        else process.env["OPENRIG_HOME"] = saved;
      }
    });

    // FF2 regression test (per qitem-20260511115845-ee9a4775): the
    // prior 3 tests verify the openrig-compat function contract but
    // do NOT prove daemon-lifecycle's module-level OPENRIG_DIR /
    // STATE_FILE / LOG_FILE constants pick up OPENRIG_HOME at import
    // time. Future code could hardcode "~/.openrig" in
    // daemon-lifecycle.ts:66-69 and the prior tests would still pass.
    //
    // This test imports daemon-lifecycle FRESH twice via
    // vi.resetModules + dynamic import, with distinct OPENRIG_HOME
    // values per import. Discriminator-distinct paths (per banked
    // feedback_poc_regression_must_discriminate) prove each module
    // load reflects the env that was set at that moment. Will fail
    // if a future contributor hardcodes a literal path or otherwise
    // bypasses openrig-compat helpers at module level.
    it("daemon-lifecycle 模块级常量在 import 时反映 OPENRIG_HOME（slice 22 FF2）", async () => {
      const saved = process.env["OPENRIG_HOME"];
      try {
        // First import — OPENRIG_HOME = blank-slate value
        process.env["OPENRIG_HOME"] = "/Users/example/.openrig-vm-blank-fresh";
        vi.resetModules();
        const blank = await import("../src/daemon-lifecycle.js");

        // 第二次 import——OPENRIG_HOME = 填充值（不同目录；不等，也不是符号链接前缀）。
        // vi.resetModules 清空模块缓存，使第二次 import 在新 env 下重新求值模块级常量。
        process.env["OPENRIG_HOME"] = "/Users/example/.openrig-vm-populated-fresh";
        vi.resetModules();
        const populated = await import("../src/daemon-lifecycle.js");

        // OPENRIG_DIR — direct snapshot of getOpenRigHome() at module load
        expect(blank.OPENRIG_DIR).toBe("/Users/example/.openrig-vm-blank-fresh");
        expect(populated.OPENRIG_DIR).toBe("/Users/example/.openrig-vm-populated-fresh");
        expect(blank.OPENRIG_DIR).not.toBe(populated.OPENRIG_DIR);

        // STATE_FILE / LOG_FILE — derived as path.join(OPENRIG_DIR, "daemon.{json,log}")
        expect(blank.STATE_FILE).toBe("/Users/example/.openrig-vm-blank-fresh/daemon.json");
        expect(populated.STATE_FILE).toBe("/Users/example/.openrig-vm-populated-fresh/daemon.json");
        expect(blank.STATE_FILE).not.toBe(populated.STATE_FILE);

        expect(blank.LOG_FILE).toBe("/Users/example/.openrig-vm-blank-fresh/daemon.log");
        expect(populated.LOG_FILE).toBe("/Users/example/.openrig-vm-populated-fresh/daemon.log");
        expect(blank.LOG_FILE).not.toBe(populated.LOG_FILE);
      } finally {
        if (saved === undefined) delete process.env["OPENRIG_HOME"];
        else process.env["OPENRIG_HOME"] = saved;
        // Re-reset modules so subsequent tests (and the file-top
        // import of daemon-lifecycle at line 4-19) aren't holding
        // stale references to a module instance bound to a temp env.
        vi.resetModules();
      }
    });
  });

  describe("V1 pre-release CLI/daemon Item 1 — transcript rotation tunables projection", () => {
    it("提供时把 transcriptsLines + transcriptsPollIntervalSeconds 投影进 OPENRIG_* env 变量", () => {
      const baseEnv: Record<string, string> = { HOME: "/Users/tester", PATH: "/usr/bin" };
      const result = buildDaemonEnv(baseEnv, {
        port: 7433,
        host: "127.0.0.1",
        db: "/tmp/test.db",
        transcriptsLines: 500,
        transcriptsPollIntervalSeconds: 5,
      });
      expect(result["OPENRIG_TRANSCRIPTS_LINES"]).toBe("500");
      expect(result["OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"]).toBe("5");
    });

    it("opts 未定义时省略 transcript 轮转 env 变量，使轮转钩子回退自身默认值", () => {
      const baseEnv: Record<string, string> = { HOME: "/Users/tester", PATH: "/usr/bin" };
      const result = buildDaemonEnv(baseEnv, {
        port: 7433,
        host: "127.0.0.1",
        db: "/tmp/test.db",
      });
      expect(result["OPENRIG_TRANSCRIPTS_LINES"]).toBeUndefined();
      expect(result["OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"]).toBeUndefined();
    });

    it("设置 opts override 时从 base env 清除继承的 OPENRIG_TRANSCRIPTS_*，使 daemon 采纳文件存储的 ConfigStore 值", () => {
      const baseEnv: Record<string, string> = {
        HOME: "/Users/tester",
        PATH: "/usr/bin",
        OPENRIG_TRANSCRIPTS_LINES: "9999",
        OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "60",
      };
      const result = buildDaemonEnv(baseEnv, {
        port: 7433,
        host: "127.0.0.1",
        db: "/tmp/test.db",
        transcriptsLines: 500,
        transcriptsPollIntervalSeconds: 5,
      });
      expect(result["OPENRIG_TRANSCRIPTS_LINES"]).toBe("500");
      expect(result["OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS"]).toBe("5");
    });
  });
});

describe("ensureWorkspaceScaffold", () => {
  it("不覆盖已有 workspace 文件", () => {
    const existing = new Set<string>([
      "/tmp/ws",
      path.join("/tmp/ws", "SPEC.md"),
      path.join("/tmp/ws", "missions", "operator-note.md"),
    ]);
    const deps = mockDeps({
      exists: vi.fn((p: string) => existing.has(p)),
      mkdirp: vi.fn((p: string) => { existing.add(p); }),
      writeFile: vi.fn(),
    });

    const result = ensureWorkspaceScaffold("/tmp/ws", deps);

    expect(result.rootCreated).toBe(false);
    expect(result.files.find((f) => f.relPath === "SPEC.md")?.skipped).toBe("exists");
    expect(deps.writeFile).not.toHaveBeenCalledWith(
      path.join("/tmp/ws", "SPEC.md"),
      expect.any(String),
    );
    expect(existing).toContain(path.join("/tmp/ws", "missions", "operator-note.md"));
  });
});

// OPR.0.3.3.04.2 (AC-4): the ONE shared daemon-not-running honest error used by
// the daemon-dependent journey verbs (bootstrap/discover/workspace/workflow).
describe("daemonNotRunningError / printDaemonNotRunning (AC-4 shared honest error)", () => {
  it("daemonNotRunningError 为三段 fact/consequence/action 形状，指向 rig up / rig daemon start", () => {
    const err = daemonNotRunningError();
    expect(err.fact).toContain("后台服务未运行");
    expect(err.consequence).toContain("需要一个正在运行的后台服务");
    expect(err.action).toContain("zrig up");
    expect(err.action).toContain("zrig daemon start");
  });

  it("printDaemonNotRunning（人类）在 stderr 输出全部三段并设退出码 1", () => {
    const lines: string[] = [];
    const origErr = console.error;
    const origExit = process.exitCode;
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    process.exitCode = undefined;
    try {
      printDaemonNotRunning();
    } finally {
      console.error = origErr;
    }
    const exit = process.exitCode;
    process.exitCode = origExit;
    const out = lines.join("\n");
    expect(out).toContain("后台服务未运行");
    expect(out).toContain("需要一个正在运行的后台服务");
    expect(out).toContain("zrig up");
    expect(exit).toBe(1);
  });

  it("printDaemonNotRunning({ json: true }) 输出 { error: { fact, consequence, action } } 信封", () => {
    const lines: string[] = [];
    const origLog = console.log;
    const origExit = process.exitCode;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    process.exitCode = undefined;
    try {
      printDaemonNotRunning({ json: true });
    } finally {
      console.log = origLog;
    }
    process.exitCode = origExit;
    const parsed = JSON.parse(lines.join("")) as { error: { fact: string; consequence: string; action: string } };
    expect(parsed.error.fact).toContain("后台服务未运行");
    expect(parsed.error.consequence).toContain("需要一个正在运行的后台服务");
    expect(parsed.error.action).toContain("zrig up");
  });

  // ===================================================================
  // SLICE-05 item-4 (D4) — daemon-status false-negative RED.
  // getDaemonStatus' stateless (no daemon.json) branch returns "stopped" on ANY
  // /healthz throw, conflating a probe TIMEOUT (daemon reachable but slow /healthz,
  // e.g. answers in 400ms > the 250ms status probe) with genuine-down. Runtime repro
  // (REPRO-D4a): a delayed-/healthz shim makes candidate `rig status` say "Daemon not
  // running" while /api serves. RED pins the honest outcome (a slow-but-ANSWERING probe
  // must not be "stopped"); fix-agnostic (widened budget OR timeout-vs-conn-error).
  // Genuine-down (connection error) stays "stopped" (control preserved).
  // ===================================================================
  it("Slice-05 D4 RED：无 daemon.json 分支上慢但有应答的 /healthz 绝不能报 stopped", async () => {
    const savedUrl = process.env["OPENRIG_URL"];
    delete process.env["OPENRIG_URL"]; // force the no-state (config) branch, not the OPENRIG_URL branch
    vi.useFakeTimers();
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false), // no daemon.json -> stateless branch
        // /healthz ANSWERS 200, but after 400ms — past the 250ms probe, within a sane budget.
        fetch: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 400))),
      });
      const statusPromise = getDaemonStatus(deps);
      await vi.runAllTimersAsync();
      const status = await statusPromise;
      expect(status.state).not.toBe("stopped"); // <-- RED: currently "stopped" (timeout conflated with down)
    } finally {
      vi.useRealTimers();
      if (savedUrl !== undefined) process.env["OPENRIG_URL"] = savedUrl;
    }
  });

  it("Slice-05 D4 保留（GREEN）：真实宕机（连接错误、无 daemon.json）仍报 stopped", async () => {
    const savedUrl = process.env["OPENRIG_URL"];
    delete process.env["OPENRIG_URL"];
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        sleep: async () => {},
        fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }), // connection refused = confirmed down
      });
      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("stopped");
    } finally {
      if (savedUrl !== undefined) process.env["OPENRIG_URL"] = savedUrl;
    }
  });

  // The OTHER independent stateless catch->stopped branch: OPENRIG_URL set (the
  // firsthand D4a repro path). Same false-negative: a slow-but-answering /healthz
  // there is also reported stopped.
  it("Slice-05 D4 RED（OPENRIG_URL 分支）：慢但有应答的 /healthz 绝不能报 stopped", async () => {
    const savedUrl = process.env["OPENRIG_URL"];
    process.env["OPENRIG_URL"] = "http://127.0.0.1:9999"; // force the OPENRIG_URL branch
    vi.useFakeTimers();
    try {
      const deps = mockDeps({
        fetch: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 400))), // answers > 250ms probe
      });
      const statusPromise = getDaemonStatus(deps);
      await vi.runAllTimersAsync();
      const status = await statusPromise;
      expect(status.state).not.toBe("stopped"); // <-- RED: currently "stopped" (OPENRIG_URL branch catch)
    } finally {
      vi.useRealTimers();
      if (savedUrl !== undefined) process.env["OPENRIG_URL"] = savedUrl;
      else delete process.env["OPENRIG_URL"];
    }
  });

  it("Slice-05 D4 保留（GREEN，OPENRIG_URL 分支）：真实宕机（连接错误）仍报 stopped", async () => {
    const savedUrl = process.env["OPENRIG_URL"];
    process.env["OPENRIG_URL"] = "http://127.0.0.1:9999";
    try {
      const deps = mockDeps({ sleep: async () => {}, fetch: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) });
      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("stopped");
    } finally {
      if (savedUrl !== undefined) process.env["OPENRIG_URL"] = savedUrl;
      else delete process.env["OPENRIG_URL"];
    }
  });
});
