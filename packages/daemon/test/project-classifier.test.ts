import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { StreamStore } from "../src/domain/stream-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClassifierLeaseManager } from "../src/domain/classifier-lease-manager.js";
import {
  ProjectClassifier,
  ProjectClassifierError,
} from "../src/domain/project-classifier.js";
import { ClassifierLeaseError } from "../src/domain/classifier-lease-manager.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("ProjectClassifier（PL-004 Phase B；L2 classifier 写路径）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let leaseMgr: ClassifierLeaseManager;
  let classifier: ProjectClassifier;
  let streamStore: StreamStore;
  let captured: PersistedEvent[];

  // R1 修复（BLOCKER 1）：测试现在迁移 streamItemsSchema（Phase A migration 023），并填种
  // 真实 stream_items row，使 project-classifier 的 L1→L2 FK + existence check 可端到端执行。
  // 通过 Phase A StreamStore 发出 stream item 的 helper。
  function seedStreamItem(streamItemId: string): void {
    streamStore.emit({
      streamItemId,
      sourceSession: "discovery@rig",
      body: `body for ${streamItemId}`,
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, classifierLeasesSchema, projectClassificationsSchema, classificationFieldsAndAttemptsSchema, classificationIdentityProvenanceSchema]);
    bus = new EventBus(db);
    leaseMgr = new ClassifierLeaseManager(db, bus);
    classifier = new ProjectClassifier(db, bus, leaseMgr);
    streamStore = new StreamStore(db, bus);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("使用有效 lease 分类时创建 project_classifications row 并发出 project.classified", () => {
    leaseMgr.acquire("alice@rig");
    seedStreamItem("stream-1");
    const proj = classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      classificationType: "idea",
      classificationDestination: "planning@rig",
    });
    expect(proj.projectId).toMatch(/^[0-9A-Z]{26}$/); // ULID shape
    expect(proj.streamItemId).toBe("stream-1");
    expect(proj.classifierSession).toBe("alice@rig");
    expect(proj.classificationType).toBe("idea");
    expect(captured.some((e) => e.type === "project.classified")).toBe(true);
  });

  it("没有 active lease 时 classify 抛出 no_active_lease", () => {
    seedStreamItem("stream-1");
    expect(() => classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
    })).toThrow(ClassifierLeaseError);
  });

  it("非 holder 执行 classify 时抛出 lease_held", () => {
    leaseMgr.acquire("alice@rig");
    seedStreamItem("stream-1");
    expect(() => classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "bob@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
    })).toThrow(/lease_held|alice@rig/);
  });

  it("R1 BLOCKER 1：分类不存在的 stream_item_id 时抛出 unknown_stream_item，不暴露 FK violation", () => {
    leaseMgr.acquire("alice@rig");
    // 不填种：stream_items 中没有 "nonexistent-stream" row。
    try {
      classifier.classify({
        streamItemId: "nonexistent-stream",
        classifierSession: "alice@rig",
        leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
        classificationType: "idea",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectClassifierError);
      expect((err as ProjectClassifierError).code).toBe("unknown_stream_item");
      expect((err as ProjectClassifierError).meta?.streamItemId).toBe("nonexistent-stream");
    }
    // 纵深防御：确认没有插入 row；existence check 在 INSERT 前触发，因此无需 FK constraint 兜底。
    const projectionAttempts = classifier.list();
    expect(projectionAttempts).toHaveLength(0);
  });

  it("R1 BLOCKER 1：existence check 被绕过时，FK constraint 作为安全网", () => {
    // 绕过 project-classifier 的直接 INSERT 应被 SQLite FK constraint 阻止；connection.ts
    // 中 PRAGMA foreign_keys = ON。
    expect(() => {
      db.prepare(
        `INSERT INTO project_classifications (
          project_id, stream_item_id, classifier_session, ts_projected
        ) VALUES (?, ?, ?, ?)`
      ).run("proj-bypass", "nonexistent-via-bypass", "alice@rig", "2026-05-03T00:00:00Z");
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("classify 对 stream_item_id 幂等，重复 projection 返回 idempotency_violation 409", () => {
    leaseMgr.acquire("alice@rig");
    seedStreamItem("stream-1");
    classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      classificationType: "idea",
    });
    expect(() => classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      classificationType: "bug",
    })).toThrow(ProjectClassifierError);
    try {
      classifier.classify({
        streamItemId: "stream-1",
        classifierSession: "alice@rig",
        leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
        classificationType: "bug",
      });
    } catch (err) {
      expect((err as ProjectClassifierError).code).toBe("idempotency_violation");
    }
  });

  it("重复 projection 尝试保留首次 classification 的 classifier_session", () => {
    leaseMgr.acquire("alice@rig");
    seedStreamItem("stream-1");
    const first = classifier.classify({
      streamItemId: "stream-1",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      classificationType: "idea",
    });
    // Reclaim + 新 lease + 同一 session 也可以再次尝试，但仍被拒绝。
    leaseMgr.reclaim("operator@rig");
    leaseMgr.acquire("bob@rig");
    try {
      classifier.classify({
        streamItemId: "stream-1",
        classifierSession: "bob@rig",
        leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
        classificationType: "feature-request",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectClassifierError);
      expect((err as ProjectClassifierError).code).toBe("idempotency_violation");
    }
    const lookup = classifier.getByStreamItemId("stream-1");
    expect(lookup?.projectId).toBe(first.projectId);
    expect(lookup?.classifierSession).toBe("alice@rig"); // first wins
    expect(lookup?.classificationType).toBe("idea");
  });

  it("classify 接受全部 6 个 classification 字段 + action；未设置时为 null", () => {
    leaseMgr.acquire("alice@rig");
    seedStreamItem("stream-full");
    seedStreamItem("stream-minimal");
    const full = classifier.classify({
      streamItemId: "stream-full",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      classificationType: "idea",
      classificationUrgency: "high",
      classificationMaturity: "ratified",
      classificationConfidence: "high",
      classificationDestination: "planning@rig",
      action: "create",
    });
    expect(full.classificationUrgency).toBe("high");
    expect(full.classificationMaturity).toBe("ratified");
    expect(full.classificationConfidence).toBe("high");
    expect(full.action).toBe("create");

    const minimal = classifier.classify({
      streamItemId: "stream-minimal",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
    });
    expect(minimal.classificationType).toBeNull();
    expect(minimal.classificationUrgency).toBeNull();
    expect(minimal.action).toBeNull();
  });

  it("list 按 classifierSession + classificationDestination 过滤", () => {
    leaseMgr.acquire("alice@rig");
    seedStreamItem("s1");
    seedStreamItem("s2");
    seedStreamItem("s3");
    classifier.classify({
      streamItemId: "s1",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      classificationDestination: "planning@rig",
    });
    classifier.classify({
      streamItemId: "s2",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      classificationDestination: "delivery@rig",
    });
    classifier.classify({
      streamItemId: "s3",
      classifierSession: "alice@rig",
      leaseId: leaseMgr.getActiveLease()?.leaseId ?? "none",
      classificationDestination: "planning@rig",
    });
    const planning = classifier.list({ classificationDestination: "planning@rig" });
    expect(planning).toHaveLength(2);
  });
});
