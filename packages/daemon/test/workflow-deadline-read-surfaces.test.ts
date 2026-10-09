import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
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
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";
import { workflowRoutes } from "../src/routes/workflow.js";

/**
 * OPR.0.4.6.WF1 FR-2 完成修补
 *（qitem-20260706211220-279039f5）——已批准的可查询性条款：
 * “instance 显示为 stuck（可通过 list/show/trace 等查询），并携带 evidence
 *（step、owner、deadline、age）”。
 *
 * 这些测试锁定读取 surface：每个 list 行、show body 和 trace/continue instance 都携带完整的
 * 派生分类 tuple；无需任何状态写入即可显示 overdue 分类，且自清除语义保持派生（只需使用新时钟
 * 重新读取）。同时服务于 WF-3 rollup 和 WF-5 的 ▲ source——一个结构、一个 evaluator 归属。
 */

const SPEC = `workflow:
  id: deadline-read-fixture
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

function buildApp(opts: { eventBus: EventBus; runtime: WorkflowRuntime }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("workflowRuntime" as never, opts.runtime);
    await next();
  });
  app.route("/api/workflow", workflowRoutes());
  return app;
}

describe("WF-1 FR-2 完成修补——读取 surface 上的 deadline", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let writerRuntime: WorkflowRuntime;
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
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝为 fail-closed（MF2）——旨在 nudge 的 terminal close 需要同数据库 intent store，
    // 才能让 wake 持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    writerRuntime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-deadline-read-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  async function instantiate(): Promise<string> {
    const result = await writerRuntime.instantiate({
      specPath,
      rootObjective: "deadline read pins",
      createdBySession: "orch@rig",
    });
    return result.instance.instanceId;
  }

  /** runtime 时钟位于未来 `offsetSeconds` 秒的 reader app。 */
  function readerAppAt(offsetSeconds: number): Hono {
    const reader = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      now: () => new Date(Date.now() + offsetSeconds * 1000),
    });
    return buildApp({ eventBus: bus, runtime: reader });
  }

  it("新 instance 在 list、show 和 trace 上读取为 healthy——deadline 存在，evidence 为 null", async () => {
    const instanceId = await instantiate();
    const app = readerAppAt(0);

    const list = await (await app.request("/api/workflow/list")).json() as Array<Record<string, unknown>>;
    const row = list.find((r) => r.instanceId === instanceId);
    expect(row?.deadline).toEqual({ state: "healthy", evidence: null });

    const show = await (await app.request(`/api/workflow/${instanceId}`)).json() as Record<string, unknown>;
    expect(show.deadline).toEqual({ state: "healthy", evidence: null });

    const trace = await (await app.request(`/api/workflow/${instanceId}/trace`)).json() as { instance: Record<string, unknown> };
    expect(trace.instance.deadline).toEqual({ state: "healthy", evidence: null });
  });

  it("超过阈值后，同一批行读取为 overdue-unclaimed 并携带完整 tuple——未发生写入", async () => {
    const instanceId = await instantiate();
    const app = readerAppAt(WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 60);

    const show = await (await app.request(`/api/workflow/${instanceId}`)).json() as {
      deadline: { state: string; evidence: Record<string, unknown> | null };
    };
    expect(show.deadline.state).toBe("overdue-unclaimed");
    const ev = show.deadline.evidence;
    expect(ev).not.toBeNull();
    // 已批准 tuple：step、owner、deadline anchor、age。
    expect(ev?.stepId).toBe("produce");
    expect(ev?.ownerSession).toBe("producer@rig");
    expect(ev?.anchor).toBe("created_at");
    expect(typeof ev?.anchorAt).toBe("string");
    expect(ev?.overdueBySeconds).toBeGreaterThanOrEqual(0);
    expect(ev?.ageSeconds).toBeGreaterThanOrEqual(WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS);

    // list 携带相同分类（同一 evaluator、同一次读取）。
    const list = await (await app.request("/api/workflow/list?status=active")).json() as Array<{
      instanceId: string; deadline: { state: string };
    }>;
    expect(list.find((r) => r.instanceId === instanceId)?.deadline.state).toBe("overdue-unclaimed");

    // 派生而从不存储：使用当前时钟的 reader 仍报告 healthy。
    const freshApp = readerAppAt(0);
    const fresh = await (await freshApp.request(`/api/workflow/${instanceId}`)).json() as {
      deadline: { state: string };
    };
    expect(fresh.deadline.state).toBe("healthy");
  });

  it("continue 的 instance 也携带 verdict（trace/continue 共享增强结构）", async () => {
    const instanceId = await instantiate();
    const app = readerAppAt(WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 60);
    const res = await app.request(`/api/workflow/${instanceId}/continue`, { method: "POST" });
    const body = await res.json() as { instance: { deadline: { state: string } } };
    expect(body.instance.deadline.state).toBe("overdue-unclaimed");
  });

  it("terminal instance（空 frontier）读取为 healthy——没有可逾期内容", async () => {
    const instanceId = await instantiate();
    // 通过 projector 路径以 terminal 方式关闭 entry step。
    const trace = await (await readerAppAt(0).request(`/api/workflow/${instanceId}/trace`)).json() as {
      instance: { currentFrontier: string[] };
    };
    const packetId = trace.instance.currentFrontier[0];
    await writerRuntime.project({
      instanceId,
      currentPacketId: packetId,
      exit: "failed",
      actorSession: "producer@rig",
      resultNote: "fixture terminal close",
    });
    const app = readerAppAt(WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 60);
    const show = await (await app.request(`/api/workflow/${instanceId}`)).json() as {
      status: string; deadline: { state: string; evidence: unknown };
    };
    expect(show.status).toBe("failed");
    expect(show.deadline).toEqual({ state: "healthy", evidence: null });
  });
});
