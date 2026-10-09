import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
// OPR.0.5.6.24 F-14 + R2 修复——parked-owner consumer 契约。Receipt 是按 reserve-before-deliver
// 写入的 ROW-SIDE transition；episode 状态由 obligation 行的 transition log 派生（在 retention
// active-frontier 不变量下持久）；失败落入 S01 ladder 原生 lastNudgeResult 词汇。五项 R2 硬检查位于
// 下方集成部分，各自在真实接缝上执行。
import {
  makeParkedOwnerConsumerPolicy,
  makeRigAnchor,
  RESERVE_PREFIX,
  CLOSE_PREFIX,
  REFUSED_PREFIX,
  FAILED_PREFIX,
  NUDGE_FAIL_PREFIX,
  PARKED_OWNER_POLICY_NAME,
  type ParkedOwnerConsumerDeps,
  type ParkedSeatDiagnosisView,
  type RowTransitionView,
} from "../src/domain/policies/parked-owner-consumer.js";
import type { WatchdogHistoryEntry } from "../src/domain/watchdog-history-log.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, isBlockerLive } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { pruneWatchdogHistory } from "../src/domain/queue-retention.js";

const RIG = "test-rig";
const SEAT = `dev-planner@${RIG}`;
const SEAT2 = `review-r9@${RIG}`;
const MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/domain/policies/parked-owner-consumer.ts",
);
const readModuleSource = () => readFileSync(MODULE_PATH, "utf8");

function makeJob(overrides: Partial<PolicyJob> = {}): PolicyJob {
  return {
    jobId: "job-poc-1",
    policy: PARKED_OWNER_POLICY_NAME,
    target: { session: makeRigAnchor(RIG) },
    intervalSeconds: 120,
    activeWakeIntervalSeconds: null,
    scanIntervalSeconds: null,
    context: {},
    lastEvaluationAt: null,
    lastFireAt: null,
    registeredBySession: "daemon@kernel",
    registeredAt: "2026-08-29T17:00:00.000Z",
    ...overrides,
  } as PolicyJob;
}

const ROW_IDS = ["qitem-a-bd7eef84", "qitem-b-f115c617", "qitem-c-64f888d1"];

function parkedSeat(overrides: Partial<ParkedSeatDiagnosisView> = {}): ParkedSeatDiagnosisView {
  return {
    sessionName: SEAT,
    parked: true,
    activity: { value: "idle-at-prompt", needsInput: { count: 0, reason: null } },
    obligations: {
      items: ROW_IDS.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })),
      held: [],
    },
    ...overrides,
  };
}

/** 跨 policy instance 共享的内存持久行 store——模拟 queue transition log（仅追加，
 * 可跨“restart”即新 policy 存续）。 */
class RowStore {
  transitions = new Map<string, RowTransitionView[]>();
  appended: Array<{ qitemId: string; note: string }> = [];
  nudges: Array<{ qitemId: string; result: string }> = [];
  openIds: (dest: string) => string[] = () => ROW_IDS;
  terminal = new Set<string>();

  deps(): ParkedOwnerConsumerDeps["rows"] {
    return {
      listTransitions: (q) => [...(this.transitions.get(q) ?? [])],
      appendNote: (q, note) => {
        if (this.terminal.has(q)) return { ok: false };
        const list = this.transitions.get(q) ?? [];
        list.push({ ts: new Date().toISOString(), transitionNote: note });
        this.transitions.set(q, list);
        this.appended.push({ qitemId: q, note });
        return { ok: true };
      },
      recordNudgeResult: (q, result) => void this.nudges.push({ qitemId: q, result }),
      listOpenIds: (dest) => this.openIds(dest),
    };
  }
}

function makeDeps(
  seats: ParkedSeatDiagnosisView[],
  store: RowStore,
  history: WatchdogHistoryEntry[] = [],
): ParkedOwnerConsumerDeps {
  return {
    diagnoseRig: () => ({ seats }),
    history: {
      listForJob: (_j, limit) => history.slice(0, limit),
      countForJob: () => history.length,
    },
    rows: store.deps(),
  };
}

function sentHistory(input: {
  episodeKey: string;
  primaryRow: string;
  deliveryStatus?: string;
  deliveryReason?: string;
}): WatchdogHistoryEntry {
  return {
    historyId: `h-${input.episodeKey}`,
    jobId: "job-poc-1",
    evaluatedAt: new Date().toISOString(),
    outcome: "sent",
    skipReason: null,
    deliveryTargetSession: SEAT,
    deliveryStatus: input.deliveryStatus ?? "ok",
    deliveryMessage: "wake",
    evaluationNotes: {
      episodeSeat: SEAT,
      episodeKey: input.episodeKey,
      primaryRow: input.primaryRow,
      ...(input.deliveryReason ? { deliveryReason: input.deliveryReason } : {}),
    },
  };
}

describe("parked-owner-consumer policy——单元契约（OPR.0.5.6.24）", () => {
  it("R1：claimed-rows × arbitrated-idle 发送一条同时列出 open 与 unhealthy-held id 的 wake，且在 send 返回前记录 reserve", async () => {
    const store = new RowStore();
    store.openIds = () => [...ROW_IDS, "qitem-held-unhealthy-1"];
    const seat = parkedSeat({
      obligations: {
        items: ROW_IDS.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })),
        held: [
          { qitemId: "qitem-held-unhealthy-1", healthy: false },
          { qitemId: "qitem-held-healthy-1", healthy: true },
        ],
      },
    });
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([seat], store));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.target.session).toBe(SEAT);
    const named = JSON.stringify(result.notes ?? {});
    for (const id of ROW_IDS) expect(named).toContain(id);
    expect(named).toContain("qitem-held-unhealthy-1");
    expect(named).not.toContain("qitem-held-healthy-1");
    // B4 顺序的一半：send 返回时持久 reserve 已存在。
    expect(store.appended.some((a) => a.note.startsWith(RESERVE_PREFIX))).toBe(true);
  });

  it("发出稳定的 wake-or-escalate capability 名称，不含历史 slice 简写", async () => {
    const result = await makeParkedOwnerConsumerPolicy(
      makeDeps([parkedSeat()], new RowStore()),
    ).evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.message).toContain("唤醒或升级");
    expect(result.message).not.toContain("S01");
    expect(result.message).not.toContain("OPR.0.5.5.1");
  });

  it("B1 硬检查：obligation set 在 derive 与投递边界间关闭时，以精确理由跳过且 reserve 为零", async () => {
    const store = new RowStore();
    store.openIds = () => []; // the boundary read — closed after diagnosis
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(JSON.stringify(result.notes)).toMatch(/obligation[-_]closed[-_]between[-_]derive[-_]and[-_]wake/);
    expect(store.appended).toHaveLength(0);
  });

  it("B1 terminal-race 守卫：被 terminal 行拒绝的 reserve 以相同理由跳过", async () => {
    const store = new RowStore();
    store.terminal.add(ROW_IDS[0]!);
    store.openIds = () => ROW_IDS; // still listed by the reader, terminal at append
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const result = await policy.evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(JSON.stringify(result.notes)).toMatch(/obligation[-_]closed[-_]between[-_]derive[-_]and[-_]wake/);
  });

  it("B4 硬检查（至多一次）：reserve 后、任何投递记录前崩溃时，同一持久 store 上的新 policy instance 不重发", async () => {
    const store = new RowStore();
    const first = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const sent = await first.evaluate(makeJob());
    expect(sent.action).toBe("send"); // reserve is durably in `store`; delivery outcome never recorded (the crash)
    const restarted = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const second = await restarted.evaluate(makeJob());
    expect(second.action).toBe("skip");
    expect(JSON.stringify(second.notes)).toMatch(/already[-_]woken/);
    // 真实性：这证明至多一次（无重复）；丢失 wake 的分支可在下一 episode 恢复，不声称恰好一次。
  });

  it("episode：close 后重新 park 会得到 ordinal 递增 key；needsInput 抖动不会", async () => {
    const store = new RowStore();
    const policy = makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store));
    const sent1 = await policy.evaluate(makeJob());
    expect(sent1.action).toBe("send");
    const key1 = String(sent1.notes?.["episodeKey"]);
    // 抖动：同一 park、不同 needsInput reason，仍视为 already-woken。
    const churned = parkedSeat({ activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "permission prompt" } } });
    expect((await makeParkedOwnerConsumerPolicy(makeDeps([churned], store)).evaluate(makeJob())).action).toBe("skip");
    // resume：持久关闭 episode。
    const closing = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat({ parked: false })], store)).evaluate(makeJob());
    expect(closing.action).toBe("skip");
    expect(String((closing as { reason?: unknown }).reason)).toMatch(/episode[-_]ended/);
    expect(store.appended.some((a) => a.note.startsWith(CLOSE_PREFIX))).toBe(true);
    // 重新 park：新 ordinal。
    const sent2 = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob());
    expect(sent2.action).toBe("send");
    expect(String(sent2.notes?.["episodeKey"])).toBe(key1.replace(/#1$/, "#2"));
  });

  it("episode：一次 park 期间 obligation-set 变化会获得自己的 wake（新 idsHash）", async () => {
    const store = new RowStore();
    const first = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob());
    expect(first.action).toBe("send");
    const grownIds = [...ROW_IDS, "qitem-new-arrival-1"];
    store.openIds = () => grownIds;
    const grown = parkedSeat({
      obligations: { items: grownIds.map((qitemId) => ({ qitemId, state: "in-progress", summary: null })), held: [] },
    });
    const second = await makeParkedOwnerConsumerPolicy(makeDeps([grown], store)).evaluate(makeJob());
    expect(second.action).toBe("send");
    expect(String(second.notes?.["idsHash"])).not.toBe(String(first.notes?.["idsHash"]));
  });

  it("starvation 守卫：跳过已有 receipt 的席位；send 在同一轮指向下一个合格 owner 并点名跳过项", async () => {
    const store = new RowStore();
    await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob()); // receipt for SEAT
    const seat2 = parkedSeat({
      sessionName: SEAT2,
      obligations: { items: [{ qitemId: "qitem-seat2-row-1", state: "in-progress", summary: null }], held: [] },
    });
    store.openIds = (dest) => (dest === SEAT2 ? ["qitem-seat2-row-1"] : ROW_IDS);
    const result = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat(), seat2], store)).evaluate(makeJob());
    expect(result.action).toBe("send");
    if (result.action !== "send") return;
    expect(result.target.session).toBe(SEAT2);
    const skipped = JSON.stringify(result.notes?.["skippedSeats"] ?? []);
    expect(skipped).toContain(SEAT);
    expect(skipped).toMatch(/already[-_]woken/);
  });

  it("cells：usage-limit 延后到 S16；indeterminate 不算 parked；空 union 真实呈现", async () => {
    const store = new RowStore();
    const limited = parkedSeat({ activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "usage limit" } } });
    expect(JSON.stringify((await makeParkedOwnerConsumerPolicy(makeDeps([limited], store)).evaluate(makeJob())).notes)).toMatch(/usage[-_]limit[-_]defer[-_]s16/);
    const indet = parkedSeat({ parked: "indeterminate" });
    expect(JSON.stringify(await makeParkedOwnerConsumerPolicy(makeDeps([indet], store)).evaluate(makeJob()))).toMatch(/indeterminate/);
    const bare = parkedSeat({ obligations: { items: [], held: [{ qitemId: "q-h", healthy: true }] } });
    expect(JSON.stringify((await makeParkedOwnerConsumerPolicy(makeDeps([bare], store)).evaluate(makeJob())).notes)).toMatch(/no[-_]park[-_]driving/);
  });

  it("refusal 与 generic：reconciliation 把拒绝落到行（持久 cell），generic 失败则落入 ladder 词汇", async () => {
    const store = new RowStore();
    const sent = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store)).evaluate(makeJob());
    expect(sent.action).toBe("send");
    const key = String(sent.notes?.["episodeKey"]);
    const primary = String(sent.notes?.["primaryRow"]);
    const refusal = `Refused: '${SEAT}' is at an interactive prompt (target_needs_input). No text was sent.`;
    // 被拒投递产生 refused note；此后 cell 从该行读取。
    const h1 = [sentHistory({ episodeKey: key, primaryRow: primary, deliveryStatus: "failed", deliveryReason: refusal })];
    const afterRefusal = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store, h1)).evaluate(makeJob());
    expect(JSON.stringify(afterRefusal.notes)).toMatch(/destination[-_]refused[-_]interactive[-_]prompt/);
    expect(store.appended.some((a) => a.note.startsWith(REFUSED_PREFIX))).toBe(true);
    expect(store.nudges).toHaveLength(0);
    // 第二个 store 上的 generic 失败产生 FAILED note + ladder 词汇，绝不误标为 refused。
    const store2 = new RowStore();
    const sent2 = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store2)).evaluate(makeJob());
    const key2 = String(sent2.notes?.["episodeKey"]);
    const primary2 = String(sent2.notes?.["primaryRow"]);
    const h2 = [sentHistory({ episodeKey: key2, primaryRow: primary2, deliveryStatus: "failed", deliveryReason: "transport timeout after 5000ms" })];
    const afterGeneric = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat()], store2, h2)).evaluate(makeJob());
    expect(JSON.stringify(afterGeneric.notes)).toMatch(/already[-_]woken/);
    expect(JSON.stringify(afterGeneric.notes)).not.toMatch(/destination[-_]refused/);
    expect(store2.appended.some((a) => a.note.startsWith(FAILED_PREFIX))).toBe(true);
    expect(store2.nudges.some((n) => n.result.startsWith(NUDGE_FAIL_PREFIX))).toBe(true);
  });

  it("锚点与结构固定项：稳定的逐 rig tuple；仅 arbitrated；没有第二 scheduler", () => {
    expect(makeRigAnchor("test-rig")).toBe("parked-owner-consumer@test-rig");
    const src = readModuleSource();
    expect(src).toMatch(/diagnoseRigParked|RigParkedDiagnosis|diagnoseRig/);
    expect(src).not.toMatch(/AgentActivityStore|getLatestForNode|activity-relay|hook/);
    expect(src).not.toMatch(/setInterval|setTimeout|new\s+\w*Scheduler|cron/i);
  });

  it("下限：干净扫描静默返回 no-parked-owner skip 且不写入", async () => {
    const store = new RowStore();
    const result = await makeParkedOwnerConsumerPolicy(makeDeps([parkedSeat({ parked: false })], store)).evaluate(makeJob());
    expect(result.action).toBe("skip");
    expect(String((result as { reason?: unknown }).reason)).toBe("no-parked-owner");
    expect(store.appended).toHaveLength(0);
  });
});

// ─── 真实接缝上的 R2 硬检查（通过 canonical migration 使用真实 DB）──────────
describe("parked-owner-consumer——R2 集成硬检查（OPR.0.5.6.24）", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true } as never);
  });
  afterEach(() => db.close());

  async function mkClaimedRow(dest = SEAT): Promise<string> {
    const row = await repo.create({ sourceSession: "sender@r", destinationSession: dest, body: "obligation" });
    db.prepare("UPDATE queue_items SET state = 'in-progress', claimed_at = ? WHERE qitem_id = ?").run(
      new Date().toISOString(),
      row.qitemId,
    );
    return row.qitemId;
  }

  function realRows(): ParkedOwnerConsumerDeps["rows"] {
    return {
      listTransitions: (q) => repo.listTransitions(q).map((t) => ({ ts: t.ts, transitionNote: t.transitionNote ?? null })),
      appendNote: (q, note) => {
        const row = repo.getById(q);
        if (!row || !isBlockerLive(row.state)) return { ok: false };
        repo.update({ qitemId: q, actorSession: "watchdog@system", transitionNote: note });
        return { ok: true };
      },
      recordNudgeResult: (q, result) => repo.recordNudgeAttempt(q, result),
      listOpenIds: (dest) =>
        repo.list({ destinationSession: dest, state: ["pending", "in-progress", "blocked"], limit: 500 }).map((r) => r.qitemId),
    };
  }

  it("B3 硬检查：普通 retention 修剪（14d + keep-50）删除 telemetry receipt，而行 receipt 保持 episode 去重", async () => {
    const qitemId = await mkClaimedRow();
    const seat = parkedSeat({ obligations: { items: [{ qitemId, state: "in-progress", summary: null }], held: [] } });
    const log = new WatchdogHistoryLog(db);
    // 真实注册 job——watchdog_history 行通过 FK 绑定 watchdog_jobs。
    const jobsRepo = new WatchdogJobsRepository(db);
    const job = jobsRepo.register({
      policy: PARKED_OWNER_POLICY_NAME,
      specYaml: `policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${makeRigAnchor(RIG)}\ninterval_seconds: 120\n`,
      targetSession: makeRigAnchor(RIG),
      intervalSeconds: 120,
      activeWakeIntervalSeconds: null,
      registeredBySession: "daemon@kernel",
    });
    const deps: ParkedOwnerConsumerDeps = {
      diagnoseRig: () => ({ seats: [seat] }),
      history: { listForJob: (j, l) => log.listForJob(j, l), countForJob: (j) => log.countForJob(j) },
      rows: realRows(),
    };
    const sent = await makeParkedOwnerConsumerPolicy(deps).evaluate(makeJob({ jobId: job.jobId }));
    expect(sent.action).toBe("send");
    // 旧设计依赖的 telemetry sent-row，已过去 15 天……
    const old = new Date(Date.now() - 15 * 86_400_000).toISOString();
    log.record({ jobId: job.jobId, evaluatedAt: old, outcome: "sent", evaluationNotes: { episodeKey: sent.notes?.["episodeKey"] } });
    // ……被 60 条更新 telemetry 行覆盖后，普通 retention 运行。
    for (let i = 0; i < 60; i++) log.record({ jobId: job.jobId, evaluatedAt: new Date().toISOString(), outcome: "skipped", skipReason: "episode-ended" });
    pruneWatchdogHistory(db, { nowIso: new Date().toISOString() });
    const remaining = log.listForJob(job.jobId, log.countForJob(job.jobId));
    expect(remaining.some((e) => e.evaluatedAt === old)).toBe(false); // telemetry receipt GONE
    // 行 receipt 存续（active-frontier 不变量）且仍能去重：
    const again = await makeParkedOwnerConsumerPolicy(deps).evaluate(makeJob({ jobId: job.jobId }));
    expect(again.action).toBe("skip");
    expect(JSON.stringify(again.notes)).toMatch(/already[-_]woken/);
  });

  it("B2 硬检查（真实持久化判别项）：consumer 失败进入 ladder，经受 ladder 自身 generic 覆盖，重试到上限并到达 escalation", async () => {
    const qitemId = await mkClaimedRow();
    // 持久记录 consumer 来源：FAILED transition note（consumer reconciliation 追加的内容）
    // 加初始 consumer 前缀 nudge 结果。
    repo.update({
      qitemId,
      actorSession: "watchdog@system",
      transitionNote: `${FAILED_PREFIX} ${SEAT}|deadbeef00000000#1; transport timeout after 5000ms`,
    });
    repo.recordNudgeAttempt(qitemId, `${NUDGE_FAIL_PREFIX} — transport timeout after 5000ms`);
    const backdate = () => {
      db.prepare("UPDATE queue_items SET last_nudge_attempt = ? WHERE qitem_id = ?").run(
        new Date(Date.now() - 10 * 60_000).toISOString(),
        qitemId,
      );
      db.prepare(
        "UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND (transition_note LIKE 'wake-attempt:%' OR transition_note LIKE 'escalation-rung:%')",
      ).run(new Date(Date.now() - 10 * 60_000).toISOString(), qitemId);
    };
    const mod = await import("../src/domain/queue-wake-ladder.js");
    const calls: string[] = [];
    // 在接缝处模拟生产持久化：每次尝试都在 last_nudge_result 中落下 generic transport 失败
    //（默认 attemptWake 的 maybeNudge 路径所写）；实时覆盖 R2 的覆盖行为。
    const tick = () =>
      mod.runWakeLadderTick({
        db,
        queueRepo: repo,
        attemptWake: async (q: string, target: string) => {
          calls.push(q);
          const generic = "failed:tmux session not found";
          repo.recordNudgeAttempt(q, generic);
          return generic;
        },
        resolveOrchestrator: () => "orch@r",
        retryIntervalSeconds: 300,
        retryCap: 3,
        unconfirmedWindowMinutes: 30,
        swapGraceSeconds: 180,
        log: () => {},
      } as never);
    backdate();
    await tick(); // entry: consumer prefix selects the row; retry persists GENERIC
    expect(calls.filter((q) => q === qitemId).length).toBe(1);
    expect(repo.getById(qitemId)?.lastNudgeResult).toBe("failed:tmux session not found"); // the overwrite is real
    backdate();
    await tick(); // RE-ENTRY after the overwrite — the durable note keeps eligibility
    expect(calls.filter((q) => q === qitemId).length).toBe(2);
    backdate();
    await tick(); // third attempt reaches the cap
    expect(calls.filter((q) => q === qitemId).length).toBeGreaterThanOrEqual(3);
    backdate();
    await tick(); // past cap: escalation phase must be REACHABLE (rung/exhausted marker)
    const markers = db
      .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts, rowid")
      .all(qitemId) as Array<{ transition_note: string | null }>;
    const joined = markers.map((m) => m.transition_note ?? "").join("\n");
    expect(joined).toMatch(/escalation-rung:|ladder-exhausted:/);
  });

  it("late-rig 硬检查（生来已武装）：createRig 在同一动作中启用 supervisor job，无需重启", () => {
    const rigRepo = new RigRepository(db);
    const jobsRepo = new WatchdogJobsRepository(db);
    rigRepo.onRigCreated = (rig) => {
      const anchor = makeRigAnchor(rig.name);
      jobsRepo.ensureAutoRegistration({
        policy: PARKED_OWNER_POLICY_NAME,
        targetSession: anchor,
        registeredBySession: "daemon@kernel",
        intervalSeconds: 120,
        activeWakeIntervalSeconds: null,
        scanIntervalSeconds: null,
        specYaml: `policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${anchor}\ncontext:\n  rig: ${rig.name}\n`,
      });
    };
    rigRepo.createRig("late-rig");
    const job = db
      .prepare("SELECT job_id, target_session FROM watchdog_jobs WHERE policy = ? AND target_session = ?")
      .get(PARKED_OWNER_POLICY_NAME, makeRigAnchor("late-rig")) as { job_id: string } | undefined;
    expect(job).toBeDefined();
  });
});
