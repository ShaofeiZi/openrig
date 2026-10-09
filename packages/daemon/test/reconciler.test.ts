import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmuxAdapter(
  sessionExists: Record<string, boolean>,
  errors?: Record<string, Error>
): TmuxAdapter {
  const hasSession = async (name: string) => {
    if (errors?.[name]) {
      throw errors[name];
    }
    return sessionExists[name] ?? false;
  };
  return {
    hasSession,
    probeSession: async (name: string) =>
      (await hasSession(name)) ? { state: "present" as const } : { state: "absent" as const },
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

describe("Reconciler", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function createReconciler(tmux: TmuxAdapter) {
    return new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  }

  function seedRigWithSessions(statuses: { logicalId: string; sessionName: string; status: string }[]) {
    const rig = rigRepo.createRig("r01");
    const nodes: { id: string; logicalId: string }[] = [];
    for (const s of statuses) {
      const node = rigRepo.addNode(rig.id, s.logicalId, { role: "worker" });
      const session = sessionRegistry.registerSession(node.id, s.sessionName);
      sessionRegistry.updateStatus(session.id, s.status);
      nodes.push({ id: node.id, logicalId: s.logicalId });
    }
    return { rig, nodes };
  }

  it("session 仍存活：tmux 确认，状态保持不变", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": true }));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(1);
    expect(result.detached).toBe(0);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });

  it("session 消失：状态更新为 detached 并发出 event", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(1);
    expect(result.detached).toBe(1);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("detached");

    // Event 已持久化。
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'session.detached'")
      .all();
    expect(events).toHaveLength(1);

    // Subscriber 已收到通知。
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("session.detached");
  });

  it("DB 中没有 session：无变更、无 event", async () => {
    const rig = rigRepo.createRig("r01");
    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(0);

    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("跳过已 detached 的 session（不重复检查）", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "detached" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    // 已 detached，因此未检查。
    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
  });

  it("跳过已 exited 的 session（不重复检查）", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "exited" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
  });

  it("旧 pane 缺失时，被取代的 occupant 历史保持 terminal", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "superseded" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({}));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
    expect(sessionRegistry.getSessionsForRig(rig.id)[0]!.status).toBe("superseded");
    expect(db.prepare("SELECT * FROM events WHERE type = 'session.detached'").all()).toHaveLength(0);
  });

  it("多个节点：3 个 session 中 2 个存活、1 个消失时只分离后者", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
      { logicalId: "dev1-qa", sessionName: "r01-dev1-qa", status: "running" },
      { logicalId: "orch1-lead", sessionName: "r01-orch1-lead", status: "running" },
    ]);

    const reconciler = createReconciler(
      mockTmuxAdapter({
        "r01-dev1-impl": true,
        "r01-dev1-qa": false, // gone
        "r01-orch1-lead": true,
      })
    );
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(3);
    expect(result.detached).toBe(1);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    const qa = sessions.find((s) => s.sessionName === "r01-dev1-qa");
    expect(qa!.status).toBe("detached");
    const impl = sessions.find((s) => s.sessionName === "r01-dev1-impl");
    expect(impl!.status).toBe("running");
  });

  it("幂等：相同状态下协调两次不产生重复 event", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));

    await reconciler.reconcile(rig.id);
    const result2 = await reconciler.reconcile(rig.id);

    // 第二次运行时 session 已 detached，因此跳过。
    expect(result2.checked).toBe(0);
    expect(result2.detached).toBe(0);

    // 总共只有 1 个 event。
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'session.detached'")
      .all();
    expect(events).toHaveLength(1);
  });

  it("DB handle 不匹配时 constructor 抛错", () => {
    const otherDb = createDb();
    migrate(otherDb, [coreSchema, bindingsSessionsSchema, eventsSchema]);
    const otherRegistry = new SessionRegistry(otherDb);

    expect(
      () =>
        new Reconciler({
          db,
          sessionRegistry: otherRegistry,
          eventBus,
          tmuxAdapter: mockTmuxAdapter({}),
        })
    ).toThrow(/同一个数据库句柄/);

    otherDb.close();
  });

  it("markDetached + event 持久化具原子性（破坏 events 后无部分状态）", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    // 破坏 events 表，使 persistWithinTransaction 在 markDetached 后失败。
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));
    const result = await reconciler.reconcile(rig.id);

    // 此 session 应报告错误。
    expect(result.errors).toHaveLength(1);

    // Session 状态未改为 detached（事务已回滚）。
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });

  it("意外 tmux 错误：session 不标为 detached，结果包含错误", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(
      mockTmuxAdapter({}, { "r01-dev1-impl": new Error("unexpected tmux failure") })
    );
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0); // couldn't check it
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("unexpected tmux failure");

    // Session 未标为 detached。
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });

  // L1 冷启动 tmux 事实修复：重启后 socket 缺失由 probeSession 分类为 transport_unavailable；
  // Reconciler 在自身调用点选择把该状态视为可分离（OPR.0.5.4.2 mini-req 2），使 DB 状态在重启后
  // 仍与 tmux 现实一致。
  it("adapter 层 socket 缺失（probe 不存在）时分离 session 并发出 event", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const reconciler = createReconciler(mockTmuxAdapter({ "r01-dev1-impl": false }));
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(1);
    expect(result.detached).toBe(1);

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("detached");

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'session.detached'")
      .all();
    expect(events).toHaveLength(1);
  });

  it("adapter 层 permission 错误（hasSession 重抛）时不分离 session，并记录错误", async () => {
    const { rig } = seedRigWithSessions([
      { logicalId: "dev1-impl", sessionName: "r01-dev1-impl", status: "running" },
    ]);

    const permErr = new Error("error connecting to /private/tmp/tmux-501/default (Operation not permitted)");
    const reconciler = createReconciler(
      mockTmuxAdapter({}, { "r01-dev1-impl": permErr })
    );
    const result = await reconciler.reconcile(rig.id);

    expect(result.checked).toBe(0);
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("Operation not permitted");

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]!.status).toBe("running");
  });
});
