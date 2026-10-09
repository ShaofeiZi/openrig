import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import {
  MissionControlFleetCliCapability,
  MISSION_CONTROL_DESIRED_FIELDS,
  LOCAL_CLI_NODE_FIELDS_AT_0_2_0,
  LOCAL_CLI_VERSION_LABEL,
  makeLocalCliCapabilityProbe,
} from "../src/domain/mission-control/mission-control-fleet-cli-capability.js";

describe("MissionControlFleetCliCapability（PL-005 Phase A；graceful degradation 的 4 个子条款）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, rigArchiveSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig-alpha')`).run();
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-2', 'rig-beta')`).run();
    bus = new EventBus(db);
    rigRepo = new RigRepository(db);
  });

  afterEach(() => db.close());

  it("rollupFleet 为每个已注册 rig 返回一行", async () => {
    const cli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    const fleet = await cli.rollupFleet();
    expect(fleet.rows).toHaveLength(2);
  });

  it("子条款 1+4：probe 上报的缺失字段浮现为 drift + 抬升 staleCliCount", async () => {
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: async (name) => ({
        cliVersionLabel: name === "rig-alpha" ? "v0.1.12" : "head",
        unsupportedFields: name === "rig-alpha" ? ["recoveryGuidance"] : [],
      }),
    });
    const fleet = await cli.rollupFleet();
    const alpha = fleet.rows.find((r) => r.rigName === "rig-alpha");
    const beta = fleet.rows.find((r) => r.rigName === "rig-beta");
    expect(alpha?.cliDriftDetected).toBe(true);
    expect(beta?.cliDriftDetected).toBe(false);
    expect(fleet.staleCliCount).toBe(1);
    expect(fleet.degradedFields).toContain("recoveryGuidance");
  });

  it("子条款 3：once-per-session-per-rig 日志——drift 事件每个（rig, field）只发一次", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: async () => ({
        cliVersionLabel: "v0.1.12",
        unsupportedFields: ["recoveryGuidance"],
      }),
    });
    // 5 次 rollup 调用 = 10 个（rig, field）观测，但只有 2 个 drift 事件（每 rig 一个）。
    for (let i = 0; i < 5; i++) {
      await cli.rollupFleet();
    }
    const driftEvents = events.filter((e) => e.type === "mission_control.cli_drift_detected");
    expect(driftEvents).toHaveLength(2); // 2 rig × 1 缺失字段 × ONCE
  });

  it("子条款 3：resetDriftLogForTest 重新武装 once-per-session 日志", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: async () => ({
        cliVersionLabel: "v0.1.12",
        unsupportedFields: ["recoveryGuidance"],
      }),
    });
    await cli.rollupFleet();
    expect(events.filter((e) => e.type === "mission_control.cli_drift_detected")).toHaveLength(2);
    cli.resetDriftLogForTest();
    await cli.rollupFleet();
    expect(events.filter((e) => e.type === "mission_control.cli_drift_detected")).toHaveLength(4);
  });

  it("子条款 2：per-rig 诚实——不同 rig 上报不同能力", async () => {
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: async (name) => {
        if (name === "rig-alpha") return { cliVersionLabel: "v0.1.12", unsupportedFields: [...MISSION_CONTROL_DESIRED_FIELDS] };
        return { cliVersionLabel: "head", unsupportedFields: [] };
      },
    });
    const fleet = await cli.rollupFleet();
    const alpha = fleet.rows.find((r) => r.rigName === "rig-alpha");
    const beta = fleet.rows.find((r) => r.rigName === "rig-beta");
    expect(alpha?.cliVersionLabel).toBe("v0.1.12");
    expect(beta?.cliVersionLabel).toBe("head");
  });

  it("带 active in-progress queue item 的 rig 汇总 activityState=active", async () => {
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-1', '2026-05-04T01:00:00Z', '2026-05-04T01:00:00Z', 'a@rig-alpha', 'b@rig-alpha', 'in-progress', 'routine', 'x')`,
    ).run();
    const cli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    const fleet = await cli.rollupFleet();
    const alpha = fleet.rows.find((r) => r.rigName === "rig-alpha");
    expect(alpha?.activityState).toBe("active");
  });

  it("带 blocked queue item 的 rig 汇总 activityState=blocked + attentionReason", async () => {
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, blocked_on)
       VALUES ('q-1', '2026-05-04T01:00:00Z', '2026-05-04T01:00:00Z', 'a@rig-alpha', 'b@rig-alpha', 'blocked', 'routine', 'x', 'gate-x')`,
    ).run();
    const cli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    const fleet = await cli.rollupFleet();
    const alpha = fleet.rows.find((r) => r.rigName === "rig-alpha");
    expect(alpha?.activityState).toBe("blocked");
    expect(alpha?.attentionReason).toContain("gate-x");
  });

  // R1 修复，依 PL-005 Phase A guard review（2026-05-04）。生产 probe
  //（makeLocalCliCapabilityProbe + LOCAL_CLI_NODE_FIELDS_AT_0_2_0）诚实上报 drift，
  // 无需 fake probeRig 注入。这是 production-wired 路径：startup.ts 用同一工厂构造
  // daemon 级 fleet capability service。
  it("R1 production-wired probe（makeLocalCliCapabilityProbe）：recoveryGuidance 不在 CLI allow-list → 每个 rig 上报 drift", async () => {
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: makeLocalCliCapabilityProbe(),
    });
    const fleet = await cli.rollupFleet();
    expect(fleet.staleCliCount).toBe(2);
    expect(fleet.degradedFields).toContain("recoveryGuidance");
    expect(fleet.degradedFields).not.toContain("agentActivity");
    for (const row of fleet.rows) {
      expect(row.cliDriftDetected).toBe(true);
      expect(row.cliVersionLabel).toBe(LOCAL_CLI_VERSION_LABEL);
    }
  });

  it("R1：agentActivity 在 LOCAL_CLI_NODE_FIELDS_AT_0_2_0 中（audit 行 5 ground truth）", () => {
    expect(LOCAL_CLI_NODE_FIELDS_AT_0_2_0.has("agentActivity")).toBe(true);
    expect(LOCAL_CLI_NODE_FIELDS_AT_0_2_0.has("recoveryGuidance")).toBe(false);
  });

  it("R1 production probe：扩展（假想未来）CLI allow-list 含 recoveryGuidance 时上报零 drift", async () => {
    const futureFields = new Set([
      ...LOCAL_CLI_NODE_FIELDS_AT_0_2_0,
      "recoveryGuidance",
    ]);
    const cli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo,
      probeRig: makeLocalCliCapabilityProbe({
        versionLabel: "0.3.0",
        knownNodeFields: futureFields,
      }),
    });
    const fleet = await cli.rollupFleet();
    expect(fleet.staleCliCount).toBe(0);
    expect(fleet.degradedFields).toEqual([]);
  });
});
