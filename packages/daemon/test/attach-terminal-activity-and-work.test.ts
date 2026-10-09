// Slice 15——`attachTerminalActivityAndWork` 非推断测试包。
//
// 节点级增强层的 HG-3（双向）+ HG-4（非推断契约）。ps-projection 计数从这些字段派生，但 UI 和
// `rig ps --json` 也需要逐节点可见性；此测试包固定该 surface。
//
// 判别模式（按预存 feedback_specific_review_recommendations_get_acted_on）：
//   - 方向 A：active + 无工作 → terminalActive=true、hasAssignedWork=false
//   - 方向 B：silent + queued work → terminalActive=false、hasAssignedWork=true
// 两者都必须通过，才能证明两个原语独立计算；只有一边会被对称性破坏。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import {
  attachTerminalActivityAndWork,
  getNodeInventory,
  readAssignedWorkBySession,
} from "../src/domain/node-inventory.js";
import {
  countAssignedWorkForSession,
  countPendingWorkForSession,
} from "../src/domain/ps-projection.js";

function seedRig(db: Database.Database, name: string): string {
  const id = `rig-${name}`;
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(id, name);
  return id;
}
function seedNode(db: Database.Database, rigId: string, logicalId: string): string {
  const id = `node-${rigId}-${logicalId}`;
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(id, rigId, logicalId);
  return id;
}
function seedSession(db: Database.Database, nodeId: string, sessionName: string, status = "running"): void {
  const id = `sess-${nodeId}-${Date.now()}-${Math.random()}`;
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, nodeId, sessionName, status, new Date().toISOString().replace("T", " ").slice(0, 19));
}
function seedQitem(
  db: Database.Database,
  destinationSession: string,
  state: string,
  body = "test-body",
): string {
  const id = `q-${Date.now()}-${Math.random()}`;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  db.prepare(`
    INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
    VALUES (?, ?, ?, ?, ?, ?, 'routine', 'routine', ?)
  `).run(id, ts, ts, "op@test", destinationSession, state, body);
  return id;
}

function seedPendingQitem(db: Database.Database, destinationSession: string, body = "test-body"): void {
  seedQitem(db, destinationSession, "pending", body);
}

function makeSeatActivityFor(activeBySession: Record<string, boolean | null>) {
  return {
    getSeatActivity: (paneId: string) => {
      if (!(paneId in activeBySession)) return null;
      const isActive = activeBySession[paneId]!;
      if (isActive === null) return null;
      return {
        paneId,
        isActiveWithinWindow: isActive,
        silenceWindowSeconds: 3,
        lastObservedAt: "2026-05-16T00:00:00.000Z",
        lastActivityAt: "2026-05-15T23:59:40.000Z",
      };
    },
  };
}

describe("attachTerminalActivityAndWork——slice 15 逐节点增强", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  it("HG-3 方向 A——节点有输出且 queue 为空：terminalActive=true、hasAssignedWork=false", () => {
    const rig = seedRig(db, "active-only");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");

    const baseEntries = getNodeInventory(db, rig);
    const seatActivity = makeSeatActivityFor({ "dev@rig": true });
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });

    expect(entry!.terminalActive).toBe(true);
    expect(entry!.hasAssignedWork).toBe(false);
    expect(entry!.pendingWorkCount).toBe(0);
  });

  it("HG-3 方向 B——节点静默且有 queued work：terminalActive=false、hasAssignedWork=true", () => {
    const rig = seedRig(db, "work-only");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    seedPendingQitem(db, "dev@rig");

    const baseEntries = getNodeInventory(db, rig);
    const seatActivity = makeSeatActivityFor({ "dev@rig": false });
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });

    expect(entry!.terminalActive).toBe(false);
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("HG-4 非推断——只切换 activity 不改变 hasAssignedWork；只切换 queue 不改变 terminalActive", () => {
    const rig = seedRig(db, "non-inf");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    const baseEntries = getNodeInventory(db, rig);

    // (a) silent + 无工作。
    let seatActivity = makeSeatActivityFor({ "dev@rig": false });
    let [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });
    expect(entry!.terminalActive).toBe(false);
    expect(entry!.hasAssignedWork).toBe(false);

    // (b) 只切换 queue（添加 pending qitem），activity 输入不变。terminalActive 必须保持，
    //     hasAssignedWork 必须变为 true。
    seedPendingQitem(db, "dev@rig");
    [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db, seatActivity: seatActivity as never });
    expect(entry!.terminalActive).toBe(false); // unchanged ⟹ no queue→active inference
    expect(entry!.hasAssignedWork).toBe(true);

    // (c) 只切换 activity（active observation），queue 输入不变。hasAssignedWork 必须保持，
    //     terminalActive 必须变为 true。
    seatActivity = makeSeatActivityFor({ "dev@rig": true });
    [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db, seatActivity: seatActivity as never });
    expect(entry!.terminalActive).toBe(true);
    expect(entry!.hasAssignedWork).toBe(true); // unchanged ⟹ no active→hasWork inference
  });

  it("没有 SeatActivity observation 时 terminalActive=null（区别于 false）", () => {
    const rig = seedRig(db, "no-obs");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");

    const baseEntries = getNodeInventory(db, rig);
    const seatActivity = { getSeatActivity: () => null };
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db, seatActivity: seatActivity as never });

    // null 不等于 false：消费者必须区分“无信号”与“确定 idle”，避免非 tmux 席位被读成 idle。
    expect(entry!.terminalActive).toBeNull();
    expect(entry!.hasAssignedWork).toBe(false);
  });

  it("未接线 seatActivity service 时 terminalActive=undefined（字段缺失，而非值声明）", () => {
    const rig = seedRig(db, "no-svc");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");

    const baseEntries = getNodeInventory(db, rig);
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db });

    expect(entry!.terminalActive).toBeUndefined();
    expect(entry!.hasAssignedWork).toBe(false); // queue check still runs
  });

  // ── ARCH RULING 3a947fb1：逐席位投影在 terminalActive 旁显示原始 lastActivityAt 事实；逐字投影，
  // ── 无 observation 时为 null（真实缺失，与 terminalActive 对齐），且没有 ageSeconds 同级字段
  // ──（C3：age 在 renderer 侧派生）。
  it("从 observation 逐字投影 lastActivityAt（原始事实，区别于 lastObservedAt），且没有 ageSeconds 同级字段（C3）", () => {
    const rig = seedRig(db, "act-ts");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");

    const seatActivity = {
      getSeatActivity: (paneId: string) =>
        paneId === "dev@rig"
          ? {
              paneId,
              isActiveWithinWindow: true,
              silenceWindowSeconds: 3,
              lastObservedAt: "2026-05-16T10:00:00.000Z",
              lastActivityAt: "2026-05-16T09:59:12.000Z", // distinct raw fact
            }
          : null,
    };
    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db, seatActivity: seatActivity as never });

    expect(entry!.lastActivityAt).toBe("2026-05-16T09:59:12.000Z");
    // C3：只有一个字段；投影 surface 上没有 ageSeconds 同级字段。
    expect((entry as Record<string, unknown>).ageSeconds).toBeUndefined();
  });

  it("无 observation 时 lastActivityAt=null（真实缺失，与 terminalActive=null 对齐）", () => {
    const rig = seedRig(db, "act-noobs");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");

    const seatActivity = { getSeatActivity: () => null };
    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db, seatActivity: seatActivity as never });

    expect(entry!.terminalActive).toBeNull();
    expect(entry!.lastActivityAt).toBeNull();
  });

  it("未接线 seatActivity service 时 lastActivityAt=undefined（字段缺失，而非值声明）", () => {
    const rig = seedRig(db, "act-nosvc");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.lastActivityAt).toBeUndefined();
  });

  it("一个席位有多个 pending qitem 时 hasAssignedWork=true、pendingWorkCount=N", () => {
    const rig = seedRig(db, "multi");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    seedPendingQitem(db, "dev@rig");
    seedPendingQitem(db, "dev@rig");
    seedPendingQitem(db, "dev@rig");

    const baseEntries = getNodeInventory(db, rig);
    const [entry] = attachTerminalActivityAndWork(baseEntries, { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(3);
  });

  // QA baseline-deep-dogfood BLOCKING-A2（qitem-20260518063900-85745917）：adopted/live-session
  // rig 不显示已分配 queue work，因为 hasAssignedWork 只用 destination_session 匹配
  // canonicalSessionName。对 ADOPTED 席位，canonicalSessionName 是原始 tmux session 名（例如
  // `my-existing-claude`）；操作员通过 `rig queue create --destination <pod>-<member>@<rig>` 使用
  // canonical 形式寻址 adopted 席位。因此 adopted 匹配失败，而 managed 匹配成功（后者的
  // canonicalSessionName 已是 canonical 形式）。
  //
  // 修复：同时用两种形式解析 pending work——entry.canonicalSessionName（覆盖 managed 及以原始
  // tmux 名排队的 adopted 用户）和派生的 `{pod}-{member}@{rig}` 形式（覆盖以 canonical id 排队的
  // adopted 用户）。下方判别项固定两个方向。

  it("BLOCKING-A2：adopted 形式条目（canonicalSessionName=原始 tmux 名）匹配 canonical queue 目标，hasAssignedWork=true", () => {
    const rig = seedRig(db, "my-rig");
    const n = seedNode(db, rig, "default.dev");
    // Adopted 节点的 session 名是原始 tmux session，而非 canonical `{pod}-{member}@{rig}` 形式。
    seedSession(db, n, "raw-tmux-name", "running");
    // 操作员使用 canonical 形式排队（`rig queue create --destination default-dev@my-rig`）。
    seedPendingQitem(db, "default-dev@my-rig");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.canonicalSessionName).toBe("raw-tmux-name");
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("BLOCKING-A2：adopted 形式条目仍匹配原始 tmux 名 queue 目标（向后兼容路径）", () => {
    const rig = seedRig(db, "my-rig");
    const n = seedNode(db, rig, "default.dev");
    seedSession(db, n, "raw-tmux-name", "running");
    seedPendingQitem(db, "raw-tmux-name");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("BLOCKING-A2：managed 形式条目的 canonicalSessionName 已是 canonical 形式，行为不变", () => {
    const rig = seedRig(db, "my-rig");
    const n = seedNode(db, rig, "default.dev");
    seedSession(db, n, "default-dev@my-rig", "running");
    seedPendingQitem(db, "default-dev@my-rig");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("BLOCKING-A2：canonicalSessionName 已等于派生 canonical 形式时不重复计数", () => {
    const rig = seedRig(db, "my-rig");
    const n = seedNode(db, rig, "default.dev");
    seedSession(db, n, "default-dev@my-rig", "running");
    // canonical 目标有一个 pending qitem；条目的 canonicalSessionName 等于派生 canonical 形式，
    // 因此按两者查询不得重复计数。
    seedPendingQitem(db, "default-dev@my-rig");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("BLOCKING-A2：原始与 canonical 形式的独立 queue 目标正确求和（每项只计一次）", () => {
    const rig = seedRig(db, "my-rig");
    const n = seedNode(db, rig, "default.dev");
    seedSession(db, n, "raw-tmux-name", "running");
    seedPendingQitem(db, "raw-tmux-name");
    seedPendingQitem(db, "default-dev@my-rig");
    seedPendingQitem(db, "default-dev@my-rig");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    // 总数 = 1（raw）+ 2（canonical）= 3。
    expect(entry!.pendingWorkCount).toBe(3);
  });

  it("BLOCKING-A2：含点号的 logical ID 在 canonical 形式中归一化为连字符（匹配 deriveCanonicalSessionName）", () => {
    const rig = seedRig(db, "openrig-velocity");
    const n = seedNode(db, rig, "redo.driver-2");
    seedSession(db, n, "raw-name-X", "running");
    // 约定为 `{pod}-{member}@{rig}`，因此 logicalId "redo.driver-2" 变为 "redo-driver-2"。
    seedPendingQitem(db, "redo-driver-2@openrig-velocity");

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.pendingWorkCount).toBe(1);
  });

  it("非 pending qitem 不计入 pendingWorkCount", () => {
    const rig = seedRig(db, "states");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    // pending：计数。
    seedPendingQitem(db, "dev@rig");
    // done：不计数。
    db.prepare(`
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
      VALUES ('q-done', ?, ?, 'op@test', 'dev@rig', 'done', 'routine', 'routine', 'body')
    `).run(ts, ts);
    // blocked：不计数（只有 'pending' 尚未处理且可 claim）。
    db.prepare(`
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
      VALUES ('q-blocked', ?, ?, 'op@test', 'dev@rig', 'blocked', 'routine', 'routine', 'body')
    `).run(ts, ts);

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.pendingWorkCount).toBe(1);
    expect(entry!.hasAssignedWork).toBe(true);
  });

  it("slice 17 RED 标本——已 claim 的 in-progress 行保持 assigned，且不改变 pendingWorkCount", () => {
    const rig = seedRig(db, "claimed");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    const qitemId = seedQitem(db, "dev@rig", "in-progress");
    db.prepare("UPDATE queue_items SET claimed_at = ? WHERE qitem_id = ?")
      .run("2026-08-28 09:24:44", qitemId);

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.assignedWorkCount).toBe(1);
    expect(entry!.pendingWorkCount).toBe(0);
    expect(entry!.inProgressWorkCount).toBe(1);
    expect(entry!.blockedWorkCount).toBe(0);
  });

  it.each([
    ["pending", true, 1, 1, 0, 0],
    ["in-progress", true, 1, 0, 1, 0],
    ["blocked", true, 1, 0, 0, 1],
    ["done", false, 0, 0, 0, 0],
    ["canceled", false, 0, 0, 0, 0],
    ["handed-off", false, 0, 0, 0, 0],
  ] as const)(
    "slice 17 state matrix — %s projects assigned=%s with exact per-state counts",
    (state, hasAssignedWork, assigned, pending, inProgress, blocked) => {
      const rig = seedRig(db, `matrix-${state}`);
      const n = seedNode(db, rig, "dev");
      seedSession(db, n, "dev@rig", "running");
      seedQitem(db, "dev@rig", state);

      const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
      expect(entry!.hasAssignedWork).toBe(hasAssignedWork);
      expect(entry!.assignedWorkCount).toBe(assigned);
      expect(entry!.pendingWorkCount).toBe(pending);
      expect(entry!.inProgressWorkCount).toBe(inProgress);
      expect(entry!.blockedWorkCount).toBe(blocked);
    },
  );

  it("slice 17 混合状态明细使 pendingWorkCount 只计算 pending 并忽略 terminal 行", () => {
    const rig = seedRig(db, "mixed");
    const n = seedNode(db, rig, "dev");
    seedSession(db, n, "dev@rig", "running");
    for (const state of ["pending", "pending", "in-progress", "blocked", "done", "canceled", "handed-off"]) {
      seedQitem(db, "dev@rig", state);
    }

    const [entry] = attachTerminalActivityAndWork(getNodeInventory(db, rig), { db });
    expect(entry!.hasAssignedWork).toBe(true);
    expect(entry!.assignedWorkCount).toBe(4);
    expect(entry!.pendingWorkCount).toBe(2);
    expect(entry!.inProgressWorkCount).toBe(1);
    expect(entry!.blockedWorkCount).toBe(1);
    expect(countPendingWorkForSession(db, "dev@rig")).toBe(2);
  });

  it("slice 17 批量与逐 session 计算位置返回相同状态计数", () => {
    for (const state of ["pending", "pending", "in-progress", "blocked", "done"]) {
      seedQitem(db, "dev@rig", state);
    }

    expect(readAssignedWorkBySession(db).get("dev@rig")).toEqual(
      countAssignedWorkForSession(db, "dev@rig"),
    );
  });
});
