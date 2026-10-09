import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { providerRoutes } from "../src/routes/provider.js";
import type { ProviderService } from "../src/domain/provider/provider-service.js";
import type { FourBlockReadModel } from "../src/domain/provider/provider-types.js";

// 切片 04（OPR.0.5.0.4）接缝 B——daemon provider 路由（数据包 3ffa3c22 §3）。
// 基于单一服务读取模型的轻量 handler：筛选投影不会分歧；边界校验 -> 400；不安全的
// precheck 仍是 200 裁决；switch 结果为 200 载荷；服务未接线 -> 明确返回 503。

const MODEL: FourBlockReadModel = {
  accounts: [
    { accountId: "cdx-a", label: "Codex A", provider: "codex", authState: "active", profileRef: "p-a", asOf: "2026-08-03T12:00:00.000Z" },
    { accountId: "cla-x", label: "Claude X", provider: "claude", authState: "active", profileRef: null, asOf: "2026-08-03T12:00:00.000Z" },
  ],
  bindings: [
    { accountId: "cdx-a", seatSession: "seat-1", rigName: "r1", boundAt: "2026-08-03T12:00:00.000Z", bindingSource: "adopt", anomalies: [] },
  ],
  signals: [
    { provider: "codex", accountRef: "cdx-a", sourceClass: "provider_structured_read", authority: "account_cross_device", window: "primary", usedPercent: 40, asOf: "2026-08-03T12:00:00.000Z", staleAfter: "2026-08-03T12:05:00.000Z", supportsNotification: true, automationUse: "allow_switch_decision" },
    { provider: "claude", accountRef: "cla-x", sourceClass: "provider_statusline", authority: "account_cross_device", window: "five_hour", usedPercent: 10, asOf: "2026-08-03T12:00:00.000Z", staleAfter: "2026-08-03T12:05:00.000Z", supportsNotification: false, automationUse: "allow_switch_decision" },
  ],
  asOf: "2026-08-03T12:00:00.000Z",
};

const stubService: ProviderService = {
  getReadModel: async () => MODEL,
  precheck: async ({ toAccount }) => (toAccount === "cdx-a" ? { safe: true } : { safe: false, reasons: ["target_needs_reauth"] }),
  switchAccount: async ({ toAccount }) =>
    toAccount === "cla-x"
      ? { outcome: "failed_safely", reasons: ["rebind_unsupported_for_runtime"] as [string, ...string[]] }
      : { outcome: "succeeded" },
};

function appWith(svc: ProviderService | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (svc) c.set("providerService" as never, svc);
    await next();
  });
  app.route("/api/provider", providerRoutes());
  return app;
}

describe("provider 路由", () => {
  it("GET /status 返回完整的四块模型", async () => {
    const res = await appWith(stubService).request("/api/provider/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MODEL);
  });

  it("accounts/bindings/signals 是同一模型的筛选投影（不能分歧）", async () => {
    const app = appWith(stubService);
    const acc = await (await app.request("/api/provider/accounts?provider=codex")).json();
    expect(acc.accounts.map((a: { accountId: string }) => a.accountId)).toEqual(["cdx-a"]);
    const sig = await (await app.request("/api/provider/signals?provider=claude")).json();
    expect(sig.signals.map((s: { accountRef: string }) => s.accountRef)).toEqual(["cla-x"]);
    const bnd = await (await app.request("/api/provider/bindings?account=cdx-a")).json();
    expect(bnd.bindings).toHaveLength(1);
    expect(bnd.bindings[0].seatSession).toBe("seat-1");
  });

  it("在边界拒绝格式错误的 provider 枚举（400）", async () => {
    const res = await appWith(stubService).request("/api/provider/accounts?provider=bad");
    expect(res.status).toBe(400);
  });

  it("在边界拒绝空值/仅空白的 account 筛选条件（400）", async () => {
    const res = await appWith(stubService).request("/api/provider/accounts?account=");
    expect(res.status).toBe(400);
  });

  it("JSON null 的 switch 请求体格式错误（400），绝不意外返回 500", async () => {
    const res = await appWith(stubService).request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  it("即使不安全，precheck 也返回 200 裁决（safe:false 不是错误）", async () => {
    const res = await appWith(stubService).request("/api/provider/precheck?seat=s1&toAccount=cla-x");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.safe).toBe(false);
    expect(body.reasons).toContain("target_needs_reauth");
  });

  it("precheck 要求 seat 和 toAccount（缺失时返回 400）", async () => {
    const res = await appWith(stubService).request("/api/provider/precheck?seat=s1");
    expect(res.status).toBe(400);
  });

  it("switch 业务结果是 200 载荷，而非传输错误（failed_safely = 200）", async () => {
    const res = await appWith(stubService).request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "s1", toAccount: "cla-x", forceUnsafe: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("failed_safely");
    // BR-1：failed_safely 结果必须携带失败可见的原因（类型强制 + 断言）。
    expect(Array.isArray(body.reasons)).toBe(true);
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it("在边界拒绝仅空白的 seat/toAccount（precheck 查询与 switch 请求体）→ 400", async () => {
    const app = appWith(stubService);
    const pre = await app.request("/api/provider/precheck?seat=%20%20&toAccount=cdx-a");
    expect(pre.status).toBe(400);
    const sw = await app.request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "  ", toAccount: "cdx-a", forceUnsafe: false }),
    });
    expect(sw.status).toBe(400);
  });

  it("switch 在边界校验 seat/toAccount/forceUnsafe（格式错误时返回 400）", async () => {
    const res = await appWith(stubService).request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "s1", forceUnsafe: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("未接线的服务明确返回 503 provider_service_unavailable（绝不伪造 stub）", async () => {
    const res = await appWith(null).request("/api/provider/status");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("provider_service_unavailable");
  });
});
