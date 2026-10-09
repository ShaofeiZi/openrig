// Slice Story View v1——slice → workflow_instance binding helper。
//
// 固定 findSliceWorkflowBinding 的承重行为：
//
//   - 空 qitem 集合 → 无 binding
//   - 没有 instance 接触 slice qitem → 无 binding
//   - trail signal：通过 prior_qitem_id / next_qitem_id 找到 instance
//   - live frontier signal：通过 current_frontier_json LIKE 找到 instance
//   - 多个 instance 绑定：最新者作为 primary，其余作为 additionalInstanceIds
//   - frontier 为空的 terminal instance 仍通过 trail 历史绑定
//   - 空 frontier_json 解析为 []

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { findSliceWorkflowBinding } from "../src/domain/workflow/slice-workflow-binding.js";

function insertInstance(db: Database.Database, opts: {
  instanceId: string;
  workflowName?: string;
  workflowVersion?: string;
  status?: string;
  currentFrontier?: string[];
  currentStepId?: string | null;
  hopCount?: number;
  createdAt?: string;
}): void {
  db.prepare(
    `INSERT INTO workflow_instances (
       instance_id, workflow_name, workflow_version,
       created_by_session, created_at, status,
       current_frontier_json, current_step_id, hop_count
     ) VALUES (?, ?, ?, 'creator@r', ?, ?, ?, ?, ?)`
  ).run(
    opts.instanceId,
    opts.workflowName ?? "conveyor",
    opts.workflowVersion ?? "1",
    opts.createdAt ?? "2026-05-04T00:00:00.000Z",
    opts.status ?? "active",
    JSON.stringify(opts.currentFrontier ?? []),
    opts.currentStepId ?? null,
    opts.hopCount ?? 0,
  );
}

function ensureQitem(db: Database.Database, qitemId: string): void {
  // workflow_step_trails 在 prior_qitem_id 和 next_qitem_id 上都有指向 queue_items 的 FK 约束；
  // FK enforcement 已启用，因此 qitem 行必须先于 trail 行存在。
  db.prepare(
    `INSERT OR IGNORE INTO queue_items
       (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
     VALUES (?, '2026-05-04T00:00:00.000Z', '2026-05-04T00:00:00.000Z', 'src@r', 'dst@r', 'in-progress', 'routine', 'fixture')`
  ).run(qitemId);
}

function insertTrail(db: Database.Database, opts: {
  trailId: string;
  instanceId: string;
  stepId: string;
  stepRole: string;
  closedAt?: string;
  closureReason?: string;
  actorSession?: string;
  priorQitemId: string;
  nextQitemId?: string | null;
}): void {
  ensureQitem(db, opts.priorQitemId);
  if (opts.nextQitemId) ensureQitem(db, opts.nextQitemId);
  db.prepare(
    `INSERT INTO workflow_step_trails (
       trail_id, instance_id, step_id, step_role,
       closed_at, closure_reason, actor_session,
       prior_qitem_id, next_qitem_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.trailId,
    opts.instanceId,
    opts.stepId,
    opts.stepRole,
    opts.closedAt ?? "2026-05-04T01:00:00.000Z",
    opts.closureReason ?? "handoff",
    opts.actorSession ?? "actor@r",
    opts.priorQitemId,
    opts.nextQitemId ?? null,
  );
}

describe("PL-slice-story-view-v1 findSliceWorkflowBinding", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  });

  afterEach(() => db.close());

  it("空 qitem 集合不返回 binding", () => {
    expect(findSliceWorkflowBinding(db, [])).toEqual({ primary: null, additionalInstanceIds: [] });
  });

  it("没有 instance 接触 slice qitem 时不返回 binding", () => {
    insertInstance(db, { instanceId: "inst-other", currentFrontier: ["q-other"] });
    insertTrail(db, { trailId: "t1", instanceId: "inst-other", stepId: "discovery", stepRole: "discovery-router", priorQitemId: "q-other" });
    expect(findSliceWorkflowBinding(db, ["q-slice-1", "q-slice-2"])).toEqual({ primary: null, additionalInstanceIds: [] });
  });

  it("trail signal：prior_qitem_id 位于 slice qitem 中时绑定", () => {
    insertInstance(db, { instanceId: "inst-1", currentFrontier: [], currentStepId: "qa", hopCount: 4, status: "active" });
    insertTrail(db, { trailId: "t1", instanceId: "inst-1", stepId: "discovery", stepRole: "discovery-router", priorQitemId: "q-slice-1" });
    const result = findSliceWorkflowBinding(db, ["q-slice-1"]);
    expect(result.primary?.instanceId).toBe("inst-1");
    expect(result.primary?.workflowName).toBe("conveyor");
    expect(result.primary?.currentStepId).toBe("qa");
    expect(result.primary?.hopCount).toBe(4);
    expect(result.additionalInstanceIds).toEqual([]);
  });

  it("trail signal：next_qitem_id 位于 slice qitem 中时绑定", () => {
    insertInstance(db, { instanceId: "inst-2", currentFrontier: [] });
    insertTrail(db, { trailId: "t2", instanceId: "inst-2", stepId: "delivery", stepRole: "delivery-driver", priorQitemId: "q-prior", nextQitemId: "q-slice-1" });
    const result = findSliceWorkflowBinding(db, ["q-slice-1"]);
    expect(result.primary?.instanceId).toBe("inst-2");
  });

  it("live frontier signal：current_frontier_json 包含 slice qitem 时绑定", () => {
    insertInstance(db, { instanceId: "inst-live", currentFrontier: ["q-slice-active"], currentStepId: "delivery", status: "active" });
    const result = findSliceWorkflowBinding(db, ["q-slice-active"]);
    expect(result.primary?.instanceId).toBe("inst-live");
    expect(result.primary?.currentFrontier).toEqual(["q-slice-active"]);
    expect(result.primary?.status).toBe("active");
  });

  it("多个 instance 绑定时选择最新者为 primary，其余公开为 additionalInstanceIds", () => {
    insertInstance(db, { instanceId: "inst-old", createdAt: "2026-05-01T00:00:00.000Z", currentFrontier: [] });
    insertInstance(db, { instanceId: "inst-mid", createdAt: "2026-05-02T00:00:00.000Z", currentFrontier: [] });
    insertInstance(db, { instanceId: "inst-new", createdAt: "2026-05-04T00:00:00.000Z", currentFrontier: [] });
    insertTrail(db, { trailId: "t-old", instanceId: "inst-old", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    insertTrail(db, { trailId: "t-mid", instanceId: "inst-mid", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    insertTrail(db, { trailId: "t-new", instanceId: "inst-new", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    const result = findSliceWorkflowBinding(db, ["q-1"]);
    expect(result.primary?.instanceId).toBe("inst-new");
    expect(result.additionalInstanceIds.sort()).toEqual(["inst-mid", "inst-old"]);
  });

  it("frontier 为空的 terminal instance 仍通过 trail 历史绑定", () => {
    insertInstance(db, { instanceId: "inst-done", status: "completed", currentFrontier: [], currentStepId: null });
    insertTrail(db, { trailId: "t-done", instanceId: "inst-done", stepId: "qa", stepRole: "qa-tester", priorQitemId: "q-final", closureReason: "done" });
    const result = findSliceWorkflowBinding(db, ["q-final"]);
    expect(result.primary?.instanceId).toBe("inst-done");
    expect(result.primary?.status).toBe("completed");
    expect(result.primary?.currentStepId).toBeNull();
    expect(result.primary?.currentFrontier).toEqual([]);
  });

  it("格式错误的 current_frontier_json 优雅解析为空数组", () => {
    db.prepare(
      `INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json)
       VALUES ('inst-bad', 'x', '1', 'c@r', '2026-05-04T00:00:00.000Z', 'active', 'not-valid-json')`
    ).run();
    insertTrail(db, { trailId: "t-bad", instanceId: "inst-bad", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    const result = findSliceWorkflowBinding(db, ["q-1"]);
    expect(result.primary?.currentFrontier).toEqual([]);
  });

  it("trail + frontier signal 的 union 会对同一 instance 去重", () => {
    // 同一 instance 可通过两种 signal 触达，不应出现两次。
    insertInstance(db, { instanceId: "inst-both", currentFrontier: ["q-1"] });
    insertTrail(db, { trailId: "t-both", instanceId: "inst-both", stepId: "x", stepRole: "r", priorQitemId: "q-1" });
    const result = findSliceWorkflowBinding(db, ["q-1"]);
    expect(result.primary?.instanceId).toBe("inst-both");
    expect(result.additionalInstanceIds).toEqual([]);
  });
});
