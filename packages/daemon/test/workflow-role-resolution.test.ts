import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "../src/db/migrations/051_workflow_resume.js";
import { workflowInstanceBoundRigSchema } from "../src/db/migrations/052_workflow_instance_bound_rig.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "../src/domain/workflow-role-resolver.js";

// OPR.0.4.6.FAC1 commit 3——能力解析器（AC-2 核心；BR-1/2/3/5；ARCH Q1/Q2/Q3/Q5；
// GUARD B1-B4）。这里分两层：
//   1. 纯策略（selectRoleSeat）——行为向量（完整的确定性/排列向量集属于 commit 4）；
//   2. 六个 owner 解析调用点，每个都接入真实数据库（projector 下一步骤、human-gate owner、
//      handler-role gate 目标、entry、eager/structural、resume），再加 Q3 异常路由一致性、
//      工作组消失时的诚实性与 unbound 字节一致性。

// ---------- 第 1 层：纯策略 ----------

function facts(over: Partial<RoleSeatCandidateFacts>): RoleSeatCandidateFacts {
  return {
    logicalId: "dev.x",
    role: "driver",
    nodeKind: "agent",
    lifecycleState: "running",
    runtime: "claude-code",
    pendingWorkCount: 0,
    coordinate: "dev-x@factory-a",
    rawSessionName: "dev-x@factory-a",
    ...over,
  };
}

describe("FAC-1 C3：selectRoleSeat（纯策略行为）", () => {
  it("选择合格 seat，并列出每个干扰候选的不合格原因", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [
        facts({ logicalId: "dev.dead", coordinate: "dev-dead@f", rawSessionName: "dev-dead@f", lifecycleState: "detached" }),
        facts({ logicalId: "dev.wrongrt", coordinate: "dev-wrongrt@f", rawSessionName: "dev-wrongrt@f", runtime: "codex" }),
        facts({ logicalId: "dev.roleless", coordinate: "dev-roleless@f", rawSessionName: "dev-roleless@f", role: null }),
        facts({ logicalId: "dev.adopted", coordinate: "dev-adopted@f", rawSessionName: "my-raw-tmux" }),
        facts({ logicalId: "dev.good", coordinate: "dev-good@f", rawSessionName: "dev-good@f" }),
      ],
      harness: "claude-code",
    });
    expect(result.seat).toBe("dev-good@f");
    const byId = new Map(result.disqualified.map((d) => [d.logicalId, d.disqualifier]));
    expect(byId.get("dev.dead")).toBe("not_live(lifecycleState=detached)");
    expect(byId.get("dev.wrongrt")).toBe("runtime_mismatch(codex≠claude-code)");
    expect(byId.get("dev.roleless")).toBe("role_not_declared");
    expect(byId.get("dev.adopted")).toBe("adopted_seat_not_role_resolvable_v1");
  });

  it("未固定的步骤接受任意 agent runtime，pending backlog 最少者优先，并按坐标码点打破平局", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [
        facts({ logicalId: "a", coordinate: "dev-b@f", rawSessionName: "dev-b@f", pendingWorkCount: 2, runtime: "codex" }),
        facts({ logicalId: "b", coordinate: "dev-c@f", rawSessionName: "dev-c@f", pendingWorkCount: 0 }),
        facts({ logicalId: "c", coordinate: "dev-a@f", rawSessionName: "dev-a@f", pendingWorkCount: 0 }),
      ],
    });
    expect(result.seat).toBe("dev-a@f"); // 零负载平局时按码点升序。
    expect(result.qualified.map((q) => q.coordinate)).toEqual(["dev-a@f", "dev-c@f", "dev-b@f"]);
  });

  it("没有合格项时返回 seat=null 与完整的不合格列表", () => {
    const result = selectRoleSeat({
      role: "qa",
      candidates: [facts({ role: "qa", lifecycleState: "detached" })],
    });
    expect(result.seat).toBeNull();
    expect(result.disqualified).toHaveLength(1);
  });

  it("infrastructure/terminal 节点完全不在范围内（绝不列出）", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [facts({ nodeKind: "infrastructure" })],
    });
    expect(result.seat).toBeNull();
    expect(result.disqualified).toHaveLength(0);
  });
});

// ---------- 第 2 层：基于真实数据库的六个调用点 ----------

const ROLE_ONLY_SPEC = `workflow:
  id: fac1-role-only
  version: 1
  objective: role-only two-step flow
  target:
    rig: factory-a
  entry:
    role: planner
  roles:
    planner: {}
    driver: {}
  steps:
    - id: plan
      actor_role: planner
      allowed_exits:
        - handoff
        - failed
    - id: build
      actor_role: driver
      allowed_exits:
        - done
        - failed
`;

const HANDLER_GATE_SPEC = `workflow:
  id: fac1-handler-gate
  version: 1
  objective: role-only handler gate
  target:
    rig: factory-a
  entry:
    role: planner
  roles:
    planner: {}
    guard: {}
  steps:
    - id: plan
      actor_role: planner
      allowed_exits:
        - handoff
    - id: gatecheck
      actor_role: planner
      gate:
        target: guard
        summary: guard check
`;

const HUMAN_GATE_SPEC = `workflow:
  id: fac1-human-gate
  version: 1
  objective: role-only human gate
  entry:
    role: planner
  target:
    rig: factory-a
  roles:
    planner: {}
  steps:
    - id: plan
      actor_role: planner
      allowed_exits:
        - handoff
    - id: signoff
      actor_role: planner
      gate:
        target: human@kernel
        summary: sign this off
        evidence_ref: proof/x.md
`;

describe("FAC-1 C3：绑定工作组上的六个 owner 解析调用点", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let tmp: string;
  let rigAId: string;
  let sessionSeq = 0;

  function seedSeat(
    rigId: string,
    rigName: string,
    pod: string,
    member: string,
    opts: { role?: string; runtime?: string; sessionStatus?: string | null; rawName?: string },
  ): string {
    const podRec =
      podRepo.getPodByNamespace(rigId, pod) ?? podRepo.createPod(rigId, pod, pod);
    const node = rigRepo.addNode(rigId, `${pod}.${member}`, {
      role: opts.role,
      runtime: opts.runtime ?? "claude-code",
      cwd: "/tmp",
      podId: podRec.id,
      agentRef: "local:agents/x",
      profile: "default",
    });
    const coordinate = `${pod}-${member}@${rigName}`;
    if (opts.sessionStatus !== null) {
      sessionSeq += 1;
      db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)`).run(
        `s-${String(sessionSeq).padStart(4, "0")}`,
        node.id,
        opts.rawName ?? coordinate,
        opts.sessionStatus ?? "running",
      );
    }
    return coordinate;
  }

  function writeSpec(name: string, content: string): string {
    const p = join(tmp, name);
    writeFileSync(p, content);
    return p;
  }

  beforeEach(() => {
    db = createFullTestDb();
    // createFullTestDb 提供 node/rig/queue 集合；workflow 表通过规范 migration 对象叠加。
    // 044/048 对 human-gate park 路径至关重要（summary/evidence_ref 列；VM 已发现：没有
    // 它们时，gate 条目在 create 时携带的 summary 会静默丢失，validateHumanPark 会在
    // park 时失败）。
    migrate(db, [
      outboxEntriesSchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
      workflowResumeSchema,
      workflowInstanceBoundRigSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝采用 fail-closed（MF2）；期望 nudge 的终态关闭需要同数据库的 intent
    // store 才能持久化 wake。
    queueRepo.attachOutbox(new OutboxHandler(db));
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
    const rigA = rigRepo.createRig("factory-a");
    rigAId = rigA.id;
    tmp = mkdtempSync(join(tmpdir(), "wf-fac1-"));
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ROW 3 + ROW 1：entry 在绑定工作组上实时解析，下一步骤在投影时解析并记录 owner_resolution trail 证据", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const driverSeat = seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);

    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "t",
      createdBySession: "orch@factory-a",
    });
    // ROW 3：entry 按能力解析（任何位置都没有 preferred_targets）。
    expect(inst.entryOwnerSession).toBe("dev-planner1@factory-a");
    expect(inst.instance.boundRig).toBe("factory-a");

    // ROW 1：projector 下一步骤解析并记录 driver role。
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(driverSeat);
    const packet = queueRepo.getById(projected.nextQitemId!);
    expect(packet?.destinationSession).toBe(driverSeat);
    // owner_resolution trail 证据（mode=role，并记录 boundRig）。
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    const evidence = trail.find((t) => t.priorQitemId === inst.entryQitemId)?.closureEvidence as
      | Record<string, Record<string, unknown>>
      | null;
    expect(evidence?.["owner_resolution"]).toMatchObject({
      mode: "role",
      role: "driver",
      boundRig: "factory-a",
      seat: driverSeat,
    });
  });

  it("ROW 1 干扰项：合格 seat 优先于 dead、runtime 错误、无 role 和高负载候选", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "dead1", { role: "driver", sessionStatus: "stopped" });
    seedSeat(rigAId, "factory-a", "dev", "wrongrt", { role: "driver", runtime: "codex" });
    seedSeat(rigAId, "factory-a", "dev", "roleless", {});
    const loaded = seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const idle = seedSeat(rigAId, "factory-a", "dev", "driver2", { role: "driver" });
    // 给第一个 driver 增加一个 PENDING 条目（已认领条目的排序值为零）。
    await queueRepo.create({ sourceSession: "orch@factory-a", destinationSession: loaded, body: "busywork" });

    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(idle);
  });

  it("ROW 2b：仅声明 role 的 HANDLER-ROLE gate 按绑定工作组能力解析 handler seat", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const guardSeat = seedSeat(rigAId, "factory-a", "rev", "guard1", { role: "guard" });
    const specPath = writeSpec("handler-gate.yaml", HANDLER_GATE_SPEC);

    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(guardSeat);
    // Handler-role gate 不在 human 上 park；实例在 gate 条目上保持 waiting。
    expect(projected.instance.status).toBe("waiting");
  });

  it("ROW 2a：仅声明 role 的 HUMAN-gated 步骤按绑定工作组能力解析已 park packet 的 OWNER", async () => {
    const plannerSeat = seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const specPath = writeSpec("human-gate.yaml", HUMAN_GATE_SPEC);

    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: plannerSeat,
    });
    // gate packet 属于按能力解析的 ROLE OWNER，并停放到 human。
    const packet = queueRepo.getById(projected.nextQitemId!);
    expect(packet?.destinationSession).toBe(plannerSeat);
    expect(packet?.blockedOn).toBe("human@kernel");
  });

  it("ROW 4：instantiate 仅在结构性零 role 覆盖时硬失败，已声明但停止的 seat 可正常实体化", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);

    // 没有任何 seat 声明 "driver"，因此明确地结构性硬失败。
    await expect(
      runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" }),
    ).rejects.toMatchObject({ code: "bound_rig_role_uncovered" });

    // STOPPED driver seat 代表结构覆盖（只看存在性，不看 liveness），所以 instantiate 成功；
    // liveness 由投影阶段负责。
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver", sessionStatus: "stopped" });
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    expect(inst.instance.boundRig).toBe("factory-a");
  });

  it("ROW 4 扩容时序：停止的 role seat 在 instantiate 后恢复，并在投影时解析（guard B1）", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    // instantiate 时节点存在且已声明 role，但未运行。
    const nodeCoord = seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver", sessionStatus: null });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });

    // seat 在步骤投影前恢复（预热场景）。
    const node = db.prepare(`SELECT id FROM nodes WHERE logical_id = 'dev.driver1'`).get() as { id: string };
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-late', ?, ?, 'running')`).run(
      node.id,
      nodeCoord,
    );
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(nodeCoord);
  });

  it("ROW 5：resume 按能力重新解析，失败到恢复期间 inventory 变化时路由到新 seat", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    const firstDriver = seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(firstDriver);
    // driver 步骤失败，实例转为 failed。
    await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: projected.nextQitemId!,
      exit: "failed",
      actorSession: firstDriver,
      resultNote: "driver died",
    });
    // Inventory 变化：driver1 停止，码点更靠前的新 driver0 启动。
    db.prepare(`UPDATE sessions SET status = 'stopped' WHERE session_name = ?`).run(firstDriver);
    const newDriver = seedSeat(rigAId, "factory-a", "dev", "driver0", { role: "driver" });

    const resumed = await runtime.resume({ instanceId: inst.instance.instanceId, actorSession: "orch@factory-a" });
    expect(resumed.ownerSession).toBe(newDriver); // 重新解析，绝不复制旧值。
  });

  it("Q3：绑定实例的未映射 failed exception 按能力路由到工作组本地 orchestrator seat（旋钮位置 3）", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const orchSeat = seedSeat(rigAId, "factory-a", "orch", "lead", { role: "orchestrator" });
    // 仅声明 role 的规范 + WF-5 旋钮：声明 orchestrator_role，且 orchestrator role 的
    // preferred_targets 为零（能力分支）。
    const specText = ROLE_ONLY_SPEC.replace(
      "  roles:",
      "  exception_routing:\n    orchestrator_role: orchestrator\n  roles:\n    orchestrator: {}",
    );
    const specPath = writeSpec("role-exc.yaml", specText);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    // 让 ENTRY packet 失败（未映射 failed → 在事务内创建 class-a exception）。
    await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "failed",
      actorSession: "dev-planner1@factory-a",
      resultNote: "boom",
    });
    const items = db
      .prepare(
        `SELECT destination_session FROM queue_items WHERE tags LIKE '%workflow-exception%' AND tags LIKE ?`,
      )
      .all(`%instance:${inst.instance.instanceId}%`) as Array<{ destination_session: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.destination_session).toBe(orchSeat);
  });

  it("工作组消失：绑定工作组在运行中被拆除时，以 bound_rig_not_found 明确解析失败", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    // 工作组消失，名称不再可解析。
    db.prepare(`UPDATE rigs SET name = 'renamed-away' WHERE id = ?`).run(rigAId);
    await expect(
      runtime.projector.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "dev-planner1@factory-a",
      }),
    ).rejects.toMatchObject({ code: "bound_rig_not_found" });
  });

  it("明确列出候选：所有 role seat 停止时返回逐候选结构化原因，零声明时返回命名消息", async () => {
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver", sessionStatus: "stopped" });
    const specPath = writeSpec("role-only.yaml", ROLE_ONLY_SPEC);
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    let thrown: unknown;
    try {
      await runtime.projector.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "dev-planner1@factory-a",
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as WorkflowProjectorError;
    expect(e.code).toBe("next_owner_unresolved");
    const candidates = e.details?.["candidates"] as Array<{ coordinate: string; disqualifier: string }>;
    const driver1 = candidates.find((c) => c.coordinate === "dev-driver1@factory-a");
    expect(driver1?.disqualifier).toMatch(/^not_live\(lifecycleState=/);

    // 零候选：新工作组中没有 seat 声明 entry role。
    const rigB = rigRepo.createRig("factory-b");
    seedSeat(rigB.id, "factory-b", "dev", "somebody", {});
    // instantiate 时先触发结构检查，返回命名的零覆盖错误。
    await expect(
      runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a", targetRig: "factory-b" }),
    ).rejects.toMatchObject({ code: "bound_rig_role_uncovered" });
  });

  it("UNBOUND 字节一致性：未绑定实例中无 target 的 role 步骤保留既有 next_owner_unresolved 形状", async () => {
    const unboundSpec = ROLE_ONLY_SPEC.replace("  target:\n    rig: factory-a\n", "");
    const specPath = writeSpec("unbound.yaml", unboundSpec);
    seedSeat(rigAId, "factory-a", "dev", "planner1", { role: "planner" });
    seedSeat(rigAId, "factory-a", "dev", "driver1", { role: "driver" });
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "t",
      createdBySession: "orch@factory-a",
      entryOwnerSession: "dev-planner1@factory-a",
    });
    expect(inst.instance.boundRig).toBeNull();
    let thrown: unknown;
    try {
      await runtime.projector.project({
        instanceId: inst.instance.instanceId,
        currentPacketId: inst.entryQitemId,
        exit: "handoff",
        actorSession: "dev-planner1@factory-a",
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as WorkflowProjectorError;
    expect(e.code).toBe("next_owner_unresolved");
    // 已发布的 unbound 消息（提供 nextOwnerSession / 添加 preferred_targets），不包含
    // bound-rig candidates 区块。
    expect(e.message).toContain("请显式提供 nextOwnerSession");
    expect(e.details?.["candidates"]).toBeUndefined();
  });
});
