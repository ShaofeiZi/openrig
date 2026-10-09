import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { occupantGenerationStampsSchema } from "../src/db/migrations/063_occupant_generation_stamps.js";
import { watchdogTargetGenerationSchema } from "../src/db/migrations/066_watchdog_target_generation.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import {
  type DeliveryFn,
  formatWatchdogDeliveryMessage,
  parseWatchdogSpec,
  WatchdogPolicyEngine,
} from "../src/domain/watchdog-policy-engine.js";
import type { PersistedEvent } from "../src/domain/types.js";
import type { PolicyEvaluation } from "../src/domain/policies/types.js";

describe("WatchdogPolicyEngine（PL-004 阶段 C R1）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let captured: PersistedEvent[];
  let deliveryCalls: Array<{ targetSession: string; message: string }>;
  let deliver: DeliveryFn;

  function makeEngine(opts?: {
    deliver?: DeliveryFn;
    now?: () => Date;
    onWakeAttempt?: (input: { jobId: string; deliveryStatus: string }) => void;
  }): WatchdogPolicyEngine {
    return new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: bus,
      deliver: opts?.deliver ?? deliver,
      now: opts?.now,
      onWakeAttempt: opts?.onWakeAttempt,
    } as never);
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]);
    bus = new EventBus(db);
    jobsRepo = new WatchdogJobsRepository(db);
    log = new WatchdogHistoryLog(db);
    captured = [];
    bus.subscribe((e) => captured.push(e));
    deliveryCalls = [];
    deliver = async (req) => {
      deliveryCalls.push(req);
      return { status: "ok" };
    };
  });

  afterEach(() => db.close());

  it("evaluate(periodic-reminder) 经交付路由、记录 sent、发出 evaluation_fired 并设置 actionable=true", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: alice@rig\ninterval_seconds: 60\nmessage: ping\n",
      targetSession: "alice@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    expect(deliveryCalls).toEqual([{ targetSession: "alice@rig", message: "ping" }]);
    expect(log.countForJob(job.jobId)).toBe(1);
    const list = log.listForJob(job.jobId);
    expect(list[0]?.outcome).toBe("sent");
    expect(captured.some((e) => e.type === "watchdog.evaluation_fired")).toBe(true);
    const after = jobsRepo.getByIdOrThrow(job.jobId);
    expect(after.lastEvaluationAt).not.toBeNull();
    expect(after.lastFireAt).not.toBeNull();
    expect(after.actionable).toBe(true);
    expect(after.lastActionableAt).not.toBeNull();
  });

  it("evaluate 静默跳过（no_actionable_artifacts）时不记录历史也不发出事件（与 POC 一致）", async () => {
    const engine = makeEngine({
      deliver: async () => {
        throw new Error("delivery should NOT be called for skip");
      },
    });
    const tmp = join(tmpdir(), `wd-eng-empty-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const job = jobsRepo.register({
        policy: "artifact-pool-ready",
        specYaml:
          `policy: artifact-pool-ready\ntarget:\n  session: alice@rig\ninterval_seconds: 60\ncontext:\n  pools:\n    - path: ${tmp}\n      include_statuses: [ready]\n`,
        targetSession: "alice@rig",
        intervalSeconds: 60,
        registeredBySession: "ops@kernel",
      });
      const result = await engine.evaluate(job);
      expect(result.outcome.action).toBe("skip");
      if (result.outcome.action !== "skip") return;
      expect(result.outcome.reason).toBe("no_actionable_artifacts");
      expect(result.meaningful).toBe(false);
      expect(deliveryCalls).toEqual([]);
      expect(log.countForJob(job.jobId)).toBe(0);
      expect(captured.some((e) => e.type === "watchdog.evaluation_skipped")).toBe(false);
      const after = jobsRepo.getByIdOrThrow(job.jobId);
      expect(after.lastEvaluationAt).not.toBeNull();
      expect(after.lastFireAt).toBeNull();
      expect(after.actionable).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("交付失败记录为 sent 且 delivery_status=failed（仍有意义）", async () => {
    const failingDeliver: DeliveryFn = async () => ({ status: "failed", error: "transport denied" });
    const engine = makeEngine({ deliver: failingDeliver });
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: alice@rig\ninterval_seconds: 60\nmessage: ping\n",
      targetSession: "alice@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    const list = log.listForJob(job.jobId);
    expect(list[0]?.outcome).toBe("sent");
    expect(list[0]?.deliveryStatus).toBe("failed");
  });

  it("S03：已触发 watchdog 将恢复尝试报告到其关联停滞行", async () => {
    const attempts: Array<{ jobId: string; deliveryStatus: string }> = [];
    const engine = makeEngine({ onWakeAttempt: (attempt) => attempts.push(attempt) });
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: alice@rig\nmessage: resume\n",
      targetSession: "alice@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    expect(attempts).toEqual([{ jobId: job.jobId, deliveryStatus: "ok" }]);
  });

  it("评估时策略未知会将任务标为终止、记录并发出 evaluation_terminal", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: a@rig\nmessage: x\n",
      targetSession: "a@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    const synthetic = { ...job, policy: "totally-bogus" as never };
    const result = await engine.evaluate(synthetic);
    expect(result.outcome.action).toBe("terminal");
    const after = jobsRepo.getByIdOrThrow(job.jobId);
    expect(after.state).toBe("terminal");
    expect(captured.some((e) => e.type === "watchdog.evaluation_terminal")).toBe(true);
  });

  it("策略注册表解析三个 v1 策略（不含 workflow-keepalive）", () => {
    const engine = makeEngine();
    expect(engine.resolvePolicy("periodic-reminder")?.name).toBe("periodic-reminder");
    expect(engine.resolvePolicy("artifact-pool-ready")?.name).toBe("artifact-pool-ready");
    expect(engine.resolvePolicy("edge-artifact-required")?.name).toBe("edge-artifact-required");
    expect(engine.resolvePolicy("workflow-keepalive")).toBeUndefined();
  });

  it("默认规范解析器提取顶层 target、context 和 message", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml:
        "policy: periodic-reminder\ntarget:\n  session: parsed-session@rig\nmessage: parsed-message\ninterval_seconds: 60\n",
      targetSession: "registered-fallback@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    expect(deliveryCalls).toEqual([
      { targetSession: "parsed-session@rig", message: "parsed-message" },
    ]);
  });

  it("规范缺少顶层 target 时回退到已注册 targetSession", async () => {
    const engine = makeEngine();
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      // 没有顶层 target。引擎应合成 {session: targetSession}。
      specYaml: "policy: periodic-reminder\nmessage: ping\ninterval_seconds: 60\n",
      targetSession: "fallback@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });
    await engine.evaluate(job);
    expect(deliveryCalls).toEqual([{ targetSession: "fallback@rig", message: "ping" }]);
  });

  it.each([
    {
      syntax: "folded block scalar",
      specYaml: "message: >-\n  Refresh the execution dashboard\n  and report only meaningful changes.\n",
      expected: "Refresh the execution dashboard and report only meaningful changes.",
    },
    {
      syntax: "literal block scalar",
      specYaml: "message: |\n  First line.\n  Second line.\n",
      expected: "First line.\nSecond line.\n",
    },
    {
      syntax: "quoted scalar",
      specYaml: 'message: "Wake: inspect the queue"\n',
      expected: "Wake: inspect the queue",
    },
    {
      syntax: "plain scalar",
      specYaml: "message: Inspect the queue\n",
      expected: "Inspect the queue",
    },
  ])("parses $syntax as its semantic reminder body", ({ specYaml, expected }) => {
    expect(parseWatchdogSpec(specYaml).message).toBe(expected);
  });

  it("将 watchdog 来源交给交付适配器，而不改变编写的 payload", async () => {
    let source: { jobId: string; policy: string } | undefined;
    const engine = makeEngine({
      deliver: async (request, deliverySource) => {
        deliveryCalls.push(request);
        source = deliverySource;
        return { status: "ok" };
      },
    });
    const job = jobsRepo.register({
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget:\n  session: alice@rig\nmessage: Inspect the queue\n",
      targetSession: "alice@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
    });

    await engine.evaluate(job);

    expect(source).toMatchObject({ jobId: job.jobId, policy: "periodic-reminder", occurrenceId: expect.any(String) });
    expect(deliveryCalls).toEqual([{ targetSession: "alice@rig", message: "Inspect the queue" }]);
    expect(formatWatchdogDeliveryMessage(source!, deliveryCalls[0]!.message)).toBe(
      `[zrig watchdog 调度器 · 策略：periodic-reminder · 任务：${job.jobId}]\nInspect the queue`,
    );
    expect(log.listForJob(job.jobId)[0]?.deliveryMessage).toBe("Inspect the queue");
  });

  // R1 修复（guard 阻断项 1）：移植 POC active-wake 回归。
  // POC 来源：tests/watchdog-active-wake-interval.test.sh
  it("active-wake 节流：唤醒窗口内抑制再次交付；窗口结束后触发", async () => {
    const tmp = join(tmpdir(), `wd-actwake-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const job = jobsRepo.register({
        policy: "artifact-pool-ready",
        specYaml:
          `policy: artifact-pool-ready\ntarget:\n  session: loop-head@example\ninterval_seconds: 30\nscan_interval_seconds: 30\nactive_wake_interval_seconds: 600\ncontext:\n  pools:\n    - path: ${tmp}\n      include_statuses: [ready]\n`,
        targetSession: "loop-head@example",
        intervalSeconds: 30,
        scanIntervalSeconds: 30,
        activeWakeIntervalSeconds: 600,
        registeredBySession: "ops@kernel",
      });

      // Tick 1：池为空 → 静默跳过（no_actionable_artifacts），actionable=false。
      let nowMs = 0;
      let engine = makeEngine({ now: () => new Date(nowMs) });
      let r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
      expect(deliveryCalls.length).toBe(0);

      // 使池变为可操作。
      writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");

      // Tick 2：刚变为可操作 → 触发（转换时不节流）。
      nowMs = 30_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome.action).toBe("send");
      expect(deliveryCalls.length).toBe(1);
      const afterFire = jobsRepo.getByIdOrThrow(job.jobId);
      expect(afterFire.actionable).toBe(true);
      expect(afterFire.lastFireAt).toBe("1970-01-01T00:00:30.000Z");

      // Tick 3 位于触发后 +30 秒（60 秒点）：池仍可操作，但唤醒窗口（600 秒）尚未结束
      // → 静默跳过（active_wake_not_due）。
      nowMs = 60_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome).toEqual({ action: "skip", reason: "active_wake_not_due" });
      expect(deliveryCalls.length).toBe(1);
      // 保留 last_fire_at。
      expect(jobsRepo.getByIdOrThrow(job.jobId).lastFireAt).toBe("1970-01-01T00:00:30.000Z");
      // actionable 仍为 true。
      expect(jobsRepo.getByIdOrThrow(job.jobId).actionable).toBe(true);

      // Tick 4 位于 630_000ms（>= last_fire + 600_000ms）：唤醒窗口已结束 → 再次触发。
      nowMs = 630_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome.action).toBe("send");
      expect(deliveryCalls.length).toBe(2);
      const after2ndFire = jobsRepo.getByIdOrThrow(job.jobId);
      expect(after2ndFire.lastFireAt).toBe("1970-01-01T00:10:30.000Z");

      // Tick 5：池变空 → 静默跳过并重置 actionable。
      rmSync(join(tmp, "ready.md"));
      nowMs = 660_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome).toEqual({ action: "skip", reason: "no_actionable_artifacts" });
      expect(jobsRepo.getByIdOrThrow(job.jobId).actionable).toBe(false);

      // Tick 6：池再次可操作 → 立即触发（刚变为可操作）。
      writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
      nowMs = 690_000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      r = await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(r.outcome.action).toBe("send");
      expect(deliveryCalls.length).toBe(3);

      // 历史只反映三个有意义的事件。
      expect(log.countForJob(job.jobId)).toBe(3);
      const entries = log.listForJob(job.jobId);
      // 全部为 sent（没有静默跳过行）。
      for (const e of entries) expect(e.outcome).toBe("sent");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("active_wake_interval_seconds 为 null 时不应用 active-wake 节流（每次触发都通过）", async () => {
    const tmp = join(tmpdir(), `wd-actwake-null-${Date.now()}-${Math.random()}`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "ready.md"), "---\nstatus: ready\n---\n");
    try {
      const job = jobsRepo.register({
        policy: "artifact-pool-ready",
        specYaml:
          `policy: artifact-pool-ready\ntarget:\n  session: x@rig\ninterval_seconds: 30\ncontext:\n  pools:\n    - path: ${tmp}\n      include_statuses: [ready]\n`,
        targetSession: "x@rig",
        intervalSeconds: 30,
        registeredBySession: "ops@kernel",
      });
      let nowMs = 0;
      let engine = makeEngine({ now: () => new Date(nowMs) });
      await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      expect(deliveryCalls.length).toBe(1);
      nowMs = 1000;
      engine = makeEngine({ now: () => new Date(nowMs) });
      await engine.evaluate(jobsRepo.getByIdOrThrow(job.jobId));
      // 没有唤醒节流时，每次发送都触发。
      expect(deliveryCalls.length).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── GHOST-STAGE（i-c）：触发时目标代门禁 ──
// 绑定到代的唤醒（选择启用 target_generation_uuid）不得在目标已移交给不同存活代后触发。
// 绑定角色（NULL）的任务保持原样触发；存活代未知时失败开放（交付——“未知绝不跳过”，
// note-2 反转）；不匹配时明确跳过。
describe("WatchdogPolicyEngine——触发时目标代门禁（i-c）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let deliveryCalls: Array<{ targetSession: string; message: string }>;
  let liveGenBySession: Map<string, string | null>;

  function makeEngine(): WatchdogPolicyEngine {
    return new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: bus,
      deliver: async (req) => { deliveryCalls.push(req); return { status: "ok" }; },
      resolveTargetGeneration: (s) => liveGenBySession.get(s) ?? null,
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, watchdogJobsSchema, watchdogHistorySchema, occupantGenerationStampsSchema, watchdogTargetGenerationSchema]);
    bus = new EventBus(db);
    jobsRepo = new WatchdogJobsRepository(db);
    log = new WatchdogHistoryLog(db);
    deliveryCalls = [];
    liveGenBySession = new Map();
  });
  afterEach(() => db.close());

  const armReminder = (targetGenerationUuid?: string | null) => jobsRepo.register({
    policy: "periodic-reminder",
    specYaml: "policy: periodic-reminder\ntarget:\n  session: alice@rig\ninterval_seconds: 60\nmessage: ping\n",
    targetSession: "alice@rig",
    intervalSeconds: 60,
    registeredBySession: "ops@kernel",
    targetGenerationUuid,
  });

  it("绑定角色（目标代为 NULL）时无论存活代如何都原样触发", async () => {
    liveGenBySession.set("alice@rig", "gen-anything");
    await makeEngine().evaluate(armReminder(null));
    expect(deliveryCalls).toEqual([{ targetSession: "alice@rig", message: "ping" }]);
  });

  it("绑定代且存活代匹配 → 交付（仍为预期目标）", async () => {
    liveGenBySession.set("alice@rig", "gen-A");
    await makeEngine().evaluate(armReminder("gen-A"));
    expect(deliveryCalls.length).toBe(1);
  });

  it("绑定代且存活代不匹配 → 明确跳过、不交付，审计指明两个代", async () => {
    liveGenBySession.set("alice@rig", "gen-B"); // target handed over since arm (armed for gen-A)
    const job = armReminder("gen-A");
    const result = await makeEngine().evaluate(job);
    expect(deliveryCalls).toEqual([]); // NEVER fired at the successor
    expect(result.outcome.action).toBe("skip");
    if (result.outcome.action === "skip") expect(result.outcome.reason).toBe("target_generation_mismatch");
    const hist = log.listForJob(job.jobId);
    expect(hist[0]?.outcome).toBe("skipped");
    expect(hist[0]?.skipReason).toBe("target_generation_mismatch");
    // 结构化审计指明两个代（启用目标与存活代）。
    expect(hist[0]?.evaluationNotes).toMatchObject({ armedForGeneration: "gen-A", liveGeneration: "gen-B" });
  });

  it("绑定代且存活代未知（null tenure）→ 交付（失败开放，未知绝不跳过）", async () => {
    // alice@rig 没有条目 → resolveTargetGeneration 返回 null。
    await makeEngine().evaluate(armReminder("gen-A"));
    expect(deliveryCalls.length).toBe(1);
  });
});

// ─── OPR.0.5.6.24 F-14——固定已裁定的两个共享引擎效果 ──────────────────────
describe("停滞所有者消费者的引擎效果（OPR.0.5.6.24）", () => {
  function makeHarness(opts: { deliver?: DeliveryFn; policyResult: () => Promise<PolicyEvaluation> }) {
    const db = createDb();
    migrate(db, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]);
    const bus = new EventBus(db);
    const jobsRepo = new WatchdogJobsRepository(db);
    const log = new WatchdogHistoryLog(db);
    const captured: PersistedEvent[] = [];
    bus.subscribe((e) => captured.push(e));
    const engine = new WatchdogPolicyEngine({
      jobsRepo,
      historyLog: log,
      eventBus: bus,
      deliver: opts.deliver ?? (async () => ({ status: "ok" as const })),
      additionalPolicies: [
        { name: "parked-owner-consumer", evaluate: () => opts.policyResult() },
      ],
    } as never);
    const job = jobsRepo.register({
      policy: "parked-owner-consumer",
      specYaml:
        "policy: parked-owner-consumer\ntarget:\n  session: parked-owner-consumer@test-rig\ninterval_seconds: 120\n",
      targetSession: "parked-owner-consumer@test-rig",
      intervalSeconds: 120,
      activeWakeIntervalSeconds: null,
      registeredBySession: "daemon@kernel",
    });
    return { db, engine, job, log, captured };
  }

  it("静默固定项：因无停滞所有者而跳过时写入零条历史行，且不发出 watchdog.* 事件", async () => {
    const h = makeHarness({
      policyResult: async () => ({ action: "skip", reason: "no-parked-owner", notes: { rig: "test-rig" } }),
    });
    await h.engine.evaluate(h.job);
    expect(h.log.countForJob(h.job.jobId)).toBe(0);
    expect(h.captured.filter((e) => String(e.type).startsWith("watchdog."))).toHaveLength(0);
    h.db.close();
  });

  it("交付原因固定项：交付错误字符串精确持久化到 sent 行的 evaluationNotes.deliveryReason", async () => {
    const refusal = "Refused: 'dev-planner@test-rig' is at an interactive prompt (target_needs_input). No text was sent.";
    const h = makeHarness({
      deliver: async () => ({ status: "failed" as const, error: refusal }),
      policyResult: async () => ({
        action: "send",
        target: { session: "dev-planner@test-rig" },
        message: "wake",
        notes: { episodeSeat: "dev-planner@test-rig", idsHash: "abc", episodeKey: "k#1" },
      }),
    });
    await h.engine.evaluate(h.job);
    const entries = h.log.listForJob(h.job.jobId, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe("sent");
    expect(entries[0]?.deliveryStatus).toBe("failed");
    expect(entries[0]?.evaluationNotes?.["deliveryReason"]).toBe(refusal);
    // 策略自身的 notes 在合并后保持不变。
    expect(entries[0]?.evaluationNotes?.["episodeKey"]).toBe("k#1");
    h.db.close();
  });
});
