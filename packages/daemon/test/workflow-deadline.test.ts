// OPR.0.4.6.WF1 FR-2（G1）+ FR-6（G4）：deadline evaluator + max_hops guard。
//
// FR-2：纯 evaluator 的四种子状态 anchor 分类（claimed-with-deadline /
// claimed-null-deadline / never-claimed / unclaimed-after-claim）。stuck 是派生值，绝不
// 存储；正常 re-projection 会自动清除。包含架构要求的具名测试，通过真实 queue row 覆盖
// claimed → unclaimed → overdue 路径（third-state note，ACK Rev-1）。
//
// FR-6：在 projection 时比较 loop_guards.max_hops，使 migration 034 的注释成为事实。超过
// 上限会把 handoff 转成真实结构化失败：packet closed、instance failed，trail + event 中携带
// guard evidence；预算内 spec 完全看不到 guard。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import {
  evaluateStepDeadline,
  exceedsMaxHops,
  MAX_HOPS_BASELINE_V1,
  WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS,
} from "../src/domain/workflow-deadline.js";
import type { WorkflowInstance } from "../src/domain/workflow-types.js";

// ── 纯 evaluator fixture ────────────────────────────────────────────

const T0 = new Date("2026-07-06T00:00:00.000Z");
const THRESHOLD_MS = WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS * 1000;

function fakeInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    instanceId: "inst-1",
    workflowName: "wf",
    workflowVersion: "1",
    createdBySession: "ops@rig",
    createdAt: T0.toISOString(),
    status: "active",
    currentFrontier: ["q-1"],
    currentStepId: "step-a",
    hopCount: 0,
    fallbackSynthesis: null,
    lastContinuationDecision: null,
    completedAt: null,
    ...overrides,
  };
}

function fakePacket(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    qitemId: "q-1",
    tsCreated: T0.toISOString(),
    tsUpdated: T0.toISOString(),
    sourceSession: "ops@rig",
    destinationSession: "owner@rig",
    state: "pending",
    priority: "routine",
    tier: "mode2",
    tags: [],
    blockedOn: null,
    handedOffTo: null,
    handedOffFrom: null,
    expiresAt: null,
    closureReason: null,
    closureTarget: null,
    closureRequiredAt: null,
    claimedAt: null,
    lastNudgeAttempt: null,
    lastNudgeResult: null,
    lastHeartbeat: null,
    resolution: null,
    chainOfRecord: [],
    body: "",
    summary: null,
    evidenceRef: null,
    targetRepo: null,
    ...overrides,
  } as QueueItem;
}

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

describe("evaluateStepDeadline（FR-2——四种子状态 anchor 分类）", () => {
  it("子状态 1（claimed 且有 closure_required_at）：deadline 后为 overdue-claimed，之前为 healthy", () => {
    const deadline = at(T0, 15 * 60 * 1000).toISOString();
    const packet = fakePacket({
      state: "in-progress",
      claimedAt: T0.toISOString(),
      closureRequiredAt: deadline,
    });
    const inst = fakeInstance();

    const before = evaluateStepDeadline(inst, [packet], at(T0, 14 * 60 * 1000));
    expect(before.state).toBe("healthy");

    const after = evaluateStepDeadline(inst, [packet], at(T0, 16 * 60 * 1000));
    expect(after.state).toBe("overdue-claimed");
    expect(after.evidence?.anchor).toBe("closure_required_at");
    expect(after.evidence?.ownerSession).toBe("owner@rig");
    expect(after.evidence?.stepId).toBe("step-a");
    expect(after.evidence?.overdueBySeconds).toBe(60);
  });

  it("子状态 2（claimed 且 closure_required_at 为 NULL，即 mode2 现实）：锚定 claimed_at + threshold", () => {
    const claimedAt = at(T0, 60_000).toISOString();
    const packet = fakePacket({
      state: "in-progress",
      claimedAt,
      closureRequiredAt: null,
    });
    const inst = fakeInstance();

    const justBefore = evaluateStepDeadline(
      inst,
      [packet],
      at(T0, 60_000 + THRESHOLD_MS - 1000),
    );
    expect(justBefore.state).toBe("healthy");

    const after = evaluateStepDeadline(
      inst,
      [packet],
      at(T0, 60_000 + THRESHOLD_MS + 1000),
    );
    expect(after.state).toBe("overdue-claimed");
    expect(after.evidence?.anchor).toBe("claimed_at");
    expect(after.evidence?.claimedAt).toBe(claimedAt);
  });

  it("子状态 3（never-claimed，即 claim 前 dead-seat / lost-nudge）：锚定 created_at + threshold", () => {
    const packet = fakePacket({ state: "pending" });
    const inst = fakeInstance();

    expect(
      evaluateStepDeadline(inst, [packet], at(T0, THRESHOLD_MS - 1000)).state,
    ).toBe("healthy");

    const verdict = evaluateStepDeadline(inst, [packet], at(T0, THRESHOLD_MS + 5000));
    expect(verdict.state).toBe("overdue-unclaimed");
    expect(verdict.evidence?.anchor).toBe("created_at");
    expect(verdict.evidence?.claimedAt).toBeNull();
    expect(verdict.evidence?.ageSeconds).toBeGreaterThanOrEqual(
      WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS,
    );
  });

  it("blocked（waiting-park）frontier packet 为 HEALTHY；park-duration policy 属于 WF-5", () => {
    const packet = fakePacket({ state: "blocked", blockedOn: "external-gate" });
    const inst = fakeInstance({ status: "waiting" });
    const verdict = evaluateStepDeadline(inst, [packet], at(T0, 10 * THRESHOLD_MS));
    expect(verdict.state).toBe("healthy");
  });

  it("terminal instance 始终 healthy；空 frontier 为 healthy；忽略不在 frontier 上的 packet", () => {
    const oldPacket = fakePacket({ state: "pending" });
    expect(
      evaluateStepDeadline(
        fakeInstance({ status: "completed" }),
        [oldPacket],
        at(T0, 10 * THRESHOLD_MS),
      ).state,
    ).toBe("healthy");
    expect(
      evaluateStepDeadline(fakeInstance({ currentFrontier: [] }), [], at(T0, 10 * THRESHOLD_MS))
        .state,
    ).toBe("healthy");
    expect(
      evaluateStepDeadline(
        fakeInstance({ currentFrontier: ["some-other-packet"] }),
        [oldPacket],
        at(T0, 10 * THRESHOLD_MS),
      ).state,
    ).toBe("healthy");
  });
});

// ── 真实 row integration：架构具名的 third-state 测试 ──────────────

const SPEC = `workflow:
  id: fr2-deadline
  version: 1
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - worker@rig
    next:
      preferred_targets:
        - next@rig
  steps:
    - id: work
      actor_role: worker
      allowed_exits:
        - handoff
        - waiting
        - done
        - failed
    - id: follow
      actor_role: next
      allowed_exits:
        - done
`;

describe("FR-2 具名测试：claimed → unclaimed → overdue（架构第三状态，真实 queue row）", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

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
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 seam 为 fail-closed（MF2）；意图 nudge 的 terminal close 需要 SAME-DB intent
    // store，才能让 wake 持久。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-deadline-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("claimed 后又 unclaimed 的 frontier packet 按 created_at anchor 分类为 overdue-unclaimed，可在 unclaim 后立即呈现，且正常 re-projection 会自动清除", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "third-state walk",
      createdBySession: "ops@rig",
    });

    // 先 claim 再 unclaim；unclaim 把 claimed_at 和 closure_required_at 都置 NULL
    //（queue-repository :908-917），使 row 与 never-claimed 无法区分。
    queueRepo.claim({ qitemId: inst.entryQitemId, destinationSession: "worker@rig" });
    const claimed = queueRepo.getById(inst.entryQitemId)!;
    expect(claimed.state).toBe("in-progress");
    queueRepo.unclaim(inst.entryQitemId, "worker@rig", "seat died mid-claim");
    const unclaimed = queueRepo.getById(inst.entryQitemId)!;
    expect(unclaimed.state).toBe("pending");
    expect(unclaimed.claimedAt).toBeNull();
    expect(unclaimed.closureRequiredAt).toBeNull();

    const instance = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);

    // created_at anchor 包含已流逝的 claimed 时段：即使刚刚 unclaim，在 created_at + threshold
    // 时 packet 仍为 overdue。
    const past = new Date(
      new Date(unclaimed.tsCreated).getTime() + THRESHOLD_MS + 1000,
    );
    const verdict = evaluateStepDeadline(instance, [unclaimed], past);
    expect(verdict.state).toBe("overdue-unclaimed");
    expect(verdict.evidence?.anchor).toBe("created_at");
    expect(verdict.evidence?.packetId).toBe(inst.entryQitemId);

    // 自动清除：owner 恢复并正常 project；instance 的新 frontier packet 为 fresh，因此重新组合
    // 读到 healthy，无需手工清除，因为 stuck 从未存储。
    const projected = await runtime.project({
      instanceId: instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "worker@rig",
    });
    const advanced = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
    const nextPacket = queueRepo.getById(projected.nextQitemId!)!;
    const after = evaluateStepDeadline(advanced, [nextPacket], new Date(nextPacket.tsCreated));
    expect(after.state).toBe("healthy");
  });
});

// ── FR-6：max_hops 强制规则 ─────────────────────────────────────────

const CYCLIC_SPEC = `workflow:
  id: fr6-cycle
  version: 1
  entry:
    role: ping
  roles:
    ping:
      preferred_targets:
        - ping@rig
    pong:
      preferred_targets:
        - pong@rig
  steps:
    - id: ping-step
      actor_role: ping
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - pong
    - id: pong-step
      actor_role: pong
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - ping
  loop_guards:
    max_hops: 3
`;

describe("FR-6：projection 时强制 loop_guards.max_hops（G4——让 migration 034 注释成为事实）", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let events: Array<Record<string, unknown> & { type: string }>;

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
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
    ]);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 seam 为 fail-closed（MF2）；意图 nudge 的 terminal close 需要 SAME-DB intent
    // store，才能让 wake 持久。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
    events = [];
    bus.subscribe((e) => events.push(e as never));
    tmp = mkdtempSync(join(tmpdir(), "wf-maxhops-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exceedsMaxHops helper：undefined guard 永不触发；baseline 偏移窗口（WF-5 resume 的架构 N1 seam）", () => {
    expect(exceedsMaxHops(999, MAX_HOPS_BASELINE_V1, undefined)).toBe(false);
    expect(exceedsMaxHops(2, 0, 3)).toBe(false); // hop 3 of 3 — allowed
    expect(exceedsMaxHops(3, 0, 3)).toBe(true); // hop 4 — over
    // WF-5 风格 redrive 修改 baseline：hopCount 相同，窗口全新。
    expect(exceedsMaxHops(3, 3, 3)).toBe(false);
  });

  it("循环 spec 运行到 max_hops，下一次 handoff 转成真实结构化失败：packet closed、instance failed，trail + workflow.failed event 携带 guard evidence", async () => {
    const specPath = join(tmp, "cycle.yaml");
    writeFileSync(specPath, CYCLIC_SPEC);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "loop until the guard",
      createdBySession: "ops@rig",
    });

    // Hop 1..3 成功（max_hops: 3）。
    let packetId = inst.entryQitemId;
    const owners = ["ping@rig", "pong@rig", "ping@rig"];
    for (let hop = 0; hop < 3; hop++) {
      const projected = await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: packetId,
        exit: "handoff",
        actorSession: owners[hop]!,
      });
      expect(projected.closureReason).toBe("handoff");
      expect(projected.nextQitemId).not.toBeNull();
      packetId = projected.nextQitemId!;
    }
    const atBudget = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(atBudget.hopCount).toBe(3);
    expect(atBudget.status).toBe("active");

    // 尝试 Hop 4 时 guard 触发。projection 以真实失败形式成功完成；绝不抛出循环，也绝不形成
    // parked potato。
    const tripped = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: packetId,
      exit: "handoff",
      actorSession: "pong@rig",
    });
    expect(tripped.closureReason).toBe("failed");
    expect(tripped.nextQitemId).toBeNull();

    // Instance 如实失败；step 清除；hop count 不递增。
    const failed = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(failed.status).toBe("failed");
    expect(failed.currentStepId).toBeNull();
    expect(failed.hopCount).toBe(3);

    // frontier owner 的 packet 如实关闭（BR-3 failed 结构）。
    const closed = queueRepo.getById(packetId)!;
    expect(closed.state).toBe("done");
    expect(closed.closureReason).toBe("denied");
    expect(String(closed.closureTarget)).toContain("max_hops_exceeded");

    // Trail 记录 guard evidence。
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    const guardRow = trail.find((t) => t.closureReason === "failed")!;
    expect(guardRow).toBeDefined();
    const guard = guardRow.closureEvidence?.max_hops_guard as Record<string, unknown>;
    expect(guard?.code).toBe("max_hops_exceeded");
    expect(guard?.maxHops).toBe(3);
    expect(guard?.attemptedHop).toBe(4);

    // 发出 workflow.failed，并点名 guard。
    const failedEvent = events.find((e) => e.type === "workflow.failed");
    expect(failedEvent).toBeDefined();
    expect(String((failedEvent as Record<string, unknown>).reason)).toContain(
      "max_hops_exceeded",
    );
  });

  it("零 guard 可观测性：UNGUARDED LINEAR spec 在任何位置都不带 guard 字段，预算内 guarded spec 同样不带，happy path 不变", async () => {
    // FR-7 后 unguarded spec 必须无环；按设计，unguarded cycle 不再通过校验，因此无 guard
    // case 是线性的。
    const linearSpec = `workflow:
  id: fr6-linear
  version: 1
  entry:
    role: ping
  roles:
    ping:
      preferred_targets:
        - ping@rig
    pong:
      preferred_targets:
        - pong@rig
  steps:
    - id: first
      actor_role: ping
      allowed_exits:
        - handoff
    - id: second
      actor_role: pong
      allowed_exits:
        - handoff
    - id: last
      actor_role: ping
      allowed_exits:
        - done
`;
    expect(linearSpec).not.toContain("loop_guards");
    const specPath = join(tmp, "plain.yaml");
    writeFileSync(specPath, linearSpec);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "no guard declared",
      createdBySession: "ops@rig",
    });
    let packetId = inst.entryQitemId;
    const owners = ["ping@rig", "pong@rig"];
    for (let hop = 0; hop < 2; hop++) {
      const projected = await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: packetId,
        exit: "handoff",
        actorSession: owners[hop]!,
      });
      expect(projected.closureReason).toBe("handoff");
      packetId = projected.nextQitemId!;
    }
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    expect(trail.length).toBeGreaterThan(0);
    for (const row of trail) {
      expect(row.closureEvidence?.max_hops_guard).toBeUndefined();
    }
    // Guarded-under-budget：上方触发测试中循环 fixture 的 hop 1..3 已断言 closureReason handoff，
    // 在超过预算前不含 guard evidence。
  });
});

// ── 架构具名的真实降级测试（mid-build contract fold #2）───────────

import {
  WorkflowSpecCache,
  resetLegacyRehydrationWarnings,
} from "../src/domain/workflow-spec-cache.js";

describe("legacy pre-050 rehydration 可见降级，绝不静默运行成 no-guards", () => {
  it("经 getByNameVersion 解析 pre-050 cache row 时只告警一次，并点名缺失 fidelity 与修复路径", () => {
    const legacyDb = createDb();
    // 刻意不应用 migration 050，保持 legacy fixture 结构。
    migrate(legacyDb, [
      outboxEntriesSchema,
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
    ]);
    const cache = new WorkflowSpecCache(legacyDb);
    const legacyTmp = mkdtempSync(join(tmpdir(), "wf-legacy-"));
    const legacySpecPath = join(legacyTmp, "legacy.yaml");
    writeFileSync(legacySpecPath, CYCLIC_SPEC);
    try {
      resetLegacyRehydrationWarnings();
      cache.readThrough(legacySpecPath);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const row = cache.getByNameVersion("fr6-cycle", "1");
      // 真实降级：guard 缺失且 advisory 已触发。
      expect(row?.spec.loop_guards).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain("无法完整还原");
      expect(String(warnSpy.mock.calls[0]![0])).toContain("fr6-cycle@1");
      // 每个进程的每个 spec 只提示一次，第二次读取保持静默。
      cache.getByNameVersion("fr6-cycle", "1");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    } finally {
      legacyDb.close();
      rmSync(legacyTmp, { recursive: true, force: true });
    }
  });
});
