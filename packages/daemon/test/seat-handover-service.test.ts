import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { WatchdogAutoRegistration } from "../src/domain/watchdog-auto-registration.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, type DeliveryFn } from "../src/domain/watchdog-policy-engine.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { observeCodexSandbox } from "../src/domain/permission-drift.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";

describe("SeatHandoverService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let hasSession: ReturnType<typeof vi.fn>;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let setRemainOnExit: ReturnType<typeof vi.fn>;
  let signalPaneProcess: ReturnType<typeof vi.fn>;
  let isPaneDead: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let sendKeys: ReturnType<typeof vi.fn>;
  let capturePaneScreen: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;
  let invalidateRetiringOccupant: ReturnType<typeof vi.fn>;
  let declareOccupantSwap: ReturnType<typeof vi.fn>;
  let resolvePredecessorRecap: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;
  let service: SeatHandoverService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    hasSession = vi.fn(async () => true);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    setRemainOnExit = vi.fn(async () => ({ ok: true }));
    signalPaneProcess = vi.fn(async () => ({ ok: true }));
    isPaneDead = vi.fn(async () => true); // 切换时，退役者收到 SIGTERM 后正常退出
    sendText = vi.fn(async () => ({ ok: true }));
    sendKeys = vi.fn(async () => ({ ok: true }));
    capturePaneScreen = vi.fn(async () => "predecessor screen tail");
    // B1 —— 使用抓取到的恢复令牌（B2 launched 模式），将全新后继者启动为实时智能体
    //（launchHarness + 就绪检查）。
    launchHarness = vi.fn(async () => ({
      ok: true,
      resumeToken: "codex-launch-tok",
      resumeType: "codex_id",
      appliedLaunch: observeCodexSandbox(" -s workspace-write"),
    }));
    checkReady = vi.fn(async () => ({ ready: true }));
    // B2 —— discovered 模式的推导辅助依赖，默认使用 Codex 线程 ID 捕获器。
    readSidecar = vi.fn(() => ({ ok: true, data: { session_id: "claude-sid-123" } }));
    captureCodexThreadId = vi.fn(async () => "codex-discovered-tok");
    invalidateRetiringOccupant = vi.fn();
    declareOccupantSwap = vi.fn();
    resolvePredecessorRecap = vi.fn(() => ({ unavailableReason: "test default: no record" }));
    // KI-14：健康默认值——重生后的窗格以空白 shell 启动。
    getDefaultShell = vi.fn(async () => "/bin/zsh");
    getPaneCommand = vi.fn(async () => "zsh");
    service = newService();
  });

  afterEach(() => {
    db.close();
  });

  function tmux(): TmuxAdapter {
    return { hasSession, createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, sendText, sendKeys, capturePaneScreen, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
  }

  function codexAdapter(): RuntimeAdapter {
    return { runtime: "codex", launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function newService(adapter: TmuxAdapter = tmux()): SeatHandoverService {
    return new SeatHandoverService({
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: adapter,
      now: () => new Date("2026-04-24T18:30:00.000Z"),
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { codex: codexAdapter() },
      contextUsageStore: { readSidecar } as never,
      resumeTokenCapturer: { captureCodexThreadId } as never,
      occupantInvalidator: { invalidateRetiringOccupant },
      activityOracle: { declareOccupantSwap },
      predecessorRecapResolver: resolvePredecessorRecap as never,
      readinessTimeoutMs: 50,
      sleep: async () => {},
    });
  }

  function seedSeat(opts?: { runtime?: string; withSession?: boolean; model?: string; codexConfigProfile?: string }) {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: opts?.runtime ?? "codex", cwd: "/project", model: opts?.model, codexConfigProfile: opts?.codexConfigProfile });
    let sessionId: string | null = null;
    if (opts?.withSession !== false) {
      const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
      sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
      sessionId = session.id;
    }
    return { rig, node, sessionId };
  }

  function seedDiscovery(opts?: { id?: string; tmuxSession?: string; tmuxPane?: string; runtimeHint?: "codex" | "claude-code" | "terminal" | "unknown" }) {
    const discovered = discoveryRepo.upsertDiscoveredSession({
      tmuxSession: opts?.tmuxSession ?? "successor-session",
      tmuxPane: opts?.tmuxPane ?? "%1",
      tmuxWindow: "0",
      runtimeHint: opts?.runtimeHint ?? "codex",
      confidence: "high",
      cwd: "/project",
    });
    if (opts?.id && opts.id !== discovered.id) {
      db.prepare("UPDATE discovered_sessions SET id = ? WHERE id = ?").run(opts.id, discovered.id);
      return discoveryRepo.getDiscoveredSession(opts.id)!;
    }
    return discovered;
  }

  function durableRows(): string {
    const tables = ["nodes", "sessions", "bindings", "discovered_sessions", "events"] as const;
    return JSON.stringify(Object.fromEntries(tables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ])));
  }

  it("将活动席位绑定到已创建且被发现的后继者", async () => {
    const { rig, node, sessionId } = seedSeat();
    const discovered = seedDiscovery();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "mvp-proof",
      source: `discovered:${discovered.id}`,
      operator: "orch-lead@seat-rig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("result" in result)) throw new Error("应返回交接结果");
    expect(result.result).toMatchObject({
      ok: true,
      dryRun: false,
      mutated: true,
      continuityTransferred: false,
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "successor-session",
      source: { mode: "discovered", ref: discovered.id },
      currentStatus: {
        sessionStatus: "running",
        startupStatus: "ready",
        occupantLifecycle: "active",
        continuityOutcome: null,
        handoverResult: "complete",
        previousOccupant: "dev-impl@seat-rig",
        handoverAt: "2026-04-24T18:30:00.000Z",
      },
      sideEffects: {
        departingSessionKilled: false,
        startupContextDelivered: false,
        provenanceRecordWritten: false,
      },
    });
    expect(result.result.previousSessionIdsSuperseded).toContain(sessionId);
    expect(hasSession).toHaveBeenCalledWith("successor-session");

    const sessions = sessionRegistry.getSessionsForRig(rig.id).filter((session) => session.nodeId === node.id);
    expect(sessions.map((session) => ({ name: session.sessionName, status: session.status, origin: session.origin, startup: session.startupStatus }))).toEqual([
      { name: "dev-impl@seat-rig", status: "superseded", origin: "launched", startup: "ready" },
      { name: "successor-session", status: "running", origin: "claimed", startup: "ready" },
    ]);
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("successor-session");
    const claimed = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.claimedNodeId).toBe(node.id);
    const nodeRow = db.prepare("SELECT occupant_lifecycle, continuity_outcome, handover_result, previous_occupant, handover_at FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow).toEqual({
      occupant_lifecycle: "active",
      continuity_outcome: null,
      handover_result: "complete",
      previous_occupant: "dev-impl@seat-rig",
      handover_at: "2026-04-24T18:30:00.000Z",
    });
    const event = db.prepare("SELECT type, payload FROM events WHERE type = 'seat.handover_completed' ORDER BY seq DESC LIMIT 1").get() as { type: string; payload: string };
    expect(event.type).toBe("seat.handover_completed");
    expect(JSON.parse(event.payload)).toMatchObject({
      type: "seat.handover_completed",
      rigId: rig.id,
      nodeId: node.id,
      logicalId: "dev.impl",
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "successor-session",
      source: `discovered:${discovered.id}`,
      reason: "mvp-proof",
      operator: "orch-lead@seat-rig",
    });
  });

  it.each(["active", "stopped"] as const)(
    "初始状态为 %s 时，将角色绑定的 watchdog 接力棒交给不同的已发现后继者",
    async (initialState) => {
      const now = new Date("2026-04-24T18:30:00.000Z");
      const jobsRepo = new WatchdogJobsRepository(db, () => now);
      const autoRegistration = new WatchdogAutoRegistration({
        db,
        jobsRepo,
        settingsStore: {
          resolveOne(key: string) {
            // B6 —— 这些接力棒测试以前提已有作业，因此 fake 会为 fleet 选择加入。
            if (key.endsWith("auto_register")) return { value: "all" };
            if (key.endsWith("opt_in_sessions")) return { value: "" };
            return { value: key.endsWith("active_wake_interval_seconds") ? 900 : 60 };
          },
        } as never,
      });
      sessionRegistry.setWatchdogRegistrationObserver(autoRegistration);

      const { node } = seedSeat();
      const retiredSession = "dev-impl@seat-rig";
      const successorSession = "dev-successor@seat-rig";
      const [original] = jobsRepo.listAll().filter((job) => job.policy === "idle-gate-qitem");
      expect(original).toBeDefined();
      if (!original) return;
      if (initialState === "stopped") {
        db.prepare("UPDATE watchdog_jobs SET state = 'stopped' WHERE job_id = ?").run(original.jobId);
      }

      const discovered = seedDiscovery({ tmuxSession: successorSession });
      const result = await service.handover({
        seatRef: retiredSession,
        reason: "watchdog-baton-proof",
        source: `discovered:${discovered.id}`,
        operator: "orch-lead@seat-rig",
      });
      expect(result.ok).toBe(true);

      const roleRows = jobsRepo.listAll().filter((job) =>
        job.policy === "idle-gate-qitem" && job.targetGeneration === null
      );
      const held = roleRows.filter((job) => job.state === "active" || job.state === "stopped");
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({
        jobId: original.jobId,
        state: initialState,
        targetSession: successorSession,
      });
      expect(held[0]?.specYaml).toContain(`target:\n  session: ${successorSession}\n`);
      expect(roleRows.filter((job) => job.targetSession === retiredSession && job.state === "active")).toEqual([]);

      if (initialState === "active" && held[0]) {
        db.prepare(
          `INSERT INTO queue_items
            (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
           VALUES
            ('q-retired-watchdog', '2026-04-24T18:00:00Z', '2026-04-24T18:00:00Z',
             'orch@seat-rig', ?, 'pending', 'urgent', 'deep', '["gate:guard"]', 'retired target')`,
        ).run(retiredSession);
        const deliveries: Array<{ targetSession: string; message: string }> = [];
        const deliver: DeliveryFn = async (request) => {
          deliveries.push(request);
          return { status: "ok" };
        };
        const engine = new WatchdogPolicyEngine({
          jobsRepo,
          historyLog: new WatchdogHistoryLog(db),
          eventBus,
          deliver,
          now: () => now,
          additionalPolicies: [makeIdleGateQitemPolicy({
            db,
            seatActivity: { getSeatStateBySession: () => null },
          })],
        });

        const evaluation = await engine.evaluate(jobsRepo.getByIdOrThrow(held[0].jobId));
        expect(evaluation.outcome).toEqual({ action: "skip", reason: "no_pending_gate" });
        expect(deliveries, "退役会话不再持有可交付的 watchdog").toEqual([]);
      } else {
        expect(jobsRepo.listActive()).toEqual([]);
      }
    },
  );

  it("真实交接接纳非规范的已发现后继者时停用退役 watchdog", async () => {
    const now = new Date("2026-04-24T18:30:00.000Z");
    db.exec(watchdogHistorySchema.sql);
    const jobsRepo = new WatchdogJobsRepository(db, () => now);
    sessionRegistry.setWatchdogRegistrationObserver(new WatchdogAutoRegistration({
      db,
      jobsRepo,
      settingsStore: {
        resolveOne(key: string) {
          // B6 —— 本测试以前提已有作业，因此 fake 会为 fleet 选择加入。
          if (key.endsWith("auto_register")) return { value: "all" };
          if (key.endsWith("opt_in_sessions")) return { value: "" };
          return { value: key.endsWith("active_wake_interval_seconds") ? 900 : 60 };
        },
      } as never,
    }));

    seedSeat();
    const retiredSession = "dev-impl@seat-rig";
    const original = jobsRepo.listActive().find((job) => job.policy === "idle-gate-qitem");
    expect(original).toBeDefined();
    if (!original) return;
    db.prepare(
      `INSERT INTO queue_items
        (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
       VALUES
        ('q-retired-noncanonical', '2026-04-24T18:00:00Z', '2026-04-24T18:00:00Z',
         'orch@seat-rig', ?, 'pending', 'urgent', 'deep', '["gate:guard"]', 'retired target')`,
    ).run(retiredSession);
    const discovered = seedDiscovery();
    const result = await service.handover({
      seatRef: retiredSession,
      reason: "noncanonical-watchdog-proof",
      source: `discovered:${discovered.id}`,
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);

    const activeRoleJobs = jobsRepo.listActive().filter((job) =>
      job.policy === "idle-gate-qitem" && job.targetGeneration === null
    );
    const deliveries: Array<{ targetSession: string; message: string }> = [];
    const deliver: DeliveryFn = async (request) => {
      deliveries.push(request);
      return { status: "ok" };
    };
    const engine = new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: new WatchdogHistoryLog(db),
      eventBus,
      deliver,
      now: () => now,
      additionalPolicies: [makeIdleGateQitemPolicy({
        db,
        seatActivity: { getSeatStateBySession: () => null },
      })],
    });
    for (const job of activeRoleJobs) await engine.evaluate(job);

    expect.soft(activeRoleJobs.filter((job) => job.targetSession === retiredSession)).toEqual([]);
    expect.soft(deliveries.filter((delivery) => delivery.targetSession === retiredSession)).toEqual([]);
  });

  it("保持 dry-run 无副作用", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(durableRows()).toBe(before);
  });

  it.each([
    ["默认来源", undefined],
    ["全新来源", "fresh"],
    ["重建来源", "rebuild"],
    ["分叉来源", "fork:abc123"],
    ["已发现来源", "discovered:some-id"],
  ])("对%s保持 dry-run 无变更（AC-1）", async (_label, source) => {
    seedSeat();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("接缝 B（R2/Guard）：无策略席位的全新交接即使存在 OPENRIG_YOLO，也以显式 floor 启动真实后继者", async () => {
    // 生产层级：固定项端到端驱动 SeatHandoverService.handover()，并断言真实
    // launchHarness 调用收到的绑定，绝不使用重新计算的回退链；这正是 c203812f 中 Guard
    // 拒绝的仅辅助函数假绿。
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      seedSeat({ runtime: "codex" }); // 任何位置都没有节点/工作组策略溯源
      const result = await service.handover({
        seatRef: "dev-impl@seat-rig",
        reason: "context-wall",
        source: "fresh",
        operator: "orch-lead@seat-rig",
      });
      expect(result.ok).toBe(true);
      expect(launchHarness).toHaveBeenCalledTimes(1);
      const successorBinding = launchHarness.mock.calls[0]![0] as { launchPosture?: string };
      // 锁定的缺失契约：连续性边显式绑定最低 floor；环境 YOLO 不得放宽无附件后继者。
      expect(successorBinding.launchPosture).toBe("floor");
    } finally { vi.unstubAllEnvs(); }
  });

  it("仅在生成交接代际后持久化后继者的已应用效果", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const predecessor = sessionRegistry.currentOccupantTenure(node.id)!;
    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);
    const successor = sessionRegistry.currentOccupantTenure(node.id)!;
    expect(successor.generationUuid).not.toBe(predecessor.generationUuid);
    expect(new AppliedLaunchObservationStore(db).readCurrent(node.id)).toMatchObject({
      generationUuid: successor.generationUuid,
      runtime: "codex",
      axis: "sandbox",
      value: "workspace-write",
    });
  });

  it("关键证明（0.5.2-07）：spec 固定模型的席位交接使用该模型启动后继者，走真实 lookupNode→createSuccessor→launchHarness 路径", async () => {
    // 与接缝 B 形态相同：由 service.handover() 端到端驱动，断言真实 launchHarness 收到
    // 的绑定。launcher 层关键证明直接注入 node.model，无法捕获 lookupNode 丢列，本测试可以。
    // main 上为红：lookupNode 只查询 id/runtime/cwd，导致 spec 固定模型在构建后继绑定前丢失。
    seedSeat({ runtime: "codex", model: "gpt-5.4-cheap" });
    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const successorBinding = launchHarness.mock.calls[0]![0] as { model?: string };
    expect(successorBinding.model).toBe("gpt-5.4-cheap");
  });

  it("关键证明（0.5.2-07 A4-profile）：codex_config_profile 固定席位的交接使用该 profile 启动后继者", async () => {
    // A4-profile 针对 codex_config_profile 列复现 A2-1。Codex 适配器已从
    // binding.codexConfigProfile 输出 `-p <profile>`；缺口在交接传递：lookupNode 必须查询
    // codex_config_profile，createSuccessor 必须将其传入后继绑定。该基线上为红：lookupNode
    // 只查询 id/runtime/cwd/model，导致固定 profile 在构建后继绑定前丢失。恢复路径已经
    // 传递该值（restore-orchestrator.ts），交接路径此前没有。
    seedSeat({ runtime: "codex", codexConfigProfile: "prod-sandboxed" });
    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const successorBinding = launchHarness.mock.calls[0]![0] as { codexConfigProfile?: string };
    expect(successorBinding.codexConfigProfile).toBe("prod-sandboxed");
  });

  it("为全新来源组合完整周期：创建 → 交付 → 验证 → 重新绑定", async () => {
    const { node } = seedSeat({ runtime: "codex" });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("result" in result)) throw new Error("应返回交接结果");
    expect(result.result).toMatchObject({
      ok: true,
      mutated: true,
      previousOccupant: "dev-impl@seat-rig",
      // 切换后席位保留规范名称；使用者变为新智能体，但名称不变。
      currentOccupant: "dev-impl@seat-rig",
      source: { mode: "fresh" },
      sideEffects: { startupContextDelivered: true },
    });

    // 切换不会创建新会话；后继者在即将离开的窗格中原地重生，其身份环境变量携带保留的
    // 规范会话名称，绝不使用带 -h 的后继者名称。
    expect(createSession).not.toHaveBeenCalled();
    expect(listPanes).toHaveBeenCalledWith("dev-impl@seat-rig");
    expect(respawnPane).toHaveBeenCalledTimes(1);
    const [paneTarget, command, opts] = respawnPane.mock.calls[0]!;
    expect(paneTarget).toBe("%9"); // 从 listPanes 解析出的离开窗格
    // KI-14：显式使用空白 shell；undefined 会重新运行窗格内置的创建命令。
    expect(command).toBe("/bin/zsh");
    expect(opts).toMatchObject({ cwd: "/project" });
    expect(opts.env).toMatchObject({
      OPENRIG_NODE_ID: node.id,
      OPENRIG_SESSION_NAME: "dev-impl@seat-rig",
      OPENRIG_RUNTIME: "codex",
      OPENRIG_OCCUPANT_GENERATION: expect.any(String),
    });

    // 在原地重生前先解析离开窗格；发现候选项在保留名称下携带该窗格，提交会重新绑定到它。
    expect(listPanes.mock.invocationCallOrder[0]!).toBeLessThan(respawnPane.mock.invocationCallOrder[0]!);
    expect(result.result.discovery.tmuxPane).toBe("%9");
    const successorRow = db.prepare("SELECT tmux_pane FROM discovered_sessions WHERE tmux_session = ?").get("dev-impl@seat-rig") as { tmux_pane: string };
    expect(successorRow.tmux_pane).toBe("%9");

    // Driver 备注 3：在连续性存在性探测前，把恢复包（启动回顾）交付给保留窗格中的后继者；
    // 绝不验证尚未恢复的席位。
    expect(sendText).toHaveBeenCalledTimes(1);
    const [target, packet] = sendText.mock.calls[0]!;
    expect(target).toBe("dev-impl@seat-rig");
    expect(packet).toContain("zrig seat handover——恢复上下文");
    expect(packet).toContain("predecessor screen tail");
    expect(sendKeys).toHaveBeenCalledWith("dev-impl@seat-rig", ["C-m"]);
    expect(sendText.mock.invocationCallOrder[0]!).toBeLessThan(hasSession.mock.invocationCallOrder[0]!);

    // B1：提交前已通过 launchHarness + 就绪检查把后继者启动为实时智能体，而不是只接收
    // 文本的裸 shell。
    expect(launchHarness).toHaveBeenCalledTimes(1);
    expect(checkReady).toHaveBeenCalled();
    // 重新绑定落在保留的席位名称上。
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    const nodeRow = db.prepare("SELECT occupant_lifecycle, handover_result, previous_occupant FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow).toMatchObject({ occupant_lifecycle: "active", handover_result: "complete", previous_occupant: "dev-impl@seat-rig" });

    // B2（launched/fresh）：启动时抓取的恢复令牌与提交原子地持久化到新认领会话，
    // provenance 为 scrape。切换保留席位名称，因此现在两行共享该名称：已被取代的退役者
    // 和活动后继者；应取最新的已认领行，与生产 latest-session 查询的 ORDER BY id DESC 一致。
    const newSession = db.prepare(
      "SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY id DESC LIMIT 1"
    ).get(node.id, "dev-impl@seat-rig") as Record<string, string | null>;
    expect(newSession).toMatchObject({ resume_type: "codex_id", resume_token: "codex-launch-tok", resume_provenance: "scrape" });
    expect(sessionRegistry.currentOccupantTenure(node.id)?.generationUuid)
      .toBe(opts.env.OPENRIG_OCCUPANT_GENERATION);
  });

  it("KI-14（5.3 wave-1）：全新交接提交把 continuity_outcome 标记为 fresh，绝不能为 null", async () => {
    // 线上缺陷的标签侧（2026-08-22 wave）：提交写入 continuity_outcome=NULL，随后
    // node-inventory 从数日前恢复留下的 restore_outcome 推导席位连续性，使 dev-qa/dev-guard
    // 在窗格运行 `codex resume <14-day-old-token>` 时仍报告 fresh/fresh-primed。记录标签必须
    // 描述本次启动。
    const { node } = seedSeat({ runtime: "codex" });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });
    expect(result.ok).toBe(true);

    const row = db.prepare("SELECT continuity_outcome, handover_result FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(row.handover_result).toBe("complete");
    expect(row.continuity_outcome).toBe("fresh");
  });

  it("交接提交失败后，携带的预留代际保持未注册且不误匹配", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    vi.spyOn(eventBus, "persistWithinTransaction").mockImplementationOnce(() => {
      throw new Error("injected commit failure");
    });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "commit-failure-proof",
      source: "fresh",
    });

    expect(result).toMatchObject({ ok: false, code: "handover_commit_failed" });
    const env = respawnPane.mock.calls[0]![2]!.env as Record<string, string>;
    const reserved = env.OPENRIG_OCCUPANT_GENERATION;
    expect(reserved).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sessionRegistry.isOccupantGenerationRegistered(node.id, reserved)).toBe(false);

    const store = new AgentActivityStore({
      db,
      eventBus,
      resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (nodeId, generation) =>
        sessionRegistry.isOccupantGenerationRegistered(nodeId, generation),
    });
    store.recordHookEvent({
      runtime: "codex",
      sessionName: "dev-impl@seat-rig",
      hookEvent: "Stop",
      generation: reserved,
    });

    expect(store.getLatestForNode({ nodeId: node.id, sessionName: "dev-impl@seat-rig" })).toMatchObject({
      state: "unknown",
      reason: "generation_unresolvable",
      generationProvenance: "unresolved",
    });
  });

  it("幽灵阶段重新分配标识接缝：提交时用退役/后继名称及退役代际调用 invalidateRetiringOccupant", async () => {
    // 切换会使退役使用者按席位名称索引的存储失效，避免后继者继承幽灵状态（dev50 切片的
    // ghost-stage 契约）。本席位负责 commit() 时的机械调用；dev50 负责
    // OccupantInvalidator 接口后的逐存储实现。切换中后继者复用席位名称，因此按名称看
    // retiring === successor；Class-A 依靠时序保证安全，Class-B 则通过 retiringGeneration
    //（atom-B）限定代际。该值是 registerClaimedSession 在复用名称下创建后继任期前捕获的
    // 退役使用者代际。
    seedSeat({ runtime: "codex" });
    const retiringGen = sessionRegistry.currentOccupantGenerationForSession("dev-impl@seat-rig");
    expect(retiringGen, "退役者具有可用于限定代际的 atom-B 任期").toBeTruthy();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    expect(invalidateRetiringOccupant).toHaveBeenCalledTimes(1);
    expect(invalidateRetiringOccupant).toHaveBeenCalledWith({
      retiringSessionName: "dev-impl@seat-rig",
      successorSessionName: "dev-impl@seat-rig",
      retiringGeneration: retiringGen, // 创建前捕获的是退役者代际，而不是后继者代际
    });
    // 证明捕获的是退役者代际：交接已在复用名称下创建新的后继任期，因此节点当前代际与
    // invalidator 收到的值不同。
    const successorGen = sessionRegistry.currentOccupantGenerationForSession("dev-impl@seat-rig");
    expect(successorGen).not.toBe(retiringGen);
  });

  it("交接在提交前失败时不使退役使用者失效，未提交的交接不重新分配标识", async () => {
    seedSeat({ runtime: "codex" });
    respawnPane.mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(false);
    expect(invalidateRetiringOccupant).not.toHaveBeenCalled();
  });

  it("S19（territory 裁定 01530）：提交向活动事实源声明使用者切换，席位键控层级重新声明且不串扰", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const retiringGen = sessionRegistry.currentOccupantGenerationForSession("dev-impl@seat-rig");

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    expect(declareOccupantSwap).toHaveBeenCalledTimes(1);
    const [seatNodeId, generation] = declareOccupantSwap.mock.calls[0]! as [string, string];
    expect(seatNodeId).toBe(node.id); // 席位键控使用持久节点 ID，绝不使用会话名称
    expect(typeof generation).toBe("string");
    expect(generation.length).toBeGreaterThan(0);
    expect(generation).not.toBe(retiringGen); // 切换身份是后继任期，而不是退役者
  });

  it("S19：提交前失败的交接绝不声明切换，不产生幽灵切换事件", async () => {
    seedSeat({ runtime: "codex" });
    respawnPane.mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(false);
    expect(declareOccupantSwap).not.toHaveBeenCalled();
  });

  it("回顾环节：记录解析成功时把前任回顾与记录路径写入交付的恢复包", async () => {
    // 回顾环节执行：解析前任的提供方记录 → 生成有界且标明来自记录的回顾 → 写入交付给
    // 后继者的包。降级会如实标明，绝不称作“回滚缓冲区”。
    seedSeat({ runtime: "codex" });
    resolvePredecessorRecap.mockReturnValue({
      recap: [
        { role: "user", content: "finish the atom" },
        { role: "assistant", content: "atom finished; handing over" },
      ],
      recordPath: "/home/.claude/projects/x/abc.jsonl",
    });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    expect(resolvePredecessorRecap).toHaveBeenCalledTimes(1);
    const [target, packet] = sendText.mock.calls[0]!;
    expect(target).toBe("dev-impl@seat-rig");
    expect(packet).toContain("前任回顾（从记录重放，并非实时终端）");
    expect(packet).toContain("user: finish the atom");
    expect(packet).toContain("/home/.claude/projects/x/abc.jsonl");
    expect(packet).toContain("如实降级");
  });

  it("回顾环节（B16）：无法解析的回顾作为具名不可用行进入包，绝不静默省略", async () => {
    seedSeat({ runtime: "codex" });
    resolvePredecessorRecap.mockReturnValue({ unavailableReason: "no resume token recorded for the departing codex session" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    const [, packet] = sendText.mock.calls[0]!;
    expect(packet).not.toContain("前任回顾（从记录重放");
    expect(packet).toContain("--- 前任回顾不可用：no resume token recorded for the departing codex session ---");
    // 基础包仍交付捕获到的前任终端内容。
    expect(packet).toContain("predecessor screen tail");
  });

  it("B16 重做：包交付使用共享的先粘贴后提交顺序，在 send_text 与 C-m 之间等待稳定", async () => {
    seedSeat({ runtime: "codex" });
    const sleeps: number[] = [];
    const orderedCalls: string[] = [];
    sendText.mockImplementation(async () => { orderedCalls.push("send_text"); return { ok: true }; });
    sendKeys.mockImplementation(async () => { orderedCalls.push("submit"); return { ok: true }; });
    const sleepSpy = async (ms: number) => { sleeps.push(ms); if (orderedCalls[orderedCalls.length - 1] === "send_text") orderedCalls.push(`sleep(${ms})`); };
    service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
      tmuxAdapter: tmux(),
      now: () => new Date("2026-04-24T18:30:00.000Z"),
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { codex: codexAdapter() },
      contextUsageStore: { readSidecar } as never,
      resumeTokenCapturer: { captureCodexThreadId } as never,
      occupantInvalidator: { invalidateRetiringOccupant },
      activityOracle: { declareOccupantSwap },
      predecessorRecapResolver: resolvePredecessorRecap as never,
      readinessTimeoutMs: 50,
      sleep: sleepSpy,
    });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    // 稳定等待位于粘贴和提交之间，这是传输层已证明的契约。
    const sendIdx = orderedCalls.indexOf("send_text");
    const settleIdx = orderedCalls.indexOf("sleep(200)");
    const submitIdx = orderedCalls.indexOf("submit");
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(settleIdx).toBeGreaterThan(sendIdx);
    expect(submitIdx).toBeGreaterThan(settleIdx);
    expect(sleeps).toContain(200);
  });

  it("回顾环节（B16）：解析器在后继者启动前运行，避免后继者覆盖按名称索引的 sidecar", async () => {
    seedSeat({ runtime: "codex" });
    resolvePredecessorRecap.mockReturnValue({ recap: [{ role: "user", content: "pre-launch read" }], recordPath: "/p/a.jsonl" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result.ok).toBe(true);
    const resolveOrder = resolvePredecessorRecap.mock.invocationCallOrder[0]!;
    const launchOrder = launchHarness.mock.invocationCallOrder[0]!;
    expect(resolveOrder).toBeLessThan(launchOrder);
  });

  // OPR.0.5.5.5（05-handover-sources-real）翻转了旧 B3 固定项：fork 和 rebuild 现在
  // 会真正执行，完整覆盖位于 seat-handover-sources.test.ts。B3 保留的是安全核心：无法继续
  // 的来源会在变更前如实拒绝，绝不把空白后继者报告为完成。
  it("OPR.0.5.5.5：fork 缺少可发现的原生 ID 时在变更前如实拒绝，席位保持不变", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:0b0165d7" });

    expect(result).toMatchObject({ ok: false, code: "fork_source_not_found" });
    expect(createSession).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    // 原席位与绑定保持不变，没有节点被标记为交接完成。
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    const nodeRow = db.prepare("SELECT handover_result FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow.handover_result).not.toBe("complete");
    expect(durableRows()).toBe(before);
  });

  it("B3：仍为 fork/rebuild 返回 dry-run 计划，不阻塞规划", async () => {
    seedSeat({ runtime: "codex" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:abc", dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(durableRows()).toBe(before);
  });

  it("B2：提交时捕获已发现后继者的实时恢复令牌（codex）", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const discovered = seedDiscovery();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "mvp-proof",
      source: `discovered:${discovered.id}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("result" in result)) throw new Error("应返回交接结果");
    // 复用 FR-3 推导辅助逻辑；令牌以 provenance "adoption" 持久化到新认领会话，
    // 且绝不会出现在事件日志中。
    expect(captureCodexThreadId).toHaveBeenCalledWith("successor-session");
    const newSession = db.prepare(
      "SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? AND session_name = ?"
    ).get(node.id, "successor-session") as Record<string, string | null>;
    expect(newSession).toMatchObject({ resume_type: "codex_id", resume_token: "codex-discovered-tok", resume_provenance: "adoption" });
    const captureEvent = db.prepare("SELECT payload FROM events WHERE type = 'session.resume_token_captured' ORDER BY seq DESC LIMIT 1").get() as { payload: string } | undefined;
    expect(captureEvent).toBeTruthy();
    const payload = JSON.parse(captureEvent!.payload);
    expect(payload).toMatchObject({ outcome: "captured", provenance: "adoption", redacted: true });
    expect(JSON.stringify(payload)).not.toContain("codex-discovered-tok");
  });

  it("B2：无法推导已发现令牌时如实进行脱敏跳过", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const discovered = seedDiscovery();
    captureCodexThreadId.mockResolvedValue(undefined); // 探测未找到结果

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "mvp-proof",
      source: `discovered:${discovered.id}`,
    });

    // 交接仍成功；令牌保持 NULL，并发出脱敏的跳过事件。
    expect(result.ok).toBe(true);
    const newSession = db.prepare(
      "SELECT resume_token FROM sessions WHERE node_id = ? AND session_name = ?"
    ).get(node.id, "successor-session") as Record<string, string | null>;
    expect(newSession.resume_token).toBeNull();
    const skipEvent = db.prepare("SELECT payload FROM events WHERE type = 'session.resume_token_captured' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(skipEvent.payload)).toMatchObject({ outcome: "skipped", reason: "probe_timeout", redacted: true });
  });

  it("原地重生失败时醒目失败并保留绑定", async () => {
    const { node } = seedSeat();
    respawnPane.mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    expect((result as { message: string }).message).toContain("create_successor");
    expect(launchHarness).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    // 席位绑定保持不变，因为提交从未执行。
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(durableRows()).toBe(before);
  });

  it("解析离开窗格时 listPanes 抛出异常会映射为醒目的 successor_create_failed，且席位不变", async () => {
    const { node } = seedSeat();
    // 离开窗格探测在任何重生前重新抛出异常，因此实时退役者完全不受影响。
    listPanes.mockRejectedValue(new Error("socket permission denied"));
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    expect((result as { message: string }).message).toContain("resolve_pane");
    // 切换不变量：回退时绝不终止保留席位；验证与交付都未运行。
    expect(respawnPane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(durableRows()).toBe(before);
  });

  it("交接在物理替换前失败时保留前任姿态事实", async () => {
    const { node } = seedSeat();
    const store = new AppliedLaunchObservationStore(db);
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    store.recordGeneration(generation, observeCodexSandbox(" -s workspace-write"));
    listPanes.mockRejectedValue(new Error("socket unavailable"));

    expect((await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" })).ok).toBe(false);
    expect(store.readCurrent(node.id)).toMatchObject({ generationUuid: generation, value: "workspace-write" });
  });

  it.each(["launch", "readiness", "context-delivery"] as const)(
    "物理替换后 %s 失败时使前任姿态事实失效",
    async (failure) => {
      const { node } = seedSeat();
      const store = new AppliedLaunchObservationStore(db);
      const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
      store.recordGeneration(generation, observeCodexSandbox(" -s workspace-write"));
      if (failure === "launch") launchHarness.mockResolvedValue({ ok: false, error: "provider refused" });
      if (failure === "readiness") checkReady.mockResolvedValue({ ready: false, reason: "not interactive" });
      if (failure === "context-delivery") sendText.mockResolvedValue({ ok: false, code: "denied", message: "denied" });

      expect((await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" })).ok).toBe(false);
      expect(store.readCurrent(node.id)).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observations WHERE generation_uuid = ?").get(generation)).toEqual({ n: 0 });
    },
  );

  it("物理切换后、后继者就绪前使前任姿态失效", async () => {
    const { node } = seedSeat();
    const store = new AppliedLaunchObservationStore(db);
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    store.recordGeneration(generation, observeCodexSandbox(" -s workspace-write"));
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    checkReady.mockImplementation(async () => {
      await readyGate;
      return { ready: true };
    });

    const pending = service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });
    await vi.waitFor(() => expect(checkReady).toHaveBeenCalledTimes(1));
    expect(store.readCurrent(node.id)).toBeNull();
    expect(store.recordGeneration(generation, observeCodexSandbox(" -s danger-full-access"))).toBe(false);
    releaseReady();
    await pending;
  });

  it("唯一窗格退出移除 tmux server 导致重生失败前，使前任姿态失效", async () => {
    const { node } = seedSeat();
    const store = new AppliedLaunchObservationStore(db);
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    store.recordGeneration(generation, observeCodexSandbox(" -s workspace-write"));

    const adapter = new TmuxAdapter(async () => {
      throw new Error("no server running on /private/tmp/tmux-501/w3");
    });
    vi.spyOn(adapter, "capturePaneScreen").mockResolvedValue("predecessor screen tail");
    vi.spyOn(adapter, "listPanes").mockResolvedValue([
      { id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true },
    ]);
    vi.spyOn(adapter, "setRemainOnExit").mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });
    vi.spyOn(adapter, "signalPaneProcess").mockResolvedValue({ ok: true });
    vi.spyOn(adapter, "respawnPane").mockImplementation(async () => {
      expect(store.readCurrent(node.id)).toBeNull();
      return { ok: false, code: "no_server", message: "no server running" };
    });
    service = newService(adapter);

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    expect(adapter.respawnPane).toHaveBeenCalledTimes(1);
    expect(store.readCurrent(node.id)).toBeNull();
  });

  it("上下文交付失败时回退且不终止保留席位，避免假绿", async () => {
    const { node } = seedSeat();
    sendText.mockResolvedValue({ ok: false, code: "session_not_found", message: "can't find session" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "context_delivery_failed" });
    expect((result as { message: string }).message).toContain("deliver-restore-packet");
    // 连续性验证未运行；后继候选项被回退为 vanished，但保留席位绝不被终止，仍可从会话
    // 文件再次唤醒。
    expect(hasSession).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    const successorRow = db.prepare("SELECT status FROM discovered_sessions WHERE tmux_session = ?").get("dev-impl@seat-rig") as { status: string };
    expect(successorRow.status).toBe("vanished");
    // 席位绑定保持不变，因为提交从未执行。
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
  });

  it("交付后连续性验证失败时回退，且不终止保留席位", async () => {
    const { node } = seedSeat();
    hasSession.mockResolvedValue(false);

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_tmux_absent" });
    // 先完成交付，随后验证失败并回退；候选项变为 vanished，但不终止保留席位。
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(killSession).not.toHaveBeenCalled();
    const successorRow = db.prepare("SELECT status FROM discovered_sessions WHERE tmux_session = ?").get("dev-impl@seat-rig") as { status: string };
    expect(successorRow.status).toBe("vanished");
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
  });

  it("发现 ID 缺失时在变更前失败", async () => {
    seedSeat();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "discovered:missing",
    });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_found" });
    expect(durableRows()).toBe(before);
  });

  it("已发现后继者消失时在变更前失败", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    discoveryRepo.markVanished([discovered.id]);
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_active" });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("已发现后继者已被认领时在变更前失败", async () => {
    const { node } = seedSeat();
    const discovered = seedDiscovery();
    discoveryRepo.markClaimed(discovered.id, node.id);
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_active" });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("后继 tmux 会话不存在时在变更前失败", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    hasSession.mockResolvedValue(false);
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "successor_tmux_absent" });
    expect(durableRows()).toBe(before);
  });

  it("tmux 探测抛出异常时封闭失败", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    hasSession.mockRejectedValue(new Error("socket permission denied"));
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "tmux_probe_failed" });
    expect(durableRows()).toBe(before);
  });

  it("运行时不匹配时在变更前失败", async () => {
    seedSeat({ runtime: "codex" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code" });
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "runtime_mismatch" });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("后继者已在其他位置受管时在变更前失败", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    const otherRig = rigRepo.createRig("other-rig");
    const otherNode = rigRepo.addNode(otherRig.id, "dev.other", { runtime: "codex" });
    sessionRegistry.updateBinding(otherNode.id, { tmuxSession: "successor-session" });
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "successor_already_managed" });
    expect(durableRows()).toBe(before);
  });

  it("席位没有当前使用者时在变更前失败", async () => {
    seedSeat({ withSession: false });
    const discovered = seedDiscovery();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev.impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "current_occupant_required" });
    expect(durableRows()).toBe(before);
  });

  it("为已发现实时变更装配后台服务路由", async () => {
    const routeTmux = { hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
    const setup = createTestApp(db, { tmux: routeTmux });
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "route-successor",
      tmuxPane: "%2",
      runtimeHint: "codex",
      confidence: "high",
    });

    const res = await setup.app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "mvp-proof",
        source: `discovered:${discovered.id}`,
        operator: "orch-lead@seat-rig",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      dryRun: false,
      mutated: true,
      continuityTransferred: false,
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "route-successor",
      currentStatus: { handoverResult: "complete" },
    });
  });
});
