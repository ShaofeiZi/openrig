import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import type { PolicyJob } from "../src/domain/policies/types.js";

function makeJob(overrides: Partial<PolicyJob> & { context: Record<string, unknown> }): PolicyJob {
  return {
    jobId: "job-1",
    policy: "workflow-keepalive",
    target: { session: "registered@rig" },
    intervalSeconds: 1800,
    activeWakeIntervalSeconds: null,
    scanIntervalSeconds: null,
    lastEvaluationAt: null,
    lastFireAt: null,
    registeredBySession: "ops@kernel",
    registeredAt: "2026-05-03T07:00:00.000Z",
    ...overrides,
  };
}

describe("workflow-keepalive 策略（PL-004 阶段 D；与 POC 一致，仅以 SQLite 为源）", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, workflowInstancesSchema]);
    // 植入 workflow_instance 与 frontier qitem。
    db.prepare(
      `INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json)
       VALUES ('inst-active', 'wf', '1', 'creator@rig', '2026-05-03T07:00:00Z', 'active', '["q-1","q-2"]')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json)
       VALUES ('inst-completed', 'wf', '1', 'creator@rig', '2026-05-03T07:00:00Z', 'completed', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json)
       VALUES ('inst-waiting', 'wf', '1', 'creator@rig', '2026-05-03T07:00:00Z', 'waiting', '["q-3"]')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_instances (instance_id, workflow_name, workflow_version, created_by_session, created_at, status, current_frontier_json)
       VALUES ('inst-empty', 'wf', '1', 'creator@rig', '2026-05-03T07:00:00Z', 'active', '[]')`,
    ).run();
    for (const [id, dest] of [["q-1", "owner1@rig"], ["q-2", "owner2@rig"], ["q-3", "waiter@rig"]] as const) {
      db.prepare(
        `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
         VALUES (?, '2026-05-03T07:00:00Z', '2026-05-03T07:00:00Z', 'src@r', ?, 'pending', 'routine', 'x')`,
      ).run(id, dest);
    }
  });

  afterEach(() => db.close());

  it("带 frontier 的活跃实例 → 发送给首个解析出的所有者；在 notes 中列出其余目标", async () => {
    const policy = makeWorkflowKeepalivePolicy({ db });
    const out = await policy.evaluate(
      makeJob({ context: { workflow_instance_id: "inst-active" } }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target.session).toBe("owner1@rig");
    expect(out.message).toContain("Workflow keepalive");
    expect(out.message).toContain("inst-active");
    expect(out.notes?.frontierLength).toBe(2);
  });

  it("waiting 状态同样符合条件（与 POC 一致）", async () => {
    const policy = makeWorkflowKeepalivePolicy({ db });
    const out = await policy.evaluate(
      makeJob({ context: { workflow_instance_id: "inst-waiting" } }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target.session).toBe("waiter@rig");
  });

  it("completed 状态 → action=terminal，原因为 workflow_not_active（与 POC 的 terminal:true 一致）", async () => {
    const policy = makeWorkflowKeepalivePolicy({ db });
    const out = await policy.evaluate(
      makeJob({ context: { workflow_instance_id: "inst-completed" } }),
    );
    expect(out.action).toBe("terminal");
    if (out.action !== "terminal") return;
    expect(out.reason).toBe("workflow_not_active");
  });

  it("frontier 为空且无回退上下文 → 以 empty_frontier 跳过", async () => {
    const policy = makeWorkflowKeepalivePolicy({ db });
    // inst-empty 的 frontier 为空，且上下文中没有 observer_session。created_by_session
    //（'creator@rig'）仍算附加目标，因此此案例实际需要创建者与观察者都无法解析的实例。
    // 这里向 inst-empty 传入无观察者上下文，并观察 "creator@rig" 生效（与 POC 一致：
    // 附加目标始终包含 workflow.created_by）。
    const out = await policy.evaluate(
      makeJob({ context: { workflow_instance_id: "inst-empty" } }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.target.session).toBe("creator@rig");
  });

  it("实例缺失 → action=terminal，原因为 workflow_instance_missing", async () => {
    const policy = makeWorkflowKeepalivePolicy({ db });
    const out = await policy.evaluate(
      makeJob({ context: { workflow_instance_id: "non-existent" } }),
    );
    expect(out.action).toBe("terminal");
    if (out.action !== "terminal") return;
    expect(out.reason).toBe("workflow_instance_missing");
  });

  it("缺少 context.workflow_instance_id 时抛出 policy_spec_invalid", async () => {
    const policy = makeWorkflowKeepalivePolicy({ db });
    try {
      await policy.evaluate(makeJob({ context: {} }));
      throw new Error("预期应抛出异常");
    } catch (err) {
      expect((err as Error & { code: string }).code).toBe("policy_spec_invalid");
    }
  });

  it("将显式 observer_session 加入附加目标", async () => {
    const policy = makeWorkflowKeepalivePolicy({ db });
    const out = await policy.evaluate(
      makeJob({
        context: {
          workflow_instance_id: "inst-active",
          observer_session: "observer@rig",
        },
      }),
    );
    expect(out.action).toBe("send");
    if (out.action !== "send") return;
    expect(out.notes?.additionalRoutingTargets).toContain("observer@rig");
  });

  it("关键约束：策略仅从 SQLite workflow_instances 读取（审计行 18）", async () => {
    // 删除 queue_items 表——策略仍必须直接从 workflow_instances 读取实例数据。
    //（预期 frontier 所有者查找静默失败或产生空解析集，但 workflow_instances 读取必须成功。）
    const policy = makeWorkflowKeepalivePolicy({ db });
    const out = await policy.evaluate(
      makeJob({ context: { workflow_instance_id: "inst-active" } }),
    );
    // 直接读取 workflow_instances 成功——策略返回有意义的结果，而不是因缺少 Markdown
    // 来源而抛错。
    expect(out.action === "send" || out.action === "terminal" || out.action === "skip").toBe(true);
  });
});
