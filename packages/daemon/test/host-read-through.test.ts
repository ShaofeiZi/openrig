// OPR.0.4.6.MH2 FR-2 + FR-7——单 host 读透传边界。
//
// 锁定此接缝上的三项架构裁定：P1 具名封闭 allowlist + 两类拒绝均为结构化且绝不转发；
// P2 完整剥离 + 拨号前校验 registry；P3 原样透传 = status + content-type + body（origin 自身的
// 404 就是答案）。另含 FR-2 零回归负向控制：缺失/local host 参数会到达现有 handler，且不尝试转发。

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  READ_THROUGH_ALLOWLIST,
  READ_THROUGH_TIMEOUT_MS,
  hostReadThrough,
  isReadThroughPath,
} from "../src/domain/hosts/read-through.js";
import { remoteRawRequest } from "../src/domain/hosts/remote-daemon-http.js";
import type { HostRegistry, HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "VPS_A_TOKEN" },
    { id: "vm-ssh", transport: "ssh", target: "vm.local" },
  ],
};

interface FetchCall {
  url: string;
  method: string;
  authorization: string | null;
}

function makeApp(opts: { fetchResponse?: () => Response; env?: Record<string, string> } = {}) {
  const fetchCalls: FetchCall[] = [];
  const localHits: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
    });
    return opts.fetchResponse
      ? opts.fetchResponse()
      : new Response(JSON.stringify({ rigs: ["remote-rig"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
  }) as typeof fetch;

  // bearer 在 transport 内从 process.env 解析；会实际拨号的测试自行设置环境变量（并在之后恢复）。
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    set("remoteFetchImpl", fakeFetch);
    await next();
  });
  app.use("/api/*", hostReadThrough());
  app.get("/api/rigs/summary", (c) => {
    localHits.push(c.req.path);
    return c.json({ rigs: ["local-rig"] });
  });
  app.get("/api/slices", (c) => {
    localHits.push(`${c.req.path}?${new URL(c.req.url).searchParams.toString()}`);
    return c.json({ slices: [] });
  });
  app.post("/api/slices/refresh", (c) => {
    localHits.push(c.req.path);
    return c.json({ refreshed: true });
  });
  app.get("/api/config", (c) => {
    localHits.push(c.req.path);
    return c.json({ config: true });
  });
  return { app, fetchCalls, localHits };
}

function withBearerEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env["VPS_A_TOKEN"] = "test-token";
  return fn().finally(() => {
    delete process.env["VPS_A_TOKEN"];
  });
}

describe("READ_THROUGH_ALLOWLIST matcher（架构 P1——具名封闭集合）", () => {
  it("匹配 allowlist 中的每个 screen read", () => {
    const positives = [
      "/api/rigs/summary",
      "/api/rigs/factory-fleet/graph",
      "/api/rigs/factory-fleet/nodes",
      "/api/rigs/factory-fleet/nodes/orch-lead", // rev1-r2 B2 + 架构方案 A：seat-detail leaf。
      "/api/ps",
      "/api/slices",
      "/api/slices/mh2-view-remote-workspace",
      "/api/slices/mh2-view-remote-workspace/doc/PLAN.md",
      "/api/slices/mh2-view-remote-workspace/doc/proof/nested.md",
      "/api/missions/release-0.4.6",
      "/api/specs/library",
      "/api/specs/library/rig-spec-1/review",
    ];
    for (const p of positives) expect(isReadThroughPath(p), p).toBe(true);
  });

  it("拒绝有意排除项及其他所有路径", () => {
    const negatives = [
      "/api/queue/qitem-123", // queue = MH-3 通道。
      "/api/files/roots", // 本地 FS 发现。
      "/api/slices/x/proof-asset/img.png", // binary——只允许文本 transport。
      "/api/specs/library/active-lens/review/extra", // 形状不匹配。
      "/api/config",
      "/api/hosts",
      "/api/mission-control/action",
      "/api/rigs", // 目前裸 collection 不是 screen read。
      "/api/rigs/x/graph/extra",
      // 首个参数化 seat-detail entry 上的架构约束：仅允许严格 segment 形状——同一前缀下更深层的
      // action 路由保持拒绝（正是 rev1-r2 B1 的本地 action endpoint）。
      "/api/rigs/x/nodes/y/focus",
      "/api/rigs/x/nodes/y/open-cmux",
      "/api/rigs/x/nodes/y/anything/deeper",
    ];
    for (const p of negatives) expect(isReadThroughPath(p), p).toBe(false);
  });

  it("锁定细节：GET /api/slices/refresh 匹配 :name——按构造无害", () => {
    // ":name" 会吸收字面量 "refresh"，因此此处 GET 确实进入 allowlist。无法借此执行 mutation：
    // refresh 写入只支持 POST，而带远端 envelope 的每个非 GET 请求都会被 method 约束拒绝（上方已在
    // 同一路径证明）；origin 将转发的 GET 解析为查询名称恰为 "refresh" 的 slice detail → 自身 404，
    // 并被原样透传。
    expect(isReadThroughPath("/api/slices/refresh")).toBe(true);
  });

  it("常量本身就是封闭集合（新增项必须是有意扩展）", () => {
    expect([...READ_THROUGH_ALLOWLIST]).toEqual([
      "/api/rigs/summary",
      "/api/rigs/:rigId/graph",
      "/api/rigs/:rigId/nodes",
      "/api/rigs/:rigId/nodes/:logicalId", // rev1-r2 B2，架构裁定方案 A。
      "/api/ps",
      "/api/slices",
      "/api/slices/:name",
      "/api/slices/:name/doc/*",
      "/api/missions/:missionId",
      "/api/specs/library",
      "/api/specs/library/:id/review",
    ]);
  });
});

describe("hostReadThrough——本地路径不变（FR-2 零回归）", () => {
  it("缺少 host 参数时落入现有 handler；不转发", async () => {
    const { app, fetchCalls, localHits } = makeApp();
    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rigs: ["local-rig"] });
    expect(localHits).toEqual(["/api/rigs/summary"]);
    expect(fetchCalls).toEqual([]);
  });

  it("host=local 时以相同行为落入现有 handler；不转发", async () => {
    const { app, fetchCalls, localHits } = makeApp();
    const res = await app.request("/api/rigs/summary?host=local");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rigs: ["local-rig"] });
    expect(localHits).toEqual(["/api/rigs/summary"]);
    expect(fetchCalls).toEqual([]);
  });
});

describe("hostReadThrough——FR-7 边界约束（拒绝，绝不转发）", () => {
  it("带远端 envelope 的非 GET 请求 → 结构化 MH-3 拒绝、零转发、本地 handler 不受影响", async () => {
    const { app, fetchCalls, localHits } = makeApp();
    const res = await app.request("/api/slices/refresh?host=vps-a", { method: "POST" });
    expect(res.status).toBe(405);
    expect(await res.json()).toMatchObject({
      error: "cross_host_write_refused",
      boundary: "MH-3",
      hostId: "vps-a",
      method: "POST",
    });
    expect(fetchCalls).toEqual([]);
    expect(localHits).toEqual([]);
  });

  it("即使位于 allowlist 的 READ 路径上，非 GET 拒绝仍会触发", async () => {
    const { app, fetchCalls } = makeApp();
    const res = await app.request("/api/rigs/summary?host=vps-a", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(await res.json()).toMatchObject({ error: "cross_host_write_refused", boundary: "MH-3" });
    expect(fetchCalls).toEqual([]);
  });

  it("allowlist 外且带远端 envelope 的 GET → 结构化 MH-3 拒绝、零转发", async () => {
    const { app, fetchCalls, localHits } = makeApp();
    const res = await app.request("/api/config?host=vps-a");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "read_through_path_not_allowed",
      boundary: "MH-3",
      hostId: "vps-a",
      path: "/api/config",
    });
    expect(fetchCalls).toEqual([]);
    expect(localHits).toEqual([]);
  });
});

describe("hostReadThrough——任何拨号前先校验 registry（架构 P2）", () => {
  it("未知 host id → 结构化 unknown-host 错误、零转发", async () => {
    const { app, fetchCalls } = makeApp();
    const res = await app.request("/api/rigs/summary?host=nope");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "remote_read_failed", hostId: "nope", failureClass: "unknown-host" });
    expect(fetchCalls).toEqual([]);
  });

  it("ssh transport host → 结构化 unsupported-transport、零转发", async () => {
    const { app, fetchCalls } = makeApp();
    const res = await app.request("/api/rigs/summary?host=vm-ssh");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "remote_read_failed", hostId: "vm-ssh", failureClass: "unsupported-transport" });
    expect(fetchCalls).toEqual([]);
  });
});

describe("hostReadThrough——转发机制（架构 P2 完整剥离 + P3 原样透传）", () => {
  it("正常路径：转发相同 path、移除 host 参数、保留其他参数、bearer 位于服务端、origin body 原样返回", () =>
    withBearerEnv(async () => {
      const { app, fetchCalls, localHits } = makeApp();
      const res = await app.request("/api/slices?filter=current&refresh=1&host=vps-a");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rigs: ["remote-rig"] });
      expect(localHits).toEqual([]); // 本地 handler 从未运行。
      expect(fetchCalls).toHaveLength(1);
      const call = fetchCalls[0]!;
      // 完整剥离：任何形式的 host 参数都不保留；query 其余部分继续透传。
      expect(call.url).toBe("http://vps-a:7433/api/slices?filter=current&refresh=1");
      expect(call.url).not.toContain("host");
      expect(call.method).toBe("GET");
      expect(call.authorization).toBe("Bearer test-token");
    }));

  it("origin 404 原样透传——status、content-type、body；绝不重新包装", () =>
    withBearerEnv(async () => {
      const originBody = JSON.stringify({ error: "mission_not_found", missionId: "nope" });
      const { app } = makeApp({
        fetchResponse: () => new Response(originBody, { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }),
      });
      const res = await app.request("/api/missions/nope?host=vps-a");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await res.text()).toBe(originBody); // 字节级原样，不重塑。
    }));

  it("缺少 bearer env → 结构化 auth-failed（edge taxonomy 只用于转发失败）", async () => {
    // 有意不设置 VPS_A_TOKEN。
    const { app, fetchCalls } = makeApp();
    const res = await app.request("/api/rigs/summary?host=vps-a");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "remote_read_failed", hostId: "vps-a", failureClass: "auth-failed" });
    expect(fetchCalls).toEqual([]); // bearer 解析先于拨号。
  });

  it("网络失败 → 结构化 unreachable", () =>
    withBearerEnv(async () => {
      const { app } = makeApp({
        fetchResponse: () => {
          throw new TypeError("fetch failed: ECONNREFUSED");
        },
      });
      const res = await app.request("/api/rigs/summary?host=vps-a");
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "remote_read_failed", failureClass: "unreachable" });
    }));
});

describe("remoteRawRequest——transport 环节自身的纪律", () => {
  const HOST: HttpHostEntry = { id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "RAW_TOKEN" };

  it("deadline 必须存在且启用：挂起的 origin 产生结构化 timeout，绝不永久挂起", async () => {
    const hangingFetch = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as typeof fetch;
    const res = await remoteRawRequest(HOST, "/api/ps", {
      timeoutMs: 25,
      fetchImpl: hangingFetch,
      env: { RAW_TOKEN: "tok" },
    });
    expect(res).toMatchObject({ ok: false, kind: "timeout", phase: "request" });
  });

  it("非 2xx origin status 是 ok:true 透传结果（P3），包含 content-type 与 body text", async () => {
    const fakeFetch = (async () =>
      new Response("<h1>origin 500</h1>", { status: 500, headers: { "Content-Type": "text/html" } })) as typeof fetch;
    const res = await remoteRawRequest(HOST, "/api/ps", { timeoutMs: 1000, fetchImpl: fakeFetch, env: { RAW_TOKEN: "tok" } });
    expect(res).toEqual({ ok: true, status: 500, contentType: "text/html", bodyText: "<h1>origin 500</h1>" });
  });
});
