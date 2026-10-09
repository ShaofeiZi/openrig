import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { PsProjectionService, deriveRigLifecycleState, seatNeedsAttention } from "../src/domain/ps-projection.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { AgentActivity, NodeInventoryEntry } from "../src/domain/types.js";

describe("PsProjectionService", () => {
  let db: Database.Database;
  let ps: PsProjectionService;

  beforeEach(() => {
    db = createFullTestDb();
    ps = new PsProjectionService({ db });
  });

  afterEach(() => { db.close(); });

  function seedRig(name: string): string {
    const id = `rig-${name}`;
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(id, name);
    return id;
  }

  function seedNode(rigId: string, logicalId: string): string {
    const id = `node-${rigId}-${logicalId}`;
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(id, rigId, logicalId);
    return id;
  }

  function seedSession(nodeId: string, status: string, createdAt?: string): string {
    const id = `sess-${nodeId}-${Date.now()}-${Math.random()}`;
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, nodeId, `tmux-${nodeId}`, status, createdAt ?? new Date().toISOString().replace("T", " ").slice(0, 19));
    return id;
  }

  function seedSnapshot(rigId: string, createdAt?: string): void {
    const id = `snap-${Date.now()}-${Math.random()}`;
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, rigId, "manual", "complete", "{}", createdAt ?? new Date().toISOString().replace("T", " ").slice(0, 19));
  }

  // T1：所有节点都在运行 -> status: running
  it("所有节点都在运行 -> status: running", () => {
    const rigId = seedRig("full-run");
    const n1 = seedNode(rigId, "dev");
    const n2 = seedNode(rigId, "qa");
    seedSession(n1, "running");
    seedSession(n2, "running");

    const entries = ps.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("running");
    expect(entries[0]!.runningCount).toBe(2);
    expect(entries[0]!.nodeCount).toBe(2);
  });

  // T2：部分节点已退出 -> status: partial
  it("部分节点已退出 -> status: partial", () => {
    const rigId = seedRig("partial");
    const n1 = seedNode(rigId, "dev");
    const n2 = seedNode(rigId, "qa");
    seedSession(n1, "running");
    seedSession(n2, "exited");

    const entries = ps.getEntries();
    expect(entries[0]!.status).toBe("partial");
    expect(entries[0]!.runningCount).toBe(1);
  });

  // T3：没有运行中的节点 -> status: stopped
  it("没有运行中的节点 -> status: stopped", () => {
    const rigId = seedRig("stopped");
    const n1 = seedNode(rigId, "dev");
    seedSession(n1, "exited");

    const entries = ps.getEntries();
    expect(entries[0]!.status).toBe("stopped");
    expect(entries[0]!.runningCount).toBe(0);
  });

  // T4：根据最早的运行中 session 计算 uptime
  it("根据最早的运行中 session 计算 uptime", () => {
    const rigId = seedRig("uptime-test");
    const n1 = seedNode(rigId, "dev");
    seedSession(n1, "running", "2026-03-26 10:00:00");

    const entries = ps.getEntries();
    expect(entries[0]!.uptime).toBeTruthy();
    // 应为类似 "Xh Ym" 的时长字符串（>24h 为 "X天 Y小时"，<60m 为 "Xm" 等）
    expect(entries[0]!.uptime).toMatch(/\d+\s*(天|小时|分钟|秒|s|m|h|d)/);
  });

  // T5：包含最新 snapshot 的 age
  it("包含最新 snapshot 的 age", () => {
    const rigId = seedRig("snap-test");
    seedNode(rigId, "dev");
    seedSnapshot(rigId, "2026-03-26 10:00:00");

    const entries = ps.getEntries();
    expect(entries[0]!.latestSnapshot).toBeTruthy();
    expect(entries[0]!.latestSnapshot).toContain("前");
  });

  // T6：空 DB -> 空数组
  it("空 DB 返回空数组", () => {
    const entries = ps.getEntries();
    expect(entries).toEqual([]);
  });

  // T7：节点有多个 session 时，只计算最新一个
  it("每个节点存在多个 session 行时——只计算最新一个", () => {
    const rigId = seedRig("multi-sess");
    const n1 = seedNode(rigId, "dev");
    seedSession(n1, "exited", "2026-03-26 09:00:00");
    seedSession(n1, "running", "2026-03-26 10:00:00"); // newest

    const entries = ps.getEntries();
    expect(entries[0]!.runningCount).toBe(1);
    expect(entries[0]!.status).toBe("running");
  });

  // T8：多个 snapshot + session -> 正确聚合
  it("正确聚合多个 snapshot + session", () => {
    const rigId = seedRig("aggregate");
    const n1 = seedNode(rigId, "dev");
    const n2 = seedNode(rigId, "qa");
    seedSession(n1, "running");
    seedSession(n2, "running");
    seedSnapshot(rigId, "2026-03-26 08:00:00");
    seedSnapshot(rigId, "2026-03-26 09:00:00"); // latest

    const entries = ps.getEntries();
    expect(entries[0]!.nodeCount).toBe(2);
    expect(entries[0]!.runningCount).toBe(2);
    expect(entries[0]!.latestSnapshot).toBeTruthy();
  });

  // T9：同一秒的 session 按 ID 决胜
  it("同一秒的 session 按 ID 降序解析", () => {
    const rigId = seedRig("tiebreak");
    const n1 = seedNode(rigId, "dev");
    // 插入时间戳相同、ID 不同的记录
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("sess-aaa", n1, "tmux-old", "exited", "2026-03-26 10:00:00");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("sess-zzz", n1, "tmux-new", "running", "2026-03-26 10:00:00");

    const entries = ps.getEntries();
    // sess-zzz 的 ID 更靠后 -> 胜出 -> running
    expect(entries[0]!.runningCount).toBe(1);
    expect(entries[0]!.status).toBe("running");
  });

  // T10：createDaemon 接入 /api/ps 路由
  it("createDaemon 接入 /api/ps 路由", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });
    try {
      const res = await app.request("/api/ps");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    } finally {
      daemonDb.close();
    }
  });

  // L2 rig 级 lifecycleState
  describe("lifecycleState（L2）", () => {
    function seedSnapshotForRig(rigId: string, sessions: Array<{ nodeId: string; resumeToken: string | null }>): void {
      const data = {
        rig: { id: rigId, name: "rig-name", createdAt: "2026-04-28T00:00:00Z", updatedAt: "2026-04-28T00:00:00Z" },
        nodes: [],
        edges: [],
        sessions: sessions.map((s, i) => ({
          id: `sess-snap-${i}`,
          nodeId: s.nodeId,
          sessionName: `tmux-${s.nodeId}`,
          status: "detached",
          resumeType: s.resumeToken ? "claude" : null,
          resumeToken: s.resumeToken,
          restorePolicy: "resume_if_possible",
          lastSeenAt: null,
          createdAt: "2026-04-28T00:00:00Z",
          origin: "launched" as const,
          startupStatus: "ready" as const,
          startupCompletedAt: null,
        })),
        checkpoints: {},
      };
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data) VALUES (?, ?, ?, ?, ?)")
        .run(`snap-${rigId}`, rigId, "manual", "complete", JSON.stringify(data));
    }

    it("所有节点都在运行 -> lifecycleState=running", () => {
      const rigId = seedRig("all-run");
      const n1 = seedNode(rigId, "dev");
      const n2 = seedNode(rigId, "qa");
      seedSession(n1, "running");
      seedSession(n2, "running");

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("running");
    });

    it("所有节点都 detached + snapshot 可用 -> lifecycleState=recoverable", () => {
      const rigId = seedRig("all-recoverable");
      const n1 = seedNode(rigId, "dev");
      const n2 = seedNode(rigId, "qa");
      seedSession(n1, "detached");
      seedSession(n2, "detached");
      seedSnapshotForRig(rigId, [
        { nodeId: n1, resumeToken: "tok-1" },
        { nodeId: n2, resumeToken: "tok-2" },
      ]);

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("recoverable");
    });

    it("所有节点都 detached + 没有可用 snapshot -> lifecycleState=stopped", () => {
      const rigId = seedRig("all-stopped");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "detached");

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("stopped");
    });

    it("混合 running + detached -> lifecycleState=degraded", () => {
      const rigId = seedRig("mixed");
      const n1 = seedNode(rigId, "dev");
      const n2 = seedNode(rigId, "qa");
      seedSession(n1, "running");
      seedSession(n2, "detached");

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("degraded");
    });

    it("任一节点 attention_required -> lifecycleState=attention_required（优先于 running）", () => {
      const rigId = seedRig("att-priority");
      const n1 = seedNode(rigId, "dev");
      const n2 = seedNode(rigId, "qa");
      seedSession(n1, "running");
      seedSession(n2, "running");
      // 通过运行中 session 上失败的 restoreOutcome 将 n2 标记为 attention_required
      db.prepare(
        "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
      ).run(rigId, n2, "restore.completed", JSON.stringify({
        result: { rigResult: "partially_restored", nodes: [{ nodeId: n2, status: "failed" }] },
        type: "restore.completed",
      }));

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("attention_required");
    });

    // L3-followup：rigName alias 始终有值且等于 name。
    it("每个条目的 rigName alias 都有值且等于 name（L3-followup）", () => {
      const rigA = seedRig("alpha");
      const rigB = seedRig("beta");
      seedNode(rigA, "dev");
      seedNode(rigB, "qa");

      const entries = ps.getEntries();
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(typeof e.rigName).toBe("string");
        expect(e.rigName.length).toBeGreaterThan(0);
        expect(e.rigName).toBe(e.name);
      }
    });

    it("即使 rig 为空，lifecycleState 也始终有值（L3-followup）", () => {
      seedRig("empty-rig");

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBeDefined();
      expect(entries[0]!.lifecycleState).not.toBeNull();
      expect(entries[0]!.lifecycleState).toBe("stopped");
    });

    // 对 fold helper 的纯单元级覆盖。
    it("deriveRigLifecycleState fold helper 覆盖所有分支", () => {
      expect(deriveRigLifecycleState([])).toBe("stopped");
      expect(deriveRigLifecycleState(["running", "running"])).toBe("running");
      expect(deriveRigLifecycleState(["detached", "detached"])).toBe("stopped");
      expect(deriveRigLifecycleState(["recoverable", "detached"])).toBe("recoverable");
      expect(deriveRigLifecycleState(["recoverable", "recoverable"])).toBe("recoverable");
      expect(deriveRigLifecycleState(["running", "detached"])).toBe("degraded");
      expect(deriveRigLifecycleState(["running", "recoverable"])).toBe("degraded");
      expect(deriveRigLifecycleState(["attention_required", "running"])).toBe("attention_required");
      expect(deriveRigLifecycleState(["attention_required", "detached"])).toBe("attention_required");
    });

    // OPR.0.3.4.6——跨接口回归门禁：投影绝不在 rig 层将 attention_required 折叠为 failed。
    it("OPR.0.3.4.6 门禁：attention_required 节点绝不映射为 rig 级 'failed'（始终为 'attention_required'）", () => {
      expect(deriveRigLifecycleState(["attention_required"])).toBe("attention_required");
      expect(deriveRigLifecycleState(["attention_required"])).not.toBe("failed");
      expect(deriveRigLifecycleState(["attention_required", "running", "detached"])).toBe("attention_required");
      expect(deriveRigLifecycleState(["attention_required", "running", "detached"])).not.toBe("failed");
    });
  });

  // Slice 15——`terminal-active` 计数 + `has-work` 计数是 PsEntry 上的并行原语；
  // `runningCount`（进程存活）保持不变。下列测试固定非推断契约（HG-3 + HG-4）：
  // 两个新计数必须可独立观察——席位处于一种状态时，不应带动另一计数增加。
  describe("slice 15——activeCount + hasWorkCount（与 runningCount 并行）", () => {
    function makeSeatActivityFor(activeByPaneId: Record<string, boolean>) {
      return {
        getSeatActivity: (paneId: string) => {
          if (paneId in activeByPaneId) {
            return {
              paneId,
              isActiveWithinWindow: activeByPaneId[paneId]!,
              silenceWindowSeconds: 3,
              lastObservedAt: "2026-05-16T00:00:00.000Z",
              lastActivityAt: "2026-05-15T23:59:40.000Z",
            };
          }
          return null;
        },
      };
    }

    function seedQitem(destinationSession: string, state: string): void {
      const id = `qitem-${Date.now()}-${Math.random()}`;
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      db.prepare(`
        INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
        VALUES (?, ?, ?, ?, ?, ?, 'routine', 'routine', ?)
      `).run(id, ts, ts, "operator@test", destinationSession, state, "test-body");
    }

    function seedPendingQitem(destinationSession: string): void {
      seedQitem(destinationSession, "pending");
    }

    it("runningCount 保持进程存活语义；未接入信号时 activeCount + hasWorkCount 默认为 0", () => {
      const rigId = seedRig("baseline");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");

      const entries = ps.getEntries();
      expect(entries[0]!.runningCount).toBe(1);
      expect(entries[0]!.activeCount).toBe(0);
      expect(entries[0]!.hasWorkCount).toBe(0);
    });

    it("HG-3 方向 A——席位正在输出但队列为空：terminalActive=true、hasAssignedWork=false ⇒ activeCount=1、hasWorkCount=0", () => {
      const rigId = seedRig("active-no-work");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;
      const seatActivity = makeSeatActivityFor({ [paneId]: true });
      const psWithActivity = new PsProjectionService({ db, seatActivity: seatActivity as never });

      const entries = psWithActivity.getEntries();
      expect(entries[0]!.activeCount).toBe(1);
      expect(entries[0]!.hasWorkCount).toBe(0);
      // 进程存活计数不变
      expect(entries[0]!.runningCount).toBe(1);
    });

    it("HG-3 方向 B——席位 SILENT 但有排队工作：terminalActive=false、hasAssignedWork=true ⇒ activeCount=0、hasWorkCount=1", () => {
      const rigId = seedRig("idle-with-work");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;
      seedPendingQitem(paneId);
      const seatActivity = makeSeatActivityFor({ [paneId]: false });
      const psWithActivity = new PsProjectionService({ db, seatActivity: seatActivity as never });

      const entries = psWithActivity.getEntries();
      expect(entries[0]!.activeCount).toBe(0);
      expect(entries[0]!.hasWorkCount).toBe(1);
      expect(entries[0]!.runningCount).toBe(1);
    });

    it("HG-4 非推断——伪造 activity 状态不改变 hasWorkCount；伪造 queue 状态不改变 activeCount", () => {
      const rigId = seedRig("non-inference");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;

      // 初始：静默席位，无排队工作。两个计数均为 0。
      const seatActivitySilent = makeSeatActivityFor({ [paneId]: false });
      let entries = new PsProjectionService({ db, seatActivity: seatActivitySilent as never }).getEntries();
      expect(entries[0]!.activeCount).toBe(0);
      expect(entries[0]!.hasWorkCount).toBe(0);

      // 只改变 queue 状态（添加 pending qitem）。activeCount 不得变化。
      seedPendingQitem(paneId);
      entries = new PsProjectionService({ db, seatActivity: seatActivitySilent as never }).getEntries();
      expect(entries[0]!.activeCount).toBe(0); // 不变——证明不存在 queue→active 推断
      expect(entries[0]!.hasWorkCount).toBe(1);

      // 只改变 activity 状态（active observation），保留 qitem。hasWorkCount 必须不变。
      const seatActivityActive = makeSeatActivityFor({ [paneId]: true });
      entries = new PsProjectionService({ db, seatActivity: seatActivityActive as never }).getEntries();
      expect(entries[0]!.activeCount).toBe(1);
      expect(entries[0]!.hasWorkCount).toBe(1); // 不变——证明不存在 active→hasWork 推断
    });

    it("running 但无 observation 时视为 inactive（activeCount=0）——null SeatActivity 与 active 不同", () => {
      const rigId = seedRig("no-obs");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      // SeatActivity 对每个 paneId 返回 null——尚无 observation。
      const seatActivity = { getSeatActivity: () => null };
      const psWithActivity = new PsProjectionService({ db, seatActivity: seatActivity as never });

      const entries = psWithActivity.getEntries();
      expect(entries[0]!.runningCount).toBe(1);
      expect(entries[0]!.activeCount).toBe(0); // 无信号 ≠ active
    });

    it("hasWorkCount 统计不同节点；一个席位上的多个 qitem 只计一次", () => {
      const rigId = seedRig("multi-qitem");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;
      seedPendingQitem(paneId);
      seedPendingQitem(paneId);
      seedPendingQitem(paneId);

      const entries = ps.getEntries();
      expect(entries[0]!.hasWorkCount).toBe(1);
    });

    it("活跃 qitem 计入 hasWorkCount，终态 qitem 不计入", () => {
      const rigId = seedRig("only-pending");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;
      for (const state of ["pending", "in-progress", "blocked", "done", "canceled", "handed-off"]) {
        seedQitem(paneId, state);
      }

      const entries = ps.getEntries();
      expect(entries[0]!.hasWorkCount).toBe(1); // 一个席位，不受其三条活跃记录影响
    });

    it.each(["in-progress", "blocked"])("slice 17——只有 %s 工作的席位计为已分配", (state) => {
      const rigId = seedRig(`assigned-${state}`);
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      seedQitem(`tmux-${n1}`, state);

      expect(ps.getEntries()[0]!.hasWorkCount).toBe(1);
    });
  });

  // OPR.0.4.4.21——rig 汇总 attention 谓词 + 聚合（FR-1）。
  describe("OPR.0.4.4.21——attentionCount（一个谓词，每席位计数一次）", () => {
    const baseEntry = (over: Partial<NodeInventoryEntry> = {}): NodeInventoryEntry => ({
      rigId: "r", rigName: "r", nodeId: "n", logicalId: "dev",
      canonicalSessionName: "dev@r",
      sessionStatus: "running",
      startupStatus: "ready",
      lifecycleState: "running",
      latestError: null,
      heldReason: null,
      ...over,
    } as NodeInventoryEntry);

    const idleActivity = (state: AgentActivity["state"]): AgentActivity => ({
      state, reason: "test", evidenceSource: "runtime_hook",
      sampledAt: new Date().toISOString(), fallback: false, stale: false,
    } as AgentActivity);

    it("单独统计每种信号：lifecycle attention", () => {
      expect(seatNeedsAttention(baseEntry({ lifecycleState: "attention_required" }), null)).toBe(true);
    });
    it("直接根据 startupStatus 统计 startup attention_required", () => {
      expect(seatNeedsAttention(baseEntry({ startupStatus: "attention_required" }), null)).toBe(true);
    });
    it("即使 latestError 为 NULL 也统计 startup failed（绝非前置条件）", () => {
      expect(seatNeedsAttention(baseEntry({ startupStatus: "failed", latestError: null }), null)).toBe(true);
    });
    it("统计 live needs_input hook", () => {
      expect(seatNeedsAttention(baseEntry(), idleActivity("needs_input"))).toBe(true);
    });
    it("统计 held 席位", () => {
      expect(seatNeedsAttention(baseEntry({ heldReason: "held: staged launch" }), null)).toBe(true);
    });
    it("将已记录的 startup error 计为额外信号", () => {
      expect(seatNeedsAttention(baseEntry({ latestError: "boom" }), null)).toBe(true);
    });
    it("activity 为 running/idle/unknown 的健康席位不计入（unknown 不等于 attention）", () => {
      expect(seatNeedsAttention(baseEntry(), null)).toBe(false);
      expect(seatNeedsAttention(baseEntry(), idleActivity("running"))).toBe(false);
      expect(seatNeedsAttention(baseEntry(), idleActivity("idle"))).toBe(false);
      expect(seatNeedsAttention(baseEntry(), idleActivity("unknown"))).toBe(false);
    });

    it("getEntries：多信号席位只计一次；健康 peer 计为零", () => {
      const rigId = seedRig("attn-once");
      const bad = seedNode(rigId, "bad");
      const ok = seedNode(rigId, "ok");
      // bad：startup failed + startup error + held（三个信号，一个席位）
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-bad", bad, "bad@attn-once", "exited", "failed");
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.startup_failed', ?, datetime('now'))")
        .run(rigId, bad, JSON.stringify({ error: "launch exploded" }));
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.held', ?, datetime('now'))")
        .run(rigId, bad, JSON.stringify({ reason: "held" }));
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-ok", ok, "ok@attn-once", "running", "ready");

      const entries = ps.getEntries();
      expect(entries.find((e) => e.rigId === rigId)!.attentionCount).toBe(1);
    });

    it("getEntries：fresh needs_input hook 通过 store 计入；stale hook 降级为 unknown 且不计入", () => {
      const rigId = seedRig("attn-hook");
      const n = seedNode(rigId, "dev");
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-hook", n, "dev@attn-hook", "running", "ready");
      const eventBus = new EventBus(db);
      const store = new AgentActivityStore({ db, eventBus });
      const emit = (eventAt: string) => eventBus.emit({
        type: "agent.activity", rigId, nodeId: n, sessionName: "dev@attn-hook", runtime: "claude-code",
        activity: { state: "needs_input", reason: "permission_prompt", evidenceSource: "runtime_hook",
          sampledAt: eventAt, eventAt, evidence: "permission_prompt", fallback: false, stale: false },
      } as never);

      emit(new Date().toISOString()); // fresh
      const withStore = new PsProjectionService({ db, agentActivity: store });
      expect(withStore.getEntries().find((e) => e.rigId === rigId)!.attentionCount).toBe(1);

      emit(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()); // stale（最新行现已过期）
      expect(withStore.getEntries().find((e) => e.rigId === rigId)!.attentionCount).toBe(0);
    });

    it("getEntries：store 缺失 -> needs_input 贡献 false（如实降级），其他信号仍计入", () => {
      const rigId = seedRig("attn-nostore");
      const n = seedNode(rigId, "dev");
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-ns", n, "dev@attn-nostore", "exited", "failed");
      const entries = ps.getEntries(); // `ps` 没有 agentActivity store
      expect(entries.find((e) => e.rigId === rigId)!.attentionCount).toBe(1);
    });

    it("attentionCount 为增量字段：保留每个既有 PsEntry key（RPS-2）", () => {
      const rigId = seedRig("attn-keys");
      const n = seedNode(rigId, "dev");
      seedSession(n, "running");
      const entry = ps.getEntries().find((e) => e.rigId === rigId)!;
      for (const key of ["rigId", "name", "rigName", "nodeCount", "runningCount", "activeCount", "hasWorkCount",
        "status", "lifecycleState", "uptime", "latestSnapshot", "archivedAt", "isArchived",
        "periodicSnapshotActive", "periodicSnapshotIntervalSeconds", "autoPeriodicSnapshotCount"]) {
        expect(Object.prototype.hasOwnProperty.call(entry, key), key).toBe(true);
      }
      expect(typeof entry.attentionCount).toBe("number");
      expect(JSON.stringify(entry)).not.toContain("resumeToken");
    });
  });
});

// ===================================================================
// SLICE-05 条目 5（D5）——ps 不得将已死亡席位虚构为 running。
// runningCount/status 来自原始 `sessions.status='running'` SQL（不感知 verdict）；
// SeatIdentityReconciler 将 session_missing verdict 写入 runningCount 从不读取的独立表。
// 带外 tmux teardown 后，持久化 status 仍为 'running'，因此 ps 会虚构 running。
// RED 固定要求：有效 runningCount/status 必须排除带 session_missing 身份 verdict 的席位。
// 生产 seam 尚未决定（ps 消费 verdict，或 adapter/verdict 降级）——此处断言结果而非机制。
// 测试自包含（使用自己的 DB）。
// ===================================================================
describe("Slice-05 条目 5（D5）——ps running 如实性与 identity verdict", () => {
  it("RED：具有有效 session_missing verdict 的 running session 不计为 running", () => {
    const db = createFullTestDb();
    try {
      db.prepare("INSERT INTO rigs (id, name) VALUES ('r-d5','d5')").run();
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n-d5','r-d5','dev','claude-code','/tmp')").run();
      db.prepare(
        "INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-d5','n-d5','tmux-n-d5','running','2026-07-02 12:00:00')",
      ).run();
      // 使用当前 binding，使 verdict 可应用（applicableVerdict 要求 verdict.sessionName === 最新 session_name，
      // 且 registeredPane === binding tmux_pane）。
      db.prepare(
        "INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-d5','n-d5','tmux','tmux-n-d5','%1')",
      ).run();
      // live tmux session 已消失；reconciler 针对此 binding 记录了 session_missing。
      new SeatIdentityStore(db).upsert({
        nodeId: "n-d5",
        verdict: "pane_missing",
        evidenceSource: "tmux_session",
        reason: "session_missing",
        evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null },
        sessionName: "tmux-n-d5",
        observedAt: "2026-07-02T12:00:00.000Z",
      });
      const entry = new PsProjectionService({ db }).getEntries()[0]!;
      // verdict 确实可应用：lifecycle 轴已遵循该 verdict（降级）。
      expect(entry.lifecycleState).toBe("attention_required");
      // 但 running 轴不感知 verdict——这正是此 RED 固定的矛盾。
      expect(entry.runningCount).toBe(0); // <-- RED：当前为 1（原始 sessions.status，不感知 verdict）
      expect(entry.status).not.toBe("running"); // <-- RED：当前为 "running"
    } finally {
      db.close();
    }
  });
});
