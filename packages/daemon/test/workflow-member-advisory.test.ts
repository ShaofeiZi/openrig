import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "../src/db/migrations/051_workflow_resume.js";
import { workflowInstanceBoundRigSchema } from "../src/db/migrations/052_workflow_instance_bound_rig.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { rigMemberExists } from "../src/domain/workflow-role-context.js";

// OPR.0.4.6.FAC3 C2——FR-5 member-exists 实例化 ADVISORY
//（plan v1.1 §3 C2；PRD FR-5 AC + BR-2）。本切片的引擎部分（B）：
// 一个声明的 preferred_target，既解析为 canonical 又命名一个已注册 rig，
// 但其 member 不存在，则在出厂的 InstantiateResult.advisories 列表上产出
// 一条响亮的聚合 advisory——且实例化始终成功（advisory 绝不拒绝；队列
// 传输闸门保持仅校验 rig-exists）。
//
// 与 workflow-bound-rig.test.ts（degrade-producer 套件——不受 FAC-3 影响；
// 其原样通过即本切片零回归故事的一部分）和 workflow-role-resolution.test.ts
//（本文件复用其 seedSeat 惯用法）互为兄弟。

const TYPO_SPEC = `workflow:
  id: fac3-typo-member
  version: 1
  objective: FR-5 AC pair — typo member on a registered rig
  entry:
    role: builder
  roles:
    builder:
      preferred_targets:
        - dev-typo1@acme-build
  steps:
    - id: build
      actor_role: builder
      allowed_exits:
        - handoff
        - done
`;

const VALID_SPEC = `workflow:
  id: fac3-valid-member
  version: 1
  objective: FR-5 AC pair — valid existing member is silent
  entry:
    role: builder
  roles:
    builder:
      preferred_targets:
        - dev-builder1@acme-build
  steps:
    - id: build
      actor_role: builder
      allowed_exits:
        - done
`;

const COLD_SPEC = `workflow:
  id: fac3-cold-member
  version: 1
  objective: FR-5 existence-not-liveness — a never-launched member is silent
  entry:
    role: builder
  roles:
    builder:
      preferred_targets:
        - dev-cold1@acme-build
  steps:
    - id: build
      actor_role: builder
      allowed_exits:
        - done
`;

const TERMINAL_SPEC = `workflow:
  id: fac3-terminal-member
  version: 1
  objective: FR-5 any-kind — an explicitly named terminal member is silent
  entry:
    role: builder
  roles:
    builder:
      preferred_targets:
        - ops-term1@acme-build
  steps:
    - id: build
      actor_role: builder
      allowed_exits:
        - done
`;

const NEGATIVES_SPEC = `workflow:
  id: fac3-negatives
  version: 1
  objective: FR-5 skip order — raw, human, and unregistered-rig targets raise nothing
  entry:
    role: legacy
  roles:
    legacy:
      preferred_targets:
        - r01-legacy-pane
    human_reviewer:
      preferred_targets:
        - human@kernel
    ghost:
      preferred_targets:
        - dev-x@ghost-rig
  steps:
    - id: one
      actor_role: legacy
      allowed_exits:
        - handoff
    - id: two
      actor_role: human_reviewer
      allowed_exits:
        - handoff
    - id: three
      actor_role: ghost
      allowed_exits:
        - done
`;

const HANDLER_GATE_SPEC = `workflow:
  id: fac3-handler-gate
  version: 1
  objective: FR-5 F-1 scope — a handler gate's target role is swept
  entry:
    role: builder
  roles:
    builder:
      preferred_targets:
        - dev-builder1@acme-build
    gatekeeper:
      preferred_targets:
        - dev-typo2@acme-build
  steps:
    - id: build
      actor_role: builder
      allowed_exits:
        - handoff
    - id: check
      actor_role: builder
      gate:
        target: gatekeeper
        summary: gate check
        evidence_ref: proof/x.md
      allowed_exits:
        - done
`;

const SELF_GATE_SPEC = `workflow:
  id: fac3-self-gate
  version: 1
  objective: FR-5 dedupe — gate target role == actor role probes once
  entry:
    role: gatekeeper
  roles:
    gatekeeper:
      preferred_targets:
        - dev-typo3@acme-build
  steps:
    - id: audit
      actor_role: gatekeeper
      gate:
        target: gatekeeper
        summary: self gate
        evidence_ref: proof/x.md
      allowed_exits:
        - done
`;

const AGGREGATION_SPEC = `workflow:
  id: fac3-aggregation
  version: 1
  objective: FR-5 aggregation — one advisory names every declaring step
  entry:
    role: builder
  roles:
    builder:
      preferred_targets:
        - dev-typo1@acme-build
  steps:
    - id: build-one
      actor_role: builder
      allowed_exits:
        - handoff
    - id: build-two
      actor_role: builder
      allowed_exits:
        - done
`;

const COMPOSED_PRODUCERS_SPEC = `workflow:
  id: fac3-composed
  version: 1
  objective: one list, two producers — degrade advisory + member advisory compose
  target:
    rig: vanished-rig
  entry:
    role: builder
  roles:
    builder:
      preferred_targets:
        - dev-typo1@acme-build
  steps:
    - id: build
      actor_role: builder
      allowed_exits:
        - done
`;

describe("FAC-3 C2：FR-5 成员存在实例化咨询", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let tmp: string;
  let buildRigId: string;
  let sessionSeq = 0;

  function seedSeat(
    rigId: string,
    rigName: string,
    pod: string,
    member: string,
    opts: { role?: string; runtime?: string; sessionStatus?: string | null } = {},
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
        coordinate,
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
    // 044/048 防御性随附（WF-3 fixture-migration 教训：
    // gate park 需要 summary/evidence_ref 列）。
    migrate(db, [
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
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
    const buildRig = rigRepo.createRig("acme-build");
    buildRigId = buildRig.id;
    // The real member the valid/typo pair discriminates against, a
    // never-launched member (existence ≠ liveness), and a terminal
    // member (existence ≠ agent-kind — the recipe's own remote pinned
    // seats are cheap terminal members, constraint (ii)).
    seedSeat(buildRigId, "acme-build", "dev", "builder1", { role: "builder" });
    seedSeat(buildRigId, "acme-build", "dev", "cold1", { sessionStatus: null });
    seedSeat(buildRigId, "acme-build", "ops", "term1", { runtime: "terminal" });
    tmp = mkdtempSync(join(tmpdir(), "wf-fac3-advisory-"));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // ---------- AC 对 ----------

  it("AC 对（拼写错误）：使用一个咨询命名目标 + 步骤/角色 + 结果实例化 SUCCEEDS", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("typo.yaml", TYPO_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    // Instantiate proceeded — the orphan destination WAS minted (the
    // very case the advisory warns about; tier-2 targets are never
    // filtered). Advisory-never-deny.
    expect(result.entryOwnerSession).toBe("dev-typo1@acme-build");
    expect(result.entryQitemId).toBeTruthy();
    expect(result.advisories).toHaveLength(1);
    const advisory = result.advisories[0]!;
    expect(advisory).toContain('"dev-typo1@acme-build"');
    expect(advisory).toContain('"acme-build"');
    expect(advisory).toContain('步骤 "build"');
    expect(advisory).toContain('角色 "builder"');
    expect(advisory).toContain("不会被认领");
    expect(advisory).toContain("卡住异常");
    expect(advisory).toContain("zrig ps");
  });

  it("AC 对（拼写错误，BOUND）：扫描也在绑定实例上运行", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("typo-bound.yaml", TYPO_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
      targetRig: "acme-build",
    });
    expect(result.instance.boundRig).toBe("acme-build");
    expect(result.advisories).toHaveLength(1);
    expect(result.advisories[0]).toContain('"dev-typo1@acme-build"');
  });

  it("AC 对（有效成员）：无声的成功 — 咨询内容为空", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("valid.yaml", VALID_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    expect(result.entryOwnerSession).toBe("dev-builder1@acme-build");
    expect(result.advisories).toEqual([]);
  });

  it("存在≠活力：已宣布但从未启动的成员未提出任何建议", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("cold.yaml", COLD_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    expect(result.advisories).toEqual([]);
  });

  it("存在 ≠ 智能体类型：明确命名的 TERMINAL 成员不会提出任何建议（配方约束 -(ii) 合法性）", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("terminal.yaml", TERMINAL_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    expect(result.advisories).toEqual([]);
  });

  // ---------- 负例（跳过顺序） ----------

  it("负面影响：原始/遗留、人类席位和未注册的工作组目标不会提出建议", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("negatives.yaml", NEGATIVES_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    expect(result.advisories).toEqual([]);
  });

  it("未注册的设备在发生写入的传输处被拒绝（无 FR-5 双重建议；队列门未受影响）", async () => {
    // FR-5 扫描在上面跳过了 dev-x@ghost-rig；对该类的响亮拒绝仍是
    // 队列写入处出厂的 rig-exists 传输闸门。用一个 validateRig 模拟，
    // 它镜像真实 topologyValidateRig 对本 fixture 的 rig-exists 回答。
    const transportRepo = new QueueRepository(db, bus, {
      validateRig: (session) => !session.endsWith("@ghost-rig"),
    });
    let thrown: unknown;
    try {
      await transportRepo.create({
        sourceSession: "orch@acme-build",
        destinationSession: "dev-x@ghost-rig",
        body: "orphan probe",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QueueRepositoryError);
    expect((thrown as QueueRepositoryError).code).toBe("unknown_destination_rig");
  });

  // ---------- handler-gate 腿（锁定 F-1 范围） ----------

  it("handler-gateleg：带有拼写错误成员的门的目标角色会产生命名门的步骤+目标角色的建议", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("handler-gate.yaml", HANDLER_GATE_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    expect(result.advisories).toHaveLength(1);
    const advisory = result.advisories[0]!;
    expect(advisory).toContain('"dev-typo2@acme-build"');
    expect(advisory).toContain('步骤 "check"');
    expect(advisory).toContain('角色 "gatekeeper"');
    // builder 角色的有效目标保持静默（未误报）。
    expect(advisory).not.toContain("dev-builder1");
  });

  it("重复数据删除：一步探测一次的门目标角色 == 参与者角色（一个声明对，而不是两个）", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("self-gate.yaml", SELF_GATE_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    expect(result.advisories).toHaveLength(1);
    const advisory = result.advisories[0]!;
    // 恰好一条 `步骤 "audit"（角色 "gatekeeper"）` 子句——
    // actor_role 探针与 gate-target 探针已合并。
    const occurrences = advisory.split('步骤 "audit"（角色 "gatekeeper"）').length - 1;
    expect(occurrences).toBe(1);
  });

  // ---------- aggregation ----------

  it("聚合：通过两个步骤声明相同的拼写错误目标 → 一个建议命名两者", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("aggregation.yaml", AGGREGATION_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    expect(result.advisories).toHaveLength(1);
    const advisory = result.advisories[0]!;
    expect(advisory).toContain('步骤 "build-one"');
    expect(advisory).toContain('步骤 "build-two"');
  });

  // ---------- zero-regression + composition ----------

  it("零回归：无咨询规范通过咨询 EMPTY 和正常结果形状进行实例化", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("zero.yaml", VALID_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    expect(result.advisories).toEqual([]);
    expect(result.instance.status).toBe("active");
    expect(result.entryQitemId).toBeTruthy();
    // (The degrade-producer suite — workflow-bound-rig.test.ts — is
    // untouched by FAC-3 and keeps passing unmodified: the other half
    // of the zero-regression story.)
  });

  it("一个列表，两个生产者：规范默认降级咨询和成员咨询 COMPOSE", async () => {
    const result = await runtime.instantiate({
      specPath: writeSpec("composed.yaml", COMPOSED_PRODUCERS_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    // Producer 1 (FAC-1): unknown spec-default target.rig → degrade to
    // unbound + advisory. Producer 2 (FAC-3): typo member → advisory.
    expect(result.instance.boundRig).toBeNull();
    expect(result.advisories).toHaveLength(2);
    const joined = result.advisories.join(" || ");
    expect(joined).toContain("vanished-rig");
    expect(joined).toContain("UNBOUND");
    expect(joined).toContain('"dev-typo1@acme-build"');
  });

  // ---------- 探针单元表面 ----------

  it("rigMemberExists：对于真实/冷/终端成员为 true；对于拼写错误的成员或未知的装备为 false", () => {
    expect(rigMemberExists(db, "acme-build", "dev-builder1@acme-build")).toBe(true);
    expect(rigMemberExists(db, "acme-build", "dev-cold1@acme-build")).toBe(true);
    expect(rigMemberExists(db, "acme-build", "ops-term1@acme-build")).toBe(true);
    expect(rigMemberExists(db, "acme-build", "dev-typo1@acme-build")).toBe(false);
    expect(rigMemberExists(db, "ghost-rig", "dev-x@ghost-rig")).toBe(false);
    // The compare is the DERIVED canonical coordinate — a raw string
    // that is not a coordinate of any member misses even when a session
    // by that raw name might exist (the Q5 one-string rule).
    expect(rigMemberExists(db, "acme-build", "not-a-coordinate")).toBe(false);
  });

  // ---------- advisory-never-throw (VM-caught, run-1) ----------

  it("Advisory-never-throw：部分模式数据库上的探测错误会默默地跳过 — 实例化永远不会失败", async () => {
    // The exact run-1 shape: a fixture DB with the workflow tables but
    // WITHOUT the inventory projection's tables (no `snapshots`) — the
    // untouched workflow-bound-rig suite's migration set. Pre-fix, the
    // sweep's probe threw SqliteError out of instantiate; the rail is
    // that an ADVISORY path can never fail the instantiate.
    const { createDb } = await import("../src/db/connection.js");
    const { coreSchema } = await import("../src/db/migrations/001_core_schema.js");
    const { eventsSchema } = await import("../src/db/migrations/003_events.js");
    const { queueItemsSchema } = await import("../src/db/migrations/024_queue_items.js");
    const { queueTransitionsSchema } = await import("../src/db/migrations/025_queue_transitions.js");
    const minimalDb = createDb();
    migrate(minimalDb, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
      workflowResumeSchema,
      workflowInstanceBoundRigSchema,
    ]);
    // A REGISTERED rig so the sweep reaches the member probe (skip (c)
    // passes) — and the probe then errors on the missing snapshots table.
    minimalDb.prepare(`INSERT INTO rigs (id, name) VALUES ('r-min', 'acme-build')`).run();
    const minimalBus = new EventBus(minimalDb);
    const minimalRepo = new QueueRepository(minimalDb, minimalBus, { validateRig: () => true });
    const minimalRuntime = new WorkflowRuntime({ db: minimalDb, eventBus: minimalBus, queueRepo: minimalRepo });
    // 探针本身在该 schema 上确实抛错（这是使本回归有意义的前置条件——
    // 若它停止抛错，测试仍过，但前置断言记录了接缝）。
    expect(() => rigMemberExists(minimalDb, "acme-build", "dev-typo1@acme-build")).toThrow();
    const result = await minimalRuntime.instantiate({
      specPath: writeSpec("never-throw.yaml", TYPO_SPEC),
      rootObjective: "t",
      createdBySession: "orch@acme-build",
    });
    // Instantiate SUCCEEDED; the errored probe means cannot-vouch → no
    // advisory (fail-open — never a throw, never a deny).
    expect(result.entryQitemId).toBeTruthy();
    expect(result.advisories).toEqual([]);
    minimalDb.close();
  });

  // ---------- purity (the FAC-1 Q1 discipline carried) ----------

  it("纯度：rigMemberExists 仅是同步 SQL — 无异步/等待、无时钟、无随机性、无 tmux", () => {
    const source = readFileSync(
      new URL("../src/domain/workflow-role-context.ts", import.meta.url),
      "utf-8",
    );
    const start = source.indexOf("export function rigMemberExists");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}", start);
    const body = source.slice(start, end);
    expect(body).not.toMatch(/\basync\b|\bawait\b/);
    expect(body).not.toMatch(/Date\.now|new Date|setTimeout|setInterval/);
    expect(body).not.toMatch(/Math\.random/);
    expect(body).not.toMatch(/tmux|attachAgentActivity|SeatActivityService/);
  });
});
