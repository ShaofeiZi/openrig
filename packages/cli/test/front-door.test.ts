// Slice-17 mini-req 7 —— 裸 rig 前门（founder + arch 加固）。
// 裸 `rig`（无参数）：stdin 与 stdout 均为 TTY → 启动 TUI；任一流被
// 管道或重定向 → 落入正常 usage 路径并快速退出（绝不挂起脚本）；
// daemon 不可达 / TUI 初始化失败 → 给出有用的 usage，绝不输出堆栈；
// --help/--version/子命令视为参数，行为不变。新文件；既有 CLI 底线不动。
import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runFrontDoor, resolveTuiPath, probeFrontDoor, type FrontDoorIo } from "../src/front-door.js";
import { DaemonClient, DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "../src/client.js";

// 一个保证被拒绝的本地端口（绑定临时端口、捕获、关闭→连接被拒）。
// 真实 socket 拒绝，而非手工构造的错误——取得真实的 Node/undici 拒绝形态。
async function refusedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function io(overrides: Partial<FrontDoorIo> = {}): FrontDoorIo & {
  outLines: string[];
  errLines: string[];
  exits: number[];
  launches: number;
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const exits: number[] = [];
  const holder = { launches: 0 };
  return {
    outLines,
    errLines,
    exits,
    get launches() {
      return holder.launches;
    },
    stdinIsTTY: true,
    stdoutIsTTY: true,
    out: (l: string) => void outLines.push(l),
    err: (l: string) => void errLines.push(l),
    exit: (c: number) => void exits.push(c),
    probeDaemon: async () => true,
    launchTui: async () => {
      holder.launches += 1;
      return 0;
    },
    ...overrides,
  };
}

describe("bare-rig front door — ownership rules", () => {
  it("bare `rig` with BOTH streams TTY and the daemon up launches the TUI", async () => {
    const deps = io();
    const handled = await runFrontDoor(["node", "rig"], deps);
    expect(handled).toBe(true);
    expect(deps.launches).toBe(1);
    expect(deps.errLines.join("\n")).toBe("");
  });

  it("stdin piped (echo x | rig) → NOT owned: falls through to the normal usage path", async () => {
    const deps = io({ stdinIsTTY: false });
    expect(await runFrontDoor(["node", "rig"], deps)).toBe(false);
    expect(deps.launches).toBe(0);
  });

  it("stdout redirected (rig > file) → NOT owned: falls through to the normal usage path", async () => {
    const deps = io({ stdoutIsTTY: false });
    expect(await runFrontDoor(["node", "rig"], deps)).toBe(false);
    expect(deps.launches).toBe(0);
  });

  it("ANY argument (--help / --version / a subcommand) → NOT owned, regardless of TTY", async () => {
    for (const argv of [["node", "rig", "--help"], ["node", "rig", "--version"], ["node", "rig", "ps"], ["node", "rig", "context", "list"]]) {
      const deps = io();
      expect(await runFrontDoor(argv, deps), argv.join(" ")).toBe(false);
      expect(deps.launches).toBe(0);
    }
  });
});

describe("bare-rig front door — first-impression degrade (never a stack trace)", () => {
  it("BLOCKER 1: transport connect (daemon DOWN) LAUNCHES the crash-cart TUI, not a degrade-and-exit", async () => {
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state: "connect" as const },
          cwdRead: { state: "unknown" as const },
          commandPath: { state: "unknown" as const },
          enforcement: { axis: "not_applicable" as const, state: "unknown" as const, expected: null, effective: null, sourcePath: null, reason: "transport_unavailable" },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    const handled = await runFrontDoor(["node", "rig"], deps);
    expect(handled).toBe(true);
    // daemon 不可达状态正是 crash-cart cockpit 存在的意义——裸 `rig` 必须抵达它。
    expect(deps.launches).toBe(1);
    expect(deps.exits).toEqual([0]); // exits with the TUI's code, not a forced degrade exit(1)
    const text = deps.errLines.join("\n");
    expect(text).not.toMatch(/runtime posture: TRANSPORT_CONNECT/); // no degrade-and-exit for daemon-down
  });

  it("BLOCKER 1 PRODUCTION PATH: bare rig + daemon down via a REAL refused socket → the crash-cart TUI launches", async () => {
    // r1/guard round-6 规则：桩错误是对 Node 行为的断言——用真实 socket 取得。
    // 真实 DaemonClient 命中真实关闭端口（经 bind→close 保证拒绝）；真实 probeFrontDoor
    // 分类 + openMissionControl 启动决策在真实 undici 拒绝形态上运行。被测接缝处无伪造错误。
    const port = await refusedPort();
    const realClient = new DaemonClient(`http://127.0.0.1:${port}`, { timeoutMs: 1500 });
    const deps = io({ probeDaemon: () => probeFrontDoor({ client: realClient, env: {} }) });
    const handled = await runFrontDoor(["node", "rig"], deps);
    expect(handled).toBe(true);
    expect(deps.launches).toBe(1); // bare-rig + daemon-down → TUI launched into the crash-cart path
    expect(deps.errLines.join("\n")).not.toMatch(/runtime posture/); // not a degrade-and-exit
  });

  it.each([
    ["cwd denied", "visible", "available", "aligned", "CWD_READ_DENIED"],
    ["command missing", "visible", "missing", "aligned", "COMMAND_PATH_MISSING"],
    ["permission drift", "visible", "available", "drift", "PERMISSION_DRIFT"],
    ["permission unknown", "visible", "available", "unknown", "UNKNOWN_EFFECTIVE"],
  ] as const)("renders an axis-specific verdict for %s", async (_label, _healthyCwd, commandState, enforcementState, verdict) => {
    const cwdState = _label === "cwd denied" ? "denied" as const : "visible" as const;
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state: "healthy" as const },
          cwdRead: { state: cwdState },
          commandPath: { state: commandState },
          enforcement: {
            axis: "permission" as const,
            state: enforcementState,
            expected: "acceptEdits",
            effective: enforcementState === "unknown" ? null : { defaultMode: enforcementState === "drift" ? "manual" : "acceptEdits" },
            sourcePath: "/work/.claude/settings.local.json",
            ...(enforcementState === "unknown" ? { reason: "settings_unparseable" } : {}),
          },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    await runFrontDoor(["node", "rig"], deps);
    const text = deps.errLines.join("\n");
    expect(text).toContain(`运行时姿态：${verdict}`);
    expect(text).not.toMatch(/daemon not running/i);
  });

  it.each(["named_profile_unresolved", "applied_launch_unknown"] as const)(
    "launches the read-only TUI when Codex sandbox enforcement is unknown only because %s",
    async (reason) => {
      const deps = io({
        probeDaemon: async () => ({
          state: "diagnostic" as const,
          diagnostic: {
            transport: { state: "healthy" as const },
            cwdRead: { state: "visible" as const },
            commandPath: { state: "available" as const },
            enforcement: {
              axis: "sandbox" as const,
              state: "unknown" as const,
              expected: null,
              effective: null,
              sourcePath: null,
              reason,
            },
            observedAt: "2026-09-01T00:00:00.000Z",
          },
        }),
      });

      await runFrontDoor(["node", "rig"], deps);

      expect(deps.launches).toBe(1);
      expect(deps.exits).toEqual([0]);
      expect(deps.errLines).toEqual([]);
    },
  );

  it("front-door unreadable settings stays UNKNOWN_EFFECTIVE and never becomes daemon-down", async () => {
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state: "healthy" as const },
          cwdRead: { state: "visible" as const },
          commandPath: { state: "available" as const },
          enforcement: { axis: "permission" as const, state: "unknown" as const, expected: "acceptEdits", effective: null, sourcePath: "/work/.claude/settings.local.json", reason: "settings_unreadable" },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    await runFrontDoor(["node", "rig"], deps);
    const text = deps.errLines.join("\n");
    expect(text).toContain("运行时姿态：UNKNOWN_EFFECTIVE");
    expect(text).toContain("reason=settings_unreadable");
    expect(text).not.toMatch(/daemon not running/i);
    expect(deps.launches).toBe(0);
    expect(deps.exits).toEqual([1]);
  });

  it("permission drift renders all four axes plus expected/effective/source and never launches", async () => {
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state: "healthy" as const },
          cwdRead: { state: "visible" as const },
          commandPath: { state: "available" as const },
          enforcement: {
            axis: "permission" as const,
            state: "drift" as const,
            expected: "acceptEdits",
            effective: { defaultMode: "denyAll", allow: [], ask: [], deny: ["Read(/outside/**)"] },
            sourcePath: "/work/.claude/settings.local.json",
          },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    await runFrontDoor(["node", "rig"], deps);
    const text = deps.errLines.join("\n");
    expect(text).toContain("transport: healthy");
    expect(text).toContain("cwd/read: visible");
    expect(text).toContain("command/PATH: available");
    expect(text).toContain("permission: DRIFT");
    expect(text).toContain("expected=acceptEdits");
    expect(text).toContain("effective=denyAll");
    expect(text).toContain("source=/work/.claude/settings.local.json");
    expect(text).not.toMatch(/daemon not running/i);
    expect(deps.launches).toBe(0);
    expect(deps.exits).toEqual([1]);
  });

  it.each(["timeout", "response"] as const)("BLOCKER 1: transport %s (daemon not ready) LAUNCHES the TUI (its probe makes the down/unverified call)", async (state) => {
    const deps = io({
      probeDaemon: async () => ({
        state: "diagnostic" as const,
        diagnostic: {
          transport: { state, detail: `${state} detail` },
          cwdRead: { state: "unknown" as const },
          commandPath: { state: "unknown" as const },
          enforcement: { axis: "not_applicable" as const, state: "unknown" as const, expected: null, effective: null, sourcePath: null, reason: "transport_unavailable" },
          observedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    });
    await runFrontDoor(["node", "rig"], deps);
    expect(deps.launches).toBe(1); // not-ready → the TUI; its own crash-cart probe renders down vs unverified
    expect(deps.errLines.join("\n")).not.toMatch(/runtime posture/); // no degrade-and-exit
  });

  it("normalizes the legacy `false` probe (daemon down) → LAUNCHES the crash-cart TUI", async () => {
    const deps = io({ probeDaemon: async () => false });
    await runFrontDoor(["node", "rig"], deps);
    expect(deps.launches).toBe(1); // false → connect diagnostic → daemon-down → the cockpit, not a degrade
    expect(deps.errLines.join("\n")).not.toMatch(/runtime posture/);
  });

  it("normalizes a legacy transport-only timeout result (not ready) → LAUNCHES the TUI", async () => {
    const deps = io({ probeDaemon: async () => ({ state: "timeout", message: "legacy timeout detail" }) });
    await runFrontDoor(["node", "rig"], deps);
    expect(deps.launches).toBe(1); // timeout → not ready → TUI (its probe renders unverified)
    expect(deps.errLines.join("\n")).not.toMatch(/runtime posture/);
  });

  it("TUI init failure → helpful usage with the failure line, exit 1, no stack trace", async () => {
    const deps = io({
      launchTui: async () => {
        throw new Error("tui entry not found at /nope/main.js");
      },
    });
    const handled = await runFrontDoor(["node", "rig"], deps);
    expect(handled).toBe(true);
    const text = deps.errLines.join("\n");
    expect(text).toMatch(/tui entry not found/);
    expect(text).toMatch(/rig --help/);
    expect(text).not.toMatch(/\n\s+at /);
    expect(deps.exits).toEqual([1]);
  });

  it("the TUI's own exit code propagates", async () => {
    const deps = io({ launchTui: async () => 3 });
    await runFrontDoor(["node", "rig"], deps);
    expect(deps.exits).toEqual([3]);
  });
});

describe("front-door probe routing", () => {
  it("uses explicit current-seat whoami diagnostics for a managed seat", async () => {
    const paths: string[] = [];
    const result = await probeFrontDoor({
      env: { OPENRIG_NODE_ID: "node/1" },
      client: {
        get: async (path: string) => {
          paths.push(path);
          return {
            status: 200,
            data: {
              permissionDrift: {
                transport: { state: "healthy" },
                cwdRead: { state: "visible" },
                commandPath: { state: "available" },
                enforcement: { axis: "sandbox", state: "aligned", expected: "workspace-write", effective: "workspace-write", sourcePath: null },
                observedAt: "2026-08-08T00:00:00.000Z",
              },
            },
          };
        },
      },
    });
    expect(result).toEqual({ state: "ready" });
    expect(paths).toEqual(["/api/whoami?nodeId=node%2F1&compact=1&diagnostics=permission"]);
  });

  it("uses cheap health for an unmanaged shell", async () => {
    const paths: string[] = [];
    const result = await probeFrontDoor({
      env: {},
      client: { get: async (path: string) => { paths.push(path); return { status: 200, data: { status: "ok" } }; } },
    });
    expect(result).toEqual({ state: "ready" });
    expect(paths).toEqual(["/healthz"]);
  });

  it("normalizes a non-2xx daemon response into a complete four-axis diagnostic", async () => {
    const result = await probeFrontDoor({
      env: { OPENRIG_NODE_ID: "node-1" },
      client: { get: async () => ({ status: 503, data: {} }) },
    });
    expect(result).toMatchObject({
      state: "diagnostic",
      diagnostic: {
        transport: { state: "response" },
        cwdRead: { state: "unknown" },
        commandPath: { state: "unknown" },
        enforcement: { state: "unknown", reason: "transport_unavailable" },
      },
    });
  });

  it("never reports ready when transport is not healthy even if every local axis aligns", async () => {
    const result = await probeFrontDoor({
      env: { OPENRIG_NODE_ID: "node-1" },
      client: {
        get: async () => ({
          status: 200,
          data: {
            permissionDrift: {
              transport: { state: "timeout", detail: "upstream timed out" },
              cwdRead: { state: "visible" },
              commandPath: { state: "available" },
              enforcement: { axis: "permission", state: "aligned", expected: "acceptEdits", effective: "acceptEdits", sourcePath: null },
              observedAt: "2026-08-08T00:00:00.000Z",
            },
          },
        }),
      },
    });
    expect(result).toMatchObject({ state: "diagnostic", diagnostic: { transport: { state: "timeout", detail: "upstream timed out" } } });
  });

  it.each([
    ["connect", new DaemonConnectionError("refused")],
    ["timeout", new DaemonTimeoutError("slow")],
    ["response", new DaemonResponseError(502, "bad")],
  ] as const)("normalizes a %s exception into the same complete four-axis diagnostic", async (state, error) => {
    const result = await probeFrontDoor({
      env: { OPENRIG_NODE_ID: "node-1" },
      client: { get: async () => { throw error; } },
    });
    expect(result).toMatchObject({
      state: "diagnostic",
      diagnostic: {
        transport: { state },
        cwdRead: { state: "unknown" },
        commandPath: { state: "unknown" },
        enforcement: { state: "unknown", reason: "transport_unavailable" },
      },
    });
    expect((result as { diagnostic: { transport: { detail?: string } } }).diagnostic.transport.detail).toContain(error.message);
  });
});

describe("resolveTuiPath — monorepo-first, bundled fallback (the daemon resolver pattern)", () => {
  it("prefers the monorepo sibling dist, falls back to the bundled copy, null when neither", () => {
    const base = "/repo/packages/cli/dist";
    const mono = join("/repo/packages/cli/dist", "../../tui/dist/main.js");
    const bundled = join("/repo/packages/cli/dist", "../tui/dist/main.js");
    expect(resolveTuiPath(base, (p) => p === mono)).toBe(mono);
    expect(resolveTuiPath(base, (p) => p === bundled)).toBe(bundled);
    expect(resolveTuiPath(base, () => false)).toBeNull();
  });
});

describe("PUBLIC bin ownership (guard finding 1 — the wrapper is the real front door)", () => {
  const binWrapper = join(__dirname, "..", "dist", "bin-wrapper.js");
  const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
  it.skipIf(!existsSync(binWrapper) || !hasTmux)("bare PUBLIC bin under a REAL PTY reaches the crash-cart COCKPIT when the daemon is down (BLOCKER 1 ownership + reachability)", () => {
    // tmux 给进程两条流都提供真实 TTY。失效的 daemon URL 正是 crash-cart 状态：
    // 修复后前门启动 TUI，渲染 daemon 不可达 cockpit（"daemon not running"）——
    // 比旧 degrade 消息更强的归属证明（它抵达真实功能）。Commander 的 usage 旁路
    // 则意味着前门并未接管本次调用。
    // Isolated OPENRIG_HOME so the launched TUI never reads the live rig (fully contained + read-only).
    const session = `frontdoor-pin-${process.pid}`;
    const home = mkdtempSync(join(tmpdir(), "fd-tmux-home-"));
    spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf-8" });
    const run = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", session, "-x", "120", "-y", "30",
        `OPENRIG_HOME=${home} OPENRIG_URL=http://127.0.0.1:9 ${process.execPath} ${binWrapper}; sleep 15`],
      { encoding: "utf-8", timeout: 10000 },
    );
    expect(run.status).toBe(0);
    let text = "";
    for (let i = 0; i < 20 && !/EXPLORER|mission control could not start|Usage: rig/.test(text); i++) {
      spawnSync("sleep", ["0.5"]);
      text = spawnSync("tmux", ["capture-pane", "-t", session, "-p"], { encoding: "utf-8", timeout: 5000 }).stdout ?? "";
    }
    spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf-8" });
    rmSync(home, { recursive: true, force: true });
    // daemon 不可达时，前门启动了 TUI（其通用 chrome——EXPLORER pane——渲染），
    // 或在 TUI 未安装时诚实降级。二者都证明 PUBLIC bin 走了前门路径；commander 的 usage
    // 旁路则意味着没有。（crash-cart cockpit 渲染本身由 TUI 自有测试覆盖；启动决策由
    // 确定性生产路径测试覆盖。）
    expect(text).toMatch(/EXPLORER|no such file|任务控制/);
    expect(text).not.toMatch(/Usage: rig \[options\] \[command\]/);
  });

  // （移除了进程内强制 TTY「抵达 degrade 分支」的备用断言：其前提是快速 daemon 不可达
  // 降级，而 BLOCKER 1 的修复改为启动 crash-cart TUI。进程内强制 TTY 会生成交互式 TUI
  // 子进程（无干净退出）——不是安全/确定性的单元测试。编译包装器归属由上方 tmux cockpit
  // 测试（受控 + 杀死）与下方管道基线测试覆盖；前门启动决策由早前「PRODUCTION PATH…
  // REAL probeFrontDoor」测试确定性覆盖，且不生成真实 TUI。）

  it.skipIf(!existsSync(binWrapper))("piped PUBLIC bin keeps the commander usage baseline (no TUI, fast exit)", () => {
    const result = spawnSync(process.execPath, [binWrapper], {
      input: "x\n",
      timeout: 5000,
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/用法： zrig/);
  });

  it.skipIf(!existsSync(binWrapper))("PUBLIC bin subcommands are untouched (rig --version via wrapper)", () => {
    const result = spawnSync(process.execPath, [binWrapper, "--version"], { timeout: 5000, encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("script-safety integration (the compiled front door)", () => {
  const cliEntry = join(__dirname, "..", "dist", "index.js");
  it.skipIf(!existsSync(cliEntry))("`echo x | rig` returns usage fast — no hang (exit code preserves today's clean-help baseline)", () => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [cliEntry], {
      input: "x\n",
      timeout: 5000,
      encoding: "utf-8",
      env: { ...process.env, OPENRIG_URL: "", OPENRIG_PORT: "" },
    });
    expect(Date.now() - started).toBeLessThan(5000);
    // slice-17 之前基线：commander 的 clean-help 路径打印 usage 并
    // 以 0 退出——前门逐字节保留管道路径
    expect(result.status).toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/用法： zrig/);
    expect(`${result.stderr}${result.stdout}`).not.toMatch(/\n\s+at /);
  });

  it.skipIf(!existsSync(cliEntry))("`rig --help` still exits 0 with the full usage (front-door regression)", () => {
    const result = spawnSync(process.execPath, [cliEntry, "--help"], { timeout: 5000, encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/用法： zrig/);
    expect(result.stdout).toMatch(/daemon/);
  });
});
