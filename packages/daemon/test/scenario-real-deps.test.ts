import { describe, it, expect, vi } from "vitest";
import { buildRealDeps, UnboundActionError } from "./helpers/scenario-real-deps.js";
import type { RigResult } from "./helpers/scenario-daemon.js";

// Slice 51-02——真实依赖适配器：将简单 runner 核心绑定到存活的 ScenarioDaemon。
// runAction 将每个动作动词映射到随附的 `zrig` 调用（以产品为事实的传输）；observe 绑定
// readSurface；daemon 动词驱动场景本地后台服务生命周期（绝不使用 rig 子进程）。v1 中
// 未绑定的动词会明确失败（与 FLAG-1 证明接口底线一致——绝不伪造）。

function fakeDaemon(over: Record<string, unknown> = {}) {
  return {
    readEnv: { OPENRIG_URL: "http://127.0.0.1:9", HOME: "/x" } as Record<string, string | undefined>,
    baseUrl: "http://127.0.0.1:9",
    sigterm: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    ...over,
  };
}

const ok = (stdout = ""): RigResult => ({ code: 0, stdout, stderr: "" });

describe("buildRealDeps runAction 动词到 zrig 的映射", () => {
  it("将 up 映射为 `zrig up <topology> --json --yes`，并捕获 rigId/rigName", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return ok(JSON.stringify({ rigId: "r-1", rigName: "demo" })); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    const r = await deps.runAction("up", {}, undefined);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual(["up", "/t/spec.yaml", "--json", "--yes"]);
  });

  it("为 up 追加 `--cwd <seatCwd>`，使席位写入落到临时目录（不污染启动 cwd）", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return ok(JSON.stringify({ rigId: "r-1", rigName: "demo" })); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", seatCwd: "/scratch/seat", runRig });
    await deps.runAction("up", {}, undefined);
    expect(calls[0]).toEqual(["up", "/t/spec.yaml", "--json", "--yes", "--cwd", "/scratch/seat"]);
  });

  it("将 send 映射为 `zrig send <to> <text> --json`（接收者来自 payload.to 或席位）", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await deps.runAction("send", { to: "a@r", text: "hello" }, undefined);
    expect(calls[0]).toEqual(["send", "a@r", "hello", "--json"]);
  });

  it("up 捕获 rigId 后，将 restart <seat> 映射为 `zrig launch <rigId> <seat> --json`", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return args[0] === "up" ? ok(JSON.stringify({ rigId: "r-9", rigName: "demo" })) : ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await deps.runAction("up", {}, undefined);
    await deps.runAction("restart", "seat-a", "seat-a");
    expect(calls[1]).toEqual(["launch", "r-9", "seat-a", "--json"]);
  });

  it("使用已捕获工作组将 down 映射为 `zrig down <rigName> --json --force`", async () => {
    const calls: string[][] = [];
    const runRig = vi.fn(async (args: string[]) => { calls.push(args); return args[0] === "up" ? ok(JSON.stringify({ rigId: "r-9", rigName: "demo" })) : ok(); });
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await deps.runAction("up", {}, undefined);
    await deps.runAction("down", {}, undefined);
    expect(calls[1]).toEqual(["down", "demo", "--json", "--force"]);
  });

  it("daemon 动词驱动场景本地后台服务生命周期，绝不使用 rig 子进程", async () => {
    const runRig = vi.fn(async () => ok());
    const daemon = fakeDaemon();
    const deps = buildRealDeps({ daemon, rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    expect((await deps.runAction("daemon", { op: "sigterm" }, undefined)).code).toBe(0);
    expect(daemon.sigterm).toHaveBeenCalledOnce();
    expect((await deps.runAction("daemon", { op: "restart" }, undefined)).code).toBe(0);
    expect(daemon.restart).toHaveBeenCalledOnce();
    expect(runRig).not.toHaveBeenCalled();
  });

  it("尚未启动工作组时 down 失败——不虚构目标", async () => {
    const runRig = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    const r = await deps.runAction("down", {}, undefined);
    expect(r.code).not.toBe(0);
    expect(runRig).not.toHaveBeenCalled();
  });

  it("v1 未绑定动词（restore/emit/mutate/policy/seed_regression）抛出 UnboundActionError——明确失败", async () => {
    const runRig = vi.fn(async () => ok());
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", runRig });
    await expect(deps.runAction("emit", { seat: "a@r", behavior: "restore" }, "a@r")).rejects.toBeInstanceOf(UnboundActionError);
    await expect(deps.runAction("seed_regression", { class: "x" }, undefined)).rejects.toBeInstanceOf(UnboundActionError);
    expect(runRig).not.toHaveBeenCalled();
  });

  it("公开可注入的 clock/sleep 和默认 within/poll 组合", async () => {
    const deps = buildRealDeps({ daemon: fakeDaemon(), rigBin: "/bin/rig", topologyPath: "/t/spec.yaml", now: () => 42, sleep: async () => {} });
    expect(deps.now()).toBe(42);
    expect(deps.defaults.withinMs).toBeGreaterThan(0);
    expect(deps.defaults.pollIntervalMs).toBeGreaterThan(0);
  });
});

describe("D2——未绑定动词消息说明原因并指明 v1 路径", () => {
  it("emit 拒绝消息指明缺失的输入通道并指向 env.stub_scripts", async () => {
    const deps = buildRealDeps({
      daemon: { readEnv: {}, baseUrl: "http://127.0.0.1:1", sigterm: async () => {}, restart: async () => {} },
      rigBin: "/bin/rig",
      topologyPath: "/t.yaml",
    });
    let msg = "";
    try { await deps.runAction("emit", { seat: "a@r", behavior: "compaction" }, "a@r"); } catch (e) { msg = (e as Error).message; }
    // 经验证的原因：stub runner 没有 stdin/输入通道，因此若无 51-01 源码工作，
    // 无法诚实绑定步骤期间的 emit。
    expect(msg).toContain("输入通道");
    // 以及当前确实可用的路径。
    expect(msg).toContain("env.stub_scripts");
    expect(msg.toLowerCase()).toContain("launch");
  });
});
