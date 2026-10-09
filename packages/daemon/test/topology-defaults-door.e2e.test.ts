// OPR.0.5.3.6——真实入口（证明项 3，也是本可在首次出现时捕获 r2-B1 的检查）：
// 启动真实后台服务，执行真实 `rig up` 动词，使用干净临时 OPENRIG_HOME，随后在推导出的
// topology.root 下查找四个层级的已安装链文件。这不是单元证明：当已交付入口什么也没安装时，
// 单元测试仍为绿色，因为 installer 接到了 materializeValidatedSpec，而 `rig up` 走的是
// bootstrap → instantiate() 路径。本测试驱动用户的实际命令。
//
// 工作组只有一个 terminal runtime 成员（builtin:terminal，启动 action 为零），因此不会启动
// agent 形状的内容；席位落在 scaffold 自有 tmux server，而非机群 server。并发说明：
// 测试会启动真实后台服务（耗时数秒），并由 timeout 限定。
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import fs from "node:fs";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, runRig, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");

function realBaseEnv() {
  return { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" };
}

const DOOR_RIG_YAML = `version: "0.2"
name: door-rig
summary: door proof rig for shipped topology defaults
pods:
  - id: ops
    label: Ops
    members:
      - id: term
        agent_ref: "builtin:terminal"
        runtime: terminal
        profile: none
        cwd: "."
    edges: []
`;

describe("拓扑默认值入口（真实后台服务、真实 rig up）", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;

  afterEach(async () => {
    if (daemon) await daemon.stop().catch(() => {});
    else if (scaffold) scaffold.cleanup();
    daemon = undefined;
    scaffold = undefined;
  });

  it("rig up 在后台服务或文件系统拓扑修改前拒绝未知 topology key", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    const specDir = join(scaffold.root, "specs", "typo-rig");
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      join(specDir, "rig.yaml"),
      DOOR_RIG_YAML.replace("name: door-rig", "name: typo-rig\noperating_mod: lab"),
      "utf-8",
    );

    const up = await runRig(["up", join(specDir, "rig.yaml"), "--json"], daemon.readEnv, RIG_BIN);
    expect(up.code).toBe(2);
    expect(JSON.parse(up.stdout).error).toContain(
      'operating_mod：未知键 "operating_mod"；拒绝该规范，因为规范化会丢弃此键并改变请求的拓扑',
    );

    const ps = await runRig(["ps", "--json"], daemon.readEnv, RIG_BIN);
    expect(ps.code).toBe(0);
    expect(JSON.parse(ps.stdout).some((rig: { name?: string }) => rig.name === "typo-rig")).toBe(false);
    expect(fs.existsSync(join(scaffold.openrigHome, "topology", "rigs", "typo-rig"))).toBe(false);
  }, 120_000);

  it("rig up 后 context trace 依次遍历 runtime 匹配的 instance、rig、pod 和 seat 默认值", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    // scaffold 内的 spec 目录，在四个层级均携带 topology/ 默认值。
    const specDir = join(scaffold.root, "specs", "door-rig");
    fs.mkdirSync(join(specDir, "topology", "instance"), { recursive: true });
    fs.mkdirSync(join(specDir, "topology", "rig"), { recursive: true });
    fs.mkdirSync(join(specDir, "topology", "pods", "ops"), { recursive: true });
    fs.mkdirSync(join(specDir, "topology", "seats", "ops-term"), { recursive: true });
    fs.writeFileSync(join(specDir, "rig.yaml"), DOOR_RIG_YAML, "utf-8");
    fs.writeFileSync(join(specDir, "topology", "instance", "CRAFT.md"), "instance default (door)", "utf-8");
    fs.writeFileSync(join(specDir, "topology", "rig", "CRAFT.md"), "rig default (door)", "utf-8");
    fs.writeFileSync(join(specDir, "topology", "pods", "ops", "CRAFT.md"), "pod ops default (door)", "utf-8");
    fs.writeFileSync(join(specDir, "topology", "seats", "ops-term", "CRAFT.md"), "seat default (door)", "utf-8");

    // 真实入口：用户针对场景局部后台服务执行的实际命令。
    const up = await runRig(["up", join(specDir, "rig.yaml"), "--json"], daemon.readEnv, RIG_BIN);
    expect(up.code, `rig up failed: ${up.stdout} ${up.stderr}`).toBe(0);

    // 查找回执：四个层级全部填充，instance 位于根目录顶层。
    const topoRoot = join(scaffold.openrigHome, "topology");
    expect(fs.readFileSync(join(topoRoot, "CRAFT.md"), "utf-8")).toBe("instance default (door)");
    expect(fs.readFileSync(join(topoRoot, "rigs", "door-rig", "CRAFT.md"), "utf-8")).toBe("rig default (door)");
    expect(fs.readFileSync(join(topoRoot, "rigs", "door-rig", "pods", "ops", "CRAFT.md"), "utf-8")).toBe("pod ops default (door)");
    expect(fs.readFileSync(join(topoRoot, "rigs", "door-rig", "seats", "ops-term", "CRAFT.md"), "utf-8")).toBe("seat default (door)");

    const ps = await runRig(["ps", "--nodes", "--rig", "door-rig", "--json", "--fields", "rigName,podNamespace,logicalId"], daemon.readEnv, RIG_BIN);
    expect(ps.code, `rig ps failed: ${ps.stdout} ${ps.stderr}`).toBe(0);
    expect(JSON.parse(ps.stdout)).toMatchObject({
      entries: [{ rigName: "door-rig", podNamespace: "ops", logicalId: "ops.term" }],
      totalNodes: 1,
      truncated: false,
    });

    const trace = await runRig(["context", "trace", "--rig", "door-rig", "--pod", "ops", "--seat", "ops-term", "--name", "CRAFT.md", "--json"], daemon.readEnv, RIG_BIN);
    expect(trace.code, `rig context trace failed: ${trace.stdout} ${trace.stderr}`).toBe(0);
    expect(JSON.parse(trace.stdout).levels.map((level: { altitude: string; content: string }) => [level.altitude, level.content])).toEqual([
      ["instance", "instance default (door)"],
      ["rig", "rig default (door)"],
      ["pod", "pod ops default (door)"],
      ["seat", "seat default (door)"],
    ]);
  }, 120_000);

  it("来源判别器：已交付的 product-team 拓扑字节通过真实入口安装", async () => {
    // r2 遗留：合成入口已证明机制；本用例证明 product-team spec 源码中的真实 topology/ 目录
    // 经真实 `rig up` 后逐字节一致落地。它刻意与 check-packing.test.mjs 中的干净检出打包判别器
    // 分开；两个测试都不单独标榜为完整锁定证明项。已披露替身：成员集合只含一个 terminal 席位，
    // 而非真实 7-agent 名单（在封闭 scaffold 中启动 claude/codex agent 不能证明默认值，
    // 还会消耗真实 runtime）；installer 以 spec 目录的 topology/ 文件夹和工作组名称为 key，
    // 此处两者均采用已交付值。
    const shippedTopology = resolve(HERE, "../specs/rigs/preview/product-team/topology");
    expect(fs.statSync(shippedTopology).isDirectory()).toBe(true);

    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    const specDir = join(scaffold.root, "specs", "product-team");
    fs.mkdirSync(specDir, { recursive: true });
    fs.cpSync(shippedTopology, join(specDir, "topology"), { recursive: true });
    fs.writeFileSync(join(specDir, "rig.yaml"), DOOR_RIG_YAML.replace("name: door-rig", "name: product-team"), "utf-8");

    const up = await runRig(["up", join(specDir, "rig.yaml"), "--json"], daemon.readEnv, RIG_BIN);
    expect(up.code, `rig up failed: ${up.stdout} ${up.stderr}`).toBe(0);

    const topoRoot = join(scaffold.openrigHome, "topology");
    const shipped = (rel: string) => fs.readFileSync(join(shippedTopology, rel), "utf-8");
    expect(fs.readFileSync(join(topoRoot, "CRAFT.md"), "utf-8")).toBe(shipped("instance/CRAFT.md"));
    expect(fs.readFileSync(join(topoRoot, "rigs", "product-team", "CRAFT.md"), "utf-8")).toBe(shipped("rig/CRAFT.md"));
    expect(fs.readFileSync(join(topoRoot, "rigs", "product-team", "ORCHESTRATION-CRAFT.md"), "utf-8")).toBe(shipped("rig/ORCHESTRATION-CRAFT.md"));
    for (const seat of ["orch1-lead", "rev1-r1", "rev1-r2", "dev1-qa"]) {
      expect(fs.readFileSync(join(topoRoot, "rigs", "product-team", "seats", seat, "CRAFT.md"), "utf-8"))
        .toBe(shipped(`seats/${seat}/CRAFT.md`));
    }
  }, 120_000);
});
