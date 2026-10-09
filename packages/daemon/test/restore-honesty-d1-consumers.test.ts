// OPR.0.5.7.1——D1 消费者对齐（R2 HOLD 修复；针对 qitem-20260829091346-bfdaaca8
// 的范围裁定）。执行逻辑从 SnapshotData.activeSessionIdByNode 解析活跃 occupant；这些测试
// 将同一 occupant 事实固定到仍会独立选择历史行的三个报告消费者：恢复计划预览
//（最大 ULID reduce）、快照可用性（任意历史 token）和生命周期可恢复性（首行 find）。
//
// 裁定的关系损坏词汇：intendedAction 为 "awaiting-decision"、freshRequired 为 false
//（--fresh 无法覆盖 A1 歧义）、原因明确指出关系失败；token 事实源自“没有解析出的 occupant”，
// 绝不来自历史行。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { findLatestUsableSnapshot } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../src/domain/restore-plan-preview.js";
import { deriveNodeLifecycleState } from "../src/domain/node-inventory.js";
import type { Snapshot, SnapshotData, Session } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

// 字典序会造成陷阱的 ULID：OLD 排在 NEW 之前，因此已退役的“latest = max id”选择会选中 NEW。
const ULID_OLD = "01ARZ3NDEKTSV4RRFFQ69G5AAA";
const ULID_NEW = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";
const ULID_GONE = "01ARZ3NDEKTSV4RRFFQ69G5XXX";

type FixtureRow = { id: string; status: string; token: string | null; type?: string | null };

function sessionRow(nodeId: string, r: FixtureRow): Session {
  return {
    id: r.id,
    nodeId,
    sessionName: "r77-seat",
    status: r.status,
    resumeType: r.type === undefined ? "claude_name" : r.type,
    resumeToken: r.token,
    restorePolicy: "resume_if_possible",
    lastSeenAt: null,
    createdAt: "2026-08-29 00:00:00",
    origin: "launched",
    startupStatus: "ready",
    startupCompletedAt: null,
  } as Session;
}

type RelationMode =
  | { mode: "field-absent" }
  | { mode: "explicit-null" }
  | { mode: "missing-node-key" }
  | { mode: "explicit-id"; id: string }
  | { mode: "dangling-id"; id: string };

function snapshotData(rigId: string, nodeId: string, rows: FixtureRow[], relation: RelationMode, rig: { rig: unknown; nodes: unknown[]; edges: unknown[] }): SnapshotData {
  const data: SnapshotData = {
    rig: rig.rig as SnapshotData["rig"],
    nodes: rig.nodes as SnapshotData["nodes"],
    edges: rig.edges as SnapshotData["edges"],
    sessions: rows.map((r) => sessionRow(nodeId, r)),
    checkpoints: {},
  };
  switch (relation.mode) {
    case "field-absent":
      break;
    case "explicit-null":
      data.activeSessionIdByNode = { [nodeId]: null };
      break;
    case "missing-node-key":
      data.activeSessionIdByNode = { "some-other-node": null };
      break;
    case "explicit-id":
    case "dangling-id":
      data.activeSessionIdByNode = { [nodeId]: relation.id };
      break;
  }
  return data;
}

describe("OPR.0.5.7.1——D1 消费者对齐（预览 / 可用性 / 生命周期）", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotCapture: SnapshotCapture;
  let snapshotRepo: SnapshotRepository;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  function seedRig() {
    const rig = rigRepo.createRig("r77");
    const node = rigRepo.addNode(rig.id, "seat", { role: "worker", runtime: "claude-code" });
    const rigW = rigRepo.getRig(rig.id)!;
    return { rigId: rig.id, nodeId: node.id, rigW };
  }

  function makeSnapshot(rigId: string, data: SnapshotData): Snapshot {
    return { id: "snap-test-1", rigId, kind: "manual", status: "ok", data, createdAt: "2026-08-29 00:00:00" };
  }

  function previewNode(rigW: ReturnType<RigRepository["getRig"]> & object, snapshot: Snapshot | null, freshLogicalIds?: string[]) {
    const rows = collectPreviewSessionRows(db, rigW as never, snapshot);
    const plan = buildRestorePlanPreview(rigW as never, snapshot, rows, freshLogicalIds);
    const node = plan.nodes.find((n) => n.logicalId === "seat");
    expect(node).toBeDefined();
    return node!;
  }

  // ------------------------------------------------------------ 预览 ---

  it("R-A：显式关系选择较旧的 ACTIVE 行，而非较新、已替代且无 token 的行——操作与 token 状态（事故顺序：新行在前）", () => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_NEW, status: "superseded", token: null },      // 更新，位于数组首项
      { id: ULID_OLD, status: "running", token: "tok-active" }, // occupant
    ], { mode: "explicit-id", id: ULID_OLD }, rigW as never);
    const node = previewNode(rigW, makeSnapshot(rigId, data));
    // 基线：最大 ULID reduce 选中较新且无 token 的行 → awaiting-decision + missing
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified"); // occupant 的 token 事实，绝不取自历史行
    expect(node.freshRequired).toBe(false);
  });

  it.each([
    ["explicit-null", { mode: "explicit-null" } as RelationMode],
    ["missing-node-key", { mode: "missing-node-key" } as RelationMode],
    ["dangling-id", { mode: "dangling-id", id: ULID_GONE } as RelationMode],
  ])("R-B（%s）：损坏的权威关系渲染 awaiting-decision、freshRequired=false，原因点明关系问题——且 --fresh 无法覆盖", (_label, relation) => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-live" },
    ], relation, rigW as never);
    for (const fresh of [undefined, ["seat"]]) {
      const node = previewNode(rigW, makeSnapshot(rigId, data), fresh);
      // 基线：无 --fresh 时 reduce 恢复历史行；有 --fresh 时短路到 fresh-primed。两者都是缺陷。
      expect(node.intendedAction).toBe("awaiting-decision");
      expect(node.freshRequired).toBe(false);
      expect(node.reason ?? "").toMatch(/关系|占用者/i);
      // token 事实源自“没有解析出的 occupant”——绝不取自历史行
      expect(node.tokenState).toBe("missing");
    }
  });

  // ---------------------------------------------------------- 生命周期 ---

  it("R-C：即使显式关联的 ACTIVE 行不是会话数组首项，生命周期可恢复性也跟随该行", () => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_NEW, status: "superseded", token: null }, // 首行，无 token
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD }, rigW as never);
    const state = deriveNodeLifecycleState({
      sessionStatus: "exited",
      restoreOutcome: "n-a",
      nodeId,
      usableSnapshot: makeSnapshot(rigId, data),
    });
    // 基线：首行 .find 看不到 token → detached
    expect(state).toBe("recoverable");
  });

  // ---------------------------------------------------------- 可用性 ---

  it("R-D：present-null 即使有历史 token 也不可用且不可恢复", () => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_OLD, status: "exited", token: "tok-historical" },
    ], { mode: "explicit-null" }, rigW as never);
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
      .run("snap-null-1", rigId, "manual", "ok", JSON.stringify(data));
    // 基线：any-historical-token 谓词会把此快照视为可用
    expect(findLatestUsableSnapshot(db, rigId)).toBeNull();
    const state = deriveNodeLifecycleState({
      sessionStatus: "exited",
      restoreOutcome: "n-a",
      nodeId,
      usableSnapshot: makeSnapshot(rigId, data),
    });
    expect(state).not.toBe("recoverable");
  });

  // --------------------------------------------- 实时无快照一致性 ---

  it("R-E1：实时预览（无快照）选择唯一 RUNNING 行作为 occupant，而非最新行", () => {
    const { rigW, nodeId } = seedRig();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    sessionRegistry.updateStatus(s1.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-active' WHERE id = ?").run(s1.id);
    const s2 = sessionRegistry.registerSession(nodeId, "r77-seat-v2"); // 更新的 ULID，状态未知，无 token
    expect(s2.id > s1.id).toBe(true);
    const node = previewNode(rigW, null);
    // 基线：实时 SELECT 不携带状态；reduce 选中较新且无 token 的行 → fresh-primed/missing
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified");
  });

  it("R-E2：实时预览存在多个 running 行时属于 explicit-null 歧义——awaiting-decision、freshRequired=false（捕获一致）", () => {
    const { rigW, nodeId } = seedRig();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    const s2 = sessionRegistry.registerSession(nodeId, "r77-seat-v2");
    sessionRegistry.updateStatus(s1.id, "running");
    sessionRegistry.updateStatus(s2.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-a' WHERE id = ?").run(s1.id);
    const node = previewNode(rigW, null);
    expect(node.intendedAction).toBe("awaiting-decision");
    expect(node.freshRequired).toBe(false);
    expect(node.tokenState).toBe("missing");
  });

  it("R-E2b：实时预览没有 running 行时属于 explicit-null 歧义——绝不借用历史 token，且 --fresh 无法覆盖", () => {
    const { rigW, nodeId } = seedRig();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    const s2 = sessionRegistry.registerSession(nodeId, "r77-seat-v2");
    // 没有运行中的行；较旧历史行携带 token，因此下方断言可证明 token 事实没有从
    // 非 occupant 行借用。
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-historical' WHERE id = ?").run(s1.id);
    for (const fresh of [undefined, ["seat"]]) {
      const node = previewNode(rigW, null, fresh);
      expect(node.intendedAction).toBe("awaiting-decision");
      expect(node.freshRequired).toBe(false);
      expect(node.tokenState).toBe("missing");
      expect(node.reason ?? "").toMatch(/关系|占用者/i);
    }
  });

  it("R-E3 一致性下限：基于已捕获快照的预览与基于相同实时状态的预览逐节点一致", () => {
    const { rigId, rigW, nodeId } = seedRig();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    sessionRegistry.updateStatus(s1.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-active' WHERE id = ?").run(s1.id);
    const snap = snapshotCapture.captureSnapshot(rigId, "manual");
    const live = previewNode(rigW, null);
    const fromSnapshot = previewNode(rigW, snapshotRepo.getSnapshot(snap.id)!);
    expect(live.intendedAction).toBe(fromSnapshot.intendedAction);
    expect(live.tokenState).toBe(fromSnapshot.tokenState);
    expect(live.freshRequired).toBe(fromSnapshot.freshRequired);
  });

  // -------------------------------------------------------- 旧版下限 ---

  it("R-F1 下限：整个字段缺失且仅有一行的旧版快照从该行生成预览（旧版推断保持完整）", () => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "field-absent" }, rigW as never);
    const node = previewNode(rigW, makeSnapshot(rigId, data));
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified");
  });

  it("R-F2 对齐：整个字段缺失且有多行的旧版快照从唯一 RUNNING 行生成预览，绝不选择最新 ULID", () => {
    // 如实的 RED 说明：在基线版本中此支路失败——预览 reduce 正是待修复的分歧。
    // 标题使用 alignment，而非 floor。
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_NEW, status: "superseded", token: null },
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "field-absent" }, rigW as never);
    const node = previewNode(rigW, makeSnapshot(rigId, data));
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified");
  });
});
