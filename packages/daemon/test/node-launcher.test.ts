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
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxOptionDefaultsApplier } from "../src/domain/tmux-option-defaults.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmuxAdapter(overrides?: {
  createSession?: (name: string, cwd?: string, env?: Record<string, string>) => Promise<TmuxResult>;
  killSession?: (name: string) => Promise<TmuxResult>;
  listPanes?: (target: string) => Promise<Array<{ id: string }>>;
}): TmuxAdapter {
  return {
    createSession: overrides?.createSession ?? (async () => ({ ok: true as const })),
    killSession: overrides?.killSession ?? (async () => ({ ok: true as const })),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: overrides?.listPanes ?? (async () => []),
    hasSession: async () => false,
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

describe("NodeLauncher", () => {
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

  function createLauncher(
    tmux?: TmuxAdapter,
    sessionEnv?: Record<string, string | undefined>,
    tmuxOptionDefaults?: TmuxOptionDefaultsApplier,
  ) {
    return new NodeLauncher({
      db,
      rigRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux ?? mockTmuxAdapter(),
      sessionEnv,
      tmuxOptionDefaults,
    });
  }

  function seedRigWithNode() {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl", {
      role: "worker",
      runtime: "claude-code",
    });
    return { rig, node };
  }

  it("成功路径：派生名称、创建 tmux、在单一事务中持久化 session+binding+event，并通知", async () => {
    const { rig, node } = seedRigWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledOnce();

    // 数据库：session 存在
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("running");

    // 数据库：binding 存在
    const fullRig = rigRepo.getRig(rig.id);
    const launchedNode = fullRig!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(launchedNode!.binding).not.toBeNull();

    // 数据库：event 存在
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(events).toHaveLength(1);

    // 已通知订阅者
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("node.launched");
  });

  it("launchNode 将已创建会话唯一的实时 pane 连同 session 和 binding 一起提交", async () => {
    const { rig, node } = seedRigWithNode();
    const listPanes = vi.fn(async () => [{ id: "%fresh" }]);
    const launcher = createLauncher(mockTmuxAdapter({ listPanes }));

    const result = await launcher.launchNode(rig.id, "dev1-impl", { occupantKind: "fresh" });

    expect(result.ok).toBe(true);
    expect(listPanes).toHaveBeenCalledWith(result.ok ? result.sessionName : "");
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%fresh");
    expect(sessionRegistry.currentOccupantTenure(node.id)?.kind).toBe("fresh");
  });

  it("派生的会话名称正确（rig.name + '-' + logicalId）", async () => {
    const { rig } = seedRigWithNode();
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    await launcher.launchNode(rig.id, "dev1-impl");

    expect(createSpy.mock.calls[0]![0]).toBe("r01-dev1-impl");
  });

  it("将运行时 hook 环境变量传给 tmux 会话创建，但不写入 provider 配置", async () => {
    const rig = rigRepo.createRig("test-rig");
    rigRepo.addNode(rig.id, "dev-qa", {
      role: "worker",
      runtime: "codex",
    });
    const createSpy = vi.fn<(name: string, cwd?: string, env?: Record<string, string>) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }), {
      OPENRIG_URL: "http://127.0.0.1:7644",
      OPENRIG_ACTIVITY_HOOK_TOKEN: "secret-token",
    });

    await launcher.launchNode(rig.id, "dev-qa");

    expect(createSpy.mock.calls[0]![2]).toEqual({
      OPENRIG_NODE_ID: expect.any(String),
      OPENRIG_SESSION_NAME: "r00-test-rig-dev-qa",
      OPENRIG_RUNTIME: "codex",
      OPENRIG_OCCUPANT_GENERATION: expect.any(String),
      OPENRIG_URL: "http://127.0.0.1:7644",
      OPENRIG_ACTIVITY_HOOK_TOKEN: "secret-token",
    });
  });

  it("将精确的启动前预留值传入 tmux，并注册同一 generation", async () => {
    const { rig, node } = seedRigWithNode();
    let launchEnv: Record<string, string> | undefined;
    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async (_name, _cwd, env) => {
          launchEnv = env;
          return { ok: true };
        },
      }),
      { OPENRIG_OCCUPANT_GENERATION: "stale-ambient-generation" },
    );

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(launchEnv?.OPENRIG_OCCUPANT_GENERATION).toMatch(/^[0-9a-f-]{36}$/i);
    expect(launchEnv?.OPENRIG_OCCUPANT_GENERATION).not.toBe("stale-ambient-generation");
    expect(sessionRegistry.currentOccupantTenure(node.id)?.generationUuid)
      .toBe(launchEnv?.OPENRIG_OCCUPANT_GENERATION);
  });

  it("任期 ledger 不可用时保持启动开放失败，并省略 generation", async () => {
    const { rig } = seedRigWithNode();
    db.exec("DROP TABLE occupant_tenures");
    let launchEnv: Record<string, string> | undefined;
    const launcher = createLauncher(mockTmuxAdapter({
      createSession: async (_name, _cwd, env) => {
        launchEnv = env;
        return { ok: true };
      },
    }));

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(true);
    expect(launchEnv).not.toHaveProperty("OPENRIG_OCCUPANT_GENERATION");
    expect(sessionRegistry.getSessionsForRig(rig.id)).toHaveLength(1);
  });

  it("提供显式 sessionName 覆盖值时使用该值", async () => {
    const { rig } = seedRigWithNode();
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    await launcher.launchNode(rig.id, "dev1-impl", { sessionName: "r99-custom1-worker" });

    expect(createSpy.mock.calls[0]![0]).toBe("r99-custom1-worker");
  });

  it("有效逻辑 ID 'orchestrator' 和 'worker' 会产生可启动名称", async () => {
    const rig = rigRepo.createRig("r01");
    rigRepo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const r1 = await launcher.launchNode(rig.id, "orchestrator");
    const r2 = await launcher.launchNode(rig.id, "worker");

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("r01-orchestrator");
    expect(createSpy.mock.calls[1]![0]).toBe("r01-worker");
  });

  it("非托管 rig 名称会规范化为托管会话名称", async () => {
    const rig = rigRepo.createRig("badname");
    rigRepo.addNode(rig.id, "worker");
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(rig.id, "worker");

    expect(result.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("r00-badname-worker");
  });

  it("未找到节点时返回错误", async () => {
    const rig = rigRepo.createRig("r01");
    const launcher = createLauncher();

    const result = await launcher.launchNode(rig.id, "nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("node_not_found");
    }
  });

  it("节点已绑定时返回错误", async () => {
    const { rig, node } = seedRigWithNode();
    // 预先绑定节点
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r01-dev1-impl" });
    const launcher = createLauncher();

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("already_bound");
    }
  });

  it("tmux createSession 失败时不产生数据库行", async () => {
    const { rig } = seedRigWithNode();
    const killSpy = vi.fn(async () => ({ ok: true as const }));
    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async () => ({
          ok: false as const,
          code: "duplicate_session",
          message: "会话重复",
        }),
        killSession: killSpy,
      })
    );

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(false);

    // 不产生 session/binding/event 行
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(0);
    const fullRig = rigRepo.getRig(rig.id);
    const node = fullRig!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(node!.binding).toBeNull();
    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(events).toHaveLength(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("数据库事务在 session+binding 之后、event 之前失败时全部回滚，并尝试 killSession", async () => {
    const { rig } = seedRigWithNode();
    const killSpy = vi.fn<(name: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });

    // 破坏 events 表，使 persistWithinTransaction 在事务内已插入 session + binding 后失败。
    // 这证明回滚也会移除 session 和 binding 行。
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    const launcher = createLauncher(
      mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
        killSession: killSpy,
      })
    );

    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(false);
    // 已尝试 killSession（tmux 清理）
    expect(killSpy).toHaveBeenCalledOnce();
    // 没有部分 session 行（已回滚）
    const sessions = db.prepare("SELECT * FROM sessions").all();
    expect(sessions).toHaveLength(0);
    // 没有部分 binding 行（已回滚）
    const bindings = db.prepare("SELECT * FROM bindings").all();
    expect(bindings).toHaveLength(0);
    // 没有 event 行（插入失败）
    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });

  it("启动后 event 行存在于数据库中（与 session+binding 原子提交）", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched' AND rig_id = ?")
      .all(rig.id) as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.type).toBe("node.launched");
    expect(payload.rigId).toBe(rig.id);
    expect(payload.logicalId).toBe("dev1-impl");
  });

  it("发出的事件具有正确的 rigId、nodeId、logicalId、sessionName", async () => {
    const { rig, node } = seedRigWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    expect(notifications).toHaveLength(1);
    const event = notifications[0]!;
    expect(event.type).toBe("node.launched");
    if (event.type === "node.launched") {
      expect(event.rigId).toBe(rig.id);
      expect(event.nodeId).toBe(node.id);
      expect(event.logicalId).toBe("dev1-impl");
      expect(event.sessionName).toBe("r01-dev1-impl");
    }
  });

  it("启动后 getRig 显示节点 binding", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    const fullRig = rigRepo.getRig(rig.id);
    const node = fullRig!.nodes.find((n) => n.logicalId === "dev1-impl");
    expect(node!.binding).not.toBeNull();
    expect(node!.binding!.tmuxSession).toBe("r01-dev1-impl");
  });

  it("启动后 getSessionsForRig 显示名称正确的会话", async () => {
    const { rig } = seedRigWithNode();
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionName).toBe("r01-dev1-impl");
  });

  it("节点已有旧会话时返回新创建的会话", async () => {
    const { rig, node } = seedRigWithNode();
    const older = sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    sessionRegistry.updateStatus(older.id, "exited");

    const launcher = createLauncher();
    const result = await launcher.launchNode(rig.id, "dev1-impl");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.session.id).not.toBe(older.id);
    expect(result.session.status).toBe("running");

    const sessions = sessionRegistry.getSessionsForRig(rig.id).filter((s) => s.nodeId === node.id);
    const newest = sessions.reduce((latest, session) => (session.id > latest.id ? session : latest));
    expect(result.session.id).toBe(newest.id);
  });

  it("恰好生成 1 行 event 和 1 次订阅者通知（不重复）", async () => {
    const { rig } = seedRigWithNode();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const launcher = createLauncher();

    await launcher.launchNode(rig.id, "dev1-impl");

    // 恰好 1 行数据库记录
    const eventRows = db
      .prepare("SELECT * FROM events WHERE type = 'node.launched'")
      .all();
    expect(eventRows).toHaveLength(1);

    // 恰好 1 次订阅者通知
    expect(notifications).toHaveLength(1);
  });

  it("通过 opts.sessionName 传入时接受带 @ 的规范会话名称", async () => {
    const rig = rigRepo.createRig("auth-feats");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const createSpy = vi.fn<(name: string, cwd?: string) => Promise<TmuxResult>>()
      .mockResolvedValue({ ok: true });
    const launcher = createLauncher(mockTmuxAdapter({ createSession: createSpy }));

    const result = await launcher.launchNode(rig.id, "dev.impl", {
      sessionName: "dev-impl@auth-feats",
    });

    expect(result.ok).toBe(true);
    expect(createSpy.mock.calls[0]![0]).toBe("dev-impl@auth-feats");

    // 以规范名称持久化会话
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionName).toBe("dev-impl@auth-feats");
  });

  it("服务使用不匹配的数据库句柄时构造函数抛错", () => {
    const otherDb = createDb();
    migrate(otherDb, [coreSchema, bindingsSessionsSchema, eventsSchema]);
    const otherRepo = new RigRepository(otherDb);

    expect(
      () =>
        new NodeLauncher({
          db,
          rigRepo: otherRepo, // 不同句柄
          sessionRegistry,
          eventBus,
          tmuxAdapter: mockTmuxAdapter(),
        })
    ).toThrow(/同一个数据库句柄/);

    otherDb.close();
  });

  describe("transcript 集成", () => {
    it("启用 TranscriptStore 时，启动成功后开启 transcript 轮换定时器", async () => {
      const {
        getActiveRotationCount,
        clearAllTranscriptRotationsForTest,
      } = await import("../src/domain/transcript-rotation.js");
      clearAllTranscriptRotationsForTest();
      const { rig } = seedRigWithNode();
      const tmux = mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
      });

      const { TranscriptStore } = await import("../src/domain/transcript-store.js");
      const transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/test-transcripts", enabled: true });
      vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(true);

      const launcher = new NodeLauncher({
        db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, transcriptStore,
      });

      const result = await launcher.launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      // 已为启动的会话注册轮换定时器。
      expect(getActiveRotationCount()).toBeGreaterThan(0);
      if (result.ok) {
        expect(result.warnings).toBeUndefined();
      }
      clearAllTranscriptRotationsForTest();
    });

    it("无法创建 transcript 目录时发出警告但仍成功", async () => {
      const { rig } = seedRigWithNode();
      const tmux = mockTmuxAdapter({
        createSession: async () => ({ ok: true as const }),
      });

      const { TranscriptStore } = await import("../src/domain/transcript-store.js");
      const transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/test-transcripts", enabled: true });
      vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(false);

      const launcher = new NodeLauncher({
        db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, transcriptStore,
      });

      const result = await launcher.launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.warnings).toBeDefined();
        expect(result.warnings!.length).toBe(1);
        expect(result.warnings![0]).toContain("无法为工作组");
      }
    });
  });

  describe("环境变量投影", () => {
    it("将 OPENRIG_NODE_ID 和 OPENRIG_SESSION_NAME 传给 createSession", async () => {
      const { rig, node } = seedRigWithNode();
      const createSpy = vi.fn<(name: string, cwd?: string, env?: Record<string, string>) => Promise<TmuxResult>>()
        .mockResolvedValue({ ok: true });
      const tmux = mockTmuxAdapter({ createSession: createSpy });
      const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

      const result = await launcher.launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      expect(createSpy).toHaveBeenCalledOnce();

      const envArg = createSpy.mock.calls[0]![2];
      expect(envArg).toBeDefined();
      expect(envArg!.OPENRIG_NODE_ID).toBe(node.id);
      expect(envArg!.OPENRIG_SESSION_NAME).toContain("dev1-impl");
    });
  });

  // OPR.0.4.6.02 S1——对刚创建的会话调用共享 tmux 默认选项应用器，并将其警告合入启动结果。
  describe("tmux 默认选项（OPR.0.4.6.02 S1）", () => {
    it("将默认选项应用到已创建会话，并合入应用器警告", async () => {
      const { rig } = seedRigWithNode();
      const applyToFreshSession = vi.fn(async () => ['未能为 r01-dev1-impl 设置 tmux "mouse" 选项：boom']);
      const applier = { applyToFreshSession } as unknown as TmuxOptionDefaultsApplier;

      const result = await createLauncher(undefined, undefined, applier).launchNode(rig.id, "dev1-impl");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("预期为 ok");
      // 恰好应用一次，目标为刚创建的会话名称（绝不是预先存在的会话）。
      expect(applyToFreshSession).toHaveBeenCalledTimes(1);
      expect(applyToFreshSession).toHaveBeenCalledWith(result.sessionName);
      // 应用器的非致命警告会随启动结果返回。
      expect(result.warnings).toContain('未能为 r01-dev1-impl 设置 tmux "mouse" 选项：boom');
    });

    it("未注入应用器时启动成功且不应用任何内容（保持现有行为安全）", async () => {
      const { rig } = seedRigWithNode();
      const result = await createLauncher().launchNode(rig.id, "dev1-impl");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("预期为 ok");
      expect(result.warnings).toBeUndefined();
    });
  });

});
