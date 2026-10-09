import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler, isDue } from "../src/domain/watchdog-scheduler.js";

describe("WatchdogScheduler（PL-004 阶段 C）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let deliveries: Array<{ targetSession: string; message: string }>;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]);
    bus = new EventBus(db);
    jobsRepo = new WatchdogJobsRepository(db);
    log = new WatchdogHistoryLog(db);
    deliveries = [];
  });

  afterEach(() => db.close());

  function makeEngine() {
    return new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: bus,
      deliver: async (req) => {
        deliveries.push(req);
        return { status: "ok" };
      },
    });
  }

  it("isDue 对从未评估的任务返回 true", () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: x\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    expect(isDue(job, Date.now())).toBe(true);
  });

  it("间隔尚未结束时 isDue 返回 false", () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: x\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    jobsRepo.recordEvaluation(job.jobId, tenSecondsAgo, true);
    const updated = jobsRepo.getByIdOrThrow(job.jobId);
    expect(isDue(updated, Date.now())).toBe(false);
  });

  it("间隔已结束时 isDue 返回 true", () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: x\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    jobsRepo.recordEvaluation(job.jobId, longAgo, true);
    const updated = jobsRepo.getByIdOrThrow(job.jobId);
    expect(isDue(updated, Date.now())).toBe(true);
  });

  it("runTickNow 仅评估已到期的活跃任务", async () => {
    const j1 = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: m1\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const j2 = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: b@rig\n  message: m2\n",
      targetSession: "b@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    jobsRepo.recordEvaluation(j1.jobId, new Date(Date.now() - 5_000).toISOString(), true);

    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    await sched.runTickNow();
    expect(deliveries).toEqual([{ targetSession: "b@rig", message: "m2" }]);
  });

  it("runTickNow 在后续每个到期 tick 都会评估已到期任务", async () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: m\n",
      targetSession: "a@rig",
      intervalSeconds: 1,
      registeredBySession: "ops@kernel",
    });
    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    await sched.runTickNow();
    expect(deliveries.length).toBe(1);
    // 重新标记为 5 秒前已评估，使下一 tick 再次到期。
    jobsRepo.recordEvaluation(job.jobId, new Date(Date.now() - 5_000).toISOString(), true);
    await sched.runTickNow();
    expect(deliveries.length).toBe(2);
  });

  it("stopped 任务不参与评估", async () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: m\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    jobsRepo.stop(job.jobId);
    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    await sched.runTickNow();
    expect(deliveries).toEqual([]);
  });

  it("terminal 任务不参与评估", async () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: a@rig\n  message: m\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    jobsRepo.markTerminal(job.jobId, "done");
    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    await sched.runTickNow();
    expect(deliveries).toEqual([]);
  });

  it("策略评估错误会被捕获，tick 继续处理同级任务", async () => {
    // 任务 1 在任何位置都没有 message——periodic-reminder 抛出 policy_spec_invalid。
    jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: a@rig\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const ok = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: ok@rig\nmessage: 正常\n",
      targetSession: "ok@rig",
      intervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const engine = makeEngine();
    const errors: unknown[] = [];
    const sched = new WatchdogScheduler({
      jobsRepo,
      policyEngine: engine,
      onTickError: (err) => errors.push(err),
    });
    await sched.runTickNow();
    expect(errors.length).toBe(1);
    expect(deliveries).toEqual([{ targetSession: "ok@rig", message: "正常" }]);
    // 成功评估后，第二个任务应已设置 last_evaluation_at。
    const after = jobsRepo.getByIdOrThrow(ok.jobId);
    expect(after.lastEvaluationAt).not.toBeNull();
  });

  it("start + stop 具备幂等性且不抛错", async () => {
    const engine = makeEngine();
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine, tickIntervalMs: 60_000 });
    sched.start();
    sched.start();
    expect(sched.isRunning()).toBe(true);
    await sched.stop();
    await sched.stop();
    expect(sched.isRunning()).toBe(false);
  });

  // R2 修复（守卫阻塞项 1）：设置 scan_interval_seconds 时调度器必须使用它；
  // interval_seconds 仅作回退。这些测试使用不同值，因此使用 interval_seconds 的回归
  // 会失败（不同于 R1 中两者相等的 active-wake 测试）。
  it("isDue 优先使用 scan_interval_seconds (=30) 而非 interval_seconds (=600)——经过 45 秒后到期", () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: a@rig\nmessage: x\n",
      targetSession: "a@rig",
      intervalSeconds: 600,
      scanIntervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const fortyFiveSecondsAgo = new Date(Date.now() - 45_000).toISOString();
    jobsRepo.recordEvaluation(job.jobId, fortyFiveSecondsAgo, true);
    const updated = jobsRepo.getByIdOrThrow(job.jobId);
    expect(isDue(updated, Date.now())).toBe(true);
  });

  it("isDue 优先使用 scan_interval_seconds (=600) 而非 interval_seconds (=30)——经过 45 秒后尚未到期", () => {
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: a@rig\nmessage: x\n",
      targetSession: "a@rig",
      intervalSeconds: 30,
      scanIntervalSeconds: 600,
      registeredBySession: "ops@kernel",
    });
    const fortyFiveSecondsAgo = new Date(Date.now() - 45_000).toISOString();
    jobsRepo.recordEvaluation(job.jobId, fortyFiveSecondsAgo, true);
    const updated = jobsRepo.getByIdOrThrow(job.jobId);
    expect(isDue(updated, Date.now())).toBe(false);
  });

  it("处于 scan_interval_seconds 未到期窗口时，runTickNow 不调用策略也不写历史", async () => {
    // scan_interval_seconds=600、interval_seconds=30（判别组合：忽略
    // scan_interval_seconds 的调度器会在 30 秒后到期，并调用策略、写入历史）。
    // 测试断言策略未跨过调度器边界调用，且没有写入 sent 历史行。
    let policyCalled = 0;
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: counted@rig\nmessage: 已计数\n",
      targetSession: "counted@rig",
      intervalSeconds: 30,
      scanIntervalSeconds: 600,
      registeredBySession: "ops@kernel",
    });
    const fortyFiveSecondsAgo = new Date(Date.now() - 45_000).toISOString();
    jobsRepo.recordEvaluation(job.jobId, fortyFiveSecondsAgo, true);
    const engine = new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: bus,
      deliver: async (req) => {
        policyCalled += 1;
        deliveries.push(req);
        return { status: "ok" };
      },
    });
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    const historyCountBefore = log.countForJob(job.jobId);
    await sched.runTickNow();
    expect(policyCalled).toBe(0);
    expect(deliveries.length).toBe(0);
    expect(log.countForJob(job.jobId)).toBe(historyCountBefore);
    expect(jobsRepo.getByIdOrThrow(job.jobId).lastEvaluationAt).toBe(fortyFiveSecondsAgo);
  });

  it("即使 interval_seconds 很大，scan_interval_seconds 结束后 runTickNow 仍会调用策略", async () => {
    let policyCalled = 0;
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: counted@rig\nmessage: 已计数\n",
      targetSession: "counted@rig",
      intervalSeconds: 600,
      scanIntervalSeconds: 30,
      registeredBySession: "ops@kernel",
    });
    const fortyFiveSecondsAgo = new Date(Date.now() - 45_000).toISOString();
    jobsRepo.recordEvaluation(job.jobId, fortyFiveSecondsAgo, true);
    const engine = new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: bus,
      deliver: async (req) => {
        policyCalled += 1;
        deliveries.push(req);
        return { status: "ok" };
      },
    });
    const sched = new WatchdogScheduler({ jobsRepo, policyEngine: engine });
    await sched.runTickNow();
    expect(policyCalled).toBe(1);
    expect(deliveries).toEqual([{ targetSession: "counted@rig", message: "已计数" }]);
    expect(log.countForJob(job.jobId)).toBe(1);
  });

  it("通过 SQLite 跨重启恢复调度（新 repo + 新调度器接管活跃任务）", async () => {
    jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "context:\n  target:\n    session: persist@rig\n  message: 已持久化\n",
      targetSession: "persist@rig",
      intervalSeconds: 1,
      registeredBySession: "ops@kernel",
    });
    // 模拟重启：新 repo、新 history-log、新引擎和新调度器共享同一数据库句柄。
    // 使用阶段 A/B 模式；SQLite 是规范来源。
    const repo2 = new WatchdogJobsRepository(db);
    const log2 = new WatchdogHistoryLog(db);
    const engine2 = new WatchdogPolicyEngine({
      jobsRepo: repo2,
      historyLog: log2,
      eventBus: bus,
      deliver: async (req) => {
        deliveries.push(req);
        return { status: "ok" };
      },
    });
    const sched2 = new WatchdogScheduler({ jobsRepo: repo2, policyEngine: engine2 });
    await sched2.runTickNow();
    expect(deliveries).toEqual([{ targetSession: "persist@rig", message: "已持久化" }]);
  });
});
