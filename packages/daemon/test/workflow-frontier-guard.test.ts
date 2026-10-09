import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { createWorkflowFrontierPredicate } from "../src/domain/workflow-frontier-guard.js";

/**
 * OPR.0.4.6.WF3 FR-6——frontier close-path guard（PM 裁定：预防优先于检测）。注入 predicate
 * 的形态（架构锁定）：queue 绝不导入 workflow domain——最后一个测试在 import graph 层锁定。
 */

const SPEC = `workflow:
  id: guard-fixture
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
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - failed
      next_hop:
        suggested_roles:
          - reviewer
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
      - failed
`;

describe("workflow frontier close-path guard（WF3 FR-6）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      outboxEntriesSchema,
      coreSchema, eventsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      workflowInstanceVersionSchema, workflowSpecJsonSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    // 生产环境的接线形态：在构造时注入 predicate（startup.ts 正是这样做的）。
    queueRepo = new QueueRepository(db, bus, {
      validateRig: () => true,
      workflowFrontierPredicate: createWorkflowFrontierPredicate(db),
    });
    // P34：W1 接缝采用 fail-closed（MF2）——旨在 nudge 的 terminal close 需要同数据库 intent
    // store，才能使其 wake 持久可靠。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-guard-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  async function instantiate() {
    const r = await runtime.instantiate({
      specPath,
      rootObjective: "guard pins",
      createdBySession: "orch@rig",
    });
    return { instanceId: r.instance.instanceId, entryPacket: r.entryQitemId };
  }

  it("带外关闭 live frontier packet 会被显著拒绝，并点名 workflow verb（what/why/fix）", async () => {
    const { entryPacket } = await instantiate();
    let caught: QueueRepositoryError | null = null;
    try {
      queueRepo.update({
        qitemId: entryPacket,
        actorSession: "rogue@rig",
        state: "done",
        closureReason: "no-follow-on",
      });
    } catch (err) {
      caught = err as QueueRepositoryError;
    }
    expect(caught).toBeInstanceOf(QueueRepositoryError);
    expect(caught?.code).toBe("workflow_frontier_packet");
    // what/why/fix：点名 binding 与正确 verb。
    expect(caught?.message).toContain("frontier packet");
    expect(caught?.message).toContain("搁浅");
    expect(caught?.message).toContain("zrig workflow project");
    expect(caught?.message).toContain("zrig workflow route");
    // packet 保持不变（预防，而非检测）。
    const row = db.prepare(`SELECT state FROM queue_items WHERE qitem_id = ?`).get(entryPacket) as { state: string };
    expect(row.state).toBe("pending");
  });

  it("MC-route 形态的闭合（经 transaction 内 primitive 执行 handed-off）受到同等保护", async () => {
    const { entryPacket } = await instantiate();
    expect(() =>
      db.transaction(() => {
        queueRepo.updateWithinTransaction({
          qitemId: entryPacket,
          actorSession: "mc@rig",
          state: "handed-off",
          closureReason: "handed_off_to",
          closureTarget: "elsewhere@rig",
          handedOffTo: "elsewhere@rig",
        });
      })(),
    ).toThrowError(/workflow instance/);
  });

  it("workflow verb 本身不受影响（它们维持不变量）", async () => {
    const { instanceId, entryPacket } = await instantiate();
    // project（推进）正常工作……
    const advanced = await runtime.project({
      instanceId,
      currentPacketId: entryPacket,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(advanced.nextStepId).toBe("review");
    // ……route 也可在新 frontier 上工作。
    const routed = await runtime.route({
      instanceId,
      toSession: "reviewer2@rig",
      actorSession: "orch@rig",
    });
    expect(routed.toSession).toBe("reviewer2@rig");
  });

  it("零摩擦负向控制：接入与未接入 predicate 时，非 workflow qitem 的闭合字节级一致", async () => {
    // 接入 predicate 的 repo（生产形态）。
    const created = await queueRepo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "ordinary work",
    });
    const closed = queueRepo.update({
      qitemId: created.qitemId,
      actorSession: "b@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    expect(closed.state).toBe("done");

    // 未接入任何 predicate 的 repo（旧版形态）——字段相同，结果相同。
    const bareRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝采用 fail-closed（MF2）——旨在 nudge 的 terminal close 需要同数据库 intent
    // store，才能使其 wake 持久可靠。
    bareRepo.attachOutbox(new OutboxHandler(db));
    const created2 = await bareRepo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "ordinary work",
    });
    const closed2 = bareRepo.update({
      qitemId: created2.qitemId,
      actorSession: "b@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    expect(closed2.state).toBe("done");
    expect(closed2.closureReason).toBe(closed.closureReason);
  });

  it("terminal instance 的 packet 不受 guard 约束（predicate 仅作用于 live frontier）", async () => {
    const { instanceId, entryPacket } = await instantiate();
    await runtime.project({ instanceId, currentPacketId: entryPacket, exit: "failed", actorSession: "producer@rig" });
    // instance 已失败；其已关闭 packet 不在 live frontier 上——guard 不干扰任何后续 queue 清理。
    expect(createWorkflowFrontierPredicate(db)(entryPacket)).toBeNull();
  });

  it("IMPORT-GRAPH 锁定（架构分层规则）：queue-repository.ts 不从 workflow domain 导入任何内容", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../src/domain/queue-repository.ts"), "utf-8");
    const importLines = src.split("\n").filter((l) => l.trimStart().startsWith("import "));
    for (const line of importLines) {
      expect(line).not.toMatch(/workflow-/);
    }
  });
});
