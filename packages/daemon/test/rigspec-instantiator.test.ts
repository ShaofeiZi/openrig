import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import { RigInstantiator } from "../src/domain/rigspec-instantiator.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { LegacyRigSpec as RigSpec, PersistedEvent } from "../src/domain/types.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: vi.fn(async () => false),
  } as unknown as TmuxAdapter;
}

function validSpec(overrides?: Partial<RigSpec>): RigSpec {
  return {
    schemaVersion: 1,
    name: "r99",
    version: "1.0.0",
    nodes: [
      { id: "orchestrator", runtime: "claude-code", role: "orchestrator", cwd: "/" },
      { id: "worker-a", runtime: "codex", role: "worker", cwd: "/" },
      { id: "worker-b", runtime: "claude-code", role: "worker", cwd: "/" },
    ],
    edges: [
      { from: "orchestrator", to: "worker-a", kind: "delegates_to" },
      { from: "orchestrator", to: "worker-b", kind: "delegates_to" },
    ],
    ...overrides,
  };
}

describe("RigInstantiator", () => {
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

  function createInstantiator(opts?: { tmux?: TmuxAdapter }) {
    const tmux = opts?.tmux ?? mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const preflight = new RigSpecPreflight({ rigRepo, tmuxAdapter: tmux, exec: async () => "", cmuxExec: async () => "" });
    return new RigInstantiator({ db, rigRepo, sessionRegistry, eventBus, nodeLauncher, preflight });
  }

  it("有效 spec 会创建名称正确的 rig", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig).not.toBeNull();
      expect(rig!.rig.name).toBe("r99");
    }
  });

  it("节点具有正确的 logical_id、role、runtime 和扩展字段", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", role: "worker", surfaceHint: "tab:main", packageRefs: ["pkg-a"] }],
      edges: [],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      const node = rig!.nodes[0]!;
      expect(node.logicalId).toBe("worker");
      expect(node.role).toBe("worker");
      expect(node.runtime).toBe("claude-code");
      expect(node.surfaceHint).toBe("tab:main");
      expect(node.packageRefs).toEqual(["pkg-a"]);
    }
  });

  it("边具有正确的 from/to/kind", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig!.edges).toHaveLength(2);
      expect(rig!.edges[0]!.kind).toBe("delegates_to");
    }
  });

  it("拓扑启动顺序（delegates_to，精确）", async () => {
    const tmux = mockTmux();
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      expect(order[0]).toBe("orchestrator");
      expect(order.indexOf("orchestrator")).toBeLessThan(order.indexOf("worker-a"));
      expect(order.indexOf("orchestrator")).toBeLessThan(order.indexOf("worker-b"));
    }
  });

  it("spawned_by 约束顺序", async () => {
    const spec = validSpec({
      nodes: [
        { id: "child", runtime: "claude-code", cwd: "/" },
        { id: "parent", runtime: "claude-code", cwd: "/" },
      ],
      edges: [{ from: "child", to: "parent", kind: "spawned_by" }],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      expect(order.indexOf("parent")).toBeLessThan(order.indexOf("child"));
    }
  });

  it("同一深度按字母顺序决胜", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      expect(order.indexOf("worker-a")).toBeLessThan(order.indexOf("worker-b"));
    }
  });

  it("can_observe 不约束顺序", async () => {
    const spec = validSpec({
      nodes: [
        { id: "orchestrator", runtime: "claude-code", role: "orchestrator", cwd: "/" },
        { id: "worker-a", runtime: "claude-code", cwd: "/" },
        { id: "worker-b", runtime: "claude-code", cwd: "/" },
      ],
      edges: [
        { from: "orchestrator", to: "worker-a", kind: "delegates_to" },
        { from: "orchestrator", to: "worker-b", kind: "delegates_to" },
        { from: "worker-b", to: "worker-a", kind: "can_observe" },
      ],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      // 按字母顺序 worker-a 在 worker-b 前；can_observe 不会反转顺序。
      expect(order.indexOf("worker-a")).toBeLessThan(order.indexOf("worker-b"));
    }
  });

  it("启动失败时节点为 'failed'，其余节点继续处理", async () => {
    const tmux = mockTmux();
    let callCount = 0;
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return { ok: false as const, code: "duplicate", message: "err" };
      return { ok: true as const };
    });
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const statuses = result.result.nodes.map((n) => n.status);
      expect(statuses).toContain("failed");
      expect(statuses.filter((s) => s === "launched").length).toBeGreaterThan(0);
    }
  });

  it("启动后持久化带 rigId、specName、specVersion 的 rig.imported", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    const events = db.prepare("SELECT payload FROM events WHERE type = 'rig.imported'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.specName).toBe("r99");
    expect(payload.specVersion).toBe("1.0.0");
    if (result.ok) expect(payload.rigId).toBe(result.result.rigId);
  });

  it("部分失败时仍发出 rig.imported", async () => {
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, code: "err", message: "fail" })
      .mockResolvedValueOnce({ ok: true });
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    const events = db.prepare("SELECT type FROM events WHERE type = 'rig.imported'").all();
    expect(events).toHaveLength(1);
  });

  it("validation_failed 结果为 { ok: false, code, errors[] }", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate({ schemaVersion: 1, name: "", version: "", nodes: [], edges: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect((result as { errors: string[] }).errors.length).toBeGreaterThan(0);
    }
    // 未创建 rig。
    expect(rigRepo.listRigs()).toHaveLength(0);
  });

  it("preflight_failed 结果为 { ok: false, code, errors[], warnings[] }", async () => {
    // 制造名称冲突。
    rigRepo.createRig("r99");
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("preflight_failed");
    }
  });

  it("DB handle 不匹配时 constructor 抛错", () => {
    const otherDb = setupDb();
    const otherRepo = new RigRepository(otherDb);
    const tmux = mockTmux();
    expect(() => new RigInstantiator({
      db, rigRepo: otherRepo, sessionRegistry, eventBus,
      nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      preflight: new RigSpecPreflight({ rigRepo, tmuxAdapter: tmux, exec: async () => "", cmuxExec: async () => "" }),
    })).toThrow(/RigInstantiator：rigRepo 必须共享同一个数据库句柄/);
    otherDb.close();
  });

  it("preflight DB handle 不匹配时 constructor 抛错", () => {
    const otherDb = setupDb();
    const otherRepo = new RigRepository(otherDb);
    const tmux = mockTmux();
    const otherPreflight = new RigSpecPreflight({ rigRepo: otherRepo, tmuxAdapter: tmux, exec: async () => "", cmuxExec: async () => "" });
    expect(() => new RigInstantiator({
      db, rigRepo, sessionRegistry, eventBus,
      nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      preflight: otherPreflight,
    })).toThrow(/RigInstantiator：preflight 必须共享同一个数据库句柄/);
    otherDb.close();
  });

  it("InstantiateResult 包含逐节点状态", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes).toHaveLength(3);
      for (const node of result.result.nodes) {
        expect(node.logicalId).toBeDefined();
        expect(["launched", "failed"]).toContain(node.status);
      }
    }
  });

  it("instantiate 后可通过 getRig 取回 DB 中的 rig", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig).not.toBeNull();
      expect(rig!.nodes).toHaveLength(3);
      expect(rig!.edges).toHaveLength(2);
    }
  });

  it("持久化扩展字段（surface_hint、package_refs）", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", surfaceHint: "tab:x", packageRefs: ["pkg"] }],
      edges: [],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig!.nodes[0]!.surfaceHint).toBe("tab:x");
      expect(rig!.nodes[0]!.packageRefs).toEqual(["pkg"]);
    }
  });

  it("restorePolicy 传播到 session metadata", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", restorePolicy: "checkpoint_only" }],
      edges: [],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sessions = sessionRegistry.getSessionsForRig(result.result.rigId);
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0]!.restorePolicy).toBe("checkpoint_only");
    }
  });

  it("默认 restorePolicy 为 resume_if_possible", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }],
      edges: [],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sessions = sessionRegistry.getSessionsForRig(result.result.rigId);
      expect(sessions[0]!.restorePolicy).toBe("resume_if_possible");
    }
  });

  it("原子 materialization：edge 失败时不留下部分 rig/node", async () => {
    // 破坏 edges 表，使 edge insert 在 materialization 事务内失败。
    db.exec("CREATE TRIGGER block_edge BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT, 'blocked'); END;");

    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(false);

    // 不应残留部分 rig 或 node。
    expect(rigRepo.listRigs()).toHaveLength(0);

    db.exec("DROP TRIGGER block_edge");
  });

  it("InstantiateResult 成功结构包含 rigId、specName、specVersion、nodes[]", async () => {
    const inst = createInstantiator();
    const result = await inst.instantiate(validSpec());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.rigId).toBeDefined();
      expect(result.result.specName).toBe("r99");
      expect(result.result.specVersion).toBe("1.0.0");
      expect(Array.isArray(result.result.nodes)).toBe(true);
    }
  });

  it("RigEvent union 包含 rig.imported event type", async () => {
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));
    const inst = createInstantiator();
    await inst.instantiate(validSpec());
    const imported = notifications.find((e) => e.type === "rig.imported");
    expect(imported).toBeDefined();
    if (imported && imported.type === "rig.imported") {
      expect(imported.specName).toBe("r99");
      expect(imported.specVersion).toBe("1.0.0");
    }
  });

  it("启动后 event 持久化失败时仍 ok:true，rig + session 存在，但无 event", async () => {
    const inst = createInstantiator();
    const spec = validSpec({ nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }], edges: [] });

    // 先让 materialization 事务成功，再破坏 events 以使启动后 emit 失败。
    const origEmit = eventBus.emit.bind(eventBus);
    let emitCount = 0;
    vi.spyOn(eventBus, "emit").mockImplementation((event) => {
      emitCount++;
      // 只阻断 rig.imported emit，不阻断 NodeLauncher 发出的 node.launched。
      if (event.type === "rig.imported") {
        throw new Error("event persistence failed");
      }
      return origEmit(event);
    });

    const result = await inst.instantiate(spec);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Rig 存在。
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig).not.toBeNull();
      // Session 存在。
      const sessions = sessionRegistry.getSessionsForRig(result.result.rigId);
      expect(sessions.length).toBeGreaterThan(0);
      // 没有 rig.imported event 行。
      const importedEvents = db.prepare("SELECT * FROM events WHERE type = 'rig.imported'").all();
      expect(importedEvents).toHaveLength(0);
    }
  });

  it("restorePolicy 传播失败时仍 ok:true（尽力而为）", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", restorePolicy: "checkpoint_only" }],
      edges: [],
    });
    const inst = createInstantiator();

    // 启动后破坏 sessions 表，使 restorePolicy UPDATE 失败。
    const origLaunchNode = inst["nodeLauncher"].launchNode.bind(inst["nodeLauncher"]);
    vi.spyOn(inst["nodeLauncher"], "launchNode").mockImplementation(async (...args: [string, string, unknown?]) => {
      const result = await origLaunchNode(...args);
      // 成功启动后进行破坏。
      if (result.ok) {
        db.exec("CREATE TRIGGER block_session_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
      }
      return result;
    });

    const result = await inst.instantiate(spec);

    // 仍应返回 ok:true。
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.rigId).toBeDefined();
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig).not.toBeNull();
    }

    // 清理 trigger。
    try { db.exec("DROP TRIGGER block_session_update"); } catch { /* may not exist */ }
  });

  it("dependency 环产生 instantiate_error", async () => {
    const spec = validSpec({
      nodes: [
        { id: "a", runtime: "claude-code", cwd: "/" },
        { id: "b", runtime: "claude-code", cwd: "/" },
      ],
      edges: [
        { from: "a", to: "b", kind: "delegates_to" },
        { from: "b", to: "a", kind: "delegates_to" },
      ],
    });
    const inst = createInstantiator();
    const result = await inst.instantiate(spec);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("instantiate_error");
      expect(result.message).toContain("cycle");
    }

    // 不应创建 rig（在 materialization 前检测到环）。
    expect(rigRepo.listRigs()).toHaveLength(0);
  });

  // -- Review Fix 2：全部启动失败时清理 --

  it("全部启动失败时返回 instantiate_error、删除 rig 且无 rig.imported", async () => {
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: false as const, code: "err", message: "all fail" }
    );
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("instantiate_error");
      expect(result.message).toContain("所有 node launch 均失败");
    }

    // Rig 应被删除。
    expect(rigRepo.listRigs()).toHaveLength(0);

    // 没有 rig.imported event。
    const events = db.prepare("SELECT * FROM events WHERE type = 'rig.imported'").all();
    expect(events).toHaveLength(0);
  });

  it("部分启动失败时 ok:true 且保留 rig", async () => {
    const tmux = mockTmux();
    let callCount = 0;
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return { ok: false as const, code: "err", message: "fail" };
      return { ok: true as const };
    });
    const inst = createInstantiator({ tmux });
    const result = await inst.instantiate(validSpec());

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Rig 已保留。
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig).not.toBeNull();
    }
  });

  it("全部失败时没有 rig.imported event 行", async () => {
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: false as const, code: "err", message: "fail" }
    );
    const inst = createInstantiator({ tmux });
    await inst.instantiate(validSpec());

    const events = db.prepare("SELECT * FROM events WHERE type = 'rig.imported'").all();
    expect(events).toHaveLength(0);
  });

  it("启动 warning 传播到 InstantiateResult.warnings", async () => {
    const tmux = mockTmux();
    // 通过 NodeLauncher transcript 集成模拟 launchNode 返回 warning。
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    // 覆盖 launchNode 以模拟 transcript warning。
    const originalLaunch = nodeLauncher.launchNode.bind(nodeLauncher);
    vi.spyOn(nodeLauncher, "launchNode").mockImplementation(async (...args) => {
      const result = await originalLaunch(...args);
      if (result.ok) {
        return { ...result, warnings: ["Transcript capture failed for test-session: pipe-pane failed"] };
      }
      return result;
    });

    const preflight = new RigSpecPreflight({ rigRepo, tmuxAdapter: tmux, exec: async () => "", cmuxExec: async () => "" });
    const inst = new RigInstantiator({ db, rigRepo, sessionRegistry, eventBus, nodeLauncher, preflight });
    const result = await inst.instantiate(validSpec());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.warnings).toBeDefined();
      expect(result.result.warnings!.length).toBeGreaterThan(0);
      expect(result.result.warnings![0]).toContain("Transcript capture failed");
    }
  });
});
