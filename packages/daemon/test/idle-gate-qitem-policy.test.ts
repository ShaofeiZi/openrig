import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { idleGateFiredConditionSchema } from "../src/db/migrations/078_idle_gate_fired_condition.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine, type DeliveryFn } from "../src/domain/watchdog-policy-engine.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const NOW = new Date("2026-07-03T12:00:00.000Z");
const FRESH = "2026-07-03T11:59:00.000Z"; // 1 分钟前，仍在 5 分钟新鲜度范围内
const STALE = "2026-07-03T11:50:00.000Z"; // 10 分钟前，已超过新鲜度范围
const SEAT = "dev-guard@test-rig";

function makeJob(overrides: Partial<PolicyJob> = {}): PolicyJob {
  return {
    jobId: "job-1",
    policy: "idle-gate-qitem",
    target: { session: SEAT },
    intervalSeconds: 30,
    activeWakeIntervalSeconds: 300,
    scanIntervalSeconds: null,
    context: {},
    lastEvaluationAt: null,
    lastFireAt: null,
    registeredBySession: "ops@kernel",
    registeredAt: "2026-07-03T07:00:00.000Z",
    ...overrides,
  };
}

describe("idle-gate-qitem 策略（OPR.0.4.3.16）", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let oracleState: ArbitratedSeatState | null;
  const seatActivity = {
    getSeatStateBySession: () => oracleState,
  };

  function setOracleState(
    activity: ArbitratedSeatState["activity"],
    needsInput: ArbitratedSeatState["needsInput"] = { count: 0, reason: null },
  ): void {
    oracleState = {
      seatNodeId: "node-oracle",
      activity,
      needsInput,
      decidedBy: "lifecycle-hooks",
      seq: 1,
      changedAt: NOW.toISOString(),
      rungs: [],
      lastSwap: null,
    };
  }

  function seedSeat(): void {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.guard", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, attachmentType: "tmux" });
  }

  function seedActivity(hookEvent: string, occurredAt: string): void {
    if (occurredAt === STALE) setOracleState("unknown");
    else if (hookEvent === "PermissionRequest") {
      setOracleState("idle-at-prompt", { count: 1, reason: "permission prompt" });
    } else if (hookEvent === "Stop") setOracleState("idle-at-prompt");
    else setOracleState("working");
  }

  function seedGateQitem(
    id: string,
    opts: { destination?: string; state?: string; tags?: string[] | null; tier?: string | null } = {},
  ): void {
    const destination = opts.destination ?? SEAT;
    const state = opts.state ?? "pending";
    const tags = opts.tags === undefined ? ["gate:guard"] : opts.tags;
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body)
       VALUES (?, '2026-07-03T07:00:00Z', '2026-07-03T07:00:00Z', 'src@r', ?, ?, 'routine', ?, ?, 'review this diff')`,
    ).run(id, destination, state, opts.tier ?? null, tags ? JSON.stringify(tags) : null);
  }

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [watchdogJobsSchema, watchdogHistorySchema, idleGateFiredConditionSchema]); // 幂等；添加 watchdog 表
    eventBus = new EventBus(db);
    oracleState = null;
    seedSeat();
  });

  afterEach(() => db.close());

  it("原始 hook 活动与裁定结果不一致时使用裁定后的事实源", async () => {
    seedGateQitem("q-opposed-activity");
    const rawStore = new AgentActivityStore({ db, eventBus, now: () => NOW });
    expect(rawStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: SEAT,
      hookEvent: "Stop",
      occurredAt: FRESH,
    }).ok).toBe(true); // 原始 hook 存储表明席位空闲
    setOracleState("working");
    const policy = makeIdleGateQitemPolicy({
      db,
      seatActivity,
    });

    const out = await policy.evaluate(makeJob());

    expect(out).toEqual({
      action: "skip",
      reason: "seat_active",
      notes: { seat: SEAT, activityState: "working" },
    });
  });

  it("待处理 gate:guard qitem + 新鲜空闲信号只发送一次，notes 记录 qitem 与活动信号", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH); // → 空闲
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target.session).toBe(SEAT);
    expect(out.message).toContain("q-gate-1");
    expect(out.notes?.qitemId).toBe("q-gate-1");
    expect(out.notes?.gateRoles).toEqual(["guard"]);
    expect(out.notes?.activityState).toBe("idle-at-prompt");
    expect(out.notes?.activityDecidedBy).toBe("lifecycle-hooks");
  });

  // --- OPR.0.5.8.1 S2：门控集合的每种实质状态只触发一次 ---
  //
  // 编写这些测试前已在真实后台服务上复现：未变化的门禁型 blocked 行会在 +0 秒和
  // +120.3 秒（窗口到期）再次唤醒席位；短暂的 seat-active 闪变会清除 `actionable`，
  // 并在 120 秒窗口开始 60.1 秒后再次触发。该窗口从来不是冷却期。

  // 引擎路径 S2 固定项。必须经过引擎而不是单独测试策略：条件回执由策略提出，只有交付
  // 返回 ok 后才由引擎保存。孤立测试策略只能断言决策，而 QA 发现的缺陷存在于两者接缝。
  function engineFor(deliveryStatus: () => "ok" | "failed") {
    let clock = NOW;
    const advance = (seconds: number) => { clock = new Date(clock.getTime() + seconds * 1000); };
    const jobsRepo = new WatchdogJobsRepository(db);
    const historyLog = new WatchdogHistoryLog(db);
    const attempts: Array<{ targetSession: string; message: string }> = [];
    const deliver: DeliveryFn = async (req) => {
      attempts.push(req);
      return { status: deliveryStatus() };
    };
    const engine = new WatchdogPolicyEngine({
      jobsRepo, historyLog, eventBus, deliver, now: () => clock,
      additionalPolicies: [makeIdleGateQitemPolicy({ db, seatActivity })],
    });
    const registered = jobsRepo.register({
      policy: "idle-gate-qitem",
      specYaml: `policy: idle-gate-qitem\ntarget:\n  session: ${SEAT}\ninterval_seconds: 30\n`,
      targetSession: SEAT,
      intervalSeconds: 30,
      activeWakeIntervalSeconds: 300,
      registeredBySession: "ops@kernel",
    });
    const evaluate = () => engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
    const receipt = () =>
      (db.prepare("SELECT last_fired_condition AS c FROM watchdog_jobs WHERE job_id = ?")
        .get(registered.jobId) as { c: string | null } | undefined)?.c ?? null;
    return { attempts, evaluate, receipt, advance };
  }
  function appendTransition(qitemId: string, note: string, id: number): void {
    db.prepare(
      `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session, transition_note)
       VALUES (?, ?, '2026-07-03T08:00:00Z', 'blocked', 'someone@rig', ?)`,
    ).run(id, qitemId, note);
  }

  it("S2 R-1——门控集合未变化时，无论经过多少窗口都不会再次唤醒", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    advance(301);
    await evaluate();
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(1);   // 三个窗口，只唤醒一次
  });

  it("S2 R-2——seat_active 短暂闪变不能制造第二次唤醒", async () => {
    // 引擎曾在每次跳过时清除 `actionable`，导致短暂忙碌状态能完全绕过活动唤醒窗口。
    // 活动跳过不会触碰条件回执，因此闪变不再产生作用。
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    expect(attempts).toHaveLength(1);

    seedActivity("UserPromptSubmit", FRESH); // 席位忙碌
    await evaluate();
    seedActivity("Stop", FRESH); // 再次空闲
    advance(301);                // 已过窗口，此时只能由条件门禁阻止
    await evaluate();
    expect(attempts).toHaveLength(1);
  });

  it("S2 F1——交付失败不保存回执，因此下次扫描会重试", async () => {
    // dev50-qa 在 f610eec7d 判为 NOT-CLEAR。第一版在尝试交付前就在 evaluate() 内写入
    // 回执，因此一次传输失败会抑制唤醒，直到门控集合变化；这种静默比正在修复的噪声更糟。
    // 抑制必须以唤醒确实到达的证据为依据。
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    let status: "ok" | "failed" = "failed";
    const { attempts, evaluate, receipt, advance } = engineFor(() => status);

    await evaluate();
    expect(attempts).toHaveLength(1);
    expect(receipt()).toBeNull();          // 发送失败时不保存任何内容

    // 引擎在发送失败时仍写入 last_fire_at，因此活动唤醒窗口仍是条件门禁下的底线，
    // 与裁定一致。重试受该窗口限制，而不是一直阻塞到行发生变化。有界且可自愈正是它
    // 与原缺陷的全部区别。
    await evaluate();
    expect(attempts).toHaveLength(1);      // 窗口内：底线仍生效
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(2);      // 窗口已过：行未变化也会重试

    status = "ok";
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(3);
    expect(receipt()).not.toBeNull();      // 只在此时保存

    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(3);      // 超过窗口后条件门禁仍生效
  });

  it("S2 保持：发生实质转换时会及时再次唤醒", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    await evaluate();
    expect(attempts).toHaveLength(1);

    appendTransition("q-gate-1", "reviewer asked a question", 9001);
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(2);
  });

  it("S2 保持：即使阻塞项状态未变，实质性阻塞项转换也会再次唤醒", async () => {
    // review50-r2 在 0bbb9d9e2 判为 NOT-CLEAR。契约规定两条阻塞项变化轴：阻塞项发生
    // 实质转换，或阻塞项到达终态。摘要只携带阻塞项状态，因此仍在处理中但新增实质内容
    // 的转换备注会产生相同摘要并被抑制。此前的“实质转换”固定项只改变门控行，仅满足
    // 两条路径中的一条。
    seedGateQitem("q-gate-1");
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
       VALUES ('q-blocker', '2026-07-03T07:00:00Z', '2026-07-03T07:00:00Z', 'src@r', 'other@rig', 'in-progress', 'routine', null, 'the blocker')`,
    ).run();
    db.prepare("UPDATE queue_items SET state = 'blocked', blocked_on = 'q-blocker' WHERE qitem_id = 'q-gate-1'").run();
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    expect(attempts).toHaveLength(1);

    // 阻塞项新增实质转换，但刻意保持其状态不变。
    appendTransition("q-blocker", "decision context materially amended", 91001);
    expect(
      (db.prepare("SELECT state FROM queue_items WHERE qitem_id = 'q-blocker'").get() as { state: string }).state,
    ).toBe("in-progress");
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(2);
  });

  it("S2——阻塞项上的唤醒机制标记仍不属于实质变化", async () => {
    // 排除规则也必须适用于阻塞项轴，否则在阻塞项上记录一次唤醒就会为下一次唤醒提供
    // 理由；这只是同一陷阱转移到了另一张表。
    seedGateQitem("q-gate-1");
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
       VALUES ('q-blocker', '2026-07-03T07:00:00Z', '2026-07-03T07:00:00Z', 'src@r', 'other@rig', 'in-progress', 'routine', null, 'the blocker')`,
    ).run();
    db.prepare("UPDATE queue_items SET state = 'blocked', blocked_on = 'q-blocker' WHERE qitem_id = 'q-gate-1'").run();
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    appendTransition("q-blocker", "wake-attempt: 2/3 outcome=failed", 91002);
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(1);
  });

  it("S2 保持：新的门禁 qitem 到达时会唤醒", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    seedGateQitem("q-gate-2");
    // 这是测量结果而非假设；在为引擎插桩前曾两次判断错误。发送后，窗口结束前每次求值
    // 都返回 active_wake_not_due：限流分支保留 `actionable`，而通用跳过分支会清除它。
    // 因此窗口在这里是真实底线，席位持续空闲时，新工作也必须等待窗口结束。
    await evaluate();
    expect(attempts).toHaveLength(1);   // 窗口内底线生效
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(2);   // 窗口已过且条件变化，因此唤醒
  });

  it("S2——唤醒机制标记绝不属于实质变化，否则每次唤醒都会为下一次提供理由", async () => {
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { attempts, evaluate, advance } = engineFor(() => "ok");
    await evaluate();
    appendTransition("q-gate-1", "wake-attempt: 1/3 outcome=delivered", 9002);
    appendTransition("q-gate-1", "escalation-rung: orchestrator -> orch@rig", 9003);
    // 已经过窗口，因此此处只能由条件门禁导致跳过；否则测试会因限流通过而无法证明任何事。
    advance(301);
    await evaluate();
    expect(attempts).toHaveLength(1);
  });

  it("S2——被抑制的唤醒仍可推导，且绝不修改行", async () => {
    // 只抑制唤醒，绝不抑制或修改记录。
    seedGateQitem("q-gate-1");
    seedActivity("Stop", FRESH);
    const { evaluate, receipt, advance } = engineFor(() => "ok");
    expect(receipt()).toBeNull();
    await evaluate();
    const banked = receipt();
    expect(banked).toMatch(/^[0-9a-f]{32}$/);
    advance(301);
    await evaluate();
    expect(receipt()).toBe(banked);        // 单一覆盖值，而非台账
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE qitem_id = 'q-gate-1'").get() as { n: number }).n,
    ).toBe(1);
  });

  it("human-gate 层级（无 gate:* 标签）+ 新鲜空闲信号会发送（次级谓词 gate:human）", async () => {
    seedGateQitem("q-human-1", { tags: null, tier: "human-gate" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.notes?.gateRoles).toEqual(["human"]);
  });

  it("席位没有待处理门禁 qitem 时跳过并返回 no_pending_gate", async () => {
    // 一个非门禁待处理 qitem，加上一个属于其他席位的门禁 qitem。
    seedGateQitem("q-plain", { tags: ["mission:x"] });
    seedGateQitem("q-other", { destination: "someone-else@test-rig" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("no_pending_gate");
  });

  it("席位运行中时跳过并返回 seat_active，不执行空闲唤醒", async () => {
    seedGateQitem("q-gate-2");
    seedActivity("UserPromptSubmit", FRESH); // → 运行中
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("seat_active");
  });

  it("席位需要输入时跳过并返回 seat_needs_input，绝不驱动实时选择器", async () => {
    seedGateQitem("q-gate-3");
    seedActivity("PermissionRequest", FRESH); // → needs_input
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("seat_needs_input");
  });

  it("活动状态为 unknown 但 needsInput 为正时保留“需要输入”语义", async () => {
    seedGateQitem("q-gate-unknown-needs-input");
    setOracleState("unknown", { count: 1, reason: "permission prompt" });
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });

    const out = await policy.evaluate(makeJob());

    expect(out).toEqual({
      action: "skip",
      reason: "seat_needs_input",
      notes: { seat: SEAT, activityReason: "permission prompt" },
    });
  });

  it("过期空闲活动会如实跳过并返回 activity_stale_unknown，绝不伪造空闲", async () => {
    seedGateQitem("q-gate-4");
    seedActivity("Stop", STALE); // 过期证据使事实源如实保持 unknown
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("activity_stale_unknown");
  });

  it("完全没有活动信号时如实跳过并返回 activity_stale_unknown", async () => {
    seedGateQitem("q-gate-5");
    // 不调用 seedActivity
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("activity_stale_unknown");
  });

  it("门禁 qitem 已被认领（in-progress）时不触发，因为不可认领而跳过", async () => {
    seedGateQitem("q-claimed", { state: "in-progress" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("skip");
    if (out.action !== "skip") return;
    expect(out.reason).toBe("no_pending_gate");
  });

  it("blocked 门禁 qitem 可认领，席位空闲时触发", async () => {
    seedGateQitem("q-blocked", { state: "blocked" });
    seedActivity("Stop", FRESH);
    const policy = makeIdleGateQitemPolicy({ db, seatActivity });
    const out = await policy.evaluate(makeJob());
    expect(out.action).toBe("send");
  });

  describe("已注册的活动 watchdog 作业（guard 备注 2：真实注册 + 引擎分派 + 冷却）", () => {
    it("已注册 idle-gate-qitem 作业由引擎主动求值：触发一次后进入冷却", async () => {
      const jobsRepo = new WatchdogJobsRepository(db);
      const historyLog = new WatchdogHistoryLog(db);
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const deliver: DeliveryFn = async (req) => {
        deliveries.push(req);
        return { status: "ok" };
      };
      const engine = new WatchdogPolicyEngine({
        jobsRepo,
        historyLog,
        eventBus,
        deliver,
        now: () => NOW,
        additionalPolicies: [makeIdleGateQitemPolicy({ db, seatActivity })],
      });

      // 注册真实作业，证明 PHASE_D_POLICIES 准入 idle-gate-qitem，且引擎从注册表解析它。
      const registered = jobsRepo.register({
        policy: "idle-gate-qitem",
        specYaml: `policy: idle-gate-qitem\ntarget:\n  session: ${SEAT}\ninterval_seconds: 30\n`,
        targetSession: SEAT,
        intervalSeconds: 30,
        activeWakeIntervalSeconds: 300,
        registeredBySession: "ops@kernel",
      });
      expect(jobsRepo.listActive().map((j) => j.jobId)).toContain(registered.jobId);
      expect(engine.resolvePolicy("idle-gate-qitem")).toBeDefined();

      seedGateQitem("q-registered");
      seedActivity("Stop", FRESH);

      // 首次求值触发：交付 + sent 历史 + evaluation_fired。
      const r1 = await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
      expect(r1.outcome.action).toBe("send");
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.targetSession).toBe(SEAT);
      expect(historyLog.listForJob(registered.jobId)[0]?.outcome).toBe("sent");

      // 紧接着第二次求值会静默跳过，不重复唤醒。
      //
      // OPR.0.5.8.1 S2 修正后，本测试的主题——触发一次后不重复唤醒——保持不变，
      // 并继续通过交付次数断言，这是用户实际感受到的行为。只有原因发生变化：条件门禁
      // 现在先于引擎的活动唤醒窗口作出决定，因此跳过原因为 `gate_condition_unchanged`，
      // 而不是 `active_wake_not_due`。
      //
      // 这里有意断言新原因，而不放宽为“任意跳过”：两个原因不可互换。
      // `active_wake_not_due` 会随窗口到期，并在一次跳过清除 `actionable` 后完全绕过；
      // `gate_condition_unchanged` 则持续到门控集合发生实质变化。实际触发哪个原因正是
      // 此修复的核心。
      const r2 = await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
      expect(r2.outcome.action).toBe("skip");
      expect((r2.outcome as { reason: string }).reason).toBe("gate_condition_unchanged");
      expect(deliveries).toHaveLength(1);
    });
  });

  // OPR.0.4.3.16 rev1-r1 修正（顾问于 2026-07-03 裁定）：卡住席位的跳过状态
  //（seat_needs_input / activity_stale_unknown）是该策略目标场景中常见的重复状态，即门禁
  // 在始终无法进入新鲜空闲状态的席位上保持待处理。如果醒目记录，每次扫描都会无限制地
  // 生成一条历史记录和一个 SSE。现在这些状态保持静默，因此门禁在卡住席位上经过多次扫描
  // 仍不会产生逐次记录；只有唤醒（send）路径继续被醒目记录和审计。
  describe("卡住席位的跳过在多次扫描间保持静默，不产生逐次 history/SSE 噪声", () => {
    function makeEngineWithCapture() {
      const jobsRepo = new WatchdogJobsRepository(db);
      const historyLog = new WatchdogHistoryLog(db);
      const deliveries: Array<{ targetSession: string; message: string }> = [];
      const deliver: DeliveryFn = async (req) => {
        deliveries.push(req);
        return { status: "ok" };
      };
      const engine = new WatchdogPolicyEngine({
        jobsRepo,
        historyLog,
        eventBus,
        deliver,
        now: () => NOW,
        additionalPolicies: [makeIdleGateQitemPolicy({ db, seatActivity })],
      });
      const registered = jobsRepo.register({
        policy: "idle-gate-qitem",
        specYaml: `policy: idle-gate-qitem\ntarget:\n  session: ${SEAT}\ninterval_seconds: 30\n`,
        targetSession: SEAT,
        intervalSeconds: 30,
        activeWakeIntervalSeconds: 300,
        registeredBySession: "ops@kernel",
      });
      return { jobsRepo, historyLog, engine, registered, deliveries };
    }

    it("门禁在 NEEDS_INPUT 席位上连续 5 次扫描仍待处理时不生成历史、SSE 或交付", async () => {
      seedGateQitem("q-stuck-needs-input");
      seedActivity("PermissionRequest", FRESH); // → needs_input，绝不空闲
      const { jobsRepo, historyLog, engine, registered, deliveries } = makeEngineWithCapture();
      const skippedEvents: unknown[] = [];
      eventBus.subscribe((e) => {
        if (e.type === "watchdog.evaluation_skipped") skippedEvents.push(e);
      });

      for (let scan = 0; scan < 5; scan++) {
        const r = await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
        expect(r.outcome.action).toBe("skip");
        expect((r.outcome as { reason: string }).reason).toBe("seat_needs_input");
        expect(r.meaningful).toBe(false);
      }

      // 核心要求：不再进行无界的逐次扫描记录。
      expect(historyLog.listForJob(registered.jobId)).toHaveLength(0);
      expect(skippedEvents).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    });

    it("门禁在 STALE 席位上连续 5 次扫描仍待处理时不生成历史、SSE 或交付", async () => {
      seedGateQitem("q-stuck-stale");
      seedActivity("Stop", STALE); // 过期证据使事实源如实保持 unknown
      const { jobsRepo, historyLog, engine, registered, deliveries } = makeEngineWithCapture();
      const skippedEvents: unknown[] = [];
      eventBus.subscribe((e) => {
        if (e.type === "watchdog.evaluation_skipped") skippedEvents.push(e);
      });

      for (let scan = 0; scan < 5; scan++) {
        const r = await engine.evaluate(jobsRepo.getByIdOrThrow(registered.jobId));
        expect(r.outcome.action).toBe("skip");
        expect((r.outcome as { reason: string }).reason).toBe("activity_stale_unknown");
        expect(r.meaningful).toBe(false);
      }

      expect(historyLog.listForJob(registered.jobId)).toHaveLength(0);
      expect(skippedEvents).toHaveLength(0);
      expect(deliveries).toHaveLength(0);
    });
  });
});
