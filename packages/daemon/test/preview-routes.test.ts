// Preview Terminal v0（PL-018）——preview 路由测试。
//
// 固定关键行为：
//   - GET /api/rigs/:rigId/nodes/:logicalId/preview 返回 content + lines + capturedAt；
//   - rate limiter 缓存窗口内的后续请求；
//   - SessionTransport 不可用时返回 503；
//   - rig/node 缺失时返回 404；
//   - session 未绑定时返回 409；
//   - GET /api/sessions/:sessionName/preview alias 可用；
//   - lines query param 会限制范围并提供默认值。

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { sessionsRoutes, nodesRoutes, sessionAdminRoutes } from "../src/routes/sessions.js";
import { PreviewRateLimiter } from "../src/domain/preview/preview-rate-limiter.js";

interface FakeNode {
  logicalId: string;
  id: string;
  binding: { tmuxSession: string | null } | null;
}

interface FakeRigRepo {
  getRig: (id: string) => { nodes: FakeNode[] } | null;
}

interface FakeCaptureResult {
  ok: boolean;
  sessionName: string;
  content?: string;
  lines?: number;
  reason?: string;
  error?: string;
}

class FakeSessionTransport {
  public calls: Array<{ sessionName: string; lines?: number }> = [];
  public response: FakeCaptureResult = { ok: true, sessionName: "x", content: "captured\nline2", lines: 50 };

  async capture(sessionName: string, opts?: { lines?: number }): Promise<FakeCaptureResult> {
    this.calls.push({ sessionName, lines: opts?.lines });
    return { ...this.response, sessionName };
  }
}

function buildApp(opts: {
  rigRepo: FakeRigRepo;
  sessionTransport: FakeSessionTransport | null;
  rateLimiter?: PreviewRateLimiter<unknown> | null;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, opts.rigRepo);
    c.set("sessionTransport" as never, opts.sessionTransport);
    if (opts.rateLimiter !== null) c.set("previewRateLimiter" as never, opts.rateLimiter ?? new PreviewRateLimiter(1000));
    await next();
  });
  app.route("/api/rigs/:rigId/nodes", nodesRoutes);
  app.route("/api/sessions", sessionAdminRoutes);
  return app;
}

describe("GET /api/rigs/:rigId/nodes/:logicalId/preview (PL-018)", () => {
  let transport: FakeSessionTransport;
  let rigRepo: FakeRigRepo;

  beforeEach(() => {
    transport = new FakeSessionTransport();
    rigRepo = {
      getRig: (id: string) =>
        id === "r-1"
          ? {
              nodes: [
                { logicalId: "driver", id: "node-1", binding: { tmuxSession: "velocity-driver@openrig-velocity" } },
                { logicalId: "guard", id: "node-2", binding: { tmuxSession: null } },
              ],
            }
          : null,
    };
  });

  it("返回 content + lines + capturedAt", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string; lines: number; sessionName: string; capturedAt: string };
    expect(body.content).toBe("captured\nline2");
    expect(body.lines).toBe(50);
    expect(body.sessionName).toBe("velocity-driver@openrig-velocity");
    expect(body.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rate limiter 缓存窗口内的后续请求", async () => {
    const limiter = new PreviewRateLimiter<unknown>(60_000);
    const app = buildApp({ rigRepo, sessionTransport: transport, rateLimiter: limiter });
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    expect(transport.calls.length).toBe(1);
  });

  it("不同 lines query 值使用不同 cache key", async () => {
    const limiter = new PreviewRateLimiter<unknown>(60_000);
    const app = buildApp({ rigRepo, sessionTransport: transport, rateLimiter: limiter });
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=50");
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=200");
    expect(transport.calls.length).toBe(2);
    expect(transport.calls[0].lines).toBe(50);
    expect(transport.calls[1].lines).toBe(200);
  });

  it("把 lines 限制在合理上限 1000", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    await app.request("/api/rigs/r-1/nodes/driver/preview?lines=99999");
    expect(transport.calls[0].lines).toBe(1000);
  });

  it("lines 缺失或不是数字时默认为 50", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    await app.request("/api/rigs/r-1/nodes/driver/preview");
    expect(transport.calls[0].lines).toBe(50);
    transport.calls.length = 0;

    // 使用全新 limiter，避免第二个请求从 cache 返回。
    const app2 = buildApp({ rigRepo, sessionTransport: transport });
    await app2.request("/api/rigs/r-1/nodes/driver/preview?lines=banana");
    expect(transport.calls[0].lines).toBe(50);
  });

  it("SessionTransport 不可用时返回 503", async () => {
    const app = buildApp({ rigRepo, sessionTransport: null });
    const res = await app.request("/api/rigs/r-1/nodes/driver/preview");
    expect(res.status).toBe(503);
  });

  it("工作组缺失时返回 404", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/missing/nodes/driver/preview");
    expect(res.status).toBe(404);
  });

  it("节点缺失时返回 404", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/r-1/nodes/nonexistent/preview");
    expect(res.status).toBe(404);
  });

  it("节点没有绑定 tmux session 时返回 409", async () => {
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/r-1/nodes/guard/preview");
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("session_unbound");
  });

  it("capture 失败时以 502 呈现结构化 reason + hint", async () => {
    transport.response = { ok: false, sessionName: "x", reason: "session_missing", error: "Session not found" };
    const app = buildApp({ rigRepo, sessionTransport: transport });
    const res = await app.request("/api/rigs/r-1/nodes/driver/preview");
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string; hint: string };
    expect(body.error).toBe("session_missing");
    expect(body.hint).toContain("Session not found");
  });
});

describe("GET /api/sessions/:sessionName/preview (PL-018 alias)", () => {
  let transport: FakeSessionTransport;

  beforeEach(() => {
    transport = new FakeSessionTransport();
  });

  it("以 session 为 key 的 alias 返回相同 payload 结构", async () => {
    const app = buildApp({ rigRepo: { getRig: () => null }, sessionTransport: transport });
    const res = await app.request("/api/sessions/velocity-driver%40openrig-velocity/preview?lines=10");
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string; sessionName: string; lines: number };
    expect(body.sessionName).toBe("velocity-driver@openrig-velocity");
    expect(transport.calls[0].sessionName).toBe("velocity-driver@openrig-velocity");
  });

  it("alias 上 SessionTransport 不可用时同样返回 503", async () => {
    const app = buildApp({ rigRepo: { getRig: () => null }, sessionTransport: null });
    const res = await app.request("/api/sessions/x/preview");
    expect(res.status).toBe(503);
  });
});
