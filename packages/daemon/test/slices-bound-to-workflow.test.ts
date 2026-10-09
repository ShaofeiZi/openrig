// Spec Library + Activation Lens v0 中的 workflow——boundToWorkflow 过滤器。
//
// 锁定 GET /api/slices?boundToWorkflow=<name>:<version>：通过 Slice Story View v1 为详情投影
// 所用的同一个 findSliceWorkflowBinding helper，将 slice 列表缩小到 primary workflow_instance
// binding 与请求 spec（name + version）匹配的项。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { slicesRoutes } from "../src/routes/slices.js";

function buildApp(opts: { indexer: SliceIndexer; projector: SliceDetailProjector }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, opts.indexer);
    c.set("sliceDetailProjector" as never, opts.projector);
    await next();
  });
  app.route("/api/slices", slicesRoutes());
  return app;
}

function writeSlice(slicesRoot: string, name: string, body: string, qitemIds: string[]): void {
  const dir = path.join(slicesRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const qitemBlock = qitemIds.length > 0
    ? `qitems:\n${qitemIds.map((q) => `  - ${q}`).join("\n")}\n`
    : "";
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `---\nstatus: active\n${qitemBlock}---\n# ${body}`,
  );
}

function ensureQitem(db: Database.Database, qitemId: string, body = "fixture"): void {
  db.prepare(
    `INSERT OR IGNORE INTO queue_items
       (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
     VALUES (?, '2026-05-04T00:00:00.000Z', '2026-05-04T00:00:00.000Z', 'src@r', 'dst@r', 'in-progress', 'routine', ?)`,
  ).run(qitemId, body);
}

function insertInstance(db: Database.Database, opts: {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  currentFrontier: string[];
  createdAt?: string;
}): void {
  db.prepare(
    `INSERT INTO workflow_instances (
       instance_id, workflow_name, workflow_version,
       created_by_session, created_at, status,
       current_frontier_json, current_step_id, hop_count
     ) VALUES (?, ?, ?, 'creator@r', ?, 'active', ?, NULL, 0)`,
  ).run(
    opts.instanceId,
    opts.workflowName,
    opts.workflowVersion,
    opts.createdAt ?? "2026-05-04T00:00:00.000Z",
    JSON.stringify(opts.currentFrontier),
  );
}

describe("GET /api/slices?boundToWorkflow=<name>:<version>", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let cleanupDir: string;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "slices-bound-test-"));
    cleanupDir = base;
    slicesRoot = path.join(base, "slices");
    fs.mkdirSync(slicesRoot, { recursive: true });
    const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    const projector = new SliceDetailProjector({ db, indexer });
    app = buildApp({ indexer, projector });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanupDir, { recursive: true, force: true });
  });

  it("将列表缩小到 primary instance 与 spec 匹配的 slice", async () => {
    const qBound = "01J0BOUND0000000000000000";
    const qOther = "01J0OTHER0000000000000000";
    // Body 文本提到 slice 名，使 SliceIndexer.matchQitems 将 qitem 与 slice 关联。
    ensureQitem(db, qBound, "work for alpha");
    ensureQitem(db, qOther, "work for beta");
    writeSlice(slicesRoot, "alpha", "alpha slice", [qBound]);
    writeSlice(slicesRoot, "beta", "beta slice", [qOther]);

    insertInstance(db, {
      instanceId: "inst-alpha",
      workflowName: "conveyor",
      workflowVersion: "1",
      currentFrontier: [qBound],
    });
    insertInstance(db, {
      instanceId: "inst-beta",
      workflowName: "other-workflow",
      workflowVersion: "1",
      currentFrontier: [qOther],
    });

    const res = await app.request("/api/slices?boundToWorkflow=conveyor:1");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      slices: Array<{ name: string }>;
      boundToWorkflow: { specName: string; specVersion: string; matched: number; total: number };
    };
    expect(body.slices.map((s) => s.name)).toEqual(["alpha"]);
    expect(body.boundToWorkflow.specName).toBe("conveyor");
    expect(body.boundToWorkflow.specVersion).toBe("1");
    expect(body.boundToWorkflow.matched).toBe(1);
  });

  it("没有 slice 匹配时返回空列表", async () => {
    const q = "01J0NOMATCH00000000000000";
    ensureQitem(db, q, "work for alpha");
    writeSlice(slicesRoot, "alpha", "alpha slice", [q]);
    insertInstance(db, {
      instanceId: "inst-1",
      workflowName: "actual",
      workflowVersion: "1",
      currentFrontier: [q],
    });

    const res = await app.request("/api/slices?boundToWorkflow=missing:1");
    const body = await res.json() as { slices: unknown[]; boundToWorkflow: { matched: number } };
    expect(body.slices).toHaveLength(0);
    expect(body.boundToWorkflow.matched).toBe(0);
  });

  it("畸形 boundToWorkflow 值（无冒号）返回 400", async () => {
    writeSlice(slicesRoot, "alpha", "alpha slice", []);
    const res = await app.request("/api/slices?boundToWorkflow=just-name");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("boundToWorkflow_invalid");
  });

  it("boundToWorkflow 缺席时返回未过滤列表", async () => {
    writeSlice(slicesRoot, "alpha", "alpha slice", []);
    writeSlice(slicesRoot, "beta", "beta slice", []);
    const res = await app.request("/api/slices");
    const body = await res.json() as { slices: Array<{ name: string }>; boundToWorkflow: unknown };
    expect(body.slices.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    expect(body.boundToWorkflow).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// qitem-ccf87c0d 修订 gate——boundToWorkflow 复合操作负载契约。route 先运行 list()，再对每个
// 已过滤 slice 运行 indexer.get()；在 75245ed6 上，每次未缓存 get 都建立自己的 2-scan batch：
// 40 个 slice 共执行 82 次 queue 扫描（由 guard 复现）。契约：一次 lens 请求执行恒定次数的
// queue_items 扫描。此路径没有 gather 读取，因此可直接应用全量计数规则（LIKE 与非 LIKE；排除
// INSERT 和 WHERE qitem_id IN 的主键点查）。
// ---------------------------------------------------------------------------

describe("qitem-ccf87c0d——boundToWorkflow 总 queue-scan 负载契约", () => {
  function instrumentQueueScans(target: Database.Database): () => number {
    let n = 0;
    const origPrepare = target.prepare.bind(target);
    (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const isScan = /from\s+queue_items/i.test(sql)
        && !/^\s*insert/i.test(sql)
        && !/where\s+qitem_id\s+in/i.test(sql);
      if (!isScan) return stmt;
      return {
        all: (...a: unknown[]) => { n++; return stmt.all!(...a); },
        iterate: (...a: unknown[]) => { n++; return stmt.iterate!(...a); },
        get: (...a: unknown[]) => { n++; return stmt.get!(...a); },
        run: (...a: unknown[]) => stmt.run!(...a),
      };
    };
    return () => n;
  }

  it("对 40 个 slice 的一次 GET /api/slices?boundToWorkflow 最多执行 4 次 queue_items 扫描，且响应诊断完整", async () => {
    const db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema,
      queueTransitionsSchema, workflowSpecsSchema, workflowInstancesSchema,
      workflowStepTrailsSchema, missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-load', 'rig')`).run();
    ensureQitem(db, "q-lone", "matches nothing");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "btw-load-"));
    const slicesRoot = path.join(base, "missions");
    for (let i = 0; i < 40; i++) {
      const dir = path.join(slicesRoot, "load-mission", "slices", `ld-${String(i).padStart(2, "0")}-topic`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "README.md"), `---\nstatus: active\n---\n# t${i}\n`);
    }
    const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    const projector = new SliceDetailProjector({ db, indexer });
    const app = buildApp({ indexer, projector });
    const scans = instrumentQueueScans(db);
    const res = await app.request("/api/slices?boundToWorkflow=openrig-velocity:1.0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { boundToWorkflow: { matched: number; total: number }; slices: unknown[] };
    expect(body.boundToWorkflow).toEqual({ specName: "openrig-velocity", specVersion: "1.0", matched: 0, total: 40 });
    expect(body.slices).toHaveLength(0);
    // 75245ed6 修复前：2（冷 list batch）+ 40x2（每个已过滤 slice 的未缓存 get）= 82。契约：恒定。
    expect(scans()).toBeLessThanOrEqual(4);
    db.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
});
