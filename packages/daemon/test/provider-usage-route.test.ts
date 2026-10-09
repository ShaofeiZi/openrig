// Slice-04（OPR.0.5.0.4）S-B——GET /api/provider/usage：外部状态站点的完整契约。
// 这是 S-A host rollup 上的薄路由：逐字提供 model.hostUsage（rollupHostUsage 行），此处不做推导
//（state/windows/resets_at/conflict-anomaly/provenance 均在 S-A 构建）。路由层固定项包括契约结构、
// anomaly 渲染（双方事实均可见）、路由层不泄露 account id 的边界、explicit_unknown 透传，以及
// service 未接线时明确返回 503。
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { providerRoutes } from "../src/routes/provider.js";
import type { ProviderService } from "../src/domain/provider/provider-service.js";
import type { FourBlockReadModel } from "../src/domain/provider/provider-types.js";
import type { HostUsageRow } from "../src/domain/provider/host-usage-rollup.js";

const AS_OF = "2026-08-03T12:00:00.000Z";
const PROVENANCE = {
  basis: "one_account_per_host_deployment_invariant" as const,
  note: "host==account deployment invariant declared by the operator; no account identity is read or emitted.",
};

const HOST_USAGE: HostUsageRow[] = [
  // 正常。
  { host: "local", provider: "claude", state: "ok", windows: [{ window: "five_hour", usedPercent: 10, asOf: AS_OF, seatSession: "review-r1@rig" }], provenance: PROVENANCE, anomalies: [], evidenceSeats: ["review-r1@rig"], asOf: AS_OF },
  // limited + resets_at。
  { host: "local", provider: "codex", state: "limited", resetsAt: "2026-08-03T13:00:00.000Z", windows: [{ window: "primary", usedPercent: 100, resetsAt: "2026-08-03T13:00:00.000Z", asOf: AS_OF, seatSession: "dev-qa@rig" }], provenance: PROVENANCE, anomalies: [], evidenceSeats: ["dev-qa@rig"], asOf: AS_OF },
  // explicit_unknown + reason（透传）。
  { host: "local", provider: "codex", state: "explicit_unknown", unknownReason: "codex profile present but no usage meter", windows: [], provenance: PROVENANCE, anomalies: [], evidenceSeats: [], asOf: AS_OF },
];

// 携带一等 conflict anomaly 的行（双方事实均可见）。
const HOST_USAGE_CONFLICT: HostUsageRow[] = [
  { host: "local", provider: "claude", state: "explicit_unknown", unknownReason: "conflicting seat windows falsify the one-account-per-host invariant", windows: [], provenance: PROVENANCE, anomalies: [{ kind: "conflicting_seat_windows", window: "five_hour", seats: ["a@rig", "b@rig"], evidence: "a=20% vs b=90% at same asOf", asOf: AS_OF }], evidenceSeats: ["a@rig", "b@rig"], asOf: AS_OF },
];

function modelWith(hostUsage: HostUsageRow[] | undefined): FourBlockReadModel {
  return {
    // accounts 有意携带账户标识；此边界证明 /usage 绝不泄露它们。
    accounts: [{ accountId: "cdx-secret-acct", label: "Codex", provider: "codex", authState: "active", profileRef: "p", asOf: AS_OF }],
    bindings: [],
    signals: [],
    ...(hostUsage !== undefined ? { hostUsage } : {}),
    asOf: AS_OF,
  };
}

function appWith(svc: ProviderService | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (svc) c.set("providerService" as never, svc);
    await next();
  });
  app.route("/api/provider", providerRoutes());
  return app;
}

const svc = (hostUsage: HostUsageRow[] | undefined): ProviderService => ({
  getReadModel: async () => modelWith(hostUsage),
  precheck: async () => ({ safe: true }),
  switchAccount: async () => ({ outcome: "succeeded" }),
});

describe("GET /api/provider/usage——S-B 外部状态契约", () => {
  it("逐字提供 host rollup 行（provider、state、windows、resets_at、asOf、evidence、provenance）", async () => {
    const res = await appWith(svc(HOST_USAGE)).request("/api/provider/usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hostUsage).toEqual(HOST_USAGE); // 逐字提供，不推导也不重塑。
    const codexLimited = body.hostUsage.find((r: HostUsageRow) => r.provider === "codex" && r.state === "limited");
    expect(codexLimited.resetsAt).toBe("2026-08-03T13:00:00.000Z");
    expect(codexLimited.windows[0].usedPercent).toBe(100);
    expect(body.hostUsage[0].provenance.basis).toBe("one_account_per_host_deployment_invariant");
  });

  it("渲染 conflict anomaly（双方事实均可见），绝不静默合并", async () => {
    const body = await (await appWith(svc(HOST_USAGE_CONFLICT)).request("/api/provider/usage")).json();
    const row = body.hostUsage[0];
    expect(row.state).toBe("explicit_unknown");
    expect(row.anomalies).toHaveLength(1);
    expect(row.anomalies[0].kind).toBe("conflicting_seat_windows");
    expect(row.anomalies[0].seats).toEqual(["a@rig", "b@rig"]);
  });

  it("原样透传 explicit_unknown 行（state + unknownReason）", async () => {
    const body = await (await appWith(svc(HOST_USAGE)).request("/api/provider/usage")).json();
    const unknown = body.hostUsage.find((r: HostUsageRow) => r.state === "explicit_unknown");
    expect(unknown.unknownReason).toBe("codex profile present but no usage meter");
    expect(unknown.windows).toEqual([]);
  });

  it("边界：/usage 响应在路由层不输出任何账户标识", async () => {
    const res = await appWith(svc(HOST_USAGE)).request("/api/provider/usage");
    const raw = await res.text();
    expect(raw).not.toContain("cdx-secret-acct"); // accounts 块 id 绝不进入 /usage。
    expect(raw).not.toContain("accountId");
    expect(raw).not.toContain("accountRef");
  });

  it("空 rollup 产生空 hostUsage 数组（真实，而非伪造行）", async () => {
    const body = await (await appWith(svc([])).request("/api/provider/usage")).json();
    expect(body.hostUsage).toEqual([]);
  });

  // 守卫提示（S-B 裁定，顺带折入）：完全没有 hostUsage key 的 PRE-S-A model 会覆盖 `?? []`
  // 缺键分支；必须提供真实空数组，绝不能是 undefined/null。
  it("hostUsage key 缺失（pre-S-A model）时通过 ?? [] 分支返回真实空数组", async () => {
    const body = await (await appWith(svc(undefined)).request("/api/provider/usage")).json();
    expect(body.hostUsage).toEqual([]);
  });

  it("service 未接线时明确返回 503（绝不返回空或伪造 payload）", async () => {
    const res = await appWith(null).request("/api/provider/usage");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("provider_service_unavailable");
  });
});
