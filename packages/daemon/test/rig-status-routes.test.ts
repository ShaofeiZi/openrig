import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

function countSessions(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
}

describe("OPR.0.4.3.22——rig-status + launch-plan 路由", () => {
  let db: Database.Database;
  let app: Hono;
  let repo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    repo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/rigs/:id/status 对未知 rig 返回 404", async () => {
    const res = await app.request("/api/rigs/nope/status");
    expect(res.status).toBe(404);
  });

  it("GET /api/rigs/:id/status 返回带 src 来源数组的组合状态对象", async () => {
    const rig = repo.createRig("r-status");
    repo.addNode(rig.id, "dev", { role: "dev" });

    const res = await app.request(`/api/rigs/${rig.id}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rigId).toBe(rig.id);
    expect(body.rigName).toBe("r-status");
    expect(["up", "partial", "down", "blocked", "unknown"]).toContain(body.status);
    // 状态来自组合而非推断，响应中可见来源信号。
    expect(Array.isArray(body.src)).toBe(true);
    expect(body.src.some((s: string) => s.startsWith("ps:"))).toBe(true);
    expect(Array.isArray(body.perSeat)).toBe(true);
    // 从未启动的 rig 没有运行中的席位，因此不处于 up。
    expect(body.status).not.toBe("up");
  });

  it("POST /api/rigs/:id/launch-plan 只读：返回 mutated:false 且不创建 session", async () => {
    const rig = repo.createRig("r-plan");
    repo.addNode(rig.id, "dev", { role: "dev" });

    const before = countSessions(db);
    const res = await app.request(`/api/rigs/${rig.id}/launch-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("plan");
    expect(body.mutated).toBe(false);
    expect(Array.isArray(body.nodes)).toBe(true);
    // 只读契约：未创建、终止或替换任何 session。
    expect(countSessions(db)).toBe(before);
  });

  it("POST /api/rigs/:id/launch-plan 对未知 rig 返回 404", async () => {
    const res = await app.request("/api/rigs/nope/launch-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("带 freshLogicalIds 的 POST /api/rigs/:id/launch-plan 为该席位预测 fresh-primed（不修改状态）", async () => {
    const rig = repo.createRig("r-fresh");
    const node = repo.addNode(rig.id, "dev", { role: "dev" });
    const session = sessionRegistry.registerSession(node.id, "dev@r-fresh");
    sessionRegistry.updateStatus(session.id, "running");

    const before = countSessions(db);
    const res = await app.request(`/api/rigs/${rig.id}/launch-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshLogicalIds: ["dev"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mutated).toBe(false);
    const dev = body.nodes.find((n: { logicalId: string }) => n.logicalId === "dev");
    expect(dev.intendedAction).toBe("fresh-primed");
    expect(countSessions(db)).toBe(before);
  });
});
