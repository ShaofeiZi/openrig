// P34——把终端关闭 writer 构建到 W1 原语之上。
//
// Lock: qitem-20260809110825-be056197 · SHAPE artifact 4f2b04c161a8da959c…f49f453a
// Pre-edit rev-2: 2f4710b1512baa41c0c4ed0de09af8fc39e6386378f28941d6d10e4cccd73345
// Guard CLEAR: qitem-20260809180349-634de805 (verdict 5ba491d7c31cf98b…d085f8)
//
// 核心点：W1 让"已执行但未唤醒"无法再*经队列自己的
// 终端动词*被写出。Mission Control、workflow-runtime 与 workflow-projector 的
// 关闭与创建发生在这些动词之外，故今日该波的前提只对一个 writer 成立，
// 对其余仅为检测。本测试集钉住这个扩展。
//
// ── RED 1（本文件首个增量）：当前缺口 ──────────────────────
// 每个受规约点都经真实 writer 驱动一次真实终端关闭 + 继任创建，挂上 intent
// 存储，并断言继任的唤醒 intent 是持久的。今日这些全部失败（intent 缺失，
// intents=0）——这个失败即捕获的缺口。装配落地后它们转绿。
//
// THE FIVE RULED SUCCESSOR SITES (planner ruling 17:57Z; guard CLEAR 18:03Z):
//   mission-control-write-contract.ts:174   (route / handoff)
//   workflow-projector.ts:466               (project → routes branch)
//   workflow-projector.ts:729               (project → failed branch — EXCLUSIVE
//                                            with :466; nextStatus="failed"
//                                            requires routes===false, :571-585)
//   workflow-runtime.ts:992                 (route)
//   workflow-runtime.ts:791                 (resume redrive)
//
// NOT A SITE, deliberately: workflow-runtime.ts:831 closes N exception items with
// closureReason "no-follow-on" and NO successor — a TERMINAL CLOSE WITH NO
// SUCCESSOR, the third state. It requires no intent, and pairing it with the :791
// packet would satisfy the assert against an unrelated successor: a check that can
// only pass. Its no-false-positive control is RED 4b (next increment).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import type { QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";

/** A two-step spec: the entry step hands off, so project(handoff) exercises the
 *  projector's ROUTES branch (:466). */
const SPEC = `workflow:
  id: p34-two-step
  version: 1
  objective: P34 terminal-closing writers
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - failed
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
      - failed
`;

interface Harness {
  db: Database.Database;
  bus: EventBus;
  repo: QueueRepository;
  outbox: OutboxHandler;
  runtime: WorkflowRuntime;
  mc: MissionControlWriteContract;
  specPath: string;
  tmp: string;
}

/** Every wake intent is keyed on its SUCCESSOR (queue-repository.ts:616). */
function intentFor(h: Harness, successorQitemId: string) {
  return h.outbox.getById(`wake-intent-${successorQitemId}`);
}

function makeHarness(): Harness {
  const db = createDb();
  migrate(db, [
    coreSchema,
    eventsSchema,
    queueItemsSchema,
    queueTransitionsSchema,
    outboxEntriesSchema,
    workflowSpecsSchema,
    workflowInstancesSchema,
    workflowStepTrailsSchema,
    missionControlActionsSchema,
    queueTargetRepoSchema,
    queueItemSummarySchema,
    queueItemEvidenceRefSchema,
  ]);
  db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  const bus = new EventBus(db);
  const outbox = new OutboxHandler(db);
  const transport: QueueNudgeTransport = {
    async send() {
      return { ok: true, verified: true };
    },
  };
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  repo.attachTransport(transport);
  // The intent store is ATTACHED on purpose: this suite asks whether the wiring
  // stages an intent, not whether the store exists. A harness without an outbox
  // could not tell "not staged" from "nowhere to stage it".
  repo.attachOutbox(outbox);
  const runtime = new WorkflowRuntime({
    db, eventBus: bus, queueRepo: repo,
    exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" },
  });
  const mc = new MissionControlWriteContract({
    db,
    eventBus: bus,
    queueRepo: repo,
    actionLog: new MissionControlActionLog(db),
  });
  const tmp = mkdtempSync(join(tmpdir(), "p34-"));
  const specPath = join(tmp, "spec.yaml");
  writeFileSync(specPath, SPEC);
  return { db, bus, repo, outbox, runtime, mc, specPath, tmp };
}

describe("P34 红色 1 — 当前未命中：终端关闭 + 后续创建阶段 无唤醒意图", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it("Mission-control-write-contract.ts:174 — 切换关闭源并创建具有持久唤醒意图的后继者", async () => {
    const source = await h.repo.create({
      sourceSession: "src@rig",
      destinationSession: "dst@rig",
      body: "work",
    });
    const result = await h.mc.act({
      verb: "handoff",
      qitemId: source.qitemId,
      actorSession: "human-operator@kernel",
      destinationSession: "next@rig",
    });

    // The terminal close actually happened — otherwise this test would pass
    // vacuously by asserting an intent for a close that never occurred.
    expect(h.repo.getById(source.qitemId)?.state).toBe("handed-off");
    expect(result.createdQitemId).toBeTruthy();

    expect(intentFor(h, result.createdQitemId!)).not.toBeNull();
  });

  it("workflow-projector.ts:466 — 项目（切换）ROUTES 分支暂存下一步数据包的唤醒意图", async () => {
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await h.runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
      resultNote: "produced",
    });

    expect(h.repo.getById(inst.entryQitemId)?.state).toBe("handed-off");
    expect(projected.nextQitemId).toBeTruthy();

    expect(intentFor(h, projected.nextQitemId!)).not.toBeNull();
  });

  it("workflow-projector.ts:729 — 项目（失败）FAILED 分支暂存异常项的唤醒意图", async () => {
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await h.runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "failed",
      actorSession: "producer@rig",
      resultNote: "blew up",
    });

    // 互斥性，钉住：nextStatus==="failed" 要求 routes===false
    //（workflow-projector.ts:571-585），故 failed 分支绝不也产出
    // next-step 包。:466 与 :729 是二选一，永不为两个继任。
    expect(projected.nextQitemId).toBeNull();

    // The exception item is the successor here. Asserting EXACTLY ONE match keeps
    // this a lookup of a known row rather than a discovery that could quietly
    // select the wrong one.
    const exceptionItems = h.db
      .prepare(`SELECT qitem_id FROM queue_items WHERE tags LIKE '%workflow-exception%'`)
      .all() as Array<{ qitem_id: string }>;
    expect(exceptionItems).toHaveLength(1);

    expect(intentFor(h, exceptionItems[0]!.qitem_id)).not.toBeNull();
  });

  it("workflow-runtime.ts:992 — 路由关闭旧的边界数据包并暂存重新路由的数据包的唤醒意图", async () => {
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const routed = await h.runtime.route({
      instanceId: inst.instance.instanceId,
      toSession: "reviewer@rig",
      actorSession: "ops@rig",
      reason: "owner swap",
    });

    expect(h.repo.getById(routed.closedPacketId)?.state).toBe("handed-off");

    expect(intentFor(h, routed.newPacketId)).not.toBeNull();
  });

  it("workflow-runtime.ts:791 — 恢复重新驱动阶段新数据包的唤醒意图（永远不会关闭异常）", async () => {
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    await h.runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "failed",
      actorSession: "producer@rig",
      resultNote: "blew up",
    });
    const resumed = await h.runtime.resume({
      instanceId: inst.instance.instanceId,
      decision: "redrive it",
      actorSession: "ops@rig",
    });

    // The redrive packet is the ONLY successor in this transaction. The N
    // exception closes at :831 have no successor of their own.
    expect(resumed.exceptionItemsClosed).toBeGreaterThan(0);

    expect(intentFor(h, resumed.newPacketId)).not.toBeNull();
  });
});

// ── THE CONTROLS ──────────────────────────────────────────────────────────────
// RED 1 证明装配工作。这些证明它正确地失败——这是决定原子诚实还是仅变绿的
// 另一半。一个谴责正确调用方的守卫一小时内就会被回滚；一个什么都不检查的守卫
// 和检查一切的守卫报同样的绿。

describe("P34 RED 4 — 无假阳性：PARK 不是封闭且不需要任何意图", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); rmSync(h.tmp, { recursive: true, force: true }); });

  it("任务控制“保持”停放物品并表现出无意图 - 停放路径未受影响", async () => {
    const source = await h.repo.create({
      sourceSession: "src@rig",
      destinationSession: "dst@rig",
      body: "work",
    });
    await h.mc.act({
      verb: "hold",
      qitemId: source.qitemId,
      actorSession: "human@rig",
      reason: "external-gate",
    });

    const parked = h.repo.getById(source.qitemId);
    expect(parked?.state).toBe("blocked");
    // 非终态 ⇒ 无物可唤醒。这从原语本身推出（它在非终态、事务可见的源上
    // 提前返回），而非从调用点写的条件推出——这就是没有 park 点需要改动的原因。
    expect(intentFor(h, source.qitemId)).toBeNull();
  });

  it("人为门控的工作流程入口 PARKS in-txn 不会绊倒接缝", async () => {
    // The gate park is an in-transaction update on a freshly created packet — the
    // shape most likely to be mistaken for a closure by an update-keyed guard.
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    expect(h.repo.getById(inst.entryQitemId)?.state).toBe("pending");
    expect(intentFor(h, inst.entryQitemId)).toBeNull();
  });
});

describe("P34 红色 4b — 无误报：无后继者的终端关闭不需要任何意图", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); rmSync(h.tmp, { recursive: true, force: true }); });

  it("任务控制“批准”关闭完成/无后续，没有后继者 - 没有意图，没有抛出", async () => {
    const source = await h.repo.create({
      sourceSession: "src@rig",
      destinationSession: "dst@rig",
      body: "work",
    });
    // This is THE THIRD STATE. Not a park (it IS terminal) and not a paired
    // closure (there is no successor). A guard keyed on "terminal close" alone —
    // rather than on "terminal close + a create in the same txn" — would fire here
    // and condemn correct code, one state over from the park case.
    const result = await h.mc.act({
      verb: "approve",
      qitemId: source.qitemId,
      actorSession: "human@rig",
    });

    expect(h.repo.getById(source.qitemId)?.state).toBe("done");
    expect(h.repo.getById(source.qitemId)?.closureReason).toBe("no-follow-on");
    expect(result.createdQitemId).toBeNull();
    expect(intentFor(h, source.qitemId)).toBeNull();
  });

  it("恢复路径的异常关闭没有自己的意图", async () => {
    const inst = await h.runtime.instantiate({
      specPath: h.specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    await h.runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "failed",
      actorSession: "producer@rig",
      resultNote: "blew up",
    });
    const exceptionIds = (
      h.db.prepare(`SELECT qitem_id FROM queue_items WHERE tags LIKE '%workflow-exception%'`)
        .all() as Array<{ qitem_id: string }>
    ).map((r) => r.qitem_id);
    expect(exceptionIds.length).toBeGreaterThan(0);

    // The assertion is on the DELTA, not on absence. Each exception item already
    // HAS an intent — it was itself a successor when :729 created it. What must be
    // true is that terminally CLOSING it adds no new one: the close has no
    // successor, so there is nothing to wake.
    const idsBefore = new Set(
      (h.db.prepare(`SELECT outbox_id FROM outbox_entries`).all() as Array<{ outbox_id: string }>)
        .map((r) => r.outbox_id),
    );

    const resumed = await h.runtime.resume({
      instanceId: inst.instance.instanceId,
      actorSession: "ops@rig",
    });

    for (const id of exceptionIds) {
      expect(h.repo.getById(id)?.state).toBe("done");
    }
    const idsAfter = (
      h.db.prepare(`SELECT outbox_id FROM outbox_entries`).all() as Array<{ outbox_id: string }>
    ).map((r) => r.outbox_id);
    const added = idsAfter.filter((id) => !idsBefore.has(id));

    // EXACTLY ONE new intent, and it belongs to the redrive packet — never to any
    // of the N closes. If the closes were each paired with the redrive packet as
    // "their" successor, this count would still be one and the test would pass
    // vacuously, which is why it also names WHICH id was added.
    expect(added).toEqual([`wake-intent-${resumed.newPacketId}`]);
  });
});

describe("P34 — NO DOUBLE SEND：暂存意图已最终确定，因此恢复无法重新发送它", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => { h.db.close(); rmSync(h.tmp, { recursive: true, force: true }); });

  it("在连线关闭+创建之后，意图行已完成并且恢复耗尽不会提供任何内容", async () => {
    const source = await h.repo.create({
      sourceSession: "src@rig",
      destinationSession: "dst@rig",
      body: "work",
    });
    const result = await h.mc.act({
      verb: "handoff",
      qitemId: source.qitemId,
      actorSession: "human@rig",
      destinationSession: "next@rig",
    });

    // The defect this pins: maybeNudge SENDS without claiming or finalizing, so the
    // row would still read `pending` and the startup sweep would deliver the same
    // wake a SECOND time. Delivering through the shared path finalizes it.
    const intent = intentFor(h, result.createdQitemId!);
    expect(intent).not.toBeNull();
    expect(intent!.deliveryState).not.toBe("pending");

    const drained = await h.repo.drainPendingWakeIntents();
    expect(drained.delivered).toBe(0);
    expect(drained.indeterminate).toBe(0);
    expect(drained.failed).toBe(0);
  });
});

describe("P34 — 后备控制：无意图存储 ⇒ 唤醒仍然发生", () => {
  it("没有附加发件箱的作家仍然会轻推，并且不会默默地跳过", async () => {
    // docstring 承诺了这个回退；代码并未实现它（deliverWakeIntent 在无存储时
    // 返回 "skipped"，而 skip 不是错误，故消失的 nudge 无处浮现）。这就是本可
    // 捕获它的对照。
    const h = makeHarness();
    try {
      const sends: string[] = [];
      const repoNoOutbox = new QueueRepository(h.db, h.bus, { validateRig: () => true });
      repoNoOutbox.attachTransport({
        async send(session: string) {
          sends.push(session);
          return { ok: true, verified: true };
        },
      });
      // Deliberately NO attachOutbox — the test/bootstrap shape.
      const created = await repoNoOutbox.create({
        sourceSession: "src@rig",
        destinationSession: "dst@rig",
        body: "work",
      });
      // create() nudges its destination on its own. Isolate the fallback's send,
      // or this control would pass on the create's nudge alone and prove nothing
      // about deliverWakeForSuccessor.
      sends.length = 0;

      await repoNoOutbox.deliverWakeForSuccessor(created.qitemId, "dst@rig", undefined, "src@rig");

      // Exactly one send, from the fallback itself. Before P34 this was ZERO:
      // deliverWakeIntent returned "skipped" with no store attached.
      expect(sends).toEqual(["dst@rig"]);
    } finally {
      h.db.close();
      rmSync(h.tmp, { recursive: true, force: true });
    }
  });
});
