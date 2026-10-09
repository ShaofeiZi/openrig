import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import type { SnapshotData } from "../src/domain/types.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, snapshotsSchema]);
  return db;
}

function sampleData(): SnapshotData {
  return {
    rig: { id: "rig-1", name: "r01", createdAt: "2026-03-23", updatedAt: "2026-03-23" },
    nodes: [],
    edges: [],
    sessions: [],
    checkpoints: {},
  };
}

describe("SnapshotRepository", () => {
  let db: Database.Database;
  let repo: SnapshotRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new SnapshotRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("createSnapshot 持久化并返回包含已解析 data、status 和 createdAt 的 Snapshot", () => {
    const snap = repo.createSnapshot("rig-1", "manual", sampleData());

    expect(snap.id).toBeDefined();
    expect(snap.rigId).toBe("rig-1");
    expect(snap.kind).toBe("manual");
    expect(snap.status).toBe("complete");
    expect(snap.createdAt).toBeDefined();
    expect(snap.data.rig.name).toBe("r01");
    expect(snap.data.checkpoints).toEqual({});
  });

  it("getSnapshot 返回包含已解析 SnapshotData、status 和 createdAt 的快照", () => {
    const created = repo.createSnapshot("rig-1", "manual", sampleData());
    const fetched = repo.getSnapshot(created.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.status).toBe("complete");
    expect(fetched!.createdAt).toBe(created.createdAt);
    expect(fetched!.data.rig.name).toBe("r01");
  });

  it("getSnapshot 查询不存在的快照 → null", () => {
    expect(repo.getSnapshot("nonexistent")).toBeNull();
  });

  it("getLatestSnapshot：使用显式时间戳，返回最新快照", () => {
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("snap-old", "rig-1", "manual", JSON.stringify(sampleData()), "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("snap-new", "rig-1", "manual", JSON.stringify(sampleData()), "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("snap-mid", "rig-1", "manual", JSON.stringify(sampleData()), "2026-03-23 02:00:00");

    const latest = repo.getLatestSnapshot("rig-1");
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe("snap-new");
  });

  it("没有快照时 getLatestSnapshot → null", () => {
    expect(repo.getLatestSnapshot("rig-1")).toBeNull();
  });

  it("listSnapshots 按 created_at DESC 顺序返回（最新优先）", () => {
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s1", "rig-1", "manual", "{}", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s2", "rig-1", "pre_restore", "{}", "2026-03-23 02:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s3", "rig-1", "manual", "{}", "2026-03-23 03:00:00");

    const all = repo.listSnapshots("rig-1");
    expect(all.map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
  });

  it("listSnapshots 按 kind 过滤后保持 DESC 顺序", () => {
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s1", "rig-1", "manual", "{}", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s2", "rig-1", "pre_restore", "{}", "2026-03-23 02:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s3", "rig-1", "manual", "{}", "2026-03-23 03:00:00");

    const manualOnly = repo.listSnapshots("rig-1", { kind: "manual" });
    expect(manualOnly.map((s) => s.id)).toEqual(["s3", "s1"]);

    const preRestore = repo.listSnapshots("rig-1", { kind: "pre_restore" });
    expect(preRestore).toHaveLength(1);
    expect(preRestore[0]!.id).toBe("s2");
  });

  it("listSnapshots 设置 limit 时按顺序返回最新 N 项", () => {
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s1", "rig-1", "manual", "{}", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s2", "rig-1", "manual", "{}", "2026-03-23 02:00:00");
    db.prepare(
      "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("s3", "rig-1", "manual", "{}", "2026-03-23 03:00:00");

    const limited = repo.listSnapshots("rig-1", { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((s) => s.id)).toEqual(["s3", "s2"]); // 最新两项。
  });

  it("pruneSnapshots 保留最新 N 项、删除最旧项并返回删除数量", () => {
    for (let i = 1; i <= 5; i++) {
      db.prepare(
        "INSERT INTO snapshots (id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(`s${i}`, "rig-1", "manual", "{}", `2026-03-23 0${i}:00:00`);
    }

    const deleted = repo.pruneSnapshots("rig-1", 2);
    expect(deleted).toBe(3);

    const remaining = repo.listSnapshots("rig-1");
    expect(remaining).toHaveLength(2);
    expect(remaining.map((s) => s.id)).toEqual(["s5", "s4"]); // 保留最新两项。
  });

  // L3b: findLatestRestoreUsable
  describe("findLatestRestoreUsable (L3b)", () => {
    function dataWithSession(opts?: { sessionName?: string; nodeId?: string; rigId?: string }): SnapshotData {
      return {
        rig: { id: opts?.rigId ?? "rig-1", name: "r01", createdAt: "2026-04-28", updatedAt: "2026-04-28" },
        nodes: [],
        edges: [],
        sessions: [{
          id: "sess-1",
          nodeId: opts?.nodeId ?? "node-a",
          sessionName: opts?.sessionName ?? "r01-worker",
          status: "detached",
          resumeType: null,
          resumeToken: null,
          restorePolicy: "resume_if_possible",
          lastSeenAt: null,
          createdAt: "2026-04-28T00:00:00Z",
          origin: "launched",
          startupStatus: "ready",
          startupCompletedAt: null,
        }],
        checkpoints: {},
      };
    }

    function insertRaw(id: string, rigId: string, kind: string, dataJson: string, createdAt: string): void {
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, rigId, kind, "complete", dataJson, createdAt);
    }

  it("存在 auto-pre-down 时返回该快照（偏好信号）", () => {
      repo.createSnapshot("rig-1", "manual", dataWithSession());
      const auto = repo.createSnapshot("rig-1", "auto-pre-down", dataWithSession());

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(auto.id);
      expect(result!.kind).toBe("auto-pre-down");
    });

  it("不存在 auto-pre-down 时返回最新手动快照", () => {
      const m = repo.createSnapshot("rig-1", "manual", dataWithSession());

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(m.id);
      expect(result!.kind).toBe("manual");
    });

  it("存在多个手动快照时返回最新项（created_at DESC，id DESC）", () => {
      insertRaw("s1", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-27 10:00:00");
      insertRaw("s2", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 10:00:00");
      insertRaw("s3", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 09:00:00");

      const result = repo.findLatestRestoreUsable("rig-1");
    expect(result!.id).toBe("s2"); // 按 created_at 判断为最新。
    });

  it("auto-pre-down 优先于更新的手动快照", () => {
      insertRaw("auto-old", "rig-1", "auto-pre-down", JSON.stringify(dataWithSession()), "2026-04-27 10:00:00");
      insertRaw("manual-new", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 10:00:00");

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result!.id).toBe("auto-old");
      expect(result!.kind).toBe("auto-pre-down");
    });

  it("选择指定的可用快照，并公开更新的替代项", () => {
      insertRaw("auto-old", "rig-1", "auto-pre-down", JSON.stringify(dataWithSession()), "2026-04-27 10:00:00");
      insertRaw("manual-new", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 10:00:00");

      const result = repo.selectRestoreUsable("rig-1", "manual-new", Date.parse("2026-04-29T10:00:00Z"));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.id).toBe("manual-new");
      expect(result.selection).toMatchObject({
        mode: "explicit",
        snapshotId: "manual-new",
        kind: "manual",
        ageMs: 24 * 60 * 60 * 1000,
        newerUsableAlternative: null,
      });
    });

  it("保持自动崩溃保障排序，并报告更新的手动替代项", () => {
      insertRaw("auto-old", "rig-1", "auto-pre-down", JSON.stringify(dataWithSession()), "2026-04-27 10:00:00");
      insertRaw("manual-new", "rig-1", "manual", JSON.stringify(dataWithSession()), "2026-04-28 10:00:00");

      const result = repo.selectRestoreUsable("rig-1", undefined, Date.parse("2026-04-29T10:00:00Z"));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.id).toBe("auto-old");
      expect(result.selection.mode).toBe("automatic");
      expect(result.selection.rationale).toMatch(/崩溃保障/);
      expect(result.selection.newerUsableAlternative).toMatchObject({ snapshotId: "manual-new", kind: "manual" });
    });

  it("拒绝工作组不匹配和不可用的指定快照", () => {
      insertRaw("other-rig", "rig-2", "manual", JSON.stringify(dataWithSession({ rigId: "rig-2" })), "2026-04-28 10:00:00");
      insertRaw("broken", "rig-1", "manual", "{}", "2026-04-28 11:00:00");

      expect(repo.selectRestoreUsable("rig-1", "other-rig")).toMatchObject({ ok: false, code: "snapshot_wrong_rig" });
      expect(repo.selectRestoreUsable("rig-1", "broken")).toMatchObject({ ok: false, code: "snapshot_unusable" });
    });

  it("拒绝格式错误的显式 roster 和占用者元数据", () => {
      insertRaw("bad-roster", "rig-1", "manual", JSON.stringify({
        ...dataWithSession(),
        topologyRoster: { version: 1, source: "operator_explicit", intendedNodeIds: ["missing-node"] },
      }), "2026-04-28 10:00:00");
      insertRaw("bad-occupant", "rig-1", "manual", JSON.stringify({
        ...dataWithSession(),
        activeOccupantsByNode: { "node-1": { kind: "resolved", sessionId: "" } },
      }), "2026-04-28 11:00:00");

      expect(repo.selectRestoreUsable("rig-1", "bad-roster")).toMatchObject({ ok: false, code: "snapshot_unusable" });
      expect(repo.selectRestoreUsable("rig-1", "bad-occupant")).toMatchObject({ ok: false, code: "snapshot_unusable" });
    });

  it("拒绝会话证据缺失或跨节点的显式占用者元数据", () => {
      const data = dataWithSession();
      data.nodes = [{ id: "node-a", logicalId: "dev.a" } as SnapshotData["nodes"][number]];
      insertRaw("missing-occupant", "rig-1", "manual", JSON.stringify({
        ...data,
        activeOccupantsByNode: {},
      }), "2026-04-28 10:00:00");
      insertRaw("cross-node-occupant", "rig-1", "manual", JSON.stringify({
        ...data,
        activeOccupantsByNode: { "node-a": { kind: "resolved", sessionId: "missing-session" } },
      }), "2026-04-28 11:00:00");

      expect(repo.selectRestoreUsable("rig-1", "missing-occupant")).toMatchObject({ ok: false, code: "snapshot_unusable" });
      expect(repo.selectRestoreUsable("rig-1", "cross-node-occupant")).toMatchObject({ ok: false, code: "snapshot_unusable" });
    });

  it("不存在快照时返回 null", () => {
      expect(repo.findLatestRestoreUsable("rig-1")).toBeNull();
    });

  it("跳过 JSON 损坏的快照并考虑下一候选项", () => {
      insertRaw("s-broken", "rig-1", "manual", "{ this is not valid json", "2026-04-28 11:00:00");
      const good = repo.createSnapshot("rig-1", "manual", dataWithSession());
    // 强制排序：让 good 使用更旧的 created_at，使损坏项成为“最新”。
      db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 10:00:00", good.id);
      db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 11:00:00", "s-broken");

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(good.id);
    });

  it("跳过会话缺少 sessionName 的快照并考虑下一候选项", () => {
      const broken = JSON.parse(JSON.stringify(dataWithSession()));
      broken.sessions[0].sessionName = "";
      insertRaw("s-no-session-name", "rig-1", "manual", JSON.stringify(broken), "2026-04-28 11:00:00");
      const good = repo.createSnapshot("rig-1", "manual", dataWithSession());
      db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 10:00:00", good.id);

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result!.id).toBe(good.id);
    });

  it("跳过会话缺少 nodeId 的快照并考虑下一候选项", () => {
      const broken = JSON.parse(JSON.stringify(dataWithSession()));
      delete broken.sessions[0].nodeId;
      insertRaw("s-no-node-id", "rig-1", "manual", JSON.stringify(broken), "2026-04-28 11:00:00");
      const good = repo.createSnapshot("rig-1", "manual", dataWithSession());
      db.prepare("UPDATE snapshots SET created_at = ? WHERE id = ?").run("2026-04-28 10:00:00", good.id);

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result!.id).toBe(good.id);
    });

  it("没有快照包含恢复可用的结构元数据时返回 null", () => {
      const noRig = JSON.stringify({ nodes: [], edges: [], sessions: [], checkpoints: {} });
      const noNodes = JSON.stringify({ rig: { id: "x", name: "r", createdAt: "", updatedAt: "" }, edges: [], sessions: [], checkpoints: {} });
      insertRaw("s-no-rig", "rig-1", "manual", noRig, "2026-04-28 11:00:00");
      insertRaw("s-no-nodes", "rig-1", "manual", noNodes, "2026-04-28 12:00:00");

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).toBeNull();
    });

  it("接受 sessions 数组为空的快照（与 validatePreRestore 一致）", () => {
    // RestoreOrchestrator.validatePreRestore 允许空 sessions 数组（只拒绝缺失或非数组）。
    // 辅助函数必须与其一致。
      const empty = sampleData();
      const s = repo.createSnapshot("rig-1", "manual", empty);

      const result = repo.findLatestRestoreUsable("rig-1");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(s.id);
    });

  it("回归：findLatestAutoPreDown 保持不变（仍只返回 auto-pre-down，不按 kind 回退）", () => {
      repo.createSnapshot("rig-1", "manual", dataWithSession());
    // 没有 auto-pre-down：即使存在有效手动快照，findLatestAutoPreDown 也返回 null；
    // findLatestRestoreUsable 则会返回该手动快照。
      expect(repo.findLatestAutoPreDown("rig-1")).toBeNull();
      expect(repo.findLatestRestoreUsable("rig-1")).not.toBeNull();
    });
  });
});
