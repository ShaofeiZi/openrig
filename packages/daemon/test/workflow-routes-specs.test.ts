// 内置 workflow 规范——GET /api/workflow/specs 路由测试。
//
// 使用手工挂载的 Hono 应用、基础 WorkflowRuntime 和新的 isBuiltIn 计算来驱动新 specs 路由。
// 固定以下关键行为：
//
//   - 空 cache：{ specs: [] }
//   - 混合（内置 + 操作者）行：逐行设置 isBuiltIn 标志
//   - 未设置 workflowBuiltinSpecsDir 上下文：所有行 isBuiltIn=false
//     （平稳回退——界面仍可用，只是不显示标记）
//   - 路由顺序：字面路径 /specs 不会被 /:instance_id 通配路由遮蔽

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { workflowRoutes } from "../src/routes/workflow.js";

const ALPHA_SPEC = `workflow:
  id: alpha-spec
  version: 1
  objective: alpha 测试
  roles:
    a:
      preferred_targets: [a@r]
  steps:
    - id: only
      actor_role: a
      allowed_exits: [handoff]
`;

function buildApp(opts: { runtime: WorkflowRuntime; eventBus: EventBus; builtinDir?: string }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("workflowRuntime" as never, opts.runtime);
    c.set("eventBus" as never, opts.eventBus);
    c.set("workflowBuiltinSpecsDir" as never, opts.builtinDir);
    await next();
  });
  app.route("/api/workflow", workflowRoutes());
  return app;
}

describe("GET /api/workflow/specs", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let eventBus: EventBus;
  let cleanupRoot: string;
  let builtinDir: string;
  let operatorDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    eventBus = new EventBus(db);
    const queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus, queueRepo });
    cleanupRoot = mkdtempSync(join(tmpdir(), "specs-route-"));
    builtinDir = join(cleanupRoot, "builtin", "workflow-specs");
    operatorDir = join(cleanupRoot, "operator");
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(operatorDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  it("没有缓存规范时返回 { specs: [] }", async () => {
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specs: unknown[] };
    expect(body.specs).toEqual([]);
  });

  it("返回每个缓存规范及其标准字段", async () => {
    const operatorSpec = join(operatorDir, "alpha.yaml");
    writeFileSync(operatorSpec, ALPHA_SPEC);
    runtime.specCache.readThrough(operatorSpec);
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specs: Array<Record<string, unknown>> };
    expect(body.specs).toHaveLength(1);
    expect(body.specs[0]).toMatchObject({
      name: "alpha-spec",
      version: "1",
      sourcePath: operatorSpec,
      isBuiltIn: false,
    });
  });

  it("sourcePath 位于 builtinDir 下的规范会计算为 isBuiltIn=true", async () => {
    const builtinSpec = join(builtinDir, "alpha.yaml");
    writeFileSync(builtinSpec, ALPHA_SPEC);
    runtime.specCache.readThrough(builtinSpec);
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    const body = (await res.json()) as { specs: Array<{ name: string; isBuiltIn: boolean }> };
    expect(body.specs[0]?.isBuiltIn).toBe(true);
  });

  it("未设置 workflowBuiltinSpecsDir 上下文时 isBuiltIn=false（平稳降级）", async () => {
    const builtinSpec = join(builtinDir, "alpha.yaml");
    writeFileSync(builtinSpec, ALPHA_SPEC);
    runtime.specCache.readThrough(builtinSpec);
    const app = buildApp({ runtime, eventBus });  // 无 builtinDir
    const res = await app.request("/api/workflow/specs");
    const body = (await res.json()) as { specs: Array<{ isBuiltIn: boolean }> };
    expect(body.specs[0]?.isBuiltIn).toBe(false);
  });

  it("混合内置 + 操作者规范时，每行都获得正确的 isBuiltIn 标志", async () => {
    const builtinPath = join(builtinDir, "alpha.yaml");
    writeFileSync(builtinPath, ALPHA_SPEC);
    runtime.specCache.readThrough(builtinPath);

    // 操作者在 workspace 路径编写另一个规范。
    const operatorPath = join(operatorDir, "beta.yaml");
    writeFileSync(operatorPath, ALPHA_SPEC.replace(/alpha-spec/g, "beta-spec").replace(/alpha 测试/g, "beta 测试"));
    runtime.specCache.readThrough(operatorPath);

    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    const body = (await res.json()) as { specs: Array<{ name: string; isBuiltIn: boolean }> };
    const byName = new Map(body.specs.map((s) => [s.name, s.isBuiltIn]));
    expect(byName.get("alpha-spec")).toBe(true);
    expect(byName.get("beta-spec")).toBe(false);
  });

  it("不会将同级后缀路径标记为内置（误报守卫）", async () => {
    // 路径 /tmp/.../builtin/workflow-specs-OTHER/foo.yaml 中的规范，不应仅因前缀匹配
    // builtinDir 字符串就被标记为 isBuiltIn。路由使用 path.sep 边界语义。
    const siblingDir = `${builtinDir}-other`;
    mkdirSync(siblingDir, { recursive: true });
    const siblingPath = join(siblingDir, "alpha.yaml");
    writeFileSync(siblingPath, ALPHA_SPEC);
    runtime.specCache.readThrough(siblingPath);
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    const body = (await res.json()) as { specs: Array<{ isBuiltIn: boolean }> };
    expect(body.specs[0]?.isBuiltIn).toBe(false);
  });

  it("路由顺序：字面路径 /specs 不会被 /:instance_id 通配路由遮蔽", async () => {
    // 若无路由顺序修复，GET /api/workflow/specs 会命中 /:instance_id handler，
    // 后者会将 "specs" 当作虚假 id 并返回 404。
    const app = buildApp({ runtime, eventBus, builtinDir });
    const res = await app.request("/api/workflow/specs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { specs: unknown };
    // 具有 specs 信封结构，而非实例未找到错误。
    expect(body).toHaveProperty("specs");
    expect(body).not.toHaveProperty("error");
  });
});
