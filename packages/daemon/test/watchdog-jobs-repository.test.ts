import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { contextUsageWatchdogSchema } from "../src/db/migrations/074_context_usage_watchdog.js";
import { contextUsageWatchdogGenerationSchema } from "../src/db/migrations/075_context_usage_watchdog_generation.js";
import {
  PHASE_C_POLICIES,
  WatchdogJobsError,
  WatchdogJobsRepository,
} from "../src/domain/watchdog-jobs-repository.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("WatchdogJobsRepository（PL-004 阶段 C）", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      watchdogJobsSchema,
      watchdogHistorySchema,
      contextUsageWatchdogSchema,
      contextUsageWatchdogGenerationSchema,
    ]);
    repo = new WatchdogJobsRepository(db);
  });

  afterEach(() => db.close());

  function validInput(overrides: Record<string, unknown> = {}) {
    return {
      policy: "periodic-reminder",
      specYaml: "policy: periodic-reminder\ntarget: a@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: a@rig\n  message: 你好\n",
      targetSession: "a@rig",
      intervalSeconds: 60,
      registeredBySession: "ops@kernel",
      ...overrides,
    };
  }

  it("register 存储每个已接受策略，且 actionable 默认为 false", () => {
    for (const p of PHASE_C_POLICIES) {
      const job = repo.register(validInput({
        policy: p,
        ...(p === "context-usage-threshold"
          ? { watchedFilePath: "/tmp/transcript.jsonl", thresholdBytes: 1 }
          : {}),
      }));
      expect(job.policy).toBe(p);
      expect(job.state).toBe("active");
      expect(job.actionable).toBe(false);
      expect(job.lastActionableAt).toBeNull();
      expect(job.jobId).toMatch(/^[0-9A-Z]{26}$/);
    }
  });

  // PL-004 阶段 D：对 workflow-keepalive 的注册拒绝已改为正向接受。workflow-keepalive
  // 现在是已接受的策略枚举值（经编排批准的阶段 D 扩展）。
  it("register 接受 workflow-keepalive（阶段 D 枚举扩展）", () => {
    const job = repo.register(validInput({ policy: "workflow-keepalive" }));
    expect(job.policy).toBe("workflow-keepalive");
    expect(job.state).toBe("active");
  });

  it("register 以 policy_unknown 拒绝未知策略", () => {
    try {
      repo.register(validInput({ policy: "totally-bogus" }));
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogJobsError);
      expect((err as WatchdogJobsError).code).toBe("policy_unknown");
    }
  });

  it("register 以 interval_invalid 拒绝非正 interval_seconds", () => {
    for (const bad of [0, -1, 1.5]) {
      try {
        repo.register(validInput({ intervalSeconds: bad }));
        throw new Error(`值 ${bad} 预期应抛错`);
      } catch (err) {
        expect(err).toBeInstanceOf(WatchdogJobsError);
        expect((err as WatchdogJobsError).code).toBe("interval_invalid");
      }
    }
  });

  it("register 以 target_session_invalid 拒绝不含 @ 的 target_session", () => {
    try {
      repo.register(validInput({ targetSession: "no-at-here" }));
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogJobsError);
      expect((err as WatchdogJobsError).code).toBe("target_session_invalid");
    }
  });

  it("listActive 仅按注册顺序返回 state=active 的任务", () => {
    const a = repo.register(validInput({ targetSession: "a@rig" }));
    const b = repo.register(validInput({ targetSession: "b@rig" }));
    const c = repo.register(validInput({ targetSession: "c@rig" }));
    repo.stop(b.jobId);
    const active = repo.listActive();
    expect(active.map((j) => j.jobId)).toEqual([a.jobId, c.jobId]);
  });

  it("recordEvaluation(fired=true) 更新 last_evaluation_at + last_fire_at", () => {
    const job = repo.register(validInput());
    repo.recordEvaluation(job.jobId, "2026-05-03T07:00:00.000Z", true);
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.lastEvaluationAt).toBe("2026-05-03T07:00:00.000Z");
    expect(after.lastFireAt).toBe("2026-05-03T07:00:00.000Z");
  });

  it("recordEvaluation(fired=false) 仅更新 last_evaluation_at", () => {
    const job = repo.register(validInput());
    repo.recordEvaluation(job.jobId, "2026-05-03T07:00:00.000Z", false);
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.lastEvaluationAt).toBe("2026-05-03T07:00:00.000Z");
    expect(after.lastFireAt).toBeNull();
  });

  it("markTerminal 设置 state=terminal + terminal_reason", () => {
    const job = repo.register(validInput());
    repo.markTerminal(job.jobId, "policy_returned_terminal");
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.state).toBe("terminal");
    expect(after.terminalReason).toBe("policy_returned_terminal");
  });

  it("stop 设置 state=stopped 并记录原因", () => {
    const job = repo.register(validInput());
    const stopped = repo.stop(job.jobId, "操作者停止原因");
    expect(stopped.state).toBe("stopped");
    expect(stopped.terminalReason).toBe("操作者停止原因");
  });

  it("对已终止任务调用 stop 时抛出 job_terminal", () => {
    const job = repo.register(validInput());
    repo.markTerminal(job.jobId, "done");
    try {
      repo.stop(job.jobId);
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogJobsError);
      expect((err as WatchdogJobsError).code).toBe("job_terminal");
    }
  });

  it("setActionable(true) 设置 actionable=1，并默认将 last_actionable_at 设为 evaluatedAt", () => {
    const job = repo.register(validInput());
    repo.setActionable(job.jobId, true, "2026-05-03T07:00:00.000Z");
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.actionable).toBe(true);
    expect(after.lastActionableAt).toBe("2026-05-03T07:00:00.000Z");
  });

  it("setActionable(true) 传入保留参数时保留 last_actionable_at（延续窗口）", () => {
    const job = repo.register(validInput());
    repo.setActionable(job.jobId, true, "2026-05-03T07:00:00.000Z");
    repo.setActionable(job.jobId, true, "2026-05-03T07:01:00.000Z", "2026-05-03T07:00:00.000Z");
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.lastActionableAt).toBe("2026-05-03T07:00:00.000Z");
  });

  it("setActionable(false) 清除 actionable + last_actionable_at", () => {
    const job = repo.register(validInput());
    repo.setActionable(job.jobId, true, "2026-05-03T07:00:00.000Z");
    repo.setActionable(job.jobId, false, "2026-05-03T07:01:00.000Z");
    const after = repo.getByIdOrThrow(job.jobId);
    expect(after.actionable).toBe(false);
    expect(after.lastActionableAt).toBeNull();
  });

  it("getByIdOrThrow 对未知 id 抛出 job_not_found", () => {
    try {
      repo.getByIdOrThrow("does-not-exist");
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(WatchdogJobsError);
      expect((err as WatchdogJobsError).code).toBe("job_not_found");
    }
  });
});

// ── GHOST-STAGE（e/Class-B）：occupant-generation 印记 + generation 范围的切换丢弃 ──
describe("WatchdogJobsRepository——generation 印记（Class-B）", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;
  let genBySession: Map<string, string | null>;

  beforeEach(() => {
    db = createDb();
    // 063 在同一次迁移中修改 queue_items + watchdog_jobs，因此两个表都必须先存在。
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, watchdogJobsSchema, watchdogHistorySchema, occupantGenerationStampsSchema]);
    genBySession = new Map();
    repo = new WatchdogJobsRepository(db, undefined, (s) => genBySession.get(s) ?? null);
  });
  afterEach(() => db.close());

  const input = (overrides: Record<string, unknown> = {}) => ({
    policy: "periodic-reminder",
    specYaml: "policy: periodic-reminder\ntarget: a@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: a@rig\n  message: 你好\n",
    targetSession: "a@rig",
    intervalSeconds: 60,
    registeredBySession: "seat@rig",
    ...overrides,
  });

  it("注册时写入布防 occupant 的 generation 印记", () => {
    genBySession.set("seat@rig", "gen-1");
    expect(repo.register(input()).registeredByGeneration).toBe("gen-1");
  });

  it("无法解析的布防 generation 保持 NULL（未知——绝不写入虚假印记）", () => {
    expect(repo.register(input({ registeredBySession: "unknown@rig" })).registeredByGeneration).toBeNull();
  });

  it("仅丢弃退役 generation 布防的任务——后继自己的任务（同名、实时 generation）会保留", () => {
    genBySession.set("seat@rig", "gen-retired");
    const retired = repo.register(input());
    genBySession.set("seat@rig", "gen-live"); // 后继恢复到相同 seat 名称，但使用新的 generation
    const live = repo.register(input());

    const stopped = repo.dropArmedByRegisteringGeneration("gen-retired");
    expect(stopped).toBe(1);
    expect(repo.getById(retired.jobId)!.state).toBe("stopped");
    expect(repo.getById(retired.jobId)!.terminalReason).toContain("retired");
    expect(repo.getById(live.jobId)!.state).toBe("active"); // 不按名称限定范围——后继不受影响
  });

  it("空 generation 为空操作（绝不会全部丢弃）", () => {
    genBySession.set("seat@rig", "gen-1");
    repo.register(input());
    expect(repo.dropArmedByRegisteringGeneration("")).toBe(0);
  });

  it("generation 为 NULL 的任务永不匹配（未知 != 已退役）", () => {
    const job = repo.register(input({ registeredBySession: "unknown@rig" }));
    expect(repo.dropArmedByRegisteringGeneration("gen-anything")).toBe(0);
    expect(repo.getById(job.jobId)!.state).toBe("active");
  });

  it("063 前数据库（无 generation 列）会降级：注册成功、generation 为 NULL、丢弃为空操作（控制影响范围）", () => {
    const bareDb = createDb();
    migrate(bareDb, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]); // 不含 063
    const bareRepo = new WatchdogJobsRepository(bareDb, undefined, () => "gen-x");
    const job = bareRepo.register(input());
    expect(job.registeredByGeneration).toBeNull();
    expect(bareRepo.dropArmedByRegisteringGeneration("gen-x")).toBe(0);
    bareDb.close();
  });
});

// ── GHOST-STAGE（i-c）：可选启用的 TARGET-generation 印记（触发时 generation 门禁输入）──
describe("WatchdogJobsRepository——target-generation 印记（i-c，可选启用）", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, watchdogJobsSchema, watchdogHistorySchema, occupantGenerationStampsSchema, watchdogTargetGenerationSchema]);
    repo = new WatchdogJobsRepository(db);
  });
  afterEach(() => db.close());

  const input = (overrides: Record<string, unknown> = {}) => ({
    policy: "periodic-reminder",
    specYaml: "policy: periodic-reminder\ntarget: a@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: a@rig\n  message: 你好\n",
    targetSession: "a@rig",
    intervalSeconds: 60,
    registeredBySession: "seat@rig",
    ...overrides,
  });

  // 核心固定点（已批准）：没有 target generation 的任务按 ROLE 绑定——为 NULL，触发行为不变。
  it("未提供 target generation 时默认为 NULL（按 role 绑定）", () => {
    expect(repo.register(input()).targetGeneration).toBeNull();
  });

  it("写入并往返保留可选启用的 target generation（绑定 generation 的唤醒）", () => {
    const job = repo.register(input({ targetGenerationUuid: "gen-target-7" }));
    expect(job.targetGeneration).toBe("gen-target-7");
    expect(repo.getById(job.jobId)!.targetGeneration).toBe("gen-target-7");
  });

  it("与绑定 generation 的同级任务并存时，绑定 role 的任务仍保持 role-bound（独立列）", () => {
    const roleBound = repo.register(input());
    const genBound = repo.register(input({ targetGenerationUuid: "gen-9" }));
    expect(repo.getById(roleBound.jobId)!.targetGeneration).toBeNull();
    expect(repo.getById(genBound.jobId)!.targetGeneration).toBe("gen-9");
  });

  it("066 前数据库（无 target-generation 列）会降级：注册成功，targetGeneration 为 NULL", () => {
    const bareDb = createDb();
    migrate(bareDb, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]); // 不含 066
    const bareRepo = new WatchdogJobsRepository(bareDb);
    const job = bareRepo.register(input({ targetGenerationUuid: "gen-x" }));
    expect(job.targetGeneration).toBeNull(); // 列缺失 → 可选启用值静默降级为 role-bound
    bareDb.close();
  });
});

// OPR.0.5.1 51-06 W2c——自动注册是精确 tuple ensure，而非盲目 register。测试刻意位于
// repository 高度：较新的 terminal 行不得隐藏较旧的可运行重复项，而 stopped 是持久的
// 操作者退出选择，不是应恢复的行。
describe("WatchdogJobsRepository——W2c 精确 tuple 自动注册", () => {
  let db: Database.Database;
  let repo: WatchdogJobsRepository;

  beforeEach(() => {
    db = createFullTestDb();
    repo = new WatchdogJobsRepository(db);
  });
  afterEach(() => db.close());

  const input = (targetSession: string) => ({
    policy: "idle-gate-qitem",
    specYaml:
      `policy: idle-gate-qitem\n` +
      `generated_by: openrig-daemon\n` +
      `target:\n  session: ${targetSession}\n` +
      `interval_seconds: 60\n` +
      `scan_interval_seconds: 60\n` +
      `active_wake_interval_seconds: 900\n`,
    targetSession,
    intervalSeconds: 60,
    scanIntervalSeconds: 60,
    activeWakeIntervalSeconds: 900,
    registeredBySession: "daemon@kernel",
    targetGenerationUuid: null,
  });

  function ensureFn() {
    const ensure = (repo as unknown as {
      ensureAutoRegistration?: (
        value: ReturnType<typeof input>,
        historicalTargetSessions?: string[],
      ) => ReturnType<WatchdogJobsRepository["register"]>;
    }).ensureAutoRegistration;
    expect(ensure, "repository must expose the state-aware W2c exact-tuple ensure").toBeTypeOf("function");
    return ensure!.bind(repo);
  }

  it("复用唯一 active 行，并在 handover 中保留 role-bound daemon 身份", () => {
    const first = repo.register(input("active@rig"));
    const ensured = ensureFn()(input("active@rig"));
    expect(ensured.jobId).toBe(first.jobId);
    expect(ensured).toMatchObject({
      state: "active",
      registeredBySession: "daemon@kernel",
      registeredByGeneration: null,
      targetGeneration: null,
    });
    expect(repo.dropArmedByRegisteringGeneration("retiring-generation")).toBe(0);
    expect(repo.getById(first.jobId)?.state).toBe("active");
  });

  it("保留唯一 stopped 行作为操作者退出选择", () => {
    const stopped = repo.register(input("stopped@rig"));
    repo.stop(stopped.jobId, "operator_stopped");
    const ensured = ensureFn()(input("stopped@rig"));
    expect(ensured.jobId).toBe(stopped.jobId);
    expect(ensured.state).toBe("stopped");
    expect(repo.listAll().filter((job) => job.targetSession === "stopped@rig")).toHaveLength(1);
  });

  it("仅有 terminal 历史时创建一个替代项，后续 ensure 复用它", () => {
    const terminal = repo.register(input("terminal@rig"));
    repo.markTerminal(terminal.jobId, "completed");
    const ensure = ensureFn();
    const replacement = ensure(input("terminal@rig"));
    expect(replacement.jobId).not.toBe(terminal.jobId);
    expect(replacement.state).toBe("active");
    expect(ensure(input("terminal@rig")).jobId).toBe(replacement.jobId);
    expect(repo.listAll().filter((job) => job.targetSession === "terminal@rig")).toHaveLength(2);
  });

  it("检查完整历史：较旧 active 加较新 terminal 时复用 active 行", () => {
    const active = repo.register(input("history@rig"));
    const terminal = repo.register(input("history@rig"));
    repo.markTerminal(terminal.jobId, "较新的 terminal 历史");
    const ensured = ensureFn()(input("history@rig"));
    expect(ensured.jobId).toBe(active.jobId);
    expect(repo.listAll().filter((job) => job.targetSession === "history@rig")).toHaveLength(2);
  });

  it("每种含糊的非终止基数都会明确失败，并列出全部任务 id 和状态", () => {
    const scenarios = [
      { target: "two-active@rig", states: ["active", "active"] as const },
      { target: "two-stopped@rig", states: ["stopped", "stopped"] as const },
      { target: "active-stopped@rig", states: ["active", "stopped"] as const },
    ];
    const ensure = ensureFn();

    for (const scenario of scenarios) {
      const rows = scenario.states.map((state) => {
        const row = repo.register(input(scenario.target));
        if (state === "stopped") repo.stop(row.jobId, "operator_stopped");
        return repo.getByIdOrThrow(row.jobId);
      });
      try {
        ensure(input(scenario.target));
        throw new Error("预期含糊的自动注册会失败");
      } catch (error) {
        expect(error).toBeInstanceOf(WatchdogJobsError);
        expect((error as WatchdogJobsError).code).toBe("auto_registration_ambiguous");
        expect((error as WatchdogJobsError).details).toMatchObject({
          targetSession: scenario.target,
          rows: expect.arrayContaining(rows.map((row) => ({ jobId: row.jobId, state: row.state }))),
        });
      }
      expect(repo.listAll().filter((job) => job.targetSession === scenario.target)).toHaveLength(2);
    }
  });

  it.each(["active", "stopped"] as const)(
    "重新定向唯一的 %s role-bound 历史别名，而不改变任务身份",
    (state) => {
      const old = repo.register(input("old-seat@rig"));
      if (state === "stopped") repo.stop(old.jobId, "operator_stopped");
      const ensured = ensureFn()(input("new-seat@rig"), ["old-seat@rig", "new-seat@rig"]);
      expect(ensured).toMatchObject({ jobId: old.jobId, state, targetSession: "new-seat@rig" });
      expect(ensured.specYaml).toContain("session: new-seat@rig");
      expect(ensured.specYaml).not.toContain("session: old-seat@rig");
      expect(repo.listAll().filter((job) => job.state !== "terminal")).toHaveLength(1);
    },
  );

  it("拒绝跨历史别名的冲突，并在结构化详情中列出每一行", () => {
    const old = repo.register(input("old-seat@rig"));
    const current = repo.register(input("new-seat@rig"));
    try {
      ensureFn()(input("new-seat@rig"), ["old-seat@rig", "new-seat@rig"]);
      throw new Error("预期发生别名冲突");
    } catch (error) {
      expect(error).toBeInstanceOf(WatchdogJobsError);
      expect((error as WatchdogJobsError).code).toBe("auto_registration_ambiguous");
      expect((error as WatchdogJobsError).details).toMatchObject({
        targetSession: "new-seat@rig",
        rows: expect.arrayContaining([
          { jobId: old.jobId, state: "active" },
          { jobId: current.jobId, state: "active" },
        ]),
      });
    }
  });

  it("仅有 terminal 别名历史时为当前 seat 创建一个替代项", () => {
    const old = repo.register(input("old-seat@rig"));
    repo.markTerminal(old.jobId, "completed");
    const replacement = ensureFn()(input("new-seat@rig"), ["old-seat@rig", "new-seat@rig"]);
    expect(replacement).toMatchObject({ state: "active", targetSession: "new-seat@rig" });
    expect(replacement.jobId).not.toBe(old.jobId);
    expect(repo.listAll()).toHaveLength(2);
  });

  it("拒绝 active、stopped 和 terminal 之外的任何持久化状态", () => {
    const invalid = repo.register(input("paused@rig"));
    db.prepare("UPDATE watchdog_jobs SET state = 'paused' WHERE job_id = ?").run(invalid.jobId);
    try {
      ensureFn()(input("paused@rig"));
      throw new Error("预期拒绝无效状态");
    } catch (error) {
      expect(error).toBeInstanceOf(WatchdogJobsError);
      expect((error as WatchdogJobsError).code).toBe("auto_registration_state_invalid");
      expect((error as WatchdogJobsError).details).toMatchObject({
        targetSession: "paused@rig",
        rows: [{ jobId: invalid.jobId, state: "paused" }],
      });
    }
  });
});
