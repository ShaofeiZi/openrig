import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  ContinuityPolicyMaterializer,
  armContinuityPolicy,
  createContinuityCutoverBaton,
  materializeContinuityPolicy,
  recordManagedWidthReceipt,
} from "../src/domain/continuity-policy-materializer.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { parseWatchdogSpec } from "../src/domain/watchdog-policy-engine.js";

const CLAUDE_SEAT = {
  compactionStrategy: "apprentice-handover" as const,
  runtime: "claude-code",
  targetSession: "advice-lead@rig",
  watchedFilePath: "/tmp/advice-lead.jsonl",
  mechanic: "operator-agent@kernel",
};

describe("连续性策略实现器 (S20 P4)", () => {
  it("将学徒策略具体化为两个经过校准的看门狗注册", () => {
    const plan = materializeContinuityPolicy(CLAUDE_SEAT);

    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs.every((job) => job.policy === "context-usage-threshold")).toBe(true);
    expect(plan.jobs.map((job) => job.key)).toEqual(["prepare", "cutover"]);
    expect(plan.jobs[1]?.requiresKey).toBe("prepare");
    expect(plan.jobs[0]!.thresholdBytes).toBeLessThan(plan.jobs[1]!.thresholdBytes);
    expect(plan.jobs[0]!.thresholdBytes).toBeGreaterThan(0);
    expect(plan.docText).toMatch(/每 MB 113K–153K token/);
    expect(plan.docText).toMatch(/余量就是保护/i);
  });

  it("将符号 requires 层级转换为首个持久任务 ID", () => {
    const register = vi
      .fn()
      .mockReturnValueOnce({ jobId: "prepare-job" })
      .mockReturnValueOnce({ jobId: "cutover-job" });

    const armed = armContinuityPolicy(CLAUDE_SEAT, { register });

    expect(armed.map((job) => job.jobId)).toEqual(["prepare-job", "cutover-job"]);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[0]![0]).toMatchObject({
      policy: "context-usage-threshold",
      requiresJobId: null,
    });
    expect(register.mock.calls[1]![0]).toMatchObject({
      policy: "context-usage-threshold",
      requiresJobId: "prepare-job",
    });
  });

  it("重新启动时复用完整的非终态实体化组合而不重复创建", () => {
    const register = vi.fn();
    const plan = materializeContinuityPolicy(CLAUDE_SEAT);
    const existing = [
      {
        jobId: "prepare-job",
        state: "active" as const,
        terminalReason: null,
        specYaml: plan.jobs[0]!.specYaml,
        requiresJobId: null,
        watchedFilePath: plan.jobs[0]!.watchedFilePath ?? null,
        thresholdBytes: plan.jobs[0]!.thresholdBytes ?? null,
        intervalSeconds: plan.jobs[0]!.intervalSeconds,
        activeWakeIntervalSeconds: plan.jobs[0]!.activeWakeIntervalSeconds ?? null,
        scanIntervalSeconds: plan.jobs[0]!.scanIntervalSeconds ?? null,
        registeredBySession: plan.jobs[0]!.registeredBySession,
      },
      {
        jobId: "cutover-job",
        state: "stopped" as const,
        terminalReason: "operator_stopped",
        specYaml: plan.jobs[1]!.specYaml,
        requiresJobId: "prepare-job",
        watchedFilePath: plan.jobs[1]!.watchedFilePath ?? null,
        thresholdBytes: plan.jobs[1]!.thresholdBytes ?? null,
        intervalSeconds: plan.jobs[1]!.intervalSeconds,
        activeWakeIntervalSeconds: plan.jobs[1]!.activeWakeIntervalSeconds ?? null,
        scanIntervalSeconds: plan.jobs[1]!.scanIntervalSeconds ?? null,
        registeredBySession: plan.jobs[1]!.registeredBySession,
      },
    ];

    expect(armContinuityPolicy(CLAUDE_SEAT, {
      register,
      listExactTuple: () => existing,
    }).map((job) => job.jobId)).toEqual(["prepare-job", "cutover-job"]);
    expect(register).not.toHaveBeenCalled();
  });

  it("将持久产生的就业机会与当前政策相协调，而无需重新激活确切停止的形状", () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      let jobs = new WatchdogJobsRepository(db);
      const original = armContinuityPolicy(CLAUDE_SEAT, jobs);
      expect(original).toHaveLength(2);

      jobs = new WatchdogJobsRepository(db);
      const changedInput = {
        ...CLAUDE_SEAT,
        mechanic: "new-mechanic@kernel",
        tokensPerMegabyte: 113_000,
      };
      const changed = armContinuityPolicy(changedInput, jobs);
      const changedRows = changed.map((job) => jobs.getByIdOrThrow(job.jobId));
      expect(changedRows).toHaveLength(2);
      expect(changedRows.map((job) => job.specYaml).join("\n")).toContain("new-mechanic@kernel");
      expect(changedRows.map((job) => job.thresholdBytes)).toEqual([5_309_734, 7_964_601]);
      expect(jobs.listActive()).toHaveLength(2);
      expect(jobs.listActive().map((job) => job.specYaml).join("\n")).not.toContain("operator-agent@kernel");
      expect(original.map((job) => jobs.getByIdOrThrow(job.jobId))).toEqual([
        expect.objectContaining({ state: "terminal", terminalReason: "continuity_policy_reconciled" }),
        expect.objectContaining({ state: "terminal", terminalReason: "continuity_policy_reconciled" }),
      ]);

      const stoppedCutover = changedRows.find((job) => job.requiresJobId !== null)!;
      jobs.stop(stoppedCutover.jobId, "operator_stopped");
      jobs = new WatchdogJobsRepository(db);
      expect(armContinuityPolicy(changedInput, jobs).map((job) => job.jobId)).toEqual(
        changed.map((job) => job.jobId),
      );
      expect(jobs.getByIdOrThrow(stoppedCutover.jobId)).toMatchObject({
        state: "stopped",
        terminalReason: "operator_stopped",
      });

      jobs = new WatchdogJobsRepository(db);
      const managed = armContinuityPolicy({
        ...CLAUDE_SEAT,
        compactionStrategy: "managed-compaction",
        mechanic: undefined,
      }, jobs);
      expect(managed).toHaveLength(1);
      expect(jobs.listActive()).toHaveLength(1);
      expect(jobs.listActive()[0]!.specYaml).toContain("continuity_mode: managed-compaction");

      jobs = new WatchdogJobsRepository(db);
      expect(armContinuityPolicy({
        ...CLAUDE_SEAT,
        compactionStrategy: "default-compaction",
      }, jobs)).toEqual([]);
      expect(jobs.listActive()).toEqual([]);

      for (const zeroJobInput of [
        { ...CLAUDE_SEAT, compactionStrategy: "handover" as const },
        { ...CLAUDE_SEAT, runtime: "codex" },
      ]) {
        jobs = new WatchdogJobsRepository(db);
        expect(armContinuityPolicy({
          ...CLAUDE_SEAT,
          compactionStrategy: "managed-compaction",
          mechanic: undefined,
        }, jobs)).toHaveLength(1);
        jobs = new WatchdogJobsRepository(db);
        expect(armContinuityPolicy(zeroJobInput, jobs)).toEqual([]);
        expect(jobs.listActive()).toEqual([]);
      }
    } finally {
      db.close();
    }
  });

  it("跨重启通过产品实体化器对账零任务转换", () => {
    const db = new Database(":memory:");
    const { watchedFilePath, ...claudeSeat } = CLAUDE_SEAT;
    try {
      migrate(db, ALL_MIGRATIONS);
      for (const next of [
        { compactionStrategy: "default-compaction" as const, runtime: "claude-code" },
        { compactionStrategy: "handover" as const, runtime: "claude-code" },
        { compactionStrategy: "managed-compaction" as const, runtime: "codex" },
      ]) {
        let jobs = new WatchdogJobsRepository(db);
        const original = new ContinuityPolicyMaterializer(jobs, () => watchedFilePath).arm({
          ...claudeSeat,
          sessionId: "original-session",
        });
        expect(original).toHaveLength(2);

        jobs = new WatchdogJobsRepository(db);
        const resolveWatchedFilePath = vi.fn(() => watchedFilePath);
        expect(new ContinuityPolicyMaterializer(jobs, resolveWatchedFilePath).arm({
          ...claudeSeat,
          ...next,
          sessionId: "replacement-session",
        })).toEqual([]);
        expect(resolveWatchedFilePath).not.toHaveBeenCalled();
        expect(jobs.listActive()).toEqual([]);
        expect(original.map((job) => jobs.getByIdOrThrow(job.jobId))).toEqual([
          expect.objectContaining({ state: "terminal", terminalReason: "continuity_policy_reconciled" }),
          expect.objectContaining({ state: "terminal", terminalReason: "continuity_policy_reconciled" }),
        ]);
      }
    } finally {
      db.close();
    }
  });

  it("通过看门狗引擎的真实规范解析器序列化两条触发通知", () => {
    const parsed = materializeContinuityPolicy(CLAUDE_SEAT).jobs.map(
      (job) => parseWatchdogSpec(job.specYaml),
    );
    const messages = parsed.map((spec) => spec.message);

    expect(messages[0]).toContain("continuity/apprentice-prepare.md");
    expect(messages[1]).toContain("continuity/apprentice-cutover.md");
    expect(messages.every((message) => message !== "|")).toBe(true);
    expect(parsed[1]?.context).toMatchObject({
      continuity_action: {
        type: "create-cutover-baton",
        destination: "operator-agent@kernel",
        body: expect.stringContaining("authority-effective-at-effect-receipt"),
      },
    });
  });

  it("武器管理压实正是一种真正的预助推登记", () => {
    const plan = materializeContinuityPolicy({
      ...CLAUDE_SEAT,
      compactionStrategy: "managed-compaction",
      mechanic: undefined,
    });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]).toMatchObject({
      key: "prepare",
      requiresKey: null,
      policy: "context-usage-threshold",
    });
    const parsed = parseWatchdogSpec(plan.jobs[0]!.specYaml);
    expect(parsed.message).toMatch(/deposit-before-compaction|recap-write/i);
    expect(parsed.context).not.toHaveProperty("continuity_action");
    expect(plan.docText).toMatch(/每 MB 113K–153K token/);
    expect(plan.docText).toMatch(/重新调整/i);
  });

  it("首个 transcript 样本尚未到达时，将生成任务登记为 pending", () => {
    const apprentice = materializeContinuityPolicy({
      ...CLAUDE_SEAT,
      watchedFilePath: null,
    });
    const managed = materializeContinuityPolicy({
      ...CLAUDE_SEAT,
      compactionStrategy: "managed-compaction",
      mechanic: undefined,
      watchedFilePath: null,
    });

    expect(apprentice.jobs).toHaveLength(2);
    expect(managed.jobs).toHaveLength(1);
    expect([...apprentice.jobs, ...managed.jobs].every((job) => job.watchedFilePath === null)).toBe(true);
  });

  it("在一次交付重试中创建一个一代键控的 QueueRepository 接力棒", async () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
      const action = {
        type: "create-cutover-baton" as const,
        jobId: "cutover-job",
        occupantGeneration: "target-generation-7",
        sourceSession: "target@rig",
        destination: "mechanic@kernel",
        body: "Owned cutover baton; one-active-walker; authority-effective-at-effect-receipt.",
      };

      const first = await createContinuityCutoverBaton(action, queue);
      const retry = await createContinuityCutoverBaton(action, queue);

      expect(retry.qitemId).toBe(first.qitemId);
      expect(queue.getById(first.qitemId)).toMatchObject({
        sourceSession: "target@rig",
        destinationSession: "mechanic@kernel",
        body: expect.stringContaining("authority-effective-at-effect-receipt"),
      });
      expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE qitem_id = ?")
        .get(first.qitemId) as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("在 S06 任务及目标代际上写入如实反映饱和度的托管宽度回执", () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      const jobs = new WatchdogJobsRepository(db, undefined, () => "target-generation-7");
      const history = new WatchdogHistoryLog(db);
      const job = jobs.register({
        policy: "context-usage-threshold",
        specYaml:
          "policy: context-usage-threshold\n" +
          "generated_by: continuity-policy-materializer\n" +
          "continuity_mode: managed-compaction\n" +
          "target:\n  session: target@rig\n" +
          "message: Deposit continuity context before managed compaction.\n",
        targetSession: "target@rig",
        intervalSeconds: 60,
        registeredBySession: "daemon@kernel",
        watchedFilePath: "/tmp/target.jsonl",
        thresholdBytes: 8,
      });

      const result = recordManagedWidthReceipt({
        sessionName: "target@rig",
        occupantGeneration: "target-generation-7",
        postRestoreUsedPercentage: 93,
        saturationBoundPercentage: 80,
        evaluatedAt: "2026-08-30T02:00:00.000Z",
      }, jobs, history);

      expect(result).toMatchObject({
        jobId: job.jobId,
        receipt: {
          postRestoreUsableWidthPercentage: 7,
          widthRecovered: false,
          reason: "restore_replayed_past_saturation_bound",
        },
      });
      expect(history.listForJob(job.jobId)).toEqual([
        expect.objectContaining({
          outcome: "skipped",
          skipReason: "post_restore_width_receipt",
          evaluationNotes: expect.objectContaining({
            occupantGeneration: "target-generation-7",
            widthRecovered: false,
            reason: "restore_replayed_past_saturation_bound",
          }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("当不存在 S06 接收密钥时，单独保留非托管压缩", () => {
    const record = vi.fn();
    expect(recordManagedWidthReceipt({
      sessionName: "default-seat@rig",
      occupantGeneration: "generation-1",
      postRestoreUsedPercentage: 20,
      saturationBoundPercentage: 80,
    }, {
      register: vi.fn(),
      listExactTuple: () => [],
    }, { record })).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it("未声明 mechanic 时拒绝启用 apprentice，并提示精确修复方式", () => {
    expect(() => materializeContinuityPolicy({
      ...CLAUDE_SEAT,
      mechanic: undefined,
    })).toThrow(/mechanic.*spec-default.*profile.*成员.*continuity\/apprentice-cutover\.md/i);
  });

  it("仅正向匹配 Claude，并保留本机/默认模式未武装", () => {
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, runtime: "codex" }).jobs).toEqual([]);
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, compactionStrategy: "default-compaction" }).jobs).toEqual([]);
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, compactionStrategy: "handover" }).jobs).toEqual([]);
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, compactionStrategy: "managed-compaction" }).jobs).toHaveLength(1);
  });

  it("只添加登记接线，绝不增加第二套计时器、调度器或引擎", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/domain/continuity-policy-materializer.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/setInterval|setTimeout|new\s+\w*Scheduler|cron/i);
    expect(source).toMatch(/jobsRepository\.register|registrar\.register/);
  });
});
