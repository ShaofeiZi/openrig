import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";

const SPEC = `workflow:
  id: pd-three-step
  version: 1
  objective: 3-step transactional-scribe test
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
    finalizer:
      preferred_targets:
        - finalizer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
    - id: review
      actor_role: reviewer
      allowed_exits:
        - handoff
    - id: finalize
      actor_role: finalizer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
      - failed
`;

// 宽松规范用于测试不同关闭形状（done、waiting、failed），无需走完整个工作流。入口步骤
// 允许全部四种 exit；否则 R2 的 allowed_exits 执行会正确拒绝只声明 handoff 的步骤上的
// 非 handoff 关闭。
const PERMISSIVE_SPEC = `workflow:
  id: pd-permissive
  version: 1
  objective: closure-shape unit tests
  entry:
    role: anyone
  roles:
    anyone:
      preferred_targets:
        - anyone@rig
    next:
      preferred_targets:
        - next@rig
  steps:
    - id: act
      actor_role: anyone
      allowed_exits:
        - handoff
        - waiting
        - done
        - failed
    - id: follow
      actor_role: next
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
      - failed
`;

describe("WorkflowProjector + WorkflowRuntime（PL-004 阶段 D，事务式记录器承重测试）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;
  let permissiveSpecPath: string;

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
    ]);
    bus = new EventBus(db);
    // 预置工作组和节点，使 QueueRepository.validateRig 接受这些目标。
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝采用 fail-closed（MF2）；期望 nudge 的终态关闭需要同数据库的 intent
    // store 才能持久化 wake。
    queueRepo.attachOutbox(new OutboxHandler(db));
    tmp = mkdtempSync(join(tmpdir(), "wf-proj-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
    permissiveSpecPath = join(tmp, "permissive-spec.yaml");
    writeFileSync(permissiveSpecPath, PERMISSIVE_SPEC);
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("刷新 continuation 时会移除旧的中文工作流方法行", async () => {
    const { withWorkflowContinuation } = await import("../src/domain/workflow-projector.js");
    const body = [
      "任务正文",
      "工作流方法：旧方法",
      "工作流方法：旧命令 --packet old",
    ].join("\n");
    const refreshed = withWorkflowContinuation({
      body,
      instanceId: "instance-1",
      packetId: "packet-new",
      ownerSession: "worker@rig",
    });
    expect(refreshed).not.toContain("旧方法");
    expect(refreshed).not.toContain("--packet old");
  });

  it("instantiate 在同一事务中创建实例和入口 qitem，并发出 workflow.instantiated + queue.created", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const result = await runtime.instantiate({
      specPath,
      rootObjective: "test run",
      createdBySession: "ops@rig",
    });
    expect(result.instance.status).toBe("active");
    expect(result.instance.currentFrontier).toEqual([result.entryQitemId]);
    expect(events.some((e) => e.type === "workflow.instantiated")).toBe(true);
    expect(events.some((e) => e.type === "queue.created")).toBe(true);
    // 入口 qitem 确实存在且目标符合预期。
    const entryItem = queueRepo.getById(result.entryQitemId);
    expect(entryItem?.destinationSession).toBe("producer@rig");
    expect(entryItem?.state).toBe("pending");
  });

  // R1 修复（guard blocker 1）：project handoff 持久化阶段 A 的 queue 关闭元数据
  //（closure_reason、closure_target、handed_off_to），追加 queue_transitions 行，并发出
  // queue.updated 事件。
  it("project(handoff) 持久化阶段 A queue 关闭元数据、transition 行和 queue.updated 事件", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
      resultNote: "produced",
    });
    // 保留阶段 A 的 queue 关闭契约。
    const closedItem = queueRepo.getById(inst.entryQitemId);
    expect(closedItem?.state).toBe("handed-off");
    expect(closedItem?.closureReason).toBe("handed_off_to");
    expect(closedItem?.closureTarget).toBe("reviewer@rig");
    expect(closedItem?.handedOffTo).toBe("reviewer@rig");
    // 已追加 queue_transitions 行。
    const transitions = db
      .prepare(`SELECT * FROM queue_transitions WHERE qitem_id = ? ORDER BY ts DESC`)
      .all(inst.entryQitemId) as Array<{ state: string; closure_reason: string | null; closure_target: string | null }>;
    expect(transitions.find((t) => t.state === "handed-off")).toBeDefined();
    expect(transitions.find((t) => t.state === "handed-off")?.closure_reason).toBe("handed_off_to");
    // 已发出 queue.updated 事件。
    expect(events.find((e) => e.type === "queue.updated")).toBeDefined();
    // 同时发出工作流事件。
    expect(events.find((e) => e.type === "workflow.step_closed")).toBeDefined();
    expect(events.find((e) => e.type === "workflow.next_qitem_projected")).toBeDefined();
    expect(projected.nextStepId).toBe("review");
  });

  it("project(done) 未暴露关闭覆盖值时默认使用 closure_reason=no-follow-on", async () => {
    const inst = await runtime.instantiate({
      specPath: permissiveSpecPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "done",
      actorSession: "anyone@rig",
    });
    const closedItem = queueRepo.getById(inst.entryQitemId);
    expect(closedItem?.state).toBe("done");
    expect(closedItem?.closureReason).toBe("no-follow-on");
    expect(events.find((e) => e.type === "queue.updated")).toBeDefined();
  });

  it("project(waiting) 使用阶段 A blocked 状态、closure_reason=blocked_on 与 blocked_on 列", async () => {
    const inst = await runtime.instantiate({
      specPath: permissiveSpecPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "anyone@rig",
      blockedOn: "external-gate-x",
    });
    const closedItem = queueRepo.getById(inst.entryQitemId);
    expect(closedItem?.state).toBe("blocked");
    expect(closedItem?.closureReason).toBe("blocked_on");
    expect(closedItem?.closureTarget).toBe("external-gate-x");
    expect(closedItem?.blockedOn).toBe("external-gate-x");
  });

  it("project(handoff) 在同一事务中关闭当前 packet 并创建下一步骤 packet，发出两个事件", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
      resultNote: "produced",
    });
    expect(projected.closurePriorPacketId).toBe(inst.entryQitemId);
    expect(projected.nextStepId).toBe("review");
    expect(projected.nextOwnerSession).toBe("reviewer@rig");
    expect(projected.nextQitemId).not.toBeNull();
    // 前一个 packet 已关闭。
    expect(queueRepo.getById(inst.entryQitemId)?.state).toBe("handed-off");
    // 下一个 packet 已存在。
    expect(queueRepo.getById(projected.nextQitemId!)?.state).toBe("pending");
    // 两个事件均已发出。
    expect(events.filter((e) => e.type === "workflow.step_closed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "workflow.next_qitem_projected")).toHaveLength(1);
  });

  it("project(handoff) 遵循 next_hop.suggested_roles，使最终 review 步骤可回到 intake", async () => {
    const loopSpec = `workflow:
  id: loop-regression
  version: 1
  entry:
    role: discovery-router
  roles:
    discovery-router:
      preferred_targets:
        - discovery@rig
    qa-tester:
      preferred_targets:
        - qa@rig
  steps:
    - id: discovery
      actor_role: discovery-router
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - qa-tester
    - id: qa
      actor_role: qa-tester
      allowed_exits:
        - handoff
        - done
      next_hop:
        suggested_roles:
          - discovery-router
  invariants:
    allowed_exits:
      - handoff
      - done
  loop_guards:
    max_hops: 10
`;
    const loopSpecPath = join(tmp, "loop-regression.yaml");
    writeFileSync(loopSpecPath, loopSpec);
    const inst = await runtime.instantiate({
      specPath: loopSpecPath,
      rootObjective: "loop regression",
      createdBySession: "ops@rig",
    });

    const qaProjection = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "discovery@rig",
      resultNote: "candidate ready",
    });
    expect(qaProjection.nextStepId).toBe("qa");
    expect(qaProjection.nextOwnerSession).toBe("qa@rig");

    const loopProjection = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: qaProjection.nextQitemId!,
      exit: "handoff",
      actorSession: "qa@rig",
      resultNote: "runtime signal ready for discovery",
    });

    expect(loopProjection.nextStepId).toBe("discovery");
    expect(loopProjection.nextOwnerSession).toBe("discovery@rig");
    expect(loopProjection.nextQitemId).not.toBeNull();
    expect(loopProjection.instance.status).toBe("active");
    expect(loopProjection.instance.currentStepId).toBe("discovery");
    expect(loopProjection.instance.currentFrontier).toEqual([loopProjection.nextQitemId]);
    expect(queueRepo.getById(qaProjection.nextQitemId!)?.closureTarget).toBe("discovery@rig");
  });

  it("事务式记录器回滚：下一 qitem 创建失败时，旧 packet 保持进行中且不产生 trail 或孤立 qitem", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    // 通过翻转 validateRig 让目标无效，从而强制投影失败。
    const failingRepo = new QueueRepository(db, bus, {
      validateRig: () => false,
    });
    // P34：W1 接缝采用 fail-closed（MF2）；期望 nudge 的终态关闭需要同数据库的 intent
    // store 才能持久化 wake。
    failingRepo.attachOutbox(new OutboxHandler(db));
    const failingRuntime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo: failingRepo });
    const trailCountBefore = failingRuntime.trailLog.countForInstance(inst.instance.instanceId);
    const queueCountBefore = db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number };

    let threw = false;
    try {
      await failingRuntime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // 旧 packet 仍为 pending（已回滚）。
    expect(queueRepo.getById(inst.entryQitemId)?.state).toBe("pending");
    // 未写入 trail 行。
    expect(failingRuntime.trailLog.countForInstance(inst.instance.instanceId)).toBe(trailCountBefore);
    // 未创建孤立 qitem。
    const queueCountAfter = db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number };
    expect(queueCountAfter.n).toBe(queueCountBefore.n);
    // 实例 frontier 不变。
    const instAfter = failingRuntime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(instAfter.currentFrontier).toEqual([inst.entryQitemId]);
    expect(instAfter.status).toBe("active");
  });

  it("在终结步骤执行 project(done) → status=completed + frontier=[]", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    // 走完全部 3 个步骤。
    let projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "handoff",
      actorSession: "reviewer@rig",
    });
    projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "done",
      actorSession: "finalizer@rig",
      resultNote: "shipped",
    });
    expect(projected.instance.status).toBe("completed");
    expect(projected.instance.currentFrontier).toEqual([]);
    expect(projected.instance.completedAt).not.toBeNull();
    expect(projected.nextQitemId).toBeNull();
    // 步骤 trail 有 3 条记录。
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    expect(trail).toHaveLength(3);
  });

  it("project 拒绝不在 frontier 上的 packet → 409 packet_not_on_frontier", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    try {
      await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: "qitem-not-in-frontier",
        exit: "done",
        actorSession: "x@r",
      });
      throw new Error("本应抛出异常");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowProjectorError);
      expect((err as WorkflowProjectorError).code).toBe("packet_not_on_frontier");
    }
  });

  it("project 拒绝已完成实例 → 409 instance_not_active", async () => {
    const inst = await runtime.instantiate({
      specPath: permissiveSpecPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    let projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "done",
      actorSession: "anyone@rig",
    });
    expect(projected.instance.status).toBe("completed");
    try {
      await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "done",
        actorSession: "anyone@rig",
      });
      throw new Error("本应抛出异常");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowProjectorError);
      expect((err as WorkflowProjectorError).code).toBe("instance_not_active");
    }
  });

  // R1 修复（guard blocker 2b）：project(waiting) 把已关闭 packet 保留在 currentFrontier，
  // 使 workflow-keepalive 仍可解析 owner。原 blocker 缺陷会移除已关闭 packet，导致单 packet
  // waiting 工作流没有可唤醒的 owner。
  it("project(waiting) 设置 status=waiting 并在 currentFrontier 保留已关闭 packet", async () => {
    const inst = await runtime.instantiate({
      specPath: permissiveSpecPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    expect(inst.instance.currentFrontier).toEqual([inst.entryQitemId]);
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "anyone@rig",
      blockedOn: "external-gate",
    });
    expect(projected.instance.status).toBe("waiting");
    expect(projected.nextQitemId).toBeNull();
    // blocked packet 上的阶段 A queue 关闭形状。
    expect(queueRepo.getById(inst.entryQitemId)?.state).toBe("blocked");
    // 保留 FRONTIER，workflow-keepalive 仍可唤醒 owner。
    expect(projected.instance.currentFrontier).toEqual([inst.entryQitemId]);
    // 重新读取，确认持久化实例行反映同样状态。
    const reread = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(reread.currentFrontier).toEqual([inst.entryQitemId]);
  });

  // R2 修复（guard blocker 1）：持久化 current-step binding。handoff 到步骤 N 后在同一
  // packet 上 waiting，再以 done/handoff 恢复时必须关闭步骤 N，而不是 N+1（R1 未捕获的
  // trail 推断缺陷）。这是技能经验 feedback_resume_after_parked_state_regression 定义的规范
  // “park 后 resume”回归。
  it("R2 resume 回归：handoff → 步骤 N 上 waiting → 同一 qitem 上 done 会关闭步骤 N 而非 N+1", async () => {
    // 使用三步骤规范，其中 "review" 允许 handoff + waiting + done，以便在第 2 步 park
    // 后恢复。
    const resumeSpec = `workflow:
  id: pd-resume-after-waiting
  version: 1
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
    finalizer:
      preferred_targets:
        - finalizer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
    - id: review
      actor_role: reviewer
      allowed_exits:
        - handoff
        - waiting
        - done
    - id: finalize
      actor_role: finalizer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
`;
    const resumeSpecPath = join(tmp, "resume.yaml");
    writeFileSync(resumeSpecPath, resumeSpec);

    // 步骤 1：instantiate，然后 handoff produce → review。
    const inst = await runtime.instantiate({
      specPath: resumeSpecPath,
      rootObjective: "resume regression",
      createdBySession: "ops@rig",
    });
    const handed = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(handed.nextStepId).toBe("review");
    const reviewQitemId = handed.nextQitemId!;

    // current_step_id 现在绑定到 "review"。
    let instAfterHandoff = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(instAfterHandoff.currentStepId).toBe("review");
    expect(instAfterHandoff.currentFrontier).toEqual([reviewQitemId]);

    // 步骤 2：在同一 qitem 上 park review。
    const waited = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: reviewQitemId,
      exit: "waiting",
      actorSession: "reviewer@rig",
      blockedOn: "external-gate",
    });
    expect(waited.instance.status).toBe("waiting");
    // frontier 保留，且 current_step_id 仍为 "review"，不会因 trail 顺序推进到 "finalize"。
    let instWaiting = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(instWaiting.currentFrontier).toEqual([reviewQitemId]);
    expect(instWaiting.currentStepId).toBe("review");

    // 步骤 3：在同一 packet 上用 done 恢复。必须关闭 "review"，而不是 "finalize"；
    // workflow_step_trails 也应包含 "review" 关闭记录（R1 缺陷会根据 trail 错误推断为
    // 已处于 "finalize"）。
    const resumed = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: reviewQitemId,
      exit: "done",
      actorSession: "reviewer@rig",
      resultNote: "review complete",
    });

    // 最新 trail 条目属于 "review"，而非 "finalize"。
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    const lastTrail = trail[0]!; // 降序排列。
    expect(lastTrail.stepId).toBe("review");
    expect(lastTrail.closureReason).toBe("done");
    expect(lastTrail.priorQitemId).toBe(reviewQitemId);

    // review 上的 done exit 且 frontier 无后继，表示工作流此时完成。规范允许 "review"
    // 以 done 退出；虽然存在下一步骤 "finalize"，但选择的是 "done" 而非 "handoff"，
    // 因此不会投影该步骤。
    expect(resumed.instance.status).toBe("completed");
    expect(resumed.instance.currentFrontier).toEqual([]);

    // 关键约束：不会为 "finalize" 写入 trail 行；旧缺陷会跳到 finalize，或让关闭目标
    // 指向错误步骤。
    expect(trail.find((t) => t.stepId === "finalize")).toBeUndefined();
  });

  // R2 修复（guard blocker 2）：allowed_exits 强制执行的正向用例。
  it("R2 allowed_exits 正向用例：step.allowed_exits 包含该 exit 时成功", async () => {
    const inst = await runtime.instantiate({
      specPath, // produce 步骤允许 handoff。
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    // handoff 位于 produce.allowed_exits 中，必须成功。
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(projected.nextStepId).toBe("review");
  });

  // R2 修复（guard blocker 2）：allowed_exits 强制执行的反向用例，并覆盖回滚/无副作用。
  it("R2 allowed_exits 反向用例：不允许的 exit 抛出 exit_not_allowed 且无副作用", async () => {
    const inst = await runtime.instantiate({
      specPath, // produce 步骤只允许 handoff。
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const beforeQueueState = queueRepo.getById(inst.entryQitemId)?.state;
    const beforeFrontier = inst.instance.currentFrontier;
    const beforeStepId = inst.instance.currentStepId;
    const beforeTrailCount = runtime.trailLog.countForInstance(inst.instance.instanceId);
    const eventsBefore: Array<{ type: string }> = [];
    bus.subscribe((e) => eventsBefore.push(e));

    // done 不在 produce.allowed_exits 中，必须抛错。
    let threw = false;
    try {
      await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "done",
        actorSession: "producer@rig",
      });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(WorkflowProjectorError);
      const e = err as WorkflowProjectorError;
      expect(e.code).toBe("exit_not_allowed");
      expect(e.details?.allowedExits).toEqual(["handoff"]);
      expect(e.details?.attemptedExit).toBe("done");
      expect(e.details?.stepId).toBe("produce");
    }
    expect(threw).toBe(true);

    // 无副作用：queue state、instance frontier、current_step_id、trail 数量和事件均不变。
    expect(queueRepo.getById(inst.entryQitemId)?.state).toBe(beforeQueueState);
    const instAfter = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(instAfter.currentFrontier).toEqual(beforeFrontier);
    expect(instAfter.currentStepId).toBe(beforeStepId);
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(beforeTrailCount);
    // 被拒绝的投影不会发出 workflow.* 事件。
    expect(eventsBefore.find((e) => e.type === "workflow.step_closed")).toBeUndefined();
    expect(eventsBefore.find((e) => e.type === "queue.updated")).toBeUndefined();
  });

  // R1 修复（guard blocker 2a）：exit=failed 设置 workflow status=failed（不是 completed），
  // 并发出 workflow.failed（不是 workflow.completed）。
  it("project(failed) 设置 workflow status=failed 并发出 workflow.failed，而非 completed", async () => {
    const events: Array<{ type: string }> = [];
    bus.subscribe((e) => events.push(e));
    const inst = await runtime.instantiate({
      specPath: permissiveSpecPath,
      rootObjective: "x",
      createdBySession: "ops@rig",
    });
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "failed",
      actorSession: "anyone@rig",
      resultNote: "could not produce artifact",
    });
    expect(projected.instance.status).toBe("failed");
    expect(events.find((e) => e.type === "workflow.failed")).toBeDefined();
    expect(events.find((e) => e.type === "workflow.completed")).toBeUndefined();
    // 阶段 A queue 关闭：state=done 且 closure_reason=denied。
    const closedItem = queueRepo.getById(inst.entryQitemId);
    expect(closedItem?.state).toBe("done");
    expect(closedItem?.closureReason).toBe("denied");
    // 持久化的 failed 事件携带原因。
    const failedEvent = events.find((e) => e.type === "workflow.failed") as
      | { type: "workflow.failed"; reason: string }
      | undefined;
    expect(failedEvent?.reason).toBe("could not produce artifact");
  });
});
