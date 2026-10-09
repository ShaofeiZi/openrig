import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { transportRoutes } from "../src/routes/transport.js";

function buildApp(bearerToken: string | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionTransport" as never, {
      resolveSessions: async () => ({ ok: true, sessions: [{ sessionName: "test", tmuxSession: "test" }] }),
      send: async () => ({ ok: true }),
      capture: async () => ({ ok: true, content: "test output" }),
      broadcast: async () => ({ ok: true, results: [] }),
    });
    await next();
  });
  app.route("/api/transport", transportRoutes({ bearerToken }));
  return app;
}

describe("transport 路由的 terminal-token 认证", () => {
  const TOKEN = "test-terminal-token-abc123";

  describe("要求 token 时", () => {
    const app = buildApp(TOKEN);

    it("POST /send 不带 token 时返回 401", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /send 携带错误 token 时返回 401", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /send 携带合法 token 时通过认证", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).not.toBe(401);
    });

    it("POST /capture 不带 token 时返回 401", async () => {
      const res = await app.request("/api/transport/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "test" }),
      });
      expect(res.status).toBe(401);
    });

    it("POST /capture 携带合法 token 时通过认证", async () => {
      const res = await app.request("/api/transport/capture", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ session: "test" }),
      });
      expect(res.status).not.toBe(401);
    });

    it("POST /broadcast 不带 token 时返回 401", async () => {
      const res = await app.request("/api/transport/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rig: "test", text: "hello" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("未配置 token（null）时", () => {
    const app = buildApp(null);

    it("POST /send 无需认证即可通过", async () => {
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "test", text: "hello" }),
      });
      expect(res.status).not.toBe(401);
    });
  });
});
