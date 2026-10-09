import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  stageTopologyRoot,
  resolveStubScriptTargets,
  deliverStubScripts,
  StubScriptTargetError,
  type StagedTopology,
} from "./helpers/scenario-stage.js";

// 51-02 delta D1（guard rev-3 bindings）——逐席位 stub script。
//
// 锁定要求场景解析逐席位 script；已发布 stub 只读取 `<cwd>/.openrig/stub/script.json`，
// 因而不同 script 需要不同的席位 CWD。共享 --cwd 无法满足这一点（resolveLaunchCwd 会使 override
// 对每个席位生效），所以 pipeline 会暂存一个自包含 topology root，并在暂存副本中写入逐席位 cwd。
// 只暂存单个 YAML 会改变 spec root 的基准，并使相对 culture_file / local: agent_ref 失去依附。

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "stage-"));
  dirs.push(d);
  return d;
};

/** 包含真实 fixture 所具备相对闭包的源 topology 目录。 */
function sourceTopologyDir(): { dir: string; topology: string } {
  const dir = scratch();
  mkdirSync(join(dir, "agents", "worker"), { recursive: true });
  writeFileSync(join(dir, "culture.md"), "# culture\n");
  writeFileSync(join(dir, "agents", "worker", "agent.yaml"), "id: worker\nrole: worker\n");
  const topology = join(dir, "topo.yaml");
  writeFileSync(
    topology,
    [
      'version: "0.2"',
      "name: scn-pair",
      "culture_file: culture.md",
      "pods:",
      "  - id: dev",
      "    label: Dev",
      "    members:",
      "      - id: alpha",
      '        agent_ref: "local:agents/worker"',
      "        profile: default",
      "        runtime: stub",
      "        cwd: .",
      "      - id: beta",
      '        agent_ref: "local:agents/worker"',
      "        profile: default",
      "        runtime: stub",
      "        cwd: .",
      "    edges: []",
      "",
    ].join("\n"),
  );
  return { dir, topology };
}

describe("D1——staging 复制自包含 root（相对闭包随之迁移）", () => {
  let staged: StagedTopology;
  let src: { dir: string; topology: string };

  const stage = () => {
    src = sourceTopologyDir();
    staged = stageTopologyRoot(src.topology, join(scratch(), "topology"));
    return staged;
  };

  it("在暂存 YAML 旁携带 culture.md 和 agents/**", () => {
    const s = stage();
    expect(existsSync(s.topologyPath)).toBe(true);
    expect(existsSync(join(s.root, "culture.md"))).toBe(true);
    expect(existsSync(join(s.root, "agents", "worker", "agent.yaml"))).toBe(true);
  });

  it("绝不写入已提交的源目录", () => {
    const s = stage();
    const before = readFileSync(src.topology, "utf-8");
    expect(before).toContain("cwd: ."); // source 保留其原始 cwd
    expect(readdirSync(src.dir).sort()).toEqual(["agents", "culture.md", "topo.yaml"]);
    expect(s.root).not.toContain(src.dir);
  });

  it("在暂存 root 内为每个席位写入不同且存在的 cwd", () => {
    const s = stage();
    const doc = parseYaml(readFileSync(s.topologyPath, "utf-8")) as any;
    const members = doc.pods[0].members;
    const cwds = members.map((m: any) => m.cwd);
    expect(new Set(cwds).size).toBe(2); // 彼此不同
    for (const c of cwds) {
      expect(c.startsWith(s.root)).toBe(true);
      expect(existsSync(c)).toBe(true);
    }
    expect(s.seatCwds["dev-alpha"]).toBe(members[0].cwd);
    expect(s.seatCwds["dev-beta"]).toBe(members[1].cwd);
  });

  it("除 cwd 值外与 source 在语义上相等（parse/serialize 无法保证字节一致）", () => {
    const s = stage();
    const strip = (raw: string) => {
      const d = parseYaml(raw) as any;
      for (const pod of d.pods) for (const m of pod.members) delete m.cwd;
      return d;
    };
    expect(strip(readFileSync(s.topologyPath, "utf-8"))).toEqual(strip(readFileSync(src.topology, "utf-8")));
  });
});

describe("D1——env.stub_scripts key 契约（在任何写入或 spawn 之前明确失败）", () => {
  const topo = {
    pods: [
      { id: "dev", members: [{ id: "alpha", runtime: "stub" }, { id: "beta", runtime: "stub" }] },
      { id: "ops", members: [{ id: "alpha", runtime: "stub" }, { id: "real", runtime: "claude-code" }] },
    ],
  };

  it("将带 pod 限定的 key 精确解析到一个 member", () => {
    expect(resolveStubScriptTargets(topo, { "dev-alpha": "a.json" })).toEqual({ "dev-alpha": "dev-alpha" });
  });

  it("解析无歧义的裸 member ID", () => {
    expect(resolveStubScriptTargets(topo, { beta: "b.json" })).toEqual({ beta: "dev-beta" });
  });

  it("拒绝 UNKNOWN key，并列出可用 stub 席位", () => {
    let msg = "";
    try { resolveStubScriptTargets(topo, { wroker: "a.json" }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("wroker");
    expect(msg).toContain("dev-alpha");
    expect(() => resolveStubScriptTargets(topo, { wroker: "a.json" })).toThrow(StubScriptTargetError);
  });

  it("拒绝匹配两个 pod 的 AMBIGUOUS 裸 key", () => {
    expect(() => resolveStubScriptTargets(topo, { alpha: "a.json" })).toThrow(/有歧义/);
  });

  it("拒绝 DUPLICATE ALIAS——两个 key 解析到同一 member", () => {
    expect(() => resolveStubScriptTargets(topo, { beta: "b.json", "dev-beta": "b2.json" })).toThrow(/同一席位|重复 alias/);
  });

  it("拒绝 NON-STUB 目标（script 永远不会被读取）", () => {
    expect(() => resolveStubScriptTargets(topo, { "ops-real": "r.json" })).toThrow(/runtime:stub|not a stub/i);
  });
});

describe("D1——delivery 将每个 script 写入其自身席位 cwd；未映射席位不写入任何内容", () => {
  it("只写入已映射席位的 script.json（未映射席位回退到内置默认值）", () => {
    const src = sourceTopologyDir();
    const scriptsDir = scratch();
    writeFileSync(join(scriptsDir, "a.json"), JSON.stringify({ steps: [{ kind: "say", text: "[alpha]" }] }));
    const staged = stageTopologyRoot(src.topology, join(scratch(), "topology"));

    deliverStubScripts(staged, { "dev-alpha": join(scriptsDir, "a.json") }, scriptsDir);

    const alphaScript = join(staged.seatCwds["dev-alpha"], ".openrig", "stub", "script.json");
    const betaScript = join(staged.seatCwds["dev-beta"], ".openrig", "stub", "script.json");
    expect(existsSync(alphaScript)).toBe(true);
    expect(JSON.parse(readFileSync(alphaScript, "utf-8")).steps[0].text).toBe("[alpha]");
    // 未映射席位没有 script 文件——应用 51-01 的内置默认值
    expect(existsSync(betaScript)).toBe(false);
  });

  it("script 文件缺失或格式错误时明确失败（绝不静默使用默认值）", () => {
    const src = sourceTopologyDir();
    const scriptsDir = scratch();
    const staged = stageTopologyRoot(src.topology, join(scratch(), "topology"));
    expect(() => deliverStubScripts(staged, { "dev-alpha": join(scriptsDir, "nope.json") }, scriptsDir)).toThrow(/nope\.json/);

    writeFileSync(join(scriptsDir, "bad.json"), "{not json");
    expect(() => deliverStubScripts(staged, { "dev-alpha": join(scriptsDir, "bad.json") }, scriptsDir)).toThrow();
  });
});

describe("D1 R4/R5——pipeline 级 fence", () => {
  it("R4：错误 script-map key 在任何文件系统或进程效果前失败", async () => {
    const { runScenarioFile } = await import("./helpers/scenario-pipeline.js");
    const src = sourceTopologyDir();
    const scenarioPath = join(src.dir, "bad-key.yaml");
    writeFileSync(
      scenarioPath,
      [
        "scenario: bad-key",
        "topology: ./topo.yaml",
        "env:",
        "  stub_scripts:",
        "    wroker: ./nope.json",
        "steps:",
        "  - up: {}",
        "",
      ].join("\n"),
    );
    // 在私有临时 root 中测量：scaffold 位于 os.tmpdir() 下，后者每次调用都会读取 TMPDIR；
    // 因此，只要其他 suite 并发创建 scaffold，对共享 /tmp 计数就会产生 flaky
    //（与 D5 pre-effect 固定测试遇到的是同一种自致竞争）。
    const priv = mkdtempSync(join(tmpdir(), "r4-preeffect-"));
    dirs.push(priv);
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = priv;
    let spawned = false;
    await expect(
      runScenarioFile(scenarioPath, {
        rigBin: "/nonexistent/rig",
        baseEnv: { HOME: "/tmp/x", PATH: process.env.PATH, TERM: "xterm" },
        // 会标记任何进程效果的 spawner——绝不能被调用
        daemon: async () => { spawned = true; throw new Error("spawner must not run"); },
      }),
    ).rejects.toThrow(StubScriptTargetError);
    expect(spawned).toBe(false);
    // 也没有创建 scaffold——私有 root 仍为空
    expect(readdirSync(priv)).toEqual([]);
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  });

  it("R5：container 模式按名称拒绝 scripted scenario，无 script 时则不受影响", async () => {
    const { runScenarioFile, ScenarioModeUnsupportedError } = await import("./helpers/scenario-pipeline.js");
    const src = sourceTopologyDir();
    const scriptsDir = scratch();
    writeFileSync(join(scriptsDir, "a.json"), JSON.stringify({ steps: [{ kind: "say", text: "hi" }] }));
    const scenarioPath = join(src.dir, "scripted.yaml");
    writeFileSync(
      scenarioPath,
      [
        "scenario: scripted",
        "topology: ./topo.yaml",
        "env:",
        "  stub_scripts:",
        `    dev-alpha: ${join(scriptsDir, "a.json")}`,
        "steps:",
        "  - up: {}",
        "",
      ].join("\n"),
    );
    let staged = 0;
    let stopped = 0;
    const containerish = async () => ({
      readEnv: {}, baseUrl: "http://127.0.0.1:1",
      sigterm: async () => {}, restart: async () => {},
      stop: async () => { stopped++; },
      stageTopology: async (p: string) => { staged++; return p; },
    });
    await expect(
      runScenarioFile(scenarioPath, {
        rigBin: "/nonexistent/rig",
        baseEnv: { HOME: "/tmp/x", PATH: process.env.PATH, TERM: "xterm" },
        daemon: containerish as never,
      }),
    ).rejects.toBeInstanceOf(ScenarioModeUnsupportedError);
    expect(staged).toBe(0);   // 从未到达 container stage 路径
    expect(stopped).toBe(1);  // teardown 仍已运行
  });
});
