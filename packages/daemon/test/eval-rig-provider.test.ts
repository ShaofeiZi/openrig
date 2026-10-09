// Test-A 预驱动（row 782b467a）——SESSION-PERSISTENT RigSeatProvider 模式：baseline -> WALK ->
// GET -> post 全程使用同一 seat/generation，在相同 EvalProvider 接缝后完成 R6 延后的 live-provider
// 环节（不是重新设计 harness）。live drive 仍由非作者负责；这些锁定证明 orchestration：持久性、
// input-echo contamination control、retirement，以及 legacy 路径上保留的 not-wired 拒绝。

import { describe, it, expect, vi } from "vitest";
import { RigSeatProvider, type RigSeatSession } from "./helpers/eval-rig-provider.js";

function fakeSession(overrides?: Partial<RigSeatSession> & { paneEcho?: boolean }): { session: RigSeatSession; sent: string[]; retired: { count: number } } {
  const sent: string[] = [];
  const retired = { count: 0 };
  const session: RigSeatSession = {
    generation: "gen-A",
    sendPrompt: async (p) => { sent.push(p); },
    captureSince: async (p) => `${overrides?.paneEcho === false ? "" : `${p}\n`}seat output for: ${p.slice(0, 12)}`,
    retire: async () => { retired.count += 1; },
    ...overrides,
  };
  return { session, sent, retired };
}

describe("RigSeatProvider——session-persistent 模式（Test-A）", () => {
  it("PERSISTENCE：四个 phase 在同一个已启动 seat/generation 上运行", async () => {
    const { session, sent } = fakeSession();
    const spawn = vi.fn(async () => session);
    const provider = new RigSeatProvider({ productionPackage: "/packs", session: { spawn } });
    for (const phase of ["baseline probe", "WALK ack", "GET pull", "post probe"]) {
      const res = await provider.run(phase);
      expect(res.error).toBeUndefined();
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["baseline probe", "WALK ack", "GET pull", "post probe"]);
  });

  it("INPUT-ECHO 负向控制：剥离 leading prompt echo——只匹配 prompt 文本的 grader pattern 无法通过", async () => {
    const { session } = fakeSession();
    const provider = new RigSeatProvider({ productionPackage: "/packs", session: { spawn: async () => session } });
    const res = await provider.run("magic-prompt-xyz nobody else says this");
    expect(res.transcript).not.toContain("magic-prompt-xyz nobody else says this\n");
    expect(res.transcript).toContain("seat output for: magic-prompt");
  });

  it("echo strip 只删除 leading echo——保留 seat 稍后的真实引用", async () => {
    const session: RigSeatSession = {
      generation: "gen-A",
      sendPrompt: async () => {},
      captureSince: async (p) => `${p}\nI will now do exactly what "${p}" asked.`,
      retire: async () => {},
    };
    const provider = new RigSeatProvider({ productionPackage: "/packs", session: { spawn: async () => session } });
    const res = await provider.run("pull the lifecycle entry");
    expect(res.transcript.startsWith("pull the lifecycle entry")).toBe(false);
    expect(res.transcript).toContain('what "pull the lifecycle entry" asked');
  });

  it("RETIREMENT：dispose 恰好退役一次；dispose 后 run() 显著拒绝", async () => {
    const { session, retired } = fakeSession();
    const provider = new RigSeatProvider({ productionPackage: "/packs", session: { spawn: async () => session } });
    await provider.run("one");
    await provider.dispose();
    await provider.dispose(); // 幂等。
    expect(retired.count).toBe(1);
    await expect(provider.run("two")).rejects.toThrow(/已 retired\/disposed/i);
  });

  it("保留 LEGACY PATH：无 session 依赖时，run() 仍抛出 R6 not-wired 拒绝（无 false green）", async () => {
    const provider = new RigSeatProvider({ productionPackage: "/packs" });
    await expect(provider.run("anything")).rejects.toThrow(/尚未驱动|provider fake/i);
  });

  it("SPAWN FAIL-FAST：spawn 失败会使本次运行失效——后续用例报错且不重新 spawn（六个 rig 泄漏类别）", async () => {
    const spawn = vi.fn(async () => { throw new Error("rig up failed: port conflict"); });
    const provider = new RigSeatProvider({ productionPackage: "/packs", session: { spawn } });
    await expect(provider.run("case one")).rejects.toThrow(/port conflict/);
    await expect(provider.run("case two")).rejects.toThrow(/已失败/);
    await expect(provider.run("case three")).rejects.toThrow(/已失败/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
