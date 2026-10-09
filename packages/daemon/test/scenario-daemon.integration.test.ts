import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import {
  spawnScenarioDaemon,
  runRig,
  findFreePort,
  type ScenarioDaemon,
} from "./helpers/scenario-daemon.js";

// Slice 51-02——强制本地后台服务 SPAWN（最后一个 hermetic-helper 单元）。集成：helper 在已清理的
// scratch env 下派生真实 scenario-local 后台服务（已构建的 `rig` bin），已发布的 `rig ps --json`
// 可读取它，stop() 可将其拆除。这是证明项 2（实时往返）的基础，在真实进程边界上证明，也是
// fail-closed helper 的核心意义（直接方法调用不能证明 transport）。
//
// 争用说明：会派生真实后台服务（数秒）；空闲端口避免冲突。fleet 高负载下 start/healthz 等待可能
// 较慢，但受 timeout 限制。

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");

function realBaseEnv() {
  return { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" };
}

describe("scenario-daemon 强制本地 spawn（集成）", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;

  afterEach(async () => {
    if (daemon) await daemon.stop().catch(() => {});
    else if (scaffold) scaffold.cleanup();
    daemon = undefined;
    scaffold = undefined;
  });

  it("findFreePort 返回可用临时端口", async () => {
    const p = await findFreePort();
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(65536);
  });

  it("派生真实强制本地后台服务、提供 ps 读取并完成拆除", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    // /healthz 在 helper 自身后台服务上可用。
    const health = await fetch(`${daemon.baseUrl}/healthz`);
    expect(health.ok).toBe(true);

    // 已发布读取可访问 scenario-local 后台服务（裸数组即空 rig 集合）。
    const ps = await runRig(["ps", "--json"], daemon.readEnv, RIG_BIN);
    expect(ps.code).toBe(0);
    const parsed = JSON.parse(ps.stdout);
    expect(Array.isArray(parsed)).toBe(true);

    // 拆除后后台服务消失（连接被拒绝），scaffold 被移除。
    const baseUrl = daemon.baseUrl;
    await daemon.stop();
    daemon = undefined;
    await expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow();
  }, 60_000);

  it("readEnv 指向 helper 自身后台服务，绝不指向外部目标", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    expect(daemon.readEnv.OPENRIG_URL).toBe(daemon.baseUrl);
    expect(daemon.baseUrl).toContain("127.0.0.1");
  }, 60_000);

  // 证明项 8（daemon-lifecycle A1 动作）：sigterm 终止 scenario-local 后台服务；restart 通过相同保证
  //（同端口/scratch）重新派生。
  it("daemon sigterm 终止 scenario-local 后台服务（healthz 被拒绝）", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    expect((await fetch(`${daemon.baseUrl}/healthz`)).ok).toBe(true);
    await daemon.sigterm();
    await expect(fetch(`${daemon.baseUrl}/healthz`)).rejects.toThrow();
  }, 60_000);

  it("daemon restart 在相同端口/scratch 上重新派生 scenario-local 后台服务", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });
    const beforePort = daemon.port;
    await daemon.restart();
    // 在相同端口恢复运行（通过相同 env 保证重新派生）。
    expect(daemon.port).toBe(beforePort);
    const health = await fetch(`${daemon.baseUrl}/healthz`);
    expect(health.ok).toBe(true);
    // 已发布读取仍能访问重新派生的后台服务。
    const ps = await runRig(["ps", "--json"], daemon.readEnv, RIG_BIN);
    expect(ps.code).toBe(0);
    expect(Array.isArray(JSON.parse(ps.stdout))).toBe(true);
  }, 60_000);
});
