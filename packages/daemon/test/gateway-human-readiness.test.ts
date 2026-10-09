import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { resolveHumanDeliveryReadiness } from "../src/domain/gateway/human-readiness.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import type { SlackConnectorConfig } from "../src/domain/gateway/slack/config.js";

const human: HumanFragment = {
  entityId: "founder",
  class: "human",
  displayName: "Founder",
  address: "founder@external",
  connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://founder", role: "primary", handle: "U1" }],
  prefs: { deliveryClass: "B" },
};

const config: SlackConnectorConfig = {
  enabled: true,
  inboundDestination: "orch@rig",
  outboundDestinations: [],
  sourceLabel: "openrig",
  channel: "C1",
  requiredScopes: ["chat:write", "channels:read"],
  secretsEnvFile: null,
  queueUrl: null,
  minimumLevelThatPosts: "NOTICE",
  minimumLevelThatInterrupts: "ALERT",
};

describe("已注册 human 的 primary-binding readiness", () => {
  it("根据 live scope 与 membership evidence 返回 connector-neutral ready 字段", async () => {
    const result = await resolveHumanDeliveryReadiness({ human, config, gatewayState: "active", botToken: "secret" }, {
      verifyScopes: async () => ({ ok: true, granted: ["chat:write", "channels:read"], missing: [] }),
      verifyMembership: async () => ({ ok: true, isMember: true }),
      now: () => new Date("2026-09-06T01:00:00.000Z"),
    });
    expect(result).toEqual({
      state: "ready",
      configured: true,
      enabled: true,
      active: true,
      ready: true,
      connector: { kind: "slack", ref: "main" },
      reason: "已验证必需 scope 与 channel membership",
      nextAction: null,
      checkedAt: "2026-09-06T01:00:00.000Z",
    });
  });

  it("通过 gateway human 路由提供相同 connector-neutral record", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("gatewaySubsystem" as never, { status: () => ({ state: "active" }) } as never);
      await next();
    });
    app.route("/", gatewayRoutes({
      readiness: async (entityId, gatewayState) => entityId === "founder"
        ? resolveHumanDeliveryReadiness({ human, config, gatewayState, botToken: "secret" }, {
            verifyScopes: async () => ({ ok: true, granted: config.requiredScopes, missing: [] }),
            verifyMembership: async () => ({ ok: true, isMember: true }),
          })
        : null,
    }));
    const response = await app.request("/human/founder/readiness");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      readiness: { state: "ready", configured: true, enabled: true, active: true, ready: true },
    });
  });

  it("点名 disabled 配置，且不探测 connector", async () => {
    const verifyScopes = vi.fn(async () => ({ ok: true, granted: [], missing: [] }));
    const result = await resolveHumanDeliveryReadiness({ human, config: { ...config, enabled: false }, gatewayState: "active", botToken: "secret" }, {
      verifyScopes,
      verifyMembership: async () => ({ ok: true, isMember: true }),
    });
    expect(result).toMatchObject({ state: "not-ready", configured: true, enabled: false, active: false, ready: false, nextAction: "zrig slack enable" });
    expect(verifyScopes).not.toHaveBeenCalled();
  });

  it("不可达 live probe 保持 indeterminate，不判为 ready 或 failed", async () => {
    const result = await resolveHumanDeliveryReadiness({ human, config, gatewayState: "active", botToken: "secret" }, {
      verifyScopes: async () => ({ ok: false, granted: [], missing: config.requiredScopes, error: "request timed out" }),
      verifyMembership: async () => ({ ok: true, isMember: true }),
    });
    expect(result).toMatchObject({ state: "indeterminate", configured: true, enabled: true, active: true, ready: false });
    expect(result.reason).toContain("request timed out");
    expect(result.nextAction).toBe("zrig slack verify --json");
  });
});
