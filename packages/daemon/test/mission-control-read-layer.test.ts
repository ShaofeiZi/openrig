import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { MissionControlFleetCliCapability } from "../src/domain/mission-control/mission-control-fleet-cli-capability.js";
import {
  MissionControlReadLayer,
  MISSION_CONTROL_VIEWS,
  type CompactStatusRow,
} from "../src/domain/mission-control/mission-control-read-layer.js";

describe("MissionControlReadLayer（PL-005 阶段 A；7 个视图）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let viewProjector: ViewProjector;
  let streamStore: StreamStore;
  let readLayer: MissionControlReadLayer;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema, viewsCustomSchema, rigArchiveSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    viewProjector = new ViewProjector(db, bus);
    streamStore = new StreamStore(db, bus);
    const rigRepo = new RigRepository(db);
    const fleetCli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    readLayer = new MissionControlReadLayer({
      db,
      queueRepo,
      viewProjector,
      streamStore,
      fleetCliCapability: fleetCli,
      // V0.3.1 切片 05 kernel-rig-as-default——ReadLayer 的 defaultOperatorSession
      // 现在从解析后的 workspace.operator_seat_name 设置注入（不再使用硬编码常量）。
      // 现有 fixture 使用 "human-operator@kernel" 作为 destinationSession；此处保留该值，
      // 使 fixture 数据与 my-queue 路由一致。生产环境 startup.ts 注入 SettingsStore 解析值。
      defaultOperatorSession: "human-operator@kernel",
    });
  });

  afterEach(() => db.close());

  it("readView 为全部 7 个视图返回结果（不抛错且结构有效）", async () => {
    for (const viewName of MISSION_CONTROL_VIEWS) {
      const result = await readLayer.readView(viewName);
      expect(result.viewName).toBe(viewName);
      expect(Array.isArray(result.rows)).toBe(true);
      expect(typeof result.meta.rowCount).toBe("number");
    }
  });

  it("九字段内容模型：每个视图的每一行都公开全部 9 个字段", async () => {
    // 植入多样内容，使每个视图至少有一行。
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      body: "需要人工批准",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人员路由 fixture）",
      evidenceRef: "proof/test-evidence.md",
    });
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "agent@rig",
      body: "agent 任务",
      priority: "high",
    });
    streamStore.emit({
      streamItemId: "stream-1",
      sourceSession: "discovery@rig",
      body: "观察记录",
    });

    const fields: Array<keyof CompactStatusRow> = [
      "rigOrMissionName",
      "currentPhase",
      "state",
      "nextAction",
      "pendingHumanDecision",
      "readCost",
      "lastUpdate",
      "confidenceFreshness",
      "evidenceLink",
    ];

    for (const viewName of MISSION_CONTROL_VIEWS) {
      const result = await readLayer.readView(viewName);
      for (const row of result.rows) {
        for (const field of fields) {
          expect(field in row).toBe(true);
        }
      }
    }
  });

  it("my-queue 仅筛选操作者的 human-gate 条目", async () => {
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      body: "交给操作者",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人员路由 fixture）",
      evidenceRef: "proof/test-evidence.md",
    });
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "agent@rig",
      body: "非 human-gate",
    });
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      summary: "测试摘要（FR-4 人员路由 fixture）",
      evidenceRef: "proof/test-evidence.md",
      body: "来自操作者的非 human-gate 条目",
    });
    const result = await readLayer.readView("my-queue");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rigOrMissionName).toBe("human-operator@kernel");
  });

  it("由 qitem 支持的行会保留手机端 human-gate 决策的队列正文", async () => {
    await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "human-operator@kernel",
      body: "检查手机通知路径后批准发布候选项。",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人员路由 fixture）",
      evidenceRef: "proof/test-evidence.md",
    });

    const result = await readLayer.readView("my-queue");
    const row = result.rows[0] as Record<string, unknown>;
    expect(row.qitemBody).toBe("检查手机通知路径后批准发布候选项。");
    expect(row.qitemSummary).toContain("批准发布候选项");
  });

  it("recent-ships 最多返回 10 条", async () => {
    for (let i = 0; i < 15; i++) {
      const created = await queueRepo.create({
        sourceSession: "src@rig",
        destinationSession: "agent@rig",
        body: `交付 ${i}`,
      });
      queueRepo.update({
        qitemId: created.qitemId,
        actorSession: "agent@rig",
        state: "done",
        closureReason: "no-follow-on",
      });
    }
    const result = await readLayer.readView("recent-ships");
    expect(result.rows).toHaveLength(10);
  });

  it("active-work 优先按优先级排序（critical > high > routine > background）", async () => {
    await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x", priority: "routine" });
    await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x", priority: "critical" });
    await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x", priority: "high" });
    const result = await readLayer.readView("active-work");
    expect(result.rows[0]?.confidenceFreshness).toBe("critical");
    expect(result.rows[1]?.confidenceFreshness).toBe("high");
    expect(result.rows[2]?.confidenceFreshness).toBe("routine");
  });

  it("recent-observations 从 stream_items 读取（PL-004 阶段 A 的 daemon 支持数据源）", async () => {
    streamStore.emit({
      streamItemId: "stream-1",
      sourceSession: "discovery@rig",
      body: "观察记录 1",
      hintType: "feature-request",
    });
    streamStore.emit({
      streamItemId: "stream-2",
      sourceSession: "discovery@rig",
      body: "观察记录 2",
    });
    const result = await readLayer.readView("recent-observations");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.rigOrMissionName).toBe("discovery@rig");
  });

  it("fleet 视图返回行及漂移指示器元数据", async () => {
    const result = await readLayer.readView("fleet");
    expect(result.viewName).toBe("fleet");
    expect(typeof result.meta.rowCount).toBe("number");
    // staleCliCount 存在（使用默认空操作探针时可能为 0）。
    expect(typeof result.meta.rigsRunningStaleCli).toBe("number");
  });
});
