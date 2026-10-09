// OPR.0.5.7.1——D1 顺序漏洞（R2 bought blocker，baton 0efd154d）：
// restoreNodeWithCompensation 在 D1 active-occupant 解析前查询 continuity_state。
// continuity_state=restoring 的 pod 节点会短路成 status "fresh" 并附带 skip warning，导致
// null/missing/dangling 状态中已存在的 authoritative relation 永不解析；launchStatusIsRunning
// 又把 "fresh" 分类为 running。这会静默绕过 A1 的明确失败语义：occupant truth 仍有歧义，
// 席位却显示健康。本 fixture 固定所需顺序：A1 ambiguity failure 必须最先触发，使用共享措辞，
// 不 resume、不调用 NodeLauncher，也不创建 replacement occupant。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter, ResumeResult } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { createFullTestDb } from "./helpers/test-app.js";

const ULID_OLD = "01ARZ3NDEKTSV4RRFFQ69G5AAA";
const ULID_NEW = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

function mockClaudeResume(result?: ResumeResult): ClaudeResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
    resume: vi.fn(async () => result ?? { ok: true as const }),
  } as unknown as ClaudeResumeAdapter;
}

function mockCodexResume(): CodexResumeAdapter {
  return {
    canResume: vi.fn(() => false),
    resume: vi.fn(async () => ({ ok: true as const })),
  } as unknown as CodexResumeAdapter;
}

describe("OPR.0.5.7.1——D1 ambiguity 先于 continuity_state=restoring skip", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
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

  it("continuity_state=restoring 且存在 ambiguous relation 的 pod 节点明确失败，绝不静默 'fresh' skip", async () => {
    const rig = rigRepo.createRig("r77");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("pod-r77", rig.id, "dev", "Dev");
    const node = rigRepo.addNode(rig.id, "seat", { role: "worker", runtime: "claude-code", podId: "pod-r77" });
    const sess = sessionRegistry.registerSession(node.id, "r77-seat");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-seed", "resume_if_possible", sess.id);
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    sessionRegistry.updateStatus(sess.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    // 会触发待修复旁路的 live continuity state。
    db.prepare("INSERT INTO continuity_state (pod_id, node_id, status) VALUES (?, ?, 'restoring')")
      .run("pod-r77", node.id);

    // ambiguous 状态下已存在的 authoritative relation：两个 running row，显式 null
    //（A1 明确失败场景）。
    const data = JSON.parse(JSON.stringify(snap.data));
    const template = data.sessions.find((s: { nodeId: string }) => s.nodeId === node.id);
    data.sessions = [
      { ...template, id: ULID_OLD, status: "running", resumeToken: "tok-a" },
      { ...template, id: ULID_NEW, status: "running", resumeToken: "tok-b" },
    ];
    delete data.activeOccupantsByNode;
    data.activeSessionIdByNode = { [node.id]: null };
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

    const tmux = mockTmux();
    const claude = mockClaudeResume();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const orch = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: claude, codexResume: mockCodexResume(),
    });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const seat = result.result.nodes.find((n) => n.logicalId === "seat");
      // base：restoring 短路会在 resolver 运行前返回 status "fresh" + skip warning
      //（candidate 约第 796–816 行）。
      expect(seat?.status).toBe("failed");
      const err = seat && "error" in seat ? String(seat.error) : "";
      expect(err).toMatch(/活动占用者有歧义/); // 共享措辞
      expect(err).toContain(ULID_OLD);
      expect(err).toContain(ULID_NEW);
    }
    // 不 resume、不调用 NodeLauncher，也不创建 replacement occupant。
    expect(claude.resume).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });
});
