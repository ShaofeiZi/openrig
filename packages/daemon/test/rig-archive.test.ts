// OPR.0.3.3.19——工作组归档能力。
//
// 关键测试是 AC-8：archive 是非破坏性的（保留工作组记录、拓扑和 snapshot，restore 仍可达），
// 并与 `down --delete` 明确对比；后者移除工作组记录，使 RestoreOrchestrator 返回
// `rig_not_found`。archive 绝不能走删除路径。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => null),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

function mockResume(): ClaudeResumeAdapter & CodexResumeAdapter {
  return {
    canResume: vi.fn(() => false),
    resume: vi.fn(async () => ({ ok: true as const })),
  } as unknown as ClaudeResumeAdapter & CodexResumeAdapter;
}

describe("rig archive affordance (OPR.0.3.3.19)", () => {
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

  afterEach(() => { db.close(); });

  function createOrchestrator() {
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: mockResume(),
      codexResume: mockResume(),
    });
  }

  /** 构建含两个节点和一条边的工作组，使保留行为可观察。 */
  function seedRigWithTopology(name: string): string {
    const rig = rigRepo.createRig(name);
    const a = rigRepo.addNode(rig.id, "orchestrator", { role: "orchestrator", runtime: "claude-code" });
    const b = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "codex" });
    rigRepo.addEdge(rig.id, a.id, b.id, "delegates_to");
    return rig.id;
  }

  function rowCount(table: string, rigCol: string, rigId: string): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${rigCol} = ?`).get(rigId) as { c: number }).c;
  }

  it("AC-8（关键）：archive 保留记录、拓扑和 snapshot，使 restore 仍可达；down --delete 移除记录并使 restore 以 rig_not_found 失败", async () => {
    const orch = createOrchestrator();
    const archiveRig = seedRigWithTopology("archive-me");
    const deleteRig = seedRigWithTopology("delete-me");
    const snapA = snapshotCapture.captureSnapshot(archiveRig, "manual");
    const snapB = snapshotCapture.captureSnapshot(deleteRig, "manual");

    // ——归档路径：非破坏性——
    expect(rigRepo.archiveRig(archiveRig)).toBe(true);
    // 工作组记录、拓扑记录和 snapshot 全部保留在磁盘。
    expect(rigRepo.getRig(archiveRig)).not.toBeNull();
    expect(rowCount("rigs", "id", archiveRig)).toBe(1);
    expect(rowCount("nodes", "rig_id", archiveRig)).toBe(2);
    expect(rowCount("edges", "rig_id", archiveRig)).toBe(1);
    expect(rowCount("snapshots", "rig_id", archiveRig)).toBeGreaterThan(0);
    // restore 仍可达：记录存在，因此不会返回 rig_not_found。
    const restoreArchived = await orch.restore(snapA.id);
    expect(restoreArchived.ok === false && restoreArchived.code === "rig_not_found").toBe(false);
    // unarchive 将其恢复到默认视图，仍为非破坏性。
    expect(rigRepo.unarchiveRig(archiveRig)).toBe(true);
    expect(rigRepo.getRig(archiveRig)).not.toBeNull();

    // ——删除路径（对照）：破坏性——
    rigRepo.deleteRig(deleteRig);
    expect(rigRepo.getRig(deleteRig)).toBeNull();
    expect(rowCount("rigs", "id", deleteRig)).toBe(0);
    // 记录已消失，restore 此时以 rig_not_found 失败。
    const restoreDeleted = await orch.restore(snapB.id);
    expect(restoreDeleted.ok).toBe(false);
    if (restoreDeleted.ok === false) {
      expect(restoreDeleted.code).toBe("rig_not_found");
    }
  });

  describe("repository archive methods + filters", () => {
    it("archiveRig/unarchiveRig 切换标志且保持幂等", () => {
      const rigId = rigRepo.createRig("r1").id;
      expect(rigRepo.archiveRig(rigId)).toBe(true);
      expect(rigRepo.archiveRig(rigId)).toBe(false); // already archived
      expect(rigRepo.unarchiveRig(rigId)).toBe(true);
      expect(rigRepo.unarchiveRig(rigId)).toBe(false); // already active
    });

    it("listRigs/getRigSummaries 默认排除已归档项；includeArchived/archivedOnly 可显式包含", () => {
      const active = rigRepo.createRig("active").id;
      const archived = rigRepo.createRig("archived").id;
      rigRepo.archiveRig(archived);

      // 默认排除已归档项。
      expect(rigRepo.listRigs().map((r) => r.id)).toEqual([active]);
      expect(rigRepo.getRigSummaries().map((s) => s.id)).toEqual([active]);
      // includeArchived 返回两者。
      expect(rigRepo.listRigs({ includeArchived: true }).map((r) => r.id).sort()).toEqual([active, archived].sort());
      // archivedOnly 仅返回已归档项。
      expect(rigRepo.listRigs({ archivedOnly: true }).map((r) => r.id)).toEqual([archived]);
      const onlyArchived = rigRepo.getRigSummaries({ archivedOnly: true });
      expect(onlyArchived.map((s) => s.id)).toEqual([archived]);
      expect(onlyArchived[0]!.archivedAt).not.toBeNull();
    });
  });

  describe("ps-projection archive filter", () => {
    it("getEntries 默认排除已归档项；includeArchived/archivedOnly 可显式包含，并携带 isArchived", () => {
      const active = rigRepo.createRig("active").id;
      const archived = rigRepo.createRig("archived").id;
      rigRepo.archiveRig(archived);
      const ps = new PsProjectionService({ db });

      expect(ps.getEntries().map((e) => e.rigId)).toEqual([active]);
      expect(ps.getEntries({ includeArchived: true }).map((e) => e.rigId).sort()).toEqual([active, archived].sort());
      const only = ps.getEntries({ archivedOnly: true });
      expect(only.map((e) => e.rigId)).toEqual([archived]);
      expect(only[0]!.isArchived).toBe(true);
      expect(only[0]!.archivedAt).not.toBeNull();
    });
  });

  describe("AC-4 host-scoped (no cross-host leak)", () => {
    it("归档仅作用于拥有工作组记录的主机；第二台主机的节点不受影响，也无需返工", () => {
      // 两个独立后台服务数据库等同于两个主机节点。V0.4 多主机将各工作组集合嵌套在所属主机节点下；
      // 当前只有 localhost，但归档标志位于本地工作组记录上，构造上按主机区分，绝不跨越主机边界。
      // 此处不构建任何多主机表或 registry（超出范围）；两个 repository 足以模拟两台主机并证明无跨主机泄漏。
      const dbHostA = db; // host A (from beforeEach)
      const repoA = rigRepo;
      const dbHostB = createFullTestDb(); // host B
      const repoB = new RigRepository(dbHostB);
      try {
        const a1 = repoA.createRig("shared-name").id;
        repoA.createRig("a-active");
        const b1 = repoB.createRig("shared-name").id;
        repoB.createRig("b-active");

        // 仅归档主机 A 下的工作组。
        expect(repoA.archiveRig(a1)).toBe(true);

        // 主机 A：默认隐藏它，archivedOnly 只显示它。
        expect(repoA.getRigSummaries().some((s) => s.id === a1)).toBe(false);
        expect(repoA.getRigSummaries({ archivedOnly: true }).map((s) => s.id)).toEqual([a1]);

        // 主机 B 不受影响：同名工作组保持活动且可见，主机 B 完全没有已归档工作组；
        // 标志从未跨主机。
        expect(repoB.getRigSummaries().some((s) => s.id === b1)).toBe(true);
        expect(repoB.getRigSummaries({ archivedOnly: true })).toEqual([]);

        // ps 投影接缝（CLI/UI 默认读取）具有相同保证。
        const psA = new PsProjectionService({ db: dbHostA });
        const psB = new PsProjectionService({ db: dbHostB });
        expect(psA.getEntries().some((e) => e.rigId === a1)).toBe(false);
        expect(psA.getEntries({ archivedOnly: true }).map((e) => e.rigId)).toEqual([a1]);
        expect(psB.getEntries({ archivedOnly: true })).toEqual([]);
      } finally {
        dbHostB.close();
      }
    });
  });
});
