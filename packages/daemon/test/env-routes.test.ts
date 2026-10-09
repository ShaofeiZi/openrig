import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { envRoutes } from "../src/routes/env.js";

function createApp(deps: {
  getServicesRecord: (rigId: string) => unknown;
  captureReceipt?: (rigId: string) => unknown;
  teardown?: (rigId: string, opts?: unknown) => unknown;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, { getServicesRecord: deps.getServicesRecord });
    const orchestrator = (deps.captureReceipt || deps.teardown)
      ? { captureReceipt: deps.captureReceipt, teardown: deps.teardown }
      : undefined;
    c.set("serviceOrchestrator" as never, orchestrator);
    c.set("composeAdapter" as never, undefined);
    await next();
  });
  app.route("/api/rigs/:rigId/env", envRoutes());
  return app;
}

describe("env 路由", () => {
  it("没有记录时 GET /api/rigs/:rigId/env 返回 hasServices false", async () => {
    const app = createApp({ getServicesRecord: () => null });
    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["hasServices"]).toBe(false);
    expect(body["surfaces"]).toBeUndefined();
  });

  it("对于服务支撑的 rig，GET /api/rigs/:rigId/env 返回 specJson 中的 surfaces", async () => {
    const specJson = JSON.stringify({
      kind: "compose",
      compose_file: "svc.compose.yaml",
      project_name: "test-svc",
      down_policy: "down",
      wait_for: [{ url: "http://127.0.0.1:8200/health" }],
      surfaces: {
        urls: [
          { name: "Vault UI", url: "http://127.0.0.1:8200/ui" },
          { name: "Vault API", url: "http://127.0.0.1:8200/v1" },
        ],
        commands: [
          { name: "Vault status", command: "vault status" },
        ],
      },
    });

    const app = createApp({
      getServicesRecord: () => ({
        rigId: "rig-1",
        kind: "compose",
        specJson,
        rigRoot: "/tmp",
        composeFile: "/tmp/svc.compose.yaml",
        projectName: "test-svc",
        latestReceiptJson: null,
        createdAt: "2026-04-09T00:00:00Z",
        updatedAt: "2026-04-09T00:00:00Z",
      }),
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["hasServices"]).toBe(true);
    expect(body["kind"]).toBe("compose");

    const surfaces = body["surfaces"] as Record<string, unknown>;
    expect(surfaces).toBeDefined();
    const urls = surfaces["urls"] as Array<{ name: string; url: string }>;
    expect(urls).toHaveLength(2);
    expect(urls[0]!.name).toBe("Vault UI");
    expect(urls[0]!.url).toBe("http://127.0.0.1:8200/ui");
    const commands = surfaces["commands"] as Array<{ name: string; command: string }>;
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("Vault status");
  });

  const SERVICE_RECORD = {
    rigId: "rig-1",
    kind: "compose",
    specJson: JSON.stringify({ kind: "compose", compose_file: "svc.yaml" }),
    rigRoot: "/tmp",
    composeFile: "/tmp/svc.yaml",
    projectName: "test-svc",
    latestReceiptJson: JSON.stringify({ kind: "compose", services: [{ name: "vault", status: "running", health: "healthy" }], capturedAt: "2026-04-09T11:00:00Z" }),
    createdAt: "2026-04-09T00:00:00Z",
    updatedAt: "2026-04-09T00:00:00Z",
  };

  it("captureReceipt 抛出异常时，GET /env 返回 probeStatus=stale 和 probeError", async () => {
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      captureReceipt: () => { throw new Error("compose ps failed: connection refused"); },
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["hasServices"]).toBe(true);
    expect(body["probeStatus"]).toBe("stale");
    expect(body["probeError"]).toContain("connection refused");
    // 仍返回缓存的 receipt
    const receipt = body["receipt"] as Record<string, unknown>;
    expect(receipt).toBeDefined();
    expect(receipt["capturedAt"]).toBe("2026-04-09T11:00:00Z");
  });

  it("captureReceipt 成功时 GET /env 返回 probeStatus=fresh", async () => {
    const freshReceipt = { kind: "compose", services: [{ name: "vault", status: "running", health: "healthy" }], capturedAt: "2026-04-09T12:00:00Z" };
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      captureReceipt: () => freshReceipt,
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["probeStatus"]).toBe("fresh");
    expect(body["probeError"]).toBeUndefined();
    const receipt = body["receipt"] as Record<string, unknown>;
    expect(receipt["capturedAt"]).toBe("2026-04-09T12:00:00Z");
  });

  it("serviceOrchestrator 缺失时 GET /env 返回 probeStatus=no_orchestrator", async () => {
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      // 没有 captureReceipt → serviceOrchestrator 为 undefined
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["probeStatus"]).toBe("no_orchestrator");
    expect(body["probeError"]).toBeUndefined();
    // 仍返回缓存的 receipt
    const receipt = body["receipt"] as Record<string, unknown>;
    expect(receipt).toBeDefined();
    expect(receipt["capturedAt"]).toBe("2026-04-09T11:00:00Z");
  });

  it("captureReceipt 返回 null 时 GET /env 返回 probeStatus=stale", async () => {
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      captureReceipt: () => null,
    });

    const res = await app.request("/api/rigs/rig-1/env");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["hasServices"]).toBe(true);
    // null 探测结果不属于 fresh——services 记录可能已消失
    expect(body["probeStatus"]).not.toBe("fresh");
    expect(body["probeStatus"]).toBe("stale");
    expect(body["probeError"]).toContain("探测未返回回执");
    // 保留缓存的 receipt
    const receipt = body["receipt"] as Record<string, unknown>;
    expect(receipt["capturedAt"]).toBe("2026-04-09T11:00:00Z");
  });

  it("带 volumes=true 的 POST /env/down 向 teardown 传递 policyOverride=down_and_volumes", async () => {
    let capturedOpts: unknown = undefined;
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      teardown: (_rigId: string, opts?: unknown) => {
        capturedOpts = opts;
        return Promise.resolve({ ok: true });
      },
    });

    const res = await app.request("/api/rigs/rig-1/env/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volumes: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(capturedOpts).toBeDefined();
    expect((capturedOpts as Record<string, unknown>)["policyOverride"]).toBe("down_and_volumes");
  });

  it("不带 volumes 的 POST /env/down 不传递 policyOverride", async () => {
    let capturedOpts: unknown = undefined;
    const app = createApp({
      getServicesRecord: () => SERVICE_RECORD,
      teardown: (_rigId: string, opts?: unknown) => {
        capturedOpts = opts;
        return Promise.resolve({ ok: true });
      },
    });

    const res = await app.request("/api/rigs/rig-1/env/down", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(capturedOpts).toBeUndefined();
  });

  it("hasServices 为 false 时 GET /env 不包含 probeStatus", async () => {
    const app = createApp({ getServicesRecord: () => null });
    const res = await app.request("/api/rigs/rig-1/env");
    const body = await res.json() as Record<string, unknown>;
    expect(body["hasServices"]).toBe(false);
    expect(body["probeStatus"]).toBeUndefined();
  });
});
