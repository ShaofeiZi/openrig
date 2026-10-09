import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { WorkflowStepTrailLog } from "../src/domain/workflow-step-trail-log.js";

describe("WorkflowStepTrailLog（PL-004 Phase D；仅追加）", () => {
  let db: Database.Database;
  let log: WorkflowStepTrailLog;
  let store: WorkflowInstanceStore;
  let instanceId: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, workflowInstancesSchema, workflowStepTrailsSchema]);
    log = new WorkflowStepTrailLog(db);
    store = new WorkflowInstanceStore(db);
    instanceId = store.create({
      workflowName: "t",
      workflowVersion: "1",
      createdBySession: "a@r",
    }).instanceId;
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-prior', '2026-05-03T07:00:00Z', '2026-05-03T07:00:00Z', 'a@r', 'b@r', 'done', 'routine', 'x')`,
    ).run();
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-next', '2026-05-03T07:01:00Z', '2026-05-03T07:01:00Z', 'a@r', 'c@r', 'pending', 'routine', 'x')`,
    ).run();
  });

  afterEach(() => db.close());

  it("record 返回带 ULID ID 和正确字段的持久化条目", () => {
    const e = log.record({
      instanceId,
      stepId: "produce",
      stepRole: "producer",
      closedAt: "2026-05-03T08:00:00.000Z",
      closureReason: "handoff",
      actorSession: "a@r",
      priorQitemId: "q-prior",
      nextQitemId: "q-next",
    });
    expect(e.trailId).toMatch(/^[0-9A-Z]{26}$/);
    expect(e.closureReason).toBe("handoff");
    expect(e.priorQitemId).toBe("q-prior");
    expect(e.nextQitemId).toBe("q-next");
  });

  it("record(closureEvidence) 以 JSON 编码，并在读取时解码", () => {
    log.record({
      instanceId,
      stepId: "x",
      stepRole: "r",
      closedAt: "2026-05-03T08:00:00.000Z",
      closureReason: "done",
      actorSession: "a@r",
      priorQitemId: "q-prior",
      closureEvidence: { result: "shipped", artifact: "/path/to/thing" },
    });
    const list = log.listForInstance(instanceId);
    expect(list[0]?.closureEvidence).toEqual({ result: "shipped", artifact: "/path/to/thing" });
  });

  it("终态 closure（done/waiting/failed）的 nextQitemId 可为 null", () => {
    log.record({
      instanceId,
      stepId: "x",
      stepRole: "r",
      closedAt: "2026-05-03T08:00:00.000Z",
      closureReason: "done",
      actorSession: "a@r",
      priorQitemId: "q-prior",
      nextQitemId: null,
    });
    expect(log.listForInstance(instanceId)[0]?.nextQitemId).toBeNull();
  });

  it("listForInstance 按 closed_at 降序返回", () => {
    log.record({ instanceId, stepId: "a", stepRole: "r", closedAt: "2026-05-03T08:00:00.000Z", closureReason: "handoff", actorSession: "a@r", priorQitemId: "q-prior" });
    log.record({ instanceId, stepId: "b", stepRole: "r", closedAt: "2026-05-03T08:01:00.000Z", closureReason: "handoff", actorSession: "a@r", priorQitemId: "q-prior" });
    const list = log.listForInstance(instanceId);
    expect(list[0]?.stepId).toBe("b");
    expect(list[1]?.stepId).toBe("a");
  });

  it("违反 FK：对未知 instance_id 调用 record() 时抛出 SQLite FK 错误", () => {
    expect(() =>
      log.record({
        instanceId: "no-such-instance",
        stepId: "x",
        stepRole: "r",
        closedAt: "2026-05-03T08:00:00.000Z",
        closureReason: "done",
        actorSession: "a@r",
        priorQitemId: "q-prior",
      }),
    ).toThrow();
  });

  it("API 接口不含 update/delete（仅追加契约）", () => {
    const proto = Object.getPrototypeOf(log) as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(proto);
    expect(names).not.toContain("update");
    expect(names).not.toContain("delete");
    expect(names).not.toContain("remove");
  });

  it("countForInstance 返回单个 instance 的行数", () => {
    expect(log.countForInstance(instanceId)).toBe(0);
    log.record({ instanceId, stepId: "x", stepRole: "r", closedAt: "2026-05-03T08:00:00.000Z", closureReason: "done", actorSession: "a@r", priorQitemId: "q-prior" });
    expect(log.countForInstance(instanceId)).toBe(1);
  });
});
