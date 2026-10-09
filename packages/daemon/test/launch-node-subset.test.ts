// OPR.0.3.4.11——launchNodeSubset 测试：受管的暂缓席位局部恢复。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { createFullTestDb } from "./helpers/test-app.js";

function makeTmux(overrides?: Partial<Record<string, (...args: unknown[]) => unknown>>) {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => false),
    sendKeys: vi.fn(async () => {}),
    capturePaneContent: vi.fn(async () => ""),
    getPaneCommand: vi.fn(async () => null),
    getSessionStatus: vi.fn(async () => null),
    waitForReady: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    startPipePane: vi.fn(async () => true),
    killSession: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("RestoreOrchestrator.launchNodeSubset", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let tmux: ReturnType<typeof makeTmux>;
  let orchestrator: RestoreOrchestrator;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    tmux = makeTmux();
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux as any });
    orchestrator = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux as any,
      claudeResume: new ClaudeResumeAdapter(tmux as any),
      codexResume: new CodexResumeAdapter(tmux as any),
    });
  });

  afterEach(() => { db.close(); });

  function seedPodAwareRig(): { rigId: string; nodeIds: string[] } {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", rig.id, "dev", "Dev");
    const n1 = rigRepo.addNode(rig.id, "dev.driver", { role: "driver", runtime: "claude-code", podId: "pod-1" });
    const n2 = rigRepo.addNode(rig.id, "dev.guard", { role: "guard", runtime: "codex", podId: "pod-1" });
    return { rigId: rig.id, nodeIds: [n1.id, n2.id] };
  }

  function seedSnapshot(rigId: string, nodeIds: string[]) {
    const sessions = nodeIds.map((nid, i) => ({
      nodeId: nid,
      id: `sess-${i}`,
      sessionName: `seat-${i}@test-rig`,
      status: "running",
      resumeType: "none",
      resumeToken: null,
      restorePolicy: "relaunch_fresh",
    }));
    const data = {
      rig: { id: rigId, name: "test-rig" },
      nodes: nodeIds.map((nid, i) => ({
        id: nid,
        logicalId: i === 0 ? "dev.driver" : "dev.guard",
        rigId,
        runtime: i === 0 ? "claude-code" : "codex",
        podId: "pod-1",
      })),
      sessions,
      edges: [],
      checkpoints: {},
      nodeStartupContext: {},
    } as any;
    const snap = snapshotRepo.createSnapshot(rigId, "manual", data);
    return snap.id;
  }

  it("未知工作组返回 rig_not_found", async () => {
    const result = await orchestrator.launchNodeSubset("nonexistent", ["dev.driver"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("rig_not_found");
  });

  it("没有 snapshot 时返回 no_usable_snapshot", async () => {
    const { rigId } = seedPodAwareRig();
    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_usable_snapshot");
  });

  it("未知 logical id 返回 no_matching_nodes", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const result = await orchestrator.launchNodeSubset(rigId, ["nonexistent.node"]);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_matching_nodes");
  });

  it("启动目标，并以默认原因暂缓非目标", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(1);
    expect(result.launched![0].logicalId).toBe("dev.driver");
    expect(result.held).toHaveLength(1);
    expect(result.held![0].logicalId).toBe("dev.guard");
    expect(result.held![0].reason).toBe("excluded_from_subset");
    expect(result.nonTargetEffects).toMatchObject({ mode: "detach_and_hold", reason: "excluded_from_subset" });
  });

  it("单节点启动不改变非目标记录、绑定、启动状态和事件", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const nonTarget = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(nonTarget.id, "running");
    sessionRegistry.updateBinding(nodeIds[1]!, { tmuxSession: "dev-guard@test-rig", tmuxPane: "%9" });
    db.prepare("UPDATE sessions SET startup_status = ? WHERE id = ?").run("attention_required", nonTarget.id);
    const before = {
      session: db.prepare("SELECT * FROM sessions WHERE id = ?").get(nonTarget.id),
      binding: db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeIds[1]),
      events: db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(nodeIds[1]) as { n: number },
    };

    const result = await orchestrator.launchSingleNode(rigId, "dev.driver");

    expect(result.ok).toBe(true);
    expect(result.launched).toEqual([
      expect.objectContaining({ logicalId: "dev.driver", status: "fresh-primed" }),
    ]);
    expect(result.nonTargetEffects).toEqual({ mode: "unchanged", reason: null, affected: [] });
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(nonTarget.id)).toEqual(before.session);
    expect(db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeIds[1])).toEqual(before.binding);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(nodeIds[1]) as { n: number }).n).toBe(before.events.n);
  });

  it("单节点启动失败也不改变非目标状态", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const nonTarget = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(nonTarget.id, "running");
    sessionRegistry.updateBinding(nodeIds[1]!, { tmuxSession: "dev-guard@test-rig", tmuxPane: "%9" });
    db.prepare("UPDATE sessions SET startup_status = ? WHERE id = ?").run("attention_required", nonTarget.id);
    const before = {
      session: db.prepare("SELECT * FROM sessions WHERE id = ?").get(nonTarget.id),
      binding: db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeIds[1]),
      events: db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(nodeIds[1]) as { n: number },
    };
    tmux.createSession.mockResolvedValue({ ok: false, code: "tmux_error", message: "launch failed" } as never);

    const result = await orchestrator.launchSingleNode(rigId, "dev.driver");

    expect(result.ok).toBe(true);
    expect(result.launched).toEqual([
      expect.objectContaining({ logicalId: "dev.driver", status: "failed", error: "launch failed" }),
    ]);
    expect(result.nonTargetEffects).toEqual({ mode: "unchanged", reason: null, affected: [] });
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(nonTarget.id)).toEqual(before.session);
    expect(db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeIds[1])).toEqual(before.binding);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ?").get(nodeIds[1]) as { n: number }).n).toBe(before.events.n);
  });

  it("精确 snapshot 选择在窄启动前覆盖自动排序", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    const manualId = seedSnapshot(rigId, nodeIds);
    db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 10:00:00", manualId);
    const autoId = seedSnapshot(rigId, nodeIds);
    db.prepare("UPDATE snapshots SET kind = ?, created_at = ? WHERE id = ?").run("auto-pre-down", "2026-04-27 10:00:00", autoId);

    const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { snapshotId: manualId });

    expect(result.ok).toBe(true);
    expect(result.snapshotSelection).toMatchObject({ snapshotId: manualId, mode: "explicit", kind: "manual" });
  });

  it("在任何启动修改前拒绝来自其他工作组的精确 snapshot", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const otherRig = rigRepo.createRig("other-rig");
    const otherNode = rigRepo.addNode(otherRig.id, "other.worker", { runtime: "codex" });
    const otherSnapshot = snapshotRepo.createSnapshot(otherRig.id, "manual", {
      rig: otherRig.rig,
      nodes: [otherNode],
      sessions: [],
      edges: [],
      checkpoints: {},
    } as any);
    const before = {
      sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions").get(),
      events: db.prepare("SELECT COUNT(*) AS n FROM events").get(),
    };

    const result = await orchestrator.launchSingleNode(rigId, "dev.driver", { snapshotId: otherSnapshot.id });

    expect(result).toMatchObject({ ok: false, code: "snapshot_wrong_rig" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual(before.sessions);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(before.events);
  });

  it("不会启动被所选 snapshot 预期成员名单排除的当前节点", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    const snapshotId = seedSnapshot(rigId, nodeIds);
    const snapshot = snapshotRepo.getSnapshot(snapshotId)!;
    const data = JSON.parse(JSON.stringify(snapshot.data));
    data.topologyRoster = { version: 1, source: "operator_explicit", intendedNodeIds: [nodeIds[0]] };
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshotId);
    const beforeEvents = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };

    const result = await orchestrator.launchSingleNode(rigId, "dev.guard", { snapshotId });

    expect(result).toMatchObject({ ok: false, code: "no_matching_nodes" });
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect((db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(beforeEvents.n);
  });

  it("规划多个非目标席位的影响，但不修改会话或事件", () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const before = {
      sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number },
      events: db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number },
    };

    const result = orchestrator.planNodeSubset(rigId, ["dev.driver"], { holdReason: "operator hold" });

    expect(result).toMatchObject({
      ok: true,
      planOnly: true,
      snapshotSelection: { mode: "automatic" },
      nonTargetEffects: {
        mode: "detach_and_hold",
        reason: "operator hold",
        affected: [{ logicalId: "dev.guard", reason: "operator hold" }],
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual(before.sessions);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(before.events);
  });

  it("仅为已启动目标发出 restore.subset_completed", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'restore.subset_completed'").all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.result.nodes).toHaveLength(1);
    expect(payload.result.nodes[0].logicalId).toBe("dev.driver");
  });

  it("emits node.held for non-running held non-targets", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'node.held'").all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.logicalId).toBe("dev.guard");
    expect(payload.reason).toBe("excluded_from_subset");
  });

  it("提供时使用操作人员的暂缓原因", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"], { holdReason: "codex auth expired" });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all() as { payload: string }[];
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.reason).toBe("codex auth expired");
  });

  it("reports already_running for live targets (tmux alive)", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => name === "dev-driver@test-rig");

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(result.ok).toBe(true);
    expect(result.alreadyRunning).toHaveLength(1);
    expect(result.alreadyRunning![0].logicalId).toBe("dev.driver");
    expect(result.launched).toHaveLength(0);
  });

  it("不会为运行中的非目标发出 node.held", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => name === "dev-guard@test-rig");

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all();
    expect(events).toHaveLength(0);
  });

  it("没有目标启动时不发出 restore.subset_completed", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => name === "dev-driver@test-rig");

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT type FROM events WHERE type = 'restore.subset_completed'").all();
    expect(events).toHaveLength(0);
  });

  // OPR.0.4.3.28 修正——反转启动存活性的“未知即失败关闭”策略。tmux 探针错误不是席位
  // 存活的正向证据（只有 hasSession 为 TRUE 才是）。旧行为：failedTargets + 硬 503。
  // 新行为：继续启动并给出非阻塞 liveness_probe_unknown 警告，让操作人员确认未占用存活席位。
  it("未知时继续：tmux 探针错误仍启动节点并附存活性警告（不计入 failedTargets）", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[0]!, "dev-driver@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockRejectedValue(new Error("tmux unavailable"));

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(1);
    expect(result.launched![0].logicalId).toBe("dev.driver");
    expect(result.failedTargets ?? []).toHaveLength(0);
    expect(result.warnings?.some((w) => w.includes("liveness_probe_unknown") && w.includes("dev.driver"))).toBe(true);
  });

  // B1 回归：tmux 探针错误的非目标不会收到 node.held。
  // 多目标成功：两个目标都启动，restore.subset_completed 包含两者。
  it("一次调用启动多个目标，并在 restore.subset_completed 中包含两者", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver", "dev.guard"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(2);
    const launchedIds = result.launched!.map((n) => n.logicalId).sort();
    expect(launchedIds).toEqual(["dev.driver", "dev.guard"]);
    expect(result.held).toHaveLength(0);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.subset_completed'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    const eventNodeIds = payload.result.nodes.map((n: { logicalId: string }) => n.logicalId).sort();
    expect(eventNodeIds).toEqual(["dev.driver", "dev.guard"]);
  });

  it("tmux 探针错误时不为非目标发出 node.held（失败关闭）", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    tmux.hasSession.mockImplementation(async (name: string) => {
      if (name === "dev-guard@test-rig") throw new Error("tmux unavailable");
      return false;
    });

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all();
    expect(events).toHaveLength(0);
  });

  // B1 回归：合法与非法席位混合时报告 unmatchedIds。
  it("为不匹配任何节点的席位报告 unmatchedIds", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);

    const result = await orchestrator.launchNodeSubset(rigId, ["dev.driver", "typo.seat"]);

    expect(result.ok).toBe(true);
    expect(result.launched).toHaveLength(1);
    expect(result.launched![0].logicalId).toBe("dev.driver");
    expect(result.unmatchedIds).toEqual(["typo.seat"]);
  });

  // B4 回归：将数据库中陈旧的非目标运行会话标记为 detached，使 inventory 投影 heldReason。
  it("发出 node.held 前将数据库中陈旧的非目标运行会话标记为 detached", async () => {
    const { rigId, nodeIds } = seedPodAwareRig();
    seedSnapshot(rigId, nodeIds);
    const session = sessionRegistry.registerSession(nodeIds[1]!, "dev-guard@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // tmux 表明 guard 已死亡。
    tmux.hasSession.mockResolvedValue(false);

    await orchestrator.launchNodeSubset(rigId, ["dev.driver"]);

    // 会话现在应为 detached，而非 running。
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string };
    expect(row.status).toBe("detached");
    // 同时应发出 node.held。
    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.held'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).logicalId).toBe("dev.guard");
  });
});
