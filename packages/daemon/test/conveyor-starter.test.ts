import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";
import { loadStarterWorkflowSpecs } from "../src/domain/workflow/starter-spec-loader.js";
import { getWorkflowReview } from "../src/domain/spec-library-workflow-scanner.js";

const BUILTIN_WORKFLOW_DIR = resolve(import.meta.dirname, "../src/builtins/workflow-specs");
const CONVEYOR_SPEC = join(BUILTIN_WORKFLOW_DIR, "conveyor.yaml");
const BASIC_LOOP_SPEC = join(BUILTIN_WORKFLOW_DIR, "basic-loop.yaml");

describe("0.3.0 conveyor starter workflow spec", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let runtime: WorkflowRuntime;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      outboxEntriesSchema,
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
    ]);
    eventBus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-conveyor', 'conveyor')`).run();
    const queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    // P34：W1 接缝关闭失败（MF2）——意图 nudge 的 terminal close 需要同 DB intent store，
    // 才能让 wake 持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus, queueRepo });
  });

  afterEach(() => db.close());

  it("准确发布通用公共 starter workflow spec", () => {
    const result = loadStarterWorkflowSpecs({
      cache: runtime.specCache,
      builtinDir: BUILTIN_WORKFLOW_DIR,
    });

    expect(result.errors).toEqual([]);
    // 此列表需与 packages/daemon/src/builtins/workflow-specs/*.yaml 保持同步。
    // OPR.0.4.6.WF2：增加三种 spec-language 示例结构（linear / gated / branched，即 FR-6
    // 手工创作集合）。OPR.0.4.6.FAC2：增加 factory-rsi（canonical 单 rig RSI factory workflow，
    // 也是 demo/dogfood 载体）。漂移裁定：这是陈旧断言（测试排序），不是产品变更；六个 spec 均已
    // 正确发布并加载。0.4.6 FAC2（commit 8250d702）加入 factory-rsi.yaml 和此预期条目时，字面量把
    // "factory-rsi" 追加到末尾，但断言将其与 `.sort()` 后的实际值比较；排序后 factory-rsi 位于
    // "conveyor" 与 "gated-release" 之间。现已恢复排序顺序，与已发布并正确加载的集合一致。
    expect(result.loaded.map((s) => s.name).sort()).toEqual([
      "basic-loop",
      "branched-remediation",
      "conveyor",
      "factory-rsi",
      "gated-release",
      "linear-build",
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("conveyor 和 basic-loop 作为面向通用 conveyor 的 spec 通过验证", () => {
    const validator = new WorkflowValidator();

    for (const specPath of [CONVEYOR_SPEC, BASIC_LOOP_SPEC]) {
      const raw = readFileSync(specPath, "utf-8");
      expect(raw).not.toMatch(/\brsi\b/i);
      expect(raw).not.toContain("openrig-velocity");

      const spec = parseWorkflowSpec(raw, specPath);
      expect(spec.target?.rig).toBe("conveyor");
      expect(spec.coordination_terminal_turn_rule).toBe("hot_potato");
      expect(spec.steps.map((step) => step.id)).toEqual(["intake", "plan", "build", "review", "close"]);

      const validation = validator.validate(spec);
      expect(validation.ok).toBe(true);
      expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
      expect(validation.summary.entryRole).toBe("intake");
    }
  });

  it("conveyor 可在同一 rig 上运行多个活动 instance", async () => {
    const first = await runtime.instantiate({
      specPath: CONVEYOR_SPEC,
      rootObjective: "packet A",
      createdBySession: "intake-lead@conveyor",
    });
    const second = await runtime.instantiate({
      specPath: CONVEYOR_SPEC,
      rootObjective: "packet B",
      createdBySession: "intake-lead@conveyor",
    });

    expect(first.instance.instanceId).not.toBe(second.instance.instanceId);
    expect(first.instance.currentStepId).toBe("intake");
    expect(second.instance.currentStepId).toBe("intake");

    const projected = await runtime.project({
      instanceId: first.instance.instanceId,
      currentPacketId: first.entryQitemId,
      exit: "handoff",
      actorSession: "intake-lead@conveyor",
      resultNote: "packet A clarified",
    });

    expect(projected.nextStepId).toBe("plan");
    expect(projected.nextOwnerSession).toBe("plan-planner@conveyor");

    const stillActive = runtime.instanceStore.getById(second.instance.instanceId);
    expect(stillActive?.status).toBe("active");
    expect(stillActive?.currentFrontier).toEqual([second.entryQitemId]);
    expect(stillActive?.currentStepId).toBe("intake");
  });

  it("basic-loop 可将一个 packet 端到端推进至 close", async () => {
    const created = await runtime.instantiate({
      specPath: BASIC_LOOP_SPEC,
      rootObjective: "walk one packet",
      createdBySession: "intake-lead@conveyor",
    });

    let packetId = created.entryQitemId;
    let projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "intake-lead@conveyor",
    });
    expect(projected.nextStepId).toBe("plan");
    packetId = projected.nextQitemId!;

    projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "plan-planner@conveyor",
    });
    expect(projected.nextStepId).toBe("build");
    packetId = projected.nextQitemId!;

    projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "build-builder@conveyor",
    });
    expect(projected.nextStepId).toBe("review");
    packetId = projected.nextQitemId!;

    projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "review-reviewer@conveyor",
    });
    expect(projected.nextStepId).toBe("close");
    expect(projected.nextOwnerSession).toBe("intake-lead@conveyor");
    packetId = projected.nextQitemId!;

    await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "done",
      actorSession: "intake-lead@conveyor",
      resultNote: "walkthrough complete",
    });

    const done = runtime.instanceStore.getById(created.instance.instanceId);
    expect(done?.status).toBe("completed");
    expect(done?.currentFrontier).toEqual([]);
    expect(done?.currentStepId).toBeNull();
  });

  it("workflow review graph 显示 pass-to-close 和 review-to-build 反馈路径", () => {
    runtime.specCache.readThrough(CONVEYOR_SPEC);
    const review = getWorkflowReview({
      db,
      workflowBuiltinSpecsDir: BUILTIN_WORKFLOW_DIR,
      name: "conveyor",
      version: "1",
    });

    expect(review?.isBuiltIn).toBe(true);
    expect(review?.topology.nodes.map((node) => node.stepId)).toEqual([
      "intake",
      "plan",
      "build",
      "review",
      "close",
    ]);
    expect(review?.topology.edges).toEqual(
      expect.arrayContaining([
        { fromStepId: "review", toStepId: "close", routingType: "direct" },
        { fromStepId: "review", toStepId: "build", routingType: "direct" },
      ]),
    );
  });
});
