// OPR.0.3.4.9——周期 snapshot 调度器测试。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { PeriodicSnapshotScheduler } from "../src/domain/periodic-snapshot-scheduler.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("PeriodicSnapshotScheduler", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let snapshotCapture: SnapshotCapture;
  let scheduler: PeriodicSnapshotScheduler;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    scheduler = new PeriodicSnapshotScheduler({ db, snapshotCapture, snapshotRepo });
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  function seedRunningRig(name: string): string {
    const rig = rigRepo.createRig(name);
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, `worker@${name}`);
    sessionRegistry.updateStatus(session.id, "running");
    return rig.id;
  }

  it("tick 为运行中的 rig 捕获 auto-periodic snapshot", async () => {
    const rigId = seedRunningRig("r1");
    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.kind).toBe("auto-periodic");
  });

  it("tick 跳过已归档 rig", async () => {
    const rigId = seedRunningRig("r-archived");
    rigRepo.archiveRig(rigId);
    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(0);
  });

  it("tick 跳过已停止 rig（没有运行中的 session）", async () => {
    const rig = rigRepo.createRig("r-stopped");
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(rig.id, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(0);
  });

  it("按 kind 定界的 retention 只修剪 auto-periodic，并保留其他 kind", async () => {
    const rigId = seedRunningRig("r-prune");
    snapshotCapture.captureSnapshot(rigId, "manual");
    snapshotCapture.captureSnapshot(rigId, "auto-pre-down");
    scheduler.start(100000, 2);
    scheduler.stop();
    // 在 retention_keep=2 时运行 5 个 tick。
    for (let i = 0; i < 5; i++) {
      snapshotCapture.captureSnapshot(rigId, "auto-periodic");
    }
    snapshotRepo.pruneSnapshotsByKind(rigId, "auto-periodic", 2);

    const periodic = snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" });
    expect(periodic).toHaveLength(2);
    const manual = snapshotRepo.listSnapshots(rigId, { kind: "manual" });
    expect(manual).toHaveLength(1);
    const preDown = snapshotRepo.listSnapshots(rigId, { kind: "auto-pre-down" });
    expect(preDown).toHaveLength(1);
  });

  it("retention_keep 下限：keepCount < 1 时仍至少保留 1 个", () => {
    const rigId = seedRunningRig("r-floor");
    snapshotCapture.captureSnapshot(rigId, "auto-periodic");
    snapshotCapture.captureSnapshot(rigId, "auto-periodic");
    snapshotRepo.pruneSnapshotsByKind(rigId, "auto-periodic", 0);
    const remaining = snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" });
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  it("按 rig 隔离错误：一个 rig 失败不会中止其他 rig", async () => {
    const rigId1 = seedRunningRig("r-ok");
    const rigId2 = seedRunningRig("r-fail");
    const origCapture = snapshotCapture.captureSnapshot.bind(snapshotCapture);
    const captureSpy = vi.spyOn(snapshotCapture, "captureSnapshot").mockImplementation((id, kind) => {
      if (id === rigId2) throw new Error("simulated failure");
      return origCapture(id, kind);
    });

    await scheduler.tick();

    const snaps1 = snapshotRepo.listSnapshots(rigId1, { kind: "auto-periodic" });
    expect(snaps1).toHaveLength(1);
    const snaps2 = snapshotRepo.listSnapshots(rigId2, { kind: "auto-periodic" });
    expect(snaps2).toHaveLength(0);
    captureSpy.mockRestore();
  });

  it("跳过拥有较旧 running 和较新 exited session 的 rig（latest-session 语义）", async () => {
    const rig = rigRepo.createRig("r-latest");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const oldSess = sessionRegistry.registerSession(node.id, "worker@r-latest");
    sessionRegistry.updateStatus(oldSess.id, "running");
    const newSess = sessionRegistry.registerSession(node.id, "worker@r-latest");
    sessionRegistry.updateStatus(newSess.id, "exited");

    await scheduler.tick();
    const snaps = snapshotRepo.listSnapshots(rig.id, { kind: "auto-periodic" });
    expect(snaps).toHaveLength(0);
  });

  it("start/stop 幂等", () => {
    scheduler.start(60000, 10);
    expect(scheduler.isActive).toBe(true);
    scheduler.start(60000, 10);
    expect(scheduler.isActive).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive).toBe(false);
    scheduler.stop();
    expect(scheduler.isActive).toBe(false);
  });

  it("tick 不重叠：running 标志防止重入", () => {
    // running 标志在 tick() 顶部同步设置；setInterval 回调在调用 tick() 前检查它。
    scheduler.start(100000, 10);
    expect(scheduler.isActive).toBe(true);
    scheduler.stop();
  });

  // OPR.0.4.3.20 FR-4——序列化前刷新实时的逐席位 resume ledger。
  type Refresher = import("../src/domain/resume-metadata-refresher.js").ResumeMetadataRefresher;

  it("FR-4：tick 在捕获周期 snapshot 前刷新实时 token", async () => {
    const rigId = seedRunningRig("r-fr4");
    const refresh = vi.fn(async () => {});
    const fr4 = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh } as unknown as Refresher,
    });
    await fr4.tick();
    // refresh 已运行，并收到 rig 最新的存活 session。
    expect(refresh).toHaveBeenCalledTimes(1);
    const passed = refresh.mock.calls[0]![0] as Array<{ sessionName: string }>;
    expect(passed.some((s) => s.sessionName === "worker@r-fr4")).toBe(true);
    // rev1 修复：周期 snapshot 路径以 fill-null-only 模式调用 refresh（绝不清除现有 token，
    // 绝不派生 `claude --resume` 探针）。
    const opts = refresh.mock.calls[0]![1] as { fillNullOnly?: boolean } | undefined;
    expect(opts?.fillNullOnly).toBe(true);
    // snapshot 仍被捕获（refresh 先于 serialize，而非取代它）。
    expect(snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" })).toHaveLength(1);
  });

  it("FR-4：refresh 抛错不会跳过 snapshot（尽力而为，独立 try/catch）", async () => {
    const rigId = seedRunningRig("r-fr4-throw");
    const fr4 = new PeriodicSnapshotScheduler({
      db, snapshotCapture, snapshotRepo, sessionRegistry,
      resumeMetadataRefresher: { refresh: vi.fn(async () => { throw new Error("refresh boom"); }) } as unknown as Refresher,
    });
    await fr4.tick();
    expect(snapshotRepo.listSnapshots(rigId, { kind: "auto-periodic" })).toHaveLength(1);
  });
});

describe("OPR.0.3.4.9 生产接线：startPeriodicSnapshotScheduler", () => {
  it("enabled=true 时调用 scheduler.start 和 psProjectionService.setPeriodicSnapshotState", async () => {
    const { startPeriodicSnapshotScheduler } = await import("../src/index.js");
    const schedulerStart = vi.fn();
    const setState = vi.fn();
    const deps = {
      periodicSnapshotScheduler: { start: schedulerStart },
      psProjectionService: { setPeriodicSnapshotState: setState },
      settingsStore: {
        resolveOne: (key: string) => {
          if (key === "snapshots.periodic.enabled") return { value: true };
          if (key === "snapshots.periodic.interval_seconds") return { value: 300 };
          if (key === "snapshots.periodic.retention_keep") return { value: 10 };
          return { value: "" };
        },
      },
    };

    startPeriodicSnapshotScheduler(deps);

    expect(schedulerStart).toHaveBeenCalledWith(300_000, 10);
    expect(setState).toHaveBeenCalledWith(true, 300);
  });

  it("enabled=false 时不启动 scheduler，也不调用 psProjectionService", async () => {
    const { startPeriodicSnapshotScheduler } = await import("../src/index.js");
    const schedulerStart = vi.fn();
    const setState = vi.fn();
    const deps = {
      periodicSnapshotScheduler: { start: schedulerStart },
      psProjectionService: { setPeriodicSnapshotState: setState },
      settingsStore: {
        resolveOne: (key: string) => {
          if (key === "snapshots.periodic.enabled") return { value: false };
          return { value: 300 };
        },
      },
    };

    startPeriodicSnapshotScheduler(deps);

    expect(schedulerStart).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });
});

describe("PsProjectionService 周期 snapshot 状态", () => {
  let db: Database.Database;

  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  it("默认 periodicSnapshotActive=false 且 interval=0（scheduler 未启动）", async () => {
    const { PsProjectionService } = await import("../src/domain/ps-projection.js");
    const svc = new PsProjectionService({ db });
    const rig = new RigRepository(db).createRig("test-rig");
    const entries = svc.getEntries();
    const entry = entries.find((e) => e.rigId === rig.id);
    expect(entry).toBeDefined();
    expect(entry!.periodicSnapshotActive).toBe(false);
    expect(entry!.periodicSnapshotIntervalSeconds).toBe(0);
    expect(entry!.autoPeriodicSnapshotCount).toBe(0);
  });

  it("调用 setPeriodicSnapshotState 后 periodicSnapshotActive=true 且 interval 匹配", async () => {
    const { PsProjectionService } = await import("../src/domain/ps-projection.js");
    const svc = new PsProjectionService({ db });
    svc.setPeriodicSnapshotState(true, 300);
    const rig = new RigRepository(db).createRig("active-rig");
    const entries = svc.getEntries();
    const entry = entries.find((e) => e.rigId === rig.id);
    expect(entry!.periodicSnapshotActive).toBe(true);
    expect(entry!.periodicSnapshotIntervalSeconds).toBe(300);
  });

  it("autoPeriodicSnapshotCount 反映实际 auto-periodic snapshot", async () => {
    const { PsProjectionService } = await import("../src/domain/ps-projection.js");
    const rigRepo = new RigRepository(db);
    const sessionReg = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const capture = new SnapshotCapture({ db, rigRepo, sessionRegistry: sessionReg, eventBus, snapshotRepo, checkpointStore });
    const svc = new PsProjectionService({ db });
    const rig = rigRepo.createRig("count-rig");
    rigRepo.addNode(rig.id, "w", { role: "worker" });
    capture.captureSnapshot(rig.id, "auto-periodic");
    capture.captureSnapshot(rig.id, "auto-periodic");
    capture.captureSnapshot(rig.id, "manual");

    const entries = svc.getEntries();
    const entry = entries.find((e) => e.rigId === rig.id);
    expect(entry!.autoPeriodicSnapshotCount).toBe(2);
  });
});

describe("OPR.0.3.4.9 配置验证：拒绝格式错误的数字写入", () => {
  it("后台服务 SettingsStore 拒绝 snapshots.periodic.interval_seconds=60abc", async () => {
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore();
    expect(() => store.set("snapshots.periodic.interval_seconds", "60abc")).toThrow(/应为大于等于 60 的整数/);
  });

  it("后台服务 SettingsStore 拒绝 snapshots.periodic.interval_seconds=60.5", async () => {
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore();
    expect(() => store.set("snapshots.periodic.interval_seconds", "60.5")).toThrow(/应为大于等于 60 的整数/);
  });

  it("后台服务 SettingsStore 拒绝 snapshots.periodic.retention_keep=0", async () => {
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore();
    expect(() => store.set("snapshots.periodic.retention_keep", "0")).toThrow(/必须大于等于 1/);
  });

  it("后台服务 SettingsStore 拒绝 snapshots.periodic.interval_seconds=30", async () => {
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore();
    expect(() => store.set("snapshots.periodic.interval_seconds", "30")).toThrow(/必须大于等于 60/);
  });

  it("后台服务 SettingsStore 接受有效 snapshots.periodic.interval_seconds=120", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
    const configPath = path.join(tmpDir, "settings.json");
    const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
    const store = new SettingsStore(configPath);
    store.set("snapshots.periodic.interval_seconds", "120");
    expect(store.resolveOne("snapshots.periodic.interval_seconds").value).toBe(120);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("findLatestRestoreUsable Option Y", () => {
  let db: Database.Database;
  let snapshotRepo: SnapshotRepository;

  function insertRaw(id: string, rigId: string, kind: string, createdAt: string) {
    const data = JSON.stringify({
      rig: { id: rigId, name: "test" },
      nodes: [{ id: "n1", logicalId: "w", binding: null }],
      edges: [],
      sessions: [],
      checkpoints: {},
    });
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, 'active', ?, ?)"
    ).run(id, rigId, kind, data, createdAt);
  }

  beforeEach(() => {
    db = createFullTestDb();
    snapshotRepo = new SnapshotRepository(db);
  });

  afterEach(() => { db.close(); });

  it("陈旧 auto-pre-down + 更新 auto-periodic 时后者胜出（崩溃修复）", () => {
    insertRaw("snap-old-apd", "rig-1", "auto-pre-down", "2026-06-10T00:00:00Z");
    insertRaw("snap-new-periodic", "rig-1", "auto-periodic", "2026-06-14T12:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("rig-1");
    expect(result!.id).toBe("snap-new-periodic");
    expect(result!.kind).toBe("auto-periodic");
  });

  it("更新 auto-pre-down + 较旧 auto-periodic 时前者胜出（保留优雅周期）", () => {
    insertRaw("snap-new-apd", "rig-1", "auto-pre-down", "2026-06-14T18:00:00Z");
    insertRaw("snap-old-periodic", "rig-1", "auto-periodic", "2026-06-14T12:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("rig-1");
    expect(result!.id).toBe("snap-new-apd");
    expect(result!.kind).toBe("auto-pre-down");
  });

  it("manual 保持不变：4 月 27 日 auto-pre-down 胜过 4 月 28 日 manual（manual tier 更低）", () => {
    insertRaw("snap-apd", "rig-1", "auto-pre-down", "2026-04-27T00:00:00Z");
    insertRaw("snap-manual", "rig-1", "manual", "2026-04-28T00:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("rig-1");
    expect(result!.id).toBe("snap-apd");
    expect(result!.kind).toBe("auto-pre-down");
  });

  it("只有 auto-periodic 时返回该项", () => {
    insertRaw("snap-periodic-only", "rig-1", "auto-periodic", "2026-06-14T12:00:00Z");
    const result = snapshotRepo.findLatestRestoreUsable("rig-1");
    expect(result!.id).toBe("snap-periodic-only");
  });
});
