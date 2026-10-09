// OPR.0.4.6.WF1 FR-1：KEEP-fence 回归固定点 + facade 测试。
//
// 这些是已发布 transactional-scribe 契约（WF-1 PRD §4 FR-1）的特征固定点。若任何保留保证
// 静默回归，它们必须失败：
//   (a) 原子性——事务中途注入失败只留下零个部分状态（绝不出现已关闭 packet 却没有下一 qitem）；
//   (b) 确定性——相同 (spec, instance) 输入在每次重放中产生相同 routing decision
//       （step、owner、closure shape）；
//   (c) 终态 exit 重放——重新投影 handed-off/done/failed packet 时以结构化 frontier 错误拒绝；
//   (d) 对 WorkflowRuntime facade 本身执行端到端测试（validate / instantiate / project /
//       continue）——本 slice 之前未测试。
//
// 真实进程终止分支（投影中途 SIGKILL + restart）是 VM proof `fr1-midtxn-process-kill`
//（ACK Rev-2）；此处 throw-injection 测试是单元级固定点，不能替代它。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const SPEC = `workflow:
  id: fr1-three-step
  version: 1
  objective: FR-1 KEEP-fence 固定点 fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
    finalizer:
      preferred_targets:
        - finalizer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - waiting
        - done
        - failed
    - id: review
      actor_role: reviewer
      allowed_exits:
        - handoff
    - id: finalize
      actor_role: finalizer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
      - failed
`;


function buildRuntime(db: Database.Database) {
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
  const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
  // P34：W1 seam 为关闭式失败（MF2）——意图 nudge 的终态 close 需要同数据库 intent store，
  // 以持久化其唤醒动作。
  queueRepo.attachOutbox(new OutboxHandler(db));
  const runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
  return { bus, queueRepo, runtime };
}

describe("WorkflowRuntime facade + FR-1 KEEP-fence 固定点（OPR.0.4.6.WF1）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    ({ bus, queueRepo, runtime } = buildRuntime(db));
    tmp = mkdtempSync(join(tmpdir(), "wf-runtime-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── (d) facade 覆盖 ────────────────────────────────────────────────

  it("facade：validate 对格式正确的 spec 返回 ok，并报告损坏 spec 的问题", () => {
    const good = runtime.validate(specPath);
    expect(good.ok).toBe(true);

    const brokenPath = join(tmp, "broken.yaml");
    writeFileSync(
      brokenPath,
      SPEC.replace("actor_role: reviewer", "actor_role: not-a-declared-role"),
    );
    const bad = runtime.validate(brokenPath);
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("facade：instantiate → project → continue 通过 facade 端到端驱动一个 instance", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "facade 演练",
      createdBySession: "ops@rig",
    });
    expect(inst.instance.status).toBe("active");
    expect(inst.instance.currentStepId).toBe("produce");

    const projected = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(projected.nextStepId).toBe("review");

    const inspected = runtime.continue(inst.instance.instanceId);
    expect(inspected.instance.instanceId).toBe(inst.instance.instanceId);
    expect(inspected.instance.currentStepId).toBe("review");
    expect(inspected.trail).toHaveLength(1);
    expect(inspected.trail[0]!.stepId).toBe("produce");
    expect(inspected.trail[0]!.nextQitemId).toBe(projected.nextQitemId);
  });

  // ── (a) 原子性固定点：事务中途失败 → 零个部分状态 ─────────────────

  it("FR-1a 原子性固定点：在 queue close 后（追加 trail 时）注入失败会回滚一切——绝不出现无下一 qitem 的已关闭 packet", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "原子性固定点",
      createdBySession: "ops@rig",
    });
    const before = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    const qitemCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }
    ).n;

    // 在追加 trail 时注入失败——此时 queue close 与下一 qitem create 已在事务中运行。若 scribe
    // 不具原子性，packet 会保持关闭并生成下一 qitem，却没有 trail/frontier——这正是 FR-1
    // 要固定防止的 lost-handoff 损坏。
    vi.spyOn(runtime.trailLog, "record").mockImplementation(() => {
      throw new Error("injected-mid-txn-failure");
    });

    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      }),
    ).rejects.toThrow("injected-mid-txn-failure");

    // 零个部分状态：
    // 1. 当前 packet 未关闭；
    const packet = queueRepo.getById(inst.entryQitemId);
    expect(packet?.state).toBe("pending");
    expect(packet?.closureReason).toBeNull();
    // 2. 未生成下一 qitem；
    const qitemCountAfter = (
      db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }
    ).n;
    expect(qitemCountAfter).toBe(qitemCountBefore);
    // 3. 未写入 trail 行；
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(0);
    // 4. frontier / step / status / hop count 不变。
    const after = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(after.currentFrontier).toEqual(before.currentFrontier);
    expect(after.currentStepId).toBe(before.currentStepId);
    expect(after.status).toBe(before.status);
    expect(after.hopCount).toBe(before.hopCount);
  });

  it("FR-1a 原子性固定点（崩溃形态、文件存储）：独立连接在失败后看到回滚状态", async () => {
    // 文件存储变体：注入事务中途失败后，第二个 better-sqlite3 连接（新进程对同一文件的视图）
    // 必须看到事务前状态。这是 fr1-midtxn-process-kill VM 演练的单元级替代。
    const fileDb = createDb(join(tmp, "crash-shaped.db"));
    const built = buildRuntime(fileDb);
    const inst = await built.runtime.instantiate({
      specPath,
      rootObjective: "崩溃形态固定点",
      createdBySession: "ops@rig",
    });

    vi.spyOn(built.runtime.trailLog, "record").mockImplementation(() => {
      throw new Error("injected-mid-txn-failure");
    });
    await expect(
      built.runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      }),
    ).rejects.toThrow("injected-mid-txn-failure");

    // 独立连接——从 restart 的视角观察。
    const secondConn = new Database(join(tmp, "crash-shaped.db"));
    try {
      const packetRow = secondConn
        .prepare(`SELECT state, closure_reason FROM queue_items WHERE qitem_id = ?`)
        .get(inst.entryQitemId) as { state: string; closure_reason: string | null };
      expect(packetRow.state).toBe("pending");
      expect(packetRow.closure_reason).toBeNull();

      const trailCount = (
        secondConn
          .prepare(`SELECT COUNT(*) AS n FROM workflow_step_trails WHERE instance_id = ?`)
          .get(inst.instance.instanceId) as { n: number }
      ).n;
      expect(trailCount).toBe(0);

      const instRow = secondConn
        .prepare(
          `SELECT status, current_step_id, hop_count, current_frontier_json
             FROM workflow_instances WHERE instance_id = ?`,
        )
        .get(inst.instance.instanceId) as {
        status: string;
        current_step_id: string;
        hop_count: number;
        current_frontier_json: string;
      };
      expect(instRow.status).toBe("active");
      expect(instRow.current_step_id).toBe("produce");
      expect(instRow.hop_count).toBe(0);
      expect(JSON.parse(instRow.current_frontier_json)).toEqual([inst.entryQitemId]);
    } finally {
      secondConn.close();
      fileDb.close();
    }
  });

  // ── (b) 确定性固定点 ──────────────────────────────────────────────

  it("FR-1b 确定性固定点：N 个相同 (spec, instance) 输入产生相同 routing decision——step、owner、closure shape", async () => {
    const N = 5;
    const decisions: Array<{
      nextStepId: string | null;
      nextOwnerSession: string | null;
      closureReason: string;
      packetState: string | undefined;
      packetClosureReason: string | null | undefined;
      packetClosureTarget: string | null | undefined;
    }> = [];

    for (let i = 0; i < N; i++) {
      const inst = await runtime.instantiate({
        specPath,
        rootObjective: "确定性固定点",
        createdBySession: "ops@rig",
      });
      const projected = await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      });
      const closed = queueRepo.getById(inst.entryQitemId);
      decisions.push({
        nextStepId: projected.nextStepId,
        nextOwnerSession: projected.nextOwnerSession,
        closureReason: projected.closureReason,
        packetState: closed?.state,
        packetClosureReason: closed?.closureReason,
        packetClosureTarget: closed?.closureTarget,
      });
    }

    const first = decisions[0]!;
    expect(first.nextStepId).toBe("review");
    expect(first.nextOwnerSession).toBe("reviewer@rig");
    for (const d of decisions) {
      expect(d).toEqual(first);
    }
  });

  // ── (c) 终态 exit 重放固定点 ──────────────────────────────────────

  it("FR-1c 终态重放固定点：重新投影 handed-off packet 时以结构化 packet_not_on_frontier 错误拒绝且不做变更", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "终态重放固定点",
      createdBySession: "ops@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    const trailCountAfterFirst = runtime.trailLog.countForInstance(
      inst.instance.instanceId,
    );

    let thrown: unknown;
    try {
      await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "producer@rig",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowProjectorError);
    expect((thrown as WorkflowProjectorError).code).toBe("packet_not_on_frontier");
    // 重放未做任何变更。
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(
      trailCountAfterFirst,
    );
  });

  it("FR-1c 终态重放固定点：done 与 failed exit 也会从 frontier 移除 packet，因此拒绝重放", async () => {
    for (const exit of ["done", "failed"] as const) {
      const inst = await runtime.instantiate({
        specPath,
        rootObjective: `终态 ${exit} 重放固定点`,
        createdBySession: "ops@rig",
      });
      await runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit,
        actorSession: "producer@rig",
      });
      await expect(
        runtime.project({
          instanceId: inst.instance.instanceId,
          currentPacketId: inst.entryQitemId,
          exit,
          actorSession: "producer@rig",
        }),
      ).rejects.toMatchObject({
        // 在 frontier 检查运行前就拒绝终态 instance——done/failed instance 状态返回
        // instance_not_active。
        name: "WorkflowProjectorError",
      });
    }
  });
});

// ── P19 A4（finding 已升级）：runtime 拥有默认 seat-liveness check ─────────────
// advisory role_no_live_preferred_target 原本存在，但从未构造 SeatLivenessCheckFn——生产中为死代码
//（instantiate 显式传入 undefined）。现在 runtime 参照 hostRegistryLookup 先例，从自身数据库
// 提供默认实现。先 RED。
const LIVENESS_SPEC = `workflow:
  id: p19-liveness
  version: 1
  objective: 存活性探测
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - dev-worker@lrig
  steps:
    - id: act
      actor_role: worker
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;

describe("P19 A4——默认 seat-liveness check（validator advisory 在生产中生效）", () => {
  it("无 running session → role_no_live_preferred_target 警告；running 时静默；stopped 后再次警告", () => {
    const db = createDb();
    const { runtime } = buildRuntime(db);
    const tmp = mkdtempSync(join(tmpdir(), "wf-p19-"));
    const specPath = join(tmp, "liveness.yaml");
    writeFileSync(specPath, LIVENESS_SPEC);
    try {
      const dead = runtime.validate(specPath);
      expect(dead.issues.some((i) => i.code === "role_no_live_preferred_target")).toBe(true);

      db.prepare(`INSERT INTO rigs (id, name) VALUES ('lr', 'lrig')`).run();
      db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('ln', 'lr', 'dev.worker', 'claude-code')`).run();
      db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('ls', 'ln', 'dev-worker@lrig', 'running')`).run();
      const alive = runtime.validate(specPath);
      expect(alive.issues.some((i) => i.code === "role_no_live_preferred_target")).toBe(false);

      db.prepare(`UPDATE sessions SET status = 'stopped' WHERE id = 'ls'`).run();
      const stopped = runtime.validate(specPath);
      expect(stopped.issues.some((i) => i.code === "role_no_live_preferred_target")).toBe(true);
    } finally {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
