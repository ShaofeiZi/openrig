// OPR.0.4.4.11——routes/up.ts 拓扑分支（S11-6）。
//
// 固定项：该分支经真实路由器分类、经真实清单模块校验、相对于清单目录解析路径形式
// 的条目、驱动注入式编排器接缝（同一公开 bootstrap() 与 tryAcquire/release 组合）、
// 在公开写入路径拒绝 host 标志加拓扑（R11-2 守护进程侧），并返回如实的封闭聚合。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Hono } from "hono";
import { upRoutes } from "../src/routes/up.js";
import { UpCommandRouter } from "../src/domain/up-command-router.js";

const VALID_SPEC = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

function realFsOps() {
  return {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    readHead: (p: string, bytes: number) => {
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, 0);
      fs.closeSync(fd);
      return buf;
    },
  };
}

interface BootstrapCall {
  sourceRef: string;
  sourceKind: string;
  autoApprove?: boolean;
}

function makeApp(opts: { bootstrapResult?: (call: BootstrapCall) => { status: string; errors: string[] } } = {}) {
  const calls: BootstrapCall[] = [];
  const locks: string[] = [];
  const orchestrator = {
    tryAcquire: (ref: string) => {
      locks.push(`acquire:${ref}`);
      return true;
    },
    release: (ref: string) => {
      locks.push(`release:${ref}`);
    },
    bootstrap: async (o: BootstrapCall & Record<string, unknown>) => {
      calls.push({ sourceRef: o.sourceRef, sourceKind: o.sourceKind, autoApprove: o.autoApprove as boolean | undefined });
      const shaped = opts.bootstrapResult?.(o) ?? { status: "completed", errors: [] };
      return { runId: "run-1", rigId: "rig-1", stages: [], warnings: [], ...shaped };
    },
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("bootstrapOrchestrator", orchestrator);
    set("bootstrapRepo", {});
    set("eventBus", { emit: () => {} });
    set("upRouter", new UpCommandRouter({ fsOps: realFsOps() }));
    set("rigRepo", {});
    await next();
  });
  app.route("/api/up", upRoutes);
  return { app, calls, locks };
}

describe("POST /api/up——拓扑分支", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "topo-route-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(content: string, name = "factory.rigtopology"): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it("通过注入式 bootstrap 接缝启动全本地拓扑；条目相对清单目录解析；返回 200 与封闭聚合", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.yaml"), VALID_SPEC);
    fs.writeFileSync(path.join(tmpDir, "b.yaml"), VALID_SPEC);
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\n  - source: ./b.yaml\n");
    const { app, calls, locks } = makeApp();

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest, autoApprove: true }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["ok"]).toBe(true);
    expect(data["topology"]).toBe(manifest);
    expect(data["entries"]).toEqual([
      { rigRef: "./a.yaml", host: "local", status: "ok" },
      { rigRef: "./b.yaml", host: "local", status: "ok" },
    ]);
    // 叶节点以相对清单目录解析的引用和请求中的 autoApprove 调用。
    expect(calls).toEqual([
      { sourceRef: path.join(tmpDir, "a.yaml"), sourceKind: "rig_spec", autoApprove: true },
      { sourceRef: path.join(tmpDir, "b.yaml"), sourceKind: "rig_spec", autoApprove: true },
    ]);
    // 路由侧逐条目锁纪律（护栏 G-2），按顺序执行——锁键就是启动引用（护栏 F1）：
    // 并发的独立 `zrig up <resolved path>` 共享完全相同的锁域。
    expect(locks).toEqual([
      `acquire:${path.join(tmpDir, "a.yaml")}`,
      `release:${path.join(tmpDir, "a.yaml")}`,
      `acquire:${path.join(tmpDir, "b.yaml")}`,
      `release:${path.join(tmpDir, "b.yaml")}`,
    ]);
    // 显式不变量：每个获取的键都等于已 bootstrap 的 sourceRef。
    const acquired = locks.filter((l) => l.startsWith("acquire:")).map((l) => l.slice("acquire:".length));
    expect(acquired).toEqual(calls.map((c) => c.sourceRef));
  });

  it("R11-2 守护进程侧：host 标志 + 拓扑源 → 400，并指出逐条目 host:（公开写入路径）", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.yaml"), VALID_SPEC);
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\n");
    const { app, calls } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest, host: "vps-b" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["code"]).toBe("host_flag_topology");
    expect(String(data["error"])).toContain("per-entry 'host:'");
    expect(calls).toEqual([]); // 未启动任何内容
  });

  it("无效清单 → 400 invalid_topology_manifest 与逐条目错误（edge 键指出非目标）", async () => {
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\nedges:\n  - from: a\n");
    const { app, calls } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["code"]).toBe("invalid_topology_manifest");
    expect(String((data["errors"] as string[])[0])).toContain("创建者批准的非目标");
    expect(calls).toEqual([]);
  });

  it("条目失败 → 500 与如实的部分聚合（ok + failed + 显式 skipped）", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.yaml"), VALID_SPEC);
    fs.writeFileSync(path.join(tmpDir, "bad.yaml"), VALID_SPEC);
    fs.writeFileSync(path.join(tmpDir, "c.yaml"), VALID_SPEC);
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\n  - source: ./bad.yaml\n  - source: ./c.yaml\n");
    const { app } = makeApp({
      bootstrapResult: (call) =>
        call.sourceRef.endsWith("bad.yaml") ? { status: "failed", errors: ["阶段 IMPORT_RIG 失败：boom"] } : { status: "completed", errors: [] },
    });
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest }),
    });
    expect(res.status).toBe(500);
    const data = (await res.json()) as { ok: boolean; entries: Array<Record<string, unknown>> };
    expect(data.ok).toBe(false);
    expect(data.entries[0]).toMatchObject({ status: "ok" });
    expect(data.entries[1]).toMatchObject({ status: "failed", error: "阶段 IMPORT_RIG 失败：boom" });
    expect(data.entries[2]).toMatchObject({ status: "skipped" }); // 显式存在，绝不缺省
  });

  it("plan + topology → 400 topology_plan_unsupported（不静默提供半支持）", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.yaml"), VALID_SPEC);
    const manifest = writeManifest("rigs:\n  - source: ./a.yaml\n");
    const { app } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest, plan: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("topology_plan_unsupported");
  });

  it("裸名称条目在解析时被拒绝（架构裁定：仅规范路径）——400，不启动任何内容", async () => {
    const manifest = writeManifest("rigs:\n  - source: some-existing-rig\n");
    const { app, calls } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["code"]).toBe("invalid_topology_manifest");
    expect(String((data["errors"] as string[])[0])).toContain("裸库/工作组名称");
    expect(String((data["errors"] as string[])[0])).toContain("zrig up some-existing-rig");
    expect(calls).toEqual([]); // 从未调用 bootstrap
  });

  it(".rigbundle 条目在解析时被拒绝，并给出直接启动单装备的替代方案——400，不启动任何内容", async () => {
    const manifest = writeManifest("rigs:\n  - source: ./workers.rigbundle\n");
    const { app, calls } = makeApp();
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: manifest }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["code"]).toBe("invalid_topology_manifest");
    expect(String((data["errors"] as string[])[0])).toContain("单工作组命令 'zrig up ./workers.rigbundle' 仍接受所有源类型");
    expect(calls).toEqual([]);
  });
});
