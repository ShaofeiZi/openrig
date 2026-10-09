// OPR.0.4.6.WF1 FR-5（G3）：真实幂等性——通过 guard 批准的完整关闭意图身份
//（G-WF1-1）下的吸收机制，堵住 waiting-replay 漏洞，并加上乐观并发 version guard。
//
// guard 指定的测试集（ACK Rev-2 / plan commit 5）：
//   (a) blockedOn 不同       → 记录新 decision（新增 trail 行）
//   (b) resultNote 不同      → 记录新 decision
//   (c) actorSession 不同    → 记录新 decision
//   (d) closureEvidence 不同 → 记录新 decision
//   (e) 完全重放             → 被吸收：一条 trail 行，相同 outcome
//   (f) 终态重放             → 409 保持不变（FR-1c）
//
// Version guard：陈旧 writer（读取版本 N 后，另一 writer 提交 N+1）抛出结构化
// instance_version_conflict，列出 expected/actual，并回滚整个事务。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowInstanceError } from "../src/domain/workflow-instance-store.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";

const SPEC = `workflow:
  id: fr5-replay
  version: 1
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - worker@rig
    next:
      preferred_targets:
        - next@rig
  steps:
    - id: work
      actor_role: worker
      allowed_exits:
        - handoff
        - waiting
        - done
        - failed
    - id: follow
      actor_role: next
      allowed_exits:
        - done
`;

describe("FR-5：waiting-replay 吸收 + version guard", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      outboxEntriesSchema,
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 seam 为关闭式失败（MF2）——意图 nudge 的终态 close 需要同数据库 intent store，
    // 以持久化其唤醒动作。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-replay-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function instantiateAndPark(evidence?: Record<string, unknown>) {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "重放演练",
      createdBySession: "ops@rig",
    });
    const first = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      resultNote: "为等待关卡而停放",
      blockedOn: "gate-x",
      closureEvidence: evidence,
    });
    return { inst, first };
  }

  it("(e) 完全重放 → 被吸收：零写入、一条 trail 行、相同记录结果、version 不递增", async () => {
    const { inst, first } = await instantiateAndPark({ note: "evidence-1" });
    const versionAfterFirst = runtime.instanceStore.getByIdOrThrow(
      inst.instance.instanceId,
    ).version;
    const trailAfterFirst = runtime.trailLog.countForInstance(inst.instance.instanceId);

    const replay = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      resultNote: "为等待关卡而停放",
      blockedOn: "gate-x",
      closureEvidence: { note: "evidence-1" },
    });
    expect(replay.absorbedReplay).toBe(true);
    expect(replay.closureReason).toBe("waiting");
    expect(replay.nextQitemId).toBe(first.nextQitemId); // 两者都为 null
    // 零写入：一条 trail 行，version 不递增（可由数据库验证）。
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(
      trailAfterFirst,
    );
    expect(
      runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId).version,
    ).toBe(versionAfterFirst);
  });

  it("(e2) 生效 blocker 归一化：首次 park 无 blockedOn（默认为 external-gate），重放显式指定 external-gate → 仍精确匹配并被吸收", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "归一化演练",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
    });
    const replay = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      blockedOn: "external-gate",
    });
    expect(replay.absorbedReplay).toBe(true);
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(1);
  });

  const NEGATIVES: Array<{
    label: string;
    mutate: (base: {
      resultNote: string;
      blockedOn: string;
      actorSession: string;
      closureEvidence: Record<string, unknown>;
    }) => Partial<{
      resultNote: string;
      blockedOn: string;
      actorSession: string;
      closureEvidence: Record<string, unknown>;
    }>;
  }> = [
    { label: "(a) blockedOn 不同", mutate: () => ({ blockedOn: "gate-y" }) },
    { label: "(b) resultNote 不同", mutate: () => ({ resultNote: "重新 park：新原因" }) },
    { label: "(c) actorSession 不同", mutate: () => ({ actorSession: "worker-replacement@rig" }) },
    {
      label: "(d) closureEvidence 不同",
      mutate: () => ({ closureEvidence: { note: "evidence-2", extra: true } }),
    },
  ];

  for (const { label, mutate } of NEGATIVES) {
    it(`${label} → 通过正常写入路径记录新的合法 decision（第二条 trail 行、更新后的 decision），不吸收也不拒绝`, async () => {
      const { inst } = await instantiateAndPark({ note: "evidence-1" });
      const base = {
        resultNote: "为等待关卡而停放",
        blockedOn: "gate-x",
        actorSession: "worker@rig",
        closureEvidence: { note: "evidence-1" },
      };
      const changed = { ...base, ...mutate(base) };

      const second = await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "waiting",
        actorSession: changed.actorSession,
        resultNote: changed.resultNote,
        blockedOn: changed.blockedOn,
        closureEvidence: changed.closureEvidence,
      });
      expect(second.absorbedReplay).toBeUndefined();
      expect(second.closureReason).toBe("waiting");
      // 第二条 trail 行 + 更新后的已存储 decision。
      expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(2);
      const updated = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
      const decision = updated.lastContinuationDecision!;
      expect(decision.actorSession).toBe(changed.actorSession);
      expect(decision.resultNote).toBe(changed.resultNote);
      expect(decision.blockedOn).toBe(changed.blockedOn);
    });
  }

  it("(f) 终态重放 → 已发布的 frontier 409 保持不变（FR-1c；吸收机制不触碰终态 guard）", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "终态重放",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "worker@rig",
    });
    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "worker@rig",
      }),
    ).rejects.toMatchObject({ code: "packet_not_on_frontier" });
  });

  it("version guard：陈旧 writer（读取后另一 writer 推进 instance）抛出结构化 instance_version_conflict，并回滚整个事务", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "竞争演练",
      createdBySession: "ops@rig",
    });

    // Writer A 读取 instance 状态……
    const staleRead = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);

    // ……writer B 先提交一次推进（waiting park 递增 version）。
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      blockedOn: "gate-x",
    });
    const afterB = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(afterB.version).toBe(staleRead.version + 1);

    // Writer A 此时尝试使用陈旧 expected version 写入。
    let thrown: unknown;
    try {
      runtime.instanceStore.updateFrontier(
        inst.instance.instanceId,
        ["phantom-packet"],
        "active",
        { expectedVersion: staleRead.version },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowInstanceError);
    const conflict = thrown as WorkflowInstanceError;
    expect(conflict.code).toBe("instance_version_conflict");
    expect(conflict.details?.expectedVersion).toBe(staleRead.version);
    expect(conflict.details?.actualVersion).toBe(afterB.version);
    // guard 写入失败后没有任何变化。
    const final = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(final.currentFrontier).toEqual(afterB.currentFrontier);
    expect(final.version).toBe(afterB.version);
  });

  it("projector 的 version guard：project() 内读取陈旧 instance 会回滚整个 scribe 事务（无已关闭 packet、无 trail 行）", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "projector 竞争演练",
      createdBySession: "ops@rig",
    });

    // 模拟竞争：project() 读取 instance 后，另一个 writer 在 project() 事务运行前递增 version。
    const realGet = runtime.instanceStore.getByIdOrThrow.bind(runtime.instanceStore);
    const spy = vi
      .spyOn(runtime.instanceStore, "getByIdOrThrow")
      .mockImplementationOnce((id: string) => {
        const current = realGet(id);
        // 在本次陈旧读取后进行带外并发递增。
        db.prepare(
          `UPDATE workflow_instances SET version = version + 1 WHERE instance_id = ?`,
        ).run(id);
        return current; // 陈旧视图
      });

    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "worker@rig",
      }),
    ).rejects.toMatchObject({ code: "instance_version_conflict" });
    spy.mockRestore();

    // 整个事务回滚：packet 未关闭，无下一 qitem，无 trail 行。
    expect(queueRepo.getById(inst.entryQitemId)?.state).toBe("pending");
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(0);
    const qitemCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }
    ).n;
    expect(qitemCount).toBe(1); // 只有入口 packet
  });

  it("BR-2 保持成立：非 FR-5 拒绝仍抛出 WorkflowProjectorError（健全性：absorbed 与 rejected 是不同类别）", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "类别健全性",
      createdBySession: "ops@rig",
    });
    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: "not-a-real-packet",
        exit: "waiting",
        actorSession: "worker@rig",
      }),
    ).rejects.toBeInstanceOf(WorkflowProjectorError);
  });
});
