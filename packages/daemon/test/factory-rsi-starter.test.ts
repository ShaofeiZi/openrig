// OPR.0.4.6.FAC2 C1——单工作组 RSI 工厂 MVP 工作流规范。
//
// 证明随附引擎上形成一致内循环所需的两点：
//  1. 能干净通过校验——可执行的 max_hops 防护（WF-1）批准有界修复循环，
//     WF-2 分支映射可以解析，每个角色与席位均固定为 1:1；
//  2. 内循环具有确定性且由引擎路由——`review` 移交给 `release_prep`，qa/review
//     的 `failed` 路由到 `implement`（有界修复），全程无需编排器转发。Dogfood 与
//     此门禁循环解耦（带外运行并输入下一份计划；连续运行时机制在后续版本交付），
//     因而它是已声明角色，而非步骤。
//
// 仅限 VM 的原则：在此编写，在一致的 VM 租约中执行。

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
// 人工发布门禁将数据包停放到 human@kernel，因此需要队列项的 summary 与 evidence_ref
// 列（迁移 044 + 048）；没有它们时，停放操作会静默跳过这些字段并如实失败。
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const BUILTIN_WORKFLOW_DIR = resolve(import.meta.dirname, "../src/builtins/workflow-specs");
const RSI_SPEC = join(BUILTIN_WORKFLOW_DIR, "factory-rsi.yaml");

describe("OPR.0.4.6.FAC2 factory-rsi 工厂工作流", () => {
  let db: Database.Database;
  let eventBus: EventBus;
  let runtime: WorkflowRuntime;
  let queueRepo: QueueRepository;

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
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
    ]);
    eventBus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-factory-rsi', 'factory-rsi')`).run();
    queueRepo = new QueueRepository(db, eventBus, { validateRig: () => true });
    // P34：W1 接缝采用失败关闭（MF2）——意图唤醒的终止关闭需要同一数据库中的
    // 意图存储，才能让唤醒持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus, queueRepo });
  });

  afterEach(() => db.close());

  it("干净通过校验：max_hops 批准循环，分支可解析，角色与席位为 1:1", () => {
    const raw = readFileSync(RSI_SPEC, "utf-8");
    const spec = parseWorkflowSpec(raw, RSI_SPEC);

    expect(spec.target?.rig).toBe("factory-rsi");
    expect(spec.entry?.role).toBe("planner");
    expect(spec.coordination_terminal_turn_rule).toBe("hot_potato");
    expect(spec.steps.map((s) => s.id)).toEqual([
      "plan",
      "implement",
      "qa_check",
      "review",
      "release_prep",
      "release_signoff",
    ]);
    // 内循环将 review 转发到 release_prep；修复分支声明在封闭的退出枚举上。
    const stepById = Object.fromEntries(spec.steps.map((s) => [s.id, s]));
    expect(stepById["review"]!.next_hop?.suggested_roles).toEqual(["release_manager"]);
    expect(stepById["qa_check"]!.next_hop?.on).toEqual({ failed: "implement" });
    expect(stepById["review"]!.next_hop?.on).toEqual({ failed: "implement" });
    // Dogfood 已解耦：这是一个已声明角色（以 dogfood 席位为目标），通过带外方式
    // 输入下一份计划——有意不作为内循环步骤。
    expect(spec.roles?.dogfood?.preferred_targets).toEqual(["dogfood-tester@factory-rsi"]);
    expect(spec.steps.some((s) => s.actor_role === "dogfood")).toBe(false);
    // 循环仅在可执行防护下存在。
    expect(spec.loop_guards?.max_hops).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(spec.loop_guards?.max_hops)).toBe(true);
    // 异常控制接入已声明的 orchestrator 角色。
    expect(spec.exception_routing?.default).toBe("orchestrator");
    expect(spec.exception_routing?.orchestrator_role).toBe("orchestrator");
    // 先准备后签核（rev1 修复）：release_prep 不设门禁（release-manager 的准备工作先运行），
    // 随后移交给独立且有门禁的 release_signoff 步骤，由人工席位掌握发布决策。
    expect(stepById["release_prep"]!.gate).toBeUndefined();
    expect(stepById["release_prep"]!.next_hop?.on).toEqual({ handoff: "release_signoff" });
    expect(stepById["release_signoff"]!.gate?.target).toBe("human@kernel");

    const validation = new WorkflowValidator().validate(spec);
    expect(validation.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.summary.entryRole).toBe("planner");
  });

  it("正向遍历将每个角色解析到其 1:1 factory-rsi 席位", async () => {
    const created = await runtime.instantiate({
      specPath: RSI_SPEC,
      rootObjective: "RSI cycle 1",
      createdBySession: "plan-planner@factory-rsi",
    });
    expect(created.instance.currentStepId).toBe("plan");

    let packetId = created.entryQitemId;
    const forward: Array<[string, string, string]> = [
      // [操作者, 预期下一步, 预期下一所有者]
      ["plan-planner@factory-rsi", "implement", "build-implementer@factory-rsi"],
      ["build-implementer@factory-rsi", "qa_check", "check-qa@factory-rsi"],
      ["check-qa@factory-rsi", "review", "review-reviewer@factory-rsi"],
      ["review-reviewer@factory-rsi", "release_prep", "release-manager@factory-rsi"],
    ];
    for (const [actor, nextStep, nextOwner] of forward) {
      const projected = await runtime.project({
        instanceId: created.instance.instanceId,
        currentPacketId: packetId,
        exit: "handoff",
        actorSession: actor,
      });
      expect(projected.nextStepId).toBe(nextStep);
      expect(projected.nextOwnerSession).toBe(nextOwner);
      packetId = projected.nextQitemId!;
    }
  });

  it("发布阶段（rev1 回归）：review → release_prep 无门禁运行 → release_signoff 持有人工门禁（先准备后签核）", async () => {
    // review 后内循环进入 release_prep——这是 release-manager 的可执行步骤，不是人工停放：
    // release-manager 在任何门禁前在此准备产物。旧结构（release_prep 上设门禁）会让实例
    // 此时已经等待/阻塞于人工；这种先签核后准备的倒置顺序正是 rev1-r1/r2 阻断项。
    const walk = await walkToReleasePrep(runtime);
    expect(walk.stepId).toBe("release_prep");
    expect(walk.ownerSession).toBe("release-manager@factory-rsi");
    expect(runtime.instanceStore.getById(walk.instanceId)?.status).toBe("active");
    expect(queueRepo.getById(walk.packetId)?.state).not.toBe("blocked");

    // release-manager 完成准备并移交给签核门禁。
    const toSignoff = await runtime.project({
      instanceId: walk.instanceId,
      currentPacketId: walk.packetId,
      exit: "handoff",
      actorSession: "release-manager@factory-rsi",
      resultNote: "release artifacts prepared",
    });
    expect(toSignoff.nextStepId).toBe("release_signoff");
    // 此时且仅在准备完成后，人工门禁才把数据包停放到人工席位，并携带 summary 和
    // evidence_ref（迁移 044 + 048）。
    const signoffItem = queueRepo.getById(toSignoff.nextQitemId!);
    expect(signoffItem?.state).toBe("blocked");
    expect(signoffItem?.blockedOn).toBe("human@kernel");
    expect(signoffItem?.summary).toBeTruthy();
    expect(signoffItem?.evidenceRef).toBe("proof/PROOF.md");
    expect(runtime.instanceStore.getById(walk.instanceId)?.status).toBe("waiting");
  });

  it("qa_check 的 `failed`（产物判定）路由到 implement 进行有界修复", async () => {
    const created = await runtime.instantiate({
      specPath: RSI_SPEC,
      rootObjective: "RSI remediation",
      createdBySession: "plan-planner@factory-rsi",
    });
    // plan → implement → qa_check。
    let packetId = created.entryQitemId;
    for (const actor of ["plan-planner@factory-rsi", "build-implementer@factory-rsi"]) {
      const p = await runtime.project({
        instanceId: created.instance.instanceId,
        currentPacketId: packetId,
        exit: "handoff",
        actorSession: actor,
      });
      packetId = p.nextQitemId!;
    }
    const projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "failed",
      actorSession: "check-qa@factory-rsi",
      resultNote: "check failed the artifact",
    });
    expect(projected.nextStepId).toBe("implement");
    expect(projected.nextOwnerSession).toBe("build-implementer@factory-rsi");
  });
});

/** 遍历全新实例的 plan→implement→qa_check→review（全部移交）；最后一跳到达
 *  release_prep（内循环的发布步骤）。 */
async function walkToReleasePrep(
  runtime: WorkflowRuntime,
): Promise<{ instanceId: string; packetId: string; stepId: string; ownerSession: string }> {
  const created = await runtime.instantiate({
    specPath: RSI_SPEC,
    rootObjective: "walk to release_prep",
    createdBySession: "plan-planner@factory-rsi",
  });
  let packetId = created.entryQitemId;
  let stepId = "plan";
  let ownerSession = "plan-planner@factory-rsi";
  for (const actor of [
    "plan-planner@factory-rsi",
    "build-implementer@factory-rsi",
    "check-qa@factory-rsi",
    "review-reviewer@factory-rsi",
  ]) {
    const p = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: actor,
    });
    packetId = p.nextQitemId!;
    stepId = p.nextStepId!;
    ownerSession = p.nextOwnerSession!;
  }
  return { instanceId: created.instance.instanceId, packetId, stepId, ownerSession };
}
