// OPR.0.4.4.15 FR-4——POST /api/mission-control/action 上的远端 action 转发。
//
// 关键固定点：hostId 缺失/local 时逐字节走现有路径并调用 write contract；remote 时由服务端
// 转发，逐字传递 origin 的结构化响应，包括成功与失败，防止 fake-success；转发路径绝不写本地
// write contract（架构裁定 4，随 R15-3 增补：origin audit row 是唯一记录）；只由单一 verb
// allowlist gate。

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "B" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};

function makeApp(opts: { fetchImpl?: typeof fetch } = {}) {
  const localActs: unknown[] = [];
  const writeContract = {
    act: async (req: unknown) => {
      localActs.push(req);
      return { ok: true, actionId: "local-act-1" };
    },
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("missionControlWriteContract", writeContract);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    if (opts.fetchImpl) set("remoteFetchImpl", opts.fetchImpl);
    set("eventBus", { emit: () => {} });
    await next();
  });
  app.route("/api/mission-control", missionControlRoutes({ bearerToken: null }));
  return { app, localActs };
}

const BASE_BODY = { verb: "resolve", qitemId: "qitem-1", actorSession: "human@host" };

function post(app: Hono, body: Record<string, unknown>) {
  // P21：调用方 transport identity 是 X-OpenRig-Session header，由 DaemonClient 从席位 env
  // 盖章。这里从 body.actorSession 镜像，使 fixture 呈现合法调用方（header == claim，可接受）；
  // 转发随后重新盖章并丢弃 body claim。
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof body.actorSession === "string") headers["X-OpenRig-Session"] = body.actorSession;
  return app.request("/api/mission-control/action", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// 转发分支使用的 Bearer env。
process.env["B"] = "remote-token";

describe("POST /action——FR-4 远端转发", () => {
  it("hostId 缺失：逐字节运行现有本地写路径", async () => {
    const { app, localActs } = makeApp();
    const res = await post(app, BASE_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actionId: "local-act-1" });
    expect(localActs).toHaveLength(1);
  });

  it("hostId 为 'local'：使用同一本地路径，该契约 literal 不表示远端", async () => {
    const { app, localActs } = makeApp();
    const res = await post(app, { ...BASE_BODY, hostId: "local" });
    expect(res.status).toBe(200);
    expect(localActs).toHaveLength(1);
  });

  it("远端 hostId：携带 bearer 转发除 hostId 外完全相同的 body；逐字传递 origin 成功响应，不触碰本地 write contract", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const { app, localActs } = makeApp({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capture.url = String(url);
        capture.init = init;
        return new Response(JSON.stringify({ ok: true, actionId: "origin-act-9", audited: "on-origin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    const res = await post(app, { ...BASE_BODY, hostId: "vps-b", annotation: "from the merged feed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actionId: "origin-act-9", audited: "on-origin" });
    expect(capture.url).toBe("http://vps-b:7433/api/mission-control/action");
    const fwdHeaders = capture.init?.headers as Record<string, string>;
    expect(fwdHeaders["Authorization"]).toBe("Bearer remote-token");
    // P21 I2 跨主机重新盖章：转发携带本后台服务派生的 actor + relay marker，并丢弃 inbound
    // body actorSession claim；origin 从重新盖章内容派生 actor。
    expect(fwdHeaders["X-OpenRig-Session"]).toBe("human@host"); // re-stamped from the derived actor
    expect(fwdHeaders["X-OpenRig-Relay"]).toBeTruthy(); // relay provenance marked
    // P21 review-actions 延后：转发携带已解析 provenance，使 origin 无法洗白。CLI 派生、存在
    // header 的 actor 以 transport:v1 传递，origin 再转为 relay:v1。
    expect(fwdHeaders["X-OpenRig-Provenance"]).toBe("transport:v1");
    const forwarded = JSON.parse(String(capture.init?.body)) as Record<string, unknown>;
    expect(forwarded).toEqual({ verb: "resolve", qitemId: "qitem-1", annotation: "from the merged feed" }); // hostId AND actorSession stripped
    expect(forwarded).not.toHaveProperty("actorSession"); // the inbound claim never rides the wire
    expect(localActs).toEqual([]); // arch pin: local mission_control_actions CLEAN after forward
  });

  it("P21 转发保留 claimed-era：转发无 header 的浏览器 UI action 时携带 claimed actor + X-OpenRig-Provenance=claimed:v1，绝不升级为 transport:v1", async () => {
    const capture: { init?: RequestInit } = {};
    const { app, localActs } = makeApp({
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        capture.init = init;
        return new Response(JSON.stringify({ ok: true, actionId: "origin-act-ui" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    // 浏览器 UI：没有 X-OpenRig-Session header，只有 bearer；body 带 actorSession，目标为远端 item。
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verb: "resolve", qitemId: "qitem-1", actorSession: "founder@host", hostId: "vps-b" }),
    });
    expect(res.status).toBe(200);
    const fwdHeaders = capture.init?.headers as Record<string, string>;
    expect(fwdHeaders["X-OpenRig-Session"]).toBe("founder@host"); // the claimed actor rides the header
    expect(fwdHeaders["X-OpenRig-Provenance"]).toBe("claimed:v1"); // PRESERVED — the origin cannot launder it to verified
    expect(JSON.parse(String(capture.init?.body))).not.toHaveProperty("actorSession"); // body claim still stripped
    expect(localActs).toEqual([]);
  });

  it("origin REFUSAL 作为结构化失败透传，不伪造成功，也不触碰本地 contract", async () => {
    const { app, localActs } = makeApp({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "qitem qitem-1 not found on this host" }), { status: 404, headers: { "Content-Type": "application/json" } })) as typeof fetch,
    });
    const res = await post(app, { ...BASE_BODY, hostId: "vps-b" });
    expect(res.status).toBe(502);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toMatchObject({ error: "remote_action_failed", hostId: "vps-b", failureClass: "remote-error", remoteStatus: 404 });
    expect(String(data["detail"])).toContain("not found on this host");
    expect(localActs).toEqual([]);
  });

  it("action 时 origin 不可达：返回结构化逐主机错误，绝不乐观，也不会因 body deadline 卡住", async () => {
    const { app, localActs } = makeApp({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const res = await post(app, { ...BASE_BODY, hostId: "vps-b" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "remote_action_failed", failureClass: "unreachable", detail: "ECONNREFUSED" });
    expect(localActs).toEqual([]);
  });

  it("SSH 声明和未知主机在任何 wire 尝试前结构化失败", async () => {
    let wireTouched = false;
    const { app } = makeApp({
      fetchImpl: (async () => {
        wireTouched = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const ssh = await post(app, { ...BASE_BODY, hostId: "ssh-1" });
    expect(ssh.status).toBe(502);
    expect(await ssh.json()).toMatchObject({ failureClass: "unsupported-transport" });
    const ghost = await post(app, { ...BASE_BODY, hostId: "ghost" });
    expect(await ghost.json()).toMatchObject({ failureClass: "unknown-host" });
    expect(wireTouched).toBe(false);
  });

  it("verb allowlist 在任何转发前 gate，只使用一份 allowlist，不重复校验", async () => {
    let wireTouched = false;
    const { app } = makeApp({
      fetchImpl: (async () => {
        wireTouched = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const res = await post(app, { verb: "reboot-host", qitemId: "q", actorSession: "a", hostId: "vps-b" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "verb_unknown" });
    expect(wireTouched).toBe(false);
  });
});
