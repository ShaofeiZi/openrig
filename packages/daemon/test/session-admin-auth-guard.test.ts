// OPR.0.4.3.02 — 会话管理变更类接口的鉴权守卫。
// 三个会改变状态的 session-admin POST(reconcile / clear-attention / unclaim)
// 必须复用 resume-token 写入与 preview 读取已上线的同一个 terminalAuthGuard()。
// 这证明已上线的 bearer 中间件覆盖了这些路由 —— 不引入新的鉴权模型。
// 结构与已上线的守卫测试保持一致
// (resume-token-route.test.ts:122 + terminal-auth.test.ts):缺少 bearer 或携带错误
// bearer 时 401、携带正确 bearer 时放行(200)、loopback(null token)无 header 时直接放行。

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { sessionAdminRoutes } from "../src/routes/sessions.js";

const TOKEN = "secret-terminal-token-abc123";

// 每个路由的最小依赖桩 —— 只要守卫放行请求,就足以让对应处理器到达确定的
// ok:true(200)。这里被测的是守卫本身;处理器的业务逻辑在别处覆盖。
function stubDeps() {
  return {
    // reconcile → convergeOp(reconcile_session) 调用 claimService.reconcileSession
    claimService: { reconcileSession: async () => ({ ok: true, sessionName: "dev1-impl@test-rig", projectionDrift: [], continuity: "unverified" }) },
    podInstantiator: {}, // 仅做存在性检查
    // clear-attention
    seatAttentionReconciler: { clearAttention: async () => ({ ok: true, from: "attention_required", clearedBy: "evidence" }) },
    // unclaim
    rigLifecycleService: { unclaimSession: async () => ({ ok: true, sessionName: "dev1-impl@test-rig", logicalId: "dev1.impl", rigId: "rig-1" }) },
  };
}

// 把 sessionAdminRoutes 挂在一个上下文中间件之后,由该中间件写入终端 bearer
// token(null = loopback/无 token 模式)并注入桩依赖。
function mountApp(bearerToken: string | null): { request: (p: string, init?: RequestInit) => Promise<Response> } {
  const deps = stubDeps();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("terminalBearerToken" as never, bearerToken);
    c.set("claimService" as never, deps.claimService);
    c.set("podInstantiator" as never, deps.podInstantiator);
    c.set("seatAttentionReconciler" as never, deps.seatAttentionReconciler);
    c.set("rigLifecycleService" as never, deps.rigLifecycleService);
    await next();
  });
  app.route("/api/sessions", sessionAdminRoutes);
  return app;
}

function post(app: { request: (p: string, init?: RequestInit) => Promise<Response> }, path: string, headers?: Record<string, string>) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify({}),
  });
}

const ROUTES: Array<{ name: string; path: string }> = [
  { name: "reconcile", path: "/api/sessions/dev1-impl%40test-rig/reconcile" },
  { name: "clear-attention", path: "/api/sessions/dev1-impl%40test-rig/clear-attention" },
  { name: "unclaim", path: "/api/sessions/dev1-impl%40test-rig/unclaim" },
];

describe("session-admin 变更接口鉴权守卫(OPR.0.4.3.02)", () => {
  describe("配置了 bearer token(非 loopback)", () => {
    for (const route of ROUTES) {
      describe(`POST .../${route.name}`, () => {
        it("不带 Authorization 头时返回 401", async () => {
          const app = mountApp(TOKEN);
          const res = await post(app, route.path);
          expect(res.status).toBe(401);
        });

        it("携带错误 bearer token 时返回 401", async () => {
          const app = mountApp(TOKEN);
          const res = await post(app, route.path, { Authorization: "Bearer wrong-token" });
          expect(res.status).toBe(401);
        });

        it("携带正确 bearer token 时放行(200)", async () => {
          const app = mountApp(TOKEN);
          const res = await post(app, route.path, { Authorization: `Bearer ${TOKEN}` });
          expect(res.status).toBe(200);
        });
      });
    }
  });

  describe("loopback / 无 token 模式(terminalBearerToken = null)", () => {
    for (const route of ROUTES) {
      it(`POST .../${route.name} 在无 Authorization 头时直接放行`, async () => {
        const app = mountApp(null);
        const res = await post(app, route.path);
        expect(res.status).not.toBe(401);
        expect(res.status).toBe(200);
      });
    }
  });

  describe("无回归:相邻路由保持既有行为", () => {
    it("已受守卫保护的 resume-token 写入在缺少 bearer 时仍返回 401", async () => {
      const app = mountApp(TOKEN);
      const res = await post(app, "/api/sessions/dev1-impl%40test-rig/resume-token");
      expect(res.status).toBe(401);
    });

    it("已受守卫保护的 GET preview 在缺少 bearer 时仍返回 401", async () => {
      const app = mountApp(TOKEN);
      const res = await app.request("/api/sessions/dev1-impl%40test-rig/preview");
      expect(res.status).toBe(401);
    });
  });
});
