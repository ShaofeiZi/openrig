import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { createFullTestDb, createTestApp, mockTmuxAdapter } from "./helpers/test-app.js";

function unavailableCmux() {
  const factory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  return new CmuxAdapter(factory, { timeoutMs: 50 });
}

function connectedCmux() {
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string) => {
      if (method === "capabilities") return { capabilities: ["surface.focus"] };
      return { ok: true };
    },
    close: () => {},
  });
  return new CmuxAdapter(factory, { timeoutMs: 1000 });
}

function failingCmux(failOn: string) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "capabilities") return { capabilities: ["surface.focus", "surface.create", "workspace.current"] };
      if (method === failOn) throw new Error(`${failOn} failed: connection lost`);
      if (method === "workspace.current") return { workspace_id: "workspace:1" };
      if (method === "surface.create") return { created_surface_ref: "surface:99" };
      return {};
    },
    close: () => {},
  });
  const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
  return { adapter, calls };
}

function trackingCmux() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "capabilities") return { capabilities: ["surface.focus", "surface.create", "workspace.current"] };
      if (method === "workspace.current") return { workspace_id: "workspace:1" };
      if (method === "surface.create") return { created_surface_ref: "surface:99" };
      return {};
    },
    close: () => {},
  });
  const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
  return { adapter, calls };
}

function staleBindingCmux() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const factory: CmuxTransportFactory = async () => ({
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "capabilities") return { capabilities: ["surface.focus", "surface.create", "workspace.current"] };
      if (method === "surface.focus") {
        const surfaceId = String((params as Record<string, unknown> | undefined)?.["surfaceId"] ?? "");
        if (surfaceId === "OK surface:78 pane:2 workspace:1") {
          throw new Error("Invalid surface handle: OK surface:78 pane:2 workspace:1");
        }
        return {};
      }
      if (method === "workspace.current") return { workspace_id: "workspace:1" };
      if (method === "surface.create") return { created_surface_ref: "surface:99" };
      return {};
    },
    close: () => {},
  });
  const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
  return { adapter, calls };
}

describe("会话路由", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/rigs/:rigId/sessions → 会话列表", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");

    const res = await app.request(`/api/rigs/${rig.id}/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].sessionName).toBe("r01-dev1-impl");
  });

  it("POST clear-attention 将旧版零号尝试协调重新限定到真实恢复尝试", async () => {
    const tmux = {
      ...mockTmuxAdapter(),
      hasSession: vi.fn(async () => true),
      listPanes: vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
      getPanePid: vi.fn(async () => 1234),
      getPaneCommand: vi.fn(async () => "claude"),
      capturePaneContent: vi.fn(async () => "Claude Code v2.1.89\n ❯ accept edits on"),
    } as unknown as TmuxAdapter;
    const { app, rigRepo, sessionRegistry, eventBus } = createTestApp(db, {
      tmux,
      listProcesses: async () => [
        { pid: 1234, ppid: 1, command: "zsh" },
        { pid: 1235, ppid: 1234, command: "claude.exe --resume tok-abc-123" },
      ],
    });
    const rig = rigRepo.createRig("r90");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    const sessionName = "r90-worker";
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = ? WHERE id = ?")
      .run("tok-abc-123", session.id);
    const started = eventBus.emit({
      type: "restore.started",
      rigId: rig.id,
      snapshotId: "snap-1",
      intendedRoster: [{ nodeId: node.id, logicalId: "worker" }],
    });
    eventBus.emit({
      type: "restore.completed",
      rigId: rig.id,
      snapshotId: "snap-1",
      result: {
        snapshotId: "snap-1",
        preRestoreSnapshotId: null,
        rigResult: "partially_restored",
        nodes: [{ nodeId: node.id, logicalId: "worker", status: "attention_required" }],
        warnings: [],
      },
    });
    eventBus.emit({
      type: "restore.outcome_reconciled",
      rigId: rig.id,
      nodeId: node.id,
      attemptId: 0,
      from: "attention_required",
      to: "operator_recovered",
      evidence: { source: "clear_attention_evidence", kind: "fresh_activity", runtimeCwdVerified: false },
    });

    const cleared = await app.request(`/api/sessions/${encodeURIComponent(sessionName)}/clear-attention`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      ok: true,
      clearedBy: "evidence",
      clearedClasses: ["restore_outcome"],
      derivedEvidence: {
        source: "restore_runtime_truth",
        attemptId: started.seq,
        resumeTokenUsed: true,
      },
    });

    const status = await app.request(`/api/rigs/${rig.id}/restore/status/${started.seq}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      ok: true,
      attemptId: started.seq,
      currentIntendedSetVerdict: "fully_restored",
      reconciliations: [{ nodeId: node.id, to: "operator_recovered" }],
    });
    const reconciliations = db.prepare(
      "SELECT json_extract(payload, '$.attemptId') AS attemptId FROM events WHERE type = 'restore.outcome_reconciled' ORDER BY seq",
    ).all() as Array<{ attemptId: number }>;
    expect(reconciliations.map((row) => row.attemptId)).toEqual([0, started.seq]);
  });

  it("POST .../launch → 201 + sessionName + session + binding，且 binding.tmuxSession === sessionName", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl", { role: "worker" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionName).toBe("r01-dev1-impl");
    expect(body.session).toBeDefined();
    expect(body.session.sessionName).toBe("r01-dev1-impl");
    expect(body.binding).toBeDefined();
    expect(body.binding.tmuxSession).toBe("r01-dev1-impl");
    expect(body.binding.tmuxSession).toBe(body.sessionName);
  });

  it("POST .../launch 已绑定 → 409", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("POST .../launch 节点不存在 → 404", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("r01");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/nonexistent/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("POST .../launch 使用普通工作组名称时规范化为 r00-managed 会话名", async () => {
    const { app, rigRepo } = createTestApp(db);
    // 普通工作组名称规范化到托管的 r00- 命名空间。
    const rig = rigRepo.createRig("badname");
    rigRepo.addNode(rig.id, "worker");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/worker/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionName).toBe("r00-badname-worker");
    expect(body.session.sessionName).toBe("r00-badname-worker");
    expect(body.binding.tmuxSession).toBe("r00-badname-worker");
  });

  it("POST .../launch 通过 launchNodeSubset 路由感知 pod 的节点（OPR.0.3.4.11）", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const rig = rigRepo.createRig("pod-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Development");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/impl",
      profile: "default",
    });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}/launch`, {
      method: "POST",
    });

    const body = await res.json();
    // 没有可用快照时，launchNodeSubset 返回 no_usable_snapshot。
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_usable_snapshot");
  });

  // OPR.0.4.3.28 修正——反转“未知时失败关闭”。tmux 存活探测失败并非席位存活的确证，
  // 因此 launch 路由不再强制返回 503；它继续启动并公开非阻塞 liveness_probe_unknown
  // 警告（验证无占位）。
  it("POST .../launch 在 tmux 探测失败时不返回 503——带存活警告启动（OPR.0.4.3.28 反转）", async () => {
    const tmuxMock = {
      createSession: vi.fn(async () => true),
      hasSession: vi.fn(async () => { throw new Error("tmux unavailable"); }),
      sendKeys: vi.fn(async () => {}),
      capturePaneContent: vi.fn(async () => ""),
      getPaneCommand: vi.fn(async () => null),
      getSessionStatus: vi.fn(async () => null),
      waitForReady: vi.fn(async () => true),
      listSessions: vi.fn(async () => []),
      startPipePane: vi.fn(async () => true),
      killSession: vi.fn(async () => {}),
    };
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { tmux: tmuxMock as any });
    const podRepo = new PodRepository(db);
    const rig = rigRepo.createRig("probe-fail-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Development");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/impl",
      profile: "default",
    });
    // 预置运行中会话和可用快照，使 launchNodeSubset 到达探针。
    const session = sessionRegistry.registerSession(node.id, "dev-impl@probe-fail-rig");
    sessionRegistry.updateStatus(session.id, "running");
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    const snapRepo = new SnapshotRepository(db);
    snapRepo.createSnapshot(rig.id, "manual", {
      rig: { id: rig.id, name: "probe-fail-rig" },
      nodes: [{ id: node.id, logicalId: "dev.impl", rigId: rig.id, runtime: "claude-code", podId: pod.id }],
      sessions: [{ id: session.id, nodeId: node.id, sessionName: "dev-impl@probe-fail-rig", status: "running", resumeType: "claude-native", resumeToken: "tok" }],
      edges: [],
      checkpoints: {},
    } as any);

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}/launch`, {
      method: "POST",
    });

    // 不再以强制 503 / target_liveness_unknown 默认拒绝。
    expect(res.status).not.toBe(503);
    const body = await res.json();
    expect(body.code).not.toBe("target_liveness_unknown");
    // 存活不确定性显示为非阻塞警告，绝不成为阻塞项。
    expect((body.warnings ?? []).some((w: string) => w.includes("liveness_probe_unknown"))).toBe(true);
  });

  it("没有快照时 POST .../nodes/launch-subset 返回 no_usable_snapshot", async () => {
    const { app, rigRepo } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const rig = rigRepo.createRig("subset-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Development");
    rigRepo.addNode(rig.id, "dev.driver", { runtime: "claude-code", podId: pod.id });
    rigRepo.addNode(rig.id, "dev.guard", { runtime: "codex", podId: pod.id });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: ["dev.driver", "dev.guard"] }),
    });

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_usable_snapshot");
  });

  it("有可用快照时 POST .../nodes/launch-subset 启动多个目标（OPR.0.3.4.11）", async () => {
    const { app, rigRepo } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const rig = rigRepo.createRig("multi-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Development");
    const n1 = rigRepo.addNode(rig.id, "dev.driver", { runtime: "claude-code", podId: pod.id });
    const n2 = rigRepo.addNode(rig.id, "dev.guard", { runtime: "codex", podId: pod.id });
    // 预置可用快照。
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    const snapRepo = new SnapshotRepository(db);
    snapRepo.createSnapshot(rig.id, "manual", {
      rig: { id: rig.id, name: "multi-rig" },
      nodes: [
        { id: n1.id, logicalId: "dev.driver", rigId: rig.id, runtime: "claude-code", podId: pod.id },
        { id: n2.id, logicalId: "dev.guard", rigId: rig.id, runtime: "codex", podId: pod.id },
      ],
      sessions: [
        // 有意全新启动（relaunch_fresh）→ 真正成功的启动。FR-7：有 token 但没有适配器
        // 可验证的 resume_if_possible 席位会转为 awaiting-decision（由下一测试覆盖）。
        { id: "s1", nodeId: n1.id, sessionName: "dev-driver@multi-rig", status: "running", resumeType: "claude-native", resumeToken: "t1", restorePolicy: "relaunch_fresh" },
        { id: "s2", nodeId: n2.id, sessionName: "dev-guard@multi-rig", status: "running", resumeType: "codex-native", resumeToken: "t2", restorePolicy: "relaunch_fresh" },
      ],
      edges: [],
      checkpoints: {},
    } as any);

    const res = await app.request(`/api/rigs/${rig.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: ["dev.driver", "dev.guard"], holdReason: "test" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.launched).toHaveLength(2);
    const launchedIds = body.launched.map((n: { logicalId: string }) => n.logicalId).sort();
    expect(launchedIds).toEqual(["dev.driver", "dev.guard"]);

    // 验证 restore.subset_completed 随两个节点一起发出。
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.subset_completed'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    const eventIds = payload.result.nodes.map((n: { logicalId: string }) => n.logicalId).sort();
    expect(eventIds).toEqual(["dev.driver", "dev.guard"]);
  });

  it("POST .../nodes/launch-subset 计划在变更前公开非目标影响", async () => {
    const { app, rigRepo } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const rig = rigRepo.createRig("plan-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Development");
    const driver = rigRepo.addNode(rig.id, "dev.driver", { runtime: "claude-code", podId: pod.id });
    const guard = rigRepo.addNode(rig.id, "dev.guard", { runtime: "codex", podId: pod.id });
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    new SnapshotRepository(db).createSnapshot(rig.id, "manual", {
      rig: { id: rig.id, name: "plan-rig" },
      nodes: [driver, guard],
      sessions: [],
      edges: [],
      checkpoints: {},
    } as any);
    const before = {
      sessions: db.prepare("SELECT COUNT(*) AS n FROM sessions").get(),
      events: db.prepare("SELECT COUNT(*) AS n FROM events").get(),
    };

    const res = await app.request(`/api/rigs/${rig.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: ["dev.driver"], holdReason: "operator hold", plan: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      planOnly: true,
      targetNodes: [{ logicalId: "dev.driver" }],
      nonTargetEffects: {
        mode: "detach_and_hold",
        affected: [{ logicalId: "dev.guard", reason: "operator hold" }],
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual(before.sessions);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(before.events);
  });

  it("POST .../nodes/launch-subset 不把 awaiting-decision 恢复报告为成功启动（FR-7）", async () => {
    const { app, rigRepo } = createTestApp(db);
    const podRepo = new PodRepository(db);
    const rig = rigRepo.createRig("fr7-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Development");
    const n1 = rigRepo.addNode(rig.id, "dev.driver", { runtime: "claude-code", podId: pod.id });
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    const snapRepo = new SnapshotRepository(db);
    snapRepo.createSnapshot(rig.id, "manual", {
      rig: { id: rig.id, name: "fr7-rig" },
      nodes: [{ id: n1.id, logicalId: "dev.driver", rigId: rig.id, runtime: "claude-code", podId: pod.id }],
      // resume_if_possible + token，但路由 harness 未接入运行时适配器 → 无法验证连续性
      // → 席位进入 awaiting-decision，而不是返回 201。
      sessions: [{ id: "s1", nodeId: n1.id, sessionName: "dev-driver@fr7-rig", status: "running", resumeType: "claude-native", resumeToken: "t1", restorePolicy: "resume_if_possible" }],
      edges: [],
      checkpoints: {},
    } as any);

    const res = await app.request(`/api/rigs/${rig.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: ["dev.driver"] }),
    });

    // FR-7：没有运行中会话的目标不得报告为成功启动。
    expect(res.status).not.toBe(201);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    const driver = body.launched.find((n: { logicalId: string; status: string }) => n.logicalId === "dev.driver");
    expect(driver.status).toBe("awaiting-decision");
  });

  it("POST .../nodes/launch-subset 拒绝空 seats 数组", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("empty-rig");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/launch-subset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seats: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("invalid_request");
  });

  it("POST .../focus 使用有效 cmux 绑定 → 调用 focusSurface", async () => {
    const cmux = connectedCmux();
    await cmux.connect();
    const focusSpy = vi.spyOn(cmux, "focusSurface");
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.updateBinding(node.id, { cmuxSurface: "surface-42" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // 证明 focusSurface 确实以正确 surface ID 调用。
    expect(focusSpy).toHaveBeenCalledOnce();
    expect(focusSpy).toHaveBeenCalledWith("surface-42");
  });

  it("POST .../focus 节点没有 cmux surface → 409，且不调用 cmux", async () => {
    const cmux = connectedCmux();
    await cmux.connect();
    const focusSpy = vi.spyOn(cmux, "focusSurface");
    const { app, rigRepo } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "dev1-impl");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    // 证明未调用 focusSurface。
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("POST .../focus logicalId 不存在 → 404", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("r01");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/nonexistent/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("POST .../focus cmux 不可用 → 200 { ok: false, code: 'unavailable' }", async () => {
    const cmux = unavailableCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.updateBinding(node.id, { cmuxSurface: "surface-42" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/focus`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unavailable");
  });

  // -- open-cmux 测试 --

  it("POST .../open-cmux 存在 cmuxSurface → focused_existing，无创建/发送副作用", async () => {
    const { adapter: cmux, calls } = trackingCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { cmuxSurface: "surface:42", cmuxWorkspace: "workspace:1" });

    // 清除连接期间的 capability 调用。
    calls.length = 0;

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("focused_existing");

    // 应只调用 focusSurface——不创建、不发送、不调用 workspace.current。
    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain("surface.focus");
    expect(methodNames).not.toContain("surface.create");
    expect(methodNames).not.toContain("surface.sendText");
    expect(methodNames).not.toContain("workspace.current");
  });

  it("POST .../open-cmux 现有 cmuxSurface 已过期 → 重新创建、绑定并聚焦新 surface", async () => {
    const { adapter: cmux, calls } = staleBindingCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "tmux",
      tmuxSession: "r01-dev1-impl",
      cmuxWorkspace: "workspace:old",
      cmuxSurface: "OK surface:78 pane:2 workspace:1",
    });

    calls.length = 0;

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_new");

    const methodNames = calls.map((c) => c.method);
    expect(methodNames.filter((name) => name === "surface.focus")).toHaveLength(2);
    expect(methodNames).toContain("workspace.current");
    expect(methodNames).toContain("surface.create");
    expect(methodNames).toContain("surface.sendText");

    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxWorkspace).toBe("workspace:1");
    expect(binding?.cmuxSurface).toBe("surface:99");
  });

  it("POST .../open-cmux 由 tmux 支持的节点没有 cmuxSurface → created_new，绑定工作区与 surface，并发送 tmux attach", async () => {
    const { adapter: cmux, calls } = trackingCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl", attachmentType: "tmux" });

    calls.length = 0;

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_new");

    // 必须以 currentWorkspace 为锚点，而非创建新工作区。
    const methodNames = calls.map((c) => c.method);
    expect(methodNames).toContain("workspace.current");
    expect(methodNames).toContain("surface.create");
    expect(methodNames).toContain("surface.sendText");
    expect(methodNames).toContain("surface.focus");
    expect(methodNames).not.toContain("workspace.create");

    // sendText 必须包含 tmux attach。
    const sendCall = calls.find((c) => c.method === "surface.sendText");
    expect(sendCall).toBeDefined();
    const sendParams = sendCall!.params as Record<string, unknown>;
    expect(String(sendParams["text"])).toBe("tmux attach -t r01-dev1-impl\n");
    expect(sendParams["workspaceId"]).toBe("workspace:1");

    const focusCalls = calls.filter((c) => c.method === "surface.focus");
    expect(focusCalls).toHaveLength(1);
    expect((focusCalls[0]!.params as Record<string, unknown>)["workspaceId"]).toBe("workspace:1");

    // 绑定必须同时持久化工作区与 surface。
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxWorkspace).toBe("workspace:1");
    expect(binding?.cmuxSurface).toBe("surface:99");
  });

  it("POST .../open-cmux external-cli 节点 → created_helper，提供诚实辅助文本，不执行 tmux attach", async () => {
    const { adapter: cmux, calls } = trackingCmux();
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "ext-node");
    sessionRegistry.registerSession(node.id, "r01-ext-node");
    sessionRegistry.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: "r01-ext-node" });

    calls.length = 0;

    const res = await app.request(`/api/rigs/${rig.id}/nodes/ext-node/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_helper");

    // 辅助文本必须包含诚实命令，而非 tmux attach。
    const sendCall = calls.find((c) => c.method === "surface.sendText");
    expect(sendCall).toBeDefined();
    const text = String((sendCall!.params as Record<string, unknown>)["text"]);
    expect(text).not.toContain("tmux attach");
    expect(text).toContain("zrig capture r01-ext-node");
    expect(text).toContain("zrig transcript r01-ext-node --tail 100");
    expect(text).toContain("zrig send r01-ext-node");
    expect(text).toContain("--verify");
  });

  it("POST .../open-cmux 的 sendText 失败 → 不报告 ok:true，且 tmux 节点不持久化 cmuxSurface（延后到 attach 成功）", async () => {
    const { adapter: cmux } = failingCmux("surface.sendText");
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl", attachmentType: "tmux" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toContain("connection lost");

    // OPR.0.3.4.8：tmux 节点 attach 失败时不持久化 cmuxSurface——延后持久化可避免
    // 重试时出现过期 focused_existing。
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxSurface).toBeNull();
  });

  it("POST .../open-cmux 创建后 focusSurface 失败 → 不报告 ok:true", async () => {
    const { adapter: cmux } = failingCmux("surface.focus");
    await cmux.connect();
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { cmux });
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl");
    sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl", attachmentType: "tmux" });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(body["error"]).toContain("connection lost");
  });

  // NS-T08：节点清单路由。
  it("GET /api/rigs/:rigId/nodes → 节点清单数组", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-rig");

    const res = await app.request(`/api/rigs/${rig.id}/nodes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].nodeId).toBe(node.id);
    expect(body[0].logicalId).toBe("dev.impl");
    expect(body[0].nodeKind).toBe("agent");
    expect(body[0].canonicalSessionName).toBe("dev-impl@test-rig");
  });

  it("权限观察不进入集群列表，只附加到单节点详情", async () => {
    const diagnose = vi.fn(() => ({
      transport: { state: "healthy" as const },
      cwdRead: { state: "visible" as const },
      commandPath: { state: "available" as const },
      enforcement: { axis: "sandbox" as const, state: "aligned" as const, expected: "workspace-write", effective: "workspace-write", sourcePath: null },
      observedAt: "2026-08-08T00:00:00.000Z",
    }));
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { permissionDriftObserver: { diagnose } });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    sessionRegistry.registerClaimedSession(node.id, "dev-impl@test-rig");

    const list = await app.request(`/api/rigs/${rig.id}/nodes?full=true`);
    expect(list.status).toBe(200);
    expect((await list.json())[0].permissionDrift).toBeUndefined();
    expect(diagnose).not.toHaveBeenCalled();

    const detail = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).permissionDrift).toMatchObject({ enforcement: { axis: "sandbox", state: "aligned" } });
    expect(diagnose).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledWith(node.id);
  });

  it("GET /api/rigs/:rigId/nodes 包含只读智能体活动证据", async () => {
    const tmux = {
      hasSession: vi.fn(async () => true),
      capturePaneContent: vi.fn(async () => "Working on task...\n⠋ Processing files\nesc to interrupt"),
    } as unknown as TmuxAdapter;
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { tmux });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@test-rig", attachmentType: "tmux" });

    // OPR.0.4.3 healthz-wedge：逐节点 tmux pane 启发式现位于 ?full=true 之后
    //（低成本默认路径跳过）——请求 full 以触发探针。
    const res = await app.request(`/api/rigs/${rig.id}/nodes?full=true`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "running",
      reason: "mid_work_pattern",
      evidenceSource: "pane_heuristic",
      fallback: true,
    });
    expect(typeof body[0].agentActivity.sampledAt).toBe("string");
    expect(tmux.capturePaneContent).toHaveBeenCalledWith("dev-impl@test-rig", 20);
  });

  it("GET /api/rigs/:rigId/nodes 优先使用新鲜 hook 活动而非 pane 回退", async () => {
    const tmux = {
      hasSession: vi.fn(async () => true),
      capturePaneContent: vi.fn(async () => "› idle\n\ngpt-5.5 xhigh fast · Context [████ ]"),
    } as unknown as TmuxAdapter;
    const { app, rigRepo, sessionRegistry, agentActivityStore } = createTestApp(db, {
      tmux,
      activityHookToken: "test-token",
    });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@test-rig", attachmentType: "tmux" });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@test-rig",
      hookEvent: "Notification",
      subtype: "permission_prompt",
      occurredAt: new Date().toISOString(),
      // W2a-1——携带发出事件的占用者代（绑定来源），使读取可解析并采用新鲜 hook 状态，
      // 而不是降级为 generation_unverifiable。
      generation: sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null,
    });

    const res = await app.request(`/api/rigs/${rig.id}/nodes`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "needs_input",
      reason: "permission_prompt",
      evidenceSource: "runtime_hook",
      fallback: false,
      rawEvent: "Notification",
      rawSubtype: "permission_prompt",
    });
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });

  it("GET /api/rigs/:rigId/nodes 将过期 hook 证据报告为 unknown，且不使用 pane 回退", async () => {
    const tmux = {
      hasSession: vi.fn(async () => true),
      capturePaneContent: vi.fn(async () => "Working on task...\n⠋ Processing files\nesc to interrupt"),
    } as unknown as TmuxAdapter;
    const { app, rigRepo, sessionRegistry, agentActivityStore } = createTestApp(db, {
      tmux,
      activityHookToken: "test-token",
      activityFreshnessMs: 1,
    });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@test-rig", attachmentType: "tmux" });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@test-rig",
      hookEvent: "UserPromptSubmit",
      occurredAt: "2000-01-01T00:00:00.000Z",
      // W2a-1——携带发出事件的代，使读取可解析并触发时钟过期判定（stale_runtime_hook），
      // 而不是由代门禁短路为 unverifiable。
      generation: sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null,
    });

    const res = await app.request(`/api/rigs/${rig.id}/nodes`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "unknown",
      reason: "stale_runtime_hook",
      evidenceSource: "runtime_hook",
      stale: true,
    });
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });

  it("GET /api/rigs/:rigId/nodes 将外部 CLI 活动标为 unsupported 而非 idle", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code" });
    sessionRegistry.registerClaimedSession(node.id, "orch-lead@test-rig");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch-lead@test-rig",
    });

    // OPR.0.4.3 healthz-wedge：探针分类现在位于 ?full=true 之后。
    const res = await app.request(`/api/rigs/${rig.id}/nodes?full=true`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "unknown",
      reason: "unsupported_attachment",
      evidenceSource: "external_cli",
    });
  });

  it("GET /api/rigs/:rigId/nodes 默认低成本（OPR.0.4.3 healthz-wedge）——无 hook 席位获得 unknown/no_runtime_hook 占位，且无逐节点 tmux 捕获", async () => {
    const tmux = {
      hasSession: vi.fn(async () => true),
      capturePaneContent: vi.fn(async () => "Working on task...\nesc to interrupt"),
    } as unknown as TmuxAdapter;
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { tmux });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@test-rig", attachmentType: "tmux" });

    // 无 ?full → 低成本默认路径。
    const res = await app.request(`/api/rigs/${rig.id}/nodes`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].agentActivity).toMatchObject({
      state: "unknown",
      reason: "no_runtime_hook",
      evidenceSource: "session_registry",
      fallback: true,
    });
    // 修复要点：默认热点路径不执行逐节点 tmux 捕获。
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
  });

  it("POST /api/activity/hooks 要求已配置的本地 hook token", async () => {
    const { app } = createTestApp(db, { activityHookToken: "test-token" });

    const res = await app.request("/api/activity/hooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runtime: "claude-code",
        sessionName: "dev-impl@test-rig",
        hookEvent: "UserPromptSubmit",
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("activity_hook_unauthorized");
  });

  it("POST /api/activity/hooks 摄取已认证的运行时 hook 事件", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db, { activityHookToken: "test-token" });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");

    const res = await app.request("/api/activity/hooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer test-token",
      },
      body: JSON.stringify({
        runtime: "claude-code",
        sessionName: "dev-impl@test-rig",
        hookEvent: "PreToolUse",
        occurredAt: "2026-04-24T11:59:00.000Z",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activity).toMatchObject({
      state: "running",
      reason: "pre_tool_use",
      evidenceSource: "runtime_hook",
    });
  });

  it("GET /api/rigs/:rigId/nodes → 未知工作组返回 404", async () => {
    const { app } = createTestApp(db);
    const res = await app.request("/api/rigs/nonexistent/nodes");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("未找到工作组");
  });

  // NS-T09：节点详情路由。
  it("GET /api/rigs/:rigId/nodes/:logicalId → 节点详情", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@test-rig");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logicalId).toBe("dev.impl");
    expect(body.nodeKind).toBe("agent");
    expect(Array.isArray(body.startupFiles)).toBe(true);
    expect(Array.isArray(body.recentEvents)).toBe(true);
  });

  it("GET /api/rigs/:rigId/nodes/:logicalId → 未知节点返回 404", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const res = await app.request(`/api/rigs/${rig.id}/nodes/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("未找到节点");
  });

  // 任务 5：节点详情返回 peers、edges、transcript 和 compactSpec。
  it("节点详情返回同一工作组中其他节点的 peers", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const n1 = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const n2 = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    sessionRegistry.registerSession(n1.id, "dev-impl@test");
    sessionRegistry.registerSession(n2.id, "dev-qa@test");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0].logicalId).toBe("dev.qa");
    expect(body.peers[0].canonicalSessionName).toBe("dev-qa@test");
    expect(body.peers[0].runtime).toBe("codex");
  });

  it("节点详情返回出边和入边", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const n1 = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const n2 = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    sessionRegistry.registerSession(n1.id, "dev-impl@test");
    sessionRegistry.registerSession(n2.id, "dev-qa@test");
    rigRepo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.edges.outgoing).toHaveLength(1);
    expect(body.edges.outgoing[0].kind).toBe("delegates_to");
    expect(body.edges.outgoing[0].to.logicalId).toBe("dev.qa");
    expect(body.edges.incoming).toHaveLength(0);

    // 从 qa 视角检查。
    const res2 = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.qa")}`);
    const body2 = await res2.json();
    expect(body2.edges.incoming).toHaveLength(1);
    expect(body2.edges.incoming[0].from.logicalId).toBe("dev.impl");
    expect(body2.edges.outgoing).toHaveLength(0);
  });

  it("节点详情返回紧凑规范摘要", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const n1 = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", profile: "default" });
    // 设置已解析的规范字段。
    db.prepare("UPDATE nodes SET resolved_spec_name = ?, resolved_spec_version = ? WHERE id = ?")
      .run("impl-agent", "1.0.0", n1.id);
    sessionRegistry.registerSession(n1.id, "dev-impl@test");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.compactSpec).toBeDefined();
    expect(body.compactSpec.name).toBe("impl-agent");
    expect(body.compactSpec.version).toBe("1.0.0");
    expect(body.compactSpec.profile).toBe("default");
    expect(typeof body.compactSpec.skillCount).toBe("number");
    expect(typeof body.compactSpec.guidanceCount).toBe("number");
  });

  it("节点详情返回转录信息（没有 TranscriptStore 时默认禁用）", async () => {
    const { app, rigRepo, sessionRegistry } = createTestApp(db);
    const rig = rigRepo.createRig("test-rig");
    const n1 = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(n1.id, "dev-impl@test");

    const res = await app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.transcript).toBeDefined();
    expect(body.transcript.enabled).toBe(false);
    expect(body.transcript.path).toBeNull();
    expect(body.transcript.tailCommand).toBeNull();
  });

  it("启用 TranscriptStore 时节点详情返回丰富的转录信息", async () => {
    const { TranscriptStore } = await import("../src/domain/transcript-store.js");
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const tmpDir = path.join(os.tmpdir(), `rigged-test-transcript-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const transcriptStore = new TranscriptStore(tmpDir);
    const { createApp } = await import("../src/server.js");
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("test-rig");
    const n1 = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(n1.id, "dev-impl@test-rig");

    // 构建接入 TranscriptStore 的最小应用。
    const appWithTranscript = createApp({ ...setup, transcriptStore });

    const res = await appWithTranscript.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    const body = await res.json();
    expect(body.transcript.enabled).toBe(true);
    expect(body.transcript.path).toContain("test-rig");
    expect(body.transcript.path).toContain("dev-impl@test-rig");
    expect(body.transcript.tailCommand).toBe("zrig transcript dev-impl@test-rig --tail 100");

    // 清理。
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- 上下文刷新路由测试 ---

  it("GET /api/rigs/:id/nodes?refresh=true 在投射前调用 contextMonitor.pollOnce", async () => {
    const db2 = createFullTestDb();
    const pollOnceSpy = vi.fn(async () => {});
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appWithMonitor = createApp({ ...setup, contextMonitor: { pollOnce: pollOnceSpy } });
    const rig = setup.rigRepo.createRig("refresh-rig");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    await appWithMonitor.request(`/api/rigs/${rig.id}/nodes?refresh=true`);

    expect(pollOnceSpy).toHaveBeenCalledOnce();
    db2.close();
  });

  it("GET /api/rigs/:id/nodes 不带 refresh 时不调用 pollOnce", async () => {
    const db2 = createFullTestDb();
    const pollOnceSpy = vi.fn(async () => {});
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appWithMonitor = createApp({ ...setup, contextMonitor: { pollOnce: pollOnceSpy } });
    const rig = setup.rigRepo.createRig("no-refresh-rig");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    await appWithMonitor.request(`/api/rigs/${rig.id}/nodes`);

    expect(pollOnceSpy).not.toHaveBeenCalled();
    db2.close();
  });

  it("GET /api/rigs/:id/nodes?refresh=true 在 pollOnce 抛出异常时返回 502", async () => {
    const db2 = createFullTestDb();
    const pollOnceSpy = vi.fn(async () => { throw new Error("statusline read failed"); });
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appWithMonitor = createApp({ ...setup, contextMonitor: { pollOnce: pollOnceSpy } });
    const rig = setup.rigRepo.createRig("fail-refresh-rig");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await appWithMonitor.request(`/api/rigs/${rig.id}/nodes?refresh=true`);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("context_refresh_failed");
    expect(body.detail).toContain("statusline read failed");
    db2.close();
  });

  it("GET /api/rigs/:id/nodes?refresh=true 在未接入 contextMonitor 时仍正常工作", async () => {
    const db2 = createFullTestDb();
    const setup = createTestApp(db2);
    const { createApp } = await import("../src/server.js");
    const appNoMonitor = createApp({ ...setup }); // no contextMonitor
    const rig = setup.rigRepo.createRig("no-monitor-rig");
    setup.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

    const res = await appNoMonitor.request(`/api/rigs/${rig.id}/nodes?refresh=true`);

    // 应成功（没有监控器即无内容可轮询；如实返回旧数据）。
    expect(res.status).toBe(200);
    db2.close();
  });
});
