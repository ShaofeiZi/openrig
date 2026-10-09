// OPR.0.4.6.WF5 FR-4：resume（重新驱动）——唯一的引擎扩展。
//
// 固定项：成功重新驱动（failed → active、重新绑定、新数据包、已完成步骤绝不重跑）、
// 架构固定点（通过投影解析器重新解析 owner——绝不从陈旧目标复制）、活锁护栏
//（resume 后 hop 窗口 + 已记录计数 + 如实生成的新 occurrence）、拒绝矩阵
//（active/waiting/completed 状态下的 resume）、occurrence 关闭 + resume 周期的新 occurrence
// 契约、决策持久性，以及 waiting-resume 回归固定点（已发布 waiting 路径不变——
// resume 拒绝它，project 继续处理它）。

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const SPEC = `workflow:
  id: wf5-resume-pipeline
  version: 1
  objective: WF-5 resume fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
    orch:
      preferred_targets:
        - orch-lead@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed
        - waiting
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
  exception_routing:
    orchestrator_role: orch
`;

const LOOP_SPEC = `workflow:
  id: wf5-resume-loop
  version: 1
  objective: WF-5 livelock-rail fixture
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
      next_hop:
        on:
          handoff: review
    - id: review
      actor_role: reviewer
      allowed_exits:
        - handoff
        - failed
      next_hop:
        on:
          handoff: produce
  loop_guards:
    max_hops: 2
`;


describe("WF-5 rev1-r2 B2：SSE 允许列表包含 workflow.resumed", () => {
  it("run/watch 跟随者实时接收 resume（源码固定点——沿用 WF-3 import-graph-pin 先例）", () => {
    const src = readFileSync(new URL("../src/routes/workflow.ts", import.meta.url), "utf8");
    const sseFilter = src.slice(src.indexOf("const sseHandler"), src.indexOf("app.get(\"/sse\""));
    expect(sseFilter).toContain('event.type !== "workflow.resumed"');
  });
});

describe("WF-5 FR-4：resume（重新驱动）", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;

  const build = () => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝采用闭合失败（MF2）——意图发送 nudge 的 terminal 关闭需要同数据库的
    // intent store，才能使唤醒持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" },
    });
  };

  const seed = (spec: string, name = "spec.yaml") => {
    tmp = tmp ?? mkdtempSync(join(tmpdir(), "wf5-resume-"));
    const specPath = join(tmp, name);
    writeFileSync(specPath, spec);
    return specPath;
  };

  const instantiateAndFail = async (specPath: string) => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "恢复演练",
      createdBySession: "ops@rig",
    });
    const packetId = inst.instance.currentFrontier[0]!;
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: packetId,
      exit: "failed",
      resultNote: "人为触发",
      actorSession: "producer@rig",
    });
    return { instanceId: inst.instance.instanceId, failedPacketId: packetId };
  };

  const trailCount = (instanceId: string) =>
    (db
      .prepare(`SELECT COUNT(*) AS n FROM workflow_step_trails WHERE instance_id = ?`)
      .get(instanceId) as { n: number }).n;

  afterEach(() => {
    db.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined as never;
  });

  it("成功重新驱动：failed → active，重新绑定失败步骤，向 owner 发送新数据包，保留 trail 且不重跑，关闭 occurrence 并记录次数", async () => {
    build();
    const { instanceId, failedPacketId } = await instantiateAndFail(seed(SPEC));
    const trailBefore = trailCount(instanceId);
    const excBefore = db
      .prepare(`SELECT qitem_id, state FROM queue_items WHERE tags LIKE '%workflow-exception%'`)
      .all() as Array<{ qitem_id: string; state: string }>;
    expect(excBefore.filter((r) => r.state === "pending")).toHaveLength(1);

    const r = await runtime.resume({
      instanceId,
      decision: "根因已修复——重试",
      actorSession: "orch-lead@rig",
    });
    expect(r.stepId).toBe("produce");
    expect(r.resumeCount).toBe(1);
    expect(r.exceptionItemsClosed).toBe(1);
    expect(r.ownerSession).toBe("producer@rig");

    const inst = runtime.instanceStore.getByIdOrThrow(instanceId);
    expect(inst.status).toBe("active");
    expect(inst.currentStepId).toBe("produce");
    expect(inst.currentFrontier).toEqual([r.newPacketId]);
    expect(inst.resumeCount).toBe(1);
    // trail 被保留并扩展，绝不重写：失败行仍然存在，resume 本身没有重跑/重写任何行。
    expect(trailCount(instanceId)).toBe(trailBefore);
    // 决策持久性：重新驱动数据包携带指令。
    const packet = db
      .prepare(`SELECT body, chain_of_record FROM queue_items WHERE qitem_id = ?`)
      .get(r.newPacketId) as { body: string; chain_of_record: string | null };
    expect(packet.body).toContain("根因已修复——重试");
    expect(String(packet.chain_of_record)).toContain(failedPacketId);
    // occurrence 已关闭
    const excAfter = db
      .prepare(`SELECT state FROM queue_items WHERE tags LIKE '%workflow-exception%'`)
      .all() as Array<{ state: string }>;
    expect(excAfter.every((x) => x.state === "done")).toBe(true);
  });

  it("重新驱动的步骤完成后，流程确定性地继续到下游", async () => {
    build();
    const { instanceId } = await instantiateAndFail(seed(SPEC));
    const r = await runtime.resume({ instanceId, actorSession: "orch-lead@rig" });
    const advanced = await runtime.project({
      instanceId,
      currentPacketId: r.newPacketId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(advanced.nextStepId).toBe("review");
    await runtime.project({
      instanceId,
      currentPacketId: advanced.nextQitemId!,
      exit: "done",
      actorSession: "reviewer@rig",
    });
    expect(runtime.instanceStore.getByIdOrThrow(instanceId).status).toBe("completed");
  });

  it("架构固定点：resume 时重新解析 owner——故障与恢复之间 preferred_targets 的变更会路由到新目标，绝不使用陈旧记录目标", async () => {
    build();
    const { instanceId } = await instantiateAndFail(seed(SPEC));
    // 操作者的修复：在 spec cache 中替换已失效的 seat（正是此固定点针对的场景）。
    const row = db
      .prepare(`SELECT spec_id, spec_json FROM workflow_specs WHERE name = 'wf5-resume-pipeline'`)
      .get() as { spec_id: string; spec_json: string };
    const spec = JSON.parse(row.spec_json);
    spec.roles.producer.preferred_targets = ["producer-replacement@rig"];
    db.prepare(`UPDATE workflow_specs SET spec_json = ? WHERE spec_id = ?`).run(
      JSON.stringify(spec),
      row.spec_id,
    );
    const r = await runtime.resume({ instanceId, actorSession: "orch-lead@rig" });
    expect(r.ownerSession).toBe("producer-replacement@rig");
  });

  it("拒绝矩阵：对 active/waiting/completed 执行 resume = 结构化 instance_not_failed 并指明状态", async () => {
    build();
    const specPath = seed(SPEC);
    // active
    const a = await runtime.instantiate({ specPath, rootObjective: "a", createdBySession: "ops@rig" });
    await expect(
      runtime.resume({ instanceId: a.instance.instanceId, actorSession: "x@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_failed" });
    // waiting（已发布 park）——回归固定点第 1 部分：resume 拒绝它
    const w = await runtime.instantiate({ specPath, rootObjective: "w", createdBySession: "ops@rig" });
    await runtime.project({
      instanceId: w.instance.instanceId,
      currentPacketId: w.instance.currentFrontier[0]!,
      exit: "waiting",
      blockedOn: "external-thing",
      actorSession: "producer@rig",
    });
    await expect(
      runtime.resume({ instanceId: w.instance.instanceId, actorSession: "x@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_failed" });
    // 回归固定点第 2 部分：已发布 waiting 路径继续通过 project 处理保留的数据包，
    // 与此前完全相同。
    const cont = await runtime.project({
      instanceId: w.instance.instanceId,
      currentPacketId: w.instance.currentFrontier[0]!,
      exit: "done",
      actorSession: "producer@rig",
    });
    expect(cont.instance.status).toBe("completed");
    // completed
    await expect(
      runtime.resume({ instanceId: w.instance.instanceId, actorSession: "x@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_failed" });
  });

  it("连续两次 resume：第二次被拒绝（第一次已使其 active）——不重复驱动", async () => {
    build();
    const { instanceId } = await instantiateAndFail(seed(SPEC));
    await runtime.resume({ instanceId, actorSession: "orch-lead@rig" });
    await expect(
      runtime.resume({ instanceId, actorSession: "orch-lead@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_failed" });
  });

  it("活锁护栏：因 max_hops 失败的实例恢复后获得一个新的有界窗口（resume 后 hop），记录次数，再次超限时如实生成新 occurrence", async () => {
    build();
    const specPath = seed(LOOP_SPEC, "loop.yaml");
    const inst = await runtime.instantiate({ specPath, rootObjective: "loop", createdBySession: "ops@rig" });
    const id = inst.instance.instanceId;
    // 驱动至守卫触发：max_hops=2 → 第 3 次 hop 转为 failed。
    let packet = inst.instance.currentFrontier[0]!;
    let actor = "producer@rig";
    for (;;) {
      const res = await runtime.project({
        instanceId: id,
        currentPacketId: packet,
        exit: "handoff",
        actorSession: actor,
      });
      const now = runtime.instanceStore.getByIdOrThrow(id);
      if (now.status === "failed") break;
      packet = res.nextQitemId!;
      actor = actor === "producer@rig" ? "reviewer@rig" : "producer@rig";
    }
    const failed1 = runtime.instanceStore.getByIdOrThrow(id);
    const hopsAtFail = failed1.hopCount;
    const firstOccurrenceItems = db
      .prepare(`SELECT qitem_id FROM queue_items WHERE tags LIKE '%workflow-exception%' AND state = 'pending'`)
      .all();
    expect(firstOccurrenceItems).toHaveLength(1);

    // Resume：一个新窗口——resume 后第一次投影不得再次触发
    //（若无该护栏则会触发：hopCount 已大于最大值）。
    const r = await runtime.resume({ instanceId: id, actorSession: "orch-lead@rig" });
    const resumed = runtime.instanceStore.getByIdOrThrow(id);
    expect(resumed.status).toBe("active");
    expect(resumed.resumeCount).toBe(1);
    expect(resumed.hopsBaseline).toBe(hopsAtFail);

    const afterOne = await runtime.project({
      instanceId: id,
      currentPacketId: r.newPacketId,
      exit: "handoff",
      actorSession: resumed.currentStepId === "produce" ? "producer@rig" : "reviewer@rig",
    });
    expect(runtime.instanceStore.getByIdOrThrow(id).status).toBe("active");

    // 继续驱动，直到新窗口再次超限 → 如实生成新的 occurrence
    //（occurrence 不同的条目；第一项保持关闭）。
    let p2 = afterOne.nextQitemId!;
    let a2 = afterOne.nextOwnerSession!;
    for (;;) {
      const res = await runtime.project({
        instanceId: id,
        currentPacketId: p2,
        exit: "handoff",
        actorSession: a2,
      });
      const now = runtime.instanceStore.getByIdOrThrow(id);
      if (now.status === "failed") break;
      p2 = res.nextQitemId!;
      a2 = res.nextOwnerSession!;
    }
    const items = db
      .prepare(`SELECT qitem_id, state, tags FROM queue_items WHERE tags LIKE '%workflow-exception%' ORDER BY ts_created`)
      .all() as Array<{ qitem_id: string; state: string; tags: string }>;
    expect(items).toHaveLength(2);
    const open = items.filter((x) => x.state === "pending");
    expect(open).toHaveLength(1);
    // occurrence 区分：两个条目使用不同 occurrence key
    const occ = (t: string) => /"occurrence:([^"]+)"/.exec(t)?.[1];
    expect(occ(items[0]!.tags)).not.toBe(occ(items[1]!.tags));
  });
});
