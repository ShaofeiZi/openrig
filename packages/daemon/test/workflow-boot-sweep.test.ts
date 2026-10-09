// OPR.0.4.6.WF1 FR-4（G5）：启动恢复扫描。
//
//   - 重新武装缺失的 keepalive（修复 WF-1 前的实例）；
//   - 重发丢失的提交后 nudge（last_nudge_attempt 为 NULL 的待处理 frontier packet 已路由
//     却从未 nudge，正对应提交后崩溃窗口；从 nudge 台账确定性识别，而非启发式判断）；
//   - 暴露卡住实例（FR-2 evaluator；未认领 frontier 是一等扫描场景，绝不会被 findOverdue
//     这类仅扫描 in-progress 的逻辑忽略）；
//   - 运行中实例为零时是无副作用空操作；
//   - 输出一行可观察的具名计数摘要。

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
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { findArmedKeepaliveJob } from "../src/domain/workflow-keepalive-arming.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";

const SPEC = `workflow:
  id: fr4-sweep
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
    - id: follow
      actor_role: next
      allowed_exits:
        - done
`;

describe("runWorkflowBootSweep (FR-4)", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let watchdogRepo: WatchdogJobsRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;
  let logLines: string[];
  let sentNudges: Array<{ session: string; text: string }>;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
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
    sentNudges = [];
    queueRepo = new QueueRepository(db, bus, {
      validateRig: () => true,
      transport: {
        send: async (session: string, text: string) => {
          sentNudges.push({ session, text });
          return { ok: true, verified: true };
        },
      },
    });
    watchdogRepo = new WatchdogJobsRepository(db);
    runtime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      watchdogJobsRepo: watchdogRepo,
    });
    tmp = mkdtempSync(join(tmpdir(), "wf-sweep-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
    logLines = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function sweep() {
    return runWorkflowBootSweep({
      instanceStore: runtime.instanceStore,
      queueRepo,
      watchdogJobsRepo: watchdogRepo,
      log: (line) => logLines.push(line),
    });
  }

  it("没有运行中实例时为空操作，无副作用且有可观察日志", async () => {
    const result = await sweep();
    expect(result).toEqual({
      instancesSwept: 0,
      keepalivesArmed: 0,
      lostNudgesReissued: 0,
      stuckSurfaced: 0,
      exceptionItemsCreated: 0,
    });
    expect(watchdogRepo.listAll()).toHaveLength(0);
    expect(sentNudges).toHaveLength(0);
    expect(logLines.some((l) => l.includes("0 个进行中实例"))).toBe(true);
  });

  it("为 WF-1 前的实例（无活动 job）重新武装 keepalive，并报告已健康武装", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "re-arm walk",
      createdBySession: "ops@rig",
    });
    // 模拟 WF-1 前状态：实例没有活动 job。
    const armed = findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)!;
    watchdogRepo.markTerminal(armed.jobId, "simulated_pre_wf1_state");

    const result = await sweep();
    expect(result.instancesSwept).toBe(1);
    expect(result.keepalivesArmed).toBe(1);
    expect(findArmedKeepaliveJob(watchdogRepo, inst.instance.instanceId)).not.toBeNull();
  });

  it("丢失 nudge 恢复：last_nudge_attempt 为 NULL 的待处理 frontier packet 在启动时重新 nudge（提交后崩溃窗口）", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "lost nudge walk",
      createdBySession: "ops@rig",
    });
    // 模拟丢失的提交后 nudge：将台账置为 NULL（instantiate 自身的 nudge 已通过上方测试传输盖戳）。
    db.prepare(
      `UPDATE queue_items SET last_nudge_attempt = NULL, last_nudge_result = NULL WHERE qitem_id = ?`,
    ).run(inst.entryQitemId);
    sentNudges.length = 0;

    const result = await sweep();
    expect(result.lostNudgesReissued).toBe(1);
    expect(sentNudges.some((n) => n.session === "worker@rig")).toBe(true);
    // nudge 台账重新盖戳，第二次扫描不会再次重发。
    const again = await sweep();
    expect(again.lostNudgesReissued).toBe(0);
  });

  it("暴露卡住实例（逾期未认领——一等未认领 frontier 场景），在日志中附证据并重新 nudge", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "stuck walk",
      createdBySession: "ops@rig",
    });
    const past = new Date(
      Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 120) * 1000,
    ).toISOString();
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(
      past,
      inst.entryQitemId,
    );
    sentNudges.length = 0;

    const result = await sweep();
    expect(result.stuckSurfaced).toBe(1);
    const stuckLine = logLines.find((l) => l.includes("卡住"));
    expect(stuckLine).toBeDefined();
    expect(stuckLine).toContain(inst.instance.instanceId);
    expect(stuckLine).toContain("overdue-unclaimed");
    expect(stuckLine).toContain("worker@rig");
    expect(sentNudges.some((n) => n.session === "worker@rig")).toBe(true);
    // 摘要行点名各项计数。
    expect(
      logLines.some((l) => l.includes("1 个进行中实例") && l.includes("1 个卡住实例")),
    ).toBe(true);
  });

  it("健康运行中实例扫描干净：已武装、零重发、零卡住", async () => {
    await runtime.instantiate({
      specPath,
      rootObjective: "healthy walk",
      createdBySession: "ops@rig",
    });
    const result = await sweep();
    expect(result.instancesSwept).toBe(1);
    expect(result.keepalivesArmed).toBe(0); // instantiate already armed it
    expect(result.lostNudgesReissued).toBe(0); // instantiate's nudge stamped the ledger
    expect(result.stuckSurfaced).toBe(0);
  });
});
