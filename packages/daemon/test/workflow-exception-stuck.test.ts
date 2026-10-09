// OPR.0.4.6.WF5 FR-2 类别 (b)：检测时创建的 stuck/overdue exception item——由 sweep 创建，
// 在重复检测及两条检测路径（sweep + keepalive）之间按 occurrence 去重；spec 未缓存时也不丢失；
// 丢失 item 时重新创建（崩溃存续保证的真实镜像：任何时刻每个 occurrence 恰有一个 OPEN item）。

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { makeEnsureStuckExceptionItem } from "../src/domain/workflow-exception-escalation.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const SPEC = `workflow:
  id: wf5-stuck-pipeline
  version: 1
  objective: WF-5 class-b fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    orch:
      preferred_targets:
        - orch-lead@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - done
        - waiting
  exception_routing:
    orchestrator_role: orch
`;


function exceptionRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT * FROM queue_items WHERE tags LIKE '%exception:stuck_overdue%' ORDER BY ts_created`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe("WF-5 FR-2 类别 (b)：检测时创建 stuck exception item", () => {
  let db: Database.Database;
  let tmp: string;

  const build = async (spec = SPEC) => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    const watchdogJobsRepo = new WatchdogJobsRepository(db);
    const ensurer = makeEnsureStuckExceptionItem({
      db,
      queueRepo,
      resolveRoute: (n, v, c) => runtime.resolveExceptionRouteFor(n, v, c),
      humanFallbackSeat: "human@host",
    });
    tmp = mkdtempSync(join(tmpdir(), "wf5-stuck-"));
    const specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, spec);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "stuck walk",
      createdBySession: "ops@rig",
    });
    const packetId = inst.instance.currentFrontier[0]!;
    // 将从未 claim 的 packet 回溯到超过 single-home 阈值。
    const past = new Date(
      Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 3600) * 1000,
    ).toISOString();
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(past, packetId);
    return { queueRepo, runtime, watchdogJobsRepo, ensurer, inst, packetId };
  };

  const sweep = (f: Awaited<ReturnType<typeof build>>) =>
    runWorkflowBootSweep({
      instanceStore: f.runtime.instanceStore,
      queueRepo: f.queueRepo,
      watchdogJobsRepo: f.watchdogJobsRepo,
      ensureStuckExceptionItem: f.ensurer,
      reconcileStuckExceptions: () => f.runtime.reconcileStuckExceptions(),
    });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("sweep 为 overdue instance 创建一个 item，按 dial 使用普通 tier 和 occurrence tag 路由", async () => {
    const f = await build();
    const result = await sweep(f);
    expect(result.stuckSurfaced).toBe(1);
    expect(result.exceptionItemsCreated).toBe(1);

    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    const item = rows[0]!;
    expect(item.destination_session).toBe("orch-lead@rig");
    expect(item.tier).not.toBe("human-gate");
    const tags = String(item.tags);
    expect(tags).toContain(`occurrence:${f.packetId}`);
    expect(tags).toContain("step:produce");
    expect(String(item.evidence_ref)).toContain("rig workflow trace");
    expect(String(item.body)).toContain("仅凭 packet age 不能证明 idle");
  });

  it("重复检测会去重：第二次 sweep 更新并再次 nudge 唯一 item，绝不重复创建", async () => {
    const f = await build();
    await sweep(f);
    const second = await sweep(f);
    expect(second.stuckSurfaced).toBe(1);
    expect(second.exceptionItemsCreated).toBe(0);
    expect(exceptionRows(db)).toHaveLength(1);
  });

  it("两条检测路径共享 occurrence：sweep 后的 keepalive 评估去重到同一 item", async () => {
    const f = await build();
    await sweep(f);
    const policy = makeWorkflowKeepalivePolicy({ db, ensureStuckExceptionItem: f.ensurer });
    const evaluation = await policy.evaluate({
      jobId: "job-1",
      policy: "workflow-keepalive",
      target: { session: "producer@rig" },
      context: { workflow_instance_id: f.inst.instance.instanceId, deadline_gated: true },
    } as never);
    expect(evaluation.action).toBe("skip");
    expect(exceptionRows(db)).toHaveLength(1);
  });

  it("仅 keepalive（无先前 sweep）会在检测 tick 创建 item", async () => {
    const f = await build();
    const policy = makeWorkflowKeepalivePolicy({ db, ensureStuckExceptionItem: f.ensurer });
    await policy.evaluate({
      jobId: "job-1",
      policy: "workflow-keepalive",
      target: { session: "producer@rig" },
      context: { workflow_instance_id: f.inst.instance.instanceId, deadline_gated: true },
    } as never);
    expect(exceptionRows(db)).toHaveLength(1);
  });

  it("绝不丢失：未缓存 spec（resolveRoute 为 null）仍按 human-gate tier 路由到 human@host", async () => {
    const f = await build();
    const blindEnsurer = makeEnsureStuckExceptionItem({
      db,
      queueRepo: f.queueRepo,
      resolveRoute: () => null,
      humanFallbackSeat: "human@host",
    });
    await runWorkflowBootSweep({
      instanceStore: f.runtime.instanceStore,
      queueRepo: f.queueRepo,
      watchdogJobsRepo: f.watchdogJobsRepo,
      ensureStuckExceptionItem: blindEnsurer,
    });
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_session).toBe("human@host");
    expect(rows[0]!.tier).toBe("human-gate");
  });

  it("在出现新的底层 episode 前尊重已关闭诊断，不重新创建同一 action", async () => {
    const f = await build();
    await sweep(f);
    const first = exceptionRows(db)[0]!;
    // 模拟丢失 item 状态：instance 仍卡在同一 packet 时被带外关闭。
    db.prepare(`UPDATE queue_items SET state = 'done' WHERE qitem_id = ?`).run(first.qitem_id);
    const again = await sweep(f);
    expect(again.exceptionItemsCreated).toBe(0);
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    const open = rows.filter((r) => r.state !== "done");
    expect(open).toHaveLength(0);
  });

  it("健康 instance 不创建任何内容（零噪声负例）", async () => {
    const f = await build();
    // 将 packet 恢复为 fresh（取消回溯）。
    db.prepare(`UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?`).run(
      new Date().toISOString(),
      f.packetId,
    );
    const result = await sweep(f);
    expect(result.stuckSurfaced).toBe(0);
    expect(result.exceptionItemsCreated).toBe(0);
    expect(exceptionRows(db)).toHaveLength(0);
  });
  it("正常 waiting 只关闭自己的 overdue occurrence；后续 overdue episode 仍可见", async () => {
    const f = await build();
    await sweep(f);
    const first = String(exceptionRows(db)[0]!.qitem_id);
    await f.runtime.project({ instanceId: f.inst.instance.instanceId, currentPacketId: f.packetId,
      actorSession: "producer@rig", exit: "waiting", blockedOn: "authored-external-condition" });
    expect(f.queueRepo.getById(first)?.state).toBe("done");
    expect(f.queueRepo.getById(first)?.closureReason).toBe("no-follow-on");
    expect(db.prepare("SELECT count(*) n FROM queue_transitions WHERE qitem_id = ?").get(first)).toMatchObject({ n: 2 });
    expect(f.runtime.reconcileStuckExceptions()).toBe(0);
    await f.queueRepo.update({ qitemId: f.packetId, actorSession: "producer@rig", state: "pending", transitionNote: "condition cleared" });
    await sweep(f);
    await sweep(f);
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.state === "pending")).toHaveLength(1);
    await f.runtime.project({ instanceId: f.inst.instance.instanceId, currentPacketId: f.packetId,
      actorSession: "producer@rig", exit: "done" });
    expect(exceptionRows(db).every((r) => r.state === "done")).toBe(true);
  });

  it("keepalive 在静默提前返回前协调健康 wait", async () => {
    const f = await build();
    await sweep(f);
    // 模拟 project 在 reconciliation 前提交（崩溃窗口）。
    await f.queueRepo.update({ qitemId: f.packetId, actorSession: "producer@rig", state: "blocked",
      closureReason: "blocked_on", blockedOn: "authored-condition", transitionNote: "waiting" });
    const policy = makeWorkflowKeepalivePolicy({ db, ensureStuckExceptionItem: f.ensurer,
      reconcileStuckExceptions: (id) => f.runtime.reconcileStuckExceptions(id) });
    const result = await policy.evaluate({ context: { workflow_instance_id: f.inst.instance.instanceId,
      deadline_gated: true } } as never);
    expect(result.action).toBe("skip");
    expect(exceptionRows(db)[0]!.state).toBe("done");
  });

  it("即使没有进行中的 workflow，启动也会协调已完成 instance", async () => {
    const f = await build();
    await sweep(f);
    // terminal 投影之后、reconciler 崩溃之前的持久状态。
    db.prepare("UPDATE workflow_instances SET status = 'completed', current_frontier_json = '[]'").run();
    expect((await sweep(f)).instancesSwept).toBe(0);
    expect(exceptionRows(db)[0]!.state).toBe("done");
  });

  it("一个健康 packet 无法清除 overdue 同级项或外部 occurrence", async () => {
    const f = await build();
    const second = await f.queueRepo.create({ sourceSession: "ops@rig", destinationSession: "producer@rig",
      body: "parallel fixture", tags: ["workflow:wf5-stuck-pipeline", `instance:${f.inst.instance.instanceId}`] });
    db.prepare("UPDATE workflow_instances SET current_frontier_json = ? WHERE instance_id = ?")
      .run(JSON.stringify([f.packetId, second.qitemId]), f.inst.instance.instanceId);
    await sweep(f);
    const overdue = String(exceptionRows(db)[0]!.qitem_id);
    const foreign = await f.queueRepo.create({ sourceSession: "ops@rig", destinationSession: "orch-lead@rig",
      body: "unknown provenance", tags: ["workflow-exception", "exception:stuck_overdue", "workflow:wf5-stuck-pipeline",
        "instance:unknown-instance", `occurrence:${f.packetId}`] });
    expect(f.runtime.reconcileStuckExceptions()).toBe(0);
    expect(f.queueRepo.getById(overdue)?.state).toBe("pending");
    await f.queueRepo.update({ qitemId: f.packetId, actorSession: "producer@rig", state: "blocked",
      closureReason: "blocked_on", blockedOn: "authored-condition", transitionNote: "waiting" });
    expect(f.runtime.reconcileStuckExceptions()).toBe(1);
    expect(f.queueRepo.getById(foreign.qitemId)?.state).toBe("pending");
  });

  it("keepalive 报告 admission 失败，但仍 nudge overdue owner", async () => {
    const f = await build();
    const policy = makeWorkflowKeepalivePolicy({ db, ensureStuckExceptionItem: async () => {
      throw new Error("无法选择已注册 human");
    } });
    const result = await policy.evaluate({ context: { workflow_instance_id: f.inst.instance.instanceId,
      deadline_gated: true } } as never);
    expect(result.action).toBe("send");
    if (result.action !== "send") throw new Error("缺少 owner nudge");
    expect(result.target.session).toBe("producer@rig");
    expect(result.notes?.exceptionItemError).toContain("无法选择已注册 human");
    expect(result.message).toContain("未获准进入");
    expect(exceptionRows(db)).toHaveLength(0);
  });

  it("dependency-graph 完成只关闭已完成并行 packet 的 alert", async () => {
    const parallel = SPEC.replace("  exception_routing:", `    - id: left
      actor_role: producer
      depends_on: [produce]
      allowed_exits: [done]
    - id: right
      actor_role: producer
      depends_on: [produce]
      allowed_exits: [done]
  exception_routing:`);
    const f = await build(parallel);
    const instanceId = f.inst.instance.instanceId;
    await f.runtime.project({ instanceId, currentPacketId: f.packetId, actorSession: "producer@rig", exit: "done" });
    const packets = f.runtime.instanceStore.getByIdOrThrow(instanceId).currentFrontier;
    expect(packets).toHaveLength(2);
    for (const id of packets) db.prepare("UPDATE queue_items SET ts_created = '2020-01-01T00:00:00Z' WHERE qitem_id = ?").run(id);
    await sweep(f);
    expect(exceptionRows(db)).toHaveLength(2);
    await f.runtime.project({ instanceId, currentPacketId: packets[0]!, actorSession: "producer@rig", exit: "done" });
    const remaining = exceptionRows(db).filter((row) => row.state === "pending");
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(String(remaining[0]!.tags))).toContain(`occurrence:${packets[1]}`);
    await sweep(f);
    expect(exceptionRows(db)).toHaveLength(2);
    await f.runtime.project({ instanceId, currentPacketId: packets[1]!, actorSession: "producer@rig", exit: "done" });
    expect(exceptionRows(db).every((row) => row.state === "done")).toBe(true);
  });

});
