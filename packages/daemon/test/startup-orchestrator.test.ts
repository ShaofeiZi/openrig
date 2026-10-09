import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile, ProjectionResult, StartupDeliveryResult, ReadinessResult } from "../src/domain/runtime-adapter.js";
import { resolveConcreteHint } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { StartupAction } from "../src/domain/types.js";
import { deriveOriented, issueStartupChallenge, verifyStartupProof } from "../src/domain/startup-proof.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";

// -- Mock --

function mockTmux(overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  } as unknown as TmuxAdapter;
}

function mockAdapter(overrides?: Partial<RuntimeAdapter>): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function emptyPlan(): ProjectionPlan {
  return { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

function makeBinding(): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." };
}

function makeAction(overrides?: Partial<StartupAction>): StartupAction {
  return { type: "slash_command", value: "/test", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true, ...overrides };
}

function makeIdentityAction(overrides?: Partial<StartupAction>): StartupAction {
  return {
    type: "send_text",
    value: [
      "dev-impl@test-rig",
      "OpenRig session identity:",
      "- rig: test-rig",
      "- pod: dev",
      "- member: impl",
      "- logical_id: dev.impl",
      "- session: dev-impl@test-rig",
    ].join("\n"),
    phase: "after_ready",
    appliesOn: ["fresh_start", "restore"],
    idempotent: true,
    builtin: "session_identity",
    ...overrides,
  };
}

describe("StartupOrchestrator", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;
  let tmux: TmuxAdapter;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
    tmux = mockTmux();
  });

  afterEach(() => { db.close(); });

  function createOrchestrator(
    opts?: TmuxAdapter | { tmux?: TmuxAdapter; readFile?: (path: string) => string },
  ): StartupOrchestrator {
    const normalized = opts && "sendText" in opts
      ? { tmux: opts as TmuxAdapter }
      : (opts ?? {});
    return new StartupOrchestrator({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: normalized.tmux ?? tmux,
      readFile: normalized.readFile,
      sleep: async () => {},
    });
  }

  function seedSession(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function makeInput(seed: { rigId: string; nodeId: string; sessionId: string }, overrides?: Partial<StartupInput>): StartupInput {
    return {
      rigId: seed.rigId,
      nodeId: seed.nodeId,
      sessionId: seed.sessionId,
      binding: makeBinding(),
      adapter: mockAdapter(),
      plan: emptyPlan(),
      resolvedStartupFiles: [],
      startupActions: [],
      isRestore: false,
      ...overrides,
    };
  }

  it("显式 fresh replacement 会附加具名 durable obligation read，且不增加额外消息", async () => {
    const seed = seedSession();
    await createOrchestrator().startNode(makeInput(seed, { startupActions: [makeIdentityAction()], includeDurableObligations: true }));
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", expect.stringContaining("zrig queue list --destination r01-impl --state pending,in-progress,blocked"));
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", expect.stringContaining(makeIdentityAction().value));
  });

  it("在 native gate 前持久化 authored context，且仅公开匹配的 continuation", async () => {
    const seed = seedSession(); const orch = createOrchestrator();
    const action = makeAction({ type: "send_text", value: "configured role and durable queue instructions" });
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: false, recovery: "attention_required", error: "Hook review" })) });
    const result = await orch.startNode(makeInput(seed, { adapter, startupActions: [action] }));
    expect(result.startupStatus).toBe("attention_required");
    expect(JSON.parse((db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id=?").get(seed.nodeId) as {startup_actions_json:string}).startup_actions_json)).toEqual([action]);
    expect(orch.canContinueFresh(seed.nodeId, seed.sessionId)).toBe(true);
    expect(orch.canContinueFresh(seed.nodeId, "other-occupant")).toBe(false);
    eventBus.emit({ type: "node.startup_pending", rigId: seed.rigId, nodeId: seed.nodeId });
    expect(orch.canContinueFresh(seed.nodeId, seed.sessionId)).toBe(false);
  });

  it("exact resume 保留已配置的 fresh context，且不发送 replay", async () => {
    const seed = seedSession(); const orch = createOrchestrator();
    const action = makeAction({ type: "send_text", value: "configured context" });
    await orch.startNode(makeInput(seed, { startupActions: [action] }));
    const before = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId);
    const adapter = mockAdapter();
    const result = await orch.startNode(makeInput(seed, { adapter, isRestore: true, resumeToken: "native-original", preserveStartupContext: true }));
    expect(result.ok).toBe(true);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId)).toEqual(before);
    expect(adapter.deliverStartup).toHaveBeenCalledWith([], expect.anything());
  });

  it.each(["launch", "readiness"])("pod-aware exact resume cannot continue fresh context after a %s gate", async (gate) => {
    const seed = seedSession(); const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { startupActions: [makeIdentityAction()], includeDurableObligations: true }));
    const before = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId);
    vi.mocked(tmux.sendText).mockClear();
    const adapter = mockAdapter(gate === "launch"
      ? { launchHarness: vi.fn(async () => ({ ok: false, recovery: "attention_required", error: "Hook review" })) }
      : { checkReady: vi.fn(async () => ({ ready: false, code: "hook_trust_gate", reason: "Hook review" })) });
    // RestoreOrchestrator 支持 pod 的 exact-resume 路径通过空 file/action 表达 replay，
    // 但使用 isRestore:false 启动 native harness。
    const input = makeInput(seed, { adapter, isRestore: false, resumeToken: "native-original",
      resumeType: "claude_id", preserveStartupContext: true, allowFreshFallback: false });
    expect((await orch.startNode(input)).startupStatus).toBe("attention_required");
    expect(orch.canContinueFresh(seed.nodeId, seed.sessionId)).toBe(false);
    expect(createOrchestrator().canContinueFresh(seed.nodeId, seed.sessionId)).toBe(false);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId)).toEqual(before);
    expect(tmux.sendText).not.toHaveBeenCalled();
    const retry = await createOrchestrator().startNode({ ...input, adapter: mockAdapter() });
    expect(retry).toMatchObject({ ok: true, continuityOutcome: "resumed" });
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  // T1：fresh launch 在 startup delivery 前进入 pending
  it("在 delivery 前标记为 pending", async () => {
    const seed = seedSession();
    const adapter = mockAdapter();
    let statusDuringProject = "";
    (adapter.project as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
      statusDuringProject = row.startup_status;
      return { projected: [], skipped: [], failed: [] };
    });

    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter }));
    expect(statusDuringProject).toBe("pending");
  });

  // T2：成功 startup 转为 ready
  it("成功 startup 转为 ready", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed));
    expect(result.ok).toBe(true);
    expect(result.startupStatus).toBe("ready");

    const row = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string; startup_completed_at: string | null };
    expect(row.startup_status).toBe("ready");
    expect(row.startup_completed_at).not.toBeNull();
  });
  it.each(["codex_client_incompatible", "hook_trust_gate"])("does not mark ready when context delivery exposes %s", async (code) => {
    const seed = seedSession();
    let delivered = false;
    const adapter = mockAdapter({
      runtime: "codex",
      deliverStartup: vi.fn(async (files) => { if (files.some((file) => file.deliveryHint === "send_text")) delivered = true; return { delivered: files.length, failed: [] }; }),
      checkReady: vi.fn(async () => delivered
        ? { ready: false, code, reason: "The native runtime requires attention" }
        : { ready: true }),
    });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter,
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/tmp/role.md", ownerRoot: "/tmp",
        deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }] }));
    expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ startup_status: "attention_required" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM node_startup_context WHERE node_id = ?").get(seed.nodeId)).toEqual({ n: 1 });
  });

  it("仅在 managed launch 成功后记录 adapter 返回的精确 launch effect", async () => {
    const seed = seedSession();
    const appliedLaunch = observeClaudePermission("--permission-mode acceptEdits");
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: true, appliedLaunch })) });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(true);
    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toMatchObject(appliedLaunch);
  });

  it("将延迟的 launch observation 绑定到实际启动的 generation", async () => {
    const seed = seedSession();
    const launchedGeneration = sessionRegistry.currentOccupantTenure(seed.nodeId)!.generationUuid;
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => {
        await launchGate;
        return { ok: true as const, appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") };
      }),
    });

    const pending = createOrchestrator().startNode(makeInput(seed, { adapter }));
    await vi.waitFor(() => expect(adapter.launchHarness).toHaveBeenCalledTimes(1));
    sessionRegistry.mintOccupantTenure(seed.nodeId, "handover");
    releaseLaunch();
    expect((await pending).ok).toBe(true);

    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toBeNull();
    expect(db.prepare("SELECT generation_uuid FROM applied_launch_observations").get()).toEqual({
      generation_uuid: launchedGeneration,
    });
  });

  it("延迟 readiness 完成时绝不复活已失效 generation", async () => {
    const seed = seedSession();
    const generation = sessionRegistry.currentOccupantTenure(seed.nodeId)!.generationUuid;
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true as const, appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") })),
      checkReady: vi.fn(async () => {
        await readyGate;
        return { ready: true as const };
      }),
    });

    const pending = createOrchestrator().startNode(makeInput(seed, { adapter }));
    await vi.waitFor(() => expect(adapter.checkReady).toHaveBeenCalledTimes(1));
    expect(new AppliedLaunchObservationStore(db).invalidateGeneration(generation)).toBe(true);
    releaseReady();
    expect((await pending).ok).toBe(true);

    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observations WHERE generation_uuid = ?").get(generation)).toEqual({ n: 0 });
  });

  it("managed launch 失败时不记录 attempted effect", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: false, error: "provider refused" })) });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(false);
    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toBeNull();
  });

  it("observation 无法持久化时仍保持 provider launch 成功", async () => {
    const seed = seedSession();
    db.exec("DROP TABLE applied_launch_observations");
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true, appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") })),
    });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(true);
    expect(result.startupStatus).toBe("ready");
  });

  // T3：delivery 失败转为 failed
  it("delivery 失败转为 failed", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [{ path: "startup.md", error: "disk full" }] })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [{ path: "startup.md", absolutePath: "/tmp/startup.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] }],
    }));
    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("failed");

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("failed");
  });

  // T4：action 失败转为 failed
  it("action 失败转为 failed", async () => {
    const seed = seedSession();
    const failTmux = mockTmux({ sendText: vi.fn(async () => ({ ok: false as const, message: "session gone" })) });
    const orch = createOrchestrator({ tmux: failTmux });
    const actions: StartupAction[] = [makeAction({ phase: "after_ready" })];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions }));
    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("failed");
  });

  // T5：新 startup 顺序：project → 启动前 deliver → launchHarness → checkReady → 启动后 deliver → after_files → after_ready
  it("startup 顺序：启动前 deliver 先于 launchHarness；after_files 位于启动后 deliver 之后；after_ready 最后", async () => {
    const seed = seedSession();
    const callOrder: string[] = [];

    const adapter = mockAdapter({
      project: vi.fn(async () => { callOrder.push("project"); return { projected: [], skipped: [], failed: [] }; }),
      deliverStartup: vi.fn(async () => { callOrder.push("deliver"); return { delivered: 1, failed: [] }; }),
      launchHarness: vi.fn(async () => { callOrder.push("launchHarness"); return { ok: true }; }),
      checkReady: vi.fn(async () => { callOrder.push("checkReady"); return { ready: true }; }),
    });

    const t = mockTmux({
      sendText: vi.fn(async (target: string, text: string) => {
        callOrder.push(`action:${text}`);
        return { ok: true as const };
      }),
    });

    const orch = createOrchestrator({ tmux: t });
    const actions: StartupAction[] = [
      makeAction({ phase: "after_files", value: "/after-files-cmd" }),
      makeAction({ phase: "after_ready", value: "/after-ready-cmd" }),
    ];
    const files = [
      { path: "culture.md", absolutePath: "/tmp/culture.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge" as const, required: true, appliesOn: ["fresh_start" as const, "restore" as const] },
      { path: "priming.txt", absolutePath: "/tmp/priming.txt", ownerRoot: "/tmp", deliveryHint: "send_text" as const, required: false, appliesOn: ["fresh_start" as const] },
    ];
    await orch.startNode(makeInput(seed, { adapter, startupActions: actions, resolvedStartupFiles: files }));

    const projectIdx = callOrder.indexOf("project");
    const launchIdx = callOrder.indexOf("launchHarness");
    const checkReadyIdx = callOrder.indexOf("checkReady");
    const afterFilesIdx = callOrder.indexOf("action:/after-files-cmd");
    const afterReadyIdx = callOrder.indexOf("action:/after-ready-cmd");

    // deliver 调用两次（启动前 + 启动后），通过 launchHarness 位置验证顺序
    expect(launchIdx).toBeGreaterThan(projectIdx);
    expect(checkReadyIdx).toBeGreaterThan(launchIdx);
    expect(afterFilesIdx).toBeGreaterThan(checkReadyIdx);
    expect(afterReadyIdx).toBeGreaterThan(afterFilesIdx);
  });

  // Slice 51-01 stub-runtime——仅用于测试的 RED（无争议 mechanical FACT 3）：由真实
  // StartupOrchestrator 驱动的真实 StubRuntimeAdapter 必须按 project → 启动前 deliver →
  // launchHarness → checkReady → 启动后 deliver 的顺序运行并到达 `ready`。dynamic import 使本文件
  // 其他测试保持 green；当前因 adapter module 缺失而 RED。导入后完全可执行：只有
  // `StubRuntimeAdapter` export 而方法缺失/错误时，startNode 无法到达 ready，deliver 也不会调用两次。
  // 带 send_text hint 的文件会强制进入启动后阶段。要求 stub 可 hermetic 测试（该 shape 的
  // determinism/hermetic 设计属性）。不编码有争议的 hook/usage_limit/compaction/packaging surface。
  // construction dependency 暂按设计定义，adapter 交付后（fresh Guard CLEAR 后）定稿。
  it("FACT3：真实 stub adapter 按 project→pre-deliver→launch→ready→post-deliver 顺序到达 ready", async () => {
    const { StubRuntimeAdapter } = await import("../src/adapters/stub-runtime-adapter.js") as { StubRuntimeAdapter: new (deps: unknown) => RuntimeAdapter }; // RED now: module absent
    const seed = seedSession();
    const t = mockTmux();
    const adapter = new StubRuntimeAdapter({ tmux: t, runtime: "stub" });
    const projectSpy = vi.spyOn(adapter, "project");
    const deliverSpy = vi.spyOn(adapter, "deliverStartup");
    const launchSpy = vi.spyOn(adapter, "launchHarness");
    const readySpy = vi.spyOn(adapter, "checkReady");
    const files = [
      { path: "priming.txt", absolutePath: "/tmp/priming.txt", ownerRoot: "/tmp", deliveryHint: "send_text" as const, required: false, appliesOn: ["fresh_start" as const] },
    ];
    const result = await createOrchestrator({ tmux: t }).startNode(makeInput(seed, { adapter, resolvedStartupFiles: files }));
    expect(result.startupStatus, "the real stub must reach ready through the real orchestrator").toBe("ready");
    expect(deliverSpy, "deliverStartup must run on BOTH sides of launch").toHaveBeenCalledTimes(2);
    const pIdx = projectSpy.mock.invocationCallOrder[0]!;
    const preDeliver = deliverSpy.mock.invocationCallOrder[0]!;
    const lIdx = launchSpy.mock.invocationCallOrder[0]!;
    const rIdx = readySpy.mock.invocationCallOrder[0]!;
    const postDeliver = deliverSpy.mock.invocationCallOrder[1]!;
    expect(pIdx).toBeLessThan(preDeliver);
    expect(preDeliver).toBeLessThan(lIdx);
    expect(lIdx).toBeLessThan(rIdx);
    expect(rIdx).toBeLessThan(postDeliver);
  });

  // T6：restore 时跳过非幂等 action
  it("restore 时跳过非幂等 action", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const actions: StartupAction[] = [
      makeAction({ value: "/setup-once", idempotent: false, appliesOn: ["fresh_start"] }),
    ];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions, isRestore: true }));
    expect(result.ok).toBe(true);
    // 不发送不适用的 action 或未选择的 proof。
    const calls = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(calls).toEqual([]);
  });

  // T7：幂等 restore action 可安全 replay
  it("幂等 action 在 restore 时 replay", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const actions: StartupAction[] = [
      makeAction({ value: "/rename impl", idempotent: true, appliesOn: ["fresh_start", "restore"] }),
    ];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions, isRestore: true }));
    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "/rename impl");
  });

  it("发送文本后提交 startup action", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const actions: StartupAction[] = [makeAction({ value: "/rename impl" })];

    const result = await orch.startNode(makeInput(seed, { startupActions: actions }));

    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "/rename impl");
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["C-m"]);
  });

  // T8：用户 debug append 在 resolved startup 后执行
  it("用户 debug action 在 startup sequence 中执行", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    // 用户 debug action 只是由 startup resolver 最后添加的普通 action
    const actions: StartupAction[] = [
      makeAction({ value: "/debug-overlay", phase: "after_ready" }),
    ];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions }));
    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "/debug-overlay");
  });

  // T9：reconciler 报告失败的 startup state
  it("session query 中可见失败的 startup", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({ ready: false, reason: "not responding" })),
    });
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 100 }));

    // session 应显示 startup 失败
    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session).toBeDefined();
    expect(session!.startupStatus).toBe("failed");
  });

  it("可恢复的交互式 startup blocker 转为 attention_required", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        code: "trust_gate",
        reason: "Claude is waiting for workspace trust approval before the session can become interactive.",
      })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter }));

    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("attention_required");

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("attention_required");
  });

  it("Claude MCP approval blocker 转为 attention_required", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        code: "mcp_gate",
        reason: "Claude is waiting for project MCP server approval before the session can become interactive.",
      })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter }));

    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("attention_required");

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("attention_required");
  });

  it("将 session identity 注入首次 fresh send_text prompt", async () => {
    const seed = seedSession();
    const deliverStartup = vi.fn(async (_files: ResolvedStartupFile[]) => ({ delivered: 0, failed: [] }));
    const adapter = mockAdapter({
      deliverStartup,
    });
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmuxOverride = mockTmux({ sendText });
    const orch = createOrchestrator({
      tmux: tmuxOverride,
      readFile: (path) => path === "/tmp/role.md" ? "Role instructions go here." : "",
    });

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [{
        path: "guidance/role.md",
        absolutePath: "/tmp/role.md",
        ownerRoot: "/tmp",
        deliveryHint: "send_text",
        required: true,
        appliesOn: ["fresh_start"],
      }],
      startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/rename impl" }),
      ],
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "fresh",
    });
    expect(sendText).toHaveBeenNthCalledWith(1, "r01-impl", expect.any(String));
    const firstPrompt = sendText.mock.calls[0]?.[1];
    expect(firstPrompt).toContain("dev-impl@test-rig");
    expect(firstPrompt).toContain("OpenRig session identity:");
    expect(firstPrompt).toContain("Role instructions go here.");
    expect(sendText).toHaveBeenNthCalledWith(2, "r01-impl", "/rename impl");
    expect(deliverStartup).toHaveBeenCalledTimes(1);
  });

  it("resumed restore 时不 replay session identity", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmuxOverride = mockTmux({ sendText });
    const orch = createOrchestrator({ tmux: tmuxOverride });

    const result = await orch.startNode(makeInput(seed, {
      startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/rename impl" }),
      ],
      isRestore: true,
      resumeToken: "claude-session-123",
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "resumed",
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("r01-impl", "/rename impl");
  });

  // OPR.0.4.7.17 restore-order-correction（qitem-e99624f7）。在真实 automatic Codex restore
  // 中，daemon 会先交付触发工作的 guidance/role.md（其 turn 执行 skill-metadata 检查 +
  // `zrig whoami`），after_ready 的“在做其他任何事之前”preload action 随后才到达——导致
  // 非 skill 工作先于 action，破坏已锁定的 action-before-work contract。修复必须是因果性的
  //（将 preload 排在 role 触发的 turn 前），而非加大发送延迟。本 pin 不依赖 shape 地断言
  // contract：在有序 provider input（send_text 发送与启动后 send_text file delivery）中，preload
  // text 不得晚于 role.md work-trigger content；合并到同一 input 时，preload text 位于 role 前。
  it("restore：after_ready preload action 排在 role.md work-trigger 前", async () => {
    const seed = seedSession();
    const ROLE = "# Role: QA\nload your named skills: using-superpowers, test-driven-development";
    const PRELOAD = "A task is coming. BEFORE you do anything else, load and invoke your process skills NOW: using-superpowers, test-driven-development. Load them first, then begin the work.";

    // provider input 的统一有序列表（实际抵达 pane 的内容）。
    const inputs: string[] = [];
    const deliverStartup = vi.fn(async (files: ResolvedStartupFile[]) => {
      for (const f of files) {
        if (f.deliveryHint === "send_text") inputs.push(f.absolutePath === "/tmp/role.md" ? ROLE : "");
      }
      return { delivered: 0, failed: [] };
    });
    const adapter = mockAdapter({ deliverStartup });
    const sendText = vi.fn(async (_session: string, text: string) => { inputs.push(text); return { ok: true as const }; });
    const tmuxOverride = mockTmux({ sendText });
    const orch = createOrchestrator({
      tmux: tmuxOverride,
      readFile: (path) => path === "/tmp/role.md" ? ROLE : "",
    });

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [{
        path: "guidance/role.md",
        absolutePath: "/tmp/role.md",
        ownerRoot: "/tmp",
        deliveryHint: "send_text",
        required: true,
        appliesOn: ["fresh_start", "restore"],
      }],
      startupActions: [
        makeAction({ type: "send_text", value: PRELOAD, phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true }),
      ],
      isRestore: true,
      resumeToken: "codex-session-abc",
    }));

    expect(result.ok).toBe(true);

    const preloadIdx = inputs.findIndex((t) => t.includes("BEFORE you do anything else"));
    const roleIdx = inputs.findIndex((t) => t.includes("# Role: QA"));
    expect(preloadIdx).toBeGreaterThanOrEqual(0); // preload action 已抵达 provider
    expect(roleIdx).toBeGreaterThanOrEqual(0);    // role.md work-trigger 已抵达 provider

    // CONTRACT：preload 不得晚于 role.md work-trigger 抵达。
    expect(preloadIdx).toBeLessThanOrEqual(roleIdx);
    // 若合并到单个 input，preload text 必须位于 role content 前。
    if (preloadIdx === roleIdx) {
      const payload = inputs[preloadIdx]!;
      expect(payload.indexOf("BEFORE you do anything else")).toBeLessThan(payload.indexOf("# Role: QA"));
    }
    // preload 不得作为重复的独立 turn 再次发送。
    const preloadDeliveries = inputs.filter((t) => t.includes("BEFORE you do anything else")).length;
    expect(preloadDeliveries).toBe(1);
  });

  it("restore 回退到 fresh launch 时先发送 identity prompt", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmuxOverride = mockTmux({ sendText });
    const adapter = mockAdapter({
      runtime: "codex",
      launchHarness: vi.fn()
        .mockResolvedValueOnce({ ok: false as const, error: "saved session missing", recovery: "retry_fresh" })
        .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-token", resumeType: "codex_id" }),
    });
    const orch = createOrchestrator({ tmux: tmuxOverride });

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "stale-token",
      startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/rename impl" }),
      ],
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "fresh",
    });
    expect(sendText).toHaveBeenNthCalledWith(
      1,
      "r01-impl",
      expect.stringContaining("dev-impl@test-rig"),
    );
    expect(sendText).toHaveBeenNthCalledWith(2, "r01-impl", "/rename impl");
  });

  it("发出选定的 startup challenge（oriented=missing，prompt 中含 challenge）", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const orch = createOrchestrator({ tmux: mockTmux({ sendText }) });

    await orch.startNode(makeInput(seed, {
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/tmp/role.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }],
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeIdentityAction()],
    }));

    const challenged = db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_challenged'").get(seed.nodeId) as { n: number };
    expect(challenged.n).toBe(1);
    expect(deriveOriented(db, seed.nodeId)).toBe("missing");
    // challenge 指令嵌入首次交付的 prompt。
    expect(sendText.mock.calls[0]?.[1]).toContain("启动定向挑战");
  });

  // OPR.0.4.3.06——resumed restore 不会再次 challenge（oriented 保持 n-a）。
  it("运行 terminal startup 命令，不向其 shell 发送 agent-orientation 文案", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const orch = createOrchestrator({ tmux: mockTmux({ sendText }) });
    await orch.startNode(makeInput(seed, {
      adapter: mockAdapter({ runtime: "terminal" }),
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeAction({ type: "send_text", value: "zrig tui" })],
    }));
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("r01-impl", "zrig tui");
    expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
  });

  it("不对 resumed restore 发起 challenge（oriented=n-a）", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, {
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeIdentityAction()],
      isRestore: true,
      resumeToken: "claude-session-123",
    }));
    const challenged = db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_challenged'").get(seed.nodeId) as { n: number };
    expect(challenged.n).toBe(0);
    expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
  });

  it.each([false, true])("omission delivers authored identity with files=%s and adds no exercise", async (withFiles) => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter,
      startupActions: [makeIdentityAction()],
      resolvedStartupFiles: withFiles ? [{ path: "role.md", absolutePath: "/tmp/role.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }] : [],
    }));
    expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(adapter.project).toHaveBeenCalledOnce();
    expect(adapter.checkReady).toHaveBeenCalledOnce();
    expect(tmux.sendText).toHaveBeenCalledExactlyOnceWith("r01-impl", makeIdentityAction().value);
    expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
    const row = db.prepare("SELECT payload FROM events WHERE type='node.startup_pending'").get() as { payload: string };
    expect(JSON.parse(row.payload).startupProof).toEqual({ mode: "none", source: "default" });
  });

  function seedVerifiedProof() {
    const seed = seedSession();
    const store = new AgentActivityStore({ db, eventBus });
    const challenge = issueStartupChallenge(eventBus, { ...seed, contractSource: "prior occupant" });
    const submit = () => verifyStartupProof({ store, eventBus }, {
      nodeId: seed.nodeId, challengeId: challenge.challengeId, answer: challenge.expectedAnswer,
    });
    expect(submit().ok).toBe(true);
    expect(deriveOriented(db, seed.nodeId)).toBe("verified");
    return { seed, submit };
  }

  describe.each(["fresh", "fresh-fallback"] as const)("%s lean proof boundary", (mode) => {
    const launchInput = mode === "fresh-fallback"
      ? { isRestore: true, resumeToken: "stale-token", allowFreshFallback: true }
      : {};
    function launchAdapter() {
      const launch = vi.fn<RuntimeAdapter["launchHarness"]>().mockResolvedValue({ ok: true });
      if (mode === "fresh-fallback") {
        launch.mockResolvedValueOnce({ ok: false, recovery: "retry_fresh", error: "stale resume" });
      }
      return launch;
    }

    it.each(["ready", "attention", "timeout", "throws"] as const)("retires verified proof before readiness %s", async (readiness) => {
      const { seed, submit } = seedVerifiedProof();
      const observedAtReadiness: string[] = [];
      const adapter = mockAdapter({
        launchHarness: launchAdapter(),
        checkReady: vi.fn(async () => {
          observedAtReadiness.push(deriveOriented(db, seed.nodeId));
          if (readiness === "throws") throw new Error("fixture readiness error");
          if (readiness === "attention") return { ready: false, code: "login_required", reason: "fixture login" };
          return { ready: readiness === "ready", reason: "fixture timeout" };
        }),
      });
      const result = await createOrchestrator().startNode(makeInput(seed, {
        ...launchInput, adapter, readinessTimeoutMs: 0,
        startupActions: [makeAction({ type: "startup_proof", value: "none" })],
      }));
      expect(result.startupStatus).toBe(readiness === "ready" ? "ready" : readiness === "attention" ? "attention_required" : "failed");
      expect(adapter.launchHarness).toHaveBeenCalledTimes(mode === "fresh-fallback" ? 2 : 1);
      expect(observedAtReadiness.length).toBeGreaterThan(0);
      expect(observedAtReadiness.every(value => value === "n-a")).toBe(true);
      expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
      expect(submit()).toMatchObject({ ok: false, code: "challenge_stale" });
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_skipped'").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_verified'").get()).toEqual({ n: 1 });
    });

    it.each(["failed", "throws"] as const)("preserves verified proof when replacement launch %s", async (failure) => {
      const { seed, submit } = seedVerifiedProof();
      const launch = launchAdapter();
      if (failure === "throws") launch.mockRejectedValue(new Error("fixture launch error"));
      else launch.mockResolvedValue({ ok: false, error: "fixture launch failed" });
      const adapter = mockAdapter({ launchHarness: launch });
      const result = await createOrchestrator().startNode(makeInput(seed, { ...launchInput, adapter }));
      expect(result.startupStatus).toBe("failed");
      expect(launch).toHaveBeenCalledTimes(mode === "fresh-fallback" ? 2 : 1);
      expect(adapter.checkReady).not.toHaveBeenCalled();
      expect(deriveOriented(db, seed.nodeId)).toBe("verified");
      expect(submit().ok).toBe(true);
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_skipped'").get()).toEqual({ n: 0 });
    });
  });

  it.each(["resume", "adopt"] as const)("preserves verified proof when %s needs readiness attention", async (mode) => {
    const { seed, submit } = seedVerifiedProof();
    const adapter = mockAdapter({ checkReady: vi.fn(async () => ({ ready: false, code: "login_required" })) });
    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter, isRestore: true,
      ...(mode === "resume" ? { resumeToken: "existing-token" } : { skipHarnessLaunch: true }),
      startupActions: [makeAction({ type: "startup_proof", value: "none" })],
    }));
    expect(result.startupStatus).toBe("attention_required");
    expect(deriveOriented(db, seed.nodeId)).toBe("verified");
    expect(submit().ok).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_skipped'").get()).toEqual({ n: 0 });
  });

  it("在 projection 或 launch 前拒绝未知的已持久化 proof selection", async () => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter, startupActions: [makeAction({ type: "startup_proof", value: "quiz" })],
    }));
    expect(result).toMatchObject({ ok: false, startupStatus: "failed" });
    expect(adapter.project).not.toHaveBeenCalled();
    expect(adapter.launchHarness).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  // T10：action 完成前 launcher 不标记 ready
  it("orchestrator 完成前 startup_status 保持 pending", async () => {
    const seed = seedSession();
    // NodeLauncher 创建 session 后，startupStatus 为 pending（AS-T00 的默认值）
    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("pending"); // launcher left it as default

    // 仅在 orchestrator.startNode 完成后才转为 ready
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed));
    const afterRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(afterRow.startup_status).toBe("ready");
  });

  // T11：重试失败 startup 不会重复不可逆工作
  it("retry-as-restore 跳过非幂等 fresh_start action", async () => {
    const seed = seedSession();

    // 首次尝试：在 action 期间失败（非幂等 action 已执行，随后其他内容失败）
    const failAdapter = mockAdapter({
      checkReady: vi.fn()
        .mockResolvedValueOnce({ ready: true }) // first attempt: ready
        .mockResolvedValueOnce({ ready: true }), // retry: ready
    });
    // OPR.0.4.3.06——text-aware mock（能适应 fresh continuity 上额外发送的 orientation challenge）：
    // 除首次 /configure（第 1 次尝试的第二个 action）仍如以前失败外，其他全部成功。
    let configureSeen = 0;
    const failTmux = mockTmux({
      sendText: vi.fn(async (_target: string, text: string) => {
        if (text === "/configure") {
          configureSeen++;
          if (configureSeen === 1) return { ok: false as const, message: "second action fails" };
        }
        return { ok: true as const };
      }),
    });

    const orch = createOrchestrator(failTmux);
    const actions: StartupAction[] = [
      makeAction({ value: "/setup-once", idempotent: false, phase: "after_ready", appliesOn: ["fresh_start"] }),
      makeAction({ value: "/configure", idempotent: true, phase: "after_ready", appliesOn: ["fresh_start", "restore"] }),
    ];

    // 首次尝试在第二个 action 上失败
    const r1 = await orch.startNode(makeInput(seed, { adapter: failAdapter, startupActions: actions, isRestore: false }));
    expect(r1.ok).toBe(false);

    // 以 restore 重试——应跳过非幂等 /setup-once
    const r2 = await orch.startNode(makeInput(seed, { adapter: failAdapter, startupActions: actions, isRestore: true }));
    expect(r2.ok).toBe(true);

    // /setup-once 只调用一次（仅首次尝试），/configure 在重试时调用
    const calls = (failTmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(calls.filter((c: string) => c === "/setup-once")).toHaveLength(1);
  });

  // T12a：restore 时跳过仅限 fresh-start 的 startup file
  it("restore 时跳过仅限 fresh-start 的 startup file", async () => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const files: ResolvedStartupFile[] = [
      { path: "fresh.md", absolutePath: "/rig/fresh.md", ownerRoot: "/rig", deliveryHint: "auto", required: true, appliesOn: ["fresh_start"] },
      { path: "always.md", absolutePath: "/rig/always.md", ownerRoot: "/rig", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] },
    ];
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter, resolvedStartupFiles: files, isRestore: true }));

    // 只应交付 "always.md"，不交付 "fresh.md"
    const deliverCalls = (adapter.deliverStartup as ReturnType<typeof vi.fn>).mock.calls;
    expect(deliverCalls).toHaveLength(1);
    const deliveredFiles = deliverCalls[0][0] as ResolvedStartupFile[];
    expect(deliveredFiles).toHaveLength(1);
    expect(deliveredFiles[0]!.path).toBe("always.md");
  });

  // T12b：发出正确的 lifecycle event
  it("发出 startup_pending 与 startup_ready event", async () => {
    const seed = seedSession();
    const events: string[] = [];
    eventBus.subscribe((e) => events.push(e.type));

    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed));

    expect(events).toContain("node.startup_pending");
    expect(events).toContain("node.startup_ready");
    expect(events.indexOf("node.startup_pending")).toBeLessThan(events.indexOf("node.startup_ready"));
  });

  // NS-T04：共享 resolveConcreteHint resolver
  it("resolveConcreteHint: SKILL.md path → skill_install", () => {
    expect(resolveConcreteHint("skills/my-skill/SKILL.md", "some content")).toBe("skill_install");
  });

  it("resolveConcreteHint：以 # SKILL 开头的内容 → skill_install", () => {
    expect(resolveConcreteHint("custom.txt", "# SKILL Some tool")).toBe("skill_install");
  });

  it("resolveConcreteHint: .md file → guidance_merge", () => {
    expect(resolveConcreteHint("role.md", "You are a developer")).toBe("guidance_merge");
  });

  it("resolveConcreteHint：非 .md 文件 → send_text", () => {
    expect(resolveConcreteHint("config.yaml", "key: value")).toBe("send_text");
  });

  // NS-T04：skipHarnessLaunch
  it("skipHarnessLaunch: true 完全跳过 launchHarness", async () => {
    const seed = seedSession();
    const launchSpy = vi.fn(async () => ({ ok: true as const }));
    const adapter = mockAdapter({ launchHarness: launchSpy });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, skipHarnessLaunch: true }));
    expect(result.ok).toBe(true);
    expect(launchSpy).not.toHaveBeenCalled();
  });

  // NS-T04：launchHarness 失败 → startup_failed
  it("launchHarness 失败转为 startup_failed", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: false as const, error: "harness crash" })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("harness crash"))).toBe(true);
    }
  });

  // NS-T04：launchHarness 持久化 resume token
  it("launchHarness resume token 持久化至 session", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "sess-xyz", resumeType: "claude_id" })),
    });
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter }));

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.resumeToken).toBe("sess-xyz");
    expect(session!.resumeType).toBe("claude_id");
  });

  it("launchHarness 不会将空 resume token 持久化为可恢复 state", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "", resumeType: "claude_id" })),
    });
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter }));

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.resumeToken).toBeNull();
    expect(session!.resumeType).toBeNull();
  });

  it("launchHarness 报告 resume recovery 可安全回退时，以 fresh 方式重试一次 restore", async () => {
    const seed = seedSession();
    const launchHarness = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "saved session missing", recovery: "retry_fresh" })
      .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-token", resumeType: "codex_id" });
    const adapter = mockAdapter({
      runtime: "codex",
      launchHarness,
    });
    const orch = createOrchestrator();

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "stale-token",
      resumeType: "codex_id",
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "fresh",
    });
    expect(launchHarness).toHaveBeenCalledTimes(2);
    expect(launchHarness.mock.calls[0]![1]).toEqual({
      name: "r01-impl",
      resumeToken: "stale-token",
    });
    expect(launchHarness.mock.calls[1]![1]).toEqual({
      name: "r01-impl",
      resumeToken: undefined,
    });

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.resumeToken).toBe("fresh-token");
    expect(session!.resumeType).toBe("codex_id");
    expect(session!.startupStatus).toBe("ready");
  });

  // 支持 pod 的 Codex auth-refusal：launchHarness 报告带 evidence 的
  // recovery: "attention_required" 时，orchestrator 必须呈现
  // startup_status: "attention_required" 并保留 evidence（不得回退到 fresh launch——
  // 这会让用户可通过重新运行 `codex login` 解决的 state 丢失 continuity）。
  it("传播 attention_required recovery，不回退到 fresh", async () => {
    const seed = seedSession();
    const refusalEvidence = [
      "$ codex resume stale-token",
      "Error: Your access token could not be refreshed because you have since",
      "logged out or signed in to another account. Please sign in again.",
    ].join("\n");
    const launchHarness = vi.fn().mockResolvedValueOnce({
      ok: false as const,
      error: "Codex auth-refusal: please sign in again",
      recovery: "attention_required",
      evidence: refusalEvidence,
    });
    const adapter = mockAdapter({ runtime: "codex", launchHarness });
    const orch = createOrchestrator();

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "stale-token",
      resumeType: "codex_id",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.startupStatus).toBe("attention_required");
      // evidence 保留在 StartupResult 上，使 restore-orchestrator 可填充
      // RestoreNodeResult 的 attentionEvidence。
      expect(result.evidence).toBe(refusalEvidence);
      expect(result.errors.some((e) => e.includes("运行环境启动需要处理"))).toBe(true);
    }
    // 关键：launchHarness 仅调用一次——不做 fresh-fallback retry。auth-refusal 可由用户恢复，
    // 并非 stale-token signal。
    expect(launchHarness).toHaveBeenCalledTimes(1);

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.startupStatus).toBe("attention_required");
    expect(session!.resumeType).toBe("codex_id");
    expect(session!.resumeToken).toBe("stale-token");
    expect(session!.resumeProvenance).toBeNull();
    expect(session!.resumeLastVerified).toBeNull();
    expect(session!.resumeLastProbeStatus).toBeNull();
  });

  it.each([
    "runner exited (code 1)",
    "readiness timed out before the runtime became interactive",
  ])("preserves attempted lineage without certifying attention outcome: %s", async (error) => {
    const seed = seedSession();
    const adapter = mockAdapter({
      runtime: "pi",
      launchHarness: vi.fn(async () => ({
        ok: false as const,
        error,
        recovery: "attention_required" as const,
      })),
    });

    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "attempted-pi-token",
      resumeType: "pi_session_file",
    }));

    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("attention_required");
    const session = sessionRegistry.getSessionsForRig(seed.rigId).find((s) => s.id === seed.sessionId)!;
    expect(session.resumeType).toBe("pi_session_file");
    expect(session.resumeToken).toBe("attempted-pi-token");
    expect(session.resumeProvenance).toBeNull();
    expect(session.resumeLastVerified).toBeNull();
    expect(session.resumeLastProbeStatus).toBeNull();
  });

  // NS-T05：readiness 重试 loop
  it("readiness 持续重试直至 ready", async () => {
    const seed = seedSession();
    let callCount = 0;
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => {
        callCount++;
        // 第 3 次尝试时 ready
        return callCount >= 3 ? { ready: true } : { ready: false, reason: "not yet" };
      }),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 10_000 }));
    expect(result.ok).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("readiness 超时 → startup_failed，并带超时消息", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({ ready: false, reason: "harness not interactive" })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 100 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("超时"))).toBe(true);
    }
  });

  it("readiness blocker 立即以 blocker reason 失败，而非等待超时", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        reason: "Codex is waiting for workspace trust approval before the session can become interactive.",
        code: "trust_gate",
      })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 10_000 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.startupStatus).toBe("attention_required");
      expect(result.errors.some((e) => e.includes("启动需要处理"))).toBe(true);
      expect(result.errors.some((e) => e.includes("超时"))).toBe(false);
    }
  });

  it("在 agent role guidance 旁交付 openrig-start.md overlay（追加而非替换）", async () => {
    const seed = seedSession();
    const deliveredFiles: string[] = [];
    const adapter = mockAdapter({
      deliverStartup: vi.fn(async (files) => {
        for (const f of files) deliveredFiles.push(f.path);
        return { delivered: files.length, failed: [] };
      }),
    });
    const roleFile: ResolvedStartupFile = {
      path: "guidance/role.md",
      absolutePath: "/agents/impl/guidance/role.md",
      ownerRoot: "/agents/impl",
      deliveryHint: "guidance_merge",
      required: true,
      appliesOn: ["fresh_start", "restore"],
    };
    const onboardingFile: ResolvedStartupFile = {
      path: "openrig-start.md",
      absolutePath: "/assets/guidance/openrig-start.md",
      ownerRoot: "/assets",
      deliveryHint: "guidance_merge",
      required: false,
      appliesOn: ["fresh_start", "restore"],
    };

    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [roleFile, onboardingFile],
    }));

    expect(result.ok).toBe(true);
    // 两个文件都已交付——追加 overlay，而非替换 role guidance
    expect(deliveredFiles).toContain("guidance/role.md");
    expect(deliveredFiles).toContain("openrig-start.md");
  });
});
