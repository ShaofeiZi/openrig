import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import type { ReadinessResult } from "../src/domain/runtime-adapter.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


describe("ContextMonitor 上下文监控", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let store: ContextUsageStore;
  let monitor: ContextMonitor;
  let ensureContextCollectorSpy: ReturnType<typeof vi.fn>;
  let checkReadySpy: ReturnType<typeof vi.fn>;
  let tmpDir: string;
  let codexHomeDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    tmpDir = join(tmpdir(), `context-monitor-${Date.now()}`);
    mkdirSync(join(tmpDir, "state", "context-usage"), { recursive: true });
    codexHomeDir = join(tmpDir, "codex-home");
    mkdirSync(join(codexHomeDir, ".codex"), { recursive: true });
    store = new ContextUsageStore(db, { stateDir: tmpDir, codexHomeDir });
    ensureContextCollectorSpy = vi.fn();
    checkReadySpy = vi.fn(async (): Promise<ReadinessResult> => ({ ready: false, reason: "not_ready", code: "awaiting_runtime" }));
    monitor = new ContextMonitor(db, store, {
      ensureContextCollector: ensureContextCollectorSpy,
      checkReady: checkReadySpy,
    });
  });

  afterEach(() => {
    monitor.stop();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedClaudeNode(logicalId = "dev.impl", sessionName = "dev-impl@test") {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    // 标记为 running，使 monitor 将其视为 eligible
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    return { rig, node, sessionName };
  }

  function seedCodexNode(status: "running" | "detached" = "running") {
    const rig = rigRepo.createRig("test-rig-2");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa@test");
    db.prepare("UPDATE sessions SET status = ?, resume_type = 'codex_id', resume_token = ? WHERE id = ?")
      .run(status, "thread-1", session.id);
    return { rig, node, sessionName: "dev-qa@test", threadId: "thread-1" };
  }

  function seedClaimedNode() {
    const rig = rigRepo.createRig("test-rig-3");
    const node = rigRepo.addNode(rig.id, "adopted.node", { runtime: "claude-code" });
    const session = sessionRegistry.registerClaimedSession(node.id, "adopted-session");
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    sessionRegistry.updateBinding(node.id, { tmuxSession: "adopted-session" });
    return { rig, node };
  }

  function seedExternalCliClaudeNode() {
    const rig = rigRepo.createRig("test-rig-4");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code" });
    const session = sessionRegistry.registerClaimedSession(node.id, "orch-lead@test");
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    sessionRegistry.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: "orch-lead@test" });
    return { rig, node };
  }

  function seedStubNode(logicalId = "dev.stub", sessionName = "dev-stub@test") {
    const rig = rigRepo.createRig("test-rig-stub");
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "stub" });
    const session = sessionRegistry.registerSession(node.id, sessionName);
    // 标记为 running，使 monitor 将其视为 eligible
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
    return { rig, node, sessionName };
  }

  function writeSidecar(sessionName: string, data: Record<string, unknown>) {
    const safeName = sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_");
    writeFileSync(join(tmpDir, "state", "context-usage", `${safeName}.json`), JSON.stringify(data));
  }

  function writeCodexTokenCount(threadId: string) {
    const codexDir = join(codexHomeDir, ".codex");
    const rolloutPath = join(codexDir, "sessions", `${threadId}.jsonl`);
    mkdirSync(join(codexDir, "sessions"), { recursive: true });

    const stateDbPath = join(codexDir, "state_5.sqlite");
    const stateDb = new BetterSqlite3(stateDbPath);
    try {
      stateDb.prepare("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)").run();
      stateDb.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(threadId, rolloutPath);
    } finally {
      stateDb.close();
    }

    writeFileSync(rolloutPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 227139,
            output_tokens: 611,
            total_tokens: 227750,
          },
          model_context_window: 258400,
        },
      },
    }));
  }

  const VALID_SIDECAR = {
    context_window: {
      context_window_size: 200000,
      used_percentage: 67,
      remaining_percentage: 33,
      total_input_tokens: 120000,
      total_output_tokens: 14000,
      current_usage: "67% used",
    },
    session_id: "sess-123",
    session_name: "dev-impl@test",
    transcript_path: "/tmp/test.log",
    sampled_at: new Date().toISOString(),
  };

  // T1：pollOnce 发现 running Claude session 并持久化用量
  it("pollOnce 发现 running Claude session 并持久化 context usage", async () => {
    const { node, sessionName } = seedClaudeNode();
    writeSidecar(sessionName, VALID_SIDECAR);

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(67);
    expect(ensureContextCollectorSpy).toHaveBeenCalledWith({
      cwd: undefined,
      tmuxSession: sessionName,
    });
  });

  // T2：pollOnce 发现 running Codex session，并从 token_count event 持久化用量
  it("pollOnce 发现 running Codex session 并持久化 context usage", async () => {
    const { node: codexNode, sessionName, threadId } = seedCodexNode();
    writeCodexTokenCount(threadId);

    await monitor.pollOnce();

    const usage = store.getForNode(codexNode.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.source).toBe("codex_token_count_jsonl");
    expect(usage.usedPercentage).toBe(88);
    expect(usage.totalInputTokens).toBe(227139);
    expect(usage.totalOutputTokens).toBe(611);
    expect(ensureContextCollectorSpy).not.toHaveBeenCalled();
  });

  it("pollOnce 根据 resume token 回填 detached Codex session", async () => {
    const { node: codexNode, sessionName, threadId } = seedCodexNode("detached");
    writeCodexTokenCount(threadId);

    await monitor.pollOnce();

    const usage = store.getForNode(codexNode.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.source).toBe("codex_token_count_jsonl");
    expect(usage.usedPercentage).toBe(88);
  });

  // STUB-A（51-01 GAP-1）：轮询并观测带 context sidecar 的 running stub session
  it("pollOnce 发现 running stub session 并持久化 context usage", async () => {
    const { node, sessionName } = seedStubNode();
    writeSidecar(sessionName, { ...VALID_SIDECAR, session_name: sessionName });

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(67);
  });

  // STUB-B（51-01 GAP-2）：stub session 使用自己的 sidecar，但绝不能配置 Claude context collector
  //（不向 stub seat cwd 写 settings.local.json / collector）——镜像 codex non-provisioning contract。
  it("pollOnce 不为 stub session 配置 Claude context collector", async () => {
    const { node, sessionName } = seedStubNode("dev.stubb", "dev-stubb@test");
    writeSidecar(sessionName, { ...VALID_SIDECAR, session_name: sessionName });

    await monitor.pollOnce();

    // 仍会使用 sidecar（无条件执行 readAndNormalize）……
    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("known");
    // ……但不为 stub seat 配置 Claude-specific collector。
    expect(ensureContextCollectorSpy).not.toHaveBeenCalled();
  });

  // T3：sidecar 缺失时，pollOnce 持久化 unknown
  it("sidecar 文件缺失时 pollOnce 持久化 unknown", async () => {
    const { node, sessionName } = seedClaudeNode();
    // 未写入 sidecar 文件

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("missing_sidecar");
  });

  // T4：pollOnce 处理 malformed sidecar 且不崩溃
  it("pollOnce 处理 malformed sidecar 时不崩溃", async () => {
    const { node, sessionName } = seedClaudeNode();
    writeSidecar(sessionName, { bad: "data" });

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, sessionName);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("parse_error");
  });

  // T5：零 eligible session 的 pollOnce 不执行任何操作
  it("零 eligible session 时 pollOnce 不执行任何操作", async () => {
    // 未 seed node
    await monitor.pollOnce(); // Should not throw
  });

  // T6：start/stop 管理 interval lifecycle
  it("start/stop 管理 interval lifecycle", () => {
    monitor.start(1000);
    monitor.start(1000); // Idempotent — no double interval
    monitor.stop();
    monitor.stop(); // Safe to call again
  });

  // T7：单个异常 session 不会阻止轮询其他 session
  it("单个异常 session 不会阻止轮询其他 session", async () => {
    const { node: node1, sessionName: s1 } = seedClaudeNode("dev.impl1", "impl1@test");
    const rig2 = rigRepo.createRig("rig2");
    const node2 = rigRepo.addNode(rig2.id, "dev.impl2", { runtime: "claude-code" });
    const s2 = sessionRegistry.registerSession(node2.id, "impl2@test");
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(s2.id);

    // 只为 node2 写入有效 sidecar；node1 无 sidecar
    writeSidecar("impl2@test", { ...VALID_SIDECAR, session_name: "impl2@test" });

    await monitor.pollOnce();

    // node1 应为 unknown，node2 应为 known
    expect(store.getForNode(node1.id, "impl1@test").availability).toBe("unknown");
    expect(store.getForNode(node2.id, "impl2@test").availability).toBe("known");
  });

  // T8：Monitor 使用现有 node/session identity（不自行创建）
  it("monitor 不创建自己的 node/session identity", async () => {
    seedClaudeNode();
    await monitor.pollOnce();

    // 不应创建新 node 或 session
    const rig = rigRepo.getRig(rigRepo.listRigs()[0]!.id);
    expect(rig!.nodes).toHaveLength(1); // Only the one we seeded
  });

  // T9：轮询已 claim/adopt 的 Claude tmux session
  it("轮询已 claim 的 tmux session", async () => {
    const { node } = seedClaimedNode();
    writeSidecar("adopted-session", { ...VALID_SIDECAR, session_name: "adopted-session" });

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, "adopted-session");
    expect(usage.availability).toBe("known");
    expect(usage.usedPercentage).toBe(67);
  });

  it("不轮询 external_cli Claude session", async () => {
    const { node } = seedExternalCliClaudeNode();
    writeSidecar("orch-lead@test", VALID_SIDECAR);

    await monitor.pollOnce();

    const usage = store.getForNode(node.id, "orch-lead@test");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("no_data");
  });

  it("runtime 存活时，pollOnce 将 stale Claude startup failure normalize 回 ready", async () => {
    const { sessionName, session } = (() => {
      const rig = rigRepo.createRig("test-rig-5");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@test");
      db.prepare("UPDATE sessions SET status = 'running', startup_status = 'failed' WHERE id = ?").run(session.id);
      return { sessionName: "dev-impl@test", session };
    })();
    writeSidecar(sessionName, VALID_SIDECAR);
    checkReadySpy.mockResolvedValue({ ready: true });

    await monitor.pollOnce();

    const refreshed = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(refreshed.startup_status).toBe("ready");
    expect(checkReadySpy).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: session.nodeId,
      tmuxSession: sessionName,
      cwd: "/project",
    }));
  });

  it("runtime 被 trust 阻塞时，pollOnce 将 stale Claude startup failure normalize 为 attention_required", async () => {
    const { sessionName, session } = (() => {
      const rig = rigRepo.createRig("test-rig-5b");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl-trust@test");
      db.prepare("UPDATE sessions SET status = 'running', startup_status = 'failed' WHERE id = ?").run(session.id);
      return { sessionName: "dev-impl-trust@test", session };
    })();
    writeSidecar(sessionName, { ...VALID_SIDECAR, session_name: sessionName });
    checkReadySpy.mockResolvedValue({
      ready: false,
      code: "trust_gate",
      reason: "Claude is waiting for workspace trust approval before the session can become interactive.",
    });

    await monitor.pollOnce();

    const refreshed = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(refreshed.startup_status).toBe("attention_required");
  });

  it("runtime 确实回退到 shell 时，pollOnce 让 stale Claude startup failure 保持 failed", async () => {
    const { sessionName, session } = (() => {
      const rig = rigRepo.createRig("test-rig-5c");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl-shell@test");
      db.prepare("UPDATE sessions SET status = 'running', startup_status = 'failed' WHERE id = ?").run(session.id);
      return { sessionName: "dev-impl-shell@test", session };
    })();
    writeSidecar(sessionName, { ...VALID_SIDECAR, session_name: sessionName });
    checkReadySpy.mockResolvedValue({
      ready: false,
      code: "returned_to_shell",
      reason: "The probe pane returned to a shell instead of staying inside the runtime.",
    });

    await monitor.pollOnce();

    const refreshed = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(refreshed.startup_status).toBe("failed");
  });

  it("trust prompt 清除后，pollOnce normalize stale Codex attention_required state", async () => {
    const rig = rigRepo.createRig("test-rig-codex-trust");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa-trust@test");
    db.prepare("UPDATE sessions SET status = 'running', startup_status = 'attention_required', resume_token = NULL WHERE id = ?")
      .run(session.id);

    const codexReadySpy = vi.fn(async (): Promise<ReadinessResult> => ({ ready: true }));
    monitor = new ContextMonitor(db, store, {
      ensureContextCollector: ensureContextCollectorSpy,
      checkReady: checkReadySpy,
    }, undefined, {
      "claude-code": { checkReady: checkReadySpy },
      codex: { checkReady: codexReadySpy },
    });

    await monitor.pollOnce();

    const refreshed = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(session.id) as {
      startup_status: string;
      startup_completed_at: string | null;
    };
    expect(refreshed.startup_status).toBe("ready");
    expect(refreshed.startup_completed_at).toBeTruthy();
    expect(codexReadySpy).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: session.nodeId,
      tmuxSession: "dev-qa-trust@test",
      cwd: "/project",
    }));
  });

  it("pollOnce 不覆盖 pending Claude startup state", async () => {
    const { sessionName, session } = (() => {
      const rig = rigRepo.createRig("test-rig-6");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/project" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl-pending@test");
      db.prepare("UPDATE sessions SET status = 'running', startup_status = 'pending' WHERE id = ?").run(session.id);
      return { sessionName: "dev-impl-pending@test", session };
    })();
    writeSidecar(sessionName, { ...VALID_SIDECAR, session_name: sessionName });
    checkReadySpy.mockResolvedValue({ ready: true });

    await monitor.pollOnce();

    const refreshed = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(session.id) as { startup_status: string };
    expect(refreshed.startup_status).toBe("pending");
    expect(checkReadySpy).not.toHaveBeenCalled();
  });

  it("合并重叠 pollOnce 调用，使一个 compaction stage 只发出一次", async () => {
    const { sessionName } = seedClaudeNode("dev.compact", "dev-compact@test");
    writeSidecar(sessionName, { ...VALID_SIDECAR, session_name: sessionName });

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const maybeAutoCompact = vi.fn(async () => {
      await blocked;
      return { triggered: true as const };
    });
    monitor = new ContextMonitor(
      db,
      store,
      { ensureContextCollector: ensureContextCollectorSpy, checkReady: checkReadySpy },
      { maybeAutoCompact } as never,
    );

    const timerTick = monitor.pollOnce();
    await vi.waitFor(() => expect(maybeAutoCompact).toHaveBeenCalledTimes(1));
    const refreshRequest = monitor.pollOnce();
    release();
    await Promise.all([timerTick, refreshRequest]);

    expect(maybeAutoCompact).toHaveBeenCalledTimes(1);
  });
});
