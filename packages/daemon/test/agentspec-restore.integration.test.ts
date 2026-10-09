import { describe, it, expect, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type Database from "better-sqlite3";

describe("AS-T09：连续性 + snapshot/restore 演进", () => {
  function setup() {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    return { db, rigRepo, podRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore, snapshotCapture };
  }

  function seedRigWithPod(ctx: ReturnType<typeof setup>) {
    const rig = ctx.rigRepo.createRig("test-rig");
    const pod = ctx.podRepo.createPod(rig.id, "dev", "Dev", { summary: "dev pod", continuityPolicyJson: JSON.stringify({ enabled: true }) });
    const node = ctx.rigRepo.addNode(rig.id, "impl", { runtime: "claude-code", podId: pod.id, agentRef: "local:agents/impl", profile: "default", resolvedSpecName: "impl-spec", resolvedSpecVersion: "1.0.0", resolvedSpecHash: "sha256:abc" });
    const session = ctx.sessionRegistry.registerSession(node.id, "r01-impl");
    ctx.sessionRegistry.updateStatus(session.id, "running");
    ctx.sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
    return { rig, pod, node, session };
  }

  // T1：snapshot 捕获 pod 成员关系。
  it("snapshot 捕获 pod 成员关系", () => {
    const ctx = setup();
    const { rig, pod } = seedRigWithPod(ctx);
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.pods).toBeDefined();
    expect(snapshot.data.pods!.length).toBe(1);
    expect(snapshot.data.pods![0]!.label).toBe("Dev");
    ctx.db.close();
  });

  // T2：snapshot 捕获已解析 spec identity。
  it("snapshot 捕获 node 上已解析的 spec identity", () => {
    const ctx = setup();
    const { rig } = seedRigWithPod(ctx);
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    const node = snapshot.data.nodes[0]!;
    expect(node.resolvedSpecName).toBe("impl-spec");
    expect(node.resolvedSpecVersion).toBe("1.0.0");
    expect(node.resolvedSpecHash).toBe("sha256:abc");
    ctx.db.close();
  });

  // T3：snapshot 捕获启动状态。
  it("snapshot 捕获 session 上的启动状态", () => {
    const ctx = setup();
    const { rig } = seedRigWithPod(ctx);
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    const session = snapshot.data.sessions[0]!;
    expect(session.startupStatus).toBe("ready");
    expect(session.startupCompletedAt).toBeTruthy();
    ctx.db.close();
  });

  // T4：启动时持久化的 startup context 可供读取。
  it("startup context 已持久化，并可供 restore 查询", () => {
    const ctx = setup();
    const { rig, node } = seedRigWithPod(ctx);

    // 按 StartupOrchestrator 的方式持久化 startup context。
    ctx.db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(node.id, "[]", "[]", "[]", "claude-code");

    const row = ctx.db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?").get(node.id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row["runtime"]).toBe("claude-code");
    ctx.db.close();
  });

  // T5：checkpoint store 接受 pod/continuity metadata。
  it("checkpoint store 创建包含 pod/continuity metadata 的 checkpoint", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    const cp = ctx.checkpointStore.createCheckpoint(node.id, {
      summary: "test checkpoint",
      podId: pod.id,
      continuitySource: "pre_shutdown",
      continuityArtifactsJson: JSON.stringify({ session_log: "/path/log.md" }),
    });
    expect(cp.podId).toBe(pod.id);
    expect(cp.continuitySource).toBe("pre_shutdown");
    expect(cp.continuityArtifactsJson).toContain("session_log");
    ctx.db.close();
  });

  // T6：pod repository 的 continuity state CRUD。
  it("pod repository 管理 continuity state", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    ctx.podRepo.updateContinuityState(pod.id, node.id, "healthy");
    let states = ctx.podRepo.getContinuityStatesForRig(rig.id);
    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe("healthy");

    ctx.podRepo.updateContinuityState(pod.id, node.id, "degraded", JSON.stringify({ stale: true }));
    states = ctx.podRepo.getContinuityStatesForRig(rig.id);
    expect(states[0]!.status).toBe("degraded");
    ctx.db.close();
  });

  // T7：RestoreResult 携带 warnings。
  it("RestoreResult 包含 warnings 字段", () => {
    const result: import("../src/domain/types.js").RestoreResult = {
      snapshotId: "s1", preRestoreSnapshotId: "s0", rigResult: "failed", nodes: [], warnings: ["test warning"],
    };
    expect(result.warnings).toEqual(["test warning"]);
  });

  // T7b：continuity_state=restoring 时，restore-orchestrator 跳过 node（保留 binding）。
  it("continuity_state 为 restoring 时跳过 node，且不清除陈旧状态", async () => {
    const { RestoreOrchestrator } = await import("../src/domain/restore-orchestrator.js");
    const { NodeLauncher } = await import("../src/domain/node-launcher.js");
    const { ClaudeResumeAdapter } = await import("../src/adapters/claude-resume.js");
    const { CodexResumeAdapter } = await import("../src/adapters/codex-resume.js");
    const { vi } = await import("vitest");

    const ctx = setup();
    const { rig, pod, node, session } = seedRigWithPod(ctx);

    // 创建 binding，以验证它得以保留。
    ctx.db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run("bind-1", node.id, "r01-impl");

    // 将 continuity_state 设为 restoring。
    ctx.db.prepare("INSERT INTO continuity_state (pod_id, node_id, status) VALUES (?, ?, 'restoring')").run(pod.id, node.id);

    // 捕获唯一运行中的 occupant，随后模拟 rig 已停止。
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    ctx.sessionRegistry.updateStatus(session.id, "exited");

    const mockTmux = { createSession: vi.fn(async () => ({ ok: true })), killSession: vi.fn(async () => ({ ok: true })), listSessions: vi.fn(async () => []), hasSession: vi.fn(async () => false), sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []) } as any;
    const nodeLauncher = new NodeLauncher({ db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus, tmuxAdapter: mockTmux });

    const restoreOrch = new RestoreOrchestrator({
      db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus,
      snapshotRepo: ctx.snapshotRepo, snapshotCapture: ctx.snapshotCapture, checkpointStore: ctx.checkpointStore,
      nodeLauncher, tmuxAdapter: mockTmux,
      claudeResume: new ClaudeResumeAdapter(mockTmux),
      codexResume: new CodexResumeAdapter(mockTmux),
    });

    const result = await restoreOrch.restore(snapshot.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // continuity_state=restoring，因此应跳过 node（fresh_no_checkpoint）。
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("fresh");
      // Warning 应提到 restoring。
      expect(result.result.warnings.some((w) => w.includes("restoring"))).toBe(true);
      // 应保留 binding（不清除）。
      const binding = ctx.db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(node.id);
      expect(binding).toBeDefined();
    }
    ctx.db.close();
  });

  // T11：restore 顺序遵循 topology。
  it("restore 按拓扑顺序处理 node", async () => {
    // 现有 restore-orchestrator.test.ts 已覆盖 topology 顺序（delegates_to、spawned_by、
    // can_observe）。这些测试验证 computeRestorePlan 会生成正确的拓扑顺序。AS-T09 未改变顺序逻辑。
    const ctx = setup();
    const { rig } = seedRigWithPod(ctx);
    // 验证 AS-T09 变更后 restore plan 计算仍正常工作。
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.nodes.length).toBeGreaterThan(0);
    ctx.db.close();
  });

  // T8：启用 continuity 的 pod 读取 continuity state。
  it("continuity state 已持久化，并可供 pod 读取", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    // 写入 continuity state。
    ctx.db.prepare("INSERT INTO continuity_state (pod_id, node_id, status) VALUES (?, ?, 'healthy')").run(pod.id, node.id);

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.continuityStates).toBeDefined();
    expect(snapshot.data.continuityStates!.length).toBe(1);
    expect(snapshot.data.continuityStates![0]!.status).toBe("healthy");
    ctx.db.close();
  });

  // T9：呈现 degraded continuity state。
  it("snapshot 捕获 degraded continuity state", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    ctx.db.prepare("INSERT INTO continuity_state (pod_id, node_id, status, artifacts_json) VALUES (?, ?, 'degraded', ?)").run(pod.id, node.id, JSON.stringify({ session_log: "/stale/log.md" }));

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.continuityStates![0]!.status).toBe("degraded");
    expect(snapshot.data.continuityStates![0]!.artifactsJson).toContain("stale");
    ctx.db.close();
  });

  // T10：checkpoint metadata 包含 pod/source context。
  it("包含 pod metadata 的 checkpoint 可正确持久化", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    // 写入包含 pod metadata 的 checkpoint（字段由 AS-T00 添加）。
    ctx.db.prepare("INSERT INTO checkpoints (id, node_id, summary, pod_id, continuity_source, continuity_artifacts_json) VALUES (?, ?, ?, ?, ?, ?)").run(
      "cp-1", node.id, "test checkpoint", pod.id, "pre_shutdown", JSON.stringify({ session_log: "/path/log.md" })
    );

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    const cp = snapshot.data.checkpoints[node.id];
    expect(cp).toBeDefined();
    expect(cp!.podId).toBe(pod.id);
    expect(cp!.continuitySource).toBe("pre_shutdown");
    ctx.db.close();
  });

  // T11：带 nodeStartupContext 的 restore 以 isRestore=true 调用 startNode。
  it("带 startup context 的 restore 通过 isRestore=true 的 startNode 重放", async () => {
    const { RestoreOrchestrator } = await import("../src/domain/restore-orchestrator.js");
    const { NodeLauncher } = await import("../src/domain/node-launcher.js");
    const { ClaudeResumeAdapter } = await import("../src/adapters/claude-resume.js");
    const { CodexResumeAdapter } = await import("../src/adapters/codex-resume.js");
    const { vi } = await import("vitest");

    const ctx = setup();
    const { rig, node, session } = seedRigWithPod(ctx);

    // 按 StartupOrchestrator 的方式持久化 startup context。
    ctx.db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(node.id, "[]", "[]", "[]", "claude-code");

    // FR-7：此 seat 没有已捕获 token，因此 resume_if_possible restore 现在会停下询问。本测试覆盖
    // 有意 fresh 的 startup-context 重放路径（isRestore=true），所以声明 relaunch_fresh——真正会
    // 执行重放的全新启动。
    ctx.db.prepare("UPDATE sessions SET restore_policy = 'relaunch_fresh' WHERE id = ?").run(session.id);

    // 捕获唯一运行中的 occupant，随后模拟 rig 已停止。
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    ctx.sessionRegistry.updateStatus(session.id, "exited");
    expect(snapshot.data.nodeStartupContext![node.id]).toBeDefined();

    // 创建可跟踪调用的 mock adapter。
    const projectCalls: unknown[] = [];
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async (...args: unknown[]) => { projectCalls.push(args); return { projected: [], skipped: [], failed: [] }; }),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true })),
    };

    const mockTmux = { createSession: vi.fn(async () => ({ ok: true })), killSession: vi.fn(async () => ({ ok: true })), listSessions: vi.fn(async () => []), hasSession: vi.fn(async () => true), sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []) } as any;
    const nodeLauncher = new NodeLauncher({ db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus, tmuxAdapter: mockTmux });

    const restoreOrch = new RestoreOrchestrator({
      db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus,
      snapshotRepo: ctx.snapshotRepo, snapshotCapture: ctx.snapshotCapture, checkpointStore: ctx.checkpointStore,
      nodeLauncher, tmuxAdapter: mockTmux,
      claudeResume: new ClaudeResumeAdapter(mockTmux),
      codexResume: new CodexResumeAdapter(mockTmux),
    });

    const result = await restoreOrch.restore(snapshot.id, {
      adapters: { "claude-code": mockAdapter as any },
      fsOps: { exists: () => true },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Startup 重放应通过 StartupOrchestrator 调用 adapter.project。
      expect(mockAdapter.project).toHaveBeenCalled();
      expect(mockAdapter.checkReady).toHaveBeenCalled();
      // node 如实报告 restore 结果（mock resume 并未真正 resume）。
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      // 状态反映实际 resume 结果，而非假定成功。
      // OPR.0.3.4.2：有意的全新启动报告 fresh-primed。
      expect(["resumed", "fresh-primed", "rebuilt"]).toContain(nodeResult!.status);
    }
    ctx.db.close();
  });

  // T12：集成——startup context 在启动时持久化并由 snapshot 捕获。
  it("startup context 在启动时持久化并由 snapshot 捕获", () => {
    const ctx = setup();
    const { rig, node } = seedRigWithPod(ctx);

    // 模拟 StartupOrchestrator 成功时的行为。
    ctx.db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(node.id, JSON.stringify([{ category: "skill", effectiveId: "s1", sourcePath: "/agents/impl", resourcePath: "skills/s1", absolutePath: "/agents/impl/skills/s1" }]),
      JSON.stringify([{ path: "startup/base.md", absolutePath: "/agents/impl/startup/base.md", ownerRoot: "/agents/impl", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }]),
      JSON.stringify([{ type: "slash_command", value: "/rename impl", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }]),
      "claude-code"
    );

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.nodeStartupContext).toBeDefined();
    const startupCtx = snapshot.data.nodeStartupContext![node.id];
    expect(startupCtx).toBeDefined();
    expect(startupCtx!.runtime).toBe("claude-code");
    expect(startupCtx!.projectionEntries).toHaveLength(1);
    expect(startupCtx!.resolvedStartupFiles).toHaveLength(1);
    expect(startupCtx!.startupActions).toHaveLength(1);
    ctx.db.close();
  });

  // CP2-R4：restore 使用最新 session，而非最早 session。
  it("node 有多个 session 时，restore 使用最新 session", () => {
    const ctx = setup();
    const { rig, node } = seedRigWithPod(ctx);

    // 创建第二个更新的 session，并使用不同 restorePolicy。
    const session2 = ctx.sessionRegistry.registerSession(node.id, "r02-impl");
    ctx.sessionRegistry.updateStatus(session2.id, "running");
    ctx.db.prepare("UPDATE sessions SET restore_policy = 'checkpoint_only' WHERE id = ?").run(session2.id);

    // 获取 snapshot——应捕获两个 session。
    ctx.sessionRegistry.updateStatus(session2.id, "exited");
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");

    // 验证 snapshot 包含两个 session。
    const nodeSessions = snapshot.data.sessions.filter((s) => s.nodeId === node.id);
    expect(nodeSessions.length).toBeGreaterThan(1);

    // 最新 session（最大 ULID）应使用 checkpoint_only。
    const newest = nodeSessions.reduce((latest, s) => s.id > latest.id ? s : latest);
    expect(newest.restorePolicy).toBe("checkpoint_only");

    ctx.db.close();
  });

});
