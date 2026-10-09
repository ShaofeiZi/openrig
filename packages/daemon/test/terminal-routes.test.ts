// OPR.0.4.6.02 C3——terminal 路由：canonical composer + rig-scoped 轻量 alias。
// 固定 route wiring + status mapping + 唯一共享 body contract：
//  - POST /api/terminal/open → 逐字返回 TerminalService result body；
//  - status mapping：ok → 200 · unknown_provider/view_required → 400 ·
//    view_not_found → 404 · provider-unavailable（honest-partial）→ 200；
//  - GET /views + GET /status 委托；
//  - service 缺失 → 503（绝不崩溃）；
//  - rig-scoped alias 组合 view = rig:<rigId> 并委托（arch R1）。

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { terminalRoutes, rigTerminalRoutes } from "../src/routes/terminal.js";
import type { OpenViewResult } from "../src/domain/terminal/terminal-provider.js";

type OpenReq = { provider?: string; view: string };

function okResult(view: string): OpenViewResult {
  return { provider: "herdr", ok: true, opened: [`${view}-seat`], absent: [], degraded: [], pages: 1 };
}

/** 使用记录 openView request 的 fake terminalService 构建 app。 */
function makeApp(opts: {
  service?: unknown;
  openImpl?: (req: OpenReq) => OpenViewResult;
} = {}) {
  const openCalls: OpenReq[] = [];
  const service =
    "service" in opts
      ? opts.service
      : {
          openView: async (req: OpenReq) => {
            openCalls.push(req);
            return (opts.openImpl ?? okResult)(req.view);
          },
          listViews: async () => ({ saved: [{ id: "watchtower", name: "Watchtower", members: [] }], rigs: ["acme-build"] }),
          status: async (p?: string) => ({ providers: [{ name: p ?? "herdr", status: { provider: p ?? "herdr", available: true, capabilities: {} }, liveness: { alive: true } }] }),
        };
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c.set.bind(c) as (k: string, v: unknown) => void)("terminalService", service);
    await next();
  });
  app.route("/api/terminal", terminalRoutes());
  app.route("/api/rigs/:rigId/terminal", rigTerminalRoutes);
  return { app, openCalls };
}

function post(app: Hono, path: string, body?: unknown) {
  return app.request(path, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/terminal/open", () => {
  it("成功时以 200 返回 TerminalService result body", async () => {
    const { app, openCalls } = makeApp();
    const res = await post(app, "/api/terminal/open", { view: "acme-build", provider: "herdr" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ provider: "herdr", ok: true, opened: ["acme-build-seat"] });
    expect(openCalls[0]).toEqual({ view: "acme-build", provider: "herdr" });
  });

  it("将 unknown_provider 映射为 400", async () => {
    const { app } = makeApp({
      openImpl: () => ({ provider: "tmate", ok: false, opened: [], absent: [], degraded: [], pages: 0, code: "unknown_provider", error: "x" }),
    });
    const res = await post(app, "/api/terminal/open", { view: "acme-build", provider: "tmate" });
    expect(res.status).toBe(400);
  });

  it("将 view_not_found 映射为 404", async () => {
    const { app } = makeApp({
      openImpl: () => ({ provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0, code: "view_not_found", error: "x" }),
    });
    const res = await post(app, "/api/terminal/open", { view: "nope" });
    expect(res.status).toBe(404);
  });

  it("provider-unavailable / honest-partial 结果是如实的 200 body", async () => {
    const { app } = makeApp({
      openImpl: () => ({ provider: "herdr", ok: false, opened: [], absent: [], degraded: [], pages: 0, code: "herdr_unavailable", error: "no binary" }),
    });
    const res = await post(app, "/api/terminal/open", { view: "acme-build" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, code: "herdr_unavailable" });
  });

  it("非 JSON body → 400 body_invalid", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/terminal/open", { method: "POST", body: "not json", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "body_invalid" });
  });

  it("service 缺失 → 503（绝不崩溃）", async () => {
    const { app } = makeApp({ service: undefined });
    const res = await post(app, "/api/terminal/open", { view: "acme-build" });
    expect(res.status).toBe(503);
  });
});

describe("GET /api/terminal/views + /status", () => {
  it("委托 views", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/terminal/views");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rigs: ["acme-build"] });
  });

  it("status 透传 provider query", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/terminal/status?provider=cmux");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ providers: [{ name: "cmux" }] });
  });
});

describe("POST /api/rigs/:rigId/terminal/open——轻量 alias", () => {
  it("组合 view = rig:<rigId> 并委托给同一 service", async () => {
    const { app, openCalls } = makeApp();
    const res = await post(app, "/api/rigs/rig-id-1/terminal/open", {});
    expect(res.status).toBe(200);
    expect(openCalls[0]?.view).toBe("rig:rig-id-1");
  });

  it("从 body 携带 provider，同时仍组合工作组 view", async () => {
    const { app, openCalls } = makeApp();
    await post(app, "/api/rigs/rig-id-1/terminal/open", { provider: "cmux" });
    expect(openCalls[0]).toEqual({ view: "rig:rig-id-1", provider: "cmux" });
  });
});
