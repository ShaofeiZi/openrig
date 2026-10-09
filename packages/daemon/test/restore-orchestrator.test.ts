import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator, rollupRestoreRigResult } from "../src/domain/restore-orchestrator.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { TmuxAdapter, type TmuxResult } from "../src/adapters/tmux.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { PiResumeAdapter } from "../src/adapters/pi-resume.js";
import type { ResumeResult } from "../src/adapters/claude-resume.js";
import type { PersistedEvent, Snapshot } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission, observeCodexSandbox, observePiResourceTrust, type AppliedLaunchObservation } from "../src/domain/permission-drift.js";
import { buildCodexResumeCore } from "../src/domain/native-resume-probe.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    getPanePid: vi.fn(async () => 1234),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

function mockClaudeResume(result?: ResumeResult): ClaudeResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
    resume: vi.fn(async () => result ?? { ok: true as const }),
  } as unknown as ClaudeResumeAdapter;
}

function mockCodexResume(result?: ResumeResult): CodexResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "codex_id" || type === "codex_last"),
    resume: vi.fn(async () => result ?? { ok: true as const }),
  } as unknown as CodexResumeAdapter;
}

function nativeLineage(runtime: "claude-code" | "codex", token: string) {
  return async () => [
    { pid: 1234, ppid: 1, command: "zsh" },
    { pid: 1235, ppid: 1234, command: runtime === "claude-code" ? `claude --resume ${token}` : `codex resume ${token}` },
  ];
}

describe("RestoreOrchestrator", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  function createOrchestrator(opts?: {
    tmux?: TmuxAdapter;
    claude?: ClaudeResumeAdapter;
    codex?: CodexResumeAdapter;
    pi?: PiResumeAdapter;
    listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
  }) {
    const tmux = opts?.tmux ?? mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: opts?.claude ?? mockClaudeResume(),
      codexResume: opts?.codex ?? mockCodexResume(),
      piResume: opts?.pi,
      listProcesses: opts?.listProcesses,
    });
  }

  function seedRigAndSnapshot(opts?: {
    edges?: { sourceLogical: string; targetLogical: string; kind: string }[];
    nodes?: { logicalId: string; role: string; runtime: string; cwd?: string }[];
    resumeType?: string;
    resumeToken?: string;
    restorePolicy?: string;
    withCheckpoint?: string; // node logicalId to add checkpoint to
    withBinding?: string; // node logicalId to add binding to
  }): Snapshot {
    const nodes = opts?.nodes ?? [
      { logicalId: "orchestrator", role: "orchestrator", runtime: "claude-code" },
      { logicalId: "worker-a", role: "worker", runtime: "claude-code" },
      { logicalId: "worker-b", role: "worker", runtime: "codex" },
    ];
    const rig = rigRepo.createRig("r99");
    const nodeMap: Record<string, string> = {};
    for (const n of nodes) {
      const node = rigRepo.addNode(rig.id, n.logicalId, { role: n.role, runtime: n.runtime, cwd: n.cwd });
      nodeMap[n.logicalId] = node.id;
    }

    const edges = opts?.edges ?? [
      { sourceLogical: "orchestrator", targetLogical: "worker-a", kind: "delegates_to" },
      { sourceLogical: "orchestrator", targetLogical: "worker-b", kind: "delegates_to" },
    ];
    for (const e of edges) {
      rigRepo.addEdge(rig.id, nodeMap[e.sourceLogical]!, nodeMap[e.targetLogical]!, e.kind);
    }

    // 按需添加带 resume metadata 的 session。
    if (opts?.resumeType) {
      for (const n of nodes) {
        const sess = sessionRegistry.registerSession(nodeMap[n.logicalId]!, `r99-${n.logicalId}`);
        db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
          .run(opts.resumeType, opts.resumeToken ?? null, opts.restorePolicy ?? "resume_if_possible", sess.id);
        // OPR.0.5.7.1 修复子项（关于 0ecd79a3 的 desk 裁定）：occupancy 是 fixture 明确陈述的
        // 前提——registerSession 默认的 'unknown' 并非 occupant，capture 会记录唯一的 RUNNING row。
        sessionRegistry.updateStatus(sess.id, "running");
      }
    }

    if (opts?.withBinding) {
      sessionRegistry.updateBinding(nodeMap[opts.withBinding]!, { tmuxSession: `r99-${opts.withBinding}` });
    }

    if (opts?.withCheckpoint) {
      checkpointStore.createCheckpoint(nodeMap[opts.withCheckpoint]!, {
        summary: "Was working on feature X",
        keyArtifacts: ["src/feature.ts"],
      });
    }

    return snapshotCapture.captureSnapshot(rig.id, "manual");
  }

  function updateSnapshotData(snapshot: Snapshot, mutate: (data: any) => void): Snapshot {
    const data = JSON.parse(JSON.stringify(snapshot.data));
    mutate(data);
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshot.id);
    const updated = snapshotRepo.getSnapshot(snapshot.id);
    if (!updated) throw new Error("expected updated snapshot");
    return updated;
  }

  it("只 restore snapshot 的预期 roster，并报告历史排除项", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [
        { logicalId: "lead", role: "lead", runtime: "claude-code" },
        { logicalId: "worker", role: "worker", runtime: "codex" },
        { logicalId: "historical", role: "worker", runtime: "claude-code" },
      ],
      edges: [],
    });
    const intendedIds = snap.data.nodes.filter((node) => node.logicalId !== "historical").map((node) => node.id);
    const fixed = updateSnapshotData(snap, (data) => {
      data.topologyRoster = { version: 1, source: "operator_explicit", intendedNodeIds: intendedIds };
    });

    const result = await createOrchestrator().restore(fixed.id, { freshLogicalIds: ["lead", "worker"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes.map((node) => node.logicalId).sort()).toEqual(["lead", "worker"]);
    expect(result.result.intendedRoster?.map((node) => node.logicalId).sort()).toEqual(["lead", "worker"]);
    expect(result.result.excludedNodes).toEqual([
      expect.objectContaining({ logicalId: "historical", reason: "historical_not_in_intended_roster" }),
    ]);
  });

  it("在发生变化前拒绝显式选择的不可用 snapshot", async () => {
    const snap = seedRigAndSnapshot({ edges: [] });
    const broken = updateSnapshotData(snap, (data) => {
      delete data.edges;
    });
    const before = {
      snapshotCount: snapshotRepo.listSnapshots(snap.rigId).length,
      sessions: db.prepare("SELECT * FROM sessions ORDER BY id").all(),
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
    };

    const result = await createOrchestrator().restore(broken.id);

    expect(result).toMatchObject({ ok: false, code: "snapshot_unusable" });
    expect(snapshotRepo.listSnapshots(snap.rigId)).toHaveLength(before.snapshotCount);
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(before.sessions);
    expect(db.prepare("SELECT * FROM events ORDER BY seq").all()).toEqual(before.events);
  });

  it("遇到真正有歧义的预期 occupant 时失败，且不启动、不输入", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_id",
      resumeToken: "saved-thread",
    });
    const node = snap.data.nodes[0]!;
    const firstSession = snap.data.sessions[0]!;
    const ambiguous = updateSnapshotData(snap, (data) => {
      data.sessions.push({
        ...firstSession,
        id: "second-live-session",
        sessionName: "r99-worker-second",
      });
      data.activeOccupantsByNode = {
        [node.id]: { kind: "ambiguous", candidateIds: [firstSession.id, "second-live-session"] },
      };
    });
    const tmux = mockTmux();

    const result = await createOrchestrator({ tmux }).restore(ambiguous.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes).toEqual([
      expect.objectContaining({ logicalId: "worker", status: "failed", error: expect.stringContaining("活动占用者有歧义") }),
    ]);
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("db handle 不匹配时 constructor 抛错", () => {
    const otherDb = setupDb();
    const otherRepo = new RigRepository(otherDb);
    const tmux = mockTmux();

    expect(() => new RestoreOrchestrator({
      db, rigRepo: otherRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher: new NodeLauncher({ db: otherDb, rigRepo: otherRepo, sessionRegistry: new SessionRegistry(otherDb), eventBus: new EventBus(otherDb), tmuxAdapter: tmux }),
      tmuxAdapter: tmux, claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
    })).toThrow(/共享同一个数据库句柄/);

    otherDb.close();
  });

  it("snapshotRepo handle 不匹配时 constructor 抛错", () => {
    const otherDb = setupDb();
    const otherSnapshotRepo = new SnapshotRepository(otherDb);
    const tmux = mockTmux();

    expect(() => new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo: otherSnapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      tmuxAdapter: tmux, claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
    })).toThrow(/snapshotRepo.*共享同一个数据库句柄/);

    otherDb.close();
  });

  it("snapshotCapture handle 不匹配时 constructor 抛错", () => {
    const otherDb = setupDb();
    const otherRigRepo = new RigRepository(otherDb);
    const otherSessionRegistry = new SessionRegistry(otherDb);
    const otherEventBus = new EventBus(otherDb);
    const otherSnapshotRepo2 = new SnapshotRepository(otherDb);
    const otherCheckpointStore = new CheckpointStore(otherDb);
    const otherSnapshotCapture = new SnapshotCapture({
      db: otherDb, rigRepo: otherRigRepo, sessionRegistry: otherSessionRegistry,
      eventBus: otherEventBus, snapshotRepo: otherSnapshotRepo2, checkpointStore: otherCheckpointStore,
    });
    const tmux = mockTmux();

    expect(() => new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture: otherSnapshotCapture,
      checkpointStore, nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      tmuxAdapter: tmux, claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
    })).toThrow(/snapshotCapture.*共享同一个数据库句柄/);

    otherDb.close();
  });

  it("nodeLauncher handle 不匹配时 constructor 抛错", () => {
    const otherDb = setupDb();
    const otherRigRepo = new RigRepository(otherDb);
    const otherSessionRegistry = new SessionRegistry(otherDb);
    const otherEventBus = new EventBus(otherDb);
    const tmux = mockTmux();
    const otherLauncher = new NodeLauncher({
      db: otherDb, rigRepo: otherRigRepo, sessionRegistry: otherSessionRegistry,
      eventBus: otherEventBus, tmuxAdapter: tmux,
    });

    expect(() => new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher: otherLauncher,
      tmuxAdapter: tmux, claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
    })).toThrow(/nodeLauncher.*共享同一个数据库句柄/);

    otherDb.close();
  });

  it("绝不因延迟的旧版 Claude、Codex 或 Pi resume 而复活已失效 generation", async () => {
    const cases: Array<{
      runtime: "claude-code" | "codex" | "pi";
      resumeType: "claude_id" | "codex_id" | "pi_session_file";
      appliedLaunch: AppliedLaunchObservation;
    }> = [
      { runtime: "claude-code", resumeType: "claude_id", appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") },
      { runtime: "codex", resumeType: "codex_id", appliedLaunch: observeCodexSandbox("-s workspace-write") },
      { runtime: "pi", resumeType: "pi_session_file", appliedLaunch: observePiResourceTrust("no-approve") },
    ];

    for (const [index, testCase] of cases.entries()) {
      const rig = rigRepo.createRig(`resume-invalidation-${index}`);
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: testCase.runtime, cwd: "/work" });
      const sessionName = `r${String(index + 1).padStart(2, "0")}-resume`;
      sessionRegistry.registerSession(node.id, sessionName);
      const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
      let releaseResume!: () => void;
      const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
      const resume = vi.fn(async () => {
        await resumeGate;
        return { ok: true as const, appliedLaunch: testCase.appliedLaunch };
      });
      const orch = createOrchestrator({
        ...(testCase.runtime === "claude-code"
          ? { claude: { canResume: vi.fn(() => true), resume } as unknown as ClaudeResumeAdapter }
          : {}),
        ...(testCase.runtime === "codex"
          ? { codex: { canResume: vi.fn(() => true), resume } as unknown as CodexResumeAdapter }
          : {}),
        ...(testCase.runtime === "pi"
          ? { pi: { canResume: vi.fn(() => true), resume } as unknown as PiResumeAdapter }
          : {}),
      });

      const pending = (orch as any).attemptResume(
        node.id,
        sessionName,
        testCase.resumeType,
        "resume-token",
        "/work",
        null,
        null,
        "floor",
      );
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
      expect(new AppliedLaunchObservationStore(db).invalidateGeneration(generation)).toBe(true);
      releaseResume();
      expect(await pending).toEqual({ kind: "resumed" });
      expect(new AppliedLaunchObservationStore(db).readCurrent(node.id)).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observations WHERE generation_uuid = ?").get(generation)).toEqual({ n: 0 });
    }
  });

  it("不存在的 snapshot -> { ok: false, code: 'snapshot_not_found' }", async () => {
    const orch = createOrchestrator();
    const result = await orch.restore("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("snapshot_not_found");
  });

  it("运行中 rig 存在 live tmux session -> { ok: false, code: 'rig_not_stopped' }", async () => {
    const rig = rigRepo.createRig("r99");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r99-worker");
    sessionRegistry.updateStatus(session.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    // tmux session 确实存活——restore 应阻塞。
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
    expect(snapshotRepo.listSnapshots(rig.id)).toHaveLength(1);
  });

  // --- 场景 A：tmux 崩溃后的陈旧 DB session ---

  it("DB 显示 session 正在运行但 tmux session 已失效时成功 restore（崩溃后）", async () => {
    // tmux 崩溃后，DB session 仍为 status='running'，但 tmux 中没有匹配 session。Restore 应对账
    // 陈旧状态并继续，而不是以 'rig_not_stopped' 拒绝。
    const rig = rigRepo.createRig("crash-rig");
    const node1 = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const node2 = rigRepo.addNode(rig.id, "dev.qa", { role: "worker", runtime: "codex" });
    const sess1 = sessionRegistry.registerSession(node1.id, "dev-impl@crash-rig");
    const sess2 = sessionRegistry.registerSession(node2.id, "dev-qa@crash-rig");
    sessionRegistry.updateStatus(sess1.id, "running");
    sessionRegistry.updateStatus(sess2.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "pre-crash");

    // 模拟崩溃后状态：tmux session 已消失。
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => false) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    // 应继续 restore，而非拒绝。
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes).toHaveLength(2);
      const ids = result.result.nodes.map((n) => n.logicalId).sort();
      expect(ids).toEqual(["dev.impl", "dev.qa"]);
    }
  });

  it("tmux session 确实存活时仍阻塞 restore（反向不变量）", async () => {
    const rig = rigRepo.createRig("live-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "worker@live-rig");
    sessionRegistry.updateStatus(sess.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
  });

  it("pre_restore snapshot 保留原始 running session 状态（变化前捕获）", async () => {
    const rig = rigRepo.createRig("snap-order-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "worker@snap-order-rig");
    sessionRegistry.updateStatus(sess.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    // tmux session 已失效（崩溃后）——restore 应继续。
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => false) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);

    if (result.ok) {
      // 验证 pre_restore snapshot 捕获了原始 running 状态。
      const preSnap = snapshotRepo.getSnapshot(result.result.preRestoreSnapshotId);
      expect(preSnap).toBeDefined();
      const preSnapSessions = preSnap!.data.sessions ?? [];
      const workerSession = preSnapSessions.find((s: { sessionName: string }) => s.sessionName === "worker@snap-order-rig");
      expect(workerSession).toBeDefined();
      expect(workerSession!.status).toBe("running"); // 不是 detached。
    }
  });

  it("较早 running session 仍存活时阻塞，即使同一 node 的较新 session 已 detached", async () => {
    const rig = rigRepo.createRig("multi-sess-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    // 较早 session：running 且 tmux 存活。
    const oldSess = sessionRegistry.registerSession(node.id, "worker@multi-sess-rig");
    sessionRegistry.updateStatus(oldSess.id, "running");
    // 较新 session：detached（例如来自此前 restore 尝试）。
    const newSess = sessionRegistry.registerSession(node.id, "worker@multi-sess-rig");
    sessionRegistry.updateStatus(newSess.id, "detached");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    // tmux 表明旧 session name 确实存活。
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
  });

  it("tmux 检查抛错时阻塞且不改变状态（fail-closed unknown）", async () => {
    const rig = rigRepo.createRig("unknown-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "worker@unknown-rig");
    sessionRegistry.updateStatus(sess.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    const snapshotCountBefore = snapshotRepo.listSnapshots(rig.id).length;

    // tmux 检查抛出意外错误（permission denied / socket failure）——它不是已知缺席错误，因此
    // hasSession 会重新抛出，而不是返回 false。
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => { throw new Error("error connecting to /tmp/tmux-501/default (Permission denied)"); }) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
    // session 不得变为 detached——fail-closed 保留原始状态。
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    const runningSess = sessions.find((s) => s.id === sess.id);
    expect(runningSess?.status).toBe("running");
    // 不应创建 pre_restore snapshot。
    expect(snapshotRepo.listSnapshots(rig.id)).toHaveLength(snapshotCountBefore);
  });

  it("生产 TmuxAdapter 探测错误到达 restore fail-closed 路径（端到端）", async () => {
    // 使用带 mock exec 的真实 TmuxAdapter——而不是 mock hasSession vi.fn。证明实际 adapter 错误
    // 分类契约会经 classifyRunningSessions 传播，并在意外错误时产生 rig_not_stopped。
    const rig = rigRepo.createRig("e2e-probe-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "worker@e2e-probe-rig");
    sessionRegistry.updateStatus(sess.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    const snapshotCountBefore = snapshotRepo.listSnapshots(rig.id).length;

    // 真实 TmuxAdapter，其 exec 会在 has-session 时抛出 Permission denied。
    const realTmux = new TmuxAdapter(async (cmd: string) => {
      if (cmd.includes("has-session")) {
        throw new Error("error connecting to /tmp/tmux-501/default (Permission denied)");
      }
      return "";
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: realTmux });
    const orch = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: realTmux,
      claudeResume: mockClaudeResume(),
      codexResume: mockCodexResume(),
    });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
    // 保留原始 session——无变化。
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    const runningSess = sessions.find((s) => s.id === sess.id);
    expect(runningSess?.status).toBe("running");
    // 未创建 pre_restore snapshot。
    expect(snapshotRepo.listSnapshots(rig.id)).toHaveLength(snapshotCountBefore);
  });

  // --- 场景 B：部分失败不会丢弃 pod ---

  it("部分 node 启动失败时，结果仍包含全部 snapshot node（不静默丢弃 pod）", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [
        { logicalId: "orch.lead", role: "orch", runtime: "claude-code" },
        { logicalId: "dev.impl", role: "impl", runtime: "claude-code" },
        { logicalId: "dev.qa", role: "qa", runtime: "codex" },
        { logicalId: "rev.r1", role: "reviewer", runtime: "claude-code" },
      ],
      edges: [
        { sourceLogical: "orch.lead", targetLogical: "dev.impl", kind: "delegates_to" },
        { sourceLogical: "orch.lead", targetLogical: "rev.r1", kind: "delegates_to" },
      ],
    });

    // 令一个特定 node 的 createSession 失败。
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      if (name.includes("dev_qa")) return { ok: false as const, message: "tmux error" };
      return { ok: true as const };
    });
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const logicalIds = new Set(result.result.nodes.map((n) => n.logicalId));
      // 结果中存在全部 4 个 snapshot node——没有静默丢失。
      expect(logicalIds).toEqual(new Set(["orch.lead", "dev.impl", "dev.qa", "rev.r1"]));
      // 失败 node 应报告为 failed，而不是缺席。
      const qaResult = result.result.nodes.find((n) => n.logicalId === "dev.qa");
      expect(qaResult).toBeDefined();
      expect(qaResult!.status).toBe("failed");
    }
  });

  it("拓扑顺序：delegates_to（精确顺序）", async () => {
    const snap = seedRigAndSnapshot();
    const tmux = mockTmux();
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      // orchestrator（delegates_to 的 source）在先，随后 worker 按字母顺序。
      expect(order).toEqual(["orchestrator", "worker-a", "worker-b"]);
    }
  });

  it("spawned_by 约束顺序（target 先于 source）", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [
        { logicalId: "child", role: "worker", runtime: "claude-code" },
        { logicalId: "parent", role: "orchestrator", runtime: "claude-code" },
      ],
      edges: [{ sourceLogical: "child", targetLogical: "parent", kind: "spawned_by" }],
    });
    const orch = createOrchestrator();

    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      // parent（spawned_by 的 target）必须先于 child（source）。
      expect(order.indexOf("parent")).toBeLessThan(order.indexOf("child"));
    }
  });

  it("can_observe 不约束顺序", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [
        { logicalId: "orchestrator", role: "orchestrator", runtime: "claude-code" },
        { logicalId: "worker-a", role: "worker", runtime: "claude-code" },
        { logicalId: "worker-b", role: "worker", runtime: "codex" },
      ],
      edges: [
        { sourceLogical: "orchestrator", targetLogical: "worker-a", kind: "delegates_to" },
        { sourceLogical: "orchestrator", targetLogical: "worker-b", kind: "delegates_to" },
        { sourceLogical: "worker-a", targetLogical: "worker-b", kind: "can_observe" },
      ],
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // can_observe 不应强制 worker-a 先于 worker-b。
      // 字母顺序 tie-breaker：worker-a 先于 worker-b（结果相同，但原因正确）。
      expect(result.result.nodes.map((n) => n.logicalId)).toEqual(["orchestrator", "worker-a", "worker-b"]);
    }
  });

  it("launch 成功 -> 新 binding 替换旧 binding，旧 session 变为 superseded", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      withBinding: "worker",
      resumeType: "claude_name",
      resumeToken: "tok",
    });

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 新 binding 应存在，并带有已启动 session name。
      const rig = rigRepo.getRig(snap.data.rig.id);
      const worker = rig!.nodes.find((n) => n.logicalId === "worker");
      expect(worker!.binding).not.toBeNull();
      expect(worker!.binding!.tmuxSession).toBe("r99-worker");

      // 旧 session 应为 superseded。
      const superseded = db.prepare("SELECT status FROM sessions WHERE status = 'superseded'").all();
      expect(superseded.length).toBeGreaterThan(0);
    }
  });

  it("launch createSession 失败 -> 完整恢复此前 binding，包括 cmuxSurface", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      withBinding: "worker",
    });

    // 在 snapshot 前向 binding 添加 cmuxSurface。
    const nodeId = snap.data.nodes[0]!.id;
    sessionRegistry.updateBinding(nodeId, { cmuxSurface: "surface-42" });

    // 捕获准确的此前 binding 状态。
    const priorBinding = sessionRegistry.getBindingForNode(nodeId);
    expect(priorBinding!.cmuxSurface).toBe("surface-42");

    // 添加状态已知的 session。
    const sess = sessionRegistry.registerSession(nodeId, "r99-worker");
    sessionRegistry.updateStatus(sess.id, "detached");

    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: false as const, code: "duplicate_session", message: "err" }
    );
    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const failedNode = result.result.nodes.find((n) => n.logicalId === "worker");
      expect(failedNode!.status).toBe("failed");

      // 完整恢复此前 binding，包括 cmuxSurface。
      const restoredBinding = sessionRegistry.getBindingForNode(nodeId);
      expect(restoredBinding).not.toBeNull();
      expect(restoredBinding!.cmuxSurface).toBe("surface-42");
      expect(restoredBinding!.tmuxSession).toBe(priorBinding!.tmuxSession);

      // session 状态恢复为准确的此前值。
      const sessions = sessionRegistry.getSessionsForRig(snap.data.rig.id);
      const originalSess = sessions.find((s) => s.id === sess.id);
      expect(originalSess!.status).toBe("detached");
    }
  });

  it("launch db_error（tmux 成功、DB 失败）-> 恢复此前状态", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      resumeType: "none",
      edges: [],
      withBinding: "worker",
    });

    const nodeId = snap.data.nodes[0]!.id;
    sessionRegistry.updateBinding(nodeId, { cmuxSurface: "surface-99" });
    const sess = sessionRegistry.registerSession(nodeId, "r99-worker");
    sessionRegistry.updateStatus(sess.id, "idle");

    // tmux createSession 成功，但 NodeLauncher 的 DB transaction 失败。破坏方式：让 createSession
    // 成功并触发 killSession（清理），但破坏 events table，使 launch transaction 失败。
    const tmux = mockTmux();
    let createCalled = false;
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (!createCalled) {
        createCalled = true;
        // 在 tmux 成功后、NodeLauncher DB transaction 前破坏 events table。
        db.exec("DROP TABLE events");
        db.exec(
          "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
        );
      }
      return { ok: true as const };
    });

    const orch = createOrchestrator({ tmux });
    // A1 前提：捕获的 running occupant 被 fresh-listed 操作 B 有意替换。
    const result = await orch.restore(snap.id, { freshLogicalIds: ["worker"] });

    // restore 本身可能因 events table 被破坏而报错。但若返回 ok，失败 node 应恢复此前状态；若返回
    // restore_error，也可接受。
    if (result.ok) {
      const failedNode = result.result.nodes.find((n) => n.logicalId === "worker");
      expect(failedNode!.status).toBe("failed");

      // 已恢复此前 binding。
      const restoredBinding = sessionRegistry.getBindingForNode(nodeId);
      expect(restoredBinding).not.toBeNull();
      expect(restoredBinding!.cmuxSurface).toBe("surface-99");

      // session 恢复为准确的此前状态。
      const sessions = db.prepare("SELECT id, status FROM sessions WHERE id = ?").get(sess.id) as { status: string } | undefined;
      expect(sessions).toBeDefined();
      expect(sessions!.status).toBe("idle");

      // 应已调用 killSession（NodeLauncher 清理）。
      expect(tmux.killSession).toHaveBeenCalled();
    }
  });

  it("没有此前 binding 时 launch 失败 -> 失败后仍无 binding", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      // 没有 withBinding——node 初始为未绑定。
    });

    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: false as const, code: "duplicate_session", message: "err" }
    );
    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeId = snap.data.nodes[0]!.id;
      const binding = sessionRegistry.getBindingForNode(nodeId);
      expect(binding).toBeNull(); // 不虚构 binding。
    }
  });

  it("在陈旧状态发生变化前捕获 pre-restore snapshot", async () => {
    const snap = seedRigAndSnapshot({
      withBinding: "orchestrator",
      resumeType: "claude_name",
      resumeToken: "tok",
    });

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);

    if (result.ok) {
      // pre-restore snapshot 应包含原始 binding 与 session state。
      const preSnap = snapshotRepo.getSnapshot(result.result.preRestoreSnapshotId);
      expect(preSnap).not.toBeNull();
      expect(preSnap!.kind).toBe("pre_restore");

      const orchNode = preSnap!.data.nodes.find((n) => n.logicalId === "orchestrator");
      expect(orchNode!.binding).not.toBeNull();
      expect(orchNode!.binding!.tmuxSession).toBe("r99-orchestrator");

      // pre-restore session 应显示原始状态（不是 superseded）。
      const preSessions = preSnap!.data.sessions;
      for (const s of preSessions) {
        expect(s.status).not.toBe("superseded");
      }
    }
  });

  it("restore_policy=resume_if_possible + claude_name -> 调用 Claude resume", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "my-session",
      restorePolicy: "resume_if_possible",
    });
    const claude = mockClaudeResume();
    const orch = createOrchestrator({ claude });
    await orch.restore(snap.id);

    expect(claude.resume).toHaveBeenCalled();
  });

  it("restore_policy=resume_if_possible + codex_id -> 调用 Codex resume", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "codex" }],
      edges: [],
      resumeType: "codex_id",
      resumeToken: "uuid-123",
      restorePolicy: "resume_if_possible",
    });
    const codex = mockCodexResume();
    const orch = createOrchestrator({ codex });
    await orch.restore(snap.id);

    expect(codex.resume).toHaveBeenCalled();
  });

  it("resume 成功 -> status 'resumed'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
    });
    const orch = createOrchestrator({ claude: mockClaudeResume({ ok: true }), listProcesses: nativeLineage("claude-code", "tok") });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("resumed");
      expect(sessionRegistry.getBindingForNode(result.result.nodes[0]!.nodeId)?.tmuxPane).toBe("%1");
      const verdict = db.prepare("SELECT verdict, registered_pane FROM seat_identity_verdicts WHERE node_id = ?")
        .get(result.result.nodes[0]!.nodeId) as { verdict: string; registered_pane: string };
      expect(verdict).toEqual({ verdict: "verified", registered_pane: "%1" });
    }
  });

  it.each(["full", "subset", "existing-hook", "conflicting-hook"])("通过 %s recovery 与下一次 identity poll 证明合成 shell 包装的 Codex", async (mode) => {
    const token = "00000000-0000-7000-8000-000000000001";
    const snap = seedRigAndSnapshot({ nodes: [{ logicalId: "worker", role: "worker", runtime: "codex" }], edges: [], resumeType: "codex_id", resumeToken: token });
    // 合成 ID、路径与时间保留 shell/Node/native 前台关系。
    const rows = [
      { pid: 3001, ppid: 3000, pgid: 3001, tpgid: 3002, executableName: "zsh", command: "-zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
      { pid: 3002, ppid: 3001, pgid: 3002, tpgid: 3002, executableName: "bash", command: "/bin/sh /tmp/openrig-tmux-send.txt", startedAt: "Sat Jan  1 12:00:00 2000" },
      { pid: 3003, ppid: 3002, pgid: 3002, tpgid: 3002, executableName: "node", command: `node /opt/bin/codex -s workspace-write -m fixture-model resume --add-dir /tmp/state ${token}`, startedAt: "Sat Jan  1 12:00:00 2000" },
      { pid: 3004, ppid: 3003, pgid: 3002, tpgid: 3002, executableName: "codex", command: `/opt/native/codex -s workspace-write -m fixture-model resume --add-dir /tmp/state ${token}`, startedAt: "Sat Jan  1 12:00:00 2000" },
    ];
    const tmux = { ...mockTmux(), getPanePid: vi.fn(async () => 3001), getPaneCommand: vi.fn(async () => "bash") } as unknown as TmuxAdapter;
    const listProcesses = async () => {
      if (mode.endsWith("hook")) db.prepare("UPDATE sessions SET resume_token = ?, resume_provenance = 'hook' WHERE id = (SELECT id FROM sessions ORDER BY id DESC LIMIT 1)").run(mode === "existing-hook" ? token : "other-thread");
      return rows;
    };
    const orch = createOrchestrator({ tmux, listProcesses });
    const result = mode !== "subset" ? await orch.restore(snap.id) : await orch.launchSingleNode(snap.rigId, "worker", { snapshotId: snap.id });
    expect(result.ok).toBe(true);
    const nodes = "result" in result ? result.result?.nodes : result.launched;
    if (mode === "conflicting-hook") {
      expect(nodes?.[0]?.status).toBe("attention_required");
      expect(db.prepare("SELECT verdict FROM seat_identity_verdicts WHERE node_id = ?").get(nodes![0]!.nodeId)).toEqual({ verdict: "mismatch" });
      expect(db.prepare("SELECT resume_token, resume_provenance FROM sessions ORDER BY id DESC LIMIT 1").get()).toEqual({ resume_token: "other-thread", resume_provenance: "hook" });
      return;
    }
    expect(nodes?.[0]?.status).toBe("resumed");
    if (mode === "existing-hook") expect(db.prepare("SELECT resume_provenance FROM sessions ORDER BY id DESC LIMIT 1").get()).toEqual({ resume_provenance: "hook" });
    const nodeId = nodes![0]!.nodeId;
    const name = sessionRegistry.getBindingForNode(nodeId)!.tmuxSession!;
    tmux.listSessions = vi.fn(async () => [{ name }] as never);
    await new SeatIdentityReconciler({ db, tmux, listProcesses } as ConstructorParameters<typeof SeatIdentityReconciler>[0]).reconcileAll();
    expect(db.prepare("SELECT verdict, observed_pid FROM seat_identity_verdicts WHERE node_id = ?").get(nodeId)).toEqual({ verdict: "verified", observed_pid: 3004 });
  });

  it("native child 携带已保存 session 时，将受管 Codex wrapper 报告为 resumed", async () => {
    const resumeToken = "01a05645-37a2-7dd0-970c-031d2f2510cb";
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "codex" }],
      edges: [],
      resumeType: "codex_id",
      resumeToken,
    });
    const tmux = { ...mockTmux(), getPaneCommand: vi.fn(async () => "node") } as unknown as TmuxAdapter;
    const codexCommand = `/opt/openrig/vendor/bin/codex --model gpt-5.6 resume --add-dir /tmp/openrig-state ${resumeToken}`;
    const result = await createOrchestrator({
      tmux,
      codex: mockCodexResume({ ok: true }),
      listProcesses: async () => [
        { pid: 1234, ppid: 1, command: "-zsh", pgid: 1234, tpgid: 54776, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 54776, ppid: 1234, command: codexCommand, pgid: 54776, tpgid: 54776, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
    }).restore(snap.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]!.status).toBe("resumed");
    expect(db.prepare("SELECT verdict, observed_pid, observed_command, matched_layer FROM seat_identity_verdicts WHERE node_id = ?")
      .get(result.result.nodes[0]!.nodeId)).toEqual({
        verdict: "verified",
        observed_pid: 54776,
        observed_command: codexCommand,
        matched_layer: 1,
      });
  });

  it("前置 profile 也名为 resume 时，仍报告 Codex resume", async () => {
    const resumeToken = "saved-thread-label";
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "codex" }],
      edges: [],
      resumeType: "codex_id",
      resumeToken,
    });
    const tmux = { ...mockTmux(), getPaneCommand: vi.fn(async () => "node") } as unknown as TmuxAdapter;
    const codexCommand = buildCodexResumeCore(resumeToken, "resume", false, "--add-dir /tmp/openrig-state");
    const result = await createOrchestrator({
      tmux,
      codex: mockCodexResume({ ok: true }),
      listProcesses: async () => [
        { pid: 1234, ppid: 1, command: "-zsh", pgid: 1234, tpgid: 54776, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 54776, ppid: 1234, command: codexCommand, pgid: 54776, tpgid: 54776, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
    }).restore(snap.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]!.status).toBe("resumed");
    expect(db.prepare("SELECT verdict, observed_pid, observed_command, matched_layer FROM seat_identity_verdicts WHERE node_id = ?")
      .get(result.result.nodes[0]!.nodeId)).toEqual({
        verdict: "verified",
        observed_pid: 54776,
        observed_command: codexCommand,
        matched_layer: 1,
      });
  });

  it("prompt 文本看似另一条 resume 命令时，使 Codex resume 保持 partial", async () => {
    const resumeToken = "saved-thread-label";
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "codex" }],
      edges: [],
      resumeType: "codex_id",
      resumeToken,
    });
    const tmux = { ...mockTmux(), getPaneCommand: vi.fn(async () => "node") } as unknown as TmuxAdapter;
    const codexCommand = `${buildCodexResumeCore("different-thread", "resume", false, "--add-dir /tmp/openrig-state")} resume ${resumeToken}`;
    const result = await createOrchestrator({
      tmux,
      codex: mockCodexResume({ ok: true }),
      listProcesses: async () => [
        { pid: 1234, ppid: 1, command: "-zsh", pgid: 1234, tpgid: 54776, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 54776, ppid: 1234, command: codexCommand, pgid: 54776, tpgid: 54776, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
    }).restore(snap.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]!.status).toBe("attention_required");
    expect(db.prepare("SELECT verdict, reason, observed_pid, observed_command FROM seat_identity_verdicts WHERE node_id = ?")
      .get(result.result.nodes[0]!.nodeId)).toEqual({
        verdict: "mismatch",
        reason: "process_identity_ambiguous",
        observed_pid: 1234,
        observed_command: "node",
      });
  });

  it("保存的 token 只是另一 session 之后的 prompt 文本时，使 Codex resume 保持 partial", async () => {
    const resumeToken = "saved-thread-label";
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "codex" }],
      edges: [],
      resumeType: "codex_id",
      resumeToken,
    });
    const tmux = { ...mockTmux(), getPaneCommand: vi.fn(async () => "node") } as unknown as TmuxAdapter;
    const result = await createOrchestrator({
      tmux,
      codex: mockCodexResume({ ok: true }),
      listProcesses: async () => [
        { pid: 1234, ppid: 1, command: "-zsh" },
        { pid: 54776, ppid: 1234, command: `node /opt/openrig/bin/codex resume different-thread ${resumeToken}` },
      ],
    }).restore(snap.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]!.status).toBe("attention_required");
    expect(db.prepare("SELECT verdict, reason, observed_pid, observed_command FROM seat_identity_verdicts WHERE node_id = ?")
      .get(result.result.nodes[0]!.nodeId)).toEqual({
        verdict: "mismatch",
        reason: "process_identity_ambiguous",
        observed_pid: 1234,
        observed_command: "node",
      });
  });

  it("无法接入 terminal pane 时，使 native resume 保持 partial", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
    });
    const tmux = { ...mockTmux(), listPanes: vi.fn(async () => []) } as unknown as TmuxAdapter;
    const result = await createOrchestrator({ tmux, claude: mockClaudeResume({ ok: true }) }).restore(snap.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("partially_restored");
    expect(result.result.nodes[0]!.status).toBe("attention_required");
      expect(result.result.nodes[0]!.error).toContain("没有可 attach 的 pane");
    expect(result.result.nodes[0]!.error).toContain("未启动替代会话");
    expect(db.prepare("SELECT verdict, reason FROM seat_identity_verdicts WHERE node_id = ?")
      .get(result.result.nodes[0]!.nodeId)).toEqual({ verdict: "pane_missing", reason: "session_missing" });
  });

  it.each([null, "node"])(
    "接入的 pane command 有歧义时，使 native resume 保持 partial（%s）",
    async (command) => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
      });
      const tmux = { ...mockTmux(), getPaneCommand: vi.fn(async () => command) } as unknown as TmuxAdapter;
      const result = await createOrchestrator({ tmux, claude: mockClaudeResume({ ok: true }) }).restore(snap.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.rigResult).toBe("partially_restored");
      expect(result.result.nodes[0]!.status).toBe("attention_required");
      expect(result.result.nodes[0]!.error).toContain("无法正向识别 runtime 'claude-code'");
      expect(db.prepare("SELECT verdict, reason FROM seat_identity_verdicts WHERE node_id = ?")
        .get(result.result.nodes[0]!.nodeId)).toEqual({ verdict: "mismatch", reason: "process_identity_ambiguous" });
    },
  );

  it("接入的 pane 与 seat runtime 冲突时，使 native resume 保持 partial", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
    });
    const tmux = { ...mockTmux(), getPaneCommand: vi.fn(async () => "codex") } as unknown as TmuxAdapter;
    const result = await createOrchestrator({ tmux, claude: mockClaudeResume({ ok: true }) }).restore(snap.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("partially_restored");
    expect(result.result.nodes[0]!.status).toBe("attention_required");
    expect(result.result.nodes[0]!.error).toContain("与 runtime 'claude-code' 矛盾");
    expect(db.prepare("SELECT verdict, reason FROM seat_identity_verdicts WHERE node_id = ?")
      .get(result.result.nodes[0]!.nodeId)).toEqual({ verdict: "mismatch", reason: "process_identity_mismatch" });
  });

  it("resume 失败 -> 回退到 checkpoint 文件投递", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: tmpDir }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
      withCheckpoint: "worker",
    });
    const claude = mockClaudeResume({ ok: false, code: "resume_failed", message: "err" });
    const orch = createOrchestrator({ claude });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    // NS-T04：resume 失败现在会显著 FAILED，不再静默回退到 checkpoint。
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("旧版 Claude resume 校验失败 -> status 'failed'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "missing-session",
    });
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      "No conversation found with session ID: missing-session\nuser@example.test %"
    );
    const claude = new ClaudeResumeAdapter(tmux, { pollMs: 0, maxWaitMs: 0, sleep: async () => {} });
    const orch = createOrchestrator({ tmux, claude });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
  });

  it("restore_policy=relaunch_fresh -> 不尝试 resume", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
      restorePolicy: "relaunch_fresh",
    });
    const claude = mockClaudeResume();
    const orch = createOrchestrator({ claude });
    await orch.restore(snap.id);

    expect(claude.resume).not.toHaveBeenCalled();
  });

  it("restore_policy=checkpoint_only -> 不尝试 resume，并写入 checkpoint", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: tmpDir }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
      restorePolicy: "checkpoint_only",
      withCheckpoint: "worker",
    });
    const claude = mockClaudeResume();
    const orch = createOrchestrator({ claude });
    const result = await orch.restore(snap.id);

    expect(claude.resume).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("rebuilt");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("resume_type=none -> 不尝试 resume", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "none",
      resumeToken: null,
    });
    const claude = mockClaudeResume();
    const codex = mockCodexResume();
    const orch = createOrchestrator({ claude, codex });
    await orch.restore(snap.id);

    expect(claude.resume).not.toHaveBeenCalled();
    expect(codex.resume).not.toHaveBeenCalled();
  });

  it("将 checkpoint 准确写入 {cwd}/.rigged-checkpoint.md，并包含 summary", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: tmpDir }],
      resumeType: "none",
      edges: [],
      withCheckpoint: "worker",
    });
    const orch = createOrchestrator();
    // A1 前提：捕获的 running occupant 被 fresh-listed 操作 B 有意替换。
    const result = await orch.restore(snap.id, { freshLogicalIds: ["worker"] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("rebuilt");
      // 验证准确文件路径与内容。
      const filePath = path.join(tmpDir, ".rigged-checkpoint.md");
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("Was working on feature X");
      expect(content).toContain("src/feature.ts");
    }
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("checkpoint + null cwd -> status 'failed'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }], // 无 cwd。
      edges: [],
      withCheckpoint: "worker",
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("pre_restore_validation_failed");
      expect(result.result.rigResult).toBe("not_attempted");
      expect(result.result.blockers?.[0]).toMatchObject({
        code: "checkpoint_missing_node_cwd",
        logicalId: "worker",
      });
    }
  });

  it("无 checkpoint -> status 'fresh'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      resumeType: "none",
      edges: [],
    });
    const orch = createOrchestrator();
    // A1 前提：捕获的 running occupant 被 fresh-listed 操作 B 有意替换。
    const result = await orch.restore(snap.id, { freshLogicalIds: ["worker"] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("fresh-primed");
  });

  it("node launch 失败 -> status 'failed'，继续处理其余 node", async () => {
    const snap = seedRigAndSnapshot({ resumeType: "none" });
    const tmux = mockTmux();
    let callCount = 0;
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return { ok: false as const, code: "unknown", message: "simulated launch failure" };
      return { ok: true as const };
    });
    const orch = createOrchestrator({ tmux });
    // A1 前提：每个默认 seed node 捕获的 running occupant 都被 fresh-listed 操作 B 有意替换。
    const result = await orch.restore(snap.id, { freshLogicalIds: ["orchestrator", "worker-a", "worker-b"] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const statuses = result.result.nodes.map((n) => n.status);
      expect(statuses).toContain("failed");
      // 仍会处理其他 node。
      expect(statuses.filter((s) => s !== "failed").length).toBeGreaterThan(0);
    }
  });

  it("checkpoint 文件写入失败 -> status 'failed'", async () => {
    // 使用不存在的目录路径，使 writeFileSync 失败。
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: "/nonexistent/path/that/does/not/exist" }],
      edges: [],
      withCheckpoint: "worker",
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("failed");
    }
  });

  it("restore.started：DB 中保存准确 payload", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const orch = createOrchestrator();
    await orch.restore(snap.id);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.started'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(snap.data.rig.id);
    expect(payload.snapshotId).toBe(snap.id);
  });

  it("restore.completed：DB 与 subscriber 中包含 RestoreResult 的准确 payload", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    // DB event。
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.completed'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(snap.data.rig.id);
    expect(payload.snapshotId).toBe(snap.id);
    expect(payload.result).toBeDefined();
    expect(payload.result.rigResult).toBeDefined();
    expect(payload.result.nodes).toHaveLength(1);

    // subscriber 收到相同 payload。
    const completedEvent = notifications.find((e) => e.type === "restore.completed");
    expect(completedEvent).toBeDefined();
    if (completedEvent && completedEvent.type === "restore.completed") {
      expect(completedEvent.rigId).toBe(snap.data.rig.id);
      expect(completedEvent.snapshotId).toBe(snap.id);
      expect(completedEvent.result).toBeDefined();
      expect(completedEvent.result.rigResult).toBe(result.ok ? result.result.rigResult : undefined);
      expect(completedEvent.result.nodes).toHaveLength(1);
      // 与返回的 RestoreResult 匹配。
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(completedEvent.result.nodes[0]!.status).toBe(result.result.nodes[0]!.status);
        expect(completedEvent.result.nodes[0]!.logicalId).toBe(result.result.nodes[0]!.logicalId);
      }
    }
  });

  it("pre-restore snapshot kind = 'pre_restore'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const preSnap = snapshotRepo.getSnapshot(result.result.preRestoreSnapshotId);
      expect(preSnap).not.toBeNull();
      expect(preSnap!.kind).toBe("pre_restore");
    }
  });

  // -- 修复 4：并发保护 --

  it("并发 restore 同一 rig -> 第二个返回 restore_in_progress", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });

    // 让 tmux createSession 变慢，使第一次 restore 仍在进行。
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true as const }), 100))
    );
    const orch = createOrchestrator({ tmux });

    // 并发启动两次 restore。
    const [r1, r2] = await Promise.all([
      orch.restore(snap.id),
      orch.restore(snap.id),
    ]);

    // 一个成功，一个被阻塞。
    const outcomes = [r1, r2];
    const succeeded = outcomes.filter((r) => r.ok);
    const blocked = outcomes.filter((r) => !r.ok && r.code === "restore_in_progress");
    expect(succeeded).toHaveLength(1);
    expect(blocked).toHaveLength(1);
  });

  it("失败时释放 lock：第一次 restore 报错，允许第二次 restore", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });

    // 第一次 restore：破坏环境以触发 restore_error。
    const tmux1 = mockTmux();
    const orch = createOrchestrator({ tmux: tmux1 });

    // 破坏 snapshots，使 pre-restore capture 失败。
    db.exec("CREATE TRIGGER block_snap BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    const r1 = await orch.restore(snap.id);
    expect(r1.ok).toBe(false);
    db.exec("DROP TRIGGER block_snap");

    // 应允许第二次 restore（失败后已释放 lock）。
    const r2 = await orch.restore(snap.id);
    // 不应为 restore_in_progress。
    if (!r2.ok) {
      expect(r2.code).not.toBe("restore_in_progress");
    }
  });

  it("不同 rig 可以并发 restore", async () => {
    // 预置两个各自带 snapshot 的 rig。
    const rig1 = rigRepo.createRig("r98");
    rigRepo.addNode(rig1.id, "worker", { role: "worker", runtime: "claude-code" });
    const snap1 = snapshotCapture.captureSnapshot(rig1.id, "manual");

    const rig2 = rigRepo.createRig("r97");
    rigRepo.addNode(rig2.id, "worker", { role: "worker", runtime: "claude-code" });
    const snap2 = snapshotCapture.captureSnapshot(rig2.id, "manual");

    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true as const }), 50))
    );
    const orch = createOrchestrator({ tmux });

    // 两者都应成功（互不阻塞）。
    const [r1, r2] = await Promise.all([
      orch.restore(snap1.id),
      orch.restore(snap2.id),
    ]);

    // 两者都不应为 restore_in_progress。
    if (!r1.ok) expect(r1.code).not.toBe("restore_in_progress");
    if (!r2.ok) expect(r2.code).not.toBe("restore_in_progress");
  });

  it.each([
    "delayed screen", "immediate screen", "no usable screen", "shell only", "trust gate",
    "wrong token", "wrong runtime", "wrong executable", "background native", "missing ancestry",
    "missing start time", "multiple natives", "duplicate PID", "native PID reused", "pane PID reused",
  ])("真实 pod-aware Codex resume 保持 readiness 与 identity：%s", async (mode) => {
    const { CodexRuntimeAdapter } = await import("../src/adapters/codex-runtime-adapter.js");
    const token = "00000000-0000-7000-8000-000000000001";
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-resume", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.owner", { runtime: "codex", podId: "pod-resume" });
    const session = sessionRegistry.registerSession(node.id, "dev-owner@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "codex_id", token);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
      .run(node.id, "[]", "[]", "[]", "codex");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    // 这里模拟启动时序，而不是重建未记录的历史样本。所有 ID、路径、进程组与启动时间均为合成值。
    let ticks = 0;
    const screen = () => {
      if (mode === "trust gate") return "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, exit";
      if (mode === "shell only") return "$ ";
      if (mode === "no usable screen" || (mode !== "immediate screen" && ticks < 8)) return "Starting Codex...";
      return "OpenAI Codex (v0.155.1)\n› Ask Codex to do anything";
    };
    let launched = false;
    const tmux = {
      ...mockTmux(),
      createSession: vi.fn(async () => { launched = true; return { ok: true as const }; }),
      hasSession: vi.fn(async () => launched),
      sendShellCommand: vi.fn(async () => ({ ok: true as const })),
      getPanePid: vi.fn(async () => 3001),
      getPaneCommand: vi.fn(async () => "bash"),
      capturePaneScreen: vi.fn(async () => screen()),
      capturePaneContent: vi.fn(async () => screen()),
    } as unknown as TmuxAdapter;
    const startedAt = "Sat Jan  1 12:00:00 2000";
    const rows = [
      { pid: 3001, ppid: 1, pgid: 3001, tpgid: 3002, executableName: "zsh", command: "-zsh", startedAt },
      { pid: 3002, ppid: 3001, pgid: 3002, tpgid: 3002, executableName: "bash", command: "/bin/sh /tmp/openrig-tmux-send.txt", startedAt },
      { pid: 3003, ppid: 3002, pgid: 3002, tpgid: 3002, executableName: "node", command: `node /opt/bin/codex resume ${token}`, startedAt },
      { pid: 3004, ppid: 3003, pgid: 3002, tpgid: 3002, executableName: "codex", command: `/opt/native/codex -s workspace-write -m fixture-model resume --add-dir /tmp/state ${token}`, startedAt },
    ];
    if (mode === "wrong token") rows[3]!.command = "/opt/native/codex resume other";
    if (mode === "wrong runtime") rows[3]!.command = "/opt/native/claude --resume " + token;
    if (mode === "wrong executable") rows[3]!.executableName = "printf";
    if (mode === "background native") rows[3]!.pgid = 999;
    if (mode === "missing ancestry") rows[3]!.ppid = 999;
    if (mode === "missing start time") rows[3]!.startedAt = "";
    if (mode === "multiple natives") rows.push({ ...rows[3]!, pid: 3005 });
    if (mode === "duplicate PID") rows.push({ ...rows[3]! });
    let samples = 0;
    const listProcesses = async () => {
      samples++;
      if (mode === "shell only") return rows.slice(0, 1);
      return rows.map(row => ({ ...row, startedAt:
        ((mode === "native PID reused" && row.pid === 3004) || (mode === "pane PID reused" && row.pid === 3001)) && samples % 2 === 0
          ? "Sat Jan  1 12:00:01 2000" : row.startedAt }));
    };
    const adapter = new CodexRuntimeAdapter({ tmux, listProcesses, sleep: async () => { ticks++; },
      fsOps: { exists: () => false, readFile: () => { throw new Error("absent"); }, writeFile: () => {}, mkdirp: () => {}, homedir: "/fixture/home" },
    });
    const result = await createOrchestrator({ tmux, listProcesses }).restore(snap.id, { adapters: { codex: adapter } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    tmux.listSessions = async () => [{ name: "dev-owner@test-rig" }] as never;
    await new SeatIdentityReconciler({ db, tmux, listProcesses }).reconcileAll();
    const latest = db.prepare("SELECT resume_token FROM sessions WHERE node_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(node.id) as { resume_token: string | null };
    const verdict = db.prepare("SELECT verdict FROM seat_identity_verdicts WHERE node_id = ?").get(node.id) as { verdict: string };
    const observed = { status: result.result.nodes[0]?.status, token: latest.resume_token, identity: verdict.verdict };
    if (mode === "delayed screen" || mode === "immediate screen") {
      expect(observed).toEqual({ status: "resumed", token, identity: "verified" });
    } else {
      expect(result.result.nodes[0]?.status).toBe("attention_required");
      const identityOnly = mode === "no usable screen" || mode === "trust gate";
      expect(verdict.verdict).toBe(identityOnly ? "verified" : "mismatch");
      if (identityOnly || mode === "shell only") {
        // 可保留尝试过的 UUID，但这并不能证明 conversation readiness。周期 identity 检查不得清除
        // 此启动失败。
        expect(db.prepare("SELECT startup_status, resume_provenance, resume_last_verified FROM sessions WHERE node_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(node.id))
          .toEqual({ startup_status: "attention_required", resume_provenance: null, resume_last_verified: null });
      }
    }
    expect(tmux.sendShellCommand).toHaveBeenCalledTimes(1);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  // NS-T05：R1——pod-aware restore 使用 launchHarness（而非旧 helper）。
  it("pod-aware restore 使用 launchHarness 执行 resume，而非旧 helper", async () => {
    // 创建 pod-aware rig。
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-1", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-1" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // 设置 resume token。
    sessionRegistry.updateResumeToken(session.id, "claude_id", "resume-token-123");
    // Startup context。
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    // Snapshot。
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    // 停止。
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchSpy = vi.fn(async () => ({ ok: true as const, resumeToken: "new-token", resumeType: "claude_id" }));
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: launchSpy,
    };

    // Claude resume spy——pod-aware node 不应调用它。
    const claudeResumeSpy = vi.fn(async () => ({ ok: true as const }));
    const claude = mockClaudeResume();
    (claude as any).resume = claudeResumeSpy;

    const orch = createOrchestrator({
      claude,
      listProcesses: nativeLineage("claude-code", "resume-token-123"),
    });
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // 应调用 launchHarness（pod-aware 路径）。
      expect(launchSpy).toHaveBeenCalled();
      // 不应调用旧 claude.resume。
      expect(claudeResumeSpy).not.toHaveBeenCalled();
      // node 应为 "resumed"。
      expect(result.result.nodes[0]!.status).toBe("resumed");
    }
  });

  it("pod-aware chooser attention 保留已尝试的 native token，以供无输入对账", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-chooser", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-chooser" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_id", "chooser-token-123");
    db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)",
    ).run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const hasSession = vi.fn(async () => false);
    const tmux = {
      ...mockTmux(),
      hasSession,
      capturePaneContent: vi.fn(async () => [
        "Claude Code v2.1.89",
        "",
        " ❯ accept edits on",
        "",
      ].join("\n")),
    } as unknown as TmuxAdapter;
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({
        ok: false as const,
        error: "Claude is at a resume-selection prompt",
        recovery: "attention_required" as const,
      })),
    };
    const orch = createOrchestrator({
      tmux,
      listProcesses: nativeLineage("claude-code", "chooser-token-123"),
    });

    const restored = await orch.restore(snap.id, { adapters: { "claude-code": adapter } });

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.result.nodes[0]?.status).toBe("attention_required");

    const latest = db.prepare(
      "SELECT startup_status, resume_type, resume_token FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    ).get(node.id) as { startup_status: string; resume_type: string | null; resume_token: string | null };
    expect(latest.startup_status).toBe("attention_required");
    expect(latest.resume_type).toBe("claude_id");
    expect(latest.resume_token).toBe("chooser-token-123");

    hasSession.mockResolvedValue(true);
    const reconciled = await orch.reconcileNodeRuntimeTruth(rig.id, node.id);
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) {
      expect(reconciled.from).toBe("attention_required");
      expect(reconciled.to).toBe("operator_recovered");
      expect(reconciled.evidence.resumeTokenUsed).toBe(true);
    }
  });

  // Slice 51-01 stub-runtime——仅测试 RED（无争议机械事实 4）：pod-aware restore 把 resume dispatch 到
  // runtime: stub 对应的真实 StubRuntimeAdapter，并经真实 launchHarness（随附 resume 路径，而非旧
  // helper 或改名 mock）到达 "resumed"。动态 import 使此文件其他测试保持绿色；当前为 RED，因为
  // adapter 模块缺失。import 后可完全执行：只导出 `StubRuntimeAdapter` 仍会失败（launchHarness 缺失/
  // 错误 ⇒ 未 resumed）。构造依赖暂由设计决定；到达 "resumed" 依赖 stub 的 hermetic 可测试性
  //（确定性/hermetic 设计性质）。这里不编码任何有争议的 surface。
  it("事实 4：pod-aware restore 把 resume dispatch 到真实 stub adapter（runtime: stub）", async () => {
    const { StubRuntimeAdapter } = await import("../src/adapters/stub-runtime-adapter.js") as { StubRuntimeAdapter: new (deps: unknown) => RuntimeAdapter }; // 当前 RED：模块缺失。
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-1", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "stub", podId: "pod-1" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "stub_id", "resume-token-123");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "stub");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const adapter = new StubRuntimeAdapter({ tmux: {} as unknown, runtime: "stub" });
    const launchSpy = vi.spyOn(adapter, "launchHarness");
    const result = await createOrchestrator().restore(snap.id, { adapters: { "stub": adapter } });
    expect(result.ok, "runtime: stub node 必须经真实 adapter 成功 restore").toBe(true);
    expect(launchSpy, "resume 必须经 stub adapter 的 launchHarness dispatch").toHaveBeenCalled();
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("resumed");
  });

  it("pod-aware resume 失败 -> status 'failed' 并带 startup 错误", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-fail", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-fail" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_id", "bad-token");
    db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: false as const, error: "Claude resume failed: no conversation found" })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("failed");
      expect(result.result.nodes[0]!.error).toContain("Claude resume failed");
    }
  });

  // NS-T05：R2——旧版 restore 使用旧 helper + skipHarnessLaunch。
  it("旧版 restore 使用旧 helper，而非 launchHarness", async () => {
    // 创建旧版 rig（无 podId）。
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_name", "test-name");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchSpy = vi.fn(async () => ({ ok: true as const }));
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: launchSpy,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    // 注意：旧版路径使用旧 claude-resume helper，随后以 skipHarnessLaunch: true 调用 startNode，
    // 因此不应调用 launchHarness（旧 helper resume 在 mock 下失败，但返回 baseStatus = failed）。
  });

  it("即使 startup context 可用，缺少 token 的旧版 Claude restore 仍失败", async () => {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET resume_type = ? WHERE id = ?").run("claude_id", session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchHarness = vi.fn(async () => ({ ok: true as const, resumeToken: "fresh-claude-token", resumeType: "claude_id" }));
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
      expect(result.result.nodes[0]!.error).toContain("没有可用令牌");
      expect(launchHarness).not.toHaveBeenCalled();
    }
  });

  it("无 startup context 时，缺少 token 的旧版 Claude restore 如实失败", async () => {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET resume_type = ? WHERE id = ?").run("claude_id", session.id);
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
      expect(result.result.nodes[0]!.error).toContain("没有可用令牌");
    }
  });

  it("pod-aware Claude restore 有 resume type 但缺少 token 时失败，而非全新启动", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-2", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "claude-code", podId: "pod-2" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // 设置 resumeType，但不设置 resumeToken。
    db.prepare("UPDATE sessions SET resume_type = ? WHERE id = ?").run("claude_id", session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "fresh-claude-token", resumeType: "claude_id" })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("awaiting-decision");
      expect(nodeResult!.error).toContain("没有可用令牌");
      expect(mockAdapter.launchHarness).not.toHaveBeenCalled();
    }
  });

  it("resume launch 证明已保存 session 消失时，pod-aware Claude restore 失败", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-claude-retry", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-claude-retry" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_id", "stale-claude-token");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchHarness = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "Claude resume failed: no conversation found for the requested session", recovery: "retry_fresh" })
      .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-claude-token", resumeType: "claude_id" });
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("failed");
      expect(nodeResult!.error).toContain("运行环境启动失败");
      expect(launchHarness).toHaveBeenCalledTimes(1);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBe("stale-claude-token");
    }
  });

  it("pod-aware Codex restore 有 resume type 但缺少 token 时失败，而非全新启动", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-missing", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", podId: "pod-codex-missing" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET resume_type = ? WHERE id = ?").run("codex_id", session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "fresh-codex-token", resumeType: "codex_id" })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("awaiting-decision");
      expect(nodeResult!.error).toContain("没有可用令牌");
      expect(mockAdapter.launchHarness).not.toHaveBeenCalled();
    }
  });

  it("resume launch 证明已保存 session 消失时，pod-aware Codex restore 失败", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-retry", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", podId: "pod-codex-retry" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "codex_id", "stale-codex-token");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchHarness = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "Codex resume failed: no saved session found for the requested session", recovery: "retry_fresh" })
      .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-codex-token", resumeType: "codex_id" });
    const mockAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("failed");
      expect(nodeResult!.error).toContain("运行环境启动失败");
      expect(launchHarness).toHaveBeenCalledTimes(1);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBe("stale-codex-token");
    }
  });

  it("即使后续 token 可能匹配，pod-aware Codex restore 也不会把 retry_fresh 视为 resumed", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-same-token", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", podId: "pod-codex-same-token" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "codex_id", "stable-codex-token");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchHarness = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "Codex resume failed: no saved session found for the requested session", recovery: "retry_fresh" })
      .mockResolvedValueOnce({ ok: true as const, resumeToken: "stable-codex-token", resumeType: "codex_id" });
    const mockAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("failed");
      expect(nodeResult!.error).toContain("运行环境启动失败");
      expect(result.result.warnings).not.toContain("Node dev.impl: resume was unavailable; launched fresh instead.");
      expect(launchHarness).toHaveBeenCalledTimes(1);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBe("stable-codex-token");
    }
  });

  it("即使存在 checkpoint，pod-aware Codex restore 仍会让请求的 resume 失败", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-codex-restore-"));
    try {
      const rig = rigRepo.createRig("test-rig");
      db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-rebuilt", rig.id, "Dev");
      const node = rigRepo.addNode(rig.id, "dev.ops", { runtime: "codex", podId: "pod-codex-rebuilt", cwd: tmpDir });
      const session = sessionRegistry.registerSession(node.id, "dev-ops@test-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateResumeToken(session.id, "codex_id", "stale-codex-token");
      checkpointStore.createCheckpoint(node.id, {
        summary: "Resume this Codex task from checkpoint",
        keyArtifacts: ["notes/todo.md"],
      });
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
      const snap = snapshotCapture.captureSnapshot(rig.id, "test");
      sessionRegistry.updateStatus(session.id, "exited");
      db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

      const launchHarness = vi.fn()
        .mockResolvedValueOnce({ ok: false as const, error: "Codex resume failed: no saved session found for the requested session", recovery: "retry_fresh" })
        .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-codex-token", resumeType: "codex_id" });
      const mockAdapter = {
        runtime: "codex",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
        checkReady: vi.fn(async () => ({ ready: true })),
        launchHarness,
      };

      const orch = createOrchestrator();
      const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
        expect(nodeResult!.status).toBe("failed");
        expect(nodeResult!.error).toContain("运行环境启动失败");
        expect(launchHarness).toHaveBeenCalledTimes(1);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("pod-aware restore 有此前 session 但无捕获 token 时进入 awaiting-decision，而非静默 fresh-prime（FR-7 Gap 1）", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-3", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.design", { runtime: "claude-code", podId: "pod-3" });
    const session = sessionRegistry.registerSession(node.id, "dev-design@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "fresh-token", resumeType: "claude_id" })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      // FR-7 Gap 1：有过 session 但没有捕获 token 的 pod-aware seat 必须停下询问（零 session
      // 启动），绝不能静默 fresh-prime 或替换 identity。
      expect(nodeResult!.status).toBe("awaiting-decision");
      expect(nodeResult!.error).toContain("--fresh");
      // 未启动 fresh harness——在 launch 前停止。
      expect(mockAdapter.launchHarness).not.toHaveBeenCalled();
    }
  });

  it("FR-7 Gap 2b：runtime adapter 不可用的 pod-aware resume seat 以 fail-closed 方式进入 awaiting-decision（非 fresh-primed）", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-2b", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.design", { runtime: "claude-code", podId: "pod-2b" });
    const session = sessionRegistry.registerSession(node.id, "dev-design@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // 存在真实捕获 token → 确实请求 resume（resume_if_possible + token）。
    db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-abc' WHERE id = ?").run(session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const orch = createOrchestrator();
    // adapters map 存在但不含 claude-code runtime → 无法验证 continuity
    //（node-subset-without-adapters 形态）。不得 fresh-prime。
    const result = await orch.restore(snap.id, { adapters: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("awaiting-decision");
      expect(nodeResult!.status).not.toBe("fresh-primed");
      expect(nodeResult!.error).toContain("--fresh");
    }
  });

  it("FR-7：对无 token seat 显式使用 --fresh 仍会 fresh-prime（只有 opt-in 才会 fresh-prime）", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-fresh", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.design", { runtime: "claude-code", podId: "pod-fresh" });
    const session = sessionRegistry.registerSession(node.id, "dev-design@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "fresh-token", resumeType: "claude_id" })),
    };
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter }, freshLogicalIds: ["dev.design"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      // --fresh 是唯一有意 fresh-prime——它绕过 FR-7 stop-and-ask。
      expect(nodeResult!.status).toBe("fresh-primed");
    }
  });

  // 由 codex-auth-refusal-attention-required slice（revision 2）更新：StartupOrchestrator 返回
  // `startupStatus: "attention_required"` 的 pod-aware node（任意需要关注的 readiness code：
  // update_gate、trust_gate、mcp_gate、login_required 或新的 codex_auth_refusal）现在会在
  // RestoreNodeResult 中如实呈现 `status: "attention_required"`，而非折叠为 "failed"。此前这是
  // 每个 slice 锁定的不诚实状态：测试名写着 "fails when ... update gate"，错误字符串却已写明
  // "Restore startup requires attention"，session row 的 startupStatus 也已经是
  // "attention_required"。此 patch 使 RestoreNodeResult status 与早已如实的 startupStatus 对齐。
  it("无 resume metadata 的 pod-aware Codex restore 在 fresh startup 遇到 update gate 时呈现 attention_required", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-update", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", podId: "pod-codex-update" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // FR-7：使用有意的 fresh launch（relaunch_fresh），以继续覆盖 fresh-startup update-gate 路径——
    // 无 token 的 resume_if_possible seat 现在会停下询问。
    db.prepare("UPDATE sessions SET restore_policy = 'relaunch_fresh' WHERE id = ?").run(session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({
        ready: false,
        code: "update_gate",
        reason: "Codex reached an update flow, so process-alive alone is not proof of a restored conversation.",
      })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("attention_required");
      expect(nodeResult!.error).toContain("恢复启动需要处理");
      expect(nodeResult!.error).toContain("Codex reached an update flow");
      // 按 restore-orchestrator.ts:65-67 的混合状态聚合，单个 attention_required node →
      // partially_restored（不是 failed）。
      expect(result.result.rigResult).toBe("partially_restored");
      expect(mockAdapter.launchHarness).toHaveBeenCalledTimes(1);
    }
    // OPR.0.5.7.1 修复子项：按 identity 选择已 restore 的 session（launch 留在 running 状态的 row），
    // 绝不按最新 ULID 推断——此 slice 消除的确切缺陷模式也不得以测试侧预期的形式残留。
    const nodeSessions = sessionRegistry.getSessionsForRig(rig.id).filter((s) => s.nodeId === node.id);
    const runningSessions = nodeSessions.filter((s) => s.status === "running");
    expect(runningSessions).toHaveLength(1);
    expect(runningSessions[0]?.startupStatus).toBe("attention_required");
  });

  it("restore 期间 fallback fresh launch 会重放 fresh_start startup action", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-4", rig.id, "Infra");
    const node = rigRepo.addNode(rig.id, "infra.ui", { runtime: "builtin:terminal", podId: "pod-4", cwd: "." });
    const session = sessionRegistry.registerSession(node.id, "infra-ui@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // FR-7：使用有意的 fresh launch（relaunch_fresh），以继续覆盖 fresh_start startup-action
    // 重放——无 token 的 resume_if_possible seat 现在会停下询问。
    db.prepare("UPDATE sessions SET restore_policy = 'relaunch_fresh' WHERE id = ?").run(session.id);
    db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(
      node.id,
      "[]",
      "[]",
      JSON.stringify([
        {
          type: "send_text",
          value: "npm run dev",
          phase: "after_ready",
          appliesOn: ["fresh_start"],
          idempotent: false,
        },
      ]),
      "builtin:terminal",
    );
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const tmux = mockTmux({
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
    });
    const mockAdapter = {
      runtime: "builtin:terminal",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };

    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id, { adapters: { "builtin:terminal": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("fresh-primed");
      expect(tmux.sendText).toHaveBeenCalledWith("infra-ui@test-rig", "npm run dev");
    }
  });

  it("restore 传播 launch warning，并写入带 snapshot ID 的 transcript 边界 marker", async () => {
    const snap = seedRigAndSnapshot({ resumeType: "none" });

    const { TranscriptStore } = await import("../src/domain/transcript-store.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-transcript-"));
    const transcriptStore = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });

    const tmux = mockTmux();
    // V1 预发布项 1：capture 通过 rotation 模块执行，其失败按 best-effort 静默处理（下一 tick 重试）。
    // 旧 "Transcript capture failed" launch-warning 路径不再触发；仅当 transcript 目录创建本身失败
    // 时才呈现结构性 transcript warning。无论 capture tick 结果如何，仍会在 launch 前写入边界 marker，
    // 并由下方断言验证。

    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, transcriptStore });
    const orch = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: mockClaudeResume(),
      codexResume: mockCodexResume(),
      transcriptStore,
    });

    // A1 前提：每个默认 seed node 捕获的 running occupant 都被 fresh-listed 操作 B 有意替换。
    const result = await orch.restore(snap.id, { freshLogicalIds: ["orchestrator", "worker-a", "worker-b"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 边界 marker 确实写入 transcript 文件。
      const rigDir = path.join(tmpDir, "r99");
      expect(fs.existsSync(rigDir)).toBe(true);

      // 检查至少一个 transcript 文件包含带 snapshot ID 的边界 marker。
      const transcriptFiles = fs.readdirSync(rigDir).filter((f) => f.endsWith(".log"));
      expect(transcriptFiles.length).toBeGreaterThan(0);
      const firstContent = fs.readFileSync(path.join(rigDir, transcriptFiles[0]!), "utf-8");
      expect(firstContent).toContain("--- SESSION BOUNDARY:");
      expect(firstContent).toContain(`尝试从快照 ${snap.id} 恢复`);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("已 restore 的 session 继承 OPENRIG_NODE_ID 与 OPENRIG_SESSION_NAME 环境变量", async () => {
    const snap = seedRigAndSnapshot({ resumeType: "none" });
    const createSessionSpy = vi.fn<(name: string, cwd?: string, env?: Record<string, string>) => Promise<{ ok: true }>>()
      .mockResolvedValue({ ok: true });
    const tmux = mockTmux();
    (tmux as unknown as Record<string, unknown>).createSession = createSessionSpy;

    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const orch = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: mockClaudeResume(),
      codexResume: mockCodexResume(),
    });

    // A1 前提：每个默认 seed node 捕获的 running occupant 都被 fresh-listed 操作 B 有意替换。
    const result = await orch.restore(snap.id, { freshLogicalIds: ["orchestrator", "worker-a", "worker-b"] });
    expect(result.ok).toBe(true);

    // 每次 createSession 调用都应收到环境变量。
    expect(createSessionSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of createSessionSpy.mock.calls) {
      const env = call[2];
      expect(env).toBeDefined();
      expect(env!.OPENRIG_NODE_ID).toBeTruthy();
      expect(env!.OPENRIG_SESSION_NAME).toBeTruthy();
    }
  });

  it("已 restore 的 session 在 snapshot node cwd 中启动 tmux", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-cwd-"));
    try {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: tmpDir }],
        resumeType: "none",
        edges: [],
      });
      const createSessionSpy = vi.fn<(name: string, cwd?: string, env?: Record<string, string>) => Promise<{ ok: true }>>()
        .mockResolvedValue({ ok: true });
      const tmux = mockTmux();
      (tmux as unknown as Record<string, unknown>).createSession = createSessionSpy;

      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orch = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResume(),
        codexResume: mockCodexResume(),
      });

      // A1 前提：有意 fresh（fresh-listed）。
      const result = await orch.restore(snap.id, { freshLogicalIds: ["worker"] });
      expect(result.ok).toBe(true);
      expect(createSessionSpy).toHaveBeenCalledWith(expect.any(String), tmpDir, expect.any(Object));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- Epic 3 D2：resume 失败时不静默 fallback fresh ---

  it("D2：旧版 node 使用 resume_if_possible 但缺少 token 时返回 failed，而非 fresh", async () => {
    const snapshot = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: null as unknown as string, // token 缺失。
      restorePolicy: "resume_if_possible",
    });

    const orchestrator = createOrchestrator();
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.result.nodes.find((n) => n.logicalId === "agent-a");
    expect(node).toBeDefined();
    // OPR.0.3.4.2：缺少 token 时 stop-and-ask 为 awaiting-decision（零 session），绝不静默 fresh。
    expect(node!.status).toBe("awaiting-decision");
  });

  it("D2：旧版 node 尝试 resume 但不可用时返回 failed，而非 fresh", async () => {
    const snapshot = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "stale-token-123",
      restorePolicy: "resume_if_possible",
    });

    const claudeResume = mockClaudeResume({ ok: false as const, error: "Session not found" });
    const orchestrator = createOrchestrator({ claude: claudeResume });
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.result.nodes.find((n) => n.logicalId === "agent-a");
    expect(node).toBeDefined();
    // OPR.0.3.4.2：resume 最终失败 -> 回滚到零 session、awaiting-decision（绝不静默 fresh）。
    expect(node!.status).toBe("awaiting-decision");
  });

  // --- Epic 3 D3：rig 级 restore 结果词汇 ---

  it("D3：所有 node 均 resumed → rigResult fully_restored", async () => {
    const snapshot = seedRigAndSnapshot({
      nodes: [
        { logicalId: "agent-a", role: "worker", runtime: "claude-code" },
        { logicalId: "agent-b", role: "worker", runtime: "claude-code" },
      ],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "token-123",
      restorePolicy: "resume_if_possible",
    });

    const orchestrator = createOrchestrator({
      listProcesses: nativeLineage("claude-code", "token-123"),
    });
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("fully_restored");
  });

  it("D3：resumed + failed 混合 → rigResult partially_restored", async () => {
    // 预置两个带 resume 的 node，一个成功、一个失败。
    const snapshot = seedRigAndSnapshot({
      nodes: [
        { logicalId: "agent-ok", role: "worker", runtime: "claude-code" },
        { logicalId: "agent-fail", role: "worker", runtime: "claude-code" },
      ],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "token-123",
      restorePolicy: "resume_if_possible",
    });

    // Claude resume 第一次调用成功，第二次失败。
    let callCount = 0;
    const claudeResume = {
      canResume: vi.fn((type: string | null) => type === "claude_name"),
      resume: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return { ok: true as const };
        return { ok: false as const, error: "Session expired" };
      }),
    } as unknown as ClaudeResumeAdapter;

    const orchestrator = createOrchestrator({ claude: claudeResume });
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("partially_restored");
  });

  it("D3：所有 node 均 stop-and-ask → rigResult partially_restored（awaiting-decision 不是 failed）", async () => {
    const snapshot = seedRigAndSnapshot({
      nodes: [
        { logicalId: "agent-a", role: "worker", runtime: "claude-code" },
        { logicalId: "agent-b", role: "worker", runtime: "claude-code" },
      ],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "token-123",
      restorePolicy: "resume_if_possible",
    });

    const claudeResume = mockClaudeResume({ ok: false as const, error: "All expired" });
    const orchestrator = createOrchestrator({ claude: claudeResume });
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("partially_restored");
  });

  it("D3：任意 fresh node 都会阻止 fully_restored", async () => {
    // 一个 node 全新启动（无 resume 数据）、其他 node 成功的 rig。
    const snapshot = seedRigAndSnapshot({
      nodes: [
        { logicalId: "agent-a", role: "worker", runtime: "claude-code" },
      ],
      resumeType: "none",
      edges: [],
      // resumeType "none" 记录一个没有可用 native resume source 的 occupant。
    });

    const orchestrator = createOrchestrator();
    // A1 前提：fresh node 是有意的（fresh-listed）——D3 聚合声明不变。
    const result = await orchestrator.restore(snapshot.id, { freshLogicalIds: ["agent-a"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.result.nodes.find((n) => n.logicalId === "agent-a");
    expect(node?.status).toBe("fresh-primed");
    // PM 定义的 D3 不变量：fresh node 会阻止 fully_restored。
    expect(result.result.rigResult).not.toBe("fully_restored");
    expect(result.result.rigResult).toBe("partially_restored");
  });

  it("D1/D4：缺少必需 startup 文件会在变化前阻塞 restore", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      resumeType: "none",
      edges: [],
    });
    const node = snap.data.nodes[0]!;
    const missingPath = "/tmp/openrig-missing-required-startup.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [],
        resolvedStartupFiles: [{
          path: "startup.md",
          absolutePath: missingPath,
          ownerRoot: "/tmp",
          deliveryHint: "guidance_merge",
          required: true,
          appliesOn: ["restore"],
        }],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const result = await createOrchestrator().restore(snapshot.id, {
      fsOps: { exists: (p) => p !== missingPath },
      // A1 前提：会消费 replay 的有意 fresh——校验必须阻塞。
      freshLogicalIds: ["agent-a"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pre_restore_validation_failed");
    expect(result.result.rigResult).toBe("not_attempted");
    expect(result.result.preRestoreSnapshotId).toBeNull();
    expect(result.result.nodes).toEqual([]);
    expect(result.result.blockers?.[0]).toMatchObject({
      code: "required_startup_file_missing",
      severity: "critical",
      logicalId: "agent-a",
      path: missingPath,
    });
    expect(result.result.blockers?.[0]?.remediation).toContain("恢复缺失的启动文件");
  });

  // OPR.0.3.4.5（behavior 09）：projection-validity != session continuity。陈旧/缺失 projection
  // 不会中止 restore；它会标记 projection_drift，而 restore 继续尝试 native resume。
  it("D1/D4 已更新：缺少 projection source 或 entry 不会中止 restore（标记 projection_drift，restore 继续）", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const node = snap.data.nodes[0]!;
    const missingSource = "/tmp/openrig-missing-agent-root";
    const missingEntry = "/tmp/openrig-missing-agent-root/skills/review/SKILL.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [{
          category: "skill",
          effectiveId: "review",
          sourceSpec: "local:agents/review",
          sourcePath: missingSource,
          resourcePath: "skills/review/SKILL.md",
          absolutePath: missingEntry,
        }],
        resolvedStartupFiles: [],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const result = await createOrchestrator().restore(snapshot.id, {
      fsOps: { exists: (p) => p !== missingSource && p !== missingEntry },
    });

    // restore 继续（不中止）——projection 陈旧是 warning，而非 blocker。
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).not.toBe("not_attempted");
    // projection drift 标记为 warning（compose slice-03 的 projection_drift 形态）。
    expect(result.result.warnings.some((w) => w.includes("projection_drift"))).toBe(true);
    expect(result.result.warnings.some((w) => w.includes(missingSource))).toBe(true);
    expect(result.result.warnings.some((w) => w.includes(missingEntry))).toBe(true);
  });

  it("OPR.0.3.4.5 (09)：陈旧 projection + 有效 resume token -> session RESUMES，并标记 projection_drift（native 优先于 fresh）", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
    });
    const node = snap.data.nodes[0]!;
    const missingEntry = "/tmp/openrig-stale-skill-05.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [{
          category: "skill",
          effectiveId: "stale-skill",
          sourceSpec: "local:agents/stale",
          sourcePath: "/tmp/openrig-stale-root",
          resourcePath: "skills/stale/SKILL.md",
          absolutePath: missingEntry,
        }],
        resolvedStartupFiles: [],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const orch = createOrchestrator({
      claude: mockClaudeResume({ ok: true }),
      listProcesses: nativeLineage("claude-code", "tok"),
    });
    const result = await orch.restore(snapshot.id, {
      fsOps: { exists: (p) => p !== missingEntry && p !== "/tmp/openrig-stale-root" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nodeResult = result.result.nodes.find((n) => n.logicalId === "worker");
    // session 已 RESUMED（native continuity 优先于 projection 陈旧）。
    expect(nodeResult!.status).toBe("resumed");
    // 标记 projection drift，绝不静默吞掉。
    expect(result.result.warnings.some((w) => w.includes("projection_drift"))).toBe(true);
    expect(result.result.warnings.some((w) => w.includes("stale-skill") || w.includes(missingEntry))).toBe(true);
  });

  it("OPR.0.3.4.5 (09)：缺少必需 startup 文件仍然失败（保留真正致命的 blocker）", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
    });
    const node = snap.data.nodes[0]!;
    const missingPath = "/tmp/openrig-missing-required-startup-05.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [],
        resolvedStartupFiles: [{
          path: "startup.md",
          absolutePath: missingPath,
          ownerRoot: "/tmp",
          deliveryHint: "guidance_merge",
          required: true,
          appliesOn: ["restore"],
        }],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const result = await createOrchestrator().restore(snapshot.id, {
      fsOps: { exists: (p) => p !== missingPath },
      // A1 前提：会消费 replay 的有意 fresh——真正致命的 blocker 必须成立。
      freshLogicalIds: ["agent-a"],
    });

    // 仍被阻塞（缺少必需 startup 文件确实致命）。
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pre_restore_validation_failed");
    expect(result.result.rigResult).toBe("not_attempted");
    expect(result.result.blockers?.[0]?.code).toBe("required_startup_file_missing");
  });

  it("D1/D4：checkpoint 对应 node 缺少 cwd 时，在 checkpoint 写入前阻塞", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
      withCheckpoint: "agent-a",
    });

    const result = await createOrchestrator().restore(snap.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pre_restore_validation_failed");
    expect(result.result.blockers?.[0]).toMatchObject({
      code: "checkpoint_missing_node_cwd",
      severity: "critical",
      logicalId: "agent-a",
    });
  });

  it("D1/D4：缺少可选 startup 文件属于 warning，而非 blocker", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      resumeType: "none",
      edges: [],
    });
    const node = snap.data.nodes[0]!;
    const missingPath = "/tmp/openrig-missing-optional-startup.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [],
        resolvedStartupFiles: [{
          path: "optional.md",
          absolutePath: missingPath,
          ownerRoot: "/tmp",
          deliveryHint: "guidance_merge",
          required: false,
          appliesOn: ["fresh_start"],
        }],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const adapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };
    const result = await createOrchestrator().restore(snapshot.id, {
      adapters: { "claude-code": adapter },
      fsOps: { exists: (p) => p !== missingPath },
      // A1 前提：会消费 replay 的有意 fresh——可选文件 warning 路径。
      freshLogicalIds: ["agent-a"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("partially_restored");
    expect(result.result.warnings.some((warning) => warning.includes("缺少可选启动文件"))).toBe(true);
  });

  it("D1/D4：校验阻塞不会发出 restore event 或改变陈旧 session", async () => {
    const rig = rigRepo.createRig("validation-block");
    const node = rigRepo.addNode(rig.id, "agent-a", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "agent-a@validation-block");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_name", "resume-token");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", JSON.stringify([{
      path: "required.md",
      absolutePath: "/tmp/openrig-missing-required-startup.md",
      ownerRoot: "/tmp",
      deliveryHint: "guidance_merge",
      required: true,
      appliesOn: ["restore"],
    }]), "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const tmux = mockTmux();
    const createSession = vi.fn(async () => ({ ok: true as const }));
    (tmux as unknown as Record<string, unknown>).createSession = createSession;
    const claude = mockClaudeResume();
    const orch = createOrchestrator({ tmux, claude });
    const result = await orch.restore(snap.id, {
      fsOps: { exists: (p) => !p.includes("openrig-missing-required-startup") },
      // A1 前提：fresh-listed 使 node 消费 replay——否则其可 resume session 会（正确地）跳过
      // 仅针对 replay 的校验。
      freshLogicalIds: ["agent-a"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result.rigResult).toBe("not_attempted");
    expect(createSession).not.toHaveBeenCalled();
    expect(claude.resume).not.toHaveBeenCalled();
    expect(snapshotRepo.listSnapshots(rig.id, { kind: "pre_restore" })).toHaveLength(0);
    const events = db.prepare("SELECT type FROM events WHERE rig_id = ?").all(rig.id) as { type: string }[];
    expect(events.map((event) => event.type)).not.toContain("restore.started");
    expect(events.map((event) => event.type)).not.toContain("restore.completed");
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string };
    expect(row.status).toBe("running");
  });

  // L3 决策 1：呈现 attempt id。
  describe("attempt id（L3）", () => {
    it("restore() 以持久化的 restore.started event seq 调用 onAttemptStarted", async () => {
      const orch = createOrchestrator();
      const snap = seedRigAndSnapshot();
      let receivedAttemptId: number | null = null;

      const outcome = await orch.restore(snap.id, {
        onAttemptStarted: (id) => { receivedAttemptId = id; },
      });

      expect(outcome.ok).toBe(true);
      expect(receivedAttemptId).not.toBeNull();
      expect(typeof receivedAttemptId).toBe("number");

      // attemptId 必须匹配可查询的 restore.started event seq。
      const startedRow = db
        .prepare("SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.started' ORDER BY seq DESC LIMIT 1")
        .get(snap.rigId) as { seq: number } | undefined;
      expect(startedRow?.seq).toBe(receivedAttemptId);
    });

    it("pre-restore 校验失败时不调用 onAttemptStarted（不发出 restore.started）", async () => {
      const orch = createOrchestrator();
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "orchestrator", role: "orchestrator", runtime: "claude-code", cwd: "/tmp" }],
        edges: [],
        withCheckpoint: "orchestrator",
      });
      // 强制 pre-restore 校验失败：清除 node cwd，使 checkpoint 阻塞 restore
      //（checkpoint_missing_node_cwd）。
      const data = JSON.parse(JSON.stringify(snap.data));
      data.nodes[0].cwd = null;
      db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

      let invoked = false;
      const outcome = await orch.restore(snap.id, {
        onAttemptStarted: () => { invoked = true; },
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("pre_restore_validation_failed");
      }
      expect(invoked).toBe(false);
    });
  });

  // L3 决策 3：runtime truth 对账。
  describe("reconcileNodeRuntimeTruth（L3）", () => {
    // Reconciler 专用 mock，将 `hasSession` 设为 vi.fn，方便各测试改变其行为。不能复用
    // `mockTmux()`，因为后者将 hasSession 接为普通 async function（88 个现有测试依赖该形态）。
    function mockTmuxForReconciler(): TmuxAdapter {
      return {
        createSession: vi.fn(async () => ({ ok: true as const })),
        killSession: vi.fn(async () => ({ ok: true as const })),
        sendText: vi.fn(async () => ({ ok: true as const })),
        sendKeys: vi.fn(async () => ({ ok: true as const })),
        getPaneCommand: vi.fn(async () => "claude"),
        getPanePid: vi.fn(async () => 1234),
        capturePaneContent: vi.fn(async () => ""),
        hasSession: vi.fn(async () => false),
        listSessions: async () => [],
        listWindows: async () => [],
        listPanes: async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }],
      } as unknown as TmuxAdapter;
    }

    const exactClaudeLineage = (token = "tok-abc-123") => async () => [
      { pid: 1234, ppid: 1, command: "zsh" },
      { pid: 1235, ppid: 1234, command: `claude.exe --resume ${token}` },
    ];

    let nextSeed = 90;
    function seedFailedAttempt(opts: {
      rigName?: string;
      logicalId?: string;
      runtime?: "claude-code" | "codex";
      restoreOutcome: "failed" | "attention_required";
      withResumeToken?: boolean;
      withBinding?: boolean;
    }) {
      // 使用规范名称，使新增用例不会超出旧版两位数 rig-name 范围。
      const rigName = opts.rigName ?? `r${nextSeed++}`;
      const logicalId = opts.logicalId ?? "worker";
      const runtime = opts.runtime ?? "claude-code";
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, logicalId, { role: "worker", runtime });

      // 绑定 tmux session name，供 reconciler 探测。
      const sessionName = `test-${logicalId}@${rigName}`;
      if (opts.withBinding ?? true) {
        sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
      }

      // 预置 session row，并按需附带 resume token。
      const sess = sessionRegistry.registerSession(node.id, sessionName);
      if (opts.withResumeToken) {
        db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ? WHERE id = ?")
          .run(runtime === "claude-code" ? "claude_id" : "codex_id", "tok-abc-123", sess.id);
      }

      // 预置带此 node outcome 的 restore.started 与 restore.completed event。
      eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-recon" });
      eventBus.emit({
        type: "restore.completed",
        rigId: rig.id,
        snapshotId: "snap-recon",
        result: {
          snapshotId: "snap-recon",
          preRestoreSnapshotId: null,
          rigResult: "partially_restored",
          nodes: [
            { nodeId: node.id, logicalId, status: opts.restoreOutcome },
          ],
          warnings: [],
        },
      });

      return { rig, nodeId: node.id, sessionName };
    }

    it.each([
      ["OpenAI Codex (v0.155.1)\n› continue", true],
      ["Update available!", false],
      ["Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.", false],
      ["Do you trust the contents of this directory?", false],
    ])("仅当内容可用时才在无输入情况下对账包装的 Codex：%s", async (content, usable) => {
      const tmux = mockTmuxForReconciler();
      vi.mocked(tmux.hasSession).mockResolvedValue(true);
      vi.mocked(tmux.getPaneCommand).mockResolvedValue("bash");
      vi.mocked(tmux.capturePaneContent).mockResolvedValue(String(content));
      const seeded = seedFailedAttempt({ runtime: "codex", restoreOutcome: "attention_required", withResumeToken: true });
      const oldEvent = db.prepare("SELECT payload FROM events WHERE type = 'restore.completed'").get();
      const listProcesses = async () => [
        { pid: 1234, ppid: 1, pgid: 1234, tpgid: 1235, command: "bash", executableName: "bash", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 1235, ppid: 1234, pgid: 1235, tpgid: 1235, command: "codex resume tok-abc-123", executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ];
      const result = await createOrchestrator({ tmux, listProcesses }).reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);
      expect(result.ok).toBe(usable);
      expect(tmux.sendKeys).not.toHaveBeenCalled();
      expect(tmux.sendText).not.toHaveBeenCalled();
      expect(db.prepare("SELECT payload FROM events WHERE type = 'restore.completed'").get()).toEqual(oldEvent);
      expect(db.prepare("SELECT * FROM events WHERE type = 'restore.outcome_reconciled'").all()).toHaveLength(usable ? 1 : 0);
    });

    it("四项前置条件全部满足时将 failed -> operator_recovered，并发出 audit event", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue([
        "Claude Code v2.1.89",
        "",
        " ❯ accept edits on",
        "",
      ].join("\n"));
      const orch = createOrchestrator({ tmux, listProcesses: exactClaudeLineage() });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(true);
      expect(tmux.sendKeys).not.toHaveBeenCalled();
      expect(tmux.sendText).not.toHaveBeenCalled();
      if (result.ok) {
        expect(result.from).toBe("failed");
        expect(result.to).toBe("operator_recovered");
        expect(result.evidence).toEqual({
          tmux: true,
          fgProcess: "claude",
          resumeTokenUsed: true,
          paneState: "usable",
        });
      }

      // audit event 存在。
      const reconciled = db.prepare(
        "SELECT * FROM events WHERE rig_id = ? AND type = 'restore.outcome_reconciled'"
      ).all(seeded.rig.id);
      expect(reconciled).toHaveLength(1);
    });

    it("全部前置条件满足时将 attention_required -> operator_recovered", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue([
        "Claude Code v2.1.89",
        "",
        " ❯ accept edits on",
      ].join("\n"));
      const orch = createOrchestrator({ tmux, listProcesses: exactClaudeLineage() });
      const seeded = seedFailedAttempt({ restoreOutcome: "attention_required", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.from).toBe("attention_required");
        expect(result.to).toBe("operator_recovered");
      }
    });

    it("audit trail：升级后，status=failed 的原始 restore.completed event 仍可查询", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Claude Code v2.1.89\n ❯ accept edits on");
      const orch = createOrchestrator({ tmux, listProcesses: exactClaudeLineage() });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      // 原始 restore.completed event 必须仍携带 failed 状态。
      const completed = db.prepare(
        "SELECT payload FROM events WHERE rig_id = ? AND type = 'restore.completed'"
      ).all(seeded.rig.id) as { payload: string }[];
      expect(completed).toHaveLength(1);
      const parsed = JSON.parse(completed[0]!.payload) as { result: { nodes: Array<{ status: string }> } };
      expect(parsed.result.nodes[0]!.status).toBe("failed");
    });

    it("tmux session 缺失时 no-op（前置条件 #1 失败）", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const orch = createOrchestrator({ tmux });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("tmux_session_missing");
      const reconciled = db.prepare(
        "SELECT * FROM events WHERE type = 'restore.outcome_reconciled'"
      ).all();
      expect(reconciled).toHaveLength(0);
    });

    it("前台进程不是 runtime 时 no-op（前置条件 #2 失败）", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh"); // shell，而非 claude/codex。
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("$ ");
      const orch = createOrchestrator({ tmux, listProcesses: exactClaudeLineage() });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("process_lineage_mismatch");
    });

    it("未使用 resume token 时 no-op（前置条件 #3 失败）", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Claude Code v2.1.89\n ❯ accept edits on");
      const orch = createOrchestrator({ tmux, listProcesses: exactClaudeLineage() });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: false });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_token_not_used");
    });

    it("pane 停在 Claude resume-selection prompt 时 no-op（前置条件 #4 失败）", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue([
        "Choose a conversation to resume:",
        "  1. project-foo",
        "  2. project-bar",
      ].join("\n"));
      const orch = createOrchestrator({ tmux, listProcesses: exactClaudeLineage() });
      const seeded = seedFailedAttempt({ restoreOutcome: "attention_required", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("pane_not_usable");
    });

    it("不会升级非 failed/attention_required 的 outcome", async () => {
      // 预置成功 resumed 的 outcome。Reconciler 应拒绝。
      const rig = rigRepo.createRig("r80");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      sessionRegistry.updateBinding(node.id, { tmuxSession: "r80-worker" });
      eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-x" });
      eventBus.emit({
        type: "restore.completed",
        rigId: rig.id,
        snapshotId: "snap-x",
        result: {
          snapshotId: "snap-x",
          preRestoreSnapshotId: null,
          rigResult: "fully_restored",
          nodes: [{ nodeId: node.id, logicalId: "worker", status: "resumed" }],
          warnings: [],
        },
      });

      const orch = createOrchestrator();
      const result = await orch.reconcileNodeRuntimeTruth(rig.id, node.id);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("outcome_not_upgradable");
    });

    it("rig 从未记录 restore.started 时拒绝", async () => {
      const rig = rigRepo.createRig("r81");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const orch = createOrchestrator();

      const result = await orch.reconcileNodeRuntimeTruth(rig.id, node.id);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_attempt");
    });

    it("绝不产生 'ready' 作为终止 outcome（决策 3 禁止）", async () => {
      // 即使所有前置条件都满足，升级目标仍是 operator_recovered。
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Claude Code v2.1.89\n ❯ accept edits on");
      const orch = createOrchestrator({ tmux, listProcesses: exactClaudeLineage() });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      if (result.ok) {
        expect(result.to).toBe("operator_recovered");
        expect(result.to).not.toBe("ready");
      } else {
        // 未升级也可以；关键是 `to` 从未成为 `ready`。
      }

      const reconciled = db.prepare(
        "SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'"
      ).all() as { payload: string }[];
      for (const row of reconciled) {
        const parsed = JSON.parse(row.payload) as { to: string };
        expect(parsed.to).toBe("operator_recovered");
        expect(parsed.to).not.toBe("ready");
      }
    });

    it("拒绝只有 executable name 或 token 错误的 process lineage", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude.exe");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Claude Code v2.1.89\n ❯ accept edits on");
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      const nameOnly = await createOrchestrator({
        tmux,
        listProcesses: async () => [{ pid: 1234, ppid: 1, command: "claude.exe" }],
      }).reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);
      const wrongToken = await createOrchestrator({
        tmux,
        listProcesses: exactClaudeLineage("wrong-token"),
      }).reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(nameOnly).toMatchObject({ ok: false, code: "process_lineage_mismatch" });
      expect(wrongToken).toMatchObject({ ok: false, code: "process_lineage_mismatch" });
      expect(db.prepare("SELECT * FROM events WHERE type = 'restore.outcome_reconciled'").all()).toHaveLength(0);
    });

    it("对同一 restore attempt 与 node 保持幂等", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude.exe");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Claude Code v2.1.89\n ❯ accept edits on");
      const orch = createOrchestrator({ tmux, listProcesses: exactClaudeLineage() });
      const seeded = seedFailedAttempt({ restoreOutcome: "attention_required", withResumeToken: true });

      expect((await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId)).ok).toBe(true);
      expect((await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId)).ok).toBe(true);

      expect(db.prepare("SELECT * FROM events WHERE type = 'restore.outcome_reconciled'").all()).toHaveLength(1);
    });
  });

  // === OPR.0.3.4.2——零 session 回归 guard（核心）===
  describe("OPR.0.3.4.2 awaiting-decision 零 session guard", () => {
    it("(A) 启动前：缺少 token -> awaiting-decision，且不调用 launchNode、session 列表不变", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        // 有意不提供 resumeToken。
      });
      const tmux = mockTmux();
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const launchSpy = vi.spyOn(nodeLauncher, "launchNode");
      const orch = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
      });

      const before = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
      const result = await orch.restore(snap.id);
      const after = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("awaiting-decision");
      expect(node.error).toContain("--fresh worker");
      // 零 session 启动：从未调用 launchNode，session 数量不变。
      expect(launchSpy).not.toHaveBeenCalled();
      expect(after.c).toBe(before.c);
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("(B) 启动后回滚：resume 最终失败 -> awaiting-decision，已启动 session 被 kill + superseded，恢复此前状态", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
        withBinding: "worker",
      });
      const tmux = mockTmux();
      const claude = mockClaudeResume({ ok: false as const, code: "resume_failed", message: "err" });
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("awaiting-decision");
      expect(node.error).toContain("已回退");
      // session 在流程中途存在（已 launch：调用 createSession），在终态时消失（调用 killSession）——
      // 用于区分 (B) 已回滚与 (A) 从未启动。
      expect((tmux.createSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      // node 不留下 running session row。
      const rig = rigRepo.listRigs()[0]!;
      const nodeRow = rigRepo.getRig(rig.id)!.nodes[0]!;
      const running = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE node_id = ? AND status = 'running'").get(nodeRow.id) as { c: number };
      expect(running.c).toBe(0);
      // 恢复此前 binding（restore 前的 tmux session name）。
      const binding = sessionRegistry.getBindingForNode(nodeRow.id);
      expect(binding?.tmuxSession).toBe("r99-worker");
    });

    it("(B) 启动后回滚且没有此前 binding：清除已启动 binding，无任何内容指向被 kill 的 session", async () => {
      // Guard BLOCKING dc16061c：priorState.binding === null。launch 创建了 binding；回滚必须删除它——
      // 留下指向已 kill session 的 binding 会违反零 session 契约。
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
        // 有意不提供 withBinding——node 没有此前 binding。
      });
      const nodeId = snap.data.nodes[0]!.id;
      expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
      const tmux = mockTmux();
      const claude = mockClaudeResume({ ok: false as const, code: "resume_failed", message: "err" });
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("awaiting-decision");
      // 流程中途启动，终态时 kill。
      expect((tmux.createSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      // node 不留下 running session row。
      const running = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE node_id = ? AND status = 'running'").get(nodeId) as { c: number };
      expect(running.c).toBe(0);
      // 核心 finding：已启动 binding 不得在回滚后残留。
      expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
    });

    it("(B) 启动后回滚：null 的此前 binding 字段不保留 launch row 数据（精确 restore，不部分 merge）", async () => {
      // Guard BLOCKING dc16061c item 3：此前 binding 存在，但含 null 字段（cmuxSurface）。若 launch
      // binding 数据在流程中途写入该字段，merge 式 restore 会保留它；精确 restore 必须将字段恢复为
      // 此前的 null。
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
        withBinding: "worker", // 此前 binding：只有 tmuxSession，cmuxSurface 为 null。
      });
      const nodeId = snap.data.nodes[0]!.id;
      const tmux = mockTmux();
      const claude = {
        canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
        resume: vi.fn(async () => {
          // 在 resume 最终失败前模拟 launch 后 binding 数据（merge 原本会保留的 launch row）。
          sessionRegistry.updateBinding(nodeId, { cmuxSurface: "launched-surface" });
          return { ok: false as const, code: "resume_failed", message: "err" };
        }),
      } as unknown as ClaudeResumeAdapter;
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
      const binding = sessionRegistry.getBindingForNode(nodeId);
      // 准确恢复此前 binding：tmuxSession 恢复，null 字段仍为 null。
      expect(binding?.tmuxSession).toBe("r99-worker");
      expect(binding?.cmuxSurface).toBeNull();
    });

    it("精确 GUARD：成功 resume 绝不会被自动 kill", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
      });
      const tmux = mockTmux();
      const orch = createOrchestrator2(
        tmux,
        mockClaudeResume({ ok: true as const }),
        nativeLineage("claude-code", "tok"),
      );

      const result = await orch.restore(snap.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("resumed");
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("边界：live 停放的 resume prompt 保持 attention_required（不 kill，绝不 awaiting-decision）", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
      });
      const tmux = mockTmux();
      const claude = mockClaudeResume({ ok: false as const, code: "attention_required", message: "resume selection prompt", evidence: "1. session-a\n2. session-b" } as never);
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("attention_required");
      expect(node.status).not.toBe("awaiting-decision");
      // live 停放 session 绝不会被 kill。
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("--fresh opt-in（操作 B）：列出的 seat 有意启动并报告 fresh-primed", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        // 无 token：若无 --fresh，此 seat 将为 awaiting-decision。
      });
      const tmux = mockTmux();
      const orch = createOrchestrator2(tmux, mockClaudeResume());

      const result = await orch.restore(snap.id, { freshLogicalIds: ["worker"] });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("fresh-primed");
      expect((tmux.createSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it("在可 resume seat 上使用 --fresh 也会 fresh-prime（操作员有意 override）", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
      });
      const tmux = mockTmux();
      const claude = mockClaudeResume({ ok: true as const });
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id, { freshLogicalIds: ["worker"] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("fresh-primed");
      // 有意跳过 resume 路径。
      expect((claude.resume as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("五项词汇：五个术语均为不同字符串", () => {
      const terms = ["resumed", "fresh-primed", "awaiting-decision", "attention_required", "failed"];
      expect(new Set(terms).size).toBe(5);
    });
  });

  // OPR.0.3.4.6——跨 surface 回归 guard：producer rollup。
  describe("OPR.0.3.4.6 如实 restore status rollup guard", () => {
    it("attention_required + awaiting-decision + mixed -> partially_restored，绝不为 failed", () => {
      const nodes = [
        { nodeId: "n1", logicalId: "a", status: "resumed" as const },
        { nodeId: "n2", logicalId: "b", status: "fresh-primed" as const },
        { nodeId: "n3", logicalId: "c", status: "awaiting-decision" as const },
        { nodeId: "n4", logicalId: "d", status: "attention_required" as const },
        { nodeId: "n5", logicalId: "e", status: "failed" as const },
      ];
      const result = rollupRestoreRigResult(nodes);
      expect(result).toBe("partially_restored");
      expect(result).not.toBe("failed");
    });

    it("只有 attention_required -> partially_restored（绝不折叠为 failed）", () => {
      const result = rollupRestoreRigResult([
        { nodeId: "n1", logicalId: "a", status: "attention_required" },
      ]);
      expect(result).toBe("partially_restored");
      expect(result).not.toBe("failed");
    });

    it("只有 awaiting-decision -> partially_restored（绝不折叠为 failed）", () => {
      const result = rollupRestoreRigResult([
        { nodeId: "n1", logicalId: "a", status: "awaiting-decision" },
      ]);
      expect(result).toBe("partially_restored");
      expect(result).not.toBe("failed");
    });

    it("全部 failed -> failed（仅保留给真正的全部失败）", () => {
      const result = rollupRestoreRigResult([
        { nodeId: "n1", logicalId: "a", status: "failed" },
        { nodeId: "n2", logicalId: "b", status: "failed" },
      ]);
      expect(result).toBe("failed");
    });

    it("全部 resumed -> fully_restored", () => {
      const result = rollupRestoreRigResult([
        { nodeId: "n1", logicalId: "a", status: "resumed" },
        { nodeId: "n2", logicalId: "b", status: "resumed" },
      ]);
      expect(result).toBe("fully_restored");
    });
  });

  // OPR.0.3.4.5——回归 guard。
  describe("OPR.0.3.4.5 回归 guard", () => {
    it("(05) CONSUMER human gate：Claude resume-selection menu -> 零次 sendKeys 选择调用 + attention_required", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
      });
      const tmux = mockTmux();
      const claude = mockClaudeResume({
        ok: false as const,
        code: "attention_required",
        message: "resume selection prompt",
        evidence: "1. session-a\n2. session-b",
      } as never);
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("attention_required");
      const sendKeysCalls = (tmux.sendKeys as ReturnType<typeof vi.fn>).mock.calls;
      const sendTextCalls = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of [...sendKeysCalls, ...sendTextCalls]) {
        const arg = String(call[1] ?? call[0] ?? "");
        expect(arg).not.toMatch(/^[0-9]+$/);
      }
    });

    it("(03) startup-replay gate：resumed seat 不接收 identity/onboarding 注入（gate 位于 concluded-fresh）", async () => {
      const rig = rigRepo.createRig("test-rig");
      db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-guard03", rig.id, "Dev");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-guard03" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateResumeToken(session.id, "claude_id", "resume-token-guard03");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(
        node.id, "[]", "[]",
        JSON.stringify([{
          type: "send_text",
          value: "OpenRig session identity: guard03-test-identity",
          phase: "after_ready",
          appliesOn: ["fresh_start"],
          builtin: "session_identity",
          idempotent: false,
        }]),
        "claude-code",
      );
      const snap = snapshotCapture.captureSnapshot(rig.id, "test");
      sessionRegistry.updateStatus(session.id, "exited");
      db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

      const launchHarness = vi.fn(async () => ({ ok: true as const, resumeToken: "resume-token-guard03", resumeType: "claude_id" }));
      const mockAdapter = {
        runtime: "claude-code",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
        checkReady: vi.fn(async () => ({ ready: true })),
        launchHarness,
      };
      const tmux = mockTmux();
      const orch = createOrchestrator({
        tmux,
        listProcesses: nativeLineage("claude-code", "resume-token-guard03"),
      });
      const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("resumed");
      const allSent = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1] ?? ""));
      expect(allSent.every((s) => !s.includes("OpenRig session identity:"))).toBe(true);
      expect((db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id=?").get(node.id) as {startup_actions_json:string}).startup_actions_json).toContain("guard03-test-identity");
    });
  });

  function createOrchestrator2(
    tmux: TmuxAdapter,
    claude: ClaudeResumeAdapter,
    listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>,
  ) {
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: claude, codexResume: mockCodexResume(), listProcesses,
    });
  }

  describe("OPR.0.4.3.20 FR-5——来自 binding row 的持久 resume-target pin", () => {
    // 预置单 node rig，其持久 binding name 可与 restore 重新推导的名称不同，并带有可 resume 的
    // snapshot session，使 restore 会启动（因而指向）一个 session。
    function seedSeat(opts: {
      logicalId: string;
      podAware?: boolean;
      boundName?: string | null; // string → 绑定该名称；null/undefined → 无 binding row。
      bindEmpty?: boolean;       // 创建不含 tmux_session 的 binding row。
    }): { rigId: string; nodeId: string; snapId: string } {
      const rig = rigRepo.createRig("r99");
      if (opts.podAware) {
        db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
          .run(`pod-${rig.id}`, rig.id, opts.logicalId.split(".")[0], "P");
      }
      const node = rigRepo.addNode(rig.id, opts.logicalId, {
        role: "worker", runtime: "claude-code", cwd: "/tmp",
        ...(opts.podAware ? { podId: `pod-${rig.id}` } : {}),
      });
      const sess = sessionRegistry.registerSession(node.id, "seed@r99-init");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
        .run("claude_id", "tok-abc", "resume_if_possible", sess.id);
      // A1 前提：occupancy 已明确陈述——capture 记录唯一 running row。
      sessionRegistry.updateStatus(sess.id, "running");
      if (typeof opts.boundName === "string") {
        sessionRegistry.updateBinding(node.id, { tmuxSession: opts.boundName });
      } else if (opts.bindEmpty) {
        sessionRegistry.updateBinding(node.id, { cmuxSurface: "s1" }); // binding row 存在，tmux_session 为 null。
      }
      const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
      return { rigId: rig.id, nodeId: node.id, snapId: snap.id };
    }

    function createdSessionNames(tmux: TmuxAdapter): string[] {
      return (tmux.createSession as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0] as string);
    }

    it("旧版 node：restore 使用持久绑定名称，而非重新推导名称", async () => {
      // 推导结果 = deriveSessionName("r99","worker-a") = "r99-worker-a"；binding 与其不同。
      const { snapId, nodeId } = seedSeat({ logicalId: "worker-a", boundName: "pinned-legacy@old-rig" });
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);

      const names = createdSessionNames(tmux);
      expect(names).toContain("pinned-legacy@old-rig"); // 已 pin 的目标。
      expect(names).not.toContain("r99-worker-a");       // 绝不使用重新推导的名称。
      // 已修复 drift amplifier：launcher 将已 pin 名称写回 binding。
      expect(sessionRegistry.getBindingForNode(nodeId)?.tmuxSession).toBe("pinned-legacy@old-rig");
    });

    it("pod-aware node：restore 使用持久绑定名称，而非重新推导的规范名称", async () => {
      // 推导结果 = deriveCanonicalSessionName("dev","driver","r99") = "dev-driver@r99"；
      // binding 与其不同。
      const { snapId } = seedSeat({ logicalId: "dev.driver", podAware: true, boundName: "pinned-pod@old-rig" });
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);

      const names = createdSessionNames(tmux);
      expect(names).toContain("pinned-pod@old-rig");
      expect(names).not.toContain("dev-driver@r99");
    });

    it("无 binding row：可观测地回退到推导名称", async () => {
      const { snapId } = seedSeat({ logicalId: "worker-a", boundName: null });
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);
      expect(createdSessionNames(tmux)).toContain("r99-worker-a"); // 推导回退。
      expect(result.result.warnings.some((w) => w.includes("FR-5") && w.includes("没有持久绑定"))).toBe(true);
    });

    it("binding row 的 tmux_session 为空：可观测地回退到推导名称", async () => {
      const { snapId } = seedSeat({ logicalId: "worker-a", bindEmpty: true });
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);
      expect(createdSessionNames(tmux)).toContain("r99-worker-a");
      expect(result.result.warnings.some((w) => w.includes("FR-5") && w.includes("没有持久绑定"))).toBe(true);
    });

    it("已 pin 名称无效：回退到推导名称，并带可观测 invalid-pin warning", async () => {
      const { snapId } = seedSeat({ logicalId: "worker-a", boundName: "bad name!" }); // validateSessionName 失败。
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);
      expect(createdSessionNames(tmux)).toContain("r99-worker-a");
      expect(result.result.warnings.some((w) => w.includes("FR-5") && w.includes("无效"))).toBe(true);
    });

    it("subset launch 呈现 FR-5 fallback warning（不丢弃）——API result + restore.subset_completed event", async () => {
      const { rigId } = seedSeat({ logicalId: "worker-a", boundName: null }); // 无 binding → FR-5 fallback。
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });
      const subsetEvents: Array<{ result?: { warnings?: string[] } }> = [];
      const unsub = eventBus.subscribe((e) => {
        if (e.type === "restore.subset_completed") subsetEvents.push(e as unknown as { result?: { warnings?: string[] } });
      });

      const result = await orch.launchNodeSubset(rigId, ["worker-a"]);
      unsub();

      expect(result.ok).toBe(true);
      expect(result.launched?.length ?? 0).toBeGreaterThan(0);
      // API result 携带聚合 warning（此前会被丢弃）。
      expect(result.warnings?.some((w) => w.includes("FR-5") && w.includes("没有持久绑定"))).toBe(true);
      // 外部可观测 event 也携带该 warning（此前为 warnings: []）。
      expect(subsetEvents[0]?.result?.warnings?.some((w) => w.includes("FR-5"))).toBe(true);
    });
  });
});
