import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function mockTmux(killResult?: { ok: boolean; code?: string; message?: string }): TmuxAdapter {
  return {
    killSession: vi.fn(async () => killResult ?? { ok: true }),
    createSession: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    getPanePid: vi.fn(async () => null),
    getPaneCommand: vi.fn(async () => null),
    capturePaneContent: vi.fn(async () => null),
  } as unknown as TmuxAdapter;
}

function mockSnapshotCapture(db: Database.Database): SnapshotCapture {
  return {
    captureSnapshot: vi.fn(() => ({ id: "snap-1", rigId: "x", kind: "manual", status: "complete", data: "{}", createdAt: new Date().toISOString() })),
    db,
  } as unknown as SnapshotCapture;
}

describe("RigTeardownOrchestrator", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rig-teardown-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedRig(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev");
    const session = sessionRegistry.registerSession(node.id, "r01-dev");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function seedRigWithNode(opts: { runtime: string; cwd: string; sessionStatus?: string }): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev", { runtime: opts.runtime, cwd: opts.cwd });
    const session = sessionRegistry.registerSession(node.id, "r01-dev");
    sessionRegistry.updateStatus(session.id, opts.sessionStatus ?? "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function buildTeardown(tmux?: TmuxAdapter) {
    return new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry,
      tmuxAdapter: tmux ?? mockTmux(),
      snapshotCapture: mockSnapshotCapture(db),
      eventBus,
    });
  }

  // T1：终止 tmux session
  it("teardown 终止 tmux session", async () => {
    const { rigId } = seedRig();
    const tmux = mockTmux();
    const td = buildTeardown(tmux);

    await td.teardown(rigId);

    expect(tmux.killSession).toHaveBeenCalledWith("r01-dev");
  });

  // T2：清除 binding
  it("teardown 后清除 binding", async () => {
    const { rigId, nodeId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const td = buildTeardown();

    await td.teardown(rigId);

    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
  });

  // T3：将 session 标记为 exited
  it("将 session 标记为 exited", async () => {
    const { rigId, sessionId } = seedRig();
    const td = buildTeardown();

    await td.teardown(rigId);

    const sessions = sessionRegistry.getSessionsForRig(rigId);
    const latest = sessions.find((s) => s.id === sessionId);
    expect(latest?.status).toBe("exited");
  });

  // T4：保留 rig
  it("不带 --delete 时保留 rig 记录", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    const result = await td.teardown(rigId);

    expect(result.deleted).toBe(false);
    expect(rigRepo.getRig(rigId)).toBeTruthy();
  });

  // T5：--delete 删除 rig
  it("--delete 在停止后删除 rig", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    const result = await td.teardown(rigId, { delete: true });

    expect(result.deleted).toBe(true);
    expect(rigRepo.getRig(rigId)).toBeNull();
  });

  // T6：--snapshot
  it("--snapshot 在 teardown 前执行 capture", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    const result = await td.teardown(rigId, { snapshot: true });

    expect(result.snapshotId).toBe("snap-1");
  });

  it("在 snapshot capture 前刷新 resume metadata", async () => {
    const { rigId } = seedRig();
    const refresh = vi.fn(async () => {});
    const td = new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry,
      tmuxAdapter: mockTmux(),
      snapshotCapture: mockSnapshotCapture(db),
      eventBus,
      resumeMetadataRefresher: { refresh } as unknown as import("../src/domain/resume-metadata-refresher.js").ResumeMetadataRefresher,
    });

    await td.teardown(rigId);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // T7：--force（v1 中与默认行为相同）
  it("--force 终止 session", async () => {
    const { rigId } = seedRig();
    const tmux = mockTmux();
    const td = buildTeardown(tmux);

    await td.teardown(rigId, { force: true });

    expect(tmux.killSession).toHaveBeenCalled();
  });

  // T8：不存在的 rig
  it("rig 不存在时抛出异常", async () => {
    const td = buildTeardown();

    await expect(td.teardown("nonexistent")).rejects.toThrow(/未找到/);
  });

  // T9：已经停止
  it("已停止的 rig 返回 alreadyStopped=true", async () => {
    const { rigId, sessionId } = seedRig();
    sessionRegistry.updateStatus(sessionId, "exited"); // 已停止
    const td = buildTeardown();

    const result = await td.teardown(rigId);

    expect(result.alreadyStopped).toBe(true);
    expect(result.sessionsKilled).toBe(0);
  });

  // T10：rig.stopped 事件
  it("发出 rig.stopped 事件", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    await td.teardown(rigId);

    const events = db.prepare("SELECT type FROM events WHERE type = 'rig.stopped'").all() as Array<{ type: string }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  // T11：多 session 节点——只终止最新一个
  it("存在多个 session 行时——只处理最新的 live session", async () => {
    const rig = rigRepo.createRig("r11");
    const node = rigRepo.addNode(rig.id, "dev");
    // 旧 session（exited）——时间戳更早 + ID 更早
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'exited', ?)")
      .run("sess-aaa", node.id, "r11-old", "2026-03-26 09:00:00");
    // 新 session（running）——时间戳更晚 + ID 更晚
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'running', ?)")
      .run("sess-zzz", node.id, "r11-new", "2026-03-26 12:00:00");

    const tmux = mockTmux();
    const td = buildTeardown(tmux);

    await td.teardown(rig.id);

    // 只应终止新 session
    expect(tmux.killSession).toHaveBeenCalledWith("r11-new");
    expect(tmux.killSession).toHaveBeenCalledTimes(1);
  });

  // T12：终止失败 + --delete -> blocked
  it("终止失败会阻止 --delete", async () => {
    const { rigId, nodeId } = seedRig();
    const tmux = mockTmux({ ok: false, code: "kill_failed", message: "tmux error" });
    const td = buildTeardown(tmux);

    const result = await td.teardown(rigId, { delete: true });

    expect(result.deleted).toBe(false);
    expect(result.errors.some((e) => e.includes("被阻止"))).toBe(true);
    expect(rigRepo.getRig(rigId)).toBeTruthy();
    // 不应将节点标记为 exited
    const sessions = sessionRegistry.getSessionsForRig(rigId);
    expect(sessions.some((s) => s.status === "running")).toBe(true);
  });

  // T13：stale session（tmux 已消失）-> 良性处理
  it("将 stale session（tmux 已消失）视为成功", async () => {
    const { rigId } = seedRig();
    const tmux = mockTmux({ ok: false, code: "session_not_found" });
    const td = buildTeardown(tmux);

    const result = await td.teardown(rigId, { delete: true });

    expect(result.sessionsKilled).toBe(1);
    expect(result.deleted).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("只移除 OpenRig 受管区块，并保留用户及第三方内容", async () => {
    const cwd = path.join(tmpDir, "claude-project");
    fs.mkdirSync(cwd, { recursive: true });
    const claudeMd = path.join(cwd, "CLAUDE.md");
    fs.writeFileSync(claudeMd, [
      "# User intro",
      "<!-- BEGIN OpenRig MANAGED BLOCK: role -->",
      "managed role",
      "<!-- END OpenRig MANAGED BLOCK: role -->",
      "<!-- BEGIN THIRD PARTY BLOCK -->",
      "third party",
      "<!-- END THIRD PARTY BLOCK -->",
      "tail",
    ].join("\n\n"));
    const { rigId } = seedRigWithNode({ runtime: "claude-code", cwd });
    const td = buildTeardown();

    await td.teardown(rigId);

    const content = fs.readFileSync(claudeMd, "utf-8");
    expect(content).toContain("# User intro");
    expect(content).toContain("third party");
    expect(content).toContain("tail");
    expect(content).not.toContain("BEGIN OpenRig MANAGED BLOCK");
  });

  it("teardown 后只剩 OpenRig 受管内容时删除 guidance 文件", async () => {
    const cwd = path.join(tmpDir, "codex-project");
    fs.mkdirSync(cwd, { recursive: true });
    const agentsMd = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(agentsMd, [
      "<!-- BEGIN OpenRig MANAGED BLOCK: role -->",
      "managed role",
      "<!-- END OpenRig MANAGED BLOCK: role -->",
    ].join("\n"));
    const { rigId } = seedRigWithNode({ runtime: "codex", cwd, sessionStatus: "exited" });
    const td = buildTeardown();

    const result = await td.teardown(rigId);

    expect(result.alreadyStopped).toBe(true);
    expect(fs.existsSync(agentsMd)).toBe(false);
  });

  // T14：逐节点清理具有原子性（同时处理 status + binding）
  it("逐节点清理以原子方式更新 status 并清除 binding", async () => {
    const { rigId, nodeId, sessionId } = seedRig();
    sessionRegistry.updateBinding(nodeId, { tmuxSession: "r01-dev" });
    const td = buildTeardown();

    await td.teardown(rigId);

    // 两者都应更新（transaction 成功）
    const sessions = sessionRegistry.getSessionsForRig(rigId);
    expect(sessions.find((s) => s.id === sessionId)?.status).toBe("exited");
    expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
  });

  // T15：破坏 --delete 事件 -> 不删除 rig
  it("rig.deleted 事件失败会阻止删除 rig", async () => {
    const { rigId } = seedRig();
    const td = buildTeardown();

    // 破坏事件持久化
    const origPersist = eventBus.persistWithinTransaction.bind(eventBus);
    eventBus.persistWithinTransaction = (event) => {
      if (event.type === "rig.deleted") throw new Error("event persist failed");
      return origPersist(event);
    };

    // Teardown + delete 应因该事件失败
    const result = await td.teardown(rigId, { delete: true });

    // session 已终止，但 rig 未删除（原子 delete + 事件已回滚）
    expect(result.sessionsKilled).toBe(1);
    expect(result.deleted).toBe(false);
    expect(rigRepo.getRig(rigId)).toBeTruthy();
    expect(result.errors.some((e) => e.includes("event persist failed") || e.includes("deletion"))).toBe(true);

    eventBus.persistWithinTransaction = origPersist;
  });
});
