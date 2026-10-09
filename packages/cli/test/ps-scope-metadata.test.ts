// OPR.0.5.0 — `rig ps --nodes` HONEST SCOPE METADATA. The current-rig-only default is CORRECT and
// 保留；该修复声明 scope，使 scoped 列表绝不被读成整个 host（宽度裁剪
// 诚实规则应用于 CLI 输出：静默看似完整的输出即静默丢失）。
// 经 STUB client 验证（DaemonClient http harness 在此环境本就损坏——
// res.json() "position 4"，Atom-5/S-C CLI-harness flake 类）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { psCommand } from "../src/commands/ps.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

const RIGS_MULTI = [
  { rigId: "rA", rigName: "alpha", name: "alpha" },
  { rigId: "rB", rigName: "beta", name: "beta" },
  { rigId: "rC", rigName: "gamma", name: "gamma" },
];
const RIGS_SINGLE = [{ rigId: "rA", rigName: "alpha", name: "alpha" }];
// LIVE-CLASS coherence fixture (review50-r1 finding @ fb8c8dcc): 4 rigs on host, but `rig ps`'s
// 裸默认 header 渲染 ACTIVE 投影（已停折叠进一行计数）——故诚实的
// "1 of N" 必须数操作员跟随提示所见的 2 个 ACTIVE rig，绝非全部 4 个。
const RIGS_MIXED = [
  { rigId: "rA", rigName: "alpha", name: "alpha", status: "running" }, // session rig (active)
  { rigId: "rB", rigName: "beta", name: "beta", status: "running" },
  { rigId: "rC", rigName: "gamma", name: "gamma", status: "stopped" },
  { rigId: "rD", rigName: "delta", name: "delta", status: "stopped" },
];
const NODE = { rigId: "rA", rigName: "alpha", logicalId: "dev.impl", canonicalSessionName: "dev-impl@alpha", lifecycleState: "running", sessionStatus: "running", agentActivity: null, hasAssignedWork: false, pendingWorkCount: 0 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubClientFactory(rigs: any[]) {
  return () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: async (path: string) => {
      if (path.startsWith("/api/ps")) return { status: 200, data: rigs };
      if (path.includes("/nodes")) return { status: 200, data: [NODE] };
      return { status: 200, data: [] };
    },
  }) as never;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deps(rigs: any[]): any {
  return {
    lifecycleDeps: { spawn: () => ({ pid: 1, unref() {} }), fetch: async () => ({ ok: true }), kill: () => true, readFile: (p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port: 1, db: "x", startedAt: "x" }) : null), writeFile() {}, removeFile() {}, exists: (p: string) => p === STATE_FILE, mkdirp() {}, openForAppend: () => 3, isProcessAlive: () => true },
    clientFactory: stubClientFactory(rigs),
  };
}
async function run(args: string[], rigs: unknown[]): Promise<{ out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const ol = console.log, oe = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { await psCommand(deps(rigs) as any).parseAsync(["node", "rig", ...args]); }
  finally { console.log = ol; console.error = oe; }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("rig ps --nodes honest scope metadata", () => {
  beforeEach(() => { process.env.OPENRIG_SESSION_NAME = "dev-impl@alpha"; }); // session rig = alpha
  afterEach(() => { delete process.env.OPENRIG_SESSION_NAME; });

  it("MULTI-RIG: --nodes --json gains a parseable scope object {rig, rigsOnHost, hint}", async () => {
    const { out } = await run(["--nodes", "--json"], RIGS_MULTI);
    const parsed = JSON.parse(out);
    expect(parsed.scope).toBeDefined();
    expect(parsed.scope.rig).toBe("alpha");
    expect(parsed.scope.rigsOnHost).toBe(3);
    expect(parsed.scope.hint).toContain("仅显示 3 个工作组中的 1 个");
    expect(parsed.scope.hint).toContain("zrig ps 可列出全部");
    expect(parsed.scope.hint).toMatch(/-A|--rig/);
    expect(parsed.entries).toHaveLength(1); // still scoped to the session rig (behavior unchanged)
  });

  it("MULTI-RIG: --nodes (human) renders ONE matching stderr hint line", async () => {
    const { err } = await run(["--nodes"], RIGS_MULTI);
    expect(err).toContain("个rig中的");
    expect(err).toContain("alpha");
    expect(err).toMatch(/zrig ps 列出全部|--rig NAME 或 -A/);
  });

  it("NO DEFAULT CHANGE: single-rig host → NO scope, bare array (byte-stable)", async () => {
    const { out, err } = await run(["--nodes", "--json"], RIGS_SINGLE);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true); // unchanged: bare array, no envelope, no scope
    expect(err).toBe(""); // no stderr hint when nothing is hidden
  });

  it("NO DEFAULT CHANGE: the scoped node set is unchanged (still the session rig only)", async () => {
    const { out } = await run(["--nodes", "--json"], RIGS_MULTI);
    const entries = JSON.parse(out).entries;
    expect(entries.every((n: { rigName: string }) => n.rigName === "alpha")).toBe(true);
  });

  it("LABEL-REFERENT COHERENCE: rigsOnHost counts the ACTIVE projection `rig ps` shows, not stopped rigs", async () => {
    // 4 rigs on host (2 active, 2 stopped). `rig ps`'s bare header renders the 2 active — so the
    // hint that DIRECTS the operator there must say "1 of 2", never "1 of 4" (the live-only finding).
    const { out, err } = await run(["--nodes", "--json"], RIGS_MIXED);
    const parsed = JSON.parse(out);
    expect(parsed.scope.rigsOnHost).toBe(2); // active projection, NOT rigRes.data.length (4)
    expect(parsed.scope.rigsOnHost).not.toBe(4); // the exact RED before the fix
    expect(parsed.scope.hint).toContain("仅显示 2 个工作组中的 1 个");
    expect(parsed.scope.hint).toContain("zrig ps 可列出全部");
    expect(err).toBe(""); // json path: no stderr
  });
});
