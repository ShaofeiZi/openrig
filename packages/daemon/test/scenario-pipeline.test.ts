import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadScenarioFile,
  ScenarioLoadError,
  ScenarioPreconditionError,
  extractQueuePreconditions,
  applyQueuePreconditions,
} from "./helpers/scenario-pipeline.js";
import type { RigResult } from "./helpers/scenario-daemon.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "scenarios");
const okRig = (stdout = ""): RigResult => ({ code: 0, stdout, stderr: "" });

// Slice 51-02——parse→validate→resolve 加载器。读取场景 YAML，相对场景文件解析其 `topology`
// rig-spec 路径，并校验架构形状。I/O + YAML 语法失败会明确抛出 ScenarioLoadError；内容问题
// 返回 validator 错误列表。这是 e2e pipeline 的纯前半段（重量级 spawn+run 属于集成路径）。

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });
function scratch(): string { dir = mkdtempSync(join(tmpdir(), "scn-pipe-")); return dir; }
function write(name: string, body: string): string {
  const d = dir ?? scratch();
  const p = join(d, name);
  writeFileSync(p, body, "utf-8");
  return p;
}

describe("loadScenarioFile", () => {
  it("解析有效场景，并相对场景文件解析 topology", () => {
    const p = write("s.yaml", [
      "scenario: baton-survives",
      "topology: ./topo.yaml",
      "steps:",
      "  - up: {}",
      "  - expect: { surface: queue, match: { state: in-progress } }",
    ].join("\n"));
    const res = loadScenarioFile(p);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.loaded.scenario.scenario).toBe("baton-survives");
    expect(isAbsolute(res.loaded.topologyPath)).toBe(true);
    expect(res.loaded.topologyPath).toBe(join(dir!, "topo.yaml"));
  });

  it("未知 surface 返回 validator 错误（明确失败而非静默处理）", () => {
    const p = write("s.yaml", [
      "scenario: bad",
      "topology: ./topo.yaml",
      "steps:",
      "  - expect: { surface: nope, match: { x: 1 } }",
    ].join("\n"));
    const res = loadScenarioFile(p);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => e.code === "UNKNOWN_EXPECT_SURFACE")).toBe(true);
  });

  it("YAML 格式错误时抛出 ScenarioLoadError", () => {
    const p = write("s.yaml", "scenario: [unterminated\n  : : :");
    expect(() => loadScenarioFile(p)).toThrow(ScenarioLoadError);
  });

  it("文件缺失时抛出 ScenarioLoadError", () => {
    expect(() => loadScenarioFile(join(tmpdir(), "does-not-exist-scn.yaml"))).toThrow(ScenarioLoadError);
  });
});

// 表达能力（proof item 7）：格式 + validator 以已创作并提交的 fixture 表达两个锁定 evidence
// 场景，由真实 loader 解析与校验（不使用 daemon）。重量级真实 tmux 运行属于集成套件。
describe("已创作的 evidence 场景（表达能力）", () => {
  it("表达 #2 queue-baton-survives-restart：通过校验、解析 topology 并携带 baton 前置条件", () => {
    const res = loadScenarioFile(join(FIXTURES, "scenario-02-baton.yaml"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.loaded.scenario.scenario).toBe("queue-baton-survives-restart");
    expect(basename(res.loaded.topologyPath)).toBe("topo-stub-baton.yaml");
    // steps 完整驱动 runner：up → expect queue → daemon restart → expect queue → down。
    const verbs = res.loaded.scenario.steps.map((s) => Object.keys(s)[0]);
    expect(verbs).toEqual(["up", "expect", "daemon", "expect", "down"]);
    // baton 前置条件可提取（fixture 层，不属于语法）。
    const pre = extractQueuePreconditions(res.loaded.scenario.env);
    expect(pre).toHaveLength(1);
    expect(pre[0]).toMatchObject({ id: "baton-1", destination: "dev-worker@scn-baton", claim: true });
  });

  it("表达 #10 one-view-state：跨两个 daemon 真相 surface 的声明式 equals 映射", () => {
    const res = loadScenarioFile(join(FIXTURES, "scenario-10-one-view-state.yaml"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.loaded.scenario.scenario).toBe("one-view-state-consistency");
    const expects = res.loaded.scenario.steps
      .filter((s) => "expect" in s)
      .map((s) => (s as { expect: Record<string, unknown> }).expect);

    // 51-03：equals 现在是声明式映射（A-N1 面向场景的形式），各 surface 声明承载共享真相的字段。
    const equalsStep = expects.find((e) => e.equals)!;
    expect(equalsStep.equals).toEqual({
      ps: { pluck: "name" },
      queue: { pluck: "destinationSession", rig: true },
    });

    // tui_socket 单独断言自身一致性，刻意不纳入 equality：已发布 control socket 的两个
    // OBSERVE 动词都返回 UI/registry 状态，因此不承载可比较的 daemon 真相；将其纳入只会
    // 通过比较天然相等的内容而通过。
    const tuiStep = expects.find((e) => e.surface === "tui_socket")!;
    expect(tuiStep).toBeDefined();
    expect(tuiStep.match).toEqual({ ok: true });
    expect(equalsStep.equals).not.toHaveProperty("tui_socket");
  });
});

describe("queue-baton 前置条件（P21 后身份：由 env 携带，绝不使用 body flag）", () => {
  it("每次调用通过 OPENRIG_SESSION_NAME 携带声明身份——creator=source、claimant=destination——且绝不传递已废弃的 --source flag", async () => {
    const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
    const runRig = vi.fn(async (args: string[], env: Record<string, string | undefined>) => {
      calls.push({ args, env });
      return okRig();
    });
    await applyQueuePreconditions(
      [{ id: "baton-1", source: "harness@r", destination: "dev-worker@r", claim: true }],
      { rigBin: "/bin/rig", readEnv: { OPENRIG_URL: "http://127.0.0.1:9" }, runRig },
    );
    // P21 I3（c4fad7b39）已废弃 --source（deprecated + IGNORED）：sender 通过 transport header
    // 传递，由 OPENRIG_SESSION_NAME 派生。argv 中若存在被忽略的 flag，会成为 harness 的陈旧
    // 声明，因此断言它不存在。
    expect(calls[0].args.slice(0, 6)).toEqual(["queue", "create", "--id", "baton-1", "--destination", "dev-worker@r"]);
    expect(calls[0].args).not.toContain("--source");
    expect(calls[0].env.OPENRIG_SESSION_NAME).toBe("harness@r");
    expect(calls[0].env.OPENRIG_URL).toBe("http://127.0.0.1:9"); // 保留 daemon target
    expect(calls[1].args).toEqual(["queue", "claim", "baton-1", "--destination", "dev-worker@r", "--json"]);
    expect(calls[1].env.OPENRIG_SESSION_NAME).toBe("dev-worker@r");
  });

  it("未设置 claim 时跳过认领，create 出错时关闭式失败", async () => {
    const noClaim = vi.fn(async () => okRig());
    await applyQueuePreconditions([{ id: "b", source: "s@r", destination: "d@r" }], { rigBin: "/bin/rig", readEnv: {}, runRig: noClaim });
    expect(noClaim).toHaveBeenCalledOnce(); // 仅 create

    const boom = vi.fn(async () => ({ code: 1, stdout: "", stderr: "dup id" }));
    await expect(
      applyQueuePreconditions([{ id: "b", source: "s@r", destination: "d@r", claim: true }], { rigBin: "/bin/rig", readEnv: {}, runRig: boom }),
    ).rejects.toBeInstanceOf(ScenarioPreconditionError);
  });

  it("明确拒绝格式错误的 env.queue 条目", () => {
    expect(() => extractQueuePreconditions({ queue: [{ id: "x" }] })).toThrow(ScenarioPreconditionError);
    expect(() => extractQueuePreconditions({ queue: "nope" })).toThrow(ScenarioPreconditionError);
    expect(extractQueuePreconditions(undefined)).toEqual([]);
  });
});

describe("D3——env.scope_mission 经完整路径保留到发布的 argv", () => {
  it("load → env-extract → real-deps → reader 生成 `zrig scope audit --mission <name> --json`", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const d = mkdtempSync(join(tmpdir(), "scope-mission-"));
    try {
      const argvLog = join(d, "argv.log");
      // 替代 `zrig` 的 bin：记录 pipeline 调用的真实 argv，从而固定组合路径（helper 层 argv spy
      // 可能在 pipeline 静默丢字段时仍然通过）。
      const fakeRig = join(d, "fake-rig.mjs");
      writeFileSync(fakeRig, [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'process.stdout.write("{}");',
        "",
      ].join("\n"));
      writeFileSync(join(d, "topo.yaml"), [
        'version: "0.2"', "name: scn-scope", "pods:", "  - id: dev", "    label: Dev",
        "    members:", "      - id: worker", '        agent_ref: "local:agents/worker"',
        "        profile: default", "        runtime: stub", "        cwd: .", "    edges: []", "",
      ].join("\n"));
      const scenarioPath = join(d, "scope.yaml");
      writeFileSync(scenarioPath, [
        "scenario: scope-mission-plumbing",
        "topology: ./topo.yaml",
        "env:",
        "  scope_mission: release-0.5.1",
        "steps:",
        "  - expect:",
        "      surface: scope",
        "      within: 0ms",
        "      match: { findings: [] }",
        "",
      ].join("\n"));

      const fakeDaemon = async () => ({
        // 真实 ScenarioDaemon 的 readEnv 携带 scaffold env（包括 PATH）。
        readEnv: { PATH: process.env.PATH }, baseUrl: "http://127.0.0.1:1",
        sigterm: async () => {}, restart: async () => {}, stop: async () => {},
      });
      await runScenarioFile(scenarioPath, {
        rigBin: fakeRig,
        baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
        daemon: fakeDaemon as never,
        deps: { defaults: { withinMs: 0, pollIntervalMs: 1 } },
      });

      const invocations = readFileSync(argvLog, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      expect(invocations).toContainEqual(["scope", "audit", "--mission", "release-0.5.1", "--json"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
