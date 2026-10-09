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
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { workflowRoutes } from "../src/routes/workflow.js";
// OPR.0.4.6.FAC1（6e991a9d 的 guard 代码审查阻断项）：新绑定工作组 HTTP 状态映射的
// 路由级回归测试。
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "../src/db/migrations/051_workflow_resume.js";
import { workflowInstanceBoundRigSchema } from "../src/db/migrations/052_workflow_instance_bound_rig.js";

const SPEC = `workflow:
  id: routes-fixture
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
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
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

describe("工作流路由（PL-004 阶段 D）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      outboxEntriesSchema,
      coreSchema, eventsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝采用失败关闭（MF2）——意图唤醒的终止关闭需要同一数据库中的意图
    // 存储，才能让唤醒持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = buildApp({ eventBus: bus, runtime });
    tmp = mkdtempSync(join(tmpdir(), "wf-routes-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("POST /validate 对有效规范返回 ok=true", async () => {
    const res = await app.request("/api/workflow/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; summary: { entryRole: string | null } };
    expect(body.ok).toBe(true);
    expect(body.summary.entryRole).toBe("producer");
  });

  it("POST /validate 对缺失文件返回 404", async () => {
    const res = await app.request("/api/workflow/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: join(tmp, "missing.yaml") }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /instantiate 返回 201、实例和入口 qitem", async () => {
    const res = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "test", createdBySession: "ops@rig" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { instance: { instanceId: string }; entryQitemId: string };
    expect(body.instance.instanceId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.entryQitemId).toBeDefined();
  });

  // OPR.0.3.3.04.1（AC-3）判别翻转：发现的规范必须能按名称实例化（无隐藏文件路径）。
  // 修复前，instantiate 将裸名称传给 readThrough → spec_file_missing（404）；修复后，
  // 它根据预置缓存将名称解析为已存 sourcePath → 201。
  it("POST /instantiate 按名称解析预置规范（AC-3 可达性），而不只接受字面路径", async () => {
    // 按 starter-spec-loader 预置时的方式将规范写入缓存：readThrough 按名称缓存
    // `routes-fixture` 及其 sourcePath。
    const seed = await app.request("/api/workflow/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath }),
    });
    expect(seed.status).toBe(200);
    // 按发现的名称实例化（不使用路径）。
    const res = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: "routes-fixture", rootObjective: "by-name", createdBySession: "ops@rig" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { instance: { instanceId: string }; entryQitemId: string };
    expect(body.instance.instanceId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.entryQitemId).toBeDefined();
  });

  // OPR.0.3.3.04.1：保留字面 sourcePath 回退。既不是缓存名称也不是现有文件的标识符
  // 会按字面路径解析，并如实返回 404（spec_file_missing）；名称解析不掩盖真正的路径缺失错误。
  it("POST /instantiate 对未匹配名称回退到字面 sourcePath（如实返回 404）", async () => {
    const res = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: "no-such-name", rootObjective: "x", createdBySession: "ops@rig" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /instantiate 将队列目标校验错误公开为 400", async () => {
    const rejectingQueueRepo = new QueueRepository(db, bus, { validateRig: () => false });
    // P34：W1 接缝采用失败关闭（MF2）——意图唤醒的终止关闭需要同一数据库中的意图
    // 存储，才能让唤醒持久化。
    rejectingQueueRepo.attachOutbox(new OutboxHandler(db));
    const rejectingRuntime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo: rejectingQueueRepo,
    });
    const rejectingApp = buildApp({ eventBus: bus, runtime: rejectingRuntime });

    const res = await rejectingApp.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "test", createdBySession: "ops@rig" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_destination_rig");
    expect(body.error).not.toBe("internal_error");
    expect(body.message).toContain("producer@rig");
  });

  it("POST /project 关闭数据包并创建下一数据包", async () => {
    const create = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const created = (await create.json()) as { instance: { instanceId: string }; entryQitemId: string };
    const res = await app.request("/api/workflow/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: created.instance.instanceId,
        currentPacketId: created.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextStepId: string; nextOwnerSession: string };
    expect(body.nextStepId).toBe("review");
    expect(body.nextOwnerSession).toBe("reviewer@rig");
  });

  // R3 修复（guard 阻断项）：exit_not_allowed 必须以 HTTP 400 而非 500 内部服务错误公开，
  // 并保留结构化详情。断言公开路径无副作用：队列仍为 pending，实例状态不变。
  it("POST /project 将 exit_not_allowed 公开为带结构化详情的 400，且无副作用", async () => {
    const create = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const created = (await create.json()) as { instance: { instanceId: string }; entryQitemId: string };

    // 通过公开接口捕获拒绝前状态。
    const beforeShow = await app.request(`/api/workflow/${created.instance.instanceId}`);
    const beforeInstance = (await beforeShow.json()) as {
      currentFrontier: string[];
      currentStepId: string | null;
      status: string;
    };

    // 在只允许 handoff 的 produce 步骤尝试 exit=done。
    const res = await app.request("/api/workflow/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: created.instance.instanceId,
        currentPacketId: created.entryQitemId,
        exit: "done",
        actorSession: "producer@rig",
      }),
    });

    // R3 关键点：返回 400（而非 500），保留结构化错误码和详情。
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as {
      error: string;
      message: string;
      stepId?: string;
      attemptedExit?: string;
      allowedExits?: string[];
    };
    expect(body.error).toBe("exit_not_allowed");
    expect(body.error).not.toBe("internal_error");
    expect(body.message).toContain("produce");
    expect(body.stepId).toBe("produce");
    expect(body.attemptedExit).toBe("done");
    expect(body.allowedExits).toEqual(["handoff"]);

    // 公开路径无副作用：实例不变。
    const afterShow = await app.request(`/api/workflow/${created.instance.instanceId}`);
    const afterInstance = (await afterShow.json()) as {
      currentFrontier: string[];
      currentStepId: string | null;
      status: string;
    };
    expect(afterInstance.currentFrontier).toEqual(beforeInstance.currentFrontier);
    expect(afterInstance.currentStepId).toBe(beforeInstance.currentStepId);
    expect(afterInstance.status).toBe(beforeInstance.status);
    // trail 仍为空（未记录投射的步骤关闭）。
    const traceRes = await app.request(`/api/workflow/${created.instance.instanceId}/trace`);
    const trace = (await traceRes.json()) as { trail: Array<unknown> };
    expect(trace.trail).toEqual([]);
  });

  it("GET /list 返回全部实例", async () => {
    await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const res = await app.request("/api/workflow/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<unknown>;
    expect(body).toHaveLength(1);
  });

  it("GET /list?status=active 按状态过滤", async () => {
    await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const res = await app.request("/api/workflow/list?status=completed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<unknown>;
    expect(body).toHaveLength(0);
  });

  it("GET /:instance_id 对未知 id 返回 404", async () => {
    const res = await app.request("/api/workflow/unknown-id");
    expect(res.status).toBe(404);
  });

  it("GET /:instance_id 对已知 id 返回实例", async () => {
    const create = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const created = (await create.json()) as { instance: { instanceId: string } };
    const res = await app.request(`/api/workflow/${created.instance.instanceId}`);
    expect(res.status).toBe(200);
  });

  it("GET /:instance_id/trace 返回实例和 trail", async () => {
    const create = await app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "x", createdBySession: "ops@rig" }),
    });
    const created = (await create.json()) as { instance: { instanceId: string } };
    const res = await app.request(`/api/workflow/${created.instance.instanceId}/trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instance: { instanceId: string }; trail: Array<unknown> };
    expect(body.trail).toEqual([]);
  });

  // 阶段 A R1 SSE 路由顺序约束测试。
  it("R1 SSE 模式：GET /api/workflow/sse 返回 200 和 content-type text/event-stream", async () => {
    const res = await app.request("/api/workflow/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：GET /api/workflow/watch 返回 200 和 content-type text/event-stream", async () => {
    const res = await app.request("/api/workflow/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：GET /api/workflow/sse 不返回 instance_not_found（路由顺序回归防护）", async () => {
    const res = await app.request("/api/workflow/sse");
    try {
      expect(res.status).not.toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });
});

// ── OPR.0.4.6.WF1 guard 阻断项 1 回归 ─────────────────────────────────

import { vi } from "vitest";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";

describe("FR-5 路由契约：instance_version_conflict 为 HTTP 409，正文含 expected/actual（guard 阻断项 1）", () => {
  it("POST /project 作为过期并发失败方时返回 409，绝不返回 500", async () => {
    const db2 = createDb();
    migrate(db2, [
      outboxEntriesSchema,
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus2 = new EventBus(db2);
    db2.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo2 = new QueueRepository(db2, bus2, { validateRig: () => true });
    // P34：W1 接缝采用失败关闭（MF2）——意图唤醒的终止关闭需要同一数据库中的意图
    // 存储，才能让唤醒持久化。
    queueRepo2.attachOutbox(new OutboxHandler(db2));
    const runtime2 = new WorkflowRuntime({ db: db2, eventBus: bus2, queueRepo: queueRepo2 });
    const app2 = buildApp({ eventBus: bus2, runtime: runtime2 });
    const tmp2 = mkdtempSync(join(tmpdir(), "wf-route-409-"));
    const specPath2 = join(tmp2, "spec.yaml");
    writeFileSync(specPath2, SPEC);
    try {
      const inst = await runtime2.instantiate({
        specPath: specPath2,
        rootObjective: "route 409 pin",
        createdBySession: "ops@rig",
      });
      // 严格按单元固定项模拟竞态：路由的 project() 读取实例，随后并发 writer 在事务体
      // 运行前提升版本。
      const realGet = runtime2.instanceStore.getByIdOrThrow.bind(runtime2.instanceStore);
      vi.spyOn(runtime2.instanceStore, "getByIdOrThrow").mockImplementationOnce(
        (id: string) => {
          const stale = realGet(id);
          db2.prepare(
            `UPDATE workflow_instances SET version = version + 1 WHERE instance_id = ?`,
          ).run(id);
          return stale;
        },
      );
      const res = await app2.request("/api/workflow/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: inst.instance.instanceId,
          currentPacketId: inst.entryQitemId,
          exit: "handoff",
          actorSession: "producer@rig",
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("instance_version_conflict");
      expect(typeof body.expectedVersion).toBe("number");
      expect(typeof body.actualVersion).toBe("number");
      expect(body.actualVersion).toBe((body.expectedVersion as number) + 1);
      vi.restoreAllMocks();
      // 整个事务回滚：数据包保持不变；干净重试可成功。
      const retry = await app2.request("/api/workflow/project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: inst.instance.instanceId,
          currentPacketId: inst.entryQitemId,
          exit: "handoff",
          actorSession: "producer@rig",
        }),
      });
      expect(retry.status).toBe(200);
    } finally {
      db2.close();
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

// ── OPR.0.4.6.WF1 guard 第 2 轮阻断项回归 ───────────────────────────

describe("FR-7 路由契约：严格校验拒绝是结构化 400，绝不是 500（guard 第 2 轮阻断项）", () => {
  let db3: Database.Database;
  let app3: Hono;
  let tmp3: string;

  beforeEach(() => {
    db3 = createDb();
    migrate(db3, [
      outboxEntriesSchema,
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus3 = new EventBus(db3);
    db3.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo3 = new QueueRepository(db3, bus3, { validateRig: () => true });
    // P34：W1 接缝采用失败关闭（MF2）——意图唤醒的终止关闭需要同一数据库中的意图
    // 存储，才能让唤醒持久化。
    queueRepo3.attachOutbox(new OutboxHandler(db3));
    const runtime3 = new WorkflowRuntime({ db: db3, eventBus: bus3, queueRepo: queueRepo3 });
    app3 = buildApp({ eventBus: bus3, runtime: runtime3 });
    tmp3 = mkdtempSync(join(tmpdir(), "wf-route-400-"));
  });

  afterEach(() => {
    db3.close();
    rmSync(tmp3, { recursive: true, force: true });
  });

  it("POST /validate 遇到 workflow: 的根级同级字段时返回 400、spec_unknown_key 和详情", async () => {
    const p = join(tmp3, "root-sibling.yaml");
    writeFileSync(p, SPEC + "extra_root_key: true\n");
    const res = await app3.request("/api/workflow/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specPath: p }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("spec_unknown_key");
    expect(body.key).toBe("extra_root_key");
    expect(body.path).toBe("(document root)");
  });

  it("POST /validate 遇到无效 loop_guards.max_hops 时返回 400、spec_field_invalid 和字段详情", async () => {
    const p = join(tmp3, "bad-maxhops.yaml");
    writeFileSync(p, SPEC + "  loop_guards:\n    max_hops: nope\n");
    const res = await app3.request("/api/workflow/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specPath: p }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("spec_field_invalid");
    expect(body.field).toBe("workflow.loop_guards.max_hops");
  });

  it("POST /instantiate 使用同一映射器：严格校验拒绝返回 400，绝不是 500", async () => {
    const p = join(tmp3, "bad-instantiate.yaml");
    writeFileSync(p, SPEC + "  loop_guards:\n    max_hops: nope\n");
    const res = await app3.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specPath: p,
        rootObjective: "must not 500",
        createdBySession: "ops@rig",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("spec_field_invalid");
  });
});

// ── OPR.0.4.6.WF2（guard 阻断项 2）：新的语言/路由失败在公开路由接口上是
// 结构化 400/409，绝不是 500。────────────────────────────────────────────

describe("工作流路由——WF-2 结构化错误边界", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    db = createDb();
    const { bindingsSessionsSchema } = await import("../src/db/migrations/002_bindings_sessions.js");
    migrate(db, [
      outboxEntriesSchema,
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝采用失败关闭（MF2）——意图唤醒的终止关闭需要同一数据库中的意图
    // 存储，才能让唤醒持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = buildApp({ eventBus: bus, runtime });
    tmp = mkdtempSync(join(tmpdir(), "wf2-routes-"));
    prevHome = process.env.OPENRIG_HOME;
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.OPENRIG_HOME;
    else process.env.OPENRIG_HOME = prevHome;
  });

  async function instantiate(specPath: string): Promise<Response> {
    return app.request("/api/workflow/instantiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specPath, rootObjective: "boundary test", createdBySession: "ops@rig" }),
    });
  }

  it("已注册远程主机固定项实例化为 400 host_pin_remote_unsupported 并指明 MH-3（绝非 500）", async () => {
    writeFileSync(
      join(tmp, "hosts.yaml"),
      "hosts:\n  - id: vps-1\n    transport: ssh\n    target: vps-1.invalid\n",
    );
    process.env.OPENRIG_HOME = tmp;
    const specPath = join(tmp, "remote.yaml");
    writeFileSync(specPath, `workflow:
  id: rb-remote
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      host: vps-1
`);
    const res = await instantiate(specPath);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("host_pin_remote_unsupported");
    expect(body.message).toContain("MH-3");
  });

  it("无法满足的 harness 固定项实例化为 409 harness_pin_unsatisfied（绝非 500）", async () => {
    const specPath = join(tmp, "harness.yaml");
    writeFileSync(specPath, `workflow:
  id: rb-harness
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      harness: codex
`);
    // 没有预置席位运行 codex → 结构化路由冲突。
    const res = await instantiate(specPath);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("harness_pin_unsatisfied");
  });

  it("gate 字段/目标失败以 400 spec_invalid 公开并携带具名校验问题（绝非 500）", async () => {
    const specPath = join(tmp, "gate.yaml");
    writeFileSync(specPath, `workflow:
  id: rb-gate
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      gate:
        target: nobody-anywhere
`);
    const res = await instantiate(specPath);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: Array<{ code: string }> };
    expect(body.error).toBe("spec_invalid");
    expect(body.issues?.some((i) => i.code === "gate_target_unresolved")).toBe(true);
  });
});

// OPR.0.4.6.FAC1——6e991a9d 的 guard 代码审查阻断项：新的 bound-rig 错误在 domain
// 中正确抛出，却缺少 route errorResponse 映射，因此公开 HTTP/CLI 接口落入 500。这些
// 路由级回归驱动真实公开接口（workflow-bound-rig / workflow-role-resolution 的 domain
// 测试不会），并固定诚实状态：instantiate 作者边界 → 400，project 实时状态冲突 → 409。
//（这是第三次出现 WF-1/WF-2“新结构化错误一旦存在就需要 route-mapper 条目”类型。）
describe("工作流路由——FAC-1 bound-rig HTTP 状态映射（guard 阻断项 6e991a9d）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let tmp: string;
  let sessionSeq = 0;

  // 仅角色规范（零 preferred_targets），使能力解析器和结构化角色覆盖检查作用于绑定工作组。
  const ROLE_ONLY = `workflow:
  id: fac1-route-roleonly
  version: 1
  entry:
    role: lead
  roles:
    lead: {}
    worker: {}
  steps:
    - id: plan
      actor_role: lead
      allowed_exits:
        - handoff
    - id: build
      actor_role: worker
      allowed_exits:
        - done
`;

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [
      outboxEntriesSchema,
      queueItemSummarySchema, queueItemEvidenceRefSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      workflowInstanceVersionSchema, workflowSpecJsonSchema, workflowResumeSchema,
      workflowInstanceBoundRigSchema,
    ]);
    bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝采用失败关闭（MF2）——意图唤醒的终止关闭需要同一数据库中的意图
    // 存储，才能让唤醒持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = buildApp({ eventBus: bus, runtime });
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-routes-boundrig-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedSeat(rigId: string, rigName: string, pod: string, member: string, role: string): string {
    const podRec = podRepo.getPodByNamespace(rigId, pod) ?? podRepo.createPod(rigId, pod, pod);
    const node = rigRepo.addNode(rigId, `${pod}.${member}`, {
      role, runtime: "claude-code", cwd: "/tmp", podId: podRec.id, agentRef: "local:agents/x", profile: "default",
    });
    sessionSeq += 1;
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)`).run(
      `s-${String(sessionSeq).padStart(4, "0")}`, node.id, `${pod}-${member}@${rigName}`, "running",
    );
    return `${pod}-${member}@${rigName}`;
  }
  function writeSpec(name: string, content: string): string {
    const p = join(tmp, name);
    writeFileSync(p, content);
    return p;
  }
  function post(path: string, body: unknown): Promise<Response> {
    return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  it("POST /instantiate：显式 --rig 未知 → 400 bound_rig_unknown 和结构化详情，无实例行（架构裁定公开契约）", async () => {
    const before = db.prepare(`SELECT COUNT(*) c FROM workflow_instances`).get() as { c: number };
    const specPath = writeSpec("ro-unknown.yaml", ROLE_ONLY);
    const res = await post("/api/workflow/instantiate", {
      specPath, rootObjective: "t", createdBySession: "ops@rig", targetRig: "no-such-rig",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; registeredRigs?: string[] };
    expect(body.error).toBe("bound_rig_unknown");
    expect(body.registeredRigs).toBeDefined();
    const after = db.prepare(`SELECT COUNT(*) c FROM workflow_instances`).get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("POST /instantiate：已知绑定工作组在结构上缺少必需角色 → 400 bound_rig_role_uncovered", async () => {
    const rig = rigRepo.createRig("factory-min");
    seedSeat(rig.id, "factory-min", "dev", "lead", "lead"); // covers entry 'lead', NOT 'worker'
    const specPath = writeSpec("ro-uncovered.yaml", ROLE_ONLY);
    const res = await post("/api/workflow/instantiate", {
      specPath, rootObjective: "t", createdBySession: "ops@factory-min", targetRig: "factory-min",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bound_rig_role_uncovered");
  });

  it("POST /project：已持久化绑定工作组在运行途中消失 → 409 bound_rig_not_found", async () => {
    const rig = rigRepo.createRig("factory-gone");
    seedSeat(rig.id, "factory-gone", "dev", "lead", "lead");
    seedSeat(rig.id, "factory-gone", "dev", "worker", "worker"); // both roles covered → instantiate succeeds bound
    const specPath = writeSpec("ro-vanish.yaml", ROLE_ONLY);
    const inst = await post("/api/workflow/instantiate", {
      specPath, rootObjective: "t", createdBySession: "ops@factory-gone", targetRig: "factory-gone",
    });
    expect(inst.status).toBe(201);
    const ib = (await inst.json()) as { instance: { instanceId: string }; entryQitemId: string; entryOwnerSession: string };
    // 绑定工作组在运行途中被拆除。
    db.prepare(`DELETE FROM rigs WHERE name = 'factory-gone'`).run();
    // 投射入口时，在已消失的绑定工作组上解析仅角色的 'build' 步骤。
    const proj = await post("/api/workflow/project", {
      instanceId: ib.instance.instanceId, currentPacketId: ib.entryQitemId, exit: "handoff", actorSession: ib.entryOwnerSession,
    });
    expect(proj.status).toBe(409);
    expect(((await proj.json()) as { error: string }).error).toBe("bound_rig_not_found");
  });
});
