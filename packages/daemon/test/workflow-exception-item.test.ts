// OPR.0.4.6.WF5 FR-2 class (a)：在事务中诞生的 exception item。
//
// 承重的“绝不丢失”验收条件：不存在实例已失败但 attention item 尚不存在的窗口，两者要么
// 一起提交，要么一起回滚（guard attention flag 1）。此外还覆盖：接线层的 tier 分流
//（路由到 orchestrator 的条目不匹配已发布 attention union 的任一分支）、每个旋钮位置的
// never-lost fallback、write-gate fallback，以及 happy path 下零条目的反例（FR-5 的约束：
// 任意路由均为零条目）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { isHumanSeatSession } from "../src/domain/human-route-enforcer.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const SPEC_WITH_ORCH = `workflow:
  id: wf5-exc-pipeline
  version: 1
  objective: WF-5 class-a fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
    orch:
      preferred_targets:
        - orch-lead@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
  exception_routing:
    orchestrator_role: orch
`;

const SPEC_NO_ROUTING = SPEC_WITH_ORCH.replace(
  /  exception_routing:\n    orchestrator_role: orch\n/,
  "",
).replace("id: wf5-exc-pipeline", "id: wf5-exc-noroute");

const SPEC_HUMAN_ONLY = SPEC_WITH_ORCH.replace(
  "  exception_routing:\n    orchestrator_role: orch\n",
  "  exception_routing:\n    default: human_only\n    orchestrator_role: orch\n",
).replace("id: wf5-exc-pipeline", "id: wf5-exc-humanonly");


function exceptionRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare(`SELECT * FROM queue_items WHERE tags LIKE '%workflow-exception%'`)
    .all() as Array<Record<string, unknown>>;
}

describe("WF-5 FR-2 class (a)：事务内创建的 exception item", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;

  const build = (opts?: { validateRig?: (ref: string) => boolean; hostDefault?: () => "orchestrator" | "human_only" | null }) => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, {
      validateRig: opts?.validateRig ?? (() => true),
    });
    // P34：W1 接缝采用 fail-closed（MF2）；期望 nudge 的终态关闭需要同数据库的 intent
    // store 才能持久化 wake。
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({
      db,
      eventBus: bus,
      queueRepo,
      exceptionDial: {
        hostDefault: opts?.hostDefault ?? (() => null),
        humanFallbackSeat: "human@host",
      },
    });
  };

  const seed = (spec: string) => {
    tmp = mkdtempSync(join(tmpdir(), "wf5-exc-"));
    const specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, spec);
    return specPath;
  };

  const failEntryStep = async (specPath: string) => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "wf5 exception walk",
      createdBySession: "ops@rig",
    });
    const packetId = inst.instance.currentFrontier[0]!;
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: packetId,
      exit: "failed",
      resultNote: "induced unmapped failure",
      actorSession: "producer@rig",
    });
    return { instanceId: inst.instance.instanceId, packetId };
  };

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("失败提交携带条目：failed 实例与 exception item 同时存在，并以普通 tier 路由到 orchestrator 目标", async () => {
    build();
    const { instanceId, packetId } = await failEntryStep(seed(SPEC_WITH_ORCH));

    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    const item = rows[0]!;
    expect(item.destination_session).toBe("orch-lead@rig");
    // 接线层的 tier-split 反例：普通 tier 且目标非 human，因此不匹配 attention union
    // 的任一分支。
    expect(item.tier).not.toBe("human-gate");
    expect(isHumanSeatSession(item.destination_session)).toBe(false);
    // identity tag 用于可查询 join，绝不依赖 summary 解析。
    const tags = String(item.tags);
    expect(tags).toContain(`instance:${instanceId}`);
    expect(tags).toContain("step:produce");
    expect(tags).toContain("exception:unmapped_failed");
    expect(tags).toContain(`occurrence:${packetId}`);
    // 可执行信息：summary + evidence 指针 + 解决入口。
    expect(String(item.summary)).toContain("没有补救分支");
    expect(String(item.evidence_ref)).toContain("zrig workflow trace");
    expect(String(item.body)).toContain("zrig workflow resume");
  });

  it("原子性：创建条目时注入失败会回滚整个关闭，不出现有失败无条目或有条目无失败的窗口", async () => {
    build();
    const specPath = seed(SPEC_WITH_ORCH);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "atomicity pin",
      createdBySession: "ops@rig",
    });
    const packetId = inst.instance.currentFrontier[0]!;
    const spy = vi
      .spyOn(queueRepo, "createWithinTransaction")
      .mockImplementation(() => {
        throw new Error("boom-injected-mid-txn");
      });
    await expect(
      runtime.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: packetId,
        exit: "failed",
        resultNote: "induced",
        actorSession: "producer@rig",
      }),
    ).rejects.toThrow(/boom-injected/);
    spy.mockRestore();

    // 整个事务回滚：实例未失败，packet 仍在 frontier 上打开，exception item 为零。
    const instRow = db
      .prepare(`SELECT status FROM workflow_instances WHERE instance_id = ?`)
      .get(inst.instance.instanceId) as { status: string };
    expect(instRow.status).toBe("active");
    expect(exceptionRows(db)).toHaveLength(0);
    const packet = db
      .prepare(`SELECT state FROM queue_items WHERE qitem_id = ?`)
      .get(packetId) as { state: string };
    expect(["pending", "in-progress"]).toContain(packet.state);
  });

  it("NEVER-LOST FALLBACK：无 exception_routing 且无 host 默认值时，以 human-gate tier 路由到 human@host", async () => {
    build();
    await failEntryStep(seed(SPEC_NO_ROUTING));
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_session).toBe("human@host");
    expect(rows[0]!.tier).toBe("human-gate");
  });

  it("HUMAN-ONLY 旋钮：优先以 human-gate tier 路由到 human@host（匹配已发布 attention union 的 tier 分支）", async () => {
    build();
    await failEntryStep(seed(SPEC_HUMAN_ONLY));
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_session).toBe("human@host");
    expect(rows[0]!.tier).toBe("human-gate");
  });

  it("规范未声明路由时应用 host 旋钮默认值（link 3）", async () => {
    build({ hostDefault: () => "human_only" });
    await failEntryStep(seed(SPEC_NO_ROUTING.replace("wf5-exc-noroute", "wf5-exc-hostdial")));
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe("human-gate");
  });

  it("WRITE-GATE FALLBACK：queue gate 拒绝目标时改路由到 human@host，不丢异常也不让关闭失败", async () => {
    build({
      validateRig: (ref: string) => !ref.includes("orch-lead"),
    });
    const { instanceId } = await failEntryStep(seed(SPEC_WITH_ORCH));
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_session).toBe("human@host");
    expect(rows[0]!.tier).toBe("human-gate");
    const instRow = db
      .prepare(`SELECT status FROM workflow_instances WHERE instance_id = ?`)
      .get(instanceId) as { status: string };
    expect(instRow.status).toBe("failed");
  });

  it("HAPPY-PATH 反例（FR-5 约束）：健康端到端运行不创建任何路由类型的 exception item", async () => {
    build();
    const specPath = seed(SPEC_WITH_ORCH.replace("id: wf5-exc-pipeline", "id: wf5-exc-happy"));
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "happy path",
      createdBySession: "ops@rig",
    });
    const p1 = inst.instance.currentFrontier[0]!;
    const r1 = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: p1,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: r1.nextQitemId!,
      exit: "done",
      actorSession: "reviewer@rig",
    });
    const instRow = db
      .prepare(`SELECT status FROM workflow_instances WHERE instance_id = ?`)
      .get(inst.instance.instanceId) as { status: string };
    expect(instRow.status).toBe("completed");
    expect(exceptionRows(db)).toHaveLength(0);
    // FR-5 的第二条约束：orchestrator 零主动介入；健康运行时，声明的 orchestrator seat
    // 不会收到任何内容。
    const orchBound = db
      .prepare(`SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = 'orch-lead@rig'`)
      .get() as { n: number };
    expect(orchBound.n).toBe(0);
  });

  it("class (c) 流程中段：WF-2 human gate 条目就是 exception item，单个 packet 携带完整 class-c 身份且 occurrence 等于自身 ID", async () => {
    build();
    const gated = SPEC_WITH_ORCH.replace("id: wf5-exc-pipeline", "id: wf5-exc-gate").replace(
      `    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed`,
      `    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
      gate:
        target: human@host
        summary: sign off the review
        evidence_ref: proof/review.md`,
    );
    const specPath = seed(gated);
    const inst = await runtime.instantiate({ specPath, rootObjective: "gate", createdBySession: "ops@rig" });
    const r = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.instance.currentFrontier[0]!,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    const item = rows[0]!;
    // 只有一个条目：gate packet 本身，不再创建第二个条目。
    expect(item.qitem_id).toBe(r.nextQitemId);
    const tags = String(item.tags);
    expect(tags).toContain("exception:human_gate_trip");
    expect(tags).toContain("step:review");
    expect(tags).toContain(`occurrence:${r.nextQitemId}`);
    expect(tags).toContain(`instance:${inst.instance.instanceId}`);
    // 通过 park 分支呈现 attention（blocked_on human@host）。
    expect(item.state).toBe("blocked");
    expect(item.blocked_on).toBe("human@host");
  });

  it("class (c) GATED ENTRY：入口 gate packet 从创建起即携带 class-c 身份", async () => {
    build();
    const entryGated = SPEC_WITH_ORCH.replace("id: wf5-exc-pipeline", "id: wf5-exc-entrygate").replace(
      `    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed`,
      `    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed
      gate:
        target: human@host
        summary: approve the kickoff
        evidence_ref: proof/kickoff.md`,
    );
    const specPath = seed(entryGated);
    const inst = await runtime.instantiate({ specPath, rootObjective: "entry gate", createdBySession: "ops@rig" });
    const entryId = inst.instance.currentFrontier[0]!;
    const rows = exceptionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qitem_id).toBe(entryId);
    const tags = String(rows[0]!.tags);
    expect(tags).toContain("exception:human_gate_trip");
    expect(tags).toContain("step:produce");
    expect(tags).toContain(`occurrence:${entryId}`);
  });

  it("class (c) 反例：handler-role gate 不携带 exception identity（确定性交接）", async () => {
    build();
    const handlerGated = SPEC_WITH_ORCH.replace("id: wf5-exc-pipeline", "id: wf5-exc-handlergate").replace(
      `    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed`,
      `    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
      gate:
        target: reviewer`,
    );
    const specPath = seed(handlerGated);
    const inst = await runtime.instantiate({ specPath, rootObjective: "handler", createdBySession: "ops@rig" });
    await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.instance.currentFrontier[0]!,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    expect(exceptionRows(db)).toHaveLength(0);
  });

  it("已映射的 failed（WF-2 分支）属于 remediation 而非 exception，因此条目为零", async () => {
    build();
    const branched = SPEC_WITH_ORCH.replace(
      "id: wf5-exc-pipeline",
      "id: wf5-exc-branched",
    ).replace(
      `    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed`,
      `    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - done
        - failed
      next_hop:
        on:
          failed: review`,
    );
    const specPath = seed(branched);
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "mapped failed",
      createdBySession: "ops@rig",
    });
    const p1 = inst.instance.currentFrontier[0]!;
    const r = await runtime.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: p1,
      exit: "failed",
      resultNote: "mapped — routes to remediation",
      actorSession: "producer@rig",
    });
    expect(r.nextStepId).toBe("review");
    const instRow = db
      .prepare(`SELECT status FROM workflow_instances WHERE instance_id = ?`)
      .get(inst.instance.instanceId) as { status: string };
    expect(instRow.status).toBe("active");
    expect(exceptionRows(db)).toHaveLength(0);
  });
});
