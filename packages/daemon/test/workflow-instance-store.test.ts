import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import {
  WorkflowInstanceError,
  WorkflowInstanceStore,
} from "../src/domain/workflow-instance-store.js";

describe("WorkflowInstanceStore (PL-004 Phase D)", () => {
  let db: Database.Database;
  let store: WorkflowInstanceStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowInstancesSchema]);
    store = new WorkflowInstanceStore(db);
  });

  afterEach(() => db.close());

  it("create 保存 status=active、空 frontier 和 ULID id 的新 instance", () => {
    const inst = store.create({
      workflowName: "test",
      workflowVersion: "1",
      createdBySession: "alice@rig",
    });
    expect(inst.instanceId).toMatch(/^[0-9A-Z]{26}$/);
    expect(inst.status).toBe("active");
    expect(inst.currentFrontier).toEqual([]);
    expect(inst.hopCount).toBe(0);
  });

  it("getByIdOrThrow 对未知 id 抛出 instance_not_found", () => {
    try {
      store.getByIdOrThrow("nope");
      throw new Error("预期应抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowInstanceError);
      expect((err as WorkflowInstanceError).code).toBe("instance_not_found");
    }
  });

  it("updateFrontier 同时修改 JSON array 和 status", () => {
    const inst = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    store.updateFrontier(inst.instanceId, ["q-1", "q-2"], "active");
    const after = store.getByIdOrThrow(inst.instanceId);
    expect(after.currentFrontier).toEqual(["q-1", "q-2"]);
    expect(after.status).toBe("active");
  });

  it("updateFrontier 带 bumpHopCount=true 时原子递增 hop_count", () => {
    const inst = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    store.updateFrontier(inst.instanceId, ["q-1"], "active", { bumpHopCount: true });
    store.updateFrontier(inst.instanceId, ["q-2"], "active", { bumpHopCount: true });
    expect(store.getByIdOrThrow(inst.instanceId).hopCount).toBe(2);
  });

  it("updateFrontier 以 JSON 序列化形式记录 lastContinuationDecision", () => {
    const inst = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    store.updateFrontier(inst.instanceId, [], "completed", {
      lastContinuationDecision: { exit: "done", actor: "a@r" },
      completedAt: "2026-05-03T08:00:00.000Z",
    });
    const after = store.getByIdOrThrow(inst.instanceId);
    expect(after.lastContinuationDecision).toEqual({ exit: "done", actor: "a@r" });
    expect(after.completedAt).toBe("2026-05-03T08:00:00.000Z");
  });

  it("listByStatus 负责筛选，listAll 返回全部", () => {
    const a = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    const b = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "b@r" });
    store.updateFrontier(b.instanceId, [], "completed");
    expect(store.listByStatus("active").map((i) => i.instanceId)).toEqual([a.instanceId]);
    expect(store.listByStatus("completed").map((i) => i.instanceId)).toEqual([b.instanceId]);
    expect(store.listAll()).toHaveLength(2);
  });

  it("通过 SQLite 跨重启保留数据，新 store instance 可读到相同内容", () => {
    const inst = store.create({ workflowName: "t", workflowVersion: "1", createdBySession: "a@r" });
    store.updateFrontier(inst.instanceId, ["q-x"], "active");
    const store2 = new WorkflowInstanceStore(db);
    const restored = store2.getByIdOrThrow(inst.instanceId);
    expect(restored.currentFrontier).toEqual(["q-x"]);
    expect(restored.status).toBe("active");
  });
});
