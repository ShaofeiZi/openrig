import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";

describe("SeatStatusService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let service: SeatStatusService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    service = new SeatStatusService({ rigRepo });
  });

  afterEach(() => {
    db.close();
  });

  it("为现有活跃节点返回如实的无 handover 默认值", () => {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");

    const result = service.getStatus("dev-impl@seat-rig");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status).toMatchObject({
      seat_ref: "dev-impl@seat-rig",
      rig_name: "seat-rig",
      logical_id: "dev.impl",
      current_occupant: "dev-impl@seat-rig",
      session_status: "running",
      startup_status: "ready",
      occupant_lifecycle: "active",
      continuity_outcome: null,
      handover_result: null,
      previous_occupant: null,
      handover_at: null,
    });
  });

  it("返回已填充的 handover 轴和来源字段", () => {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    db.prepare(`
      UPDATE nodes SET
        occupant_lifecycle = 'retired',
        continuity_outcome = 'rebuilt',
        handover_result = 'partial',
        previous_occupant = 'old-impl@seat-rig',
        handover_at = '2026-04-20T13:00:00Z'
      WHERE id = ?
    `).run(node.id);

    const result = service.getStatus("dev.impl@seat-rig");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status.occupant_lifecycle).toBe("retired");
    expect(result.status.continuity_outcome).toBe("rebuilt");
    expect(result.status.handover_result).toBe("partial");
    expect(result.status.previous_occupant).toBe("old-impl@seat-rig");
    expect(result.status.handover_at).toBe("2026-04-20T13:00:00Z");
  });

  it("不会为没有当前运行会话的节点推断 active 生命周期", () => {
    const rig = rigRepo.createRig("seat-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });

    const result = service.getStatus("dev.impl@seat-rig");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status.current_occupant).toBeNull();
    expect(result.status.occupant_lifecycle).toBe("unknown");
    expect(result.status.continuity_outcome).toBeNull();
    expect(result.status.handover_result).toBeNull();
  });

  it("对未知 seat 引用返回未找到", () => {
    const result = service.getStatus("missing@seat-rig");

    expect(result).toMatchObject({
      ok: false,
      code: "seat_not_found",
      guidance: "使用 zrig ps --nodes 列出席位",
    });
  });

  it("接入 daemon 的 /api/seat/status 路由", async () => {
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");

    const res = await setup.app.request("/api/seat/status/dev-impl%40seat-rig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      seat_ref: "dev-impl@seat-rig",
      rig_name: "seat-rig",
      logical_id: "dev.impl",
      occupant_lifecycle: "active",
      handover_result: null,
    });
  });
});
