import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { USAGE_LIMIT_BLOCKER_TAG } from "../src/domain/queue-wake-repository.js";
import { isDue } from "../src/domain/watchdog-scheduler.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";

// S03 R25 RED-FIRST fixture：这是 migration 073 将交付的 contract shape。
// 在 RED commit 中将 table 保持为本地定义，可让每项行为在旧基线上各自因 assertion 失败，
// 避免一个 module 缺失错误掩盖整组结果。
function createWakeContractTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE queue_transition_wakes (
      transition_id INTEGER PRIMARY KEY,
      qitem_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      wake_kind TEXT NOT NULL,
      wake_ref TEXT NOT NULL,
      delivery_status TEXT
    );
    CREATE INDEX idx_queue_transition_wakes_qitem
      ON queue_transition_wakes(qitem_id, transition_id);
    CREATE INDEX idx_queue_transition_wakes_ref
      ON queue_transition_wakes(wake_ref, phase);
  `);
}

describe("S03 R25——park 会在 append-only transition 上记录 wake", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let jobs: WatchdogJobsRepository;
  let sent: Array<{ session: string; text: string }>;
  let transportResult: Awaited<ReturnType<QueueNudgeTransport["send"]>>;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      outboxEntriesSchema,
      watchdogJobsSchema,
      watchdogHistorySchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
    ]);
    createWakeContractTable(db);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    repo.attachOutbox(new OutboxHandler(db));
    sent = [];
    transportResult = { ok: true, verified: true };
    repo.attachTransport({
      async send(session, text) {
        sent.push({ session, text });
        return transportResult;
      },
    });
    jobs = new WatchdogJobsRepository(db);
  });

  afterEach(() => db.close());

  async function item(destinationSession = "worker@rig") {
    return repo.create({ sourceSession: "orch@rig", destinationSession, body: "work", nudge: false });
  }

  function wakes(qitemId: string): Array<Record<string, unknown>> {
    return db.prepare(
      "SELECT transition_id, qitem_id, phase, wake_kind, wake_ref, delivery_status FROM queue_transition_wakes WHERE qitem_id = ? ORDER BY transition_id",
    ).all(qitemId) as Array<Record<string, unknown>>;
  }

  it("在 park transition 上记录现有 active watchdog id", async () => {
    const row = await item();
    const job = jobs.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: worker@rig\nmessage: resume\n",
      targetSession: "worker@rig",
      intervalSeconds: 60,
      registeredBySession: "orch@rig",
    });

    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:vendor-window",
      transitionNote: "continuation: resume when the vendor window opens",
      wakeWatchdogId: job.jobId,
    } as never);

    expect(wakes(row.qitemId)).toEqual([
      expect.objectContaining({ phase: "armed", wake_kind: "watchdog", wake_ref: job.jobId }),
    ]);
  });

  it("以原子方式启用 timer，并记录生成的 watchdog id", async () => {
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:cooldown",
      transitionNote: "continuation: retry after cooldown",
      wakeAfterSeconds: 90,
    } as never);

    const wake = wakes(row.qitemId)[0] as { wake_kind: string; wake_ref: string } | undefined;
    expect(wake?.wake_kind).toBe("timer");
    const job = wake ? jobs.getById(wake.wake_ref) : null;
    expect(job).toMatchObject({ state: "active", targetSession: "worker@rig", intervalSeconds: 90 });
    // 经 OPR.0.5.8.1 S1 修订。本测试主题——park 以原子方式启用 timer 并记录生成的 watchdog id——
    // 未改变，且仍由上方 assertion 固定。只有下面两行附带检查描述了缺陷行为：未初始化的
    // `last_evaluation_at` 会让 `isDue` 在注册时为 true，因此 90 秒 timer（与实测的 20 分钟和
    // 2 小时 timer 一样）会在 scheduler 首次遍历时触发。现在每个显式 `--wake-after` 都从注册时刻
    // 开始计时，与 provider-limit park 既有行为一致。
    expect(job?.lastEvaluationAt).toBe(job?.registeredAt);
    const armedAt = Date.parse(job!.registeredAt);
    expect(isDue(job!, armedAt)).toBe(false);              // 启用瞬间尚未到期
    expect(isDue(job!, armedAt + 89_999)).toBe(false);     // 也不会提前一个 tick 到期
    expect(isDue(job!, armedAt + 90_000)).toBe(true);      // 在请求的 90 秒时到期
    // 此项未改变且刻意保留 assertion：本次修复不会给普通 timer park 添加 expiry 字段
    //（不新增 per-wake bookkeeping）。
    expect(repo.getParkWakeStatus(row.qitemId)).not.toHaveProperty("expiresAt");
  });

  it("OPR.0.5.8.1 S1——两个显著不同的 --wake-after 时长不会收敛为同一延迟", async () => {
    // SPEC 自身的 contract line。通过真实 public seam 在基础 build 上测得：请求 20 分钟的任务
    // 在启用后 0.69 秒触发，请求 2 小时的任务在 0.77 秒触发——相差 6 倍的请求被压缩为共同的
    // 亚秒级延迟，因为 `isDue` 将没有 `last_evaluation_at` 的 job 视为到期。现在每个时长都必须
    // 相对各自的启用时刻计算。
    const short = await item("worker@rig");
    const long = await item("worker@rig");
    await repo.update({
      qitemId: short.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: short", wakeAfterSeconds: 120,
    } as never);
    await repo.update({
      qitemId: long.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: long", wakeAfterSeconds: 7200,
    } as never);

    const shortJob = jobs.getById((wakes(short.qitemId)[0] as { wake_ref: string }).wake_ref)!;
    const longJob = jobs.getById((wakes(long.qitemId)[0] as { wake_ref: string }).wake_ref)!;
    expect(shortJob.intervalSeconds).toBe(120);
    expect(longJob.intervalSeconds).toBe(7200);

    const shortArmed = Date.parse(shortJob.registeredAt);
    const longArmed = Date.parse(longJob.registeredAt);

    // 两者都不会在 scheduler 首次遍历时触发。
    expect(isDue(shortJob, shortArmed + 1_000)).toBe(false);
    expect(isDue(longJob, longArmed + 1_000)).toBe(false);

    // 两分钟时，短任务到期，长任务明确未到期：时长彼此区分，不再收敛。
    expect(isDue(shortJob, shortArmed + 120_000)).toBe(true);
    expect(isDue(longJob, longArmed + 120_000)).toBe(false);

    // 长任务只在自己请求的时刻到期。
    expect(isDue(longJob, longArmed + 7_199_999)).toBe(false);
    expect(isDue(longJob, longArmed + 7_200_000)).toBe(true);
  });

  it("OPR.0.5.8.1 S1b——park timer 是一次性的：触发即结束，不会二次 wake", async () => {
    // `periodic-reminder` 会永久按 intervalSeconds 重复。未停止的 park timer 因此会在第 2、
    // 第 3 个间隔及之后持续再次唤醒 owner。
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: one-shot", wakeAfterSeconds: 90,
    } as never);
    const ref = (wakes(row.qitemId)[0] as { wake_ref: string }).wake_ref;
    expect(jobs.getById(ref)!.state).toBe("active");

    repo.recordWatchdogWakeAttempt(ref, "verified");

    // 由触发本身终止，因此 scheduler 再也不会选中它。
    expect(jobs.getById(ref)!.state).not.toBe("active");
  });

  it("OPR.0.5.8.1 S1b——离开 park 会结束 timer：terminal row 不可被唤醒", async () => {
    // 样本：job 01M1E6F3QG41N76Y1CDX48P766 在 10:18:07Z 为一条 10:02:03Z 已 handed-off
    // 的 row 触发——它已 terminal 十六分钟，wake 却仍指示 seat 恢复。done 绝不能被读作欠办。
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: lifetime", wakeAfterSeconds: 7200,
    } as never);
    const ref = (wakes(row.qitemId)[0] as { wake_ref: string }).wake_ref;
    expect(jobs.getById(ref)!.state).toBe("active");

    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "done",
      closureReason: "no-follow-on", transitionNote: "row closed while parked",
    } as never);

    // park 结束时 timer 即消失——远早于其 2 小时到期时刻——因此无论怎样推进时钟，
    // 都不会为已关闭 row 产生 wake。
    expect(jobs.getById(ref)!.state).not.toBe("active");
    expect(repo.recordWatchdogWakeAttempt(ref, "verified")).toBeUndefined();
    expect(wakes(row.qitemId).some((w) => (w as { phase: string }).phase === "fired")).toBe(false);
  });

  it("OPR.0.5.8.1 S1c——绑定到 terminal row 的 legacy park timer 会在 transport 前被拒绝", async () => {
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: legacy timer", wakeAfterSeconds: 90,
    } as never);
    const timerId = (wakes(row.qitemId)[0] as { wake_ref: string }).wake_ref;

    // 精确模拟 legacy residue：旧 daemon 关闭 row 时未终止其生成的 timer。即使已没有新的
    // row transition 可拦截，当前 delivery seam 也必须防御这个持久化 preimage。
    db.prepare("UPDATE queue_items SET state = 'done', blocked_on = NULL WHERE qitem_id = ?").run(row.qitemId);
    expect(jobs.getById(timerId)?.state).toBe("active");

    const guardCalls: string[] = [];
    const deliveries: Array<{ targetSession: string; message: string }> = [];
    const engine = new WatchdogPolicyEngine({
      jobsRepo: jobs,
      historyLog: new WatchdogHistoryLog(db),
      eventBus: bus,
      deliver: async (request) => {
        deliveries.push(request);
        return { status: "ok" };
      },
      resolvePreDeliveryTerminalReason: ({ jobId }: { jobId: string }) => {
        guardCalls.push(jobId);
        return repo.resolveWatchdogPreDeliveryTerminalReason(jobId);
      },
      onWakeAttempt: ({ jobId, deliveryStatus }) => repo.recordWatchdogWakeAttempt(jobId, deliveryStatus),
    });

    const result = await engine.evaluate(jobs.getByIdOrThrow(timerId));

    expect(guardCalls).toEqual([timerId]);
    expect(deliveries).toEqual([]);
    expect(result.outcome).toEqual({ action: "terminal", reason: "park_timer_target_terminal" });
    expect(jobs.getById(timerId)).toMatchObject({
      state: "terminal",
      terminalReason: "park_timer_target_terminal",
    });
    expect(wakes(row.qitemId).some((w) => (w as { phase: string }).phase === "fired")).toBe(false);
  });

  it("OPR.0.5.8.1 S1c——delivery guard 保留可操作 timer 与附加 watchdog", async () => {
    const deliveries: Array<{ targetSession: string; message: string }> = [];
    const engine = new WatchdogPolicyEngine({
      jobsRepo: jobs,
      historyLog: new WatchdogHistoryLog(db),
      eventBus: bus,
      deliver: async (request) => {
        deliveries.push(request);
        return { status: "ok" };
      },
      resolvePreDeliveryTerminalReason: ({ jobId }) =>
        repo.resolveWatchdogPreDeliveryTerminalReason(jobId),
      onWakeAttempt: ({ jobId, deliveryStatus }) => repo.recordWatchdogWakeAttempt(jobId, deliveryStatus),
    });

    const timerRow = await item("timer-owner@rig");
    repo.update({
      qitemId: timerRow.qitemId, actorSession: "timer-owner@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: actionable", wakeAfterSeconds: 90,
    } as never);
    const timerId = (wakes(timerRow.qitemId)[0] as { wake_ref: string }).wake_ref;
    const timerResult = await engine.evaluate(jobs.getByIdOrThrow(timerId));

    expect(timerResult.outcome.action).toBe("send");
    expect(deliveries).toEqual([
      expect.objectContaining({ targetSession: "timer-owner@rig" }),
    ]);
    expect(wakes(timerRow.qitemId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "fired", wake_kind: "timer", wake_ref: timerId }),
    ]));

    const operatorJob = jobs.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: attached-owner@rig\nmessage: operator-owned\n",
      targetSession: "attached-owner@rig",
      intervalSeconds: 90,
      registeredBySession: "operator@rig",
    });
    const attachedRow = await item("attached-owner@rig");
    repo.update({
      qitemId: attachedRow.qitemId, actorSession: "attached-owner@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: attached watchdog",
      wakeWatchdogId: operatorJob.jobId,
    } as never);
    const attachedResult = await engine.evaluate(jobs.getByIdOrThrow(operatorJob.jobId));

    expect(attachedResult.outcome.action).toBe("send");
    expect(deliveries).toEqual([
      expect.objectContaining({ targetSession: "timer-owner@rig" }),
      expect.objectContaining({ targetSession: "attached-owner@rig" }),
    ]);
    expect(jobs.getById(operatorJob.jobId)?.state).toBe("active");
  });

  it("OPR.0.5.8.1 S1c——共享同一 job 时，terminal timer row 不得终止附加 watchdog", async () => {
    // ea0e80d2 的 R2 blocking finding。上方 control 使用两个不同 job id，无法覆盖真实交付组合：
    // --wake-watchdog 接受 target 匹配 parked owner 的任意 active job，包括另一条 row 的
    // --wake-after 刚创建的 job。随后两个 binding 都挂在同一个 wake_ref 上。timer lookup 只选择
    // wake_kind='timer'，所以 legacy-terminal timer row 会使 resolver 认领整个 job，engine 又会
    // 在 transport 前终止它，导致仍 blocked 的用户 attachment 永远无法 wake。
    const deliveries: Array<{ targetSession: string; message: string }> = [];
    const engine = new WatchdogPolicyEngine({
      jobsRepo: jobs,
      historyLog: new WatchdogHistoryLog(db),
      eventBus: bus,
      deliver: async (request) => {
        deliveries.push(request);
        return { status: "ok" };
      },
      resolvePreDeliveryTerminalReason: ({ jobId }) =>
        repo.resolveWatchdogPreDeliveryTerminalReason(jobId),
      onWakeAttempt: ({ jobId, deliveryStatus }) => repo.recordWatchdogWakeAttempt(jobId, deliveryStatus),
    });

    // Row A 使用 --wake-after park，产生 job J 与一个 timer binding。
    const timerRow = await item("shared-owner@rig");
    repo.update({
      qitemId: timerRow.qitemId, actorSession: "shared-owner@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: timer", wakeAfterSeconds: 90,
    } as never);
    const sharedJobId = (db.prepare(
      "SELECT wake_ref FROM queue_transition_wakes WHERE qitem_id = ? AND wake_kind = 'timer'",
    ).get(timerRow.qitemId) as { wake_ref: string }).wake_ref;

    // Row B 通过受支持的 --wake-watchdog 路径绑定同一个 job 并 park。
    const attachedRow = await item("shared-owner@rig");
    repo.update({
      qitemId: attachedRow.qitemId, actorSession: "shared-owner@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: attached watchdog",
      wakeWatchdogId: sharedJobId,
    } as never);

    // 精确构造 S1c 要防御的 legacy residue，方式与 R2 probe 相同：直接执行 SQL，刻意绕过
    // repo.update。通过正常路径关闭 row 会触发 S1b 的 transition-time retirement，不会留下可供
    // 防御的 residue——fixture 必须模拟没有该 hook 的旧 daemon。
    db.prepare("UPDATE queue_items SET state = 'done', blocked_on = NULL WHERE qitem_id = ?")
      .run(timerRow.qitemId);
    expect(repo.getById(attachedRow.qitemId)?.state).toBe("blocked");

    const result = await engine.evaluate(jobs.getByIdOrThrow(sharedJobId));

    // attachment 是可操作工作；job 必须存活并交付。
    expect(result.outcome).not.toMatchObject({ reason: "park_timer_target_terminal" });
    expect(result.outcome.action).toBe("send");
    expect(jobs.getById(sharedJobId)?.state).toBe("active");
    expect(deliveries).toEqual([
      expect.objectContaining({ targetSession: "shared-owner@rig" }),
    ]);
  });

  it("OPR.0.5.8.1 S1c——仅由 park 生成且绑定 terminal row 的 timer 仍会被拒绝", async () => {
    // ownership boundary 的另一面：增加 watchdog 检查不能解除 S1c 所保护的 guard。若没有
    // attachment 共享此 job，terminal timer row 仍会终止 legacy residue。
    const engine = new WatchdogPolicyEngine({
      jobsRepo: jobs,
      historyLog: new WatchdogHistoryLog(db),
      eventBus: bus,
      deliver: async () => ({ status: "ok" }),
      resolvePreDeliveryTerminalReason: ({ jobId }) =>
        repo.resolveWatchdogPreDeliveryTerminalReason(jobId),
      onWakeAttempt: ({ jobId, deliveryStatus }) => repo.recordWatchdogWakeAttempt(jobId, deliveryStatus),
    });

    const row = await item("lone-owner@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "lone-owner@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: timer", wakeAfterSeconds: 90,
    } as never);
    const jobId = (db.prepare(
      "SELECT wake_ref FROM queue_transition_wakes WHERE qitem_id = ? AND wake_kind = 'timer'",
    ).get(row.qitemId) as { wake_ref: string }).wake_ref;
    // 与上方相同的 legacy-residue shape，原因也相同。
    db.prepare("UPDATE queue_items SET state = 'done', blocked_on = NULL WHERE qitem_id = ?")
      .run(row.qitemId);

    const result = await engine.evaluate(jobs.getByIdOrThrow(jobId));

    expect(result.outcome).toMatchObject({ action: "terminal", reason: "park_timer_target_terminal" });
  });

  it("OPR.0.5.8.1 S1b——unpark（blocked -> in-progress）也会结束 timer", async () => {
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: unpark", wakeAfterSeconds: 7200,
    } as never);
    const ref = (wakes(row.qitemId)[0] as { wake_ref: string }).wake_ref;

    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "in-progress",
      transitionNote: "owner resumed the row itself",
    } as never);

    expect(jobs.getById(ref)!.state).not.toBe("active");
  });

  // --- OPR.0.5.8.1 S1b 修复（8dfe8a3a 上 review50-r2 NOT-CLEAR）---
  //
  // `queue_items.state` 由六个方法写入，而非一个。首次修复只接入通用 `update()` 路径，
  // 因此其他 writer 都让 timer 保持 active——包括原始样本实际经过的 `handoff()`。
  // 下方每个 exit 都通过其真实方法固定，而不是换一种方式调用 `update()`；后者正是
  // 首次未发现缺口的原因。

  async function parkedWithTimer(session = "worker@rig", seconds = 7200) {
    const row = await item(session);
    repo.update({
      qitemId: row.qitemId, actorSession: session, state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: parked", wakeAfterSeconds: seconds,
    } as never);
    const ref = (wakes(row.qitemId).at(-1) as { wake_ref: string }).wake_ref;
    expect(jobs.getById(ref)!.state).toBe("active");
    return { row, ref };
  }
  const terminalReason = (ref: string) =>
    (db.prepare("SELECT terminal_reason FROM watchdog_jobs WHERE job_id = ?")
      .get(ref) as { terminal_reason: string | null }).terminal_reason;

  it("OPR.0.5.8.1 S1b——handoff() 会终止 timer（原始样本自身的路径）", async () => {
    // Row b7a70333 在 10:02:03Z handed-off，其 timer 却在 10:18:07Z 触发。
    // handoff() 使用独立 transaction，从不经过 update()。
    const { row, ref } = await parkedWithTimer();

    await repo.handoff({
      qitemId: row.qitemId, fromSession: "worker@rig", toSession: "next@rig", nudge: false,
    } as never);

    expect(repo.getById(row.qitemId)!.state).toBe("handed-off");
    expect(jobs.getById(ref)!.state).not.toBe("active");
    expect(terminalReason(ref)).toBe("park_ended:handed-off");
  });

  it("OPR.0.5.8.1 S1b——handoffAndComplete() 会终止 timer", async () => {
    const { row, ref } = await parkedWithTimer();

    await repo.handoffAndComplete({
      qitemId: row.qitemId, fromSession: "worker@rig", toSession: "next@rig", nudge: false,
    } as never);

    expect(jobs.getById(ref)!.state).not.toBe("active");
    expect(terminalReason(ref)).toBe("park_ended:done");
  });

  it("OPR.0.5.8.1 S1b——closeCrossHostHandoffSource() 会终止 timer", async () => {
    // handoff family 的第三个成员。同样绕过通用路径并使用自己的 transaction；它是通过枚举
    // state writer 找到的，而不是由既有说明指出。
    const { row, ref } = await parkedWithTimer();

    repo.closeCrossHostHandoffSource({
      qitemId: row.qitemId,
      fromSession: "worker@rig",
      toSession: "next@rig",
      closureTarget: "qitem-remote-1@otherhost",
      terminalState: "handed-off",
    });

    expect(jobs.getById(ref)!.state).not.toBe("active");
    expect(terminalReason(ref)).toBe("park_ended:handed-off");
  });

  it("OPR.0.5.8.1 S1b——claim() 会终止 timer（contract 指定的 claim-resume）", async () => {
    // blocked row 可以被 claim，因此 claim 是直接写入 state 的真实 park exit。此前的 pin
    // 通过 update() 表达此行为，而非 claim()。
    const { row, ref } = await parkedWithTimer();

    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@rig" } as never);

    expect(repo.getById(row.qitemId)!.state).toBe("in-progress");
    expect(jobs.getById(ref)!.state).not.toBe("active");
    expect(terminalReason(ref)).toBe("park_ended:claimed");
  });

  it("OPR.0.5.8.1 S1b——blocker 完成时 auto-unpark 会终止 timer", async () => {
    // `--on X --wake-after 20m` 同时携带 blocker 与 timer。X 完成后 blocker 已发挥作用，
    // timer 不得再触发。
    const blocker = await item("gate@rig");
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: blocker.qitemId, transitionNote: "parked on a blocker AND a timer",
      wakeAfterSeconds: 7200,
    } as never);
    const ref = (wakes(row.qitemId).at(-1) as { wake_ref: string }).wake_ref;
    expect(jobs.getById(ref)!.state).toBe("active");

    repo.update({
      qitemId: blocker.qitemId, actorSession: "gate@rig", state: "done",
      closureReason: "no-follow-on", transitionNote: "blocker cleared",
    } as never);

    expect(repo.getById(row.qitemId)!.state).toBe("pending");   // auto-unparked
    expect(jobs.getById(ref)!.state).not.toBe("active");
    expect(terminalReason(ref)).toBe("park_ended:auto-unparked");
  });

  it("OPR.0.5.8.1 S1b——handoff exit 不会触碰用户附加的 watchdog", async () => {
    // 每个 exit caller 都使用共享 ownership predicate；本测试执行一条真实 handoff route，
    // 而非声称覆盖六条 route 的矩阵。
    const job = jobs.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: \"worker@rig\"\nmessage: \"operator's own\"\n",
      targetSession: "worker@rig", intervalSeconds: 600, registeredBySession: "operator@rig",
    });
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "park on operator watchdog",
      wakeWatchdogId: job.jobId,
    } as never);

    await repo.handoff({
      qitemId: row.qitemId, fromSession: "worker@rig", toSession: "next@rig", nudge: false,
    } as never);

    expect(jobs.getById(job.jobId)!.state).toBe("active");
  });

  it("OPR.0.5.8.1 S1b——再次 park 会取代旧 timer：恰好一个 live job", async () => {
    // 第三条重复路径。再次 park 过去会在首个 job 仍 active 时启用第二个 job，导致一条 row
    // 携带两个各自按节奏触发的 live timer。现在新的 park episode 会取代旧 episode。
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: first park", wakeAfterSeconds: 90,
    } as never);
    const first = (wakes(row.qitemId)[0] as { wake_ref: string }).wake_ref;
    expect(jobs.getById(first)!.state).toBe("active");

    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: re-park, longer", wakeAfterSeconds: 3600,
    } as never);
    const second = repo.getParkWakeStatus(row.qitemId)!.ref;
    expect(second).not.toBe(first);

    // 此 row 上恰好一个 live timer
    expect(jobs.getById(first)!.state).not.toBe("active");
    expect((db.prepare("SELECT terminal_reason FROM watchdog_jobs WHERE job_id = ?")
      .get(first) as { terminal_reason: string | null }).terminal_reason).toBe("park_superseded");
    expect(jobs.getById(second)!.state).toBe("active");

    // 幸存者从自己的启用时刻起，按自己的时长计算
    const secondJob = jobs.getById(second)!;
    expect(secondJob.intervalSeconds).toBe(3600);
    const armed = Date.parse(secondJob.registeredAt);
    expect(isDue(secondJob, armed + 90_000)).toBe(false);      // 不是旧的 90 秒
    expect(isDue(secondJob, armed + 3_599_999)).toBe(false);
    expect(isDue(secondJob, armed + 3_600_000)).toBe(true);
  });

  it("OPR.0.5.8.1 S1b——再次 park 不会触碰用户附加的 watchdog", async () => {
    const job = jobs.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: \"worker@rig\"\nmessage: \"operator's own\"\n",
      targetSession: "worker@rig",
      intervalSeconds: 600,
      registeredBySession: "operator@rig",
    });
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "park on operator watchdog",
      wakeWatchdogId: job.jobId,
    } as never);
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "re-park with a timer", wakeAfterSeconds: 90,
    } as never);

    expect(jobs.getById(job.jobId)!.state).toBe("active");   // 仍归用户所有
  });

  it("OPR.0.5.8.1 S1b——S16 provider-limit 路径保持不变且可区分", async () => {
    // Contract 第 3 项要求明确本修复是否影响 S16，并用测试固定结论。答案是不影响：
    // provider-limit timer 原本就会在触发后结束，并因自己的原因结束、执行自己的 blocker
    // resolution；普通 park timer 绝不能这样做。assert 具体 reason 而不只检查 "terminal"，
    // 能防止以后合并代码时混淆两条路径。
    const blocker = await repo.create({
      sourceSession: "wake-ladder@system",
      destinationSession: "wake-ladder@rig",
      body: "provider limit for one account pool",
      tags: [USAGE_LIMIT_BLOCKER_TAG, "usage-limit-pool:claude%3Alocal"],
      nudge: false,
    });
    repo.update({
      qitemId: blocker.qitemId, actorSession: "wake-ladder@system", state: "blocked",
      blockedOn: "external:provider-limit:claude:local",
      transitionNote: "usage-limit park until stated reset", wakeAfterSeconds: 60,
    } as never);
    const ref = repo.getParkWakeStatus(blocker.qitemId)!.ref;

    repo.recordWatchdogWakeAttempt(ref, "verified");

    const reason = (db.prepare("SELECT terminal_reason FROM watchdog_jobs WHERE job_id = ?")
      .get(ref) as { terminal_reason: string | null }).terminal_reason;
    expect(reason).toBe("usage_limit_expiry_fired");     // 不是 park_timer_fired_once
    expect(repo.getById(blocker.qitemId)!.state).toBe("done");  // 其 blocker resolution 仍执行
  });

  it("OPR.0.5.8.1 S1b——用户附加的 watchdog 会在 park 结束后继续存活", async () => {
    // 只有 park 生成的 timer 归 park 所有。用户通过 --wake-watchdog 附加的 job 归用户所有，
    // 可能指向其他 row，不得被此 row 的 lifecycle 销毁。
    const job = jobs.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: \"worker@rig\"\nmessage: \"operator's own\"\n",
      targetSession: "worker@rig",
      intervalSeconds: 600,
      registeredBySession: "operator@rig",
    });
    const row = await item("worker@rig");
    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "external:cooldown", transitionNote: "continuation: attached",
      wakeWatchdogId: job.jobId,
    } as never);
    expect(repo.getParkWakeStatus(row.qitemId)).toMatchObject({ kind: "watchdog", ref: job.jobId });

    repo.update({
      qitemId: row.qitemId, actorSession: "worker@rig", state: "done",
      closureReason: "no-follow-on", transitionNote: "row closed while parked",
    } as never);

    expect(jobs.getById(job.jobId)!.state).toBe("active");   // 仍归用户所有
  });

  it("park transaction 中止时回滚生成的 timer", async () => {
    const row = await item();
    db.exec(`
      CREATE TRIGGER reject_test_park BEFORE UPDATE OF state ON queue_items
      WHEN NEW.qitem_id = '${row.qitemId}'
      BEGIN SELECT RAISE(ABORT, 'forced park failure'); END;
    `);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs").get() as { n: number }).n;
    expect(() => repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:cooldown",
      transitionNote: "continuation: retry after cooldown",
      wakeAfterSeconds: 90,
    } as never)).toThrow(/forced park failure/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs").get() as { n: number }).n).toBe(before);
    expect(repo.getById(row.qitemId)?.state).toBe("pending");
    expect(wakes(row.qitemId)).toEqual([]);
  });

  it("auto-unpark 发布 dependent event，并记录真实的 commit 后 delivery outcome", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    const sibling = await item("worker-2@rig");
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after gate closes",
    });
    repo.update({
      qitemId: sibling.qitemId,
      actorSession: "worker-2@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: sibling resumes after gate closes",
    });

    expect(wakes(row.qitemId)).toEqual([
      expect.objectContaining({ phase: "armed", wake_kind: "blocker", wake_ref: blocker.qitemId }),
    ]);

    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));
    transportResult = { ok: false, error: "owner unreachable" };
    repo.update({
      qitemId: blocker.qitemId,
      actorSession: "gate@rig",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "gate cleared",
    });

    expect(repo.getById(row.qitemId)?.state).toBe("pending");
    expect(repo.getById(sibling.qitemId)?.state).toBe("pending");
    const updatedIds = received
      .filter((event) => event.type === "queue.updated")
      .map((event) => event.qitemId);
    expect(updatedIds).toHaveLength(3);
    expect(new Set(updatedIds)).toEqual(new Set([row.qitemId, sibling.qitemId, blocker.qitemId]));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(new Set(sent.map((call) => call.session))).toEqual(new Set(["worker@rig", "worker-2@rig"]));
    expect(sent.some((call) => call.text.includes(row.qitemId))).toBe(true);
    expect(sent.some((call) => call.text.includes(sibling.qitemId))).toBe(true);
    expect(repo.getById(row.qitemId)?.lastNudgeResult).toBe("failed:owner unreachable");
    expect(repo.getById(sibling.qitemId)?.lastNudgeResult).toBe("failed:owner unreachable");
    expect(wakes(row.qitemId).at(-1)).toMatchObject({
      phase: "fired",
      wake_kind: "blocker",
      wake_ref: blocker.qitemId,
      delivery_status: "failed:owner unreachable",
    });
    expect(wakes(sibling.qitemId).at(-1)).toMatchObject({
      phase: "fired",
      wake_kind: "blocker",
      wake_ref: blocker.qitemId,
      delivery_status: "failed:owner unreachable",
    });
    const intent = db.prepare(
      "SELECT COUNT(*) AS n FROM outbox_entries WHERE audit_pointer IN (?, ?) AND delivery_state = 'failed'",
    ).get(row.qitemId, sibling.qitemId) as { n: number };
    expect(intent.n).toBe(2);
  });

  it("外围 transaction 通过精确 notify envelope 发布每个 auto-unpark event", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after gate closes",
    });
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.withNotifyEnvelope((register) => {
      const result = repo.updateWithinTransaction({
        qitemId: blocker.qitemId,
        actorSession: "gate@rig",
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: "gate cleared transactionally",
      });
      register(result.persistedEvent);
    });

    expect(received.filter((event) => event.type === "queue.updated").map((event) => event.qitemId)).toEqual([
      row.qitemId,
      blocker.qitemId,
    ]);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it("回滚的 blocker completion 不留下 intent，也不执行 wake effect", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after gate closes",
    });

    expect(() => bus.withNotifyEnvelope((register) => {
      const result = repo.updateWithinTransaction({
        qitemId: blocker.qitemId,
        actorSession: "gate@rig",
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: "this whole transaction will abort",
      });
      register(result.persistedEvent);
      throw new Error("forced outer rollback");
    })).toThrow(/forced outer rollback/);

    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect(sent).toEqual([]);
    expect(repo.getById(blocker.qitemId)?.state).toBe("pending");
    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect((db.prepare("SELECT COUNT(*) AS n FROM outbox_entries").get() as { n: number }).n).toBe(0);
  });

  it("已提交的 auto-unpark intent 可在 transport 缺失时存留，recovery drain 会记录其交付", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after gate closes",
    });

    const recovering = new QueueRepository(db, bus);
    recovering.attachOutbox(new OutboxHandler(db));
    recovering.update({
      qitemId: blocker.qitemId,
      actorSession: "gate@rig",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "gate cleared while transport is absent",
    });
    await new Promise<void>((resolveDone) => setImmediate(resolveDone));
    expect(sent).toEqual([]);
    expect(db.prepare(
      "SELECT delivery_state FROM outbox_entries WHERE audit_pointer = ?",
    ).get(row.qitemId)).toMatchObject({ delivery_state: "pending" });
    expect(wakes(row.qitemId).at(-1)).toMatchObject({ phase: "armed", delivery_status: null });

    recovering.attachTransport({
      async send(session, text) {
        sent.push({ session, text });
        return { ok: true, verified: true };
      },
    });
    await expect(recovering.drainPendingWakeIntents()).resolves.toEqual({
      delivered: 1,
      indeterminate: 0,
      failed: 0,
      retained: 0,
    });
    expect(sent).toHaveLength(1);
    expect(wakes(row.qitemId).at(-1)).toMatchObject({
      phase: "fired",
      wake_kind: "blocker",
      wake_ref: blocker.qitemId,
      delivery_status: "verified",
    });
  });

  it("S16 将一个 provider-limit timer 解析为每个 dependent 恰好一次 durable wake", async () => {
    const blocker = await repo.create({
      sourceSession: "wake-ladder@system",
      destinationSession: "wake-ladder@rig",
      body: "provider limit for one account pool",
      tags: [USAGE_LIMIT_BLOCKER_TAG, "usage-limit-pool:claude%3Alocal"],
      nudge: false,
    });
    repo.update({
      qitemId: blocker.qitemId,
      actorSession: "wake-ladder@system",
      state: "blocked",
      blockedOn: "external:provider-limit:claude:local",
      transitionNote: "usage-limit park until stated reset",
      wakeAfterSeconds: 60,
    } as never);
    const timer = repo.getParkWakeStatus(blocker.qitemId)!;

    const dependents = await Promise.all([
      item("worker-1@rig"),
      item("worker-2@rig"),
      item("worker-3@rig"),
    ]);
    for (const dependent of dependents) {
      repo.update({
        qitemId: dependent.qitemId,
        actorSession: "wake-ladder@system",
        state: "blocked",
        blockedOn: blocker.qitemId,
        transitionNote: "usage-limit park on the shared provider/account timer",
      });
      expect(repo.getParkWakeStatus(dependent.qitemId)).toMatchObject({
        kind: "blocker",
        ref: blocker.qitemId,
        live: true,
        expiresAt: timer.expiresAt,
      });
    }

    repo.recordWatchdogWakeAttempt(timer.ref, "failed:synthetic timer target");
    await repo.drainPendingWakeIntents();

    expect(jobs.getById(timer.ref)?.state).toBe("terminal");
    expect(repo.getById(blocker.qitemId)?.state).toBe("done");
    expect(dependents.map((row) => repo.getById(row.qitemId)?.state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(sent.map((call) => call.session).sort()).toEqual([
      "worker-1@rig",
      "worker-2@rig",
      "worker-3@rig",
    ]);

    repo.recordWatchdogWakeAttempt(timer.ref, "failed:duplicate watchdog callback");
    await repo.drainPendingWakeIntents();
    expect(sent).toHaveLength(3);
  });

  it("S16 初始化 timer baseline，使其在预计到期时到期，而非立即到期", async () => {
    const blocker = await repo.create({
      sourceSession: "wake-ladder@system",
      destinationSession: "wake-ladder@rig",
      body: "provider limit for one account pool",
      tags: [USAGE_LIMIT_BLOCKER_TAG, "usage-limit-pool:claude%3Alocal"],
      nudge: false,
    });
    repo.update({
      qitemId: blocker.qitemId,
      actorSession: "wake-ladder@system",
      state: "blocked",
      blockedOn: "external:provider-limit:claude:local",
      transitionNote: "usage-limit park until stated reset",
      wakeAfterSeconds: 60,
    } as never);

    const timer = repo.getParkWakeStatus(blocker.qitemId)!;
    const job = jobs.getById(timer.ref)!;
    const registeredAt = Date.parse(job.registeredAt);
    expect(job.lastEvaluationAt).toBe(job.registeredAt);
    expect(timer.expiresAt).toBe(new Date(registeredAt + 60_000).toISOString());
    expect(repo.listTransitions(blocker.qitemId).find((transition) => transition.wake)?.wake)
      .toMatchObject({ expiresAt: timer.expiresAt });
    expect(isDue(job, registeredAt + 59_999)).toBe(false);
    expect(isDue(job, registeredAt + 60_000)).toBe(true);
  });

  it("普通 blocker wake 仍不带 expiry", async () => {
    const blocker = await item("gate@rig");
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
      transitionNote: "ordinary blocker",
    });

    expect(repo.getParkWakeStatus(row.qitemId)).toEqual(expect.objectContaining({
      kind: "blocker",
      ref: blocker.qitemId,
    }));
    expect(repo.getParkWakeStatus(row.qitemId)).not.toHaveProperty("expiresAt");
  });

  it("负向对照：不带 wake 的 park 仍成功，且不记录虚构 wake", async () => {
    const row = await item();
    const parked = repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:unknown",
      transitionNote: "legacy wakeless park",
    });
    expect(parked.state).toBe("blocked");
    expect(wakes(row.qitemId)).toEqual([]);
    expect(repo.getParkWakeStatus(row.qitemId)).toBeNull();

    const teaching = "`parked` 表示该记录已阻塞；请使用 `zrig parked` 诊断其 wake。";
    expect(teaching).toContain("该记录已阻塞");
    expect(teaching).toContain("`zrig parked`");
    expect(teaching).not.toContain("它携带 wake 并合理等待");
  });

  it("已触发 timer 追加 resume attempt；保持 blocked 会使其可观察地处于未消费状态", async () => {
    const row = await item();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "external:cooldown",
      transitionNote: "continuation: resume after cooldown",
      wakeAfterSeconds: 30,
    } as never);
    const timerId = String(wakes(row.qitemId)[0]?.wake_ref);

    (repo as unknown as { recordWatchdogWakeAttempt: (jobId: string, status: string) => void })
      .recordWatchdogWakeAttempt(timerId, "ok");

    expect(repo.getById(row.qitemId)?.state).toBe("blocked");
    expect(wakes(row.qitemId).at(-1)).toMatchObject({
      phase: "fired",
      wake_kind: "timer",
      wake_ref: timerId,
      delivery_status: "ok",
    });
    expect((repo as unknown as { getParkWakeStatus: (id: string) => { unconsumed: boolean } | null })
      .getParkWakeStatus(row.qitemId)?.unconsumed).toBe(true);
  });

  it("FR-6 负向对照：有效 human-seat park 仍要求并持久化 summary + evidence", async () => {
    const row = await item();
    const parked = repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@rig",
      state: "blocked",
      blockedOn: "human-review@kernel",
      summary: "choose the release boundary",
      evidenceRef: "/proof/release.md",
      transitionNote: "continuation: apply the human ruling",
    });
    expect(parked).toMatchObject({
      state: "blocked",
      summary: "choose the release boundary",
      evidenceRef: "/proof/release.md",
    });
  });
});
