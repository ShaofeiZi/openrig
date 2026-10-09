import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatHandoverPlanner, parseHandoverSource } from "../src/domain/seat-handover-planner.js";

describe("SeatHandoverPlanner", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let planner: SeatHandoverPlanner;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    planner = new SeatHandoverPlanner({ rigRepo });
  });

  afterEach(() => {
    db.close();
  });

  function seedSeat() {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig" });
    return { rig, node, session };
  }

  function durableRows(): string {
    const tables = ["nodes", "sessions", "bindings"] as const;
    return JSON.stringify(Object.fromEntries(tables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ])));
  }

  it("使用当前 seat 状态构建稳定且无修改的 dry-run 计划", () => {
    seedSeat();
    const before = durableRows();

    const result = planner.plan({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:0b0165d7",
      operator: "orch-lead@seat-rig",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan).toMatchObject({
      ok: true,
      dryRun: true,
      willMutate: false,
      seat: {
        ref: "dev-impl@seat-rig",
        rigName: "seat-rig",
        logicalId: "dev.impl",
        runtime: "codex",
      },
      source: { mode: "fork", ref: "0b0165d7", raw: "fork:0b0165d7", defaulted: false },
      reason: "context-wall",
      operator: "orch-lead@seat-rig",
      currentOccupant: "dev-impl@seat-rig",
      currentStatus: {
        sessionStatus: "running",
        startupStatus: "ready",
        occupantLifecycle: "active",
        continuityOutcome: null,
        handoverResult: null,
      },
    });
    expect(result.plan.phases.map((phase) => phase.id)).toEqual(["prepare", "commit"]);
    expect(result.plan.phases.flatMap((phase) => phase.steps.map((step) => step.id))).toEqual([
      "validate-seat",
      "capture-departing-context",
      "create-successor",
      "verify-successor-readiness",
      "archive-departing-occupant",
      "rebind-seat",
      "deliver-startup-context",
      "record-provenance",
    ]);
    expect(result.plan.phases.flatMap((phase) => phase.steps).every((step) => step.willMutate === false)).toBe(true);
    expect(durableRows()).toBe(before);
  });

  it("source 默认为 fresh，并可解析 rebuild 与 fork source", () => {
    expect(parseHandoverSource(null)).toMatchObject({
      ok: true,
      source: { mode: "fresh", ref: null, raw: "fresh", defaulted: true },
    });
    expect(parseHandoverSource("default")).toMatchObject({
      ok: true,
      source: { mode: "fresh", ref: null, raw: "default", defaulted: true },
    });
    expect(parseHandoverSource("rebuild")).toMatchObject({
      ok: true,
      source: { mode: "rebuild", ref: null, raw: "rebuild", defaulted: false },
    });
    expect(parseHandoverSource("fork:abc123")).toMatchObject({
      ok: true,
      source: { mode: "fork", ref: "abc123", raw: "fork:abc123", defaulted: false },
    });
    expect(parseHandoverSource("discovered:disc-123")).toMatchObject({
      ok: true,
      source: { mode: "discovered", ref: "disc-123", raw: "discovered:disc-123", defaulted: false },
    });
  });

  it("规划前要求提供 reason", () => {
    seedSeat();

    const result = planner.plan({ seatRef: "dev-impl@seat-rig", dryRun: true });

    expect(result).toMatchObject({
      ok: false,
      code: "missing_reason",
      message: "缺少必填选项：--reason <reason>",
    });
  });

  it("对未知 seat 返回 seat 查找指引", () => {
    const result = planner.plan({
      seatRef: "missing@seat-rig",
      reason: "context-wall",
      dryRun: true,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "seat_not_found",
      guidance: "使用 zrig ps --nodes 列出席位",
    });
  });

  it("拒绝非 dry-run 修改", () => {
    seedSeat();

    const result = planner.plan({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      dryRun: false,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "mutation_disabled",
      message: "此 slice 尚未实现 seat handover 修改操作。",
    });
  });

  it("接通后台服务 /api/seat/handover 路由", async () => {
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");

    const res = await setup.app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "context-wall", source: "rebuild", dryRun: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      dryRun: true,
      willMutate: false,
      source: { mode: "rebuild", ref: null },
      currentOccupant: "dev-impl@seat-rig",
    });
  });
});
