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
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";
import { workflowRoutes } from "../src/routes/workflow.js";

/**
 * OPR.0.4.6.WF3 FR-4——`route` 契约锁定。ZOMBIE REVOCATION 测试置于首位（裁定中的
 * 承重事实：若它失败，其他结果都不再重要）。
 */

const SPEC = `workflow:
  id: route-fixture
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
        - waiting
        - failed
      next_hop:
        suggested_roles:
          - reviewer
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
      - failed
`;

// OPR.0.5.1 slice-51-06 D2 有界修正——一个受 handler role gate 约束的 step（metadata 随 packet
// 携带），其 exit=waiting 会将它停放在非 HUMAN blocker（"external-gate"）上。路由该 packet 不得
// 触发 D2 的非停放 metadata 拒绝（route 会重新提供冗余 summary/evidence）。
const SPEC_GATED = `workflow:
  id: route-repark-fixture
  version: 1
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    handler:
      preferred_targets:
        - handler@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - failed
      next_hop:
        suggested_roles:
          - handler
    - id: review
      actor_role: handler
      gate:
        target: handler
        summary: needs handler sign-off
        evidence_ref: proof/review.md
      allowed_exits:
        - waiting
        - done
        - failed
  invariants:
    allowed_exits:
      - handoff
      - waiting
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

describe("workflow route（WF3 FR-4——close+recreate+rebind）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let queueRepo: QueueRepository;
  let app: Hono;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      outboxEntriesSchema,
      coreSchema, bindingsSessionsSchema, eventsSchema,
      queueItemsSchema, queueTransitionsSchema,
      queueItemSummarySchema, queueItemEvidenceRefSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      workflowInstanceVersionSchema, workflowSpecJsonSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝采用 fail-closed（MF2）——旨在 nudge 的终止 close 需要同数据库 intent store，
    // 才能使其 wake 持久可靠。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
    app = buildApp({ eventBus: bus, runtime });
    tmp = mkdtempSync(join(tmpdir(), "wf-route-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  async function instantiate() {
    const r = await runtime.instantiate({
      specPath,
      rootObjective: "route pins",
      createdBySession: "orch@rig",
    });
    return { instanceId: r.instance.instanceId, entryPacket: r.entryQitemId };
  }

  it("ZOMBIE REVOCATION 证明：旧 owner 的陈旧 project → 结构化 packet_not_on_frontier 409；新 owner 成功", async () => {
    const { instanceId, entryPacket } = await instantiate();
    const routed = await runtime.route({
      instanceId,
      toSession: "producer2@rig",
      actorSession: "orch@rig",
      reason: "owner seat dead",
    });

    // zombie（compaction 后醒来的旧 owner）尝试推进其陈旧 packet——随附 replay guard 从结构上拒绝。
    const zombie = await app.request(`/api/workflow/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId,
        currentPacketId: entryPacket,
        exit: "handoff",
        actorSession: "producer@rig",
      }),
    });
    expect(zombie.status).toBe(409);
    const zbody = await zombie.json() as { error: string };
    expect(zbody.error).toBe("packet_not_on_frontier");

    // 新 owner 成功推进同一 step。
    const advanced = await runtime.project({
      instanceId,
      currentPacketId: routed.newPacketId,
      exit: "handoff",
      actorSession: "producer2@rig",
    });
    expect(advanced.nextStepId).toBe("review");
  });

  it("可观测契约：owner 改变、step 不变、handoff 如实闭合（不伪造完成）、provenance 持久、version 增加、hop count 不增加", async () => {
    const { instanceId, entryPacket } = await instantiate();
    const before = runtime.instanceStore.getByIdOrThrow(instanceId);
    const routed = await runtime.route({
      instanceId,
      toSession: "producer2@rig",
      actorSession: "orch@rig",
      reason: "rebalance",
    });
    const after = runtime.instanceStore.getByIdOrThrow(instanceId);

    // (1) owner 是目标（直接读取 queue row——queueRepo 按设计为 runtime 私有）。
    const qrow = (id: string) =>
      db.prepare(`SELECT destination_session, state, closure_reason, closure_target, blocked_on, chain_of_record FROM queue_items WHERE qitem_id = ?`).get(id) as Record<string, string | null> | undefined;
    const newPacket = qrow(routed.newPacketId);
    expect(newPacket?.destination_session).toBe("producer2@rig");
    // (2) step identity 不变。
    expect(after.currentStepId).toBe(before.currentStepId);
    expect(after.currentStepId).toBe("produce");
    // (4) 旧 packet 以 handed_off_to 闭合——绝不是 done/no-follow-on。
    const oldPacket = qrow(entryPacket);
    expect(oldPacket?.state).toBe("handed-off");
    expect(oldPacket?.closure_reason).toBe("handed_off_to");
    expect(oldPacket?.closure_target).toBe("producer2@rig");
    // (3) provenance 可查询：transition 中包含 actor + reason + old→new。
    const transition = db
      .prepare(`SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(entryPacket) as { transition_note?: string } | undefined;
    expect(transition?.transition_note).toContain("orch@rig");
    expect(transition?.transition_note).toContain("producer@rig");
    expect(transition?.transition_note).toContain("producer2@rig");
    expect(transition?.transition_note).toContain("rebalance");
    // (5) frontier 不悬空。
    expect(after.currentFrontier).toEqual([routed.newPacketId]);
    // (7) version guard 已执行（bump）；route 并非推进（hop 不增加）。
    expect(after.version).toBe(before.version + 1);
    expect(after.hopCount).toBe(before.hopCount);
    // chainOfRecord 串起 lineage。
    expect(String(newPacket?.chain_of_record ?? "")).toContain(entryPacket);
  });

  it("(6) 发出 routing_table_changed，并携带追加的 re-route detail", async () => {
    const { instanceId, entryPacket } = await instantiate();
    const seen: Array<Record<string, unknown>> = [];
    bus.subscribe((e) => {
      if ((e as { type?: string }).type === "workflow.routing_table_changed") seen.push(e as never);
    });
    await runtime.route({ instanceId, toSession: "producer2@rig", actorSession: "orch@rig" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cause: "workflow_route",
      instanceId,
      stepId: "produce",
      from: "producer@rig",
      to: "producer2@rig",
    });
    void entryPacket;
  });

  it("拒绝矩阵：已完成 instance → instance_not_active；处理空 frontier；HTTP 映射 409/400", async () => {
    const { instanceId, entryPacket } = await instantiate();
    await runtime.project({ instanceId, currentPacketId: entryPacket, exit: "failed", actorSession: "producer@rig" });
    await expect(
      runtime.route({ instanceId, toSession: "x@rig", actorSession: "orch@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_active" });

    // HTTP surface：终止 instance 返回 409；缺失字段返回 400。
    const res409 = await app.request(`/api/workflow/${instanceId}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toSession: "x@rig", actorSession: "orch@rig" }),
    });
    expect(res409.status).toBe(409);
    const res400 = await app.request(`/api/workflow/${instanceId}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res400.status).toBe(400);
  });

  it("路由 waiting instance 时保留其停放状态（owner 改变，记录状态不变）", async () => {
    const { instanceId, entryPacket } = await instantiate();
    await runtime.project({
      instanceId,
      currentPacketId: entryPacket,
      exit: "waiting",
      actorSession: "producer@rig",
      blockedOn: "founder-gate",
    });
    const routed = await runtime.route({ instanceId, toSession: "producer2@rig", actorSession: "orch@rig" });
    const successor = db.prepare(`SELECT state, blocked_on FROM queue_items WHERE qitem_id = ?`).get(routed.newPacketId) as Record<string, string | null> | undefined;
    expect(successor?.state).toBe("blocked");
    expect(successor?.blocked_on).toBe("founder-gate");
    const inst = runtime.instanceStore.getByIdOrThrow(instanceId);
    expect(inst.status).toBe("waiting");
    expect(inst.currentStepId).toBe("produce");
  });

  it("并发：version guard 强制串行——route 后使用陈旧 version 写 frontier 会冲突", async () => {
    const { instanceId } = await instantiate();
    const stale = runtime.instanceStore.getByIdOrThrow(instanceId);
    await runtime.route({ instanceId, toSession: "producer2@rig", actorSession: "orch@rig" });
    // 持有 route 前 version 的 writer 会失败（WF-1 guard——projector 使用同一机制；在
    // better-sqlite3 的同步单 writer 模型下，真正同一时刻的 commit 不可能发生，因此陈旧读取模拟
    // 就是忠实且经架构认可的竞争）。
    expect(() =>
      runtime.instanceStore.updateFrontier(instanceId, ["qitem-fake"], "active", {
        expectedVersion: stale.version,
      }),
    ).toThrowError(/instance_version_conflict|version/);
  });

  it("路由 HUMAN-GATED 停放项时保留 summary/evidence_ref——绝不出现 human_route_fields_required（rev1-r2 BLOCKING fold）", async () => {
    // waiting-on-human 类是 route 最主要的适用场景：由 HUMAN 停放的 packet，其 ROLE OWNER seat
    // 已失效。successor 必须同时保留停放状态和 human-route 字段，否则随附的 validateHumanPark 会
    // 拒绝再次停放，使 instance 恰恰在最需要时无法路由。
    const gatedSpecPath = join(tmp, "gated.yaml");
    writeFileSync(gatedSpecPath, `workflow:
  id: route-gated-human
  version: 1
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - done
        - failed
      gate:
        target: human@kernel
        summary: "Sign off the walk"
        evidence_ref: proof/PROOF.md
  invariants:
    allowed_exits:
      - done
      - failed
`);
    const r = await runtime.instantiate({
      specPath: gatedSpecPath,
      rootObjective: "human-park route",
      createdBySession: "orch@rig",
    });
    const iid = r.instance.instanceId;
    // entry 携带必需字段停放在 human seat 上。
    const qrow = (id: string) =>
      db.prepare(`SELECT destination_session, state, blocked_on, summary, evidence_ref FROM queue_items WHERE qitem_id = ?`).get(id) as Record<string, string | null>;
    const parked = qrow(r.entryQitemId);
    expect(parked.state).toBe("blocked");
    expect(parked.blocked_on).toBe("human@kernel");
    expect(parked.summary).toBe("Sign off the walk");

    // 将停放的 step 路由到新的 role-owner seat：必须成功。
    const routed = await runtime.route({
      instanceId: iid,
      toSession: "producer2@rig",
      actorSession: "orch@rig",
      reason: "role owner seat dead",
    });
    const successor = qrow(routed.newPacketId);
    expect(successor.destination_session).toBe("producer2@rig");
    expect(successor.state).toBe("blocked");
    expect(successor.blocked_on).toBe("human@kernel");
    // 修复点：human-route 字段在重新路由后仍保留。
    expect(successor.summary).toBe("Sign off the walk");
    expect(successor.evidence_ref).toBe("proof/PROOF.md");
    // 保留 step identity 与 instance state。
    const inst = runtime.instanceStore.getByIdOrThrow(iid);
    expect(inst.currentStepId).toBe("produce");
    expect(inst.currentFrontier).toEqual([routed.newPacketId]);
    // OPR.0.4.6.WF5（rev1-r2 B1）：class-(c) exception identity 会传递给路由后的 successor——
    // live frontier item 保持可查询，occurrence 保留原始 gate packet id（route 改变 owner，
    // 绝不改变 episode）。
    const successorTags = String(
      (db.prepare(`SELECT tags FROM queue_items WHERE qitem_id = ?`).get(routed.newPacketId) as { tags: string }).tags,
    );
    expect(successorTags).toContain("workflow-exception");
    expect(successorTags).toContain("exception:human_gate_trip");
    expect(successorTags).toContain("step:produce");
    expect(successorTags).toContain(`occurrence:${r.entryQitemId}`);
    expect(successorTags).toContain("re-route");
  });

  it("违反 PIN 的目标以 409 harness_pin_unsatisfied 拒绝；匹配 harness 的目标可正常路由（guard 预检 finding 3）", async () => {
    // 预置受管 node，使 nodeRuntimeOf 能解析 runtime（WF-2 seedSeat 模式）。
    const seedSeat = (sessionName: string, runtimeName: string, nodeId: string): void => {
      db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'r-1', ?, ?)`)
        .run(nodeId, sessionName.split("@")[0], runtimeName);
      db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')`)
        .run(`s-${nodeId}`, nodeId, sessionName);
    };
    seedSeat("codex-seat@rig", "codex", "n-codex");
    seedSeat("codex-seat2@rig", "codex", "n-codex2");
    seedSeat("claude-seat@rig", "claude-code", "n-claude");
    const pinnedSpecPath = join(tmp, "pinned.yaml");
    writeFileSync(pinnedSpecPath, `workflow:
  id: route-pinned
  version: 1
  entry:
    role: builder
  roles:
    builder:
      preferred_targets:
        - codex-seat@rig
  steps:
    - id: build
      actor_role: builder
      allowed_exits:
        - done
        - failed
      harness: codex
  invariants:
    allowed_exits:
      - done
      - failed
`);
    const r = await runtime.instantiate({
      specPath: pinnedSpecPath,
      rootObjective: "pin pins",
      createdBySession: "orch@rig",
    });
    const iid = r.instance.instanceId;

    // HTTP surface 上 harness 错误：返回结构化 409，不改变任何内容。
    const res = await app.request(`/api/workflow/${iid}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toSession: "claude-seat@rig", actorSession: "orch@rig" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("harness_pin_unsatisfied");
    const untouched = runtime.instanceStore.getByIdOrThrow(iid);
    expect(untouched.currentFrontier).toEqual([r.entryQitemId]);

    // 匹配的 harness 可正常路由。
    const routed = await runtime.route({ instanceId: iid, toSession: "codex-seat2@rig", actorSession: "orch@rig" });
    expect(routed.toSession).toBe("codex-seat2@rig");
  });

  it("路由未知 instance 时抛出 instance_not_found（路由层返回 404）", async () => {
    await expect(
      runtime.route({ instanceId: "nope", toSession: "x@rig", actorSession: "orch@rig" }),
    ).rejects.toSatisfy((e: unknown) => {
      // instanceStore.getByIdOrThrow 抛出自己的 store error class；HTTP mapper 将其转为 404——
      // 在 HTTP 层锁定：
      return e instanceof Error;
    });
    const res = await app.request(`/api/workflow/nope/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toSession: "x@rig", actorSession: "orch@rig" }),
    });
    expect(res.status).toBe(404);
    void WorkflowProjectorError;
  });

  // OPR.0.5.1 slice-51-06 D2 有界修正（terminal NOT-CLEAR 回归）。修复前 RED：路由一个投影为
  // WAITING 在非 human blocker 上、由 handler gate 约束的 metadata packet 会触发 D2（再次停放时
  // 重复提供 summary/evidence）-> route txn 回滚，POST /:id/route 呈现 HTTP 500
  // summary_evidence_not_persistable。修复后 GREEN：route 提交，successor 在准确的非 human blocker
  // 上保留 metadata（由 create 侧传递），且 frontier 重新绑定、无 orphan。
  it("D2×route：WAITING 在非 human blocker 上的 handler-gated metadata packet 可干净路由（无 500、保留 metadata、frontier 重新绑定）", async () => {
    const gatedPath = join(tmp, "gated.yaml");
    writeFileSync(gatedPath, SPEC_GATED);
    const inst = await runtime.instantiate({ specPath: gatedPath, rootObjective: "repark", createdBySession: "orch@rig" });
    const instanceId = inst.instance.instanceId;
    const frontier = (): string[] => runtime.instanceStore.getByIdOrThrow(instanceId).currentFrontier;

    // produce -> review（handler-gated：summary/evidence 随 review packet 携带，目标为 handler@rig）。
    await runtime.project({ instanceId, currentPacketId: inst.entryQitemId, exit: "handoff", actorSession: "producer@rig" });
    const reviewPacket = frontier()[0]!;
    // review 投影为 WAITING -> 阻塞于非 HUMAN "external-gate"，metadata 得以保留。
    await runtime.project({ instanceId, currentPacketId: reviewPacket, exit: "waiting", actorSession: "handler@rig" });
    const waited = queueRepo.getByIdOrThrow(reviewPacket);
    expect(waited.state).toBe("blocked");
    expect(waited.blockedOn).toBe("external-gate");
    expect(waited.summary).toBe("needs handler sign-off");
    expect(waited.evidenceRef).toBe("proof/review.md");
    const before = runtime.instanceStore.getByIdOrThrow(instanceId);
    expect(before.currentStepId).toBe("review");
    expect(before.status).toBe("waiting");

    // 真实 POST /api/workflow/:instance_id/route（修复前：500 summary_evidence_not_persistable）。
    const res = await app.request(`/api/workflow/${instanceId}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toSession: "handler2@rig", actorSession: "orch@rig", reason: "rebalance" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { newPacketId: string };

    // successor 是唯一 frontier；workflow 继续在同一 step 上等待（route ≠ advance）。
    const after = runtime.instanceStore.getByIdOrThrow(instanceId);
    expect(after.currentFrontier).toEqual([body.newPacketId]);
    expect(after.currentStepId).toBe("review");
    expect(after.currentStepId).toBe(before.currentStepId);
    expect(after.status).toBe("waiting");
    // successor：owner=handler2@rig，仍阻塞于同一非 human blocker，metadata 保留。
    const successor = queueRepo.getByIdOrThrow(body.newPacketId);
    expect(successor.destinationSession).toBe("handler2@rig");
    expect(successor.state).toBe("blocked");
    expect(successor.blockedOn).toBe("external-gate");
    expect(successor.summary).toBe("needs handler sign-off");
    expect(successor.evidenceRef).toBe("proof/review.md");
    // 旧 blocked packet 如实闭合：以准确 closure target 执行 handed-off（无 orphan）。
    const old = queueRepo.getByIdOrThrow(reviewPacket);
    expect(old.state).toBe("handed-off");
    expect(old.closureReason).toBe("handed_off_to");
    expect(old.closureTarget).toBe("handler2@rig");
    expect(old.handedOffTo).toBe("handler2@rig");
    expect(after.currentFrontier).not.toContain(reviewPacket);
  });
});
