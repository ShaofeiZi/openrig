import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { startupContextSchema } from "../src/db/migrations/015_startup_context.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { snapshotMatchesCurrentOccupants } from "../src/domain/rehydrate-eligibility.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../src/domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";
import { deriveRehydrateOccupantsByNode } from "../src/domain/active-occupant.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

describe("SnapshotCapture", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let capture: SnapshotCapture;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    capture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  function seedRig() {
    const rig = rigRepo.createRig("r01");
    const n1 = rigRepo.addNode(rig.id, "orchestrator", { role: "orchestrator", runtime: "claude-code" });
    const n2 = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "codex" });
    rigRepo.addEdge(rig.id, n1.id, n2.id, "delegates_to");
    sessionRegistry.updateBinding(n1.id, { tmuxSession: "r99-demo1-lead", cmuxSurface: "s-1" });
    return { rig, n1, n2 };
  }

  it("不会把悬空的当前效果折叠为从未被占用的 seat", () => {
    expect(deriveRehydrateOccupantsByNode([], ["n1"], { n1: "missing-session" }).n1).toEqual({ kind: "ambiguous", candidateIds: [] });
  });

  it("在重启捕获、实时预览和快照匹配中一致使用当前 fresh 效果", () => {
    const { rig, n1 } = seedRig();
    const old = sessionRegistry.registerSession(n1.id, "r99-demo1-lead");
    const successor = sessionRegistry.registerSession(n1.id, "r99-demo1-lead", "fresh");
    sessionRegistry.markDetached(old.id);
    sessionRegistry.markDetached(successor.id);
    sessionRegistry.updateResumeToken(successor.id, "claude_id", "native-successor", "hook");
    const generation = sessionRegistry.currentOccupantTenure(n1.id)!.generationUuid;
    const event = { nodeId: n1.id, sessionId: successor.id, newGeneration: generation };
    db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify(event));
    const current = rigRepo.getRig(rig.id)!;
    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
    expect(snapshot.data.activeOccupantsByNode?.[n1.id]).toEqual({ kind: "resolved", sessionId: successor.id });
    expect(snapshotMatchesCurrentOccupants(db, current, snapshot)).toBe(true);
    const preview = buildRestorePlanPreview(current, null, collectPreviewSessionRows(db, current, null), undefined, Date.now(), readFreshOccupantRelations(db, rig.id));
    expect(preview.nodes.find((node) => node.logicalId === n1.logicalId)).toMatchObject({ occupantSessionId: successor.id, intendedAction: "resume-original" });
    // 同一 generation 下存在冲突效果时，不能选择任一历史记录。
    db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify({ ...event, sessionId: old.id }));
    expect(snapshotMatchesCurrentOccupants(db, current, snapshot)).toBe(false);
    expect(capture.captureSnapshot(rig.id, "auto-rehydrate").data.activeOccupantsByNode?.[n1.id]?.kind).toBe("ambiguous");
  });

  it("组装正确的 SnapshotData（rig + nodes + edges + bindings）", () => {
    const { rig, n1 } = seedRig();

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.rig.name).toBe("r01");
    expect(snap.data.nodes).toHaveLength(2);
    expect(snap.data.edges).toHaveLength(1);
    expect(snap.data.edges[0]!.kind).toBe("delegates_to");
    // n1 有 binding
    const orchNode = snap.data.nodes.find((n) => n.logicalId === "orchestrator");
    expect(orchNode!.binding).not.toBeNull();
    expect(orchNode!.binding!.tmuxSession).toBe("r99-demo1-lead");
  });

  it("包含带恢复元数据的会话", () => {
    const { rig, n1 } = seedRig();
    const session = sessionRegistry.registerSession(n1.id, "r99-demo1-lead");
    db.prepare(
      "UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?"
    ).run("claude_name", "my-token", "resume_if_possible", session.id);

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.sessions).toHaveLength(1);
    expect(snap.data.sessions[0]!.resumeType).toBe("claude_name");
    expect(snap.data.sessions[0]!.resumeToken).toBe("my-token");
    expect(snap.data.sessions[0]!.restorePolicy).toBe("resume_if_possible");
  });

  it("持久化带版本的预期花名册和显式三态 occupant 事实", () => {
    const { rig, n1, n2 } = seedRig();
    const resolved = sessionRegistry.registerSession(n1.id, "r99-demo1-lead");
    sessionRegistry.updateStatus(resolved.id, "running");
    const ambiguousA = sessionRegistry.registerSession(n2.id, "r99-worker-a");
    const ambiguousB = sessionRegistry.registerSession(n2.id, "r99-worker-b");
    sessionRegistry.updateStatus(ambiguousA.id, "running");
    sessionRegistry.updateStatus(ambiguousB.id, "running");

    const snap = capture.captureSnapshot(rig.id, "manual", { intendedNodeIds: [n1.id, n2.id] });

    expect(snap.data.topologyRoster).toEqual({
      version: 1,
      source: "operator_explicit",
      intendedNodeIds: [n1.id, n2.id],
    });
    expect(snap.data.activeOccupantsByNode?.[n1.id]).toEqual({ kind: "resolved", sessionId: resolved.id });
    expect(snap.data.activeOccupantsByNode?.[n2.id]).toEqual({
      kind: "ambiguous",
      candidateIds: [ambiguousA.id, ambiguousB.id],
    });
  });

  it("使用最新的持久化实体拓扑花名册，而非全部历史节点", () => {
    const { rig, n1, n2 } = seedRig();
    eventBus.emit({
      type: "topology.roster_recorded",
      rigId: rig.id,
      intendedNodeIds: [n1.id],
      source: "materialized_topology",
    });

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.nodes.map((node) => node.id)).toContain(n2.id);
    expect(snap.data.topologyRoster).toEqual({
      version: 1,
      source: "materialized_topology",
      intendedNodeIds: [n1.id],
    });
  });

  it("最新权威花名册事件格式错误时拒绝捕获快照", () => {
    const { rig } = seedRig();
    db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)")
      .run(rig.id, "topology.roster_recorded", JSON.stringify({ intendedNodeIds: "not-an-array" }));

    expect(() => capture.captureSnapshot(rig.id, "manual")).toThrow(/格式错误的权威拓扑名册/);
    expect(snapshotRepo.listSnapshots(rig.id)).toHaveLength(0);
  });

  it("以映射形式包含 checkpoint（每个节点取最新项）", () => {
    const { rig, n1 } = seedRig();
    checkpointStore.createCheckpoint(n1.id, { summary: "旧 checkpoint", keyArtifacts: [] });
    checkpointStore.createCheckpoint(n1.id, { summary: "最新 checkpoint", keyArtifacts: ["file.ts"] });

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.checkpoints[n1.id]).not.toBeNull();
    expect(snap.data.checkpoints[n1.id]!.summary).toBe("最新 checkpoint");
  });

  it("没有 checkpoint 的节点在 checkpoints 映射中对应 null", () => {
    const { rig, n1, n2 } = seedRig();
    checkpointStore.createCheckpoint(n1.id, { summary: "有 checkpoint", keyArtifacts: [] });
    // n2 没有 checkpoint

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.checkpoints[n1.id]).not.toBeNull();
    expect(snap.data.checkpoints[n2.id]).toBeNull();
  });

  it("通过 SnapshotRepository 持久化（可按 id 获取）", () => {
    const { rig } = seedRig();

    const snap = capture.captureSnapshot(rig.id, "manual");

    const fetched = snapshotRepo.getSnapshot(snap.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(snap.id);
    expect(fetched!.data.rig.name).toBe("r01");
  });

  it("以精确载荷发出 snapshot.created（持久化 + 订阅者）", () => {
    const { rig } = seedRig();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const snap = capture.captureSnapshot(rig.id, "manual");

    // 订阅者收到事件
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("snapshot.created");
    if (notifications[0]!.type === "snapshot.created") {
      expect(notifications[0]!.rigId).toBe(rig.id);
      expect(notifications[0]!.snapshotId).toBe(snap.id);
      expect(notifications[0]!.kind).toBe("manual");
    }

    // 事件持久化到数据库
    const events = db
      .prepare("SELECT type, payload FROM events WHERE type = 'snapshot.created'")
      .all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
    expect(payload.snapshotId).toBe(snap.id);
    expect(payload.kind).toBe("manual");
  });

  it("空 rig（无节点）→ 包含空集合的有效快照", () => {
    const rig = rigRepo.createRig("r02");

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.rig.name).toBe("r02");
    expect(snap.data.nodes).toEqual([]);
    expect(snap.data.edges).toEqual([]);
    expect(snap.data.sessions).toEqual([]);
    expect(snap.data.checkpoints).toEqual({});
  });

  it("rig 不存在时明确抛出 RigNotFoundError", async () => {
    const { RigNotFoundError } = await import("../src/domain/errors.js");
    let caught: unknown;
    try {
      capture.captureSnapshot("nonexistent", "manual");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RigNotFoundError);
  });

  it("数据库句柄不匹配时构造函数抛错", () => {
    const otherDb = setupDb();
    const otherRepo = new RigRepository(otherDb);

    expect(() =>
      new SnapshotCapture({
        db,
        rigRepo: otherRepo,
        sessionRegistry,
        eventBus,
        snapshotRepo,
        checkpointStore,
      })
    ).toThrow(/同一个数据库句柄/);

    otherDb.close();
  });

  it("原子性：破坏 event 插入后不残留快照行（回滚）", () => {
    const { rig } = seedRig();

    // 破坏 events 表，使 persistWithinTransaction 失败
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    expect(() => capture.captureSnapshot(rig.id, "manual")).toThrow();

    // 不应存在快照行（已回滚）
    const snaps = db.prepare("SELECT * FROM snapshots").all();
    expect(snaps).toHaveLength(0);

    // 也不应存在 event 行
    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });
});
