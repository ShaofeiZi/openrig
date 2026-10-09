import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { classificationFieldsAndAttemptsSchema } from "../src/db/migrations/086_classification_fields_and_attempts.js";
import { classificationIdentityProvenanceSchema } from "../src/db/migrations/089_classification_identity_provenance.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import { ProjectClassifier } from "../src/domain/project-classifier.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { projectsRoutes } from "../src/routes/projects.js";

function buildApp(opts: {
  eventBus: EventBus;
  classifier: ProjectClassifier;
  leaseMgr: ClassifierLeaseManager;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("projectClassifier" as never, opts.classifier);
    c.set("classifierLeaseManager" as never, opts.leaseMgr);
    await next();
  });
  app.route("/api/projects", projectsRoutes());
  return app;
}

describe("projects 路由（PL-004 阶段 B）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let leaseMgr: ClassifierLeaseManager;
  let classifier: ProjectClassifier;
  let streamStore: StreamStore;
  let app: Hono;

  // R1 修复（阻塞项 1）：测试现在迁移 streamItemsSchema（阶段 A 迁移 023），
  // 并植入真实 stream_items 行，使 L1→L2 外键与存在性检查通过路由进行端到端演练。
  function seedStreamItem(streamItemId: string): void {
    streamStore.emit({
      streamItemId,
      sourceSession: "discovery@rig",
      body: `${streamItemId} 的正文`,
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, classifierLeasesSchema, projectClassificationsSchema, classificationFieldsAndAttemptsSchema, classificationIdentityProvenanceSchema]);
    bus = new EventBus(db);
    leaseMgr = new ClassifierLeaseManager(db, bus);
    classifier = new ProjectClassifier(db, bus, leaseMgr);
    streamStore = new StreamStore(db, bus);
    app = buildApp({ eventBus: bus, classifier, leaseMgr });
  });

  afterEach(() => db.close());

  it("POST /api/projects/lease/acquire 返回 201 和活跃 lease", async () => {
    const res = await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    expect(res.status).toBe(201);
    const lease = (await res.json()) as { state: string; classifierSession: string };
    expect(lease.state).toBe("active");
    expect(lease.classifierSession).toBe("alice@rig");
  });

  it("POST /api/projects/project 要求 lease，并对 stream_item_id 幂等", async () => {
    seedStreamItem("stream-x");
    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    const first = await app.request("/api/projects/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamItemId: "stream-x",
        classifierSession: "alice@rig",
        leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
        classificationType: "idea",
      }),
    });
    expect(first.status).toBe(201);
    const project = (await first.json()) as { projectId: string };
    expect(project.projectId).toMatch(/^[0-9A-Z]{26}$/);

    const second = await app.request("/api/projects/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamItemId: "stream-x",
        classifierSession: "alice@rig",
        leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
        classificationType: "bug",
      }),
    });
    expect(second.status).toBe(409);
    const err = (await second.json()) as { error: string };
    expect(err.error).toBe("idempotency_violation");
  });

  it("POST /api/projects/project 缺少活跃 lease 时返回 409 no_active_lease", async () => {
    seedStreamItem("stream-x");
    const res = await app.request("/api/projects/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamItemId: "stream-x",
        classifierSession: "alice@rig",
        leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      }),
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe("no_active_lease");
  });

  it("R1 阻塞项 1：POST /api/projects/project 使用不存在的 stream_item_id 时返回 400 unknown_stream_item", async () => {
    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    // 注意：未调用 seedStreamItem——stream-nonexistent 在 stream_items 中没有记录。
    const res = await app.request("/api/projects/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        streamItemId: "stream-nonexistent",
        classifierSession: "alice@rig",
        leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
        classificationType: "idea",
      }),
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string; message: string; streamItemId: string };
    expect(err.error).toBe("unknown_stream_item");
    expect(err.message).toMatch(/does not exist/);
    expect(err.streamItemId).toBe("stream-nonexistent");
  });

  it("POST /api/projects/reclaim-classifier 使用 --if-dead 时拒绝仍存活的持有者", async () => {
    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    const res = await app.request("/api/projects/reclaim-classifier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ byClassifierSession: "operator@rig", ifDead: true }),
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe("lease_still_active");
  });

  it("POST /api/projects/reclaim-classifier 不使用 --if-dead 时成功", async () => {
    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    const res = await app.request("/api/projects/reclaim-classifier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ byClassifierSession: "operator@rig" }),
    });
    expect(res.status).toBe(200);
    const lease = (await res.json()) as { state: string; reclaimedBySession: string };
    expect(lease.state).toBe("reclaimed");
    expect(lease.reclaimedBySession).toBe("operator@rig");
  });

  it("GET /api/projects/lease 返回活跃 lease（不存在时返回 404）", async () => {
    let res = await app.request("/api/projects/lease");
    expect(res.status).toBe(404);

    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });

    res = await app.request("/api/projects/lease");
    expect(res.status).toBe(200);
    const lease = (await res.json()) as { classifierSession: string };
    expect(lease.classifierSession).toBe("alice@rig");
  });

  it("GET /api/projects/list 按 classifierSession + classificationDestination 筛选", async () => {
    await app.request("/api/projects/lease/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierSession: "alice@rig" }),
    });
    for (const [id, dest] of [["s1", "planning@rig"], ["s2", "delivery@rig"], ["s3", "planning@rig"]] as Array<[string, string]>) {
      seedStreamItem(id);
      await app.request("/api/projects/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamItemId: id,
          classifierSession: "alice@rig",
          leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
          classificationDestination: dest,
        }),
      });
    }
    const res = await app.request("/api/projects/list?classificationDestination=planning%40rig");
    const data = (await res.json()) as unknown[];
    expect(data).toHaveLength(2);
  });

  it("R1 SSE 模式：GET /api/projects/sse 返回 200 + content-type text/event-stream（命中 handler，而非 /:id）", async () => {
    const res = await app.request("/api/projects/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：GET /api/projects/watch 返回 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/projects/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：GET /api/projects/sse 不返回 project_not_found（路由顺序回归守卫）", async () => {
    const res = await app.request("/api/projects/sse");
    try {
      expect(res.status).not.toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });
});
