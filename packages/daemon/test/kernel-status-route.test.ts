// V0.3.1 slice 05 kernel-rig-as-default——架构级 forward-fix #3。
//
// GET /api/kernel/status 路由测试。验证该路由通过稳定的 JSON envelope
// 暴露 tracker 状态，并在未接入 tracker 时明确返回 503。

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { kernelStatusRoutes } from "../src/routes/kernel-status.js";
import { KernelBootTracker } from "../src/domain/kernel-boot-tracker.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { RigRepository } from "../src/domain/rig-repository.js";

function mountWithTracker(tracker: KernelBootTracker | undefined) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("kernelBootTracker" as never, tracker);
    await next();
  });
  app.route("/api/kernel", kernelStatusRoutes);
  return app;
}

function makeTracker(opts: {
  rigs?: Array<{ id: string; name: string }>;
  sessionsByRig?: Record<string, Array<{ sessionName: string; runtime: string; startupStatus: string }>>;
} = {}) {
  const eventBus = { emit: () => undefined } as unknown as EventBus;
  const sessionRegistry = {
    getSessionsForRig: (rigId: string) => opts.sessionsByRig?.[rigId] ?? [],
  } as unknown as SessionRegistry;
  const rigRepo = {
    listRigs: () => opts.rigs ?? [],
    findRigsByName: (name: string) => (opts.rigs ?? []).filter((r) => r.name === name),
  } as unknown as RigRepository;
  return new KernelBootTracker({ eventBus, sessionRegistry, rigRepo, degradedTimeoutMs: 0 });
}

describe("GET /api/kernel/status", () => {
  it("未接入 tracker 时返回 503 和明确错误", async () => {
    const app = mountWithTracker(undefined);
    const res = await app.request("/api/kernel/status");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("kernel_boot_tracker_unavailable");
    expect(body.message).toContain("内核启动 tracker 未接入");
  });

  it("对于全新的 tracker 返回 200 和 skipped envelope", async () => {
    const app = mountWithTracker(makeTracker());
    const res = await app.request("/api/kernel/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kernel_state).toBe("skipped");
    expect(body.agents).toEqual([]);
    expect(body.first_unready_since).toBeNull();
    expect(body.variant).toBeNull();
    expect(body.detail).toBeNull();
  });

  it("tracker 被 auth 阻塞时返回 200 和 auth_blocked envelope", async () => {
    const tracker = makeTracker();
    tracker.setAuthBlocked("Error: ...\nReason: ...\nFix: ...");
    const app = mountWithTracker(tracker);
    const res = await app.request("/api/kernel/status");
    const body = await res.json();
    expect(body.kernel_state).toBe("auth_blocked");
    expect(body.detail).toContain("Error:");
  });

  it("从 tracker getStatus() 投影带 snake_case key 的 agents[]", async () => {
    const rigId = "rig-kernel-route-1";
    const tracker = makeTracker({
      rigs: [{ id: rigId, name: "kernel" }],
      sessionsByRig: {
        [rigId]: [
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "ready" },
          { sessionName: "operator-agent@kernel", runtime: "codex", startupStatus: "pending" },
        ],
      },
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await new Promise<void>((r) => setImmediate(r));
    const app = mountWithTracker(tracker);
    const res = await app.request("/api/kernel/status");
    const body = await res.json();
    expect(body.kernel_state).toBe("partial_ready");
    expect(body.variant).toBe("rig.yaml");
    expect(body.agents).toHaveLength(2);
    expect(body.agents[0]).toMatchObject({
      session_name: "advisor-lead@kernel",
      runtime: "claude-code",
      startup_status: "ready",
    });
    expect(body.first_unready_since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    tracker.stop();
  });
});
