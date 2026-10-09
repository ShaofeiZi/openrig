import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  provisionTui,
  probeTuiState,
  TuiProvisioningError,
  type TuiProcessLike,
} from "./helpers/scenario-tui.js";

// 51-02 delta D7（guard binding）——TUI readiness boundary。
//
// readTuiSocket 遇到连接错误会立即 reject，expect poller 不捕获 observation error，因此
// “spawn 后立即继续”会使 #10 容易出现 race。provisioning 会在有界时间内等待真实 `state`
// 往返、检测提前退出，并在每条路径执行 teardown。

const dirs: string[] = [];
const servers: net.Server[] = [];
const conns: net.Socket[] = [];
afterEach(async () => {
  // 先销毁 live connection：server.close() 会等待它们，而刻意不完成正常 handshake 的 probe
  // 会挂起整个 suite。
  for (const c of conns.splice(0)) c.destroy();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sockPath = (): string => {
  const d = mkdtempSync(join(tmpdir(), "tui-"));
  dirs.push(d);
  return join(d, "t.sock");
};

/** 像已交付 TUI 一样回答 `state` 的 control socket。 */
function listenStateServer(path: string): Promise<net.Server> {
  const server = net.createServer((conn) => {
    conns.push(conn);
    conn.on("error", () => {});
    conn.on("data", () => {
      // 回复后结束：半开连接会在 cleanup 时挂起 server.close()
      conn.end(JSON.stringify({ ok: true, screen: "rigs", drill: [] }) + "\n");
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

/** 生命周期由测试控制的 fake TUI process。 */
function fakeProc(): TuiProcessLike & { exit(code: number): void; killed: boolean } {
  let exited = false;
  let resolveExit!: (c: number | null) => void;
  const exitedPromise = new Promise<number | null>((r) => { resolveExit = r; });
  const p = {
    exited: exitedPromise,
    hasExited: () => exited,
    killed: false,
    kill() { p.killed = true; if (!exited) { exited = true; resolveExit(143); } },
    exit(code: number) { if (!exited) { exited = true; resolveExit(code); } },
  };
  return p;
}

describe("D7——在时限内容许延迟 readiness", () => {
  it("socket 延迟开始回答 `state` 后继续", async () => {
    const path = sockPath();
    const proc = fakeProc();
    let ticks = 0;
    // 仅在第 3 次 probe 后开始 listen——曾导致 #10 中止的精确 race
    const provisioned = await provisionTui({
      socketPath: path,
      spawnTui: () => proc,
      readinessTimeoutMs: 10_000,
      probeIntervalMs: 1,
      now: () => ticks * 10,
      sleep: async () => { ticks++; if (ticks === 3) await listenStateServer(path); },
    });
    expect(provisioned.socketPath).toBe(path);
    expect(await probeTuiState(path)).toBe(true);
    await provisioned.stop();
    expect(proc.killed).toBe(true);
  });
});

describe("D7——提前退出会具名失败并执行 teardown", () => {
  it("报告 early_exit（非 timeout），且不留下 live process", async () => {
    const proc = fakeProc();
    proc.exit(1); // 第一次 probe 前已退出
    let err: TuiProvisioningError | undefined;
    try {
      await provisionTui({
        socketPath: sockPath(),
        spawnTui: () => proc,
        readinessTimeoutMs: 10_000,
        probeIntervalMs: 1,
        now: () => 0,
        sleep: async () => {},
        probe: async () => false,
      });
    } catch (e) { err = e as TuiProvisioningError; }
    expect(err).toBeInstanceOf(TuiProvisioningError);
    expect(err!.reason).toBe("early_exit");
    expect(err!.message).toContain("退出");
    expect(proc.hasExited()).toBe(true);
  });
});

describe("D7——永不 listen 的 socket 会具名超时并执行 teardown", () => {
  it("报告 readiness_timeout 并终止 process", async () => {
    const proc = fakeProc();
    let ticks = 0;
    let err: TuiProvisioningError | undefined;
    try {
      await provisionTui({
        socketPath: sockPath(),
        spawnTui: () => proc,
        readinessTimeoutMs: 50,
        probeIntervalMs: 1,
        now: () => ticks * 20,
        sleep: async () => { ticks++; },
        probe: async () => false,
      });
    } catch (e) { err = e as TuiProvisioningError; }
    expect(err).toBeInstanceOf(TuiProvisioningError);
    expect(err!.reason).toBe("readiness_timeout");
    expect(proc.killed).toBe(true); // failure 路径已执行 teardown
  });
});

describe("D7——probeTuiState 回答 contract，而非只判断 socket 是否存在", () => {
  it("无人 listen 时为 false，收到可解析 state reply 时为 true", async () => {
    const path = sockPath();
    expect(await probeTuiState(path, 200)).toBe(false);
    await listenStateServer(path);
    expect(await probeTuiState(path, 500)).toBe(true);
  });

  it("socket 返回非 JSON 时为 false（正在 listen 不代表 TUI 正常工作）", async () => {
    const path = sockPath();
    const server = net.createServer((conn) => { conns.push(conn); conn.on("error", () => {}); conn.end("not json\n"); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(path, () => r()));
    expect(await probeTuiState(path, 500)).toBe(false);
  });
});

describe("D7——provisioning 经 runScenarioFile 接线（opt-in、始终 teardown）", () => {
  it("仅在声明 env.tui 时 spawn，透传 socket path，并在运行后 teardown", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const d = mkdtempSync(join(tmpdir(), "tui-pipe-"));
    dirs.push(d);
    writeFileSync(join(d, "topo.yaml"), [
      'version: "0.2"', "name: scn-tui", "pods:", "  - id: dev", "    label: Dev",
      "    members:", "      - id: worker", '        agent_ref: "local:agents/worker"',
      "        profile: default", "        runtime: stub", "        cwd: .", "    edges: []", "",
    ].join("\n"));
    const scenarioPath = join(d, "tui.yaml");
    writeFileSync(scenarioPath, [
      "scenario: tui-provisioned",
      "topology: ./topo.yaml",
      "env:",
      "  tui: true",
      "steps:",
      "  - up: {}",
      "  - expect:",
      "      surface: tui_socket",
      "      within: 2s",
      "      match: { ok: true }",
      "",
    ].join("\n"));

    let spawnedWith: Record<string, string | undefined> | undefined;
    const proc = fakeProc();
    const upEnv: Record<string, string | undefined> = { PATH: process.env.PATH };
    const fakeDaemon = async () => ({
      readEnv: upEnv, baseUrl: "http://127.0.0.1:1",
      sigterm: async () => {}, restart: async () => {}, stop: async () => {},
    });
    // 使用能成功执行 `up` 的 zrig binary，使流程抵达 provisioning
    const fakeRig = join(d, "rig.mjs");
    writeFileSync(fakeRig, 'process.stdout.write(JSON.stringify({rigId:"r1",rigName:"scn-tui"}));\n');

    const result = await runScenarioFile(scenarioPath, {
      rigBin: fakeRig,
      baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
      daemon: fakeDaemon as never,
      spawnTui: (env) => {
        spawnedWith = env;
        // 立即在 pipeline 选择的路径上开始回答 `state`
        void listenStateServer(env.OPENRIG_TUI_SOCKET!);
        return proc;
      },
      deps: { defaults: { withinMs: 2000, pollIntervalMs: 20 } },
    });

    expect(spawnedWith?.OPENRIG_TUI_SOCKET).toMatch(/tui\.sock$/);
    expect(result.verdict).toBe("PASS"); // tui_socket expect 读取到真实 state reply
    expect(proc.killed).toBe(true);      // success 路径已 teardown
  });

  it("scenario 未声明 env.tui 时不 spawn TUI", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const d = mkdtempSync(join(tmpdir(), "tui-none-"));
    dirs.push(d);
    writeFileSync(join(d, "topo.yaml"), [
      'version: "0.2"', "name: scn-notui", "pods:", "  - id: dev", "    label: Dev",
      "    members:", "      - id: worker", '        agent_ref: "local:agents/worker"',
      "        profile: default", "        runtime: stub", "        cwd: .", "    edges: []", "",
    ].join("\n"));
    const scenarioPath = join(d, "s.yaml");
    writeFileSync(scenarioPath, [
      "scenario: no-tui", "topology: ./topo.yaml", "steps:", "  - up: {}", "",
    ].join("\n"));
    const fakeRig = join(d, "rig.mjs");
    writeFileSync(fakeRig, 'process.stdout.write("{}");\n');
    let spawned = false;
    await runScenarioFile(scenarioPath, {
      rigBin: fakeRig,
      baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
      daemon: (async () => ({
        readEnv: { PATH: process.env.PATH }, baseUrl: "http://127.0.0.1:1",
        sigterm: async () => {}, restart: async () => {}, stop: async () => {},
      })) as never,
      spawnTui: () => { spawned = true; return fakeProc(); },
    });
    expect(spawned).toBe(false);
  });
});

// Guard finding 3：下方 failure matrix 此前只覆盖 helper。helper pin 无法证明 runScenarioFile
// 会传播具名 failure 且仍执行 teardown，因此三个 case 现在都跨越 pipeline boundary。
describe("D7——failure matrix 跨越 runScenarioFile（每条路径都有具名 outcome + teardown）", () => {
  const setup = () => {
    const d = mkdtempSync(join(tmpdir(), "tui-fail-"));
    dirs.push(d);
    writeFileSync(join(d, "topo.yaml"), [
      'version: "0.2"', "name: scn-tuifail", "pods:", "  - id: dev", "    label: Dev",
      "    members:", "      - id: worker", '        agent_ref: "local:agents/worker"',
      "        profile: default", "        runtime: stub", "        cwd: .", "    edges: []", "",
    ].join("\n"));
    writeFileSync(join(d, "s.yaml"), [
      "scenario: tui-failure", "topology: ./topo.yaml", "env:", "  tui: true",
      "steps:", "  - up: {}",
      "  - expect: { surface: tui_socket, within: 1s, match: { ok: true } }", "",
    ].join("\n"));
    writeFileSync(join(d, "rig.mjs"), 'process.stdout.write(JSON.stringify({rigId:"r1",rigName:"scn-tuifail"}));\n');
    return d;
  };

  const daemonStops: number[] = [];
  const spawner = () => {
    let stops = 0;
    daemonStops.push(0);
    const idx = daemonStops.length - 1;
    return {
      spawn: (async (scaffold: { env: Record<string, string | undefined> }) => ({
        readEnv: { ...scaffold.env, OPENRIG_URL: "http://127.0.0.1:1" },
        baseUrl: "http://127.0.0.1:1",
        sigterm: async () => {}, restart: async () => {},
        stop: async () => { stops++; daemonStops[idx] = stops; },
      })) as never,
      stopped: () => daemonStops[idx],
    };
  };

  it("时限内延迟 readiness：运行继续通过 pipeline", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const d = setup();
    const proc = fakeProc();
    const dae = spawner();
    const result = await runScenarioFile(join(d, "s.yaml"), {
      rigBin: join(d, "rig.mjs"),
      baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
      daemon: dae.spawn,
      tuiReadiness: { readinessTimeoutMs: 5_000, probeIntervalMs: 20 },
      spawnTui: (env) => {
        // 只在真实延迟后开始 listen——曾使 #10 中止的 race
        setTimeout(() => { void listenStateServer(env.OPENRIG_TUI_SOCKET!); }, 150);
        return proc;
      },
      deps: { defaults: { withinMs: 3000, pollIntervalMs: 25 } },
    });
    expect(result.verdict).toBe("PASS");
    expect(proc.killed).toBe(true);
    expect(dae.stopped()).toBe(1);
  }, 60_000);

  it("提前退出：runScenarioFile 以 early_exit reject，并 teardown daemon", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const d = setup();
    const proc = fakeProc();
    proc.exit(1);
    const dae = spawner();
    let err: TuiProvisioningError | undefined;
    try {
      await runScenarioFile(join(d, "s.yaml"), {
        rigBin: join(d, "rig.mjs"),
        baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
        daemon: dae.spawn,
        tuiReadiness: { readinessTimeoutMs: 5_000, probeIntervalMs: 10 },
        spawnTui: () => proc,
      });
    } catch (e) { err = e as TuiProvisioningError; }
    expect(err).toBeInstanceOf(TuiProvisioningError);
    expect(err!.reason).toBe("early_exit");
    expect(dae.stopped()).toBe(1); // failure 路径中的 finally-block teardown
  }, 60_000);

  it("永不 listen：runScenarioFile 以 readiness_timeout reject 并 teardown", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const d = setup();
    const proc = fakeProc();
    const dae = spawner();
    let err: TuiProvisioningError | undefined;
    try {
      await runScenarioFile(join(d, "s.yaml"), {
        rigBin: join(d, "rig.mjs"),
        baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
        daemon: dae.spawn,
        tuiReadiness: { readinessTimeoutMs: 120, probeIntervalMs: 20 },
        spawnTui: () => proc, // 始终没有进程在 socket 上 listen
      });
    } catch (e) { err = e as TuiProvisioningError; }
    expect(err).toBeInstanceOf(TuiProvisioningError);
    expect(err!.reason).toBe("readiness_timeout");
    expect(proc.killed).toBe(true);
    expect(dae.stopped()).toBe(1);
  }, 60_000);
});
