import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import {
  MissionControlWriteContract,
  MissionControlWriteContractError,
} from "../src/domain/mission-control/mission-control-write-contract.js";

describe("MissionControlWriteContract（PL-005 阶段 A；原子的 7 个动词）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let actionLog: MissionControlActionLog;
  let writeContract: MissionControlWriteContract;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      missionControlActionsSchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    actionLog = new MissionControlActionLog(db);
    writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
  });

  afterEach(() => db.close());

  async function seedQitem(): Promise<string> {
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "dst@rig",
      body: "测试工作",
      tier: "human-gate",
      summary: "测试摘要（FR-4 人员路由 fixture）",
      evidenceRef: "proof/test-evidence.md",
    });
    return created.qitemId;
  }

  it("approve 以 closure_reason=no-follow-on 关闭 qitem，并记录审计、发出事件", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const qitemId = await seedQitem();
    const result = await writeContract.act({
      verb: "approve",
      qitemId,
      actorSession: "human-operator@kernel",
    });
    expect(result.actionId).toMatch(/^[0-9A-Z]{26}$/);
    expect(queueRepo.getById(qitemId)?.state).toBe("done");
    expect(queueRepo.getById(qitemId)?.closureReason).toBe("no-follow-on");
    expect(actionLog.listForQitem(qitemId)).toHaveLength(1);
    expect(actionLog.listForQitem(qitemId)[0]?.actionVerb).toBe("approve");
    expect(events.some((e) => e.type === "mission_control.action_executed")).toBe(true);
    expect(events.some((e) => e.type === "queue.updated")).toBe(true);
  });

  it("deny 以 closure_reason=denied 关闭 qitem", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({
      verb: "deny",
      qitemId,
      actorSession: "human@r",
      reason: "范围错误",
    });
    expect(queueRepo.getById(qitemId)?.closureReason).toBe("denied");
  });

  it("hold 将 qitem 转换为 blocked，并设置 closure_reason=blocked_on 及 blocked_on 列", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({
      verb: "hold",
      qitemId,
      actorSession: "human@r",
      reason: "external-gate-x",
    });
    const closed = queueRepo.getById(qitemId);
    expect(closed?.state).toBe("blocked");
    expect(closed?.closureReason).toBe("blocked_on");
    expect(closed?.blockedOn).toBe("external-gate-x");
  });

  it("drop 以 closure_reason=canceled 关闭 qitem", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({
      verb: "drop",
      qitemId,
      actorSession: "human@r",
      reason: "陈旧工作",
    });
    expect(queueRepo.getById(qitemId)?.closureReason).toBe("canceled");
  });

  it("handoff 是原子的四步操作：源关闭、目标创建、审计和事件位于同一事务", async () => {
    const qitemId = await seedQitem();
    const result = await writeContract.act({
      verb: "handoff",
      qitemId,
      actorSession: "human@r",
      destinationSession: "next@r",
      notify: false,
    });
    expect(result.createdQitemId).not.toBeNull();
    const closed = queueRepo.getById(qitemId);
    expect(closed?.state).toBe("handed-off");
    expect(closed?.closureReason).toBe("handed_off_to");
    expect(closed?.handedOffTo).toBe("next@r");
    const created = queueRepo.getById(result.createdQitemId!);
    expect(created?.destinationSession).toBe("next@r");
    expect(created?.state).toBe("pending");
  });

  it("route 与 handoff 对应，但为新数据包添加 mission-control:route 标签", async () => {
    const qitemId = await seedQitem();
    const result = await writeContract.act({
      verb: "route",
      qitemId,
      actorSession: "human@r",
      destinationSession: "other@r",
      notify: false,
    });
    expect(result.createdQitemId).not.toBeNull();
    const created = queueRepo.getById(result.createdQitemId!);
    expect(created?.tags).toContain("mission-control:route");
  });

  it("annotate 不更改队列，但会写入审计和事件", async () => {
    const qitemId = await seedQitem();
    const beforeState = queueRepo.getById(qitemId)?.state;
    await writeContract.act({
      verb: "annotate",
      qitemId,
      actorSession: "human@r",
      annotation: "操作者备注",
    });
    expect(queueRepo.getById(qitemId)?.state).toBe(beforeState); // 未改变
    const list = actionLog.listForQitem(qitemId);
    expect(list[0]?.actionVerb).toBe("annotate");
    expect(list[0]?.annotation).toBe("操作者备注");
  });

  it("annotate 拒绝未知 qitem，而不是创建幽灵审计行", async () => {
    const auditCountBefore = actionLog.countAll();
    try {
      await writeContract.act({
        verb: "annotate",
        qitemId: "qitem-missing",
        actorSession: "human@r",
        annotation: "操作者备注",
      });
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlWriteContractError);
      expect((err as MissionControlWriteContractError).code).toBe("qitem_not_found");
    }
    expect(actionLog.countAll()).toBe(auditCountBefore);
  });

  it("annotate 与其他 Mission Control 操作一样拒绝终止状态的 qitem", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({ verb: "approve", qitemId, actorSession: "human@r" });
    const auditCountBefore = actionLog.countAll();
    try {
      await writeContract.act({
        verb: "annotate",
        qitemId,
        actorSession: "human@r",
        annotation: "迟到的备注",
      });
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlWriteContractError);
      expect((err as MissionControlWriteContractError).code).toBe("qitem_already_terminal");
    }
    expect(actionLog.countAll()).toBe(auditCountBefore);
  });

  it("以 qitem_already_terminal 拒绝对终止条目的变更", async () => {
    const qitemId = await seedQitem();
    await writeContract.act({ verb: "approve", qitemId, actorSession: "human@r" });
    try {
      await writeContract.act({ verb: "approve", qitemId, actorSession: "human@r" });
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlWriteContractError);
      expect((err as MissionControlWriteContractError).code).toBe("qitem_already_terminal");
    }
  });

  it("拒绝缺少 destinationSession 的 route/handoff", async () => {
    const qitemId = await seedQitem();
    try {
      await writeContract.act({ verb: "handoff", qitemId, actorSession: "human@r" });
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(MissionControlWriteContractError);
      expect((err as MissionControlWriteContractError).code).toBe("destination_required");
    }
  });

  it("原子回滚：目标无效的 handoff 会回滚源关闭、审计和新 qitem", async () => {
    const failingRepo = new QueueRepository(db, bus, { validateRig: () => false });
    const failingContract = new MissionControlWriteContract({
      db,
      eventBus: bus,
      queueRepo: failingRepo,
      actionLog,
    });
    const qitemId = await seedQitem();
    const beforeState = queueRepo.getById(qitemId)?.state;
    const auditCountBefore = actionLog.countAll();
    const queueCountBefore = db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number };

    let threw = false;
    try {
      await failingContract.act({
        verb: "handoff",
        qitemId,
        actorSession: "human@r",
        destinationSession: "rejected@r",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // 回滚：源不变、无审计行、无孤立 qitem。
    expect(queueRepo.getById(qitemId)?.state).toBe(beforeState);
    expect(actionLog.countAll()).toBe(auditCountBefore);
    const queueCountAfter = db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number };
    expect(queueCountAfter.n).toBe(queueCountBefore.n);
  });
});

// OPR.0.4.4.19 FR-7 — resolve + unpark（数据包中唯一真正的设计单元）。
describe("resolve 动词（OPR.0.4.4.19 FR-7）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let actionLog: MissionControlActionLog;
  let writeContract: MissionControlWriteContract;
  let sentNudges: Array<{ session: string; text: string }>;
  let failTransport: boolean;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    sentNudges = [];
    failTransport = false;
    queueRepo = new QueueRepository(db, bus, {
      validateRig: () => true,
      transport: {
        send: async (session: string, text: string) => {
          if (failTransport) throw new Error("transport 已停止");
          sentNudges.push({ session, text });
          return { ok: true, verified: true };
        },
      },
    });
    actionLog = new MissionControlActionLog(db);
    writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
  });

  afterEach(() => db.close());

  async function parkedQitem(): Promise<string> {
    const created = await queueRepo.create({
      sourceSession: "orch@rig",
      destinationSession: "driver@rig",
      body: "构建目标",
      nudge: false,
    });
    queueRepo.claim({ qitemId: created.qitemId, destinationSession: "driver@rig" });
    queueRepo.update({
      qitemId: created.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: "human-review@kernel",
      summary: "要交付哪条时序规则？",
      evidenceRef: "missions/x/OPTIONS.md",
    });
    return created.qitemId;
  }

  it("成功路径：单一事务——blocked->in-progress、transition_note 中的决策与 actor、审计行、事件、携带决策文本的 owner 提醒；不关闭", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const qitemId = await parkedQitem();
    const decision = "按双 regime 规则交付；时序采用方案 B";

    const result = await writeContract.act({
      verb: "resolve",
      qitemId,
      actorSession: "human-review@kernel",
      decision,
    });

    const item = queueRepo.getById(qitemId)!;
    // 护栏 4：返回已停放 owner；所有权不变，不关闭。
    expect(item.state).toBe("in-progress");
    expect(item.destinationSession).toBe("driver@rig");
    expect(item.closureReason).toBeNull();
    // 护栏 2：决策文本可在转换日志中永久查询。
    const transitions = queueRepo.transitionLog.listForQitem(qitemId);
    const resolveTransition = transitions.find((t) => t.transitionNote === decision);
    expect(resolveTransition).toBeDefined();
    expect(resolveTransition!.actorSession).toBe("human-review@kernel");
    // 仅追加的审计行记录 resolve。
    const audits = actionLog.listForQitem(qitemId);
    expect(audits.some((a) => a.actionVerb === "resolve" && a.reason === decision)).toBe(true);
    // F-pre/P2 刷新契约：unpark 时发出 queue.updated。
    expect(events.some((e) => e.type === "queue.updated")).toBe(true);
    expect(events.some((e) => e.type === "mission_control.action_executed")).toBe(true);
    // Owner 提醒携带决策文本。
    expect(sentNudges).toHaveLength(1);
    expect(sentNudges[0]!.session).toBe("driver@rig");
    expect(sentNudges[0]!.text).toContain(decision);
    expect(result.createdQitemId).toBeNull(); // 绝不创建新任务
  });

  it("拒绝空白决策文本（执行对称性）", async () => {
    const qitemId = await parkedQitem();
    await expect(
      writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision: "   " })
    ).rejects.toMatchObject({ code: "decision_required" });
    await expect(
      writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel" })
    ).rejects.toMatchObject({ code: "decision_required" });
  });

  it("拒绝对非 parked qitem 执行 resolve，并说明预期的 park 结构", async () => {
    const created = await queueRepo.create({
      sourceSession: "a@rig", destinationSession: "b@rig", body: "x", nudge: false,
    });
    await expect(
      writeContract.act({ verb: "resolve", qitemId: created.qitemId, actorSession: "human@kernel", decision: "d" })
    ).rejects.toMatchObject({ code: "qitem_not_leg1_parked" });
  });

  it("拒绝对被另一个 qitem 阻塞的 qitem 执行 resolve（仅限 leg-1 结构）", async () => {
    const blocker = await queueRepo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "blocker", nudge: false });
    const item = await queueRepo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "x", nudge: false });
    queueRepo.update({ qitemId: item.qitemId, actorSession: "b@rig", state: "blocked", blockedOn: blocker.qitemId });
    await expect(
      writeContract.act({ verb: "resolve", qitemId: item.qitemId, actorSession: "human@kernel", decision: "d" })
    ).rejects.toMatchObject({ code: "qitem_not_leg1_parked" });
  });

  it("幂等性：再次 resolve 已解决条目会产生空操作错误，而非重复转换", async () => {
    const qitemId = await parkedQitem();
    await writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision: "first" });
    const transitionsAfterFirst = queueRepo.transitionLog.listForQitem(qitemId).length;
    await expect(
      writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision: "second" })
    ).rejects.toMatchObject({ code: "qitem_not_leg1_parked" });
    expect(queueRepo.transitionLog.listForQitem(qitemId)).toHaveLength(transitionsAfterFirst);
  });

  it("BR-8：即使 owner 提醒传输失败，resolve 仍会提交", async () => {
    const qitemId = await parkedQitem();
    failTransport = true;
    const result = await writeContract.act({
      verb: "resolve", qitemId, actorSession: "human@kernel", decision: "仍然提交",
    });
    expect(queueRepo.getById(qitemId)!.state).toBe("in-progress");
    // 通过现有 last_nudge_* 机制记录提醒结果。
    expect(queueRepo.getById(qitemId)!.lastNudgeResult).toMatch(/^failed:/);
    expect(result.notifyAttempted).toBe(true);
  });

  it("写入契约没有 resolve 的关闭映射：resolve 后 closure_reason 保持 null", async () => {
    const qitemId = await parkedQitem();
    await writeContract.act({ verb: "resolve", qitemId, actorSession: "human@kernel", decision: "d" });
    const item = queueRepo.getById(qitemId)!;
    expect(item.state).toBe("in-progress");
    expect(item.closureReason).toBeNull();
    expect(item.closureTarget).toBeNull();
  });
});
