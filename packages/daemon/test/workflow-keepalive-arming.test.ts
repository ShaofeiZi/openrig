// OPR.0.4.6.WF1 FR-3（G2）：keepalive 在事务内自动 arm、disarm，以及受 deadline 门控的
// policy 行为。
//
//   - instantiate 在创建 entry packet 的同一事务内，为每个 instance arm 恰好一个
//     workflow-keepalive job；
//   - handoff 投影以幂等方式保持 armed（每个 instance 一个 job——架构已认可——并修复 WF-1
//     之前的 instance）；
//   - terminal 退出在事务内 disarm（无孤立 watchdog 噪声）；
//   - 事务中途失败会连同其他所有内容回滚 arming（arming 随 scribe 执行，不是第二个 writer）；
//   - 自动 armed（deadline_gated）policy 在 healthy 时保持安静（FR-2 零噪声 AC），frontier packet
//     逾期后发送带 evidence 的 stuck re-nudge，引导恢复后的 agent 重新投影。操作员注册 job 保持
//     POC 始终发送的行为。

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
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import {
  findArmedKeepaliveJob,
  WORKFLOW_KEEPALIVE_AUTO_INTERVAL_SECONDS,
} from "../src/domain/workflow-keepalive-arming.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

const SPEC = `workflow:
  id: fr3-arming
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
        - failed
`;

describe("FR-3：keepalive 在事务内自动 arm + disarm", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let watchdogRepo: WatchdogJobsRepository;
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
      watchdogJobsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝为 fail-closed（MF2）——旨在 nudge 的 terminal close 需要同数据库的 intent store，
    // 才能让 wake 持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    watchdogRepo = new WatchdogJobsRepository(db);
    runtime = new WorkflowRuntime({
      exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" },
      db,
      eventBus: bus,
      queueRepo,
      watchdogJobsRepo: watchdogRepo,
    });
    tmp = mkdtempSync(join(tmpdir(), "wf-arming-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("instantiate 在 entry packet 的同一事务中，为每个 instance arm 恰好一个受 deadline 门控的 keepalive job", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "arming walk",
      createdBySession: "ops@rig",
    });
    const job = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId);
    expect(job).not.toBeNull();
    expect(job!.policy).toBe("workflow-keepalive");
    expect(job!.state).toBe("active");
    expect(job!.targetSession).toBe("worker@rig");
    expect(job!.intervalSeconds).toBe(WORKFLOW_KEEPALIVE_AUTO_INTERVAL_SECONDS);
    expect(job!.specYaml).toContain(`workflow_instance_id: ${inst.instance.instanceId}`);
    expect(job!.specYaml).toContain("deadline_gated: true");
    expect(watchdogRepo.listActive()).toHaveLength(1);
  });

  it("handoff 保持每个 instance 一个 job（幂等确保）；terminal done 在事务内将其 disarm", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "one job walk",
      createdBySession: "ops@rig",
    });
    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "worker@rig",
    });
    // 该 instance 仍恰有一个 active job。
    expect(
      watchdogRepo
        .listActive()
        .filter((j) => j.specYaml.includes(inst.instance.instanceId)),
    ).toHaveLength(1);

    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "done",
      actorSession: "next@rig",
    });
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).toBeNull();
    const all = watchdogRepo
      .listAll()
      .filter((j) => j.specYaml.includes(inst.instance.instanceId));
    expect(all).toHaveLength(1);
    expect(all[0]!.state).toBe("terminal");
    expect(all[0]!.terminalReason).toBe("workflow_completed");
  });

  it("failed 退出以 workflow_failed disarm；handoff 到 WF-1 前的无 job instance 时通过 arming 修复", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "heal walk",
      createdBySession: "ops@rig",
    });
    // 模拟 WF-1 前的 instance：在带外移除自动 armed job。
    const armed = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)!;
    watchdogRepo.markTerminal(armed.jobId, "simulated_pre_wf1_state");
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).toBeNull();

    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "worker@rig",
    });
    // 已修复：重新存在新的 active job。
    const healed = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId);
    expect(healed).not.toBeNull();
    expect(healed!.targetSession).toBe("next@rig");

    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "failed",
      actorSession: "next@rig",
    });
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).toBeNull();
    const terminalJob = watchdogRepo
      .listAll()
      .find((j) => j.jobId === healed!.jobId)!;
    expect(terminalJob.terminalReason).toBe("workflow_failed");
  });

  it("waiting 保持受 deadline 门控的 keepalive armed（编写的再次展示使用独立一次性 timer）", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "waiting walk",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting",
      actorSession: "worker@rig",
      blockedOn: "external-gate-x",
    });
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).not.toBeNull();
  });

  it("BR-2/原子性：事务中途失败会连同其余内容回滚 arming——arming 随 scribe 执行，不是第二个 writer", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "rollback walk",
      createdBySession: "ops@rig",
    });
    // 将其模拟为 WF-1 前的 instance，使 handoff 会执行 arm。
    const armed = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)!;
    watchdogRepo.markTerminal(armed.jobId, "simulated_pre_wf1_state");

    vi.spyOn(runtime.trailLog, "record").mockImplementation(() => {
      throw new Error("injected-mid-txn-failure");
    });
    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "worker@rig",
      }),
    ).rejects.toThrow("injected-mid-txn-failure");

    // heal-arm 连同其他所有内容一起回滚。
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).toBeNull();
  });
});

describe("FR-3/FR-2：受 deadline 门控的 keepalive policy 行为", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let watchdogRepo: WatchdogJobsRepository;
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
      watchdogJobsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝为 fail-closed（MF2）——旨在 nudge 的 terminal close 需要同数据库的 intent store，
    // 才能让 wake 持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    watchdogRepo = new WatchdogJobsRepository(db);
    runtime = new WorkflowRuntime({
      exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" },
      db,
      eventBus: bus,
      queueRepo,
      watchdogJobsRepo: watchdogRepo,
    });
    tmp = mkdtempSync(join(tmpdir(), "wf-gated-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function jobFor(instanceId: string, deadlineGated: boolean): PolicyJob {
    return {
      jobId: "job-test",
      policy: "workflow-keepalive",
      target: { session: "fallback@rig" },
      intervalSeconds: 900,
      activeWakeIntervalSeconds: null,
      scanIntervalSeconds: null,
      context: {
        workflow_instance_id: instanceId,
        ...(deadlineGated ? { deadline_gated: true } : {}),
      },
      lastEvaluationAt: null,
      lastFireAt: null,
      registeredBySession: "ops@rig",
      registeredAt: new Date().toISOString(),
    };
  }

  it("deadline-gated + healthy → 静默 skip（workflow_healthy_deadline_gated）——正常路径零噪声", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "quiet walk",
      createdBySession: "ops@rig",
    });
    const policy = makeWorkflowKeepalivePolicy({ db });
    const evaluation = await policy.evaluate(jobFor(inst.instance.instanceId, true));
    expect(evaluation.action).toBe("skip");
    expect(evaluation.reason).toBe("workflow_healthy_deadline_gated");
  });

  it("deadline-gated + overdue-unclaimed → 向 packet owner 发送 stuck evidence + re-project steering", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "stuck walk",
      createdBySession: "ops@rig",
    });
    // 将 entry packet 老化到超过 never-claimed 阈值。
    const past = new Date(
      Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 60) * 1000,
    ).toISOString();
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(
      past,
      inst.entryQitemId,
    );

    const policy = makeWorkflowKeepalivePolicy({ db });
    const evaluation = await policy.evaluate(jobFor(inst.instance.instanceId, true));
    expect(evaluation.action).toBe("send");
    if (evaluation.action !== "send") throw new Error("unreachable");
    expect(evaluation.target.session).toBe("worker@rig");
    expect(evaluation.message).toContain("Workflow deadline：");
    expect(evaluation.message).toContain(inst.entryQitemId);
    expect(evaluation.message).toContain("--full");
    expect(evaluation.message).toContain("Packet age 不能证明处于 idle");
    const deadlineNotes = (evaluation.notes as Record<string, unknown>)
      .deadline as Record<string, unknown>;
    expect(deadlineNotes.state).toBe("overdue-unclaimed");
    expect(deadlineNotes.packetId).toBe(inst.entryQitemId);
  });

  it("非门控（操作员注册）+ healthy → 已发布 POC 始终发送行为不变", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "parity walk",
      createdBySession: "ops@rig",
    });
    const policy = makeWorkflowKeepalivePolicy({ db });
    const evaluation = await policy.evaluate(jobFor(inst.instance.instanceId, false));
    expect(evaluation.action).toBe("send");
    if (evaluation.action !== "send") throw new Error("unreachable");
    expect(evaluation.message).toContain("Workflow keepalive：");
    expect(evaluation.message).not.toContain("Workflow STUCK");
  });
});
