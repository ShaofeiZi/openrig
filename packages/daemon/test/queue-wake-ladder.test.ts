// S01（OPR.0.5.5.1）——BATON 的 WAKE 或 ESCALATE，RED-first。“wake 失败的 handoff
// 绝不能静默停放。”当前只记录一次失败的 nudge，随后没有动作（实测 0.5.3 的主要失败类别）。
// 此 slice 完成后，失败的 baton wake 会按 config 指定的有界 schedule 重试，然后经具名 rung
// escalate（先到 destination 的 orchestrator，再到 operator surface）；每一步都记录 transition，
// 没有任何静默动作。
//
// 具名不变量（mini-req 7）：ROW 恰好一次地承载 OBLIGATION；WAKE 至少一次。ladder 重试 NUDGE，
// 绝不重试 content——此处没有任何机制生成重复 obligation row（每个 destination 仅有一条 aggregate
// escalation row，它是发给 orchestrator 的新 obligation，会去重和 refresh）。
//
// ladder 的 state 就是 transition log（AM-P3-F6）：每次 tick 都从 marker 派生 attempt、rung 与
// suspension，因此 daemon restart 会从准确位置恢复——下方 forgotten-ladder 与 reset-count 均为 RED。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { USAGE_LIMIT_BLOCKER_TAG } from "../src/domain/queue-wake-repository.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import {
  LADDER_ATTEMPT_PREFIX,
  LADDER_RUNG_PREFIX,
  LADDER_EXHAUSTED_PREFIX,
  STUCK_SWEEP_FINDING_TAG,
  runStuckSweep,
  createStuckSweepStatus,
} from "../src/domain/queue-stuck-sweep.js";

const ladderMod = () => import("../src/domain/queue-wake-ladder.js");

interface WakeCall {
  qitemId: string;
  target: string;
}

describe("S01 wake-or-escalate——重试 ladder、具名 rung、派生 suspension", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let calls: WakeCall[];
  /** 按 target session 编排 outcome；默认为 failed。 */
  let outcomes: Record<string, string>;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    calls = [];
    outcomes = {};
    delete process.env.OPENRIG_WAKE_SUSPEND;
  });
  afterEach(() => {
    delete process.env.OPENRIG_WAKE_SUSPEND;
    db.close();
  });

  const attemptWake = async (qitemId: string, target: string): Promise<string> => {
    calls.push({ qitemId, target });
    return outcomes[target] ?? "failed:tmux session not found";
  };

  async function mkBaton(dest = "worker@r"): Promise<QueueItem> {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const { created } = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "relay@r",
      toSession: dest,
      nudge: false,
    });
    return created;
  }

  function setNudgeResult(qitemId: string, result: string, minutesAgo = 0): void {
    const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?").run(
      ts,
      result,
      qitemId,
    );
  }

  function ageCreated(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, qitemId);
  }

  /** 将每个 ladder marker 回拨，使下一次 tick 判定 interval 已经过。 */
  function ageMarkers(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare(
      "UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND (transition_note LIKE 'wake-attempt:%' OR transition_note LIKE 'escalation-rung:%' OR transition_note LIKE 'ladder-suspend:%')",
    ).run(past, qitemId);
  }

  function markersOf(qitemId: string, prefix: string): string[] {
    const rows = db
      .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts, rowid")
      .all(qitemId) as Array<{ transition_note: string | null }>;
    return rows.map((r) => r.transition_note ?? "").filter((n) => n.startsWith(prefix));
  }

  /** 真实 managed-seat 形态：canonical session（短横线形式）与 node logical_id（点号形式）
   *  相互独立定义——live topology 中没有二者相同的情况，因此任何由一方派生另一方的 fixture 都
   *  忽略了真实形态。持久链接是 sessions table binding，绝不是字符串转换。 */
  let nodeSeq = 0;
  function bindSeat(sessionName: string, dottedLogicalId: string, rigName = "r"): string {
    const nodeId = `node-${++nodeSeq}`;
    db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES (?, ?)").run(`rig-${rigName}`, rigName);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(
      nodeId,
      `rig-${rigName}`,
      dottedLogicalId,
    );
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')",
    ).run(`sess-${nodeId}`, nodeId, sessionName);
    return nodeId;
  }

  function setHandoverAt(dest: string, secondsAgo: number): void {
    const existing = db
      .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1")
      .get(dest) as { node_id: string } | undefined;
    const nodeId = existing?.node_id ?? bindSeat(dest, `fixture.swap-${nodeSeq}`);
    db.prepare("UPDATE nodes SET handover_at = ? WHERE id = ?").run(
      new Date(Date.now() - secondsAgo * 1000).toISOString(),
      nodeId,
    );
  }

  async function tick(overrides: Record<string, unknown> = {}) {
    const mod = await ladderMod();
    return mod.runWakeLadderTick({
      db,
      queueRepo: repo,
      attemptWake,
      resolveOrchestrator: () => "orch@r",
      retryIntervalSeconds: 300,
      retryCap: 3,
      unconfirmedWindowMinutes: 30,
      swapGraceSeconds: 180,
      log: () => {},
      ...overrides,
    });
  }

  async function escalationRowsFor(dest: string): Promise<QueueItem[]> {
    const mod = await ladderMod();
    return repo
      .list({ limit: 500 })
      .filter((i) => (i.tags ?? []).includes(mod.escalationDedupTag(dest)));
  }

  // ── G1：记录 RETRY，RED-FIRST ────────────────────────────────────────────────

  it("记录 RETRY：失败的 baton wake 按 schedule 重试；每次 attempt 都以带 outcome 的 transition marker 落盘", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 10);
    await tick();
    expect(calls).toEqual([{ qitemId: baton.qitemId, target: "worker@r" }]);
    let attempts = markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatch(/1\/3/);
    expect(attempts[0]).toMatch(/failed/); // attempt 的 outcome 位于 marker 上
    ageMarkers(baton.qitemId, 10);
    await tick();
    ageMarkers(baton.qitemId, 10);
    await tick();
    attempts = markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]).toMatch(/3\/3/); // 从 transition 计数，而非从内存计数
  });

  it("遵守 SCHEDULE：retry interval 内的 tick 不执行 attempt（有界，绝不形成 hot loop）", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 10);
    await tick();
    expect(calls).toHaveLength(1);
    await tick(); // marker 尚新——interval 未经过
    expect(calls).toHaveLength(1);
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(1);
  });

  // ── G2：ESCALATION RUNG 按顺序触发 ───────────────────────────────────────────

  it("RUNG 顺序：超过 cap 后，orchestrator rung 以带原因的 transition 落盘，只生成一条 aggregate escalation row，不重复 baton row", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    for (let i = 0; i < 3; i++) {
      await tick();
      ageMarkers(baton.qitemId, 10);
    }
    const before = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    await tick(); // 超过 cap → orchestrator rung
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs).toHaveLength(1);
    expect(rungs[0]).toMatch(/orchestrator/);
    expect(rungs[0]).toMatch(/wake 失败 3 次，历时 \d+ 分钟/i); // 具名原因
    const escRows = await escalationRowsFor("worker@r");
    expect(escRows).toHaveLength(1);
    expect(escRows[0]!.destinationSession).toBe("orch@r");
    expect(escRows[0]!.body).toContain(baton.qitemId);
    const after = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    expect(after).toBe(before + 1); // 恰好一条 aggregate row——baton 绝不重复
  });

  it("VIEW 呈现结果：`view show escalations` 返回 open wake-escalation aggregate", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    for (let i = 0; i < 4; i++) {
      await tick();
      ageMarkers(baton.qitemId, 10);
    }
    const projector = new ViewProjector(db);
    const view = projector.show("escalations");
    const escRows = await escalationRowsFor("worker@r");
    expect(escRows).toHaveLength(1);
    expect(view.rows.map((r) => r.qitem_id)).toContain(escRows[0]!.qitemId);
  });

  // ── G3：F1——UNCONFIRMED 绝不重试，也绝不静默停放 ──────────────────────────────

  it("UNCONFIRMED 绝不再次 NUDGE（阴性对照）：window 内的 delivered-ack-pending baton 不执行 wake attempt", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "delivered-ack-pending", 5);
    await tick();
    expect(calls).toHaveLength(0);
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(0);
  });

  it("UNCONFIRMED + 无 PICKUP 直接 ESCALATE：超过 window 且无 pickup evidence 时，ladder 跳过 retry rung——绝不再次向 destination 发送", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "delivered-ack-pending", 45);
    ageCreated(baton.qitemId, 45);
    await tick();
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(0); // 无 retry rung
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs).toHaveLength(1);
    expect(rungs[0]).toMatch(/orchestrator/);
    expect(rungs[0]).toMatch(/unconfirmed/i);
    // Escalation 不是重新发送：每次 delivery attempt 都发给 orchestrator，而非 destination。
    expect(calls.every((c) => c.target === "orch@r")).toBe(true);
    expect(calls.some((c) => c.target === "worker@r")).toBe(false);
  });

  it("UNCONFIRMED + 有 PICKUP ACTIVITY 不进入（阴性对照）：超过 window 的 claimed baton 保持不动", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "delivered-ack-pending", 45);
    ageCreated(baton.qitemId, 45);
    repo.claim({ qitemId: baton.qitemId, destinationSession: "worker@r" }); // pickup evidence
    await tick();
    expect(calls).toHaveLength(0);
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX)).toHaveLength(0);
  });

  it("INDETERMINATE OUTCOME 走相同确认路径：无 pickup 的 indeterminate baton 不重新发送，直接 escalate", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "indeterminate:wake send timed out", 45);
    ageCreated(baton.qitemId, 45);
    await tick();
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(0);
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX)).toHaveLength(1);
    expect(calls.some((c) => c.target === "worker@r")).toBe(false);
  });

  // ── G4：F2——SUSPENSION 从 SWAP STATE 派生 ─────────────────────────────────────

  it("SWAP 暂停 LADDER：处于 post-swap grace 的 destination 不执行 wake attempt，只记录一个 suspend marker（stale-wake-burst 样本）", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    setHandoverAt("worker@r", 10); // swap 于 10 秒前完成——仍在 180 秒 grace 内
    await tick();
    await tick(); // burst 形态：swap window 内重复到期的 tick
    expect(calls).toHaveLength(0); // grace 内零 attempt
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(0);
    expect(markersOf(baton.qitemId, "ladder-suspend:")).toHaveLength(1); // 只记录一次，而非每个 tick 一次
  });

  it("记录 RESUME：grace 结束后，ladder 以一条 resume marker 恢复并继续 retry", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    setHandoverAt("worker@r", 10);
    await tick(); // 已暂停
    setHandoverAt("worker@r", 600); // grace（180 秒）已结束
    await tick();
    expect(markersOf(baton.qitemId, "ladder-resume:")).toHaveLength(1);
    expect(calls).toEqual([{ qitemId: baton.qitemId, target: "worker@r" }]);
  });

  it("声明 WINDOW 仅为 OPERATOR OVERRIDE：OPENRIG_WAKE_SUSPEND 可暂停没有 swap 的 destination", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    process.env.OPENRIG_WAKE_SUSPEND = `worker@r:${new Date(Date.now() + 3600_000).toISOString()}`;
    await tick();
    expect(calls).toHaveLength(0);
    expect(markersOf(baton.qitemId, "ladder-suspend:")).toHaveLength(1);
    expect(markersOf(baton.qitemId, "ladder-suspend:")[0]).toMatch(/operator/i); // 点名为 override
  });

  // ── G5：F3——风暴聚合 ─────────────────────────────────────────────────────────

  it("风暴聚合：一个失效 destination × 五个卡住 baton，只产生一条点名全部五项的 aggregate escalation，refresh 而不重复", async () => {
    const batons: QueueItem[] = [];
    for (let i = 0; i < 5; i++) {
      const b = await mkBaton();
      setNudgeResult(b.qitemId, "failed:tmux session not found", 120);
      // 预置 exhausted retry history，使五个 baton 都处于 escalation phase。
      for (let a = 1; a <= 3; a++) {
        repo.transitionLog.append({
          qitemId: b.qitemId,
          state: "pending",
          actorSession: "wake-ladder@system",
          transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
        });
      }
      ageMarkers(b.qitemId, 30);
      batons.push(b);
    }
    await tick();
    const escRows = await escalationRowsFor("worker@r");
    expect(escRows).toHaveLength(1); // 五条独立 escalation 是 RED
    for (const b of batons) expect(escRows[0]!.body).toContain(b.qitemId);
    await tick(); // 重新检测会 refresh aggregate
    expect(await escalationRowsFor("worker@r")).toHaveLength(1);
    const refreshNotes = db
      .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?")
      .all(escRows[0]!.qitemId) as Array<{ transition_note: string | null }>;
    expect(refreshNotes.some((n) => /refresh/i.test(n.transition_note ?? ""))).toBe(false);
  });

  it("DESTINATION 限速：跨所有 ladder 发往同一 destination 的 wake attempt 保持在 per-window 上限内", async () => {
    for (let i = 0; i < 5; i++) {
      const b = await mkBaton();
      setNudgeResult(b.qitemId, "failed:tmux session not found", 60);
    }
    await tick();
    const toWorker = calls.filter((c) => c.target === "worker@r");
    expect(toWorker.length).toBeLessThanOrEqual(3); // cap 同时是 per-destination window 上限
    expect(toWorker.length).toBeGreaterThan(0);
  });

  // ── G6：F4——RUNG 执行 DELIVERY 并推进 ────────────────────────────────────────

  it("RUNG 失败后推进：orchestrator-rung wake 失败会推进到 operator rung——有记录、有界、无循环——并诚实说明带 S11 引用的 operator floor", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    outcomes["orch@r"] = "failed:tmux session not found"; // orchestrator rung 自身的 wake 失败
    await tick(); // orchestrator rung（失败）
    ageMarkers(baton.qitemId, 30);
    await tick(); // 推进到 operator rung
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs).toHaveLength(2);
    expect(rungs[0]).toMatch(/orchestrator/);
    expect(rungs[1]).toMatch(/operator/);
    expect(rungs[1]).toMatch(/escalation view/i); // 如实说明 floor
    // OPR.0.5.6.1 fixture update（已列举）：S11 cited-not-built pointer 已退役——此 fixture 未接入
    // engine port，因此 marker 会如实说明未接线的 floor，而非引用未来 slice。
    expect(rungs[1]).toMatch(/delivery engine not wired/);
    expect(markersOf(baton.qitemId, LADDER_EXHAUSTED_PREFIX)).toHaveLength(1); // 有限——ladder 到此结束
    const before = calls.length;
    ageMarkers(baton.qitemId, 30);
    await tick(); // 无循环：exhausted ladder 永不再次触发
    expect(calls.length).toBe(before);
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX)).toHaveLength(2);
  });

  it("DELIVERED ESCALATION 完成 LADDER：orchestrator wake 成功后 ladder 结束，不进入 operator rung", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    outcomes["orch@r"] = "verified";
    await tick();
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX)).toHaveLength(1);
    expect(markersOf(baton.qitemId, LADDER_EXHAUSTED_PREFIX)).toHaveLength(1);
    expect(markersOf(baton.qitemId, LADDER_EXHAUSTED_PREFIX)[0]).toMatch(/delivered/i);
  });

  it("RUNG 1 自行跳过：orchestrator 解析为 destination 自身时，ladder 直接进入 operator rung", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    await tick({ resolveOrchestrator: () => "worker@r" }); // 解析为 destination 自身
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs.some((r) => /orchestrator/.test(r) && /self-skip/i.test(r))).toBe(true);
    expect(rungs.some((r) => /operator/.test(r))).toBe(true);
    expect(calls.some((c) => c.target === "worker@r")).toBe(false); // 绝不向失效 seat escalate
  });

  // ── G7：F5——S02 接缝保持成立 ──────────────────────────────────────────────────

  it("接缝（live ladder）：处于 live ladder 下的 baton 不产生 S02 undelivered finding", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 10);
    await tick(); // 一个 attempt marker → live ladder
    await runStuckSweep({
      db,
      queueRepo: repo,
      status: createStuckSweepStatus(),
      resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60,
      log: () => {},
    });
    const findings = repo.list({ limit: 500 }).filter((i) => (i.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG));
    expect(findings.filter((f) => (f.tags ?? []).some((t) => t.endsWith(`:${baton.qitemId}`)))).toHaveLength(0);
  });

  it("接缝：exhaustion 后由已有 aggregate 负责 recovery；两次 sweep 不再创建 obligation", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    outcomes["orch@r"] = "failed:tmux session not found";
    await tick(); // orchestrator rung 失败
    ageMarkers(baton.qitemId, 30);
    await tick(); // operator rung + exhausted
    const sweep = () =>
      runStuckSweep({
        db,
        queueRepo: repo,
        status: createStuckSweepStatus(),
        resolveOrchestrator: () => null,
        unclaimedAgeMinutes: 60,
        log: () => {},
      });
    await sweep();
    await sweep();
    const findings = repo
      .list({ limit: 500 })
      .filter(
        (i) =>
          (i.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG) &&
          (i.tags ?? []).some((t) => t.endsWith(`:${baton.qitemId}`)),
      );
    expect(findings).toHaveLength(0);
    expect(await escalationRowsFor("worker@r")).toHaveLength(1);
  });

  // ── G8：F6——LADDER 通过派生跨越 RESTART ───────────────────────────────────────

  it("RESTART 保留计数：两次已记录 attempt 跨越 restart——下一次为 3/3，绝不是 1/3（reset-count RED）", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 60);
    await tick();
    ageMarkers(baton.qitemId, 10);
    await tick();
    // “Restart”：tick 不持有任何内存——一切都从 transition 派生。
    ageMarkers(baton.qitemId, 10);
    await tick();
    const attempts = markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]).toMatch(/3\/3/);
  });

  it("RESTART 保留 RUNG：已记录的 orchestrator rung 跨越 restart——ladder 推进到 operator，绝不遗忘（forgotten-ladder RED）", async () => {
    const baton = await mkBaton();
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    repo.transitionLog.append({
      qitemId: baton.qitemId,
      state: "pending",
      actorSession: "wake-ladder@system",
      transitionNote: `${LADDER_RUNG_PREFIX} orchestrator -> orch@r outcome=failed:tmux session not found reason=wake failed 3 times over 45 min`,
    });
    ageMarkers(baton.qitemId, 30);
    await tick(); // 重新派生：必须推进到 operator，而非重启 retry
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(3); // 无新 attempt
    const rungs = markersOf(baton.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs).toHaveLength(2);
    expect(rungs[1]).toMatch(/operator/);
  });

  // ── S16——PROVIDER LIMIT 共用一个 TIMER 停放 ─────────────────────────────────

  it("USAGE LIMIT 抑制错误 RUNG：三个 Claude seat 共用一个 blocker timer，不执行 retry/escalation attempt", async () => {
    const now = new Date();
    const reset = new Date(now.getTime() + 15 * 60_000).toISOString();
    const staleAfter = new Date(now.getTime() + 30 * 60_000).toISOString();
    const jobs = new WatchdogJobsRepository(db, () => now);
    repo.attachWatchdogJobsRepository(jobs);
    const batons = await Promise.all([
      mkBaton("dev-a@r"),
      mkBaton("dev-b@r"),
      mkBaton("dev-c@r"),
    ]);
    for (const baton of batons) setNudgeResult(baton.qitemId, "failed:provider usage limit", 10);

    const result = await tick({
      now,
      usageLimitJitterSeconds: 0,
      getProviderReadModel: async () => ({
        bindings: [],
        signals: ["dev-a@r", "dev-b@r", "dev-c@r"].map((seatSession, index) => ({
          provider: "claude" as const,
          seatSession,
          sourceClass: "provider_statusline" as const,
          authority: "account_cross_device" as const,
          window: "five_hour",
          usedPercent: index === 0 ? 100 : 75,
          resetsAt: reset,
          asOf: now.toISOString(),
          staleAfter,
          supportsNotification: false,
          automationUse: "allow_switch_decision" as const,
        })),
      }),
    });

    expect(calls).toEqual([]);
    expect(result.actions).toHaveLength(3);
    expect(result.actions.every((action) => action.action === "park-usage-limit")).toBe(true);
    const blockers = repo.list({ limit: 500 }).filter((row) => row.tags?.includes(USAGE_LIMIT_BLOCKER_TAG));
    expect(blockers).toHaveLength(1);
    expect(batons.map((row) => repo.getById(row.qitemId)?.state)).toEqual(["blocked", "blocked", "blocked"]);
    expect(new Set(batons.map((row) => repo.getById(row.qitemId)?.blockedOn))).toEqual(new Set([blockers[0]!.qitemId]));
    expect((db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs WHERE state = 'active'").get() as { n: number }).n).toBe(1);
    for (const baton of batons) {
      expect(repo.getParkWakeStatus(baton.qitemId)).toMatchObject({
        kind: "blocker",
        ref: blockers[0]!.qitemId,
        live: true,
        expiresAt: reset,
      });
    }

    await tick({
      now,
      usageLimitJitterSeconds: 0,
      getProviderReadModel: async () => ({ bindings: [], signals: [] }),
    });
    expect(repo.list({ limit: 500 }).filter((row) => row.tags?.includes(USAGE_LIMIT_BLOCKER_TAG))).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("过期 WAKE 失败后，在 provider reset 之后恢复已交付的 ladder", async () => {
    const now = new Date();
    const resetDate = new Date(now.getTime() + 60_000);
    const reset = resetDate.toISOString();
    const staleAfter = new Date(now.getTime() + 5 * 60_000).toISOString();
    const jobs = new WatchdogJobsRepository(db, () => now);
    repo.attachWatchdogJobsRepository(jobs);
    repo.attachOutbox(new OutboxHandler(db));
    repo.attachTransport({
      async send() {
        return { ok: false, error: "still usage-limited" };
      },
    });
    const baton = await mkBaton("dev-a@r");
    setNudgeResult(baton.qitemId, "failed:provider usage limit", 10);
    const model = {
      bindings: [],
      signals: [{
        provider: "claude" as const,
        seatSession: "dev-a@r",
        sourceClass: "provider_statusline" as const,
        authority: "account_cross_device" as const,
        window: "five_hour",
        usedPercent: 100,
        resetsAt: reset,
        asOf: now.toISOString(),
        staleAfter,
        supportsNotification: false,
        automationUse: "allow_switch_decision" as const,
      }],
    };

    await tick({
      now,
      usageLimitJitterSeconds: 0,
      getProviderReadModel: async () => model,
    });
    const blockerId = repo.getById(baton.qitemId)?.blockedOn;
    const timerId = blockerId ? repo.getParkWakeStatus(blockerId)?.ref : undefined;
    expect(timerId).toBeTruthy();

    repo.recordWatchdogWakeAttempt(timerId!, "failed:synthetic timer target");
    await repo.drainPendingWakeIntents();
    expect(repo.getById(baton.qitemId)).toMatchObject({
      state: "pending",
      lastNudgeResult: "failed:still usage-limited",
    });

    const afterReset = new Date(resetDate.getTime() + 6 * 60_000);
    await tick({
      now: afterReset,
      usageLimitJitterSeconds: 0,
      getProviderReadModel: async () => model,
    });
    expect(calls).toEqual([{ qitemId: baton.qitemId, target: "dev-a@r" }]);
    expect(markersOf(baton.qitemId, LADDER_ATTEMPT_PREFIX)).toHaveLength(1);
  });

  it("UNKNOWN 保持 UNKNOWN：无法解析的 provider evidence 原样走已交付 retry 路径", async () => {
    const baton = await mkBaton("dev-unknown@r");
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 10);
    await tick({
      getProviderReadModel: async () => ({
        bindings: [],
        signals: [{
          provider: "claude" as const,
          seatSession: "dev-unknown@r",
          sourceClass: "unknown" as const,
          authority: "unknown" as const,
          asOf: new Date().toISOString(),
          unknownReason: "no reset fidelity",
          automationUse: "do_not_automate" as const,
        }],
      }),
    });

    expect(calls).toEqual([{ qitemId: baton.qitemId, target: "dev-unknown@r" }]);
    expect(repo.getById(baton.qitemId)?.state).toBe("pending");
  });

  // ── Production identity 解析（修复轮次：review-r2 NOT-CLEAR）──────────────────

  it("默认 ORCHESTRATOR 解析：production identity 形态通过 session binding 解析——点号 logical id、短横线 canonical session，不做字符串派生", async () => {
    // live fleet 形态：`orch-lead@r` 绑定 logical_id 为 `orch.lead` 的 node。
    const orchNode = bindSeat("orch-lead@r", "orch.lead");
    const workerNode = bindSeat("worker-b2@r", "worker.b2");
    db.prepare(
      "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('e1', 'rig-r', ?, ?, 'delegates_to')",
    ).run(orchNode, workerNode);
    const row = await mkBaton("worker-b2@r");
    setNudgeResult(row.qitemId, "failed:tmux session not found", 120);
    // 超过 cap，使 escalation 通过默认 resolver 解析 orchestrator。
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: row.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(row.qitemId, 30);
    await tick({ resolveOrchestrator: undefined }); // 覆盖默认实现
    const escRows = await escalationRowsFor("worker-b2@r");
    expect(escRows).toHaveLength(1);
    // parent 当前的 canonical session binding——绝不是合成的 logical_id@rig。
    expect(escRows[0]!.destinationSession).toBe("orch-lead@r");
    const rungs = markersOf(row.qitemId, LADDER_RUNG_PREFIX);
    expect(rungs.some((r) => /orchestrator -> orch-lead@r/.test(r))).toBe(true);
  });

  it("SELF-SKIP 可见（operator floor 端到端）：无 orchestrator 时，operator rung 生成 OPEN escalation row，并由 escalations view 与 health status 呈现", async () => {
    const baton = await mkBaton("worker-c3@r");
    bindSeat("worker-c3@r", "worker.c3"); // 已绑定 seat，但无 delegates_to parent
    setNudgeResult(baton.qitemId, "failed:tmux session not found", 120);
    for (let a = 1; a <= 3; a++) {
      repo.transitionLog.append({
        qitemId: baton.qitemId,
        state: "pending",
        actorSession: "wake-ladder@system",
        transitionNote: `${LADDER_ATTEMPT_PREFIX} ${a}/3 outcome=failed:tmux session not found`,
      });
    }
    ageMarkers(baton.qitemId, 30);
    const mod = await ladderMod();
    const status = mod.createWakeLadderStatus();
    await tick({ resolveOrchestrator: undefined, status });
    // rung 已记录，ladder 已结束……
    expect(markersOf(baton.qitemId, LADDER_RUNG_PREFIX).some((r) => /operator/.test(r))).toBe(true);
    expect(markersOf(baton.qitemId, LADDER_EXHAUSTED_PREFIX)).toHaveLength(1);
    // ……且 escalation OBJECT 存在：一个 open row，可在两个 floor surface 上看到。
    const escRows = await escalationRowsFor("worker-c3@r");
    expect(escRows).toHaveLength(1);
    expect(escRows[0]!.state).toBe("pending");
    expect(escRows[0]!.destinationSession).not.toBe("worker-c3@r"); // 绝不发向失效 seat
    const view = new ViewProjector(db).show("escalations");
    expect(view.rows.map((r) => r.qitem_id)).toContain(escRows[0]!.qitemId);
    expect(status.snapshot().escalationsOpen).toBeGreaterThanOrEqual(1);
  });

  // ── Config surface ───────────────────────────────────────────────────────────

  it("FOUNDING 默认值：retry cadence 300 秒、cap 3、unconfirmed window 30 分钟、swap grace 180 秒——daemon store 与 module 常量一致", async () => {
    const mod = await ladderMod();
    expect(mod.DEFAULT_WAKE_RETRY_INTERVAL_SECONDS).toBe(300);
    expect(mod.DEFAULT_WAKE_RETRY_CAP).toBe(3);
    expect(mod.DEFAULT_WAKE_UNCONFIRMED_WINDOW_MINUTES).toBe(30);
    expect(mod.DEFAULT_WAKE_SWAP_GRACE_SECONDS).toBe(180);
    expect(mod.drawUsageLimitJitterSeconds(() => 0)).toBe(30);
    expect(mod.drawUsageLimitJitterSeconds(() => 0.999_999)).toBe(90);
    const missingConfig = `/tmp/openrig-s01-missing-${process.pid}-${Date.now()}.json`;
    const store = new SettingsStore(missingConfig);
    expect(store.resolveOne("queue.wake_retry_interval_seconds" as never)).toMatchObject({ value: 300, source: "default" });
    expect(store.resolveOne("queue.wake_retry_cap" as never)).toMatchObject({ value: 3, source: "default" });
    expect(store.resolveOne("queue.wake_unconfirmed_window_minutes" as never)).toMatchObject({ value: 30, source: "default" });
    expect(store.resolveOne("queue.wake_swap_grace_seconds" as never)).toMatchObject({ value: 180, source: "default" });
  });
});
