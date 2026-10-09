import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { readCrashCartDiscovery } from "../src/domain/crash-cart-discovery.js";

// Crash-cart C2 read-model——在 daemon 关闭时从（拷贝的）DB 复现 daemon 的 discovery 事实。
// 从 CANONICAL ALL_MIGRATIONS 播种（schema parity，不是手抄子集）。
// 两个事实按构造 honest-null（daemon-down 时无持久 substrate）：header 的 stop-reason /
// prior-uptime（任何地方都无 shutdown 记录）——呈现 null，绝不虚构。

let db: BetterSqlite3.Database;
beforeEach(() => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
});
afterEach(() => db.close());

function seedRig(rigId: string, name: string) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(rigId, name);
}
function seedNode(nodeId: string, rigId: string, logicalId: string) {
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(nodeId, rigId, logicalId);
}
function seedSession(over: {
  id: string;
  nodeId: string;
  name: string;
  status?: string;
  lastSeenAt?: string;
  createdAt?: string;
  probe?: string | null;
  resumeToken?: string | null;
}) {
  db.prepare(
    `INSERT INTO sessions (id, node_id, session_name, status, last_seen_at, created_at, resume_last_probe_status, resume_token)
     VALUES (@id, @nodeId, @name, @status, @lastSeenAt, @createdAt, @probe, @resumeToken)`,
  ).run({
    status: "unknown",
    lastSeenAt: null,
    // 把 created_at 钉到固定旧值，使默认 datetime('now') 绝不以 wall-clock 污染
    // header 的 last-activity union（确定性测试）。
    createdAt: "2000-01-01T00:00:00Z",
    probe: null,
    resumeToken: null,
    ...over,
  });
}

describe("readCrashCartDiscovery——本机发现", () => {
  it("报告每 rig 的 seat 数、running 数、resumable 数与最近活跃", () => {
    seedRig("r1", "alpha");
    seedNode("n1", "r1", "worker");
    seedNode("n2", "r1", "guard");
    // n1：最新 session running + resumable（probe=resumable）；n2：stopped，不可 resume。
    seedSession({ id: "01A", nodeId: "n1", name: "worker@alpha", status: "running", lastSeenAt: "2026-08-06T07:00:00Z", probe: "resumable", resumeToken: "tok" });
    seedSession({ id: "01B", nodeId: "n2", name: "guard@alpha", status: "stopped", lastSeenAt: "2026-08-06T06:00:00Z", probe: "not_resumable" });

    const { foundOnHost } = readCrashCartDiscovery(db);
    expect(foundOnHost).toHaveLength(1);
    const rig = foundOnHost[0];
    expect(rig.rigId).toBe("r1");
    expect(rig.rigName).toBe("alpha");
    expect(rig.seatCount).toBe(2);
    expect(rig.runningCount).toBe(1);
    expect(rig.resumableCount).toBe(1);
    expect(rig.lastActiveAt).toBe("2026-08-06T07:00:00Z");
  });

  it("每 node 只用最新 session（max ULID id）判断 status/resumable", () => {
    seedRig("r1", "alpha");
    seedNode("n1", "r1", "worker");
    // 旧 running+resumable，新 stopped+not——最新者胜 ⇒ 非 running、不可 resume。
    seedSession({ id: "01A", nodeId: "n1", name: "w@a", status: "running", probe: "resumable", resumeToken: "t" });
    seedSession({ id: "01Z", nodeId: "n1", name: "w@a", status: "stopped", probe: "not_resumable" });
    const { foundOnHost } = readCrashCartDiscovery(db);
    expect(foundOnHost[0].runningCount).toBe(0);
    expect(foundOnHost[0].resumableCount).toBe(0);
  });

  it("排除 archived rig", () => {
    seedRig("r1", "alpha");
    seedRig("r2", "beta");
    db.prepare("UPDATE rigs SET archived_at = ? WHERE id = 'r2'").run("2026-08-06T00:00:00Z");
    const { foundOnHost } = readCrashCartDiscovery(db);
    expect(foundOnHost.map((r) => r.rigId)).toEqual(["r1"]);
  });
});

describe("readCrashCartDiscovery——工作停处（in-progress 队列，仅展示）", () => {
  it("只列 in-progress queue item，带 owner + claimed_at，最新在前", () => {
    const ins = db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, claimed_at)
       VALUES (@id, @c, @u, @src, @dst, @state, @body, @claimed)`,
    );
    ins.run({ id: "q1", c: "t0", u: "2026-08-06T05:00:00Z", src: "orch@r", dst: "worker@alpha", state: "in-progress", body: "build X", claimed: "2026-08-06T05:00:00Z" });
    ins.run({ id: "q2", c: "t0", u: "2026-08-06T06:00:00Z", src: "orch@r", dst: "guard@alpha", state: "in-progress", body: "review Y", claimed: "2026-08-06T06:00:00Z" });
    ins.run({ id: "q3", c: "t0", u: "t9", src: "orch@r", dst: "worker@alpha", state: "done", body: "old", claimed: null });
    ins.run({ id: "q4", c: "t0", u: "t9", src: "orch@r", dst: "worker@alpha", state: "pending", body: "future", claimed: null });

    const { whereWorkStopped } = readCrashCartDiscovery(db);
    expect(whereWorkStopped.map((w) => w.qitemId)).toEqual(["q2", "q1"]); // ts_updated 最新在前，仅 in-progress
    expect(whereWorkStopped[0]).toMatchObject({ destinationSession: "guard@alpha", state: "in-progress", claimedAt: "2026-08-06T06:00:00Z" });
  });
});

describe("readCrashCartDiscovery——HEADER（派生；不可恢复项 honest-null）", () => {
  it("从最新写时间戳派生 last-activity 并暴露启动时间；stop-reason + prior-uptime 为 honest-null", () => {
    db.prepare(
      "INSERT INTO self_host_identity (singleton, host_id, minted_at, reconciled_at) VALUES (1, ?, ?, ?)",
    ).run("host-A", "2026-08-01T00:00:00Z", "2026-08-06T04:00:00Z");
    seedRig("r1", "alpha");
    seedNode("n1", "r1", "worker");
    seedSession({ id: "01A", nodeId: "n1", name: "w@a", status: "running", lastSeenAt: "2026-08-06T07:30:00Z" });

    const { header } = readCrashCartDiscovery(db);
    expect(header.lastActivityAt).toBe("2026-08-06T07:30:00Z"); // 跨写时间戳最新
    expect(header.lastBootAt).toBe("2026-08-06T04:00:00Z");
    expect(header.firstBootAt).toBe("2026-08-01T00:00:00Z");
    expect(header.hostId).toBe("host-A");
    // 承重缺口（已标记）：无持久 shutdown 记录 → 绝不虚构。
    expect(header.stopReason).toBeNull();
    expect(header.priorUptimeMs).toBeNull();
  });

  it("DB 空时整个 header 为 honest-null（不虚构）", () => {
    const { header, foundOnHost, whereWorkStopped } = readCrashCartDiscovery(db);
    expect(header).toEqual({
      lastActivityAt: null,
      lastBootAt: null,
      firstBootAt: null,
      hostId: null,
      stopReason: null,
      priorUptimeMs: null,
    });
    expect(foundOnHost).toEqual([]);
    expect(whereWorkStopped).toEqual([]);
  });
});
