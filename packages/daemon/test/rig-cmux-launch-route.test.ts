// Slice 24 Checkpoint C——POST /api/rigs/:rigId/cmux/launch 路由测试。
//
// 使用 mock 依赖测试路由协调逻辑（rig 查找 → cmux 可用性门禁 → NodeInventory session-name 映射
// → 按 pod 再按 member 排序 → 按 MAX_PER_WORKSPACE 分块 → 解决 workspace 名称冲突
// → 为每个分块执行 buildWorkspace），以保持测试快速且 hermetic。根据权限姿态，完整 cmux daemon
// 端到端测试留给 QA/operator 窗口。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { rigCmuxRoutes } from "../src/routes/rig-cmux.js";
import { CmuxLayoutService } from "../src/domain/cmux-layout-service.js";
import type { CmuxAdapter, CmuxResult, CmuxWorkspace } from "../src/adapters/cmux.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type Database from "better-sqlite3";

interface FakeRigOpts {
  id: string;
  name: string;
  nodes: Array<{
    logicalId: string;
    podId: string | null;
    canonicalSessionName: string | null;
    sessionStatus?: string | null;
    attachmentType?: string | null;
  }>;
}

function makeRigRepoStub(rigs: Record<string, FakeRigOpts>): RigRepository {
  return {
    getRig: (rigId: string) => {
      const rig = rigs[rigId];
      if (!rig) return null;
      return {
        rig: { id: rig.id, name: rig.name } as never,
        nodes: rig.nodes.map((n) => ({
          id: n.logicalId,
          rigId: rig.id,
          logicalId: n.logicalId,
          podId: n.podId,
          binding: null,
        })) as never,
        edges: [],
      };
    },
  } as unknown as RigRepository;
}

function makeNodeInventoryStub(rigs: Record<string, FakeRigOpts>) {
  return (rigId: string) => {
    const rig = rigs[rigId];
    if (!rig) return [];
    // 镜像 getNodeInventory：每个节点生成一个条目（包括 detached/exited 节点，由 sessionStatus 区分）。
    // 默认 sessionStatus = "running" 且 attachmentType = "tmux"，使现有 happy-path 测试保持 green。
    return rig.nodes.map((n) => ({
      logicalId: n.logicalId,
      canonicalSessionName: n.canonicalSessionName,
      sessionStatus: n.sessionStatus ?? (n.canonicalSessionName ? "running" : null),
      attachmentType: n.attachmentType ?? "tmux",
      podId: n.podId,
    })) as never;
  };
}

function makeMockAdapter(opts: {
  available: boolean;
  existingWorkspaces?: string[];
  splitOk?: boolean;
  createOk?: boolean;
  failOn?: "createWorkspace" | "splitSurface" | "sendText" | "listWorkspaces";
  /**
   * 设置后，仅当传入此特定名称时才使 createWorkspace 失败。
   * 用于验证“chunk 0 成功、chunk 1 失败”的 partial-response 判别
   *（slice 24.C 延续事项）。
   */
  failOnWorkspaceName?: string;
}): CmuxAdapter {
  const existing = opts.existingWorkspaces ?? [];
  const adapter = {
    isAvailable: () => opts.available,
    getStatus: () => ({ available: opts.available, capabilities: {} }),
    connect: async () => {},
    listWorkspaces: async (): Promise<CmuxResult<CmuxWorkspace[]>> => {
      if (opts.failOn === "listWorkspaces") {
        return { ok: false, code: "request_failed", message: "list failed" };
      }
      return { ok: true, data: existing.map((name, i) => ({ id: `workspace:${i + 100}`, name })) };
    },
    createWorkspace: async (name: string): Promise<CmuxResult<string>> => {
      if (opts.failOn === "createWorkspace") {
        return { ok: false, code: "request_failed", message: "duplicate name" };
      }
      if (opts.failOnWorkspaceName === name) {
        return { ok: false, code: "request_failed", message: `cmux refused workspace "${name}"` };
      }
      return { ok: true, data: `workspace:new-${name}` };
    },
    listSurfaces: async (): Promise<CmuxResult<unknown[]>> => ({
      ok: true,
      data: [{ id: "surface:default", title: "", type: "terminal" }],
    }),
    splitSurface: async (): Promise<CmuxResult<string>> => {
      if (opts.failOn === "splitSurface") {
        return { ok: false, code: "request_failed", message: "split failed" };
      }
      return { ok: true, data: `surface:${Math.random().toString(36).slice(2, 8)}` };
    },
    sendText: async (): Promise<CmuxResult<void>> => {
      if (opts.failOn === "sendText") {
        return { ok: false, code: "request_failed", message: "send failed" };
      }
      return { ok: true, data: undefined };
    },
    closeWorkspace: async (): Promise<CmuxResult<void>> => ({ ok: true, data: undefined }),
    listPaneSurfaces: async (): Promise<CmuxResult<unknown[]>> => ({ ok: true, data: [] }),
  };
  return adapter as unknown as CmuxAdapter;
}

function makeTmuxAdapterStub(liveSessions?: Set<string>): import("../src/adapters/tmux.js").TmuxAdapter {
  const live = liveSessions ?? new Set<string>();
  return {
    hasSession: async (name: string) => live.has(name),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
    getPaneCommand: async () => null,
    capturePaneContent: async () => null,
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
  } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
}

function buildApp(opts: {
  rigs: Record<string, FakeRigOpts>;
  adapter: CmuxAdapter;
  liveSessions?: Set<string>;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
}): Hono {
  const app = new Hono();
  const rigRepo = makeRigRepoStub(opts.rigs);
  const nodeInventoryFn = makeNodeInventoryStub(opts.rigs);
  // 使用空操作 sleep，避免测试实际等待
  const layoutService = new CmuxLayoutService(opts.adapter, { sleep: async () => {} });
  // OPR.0.3.4.8：默认 live session = 有效 sessionStatus 为 "running" 的 session
  //（镜像 makeNodeInventoryStub 的默认规则：canonicalSessionName 存在且未显式指定非 running
  // sessionStatus，即视为 "running"）。
  const defaultLive = new Set<string>();
  for (const rig of Object.values(opts.rigs)) {
    for (const node of rig.nodes ?? []) {
      if (!node.canonicalSessionName) continue;
      const effectiveStatus = node.sessionStatus ?? "running";
      if (effectiveStatus === "running") {
        defaultLive.add(node.canonicalSessionName);
      }
    }
  }
  const tmuxAdapter = makeTmuxAdapterStub(opts.liveSessions ?? defaultLive);

  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, rigRepo);
    c.set("cmuxAdapter" as never, opts.adapter);
    c.set("cmuxLayoutService" as never, layoutService);
    c.set("nodeInventoryFn" as never, nodeInventoryFn);
    c.set("tmuxAdapter" as never, tmuxAdapter);
    c.set("readinessTimeoutMs" as never, opts.readinessTimeoutMs);
    c.set("readinessPollMs" as never, opts.readinessPollMs);
    c.set("db" as never, {} as Database.Database);
    await next();
  });
  app.route("/api/rigs/:rigId/cmux", rigCmuxRoutes);
  return app;
}

describe("POST /api/rigs/:rigId/cmux/launch", () => {
  it("找不到 rig 时返回 404", async () => {
    const app = buildApp({
      rigs: {},
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/missing/cmux/launch", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rig_not_found");
  });

  it("cmux adapter 不可用时返回 503", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "my-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@my-rig" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: false }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("cmux_unavailable");
    expect(body.message.toLowerCase()).toMatch(/cmux/);
  });

  it("rig 没有运行中的 tmux session 时返回 412", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "my-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: null }, // 未运行
            { logicalId: "b", podId: "p1", canonicalSessionName: null },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      readinessTimeoutMs: 100,
      readinessPollMs: 10,
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rig_not_running");
  });

  it("happy path：3 个运行中的 agent → 1 个以 rig 命名的 workspace", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "my-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@my-rig" },
            { logicalId: "b", podId: "p1", canonicalSessionName: "b@my-rig" },
            { logicalId: "c", podId: "p2", canonicalSessionName: "c@my-rig" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ name: string; agents: string[]; blanks: number }> };
    expect(body.ok).toBe(true);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]!.name).toBe("my-rig");
    expect(body.workspaces[0]!.agents).toEqual(["a@my-rig", "b@my-rig", "c@my-rig"]);
    expect(body.workspaces[0]!.blanks).toBe(1);
  });

  it("13 个 agent → 2 个 workspace（12 + 1）", async () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      logicalId: `a${i + 1}`,
      podId: "p1",
      canonicalSessionName: `a${i + 1}@big-rig`,
    }));
    const app = buildApp({
      rigs: { "rig-1": { id: "rig-1", name: "big-rig", nodes } },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ name: string; agents: string[] }> };
    expect(body.workspaces).toHaveLength(2);
    expect(body.workspaces[0]!.name).toBe("big-rig");
    expect(body.workspaces[0]!.agents).toHaveLength(12);
    expect(body.workspaces[1]!.name).toBe("big-rig-2");
    expect(body.workspaces[1]!.agents).toHaveLength(1);
  });

  it("cmux 中已存在与 rig 同名的 workspace 时自动追加 -2 后缀", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "existing-rig",
          nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@existing-rig" }],
        },
      },
      adapter: makeMockAdapter({
        available: true,
        existingWorkspaces: ["existing-rig"], // 名称冲突
      }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ name: string }> };
    expect(body.workspaces[0]!.name).toBe("existing-rig-2");
  });

  it("多个 workspace 冲突时自动追加连续后缀", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "collide",
          nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@collide" }],
        },
      },
      adapter: makeMockAdapter({
        available: true,
        existingWorkspaces: ["collide", "collide-2", "collide-3"],
      }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ name: string }> };
    expect(body.workspaces[0]!.name).toBe("collide-4");
  });

  it("buildWorkspace 步骤中途失败时返回 500 和部分 workspace 信息", async () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      logicalId: `a${i + 1}`,
      podId: "p1",
      canonicalSessionName: `a${i + 1}@partial-rig`,
    }));
    const app = buildApp({
      rigs: { "rig-1": { id: "rig-1", name: "partial-rig", nodes } },
      adapter: makeMockAdapter({
        available: true,
        failOn: "splitSurface", // splitSurface 在第一个 workspace 失败（12 个 agent 需要 split）
      }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("build_workspace_failed");
    expect(body.message.toLowerCase()).toMatch(/split failed/);
  });

  // velocity-guard 24.C BLOCKING-CONCERN 修复回归：
  // 仅存在 canonicalSessionName 并不充分——session 可能已 detached/exited，
  // 但 node-inventory 中仍记录有名称。路由还必须按 sessionStatus === "running" 过滤。

  it("节点有 canonicalSessionName 但 sessionStatus 为 'exited' 时返回 412 rig_not_running（BLOCKING-FIX）", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "stale-rig",
          nodes: [
            {
              logicalId: "a",
              podId: "p1",
              canonicalSessionName: "a@stale-rig",
              sessionStatus: "exited", // stale：记录了 session 名称，但 session 已退出
            },
            {
              logicalId: "b",
              podId: "p1",
              canonicalSessionName: "b@stale-rig",
              sessionStatus: "detached", // detached：情况相同
            },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rig_not_running");
  });

  it("混合 stale+running：只 attach 运行中的 session（BLOCKING-FIX 判别测试）", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "mixed-rig",
          nodes: [
            {
              logicalId: "a",
              podId: "p1",
              canonicalSessionName: "a@mixed-rig",
              sessionStatus: "running",
            },
            {
              logicalId: "b",
              podId: "p1",
              canonicalSessionName: "b@mixed-rig",
              sessionStatus: "exited", // stale
            },
            {
              logicalId: "c",
              podId: "p2",
              canonicalSessionName: "c@mixed-rig",
              sessionStatus: "running",
            },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }> };
    expect(body.workspaces).toHaveLength(1);
    // 只 attach 两个 RUNNING session；已退出的 b 被过滤。缺少 sessionStatus 过滤时，
    // 此处会包含 "b@mixed-rig"，从而导致断言失败。
    expect(body.workspaces[0]!.agents).toEqual(["a@mixed-rig", "c@mixed-rig"]);
  });

  // velocity-guard 24.C-repair ADVISORY-OK 延续事项：
  // 先前测试无法判别 partial-workspace 声明（failOn:"splitSurface" 在第一个 workspace 失败，
  // 因此这些场景中的 partial[] 始终为空）。本测试证明 partial[] payload 会累积失败前已成功构建的 workspace。

  it("500 partial-workspace 信息判别：chunk 0 成功 + chunk 1 失败 → partial 包含 chunk-0 信息", async () => {
    // 13 个 agent → 2 个 chunk："fanout"（12 个 agent）+ "fanout-2"（1 个 agent）。
    // failOnWorkspaceName="fanout-2" 使第一个 createWorkspace 成功（包括所有 split + send），
    // 随后在 chunk 1 处使第二个 createWorkspace 失败。响应的 `partial[]` 中应包含 chunk 0 构建的 workspace。
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      logicalId: `a${i + 1}`,
      podId: "p1",
      canonicalSessionName: `a${i + 1}@fanout`,
    }));
    const app = buildApp({
      rigs: { "rig-1": { id: "rig-1", name: "fanout", nodes } },
      adapter: makeMockAdapter({
        available: true,
        failOnWorkspaceName: "fanout-2",
      }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: string;
      message: string;
      partial: Array<{ name: string; agents: string[]; blanks: number }>;
    };
    expect(body.error).toBe("build_workspace_failed");
    // 关键断言：partial 包含成功构建的第一个 workspace（"fanout"，含 12 个 agent）。
    // 如果实现未累积 partial，此处将为 undefined 或 []。
    expect(body.partial).toHaveLength(1);
    expect(body.partial[0]!.name).toBe("fanout");
    expect(body.partial[0]!.agents).toHaveLength(12);
    expect(body.partial[0]!.blanks).toBe(0);
    // 失败消息引用第二个 workspace。
    expect(body.message.toLowerCase()).toMatch(/fanout-2/);
  });

  it("即使 sessionStatus 为 running，attachmentType 非 tmux 时也返回 412 rig_not_running（防御性）", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "non-tmux-rig",
          nodes: [
            {
              logicalId: "a",
              podId: "p1",
              canonicalSessionName: "a@non-tmux",
              sessionStatus: "running",
              attachmentType: "ssh", // 非 tmux：无法执行 'tmux attach -t'
            },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
  });

  // OPR.0.3.4.8——cmux launch readiness：tmux-liveness 判别 + 如实 partial。

  it("OPR.0.3.4.8：live detached session（hasSession 为 true）作为 pane 包含在内", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "live-detached-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@live-detached-rig", sessionStatus: "detached" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(["a@live-detached-rig"]),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }>; missing?: Array<{ logicalId: string }> };
    expect(body.workspaces[0]!.agents).toEqual(["a@live-detached-rig"]);
    expect(body.missing).toBeUndefined();
  });

  it("OPR.0.3.4.8：混合 live + stale -> 响应包含带原因的 missing", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "partial-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@partial-rig", sessionStatus: "running" },
            { logicalId: "b", podId: "p1", canonicalSessionName: "b@partial-rig", sessionStatus: "exited" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(["a@partial-rig"]),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ agents: string[] }>; missing: Array<{ logicalId: string; reason: string }> };
    expect(body.ok).toBe(true);
    expect(body.workspaces[0]!.agents).toEqual(["a@partial-rig"]);
    expect(body.missing).toBeDefined();
    expect(body.missing).toHaveLength(1);
    expect(body.missing[0]!.logicalId).toBe("b");
    expect(body.missing[0]!.reason).toBe("session-missing");
  });

  it("OPR.0.3.4.8：stale dead session（hasSession 为 false）不 attach，并列为 missing", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "dead-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@dead-rig", sessionStatus: "exited" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: string; missing: Array<{ logicalId: string; reason: string }> };
    expect(body.error).toBe("rig_not_running");
    expect(body.missing).toBeDefined();
    expect(body.missing.some((m) => m.logicalId === "a")).toBe(true);
  });

  it("OPR.0.3.4.8：fully-ready rig 打开所有席位，且无 missing", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "full-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@full-rig" },
            { logicalId: "b", podId: "p1", canonicalSessionName: "b@full-rig" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ agents: string[] }>; missing?: unknown };
    expect(body.ok).toBe(true);
    expect(body.workspaces[0]!.agents).toEqual(["a@full-rig", "b@full-rig"]);
    expect(body.missing).toBeUndefined();
  });

  it("OPR.0.3.4.8：没有代码按 sessionStatus === attention_required 分支", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "attn-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@attn-rig", sessionStatus: "running" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(["a@attn-rig"]),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }> };
    expect(body.workspaces[0]!.agents).toContain("a@attn-rig");
  });

  it("OPR.0.3.4.8：候选 hasSession 在超时前依次为 false、false、true -> 包含在内", async () => {
    let callCount = 0;
    const dynamicTmux = {
      ...makeTmuxAdapterStub(new Set()),
      hasSession: async (name: string) => {
        callCount++;
        return callCount >= 3;
      },
    } as unknown as import("../src/adapters/tmux.js").TmuxAdapter;
    const app = new Hono();
    const rigs = {
      "rig-1": {
        id: "rig-1",
        name: "late-live-rig",
        nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: "a@late-live-rig", sessionStatus: "running" as string | undefined }],
      },
    };
    const rigRepo = makeRigRepoStub(rigs);
    const nodeInventoryFn = makeNodeInventoryStub(rigs);
    const layoutService = new CmuxLayoutService(makeMockAdapter({ available: true }), { sleep: async () => {} });
    app.use("*", async (c, next) => {
      c.set("rigRepo" as never, rigRepo);
      c.set("cmuxAdapter" as never, makeMockAdapter({ available: true }));
      c.set("cmuxLayoutService" as never, layoutService);
      c.set("nodeInventoryFn" as never, nodeInventoryFn);
      c.set("tmuxAdapter" as never, dynamicTmux);
      c.set("readinessTimeoutMs" as never, 500);
      c.set("readinessPollMs" as never, 10);
      c.set("db" as never, {} as Database.Database);
      await next();
    });
    app.route("/api/rigs/:rigId/cmux", rigCmuxRoutes);

    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ agents: string[] }>; missing?: unknown };
    expect(body.ok).toBe(true);
    expect(body.workspaces[0]!.agents).toContain("a@late-live-rig");
    expect(body.missing).toBeUndefined();
  });

  it("OPR.0.3.4.8：首次 snapshot 无 session -> 超时前发现 canonical/live -> 包含在内（多次重新读取 null）", async () => {
    let inventoryCallCount = 0;
    const dynamicInventoryFn = () => {
      inventoryCallCount++;
      if (inventoryCallCount <= 3) {
        return [{ logicalId: "a", canonicalSessionName: null, sessionStatus: null, attachmentType: "tmux", podId: "p1" }] as never;
      }
      return [{ logicalId: "a", canonicalSessionName: "a@late-start-rig", sessionStatus: "running", attachmentType: "tmux", podId: "p1" }] as never;
    };
    const app = new Hono();
    const rigs = {
      "rig-1": {
        id: "rig-1",
        name: "late-start-rig",
        nodes: [{ logicalId: "a", podId: "p1", canonicalSessionName: null as string | null }],
      },
    };
    const rigRepo = makeRigRepoStub(rigs);
    const layoutService = new CmuxLayoutService(makeMockAdapter({ available: true }), { sleep: async () => {} });
    const tmux = makeTmuxAdapterStub(new Set(["a@late-start-rig"]));
    app.use("*", async (c, next) => {
      c.set("rigRepo" as never, rigRepo);
      c.set("cmuxAdapter" as never, makeMockAdapter({ available: true }));
      c.set("cmuxLayoutService" as never, layoutService);
      c.set("nodeInventoryFn" as never, dynamicInventoryFn);
      c.set("tmuxAdapter" as never, tmux);
      c.set("readinessTimeoutMs" as never, 500);
      c.set("readinessPollMs" as never, 10);
      c.set("db" as never, {} as Database.Database);
      await next();
    });
    app.route("/api/rigs/:rigId/cmux", rigCmuxRoutes);

    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: Array<{ agents: string[] }>; missing?: unknown };
    expect(body.ok).toBe(true);
    expect(body.workspaces[0]!.agents).toContain("a@late-start-rig");
    expect(body.missing).toBeUndefined();
  });

  it("OPR.0.3.4.8：stale/exited session 保持 session-missing（即使轮询后也绝不 attach）", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "stale-poll-rig",
          nodes: [
            { logicalId: "a", podId: "p1", canonicalSessionName: "a@stale-poll-rig", sessionStatus: "exited" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
      liveSessions: new Set(),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    expect(res.status).toBe(412);
    const body = (await res.json()) as { missing: Array<{ logicalId: string; reason: string }> };
    expect(body.missing[0]!.reason).toBe("session-missing");
  });

  it("agents 数组保留 rig.nodes 顺序（DB 按 created_at 排序 = 先 pod 后 member）", async () => {
    const app = buildApp({
      rigs: {
        "rig-1": {
          id: "rig-1",
          name: "ordered",
          nodes: [
            // 顺序：pod1.lead、pod1.peer、pod2.impl、pod2.qa（created_at 顺序 = spec 顺序）
            { logicalId: "pod1.lead", podId: "p1", canonicalSessionName: "pod1.lead@ordered" },
            { logicalId: "pod1.peer", podId: "p1", canonicalSessionName: "pod1.peer@ordered" },
            { logicalId: "pod2.impl", podId: "p2", canonicalSessionName: "pod2.impl@ordered" },
            { logicalId: "pod2.qa", podId: "p2", canonicalSessionName: "pod2.qa@ordered" },
          ],
        },
      },
      adapter: makeMockAdapter({ available: true }),
    });
    const res = await app.request("/api/rigs/rig-1/cmux/launch", { method: "POST" });
    const body = (await res.json()) as { workspaces: Array<{ agents: string[] }> };
    expect(body.workspaces[0]!.agents).toEqual([
      "pod1.lead@ordered",
      "pod1.peer@ordered",
      "pod2.impl@ordered",
      "pod2.qa@ordered",
    ]);
  });
});
