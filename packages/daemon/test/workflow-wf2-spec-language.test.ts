// OPR.0.4.6.WF2——全功能规范语言：新字段的解析器严格性（FR-6）、解析时移除
// gates[]/prefer（FR-4/FR-5）、基于结果的条件分支语言及其校验与执行（FR-1——唯一
// 具名的引擎扩展）、harness 固定（FR-2）、host 固定的 MH-3 边界（FR-3）、将 gate
// 编译到发行原语（FR-5），以及零回归主干（BR-3）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { parseWorkflowSpec, WorkflowSpecError } from "../src/domain/workflow-spec-cache.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import { resolveNextStep } from "../src/domain/workflow-projector.js";

// ── 规范夹具 ────────────────────────────────────────────────────────

const BRANCHED_SPEC = `workflow:
  id: wf2-branched
  version: 1
  loop_guards:
    max_hops: 8
  roles:
    builder:
      preferred_targets: [builder@rig]
    fixer:
      preferred_targets: [fixer@rig]
    prover:
      preferred_targets: [prover@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, waiting, done, failed]
      next_hop:
        on: { failed: remediate }
    - id: verify
      actor_role: prover
      allowed_exits: [handoff, waiting, done, failed]
      next_hop:
        on: { failed: remediate }
    - id: remediate
      actor_role: fixer
      allowed_exits: [handoff, waiting, done, failed]
      next_hop:
        suggested_roles: [prover]
`;

// 相同结构但不含分支映射——零回归双生夹具。
const LINEAR_SPEC = `workflow:
  id: wf2-linear
  version: 1
  roles:
    builder:
      preferred_targets: [builder@rig]
    prover:
      preferred_targets: [prover@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, waiting, done, failed]
    - id: verify
      actor_role: prover
      allowed_exits: [handoff, waiting, done, failed]
`;

const HARNESS_SPEC = `workflow:
  id: wf2-harness
  version: 1
  roles:
    builder:
      preferred_targets: [claude-seat@rig, codex-seat@rig]
    prover:
      preferred_targets: [codex-seat@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, done]
      harness: codex
    - id: prove
      actor_role: prover
      allowed_exits: [done]
`;

const GATED_HUMAN_SPEC = `workflow:
  id: wf2-gated-human
  version: 1
  roles:
    builder:
      preferred_targets: [builder@rig]
    prover:
      preferred_targets: [prover@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, done]
    - id: signoff
      actor_role: prover
      allowed_exits: [done]
      gate:
        target: human@kernel
        summary: "批准发布"
        evidence_ref: proof/PROOF.md
`;

const GATED_HANDLER_SPEC = `workflow:
  id: wf2-gated-handler
  version: 1
  roles:
    builder:
      preferred_targets: [builder@rig]
    checker:
      preferred_targets: [checker@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, done]
    - id: checkpoint
      actor_role: builder
      allowed_exits: [done]
      gate:
        target: checker
        summary: "关闭前由处理者检查"
`;

// rev1-r2 阻塞项固定：步骤同时带 harness 固定与处理者角色 gate——固定必须绑定处理者
// 席位（数据包的实际路由目标），绝不能被静默绕过。
const GATED_HANDLER_PINNED_SPEC = `workflow:
  id: wf2-gated-handler-pinned
  version: 1
  roles:
    builder:
      preferred_targets: [builder@rig]
    checker:
      preferred_targets: [claude-check@rig, codex-check@rig]
  steps:
    - id: build
      actor_role: builder
      allowed_exits: [handoff, done]
    - id: checkpoint
      actor_role: builder
      allowed_exits: [done]
      harness: codex
      gate:
        target: checker
        summary: "固定处理者检查"
`;

function writeSpec(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("OPR.0.4.6.WF2——规范语言", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      outboxEntriesSchema,
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      queueItemSummarySchema,
      queueItemEvidenceRefSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
      missionControlActionsSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝失败关闭（MF2）——旨在 nudge 的终态关闭需要同一数据库的意图存储，
    // 才能使其唤醒持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    tmp = mkdtempSync(join(tmpdir(), "wf2-lang-"));
    runtime = new WorkflowRuntime({ exceptionDial: { hostDefault: () => null, humanFallbackSeat: "human@host" }, db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 植入托管节点与会话，使 nodeRuntimeOf 能解析运行时。 */
  function seedSeat(sessionName: string, runtimeName: string, nodeId: string): void {
    db.prepare(
      `INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'r-1', ?, ?)`,
    ).run(nodeId, sessionName.split("@")[0], runtimeName);
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')`,
    ).run(`s-${nodeId}`, nodeId, sessionName);
  }

  // ── FR-6：新表层上的解析器严格性 ──────────────────────────────────

  describe("FR-6 解析器严格性（原始数据接缝）", () => {
    it("拒绝已移除的 gates[] 字符串列表，并给出是什么/为什么/如何修复的迁移错误", () => {
      const yaml = `workflow:
  id: legacy-gates
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      gates: [approval]
`;
      expect(() => parseWorkflowSpec(yaml, "legacy.yaml")).toThrowError(
        expect.objectContaining({ code: "spec_gates_removed" }),
      );
      try {
        parseWorkflowSpec(yaml, "legacy.yaml");
      } catch (e) {
        expect((e as WorkflowSpecError).message).toContain("gate:");
        expect((e as WorkflowSpecError).message).toContain("target:");
      }
    });

    it("拒绝已移除的 next_hop.mode prefer，并在迁移错误中指出替代项", () => {
      const yaml = `workflow:
  id: legacy-prefer
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      next_hop:
        mode: prefer
        suggested_roles: [a]
`;
      expect(() => parseWorkflowSpec(yaml, "legacy.yaml")).toThrowError(
        expect.objectContaining({ code: "spec_prefer_mode_removed" }),
      );
      try {
        parseWorkflowSpec(yaml, "legacy.yaml");
      } catch (e) {
        expect((e as WorkflowSpecError).message).toContain("require");
        expect((e as WorkflowSpecError).message).toContain("forbid");
      }
    });

    it("拒绝封闭退出枚举之外的分支键，并指出允许集合", () => {
      const yaml = `workflow:
  id: bad-branch-key
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      next_hop:
        on: { success: s1 }
`;
      expect(() => parseWorkflowSpec(yaml, "bad.yaml")).toThrowError(
        expect.objectContaining({ code: "spec_branch_key_invalid" }),
      );
    });

    it("拒绝 harness:terminal，并在说明错误中列出智能体集合", () => {
      const yaml = `workflow:
  id: bad-harness
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      harness: terminal
`;
      try {
        parseWorkflowSpec(yaml, "bad.yaml");
        expect.unreachable("预期应抛出异常");
      } catch (e) {
        expect((e as WorkflowSpecError).code).toBe("spec_harness_invalid");
        expect((e as WorkflowSpecError).message).toContain("claude-code");
        expect((e as WorkflowSpecError).message).toContain("codex");
        expect((e as WorkflowSpecError).message).toContain("不是智能体 harness");
      }
    });

    it("依据封闭 gate 键集拒绝未知 gate 键", () => {
      const yaml = `workflow:
  id: bad-gate-key
  version: 1
  roles:
    a: { preferred_targets: [a@rig] }
  steps:
    - id: s1
      actor_role: a
      gate:
        target: human@kernel
        summary: ok
        evidence_ref: proof/x.md
        condition: always
`;
      expect(() => parseWorkflowSpec(yaml, "bad.yaml")).toThrowError(
        expect.objectContaining({ code: "spec_unknown_key" }),
      );
    });

    it("接受每个新字段并将其带入解析后规范（spec_json 承载）", () => {
      const spec = parseWorkflowSpec(readFixture(BRANCHED_SPEC), "branched.yaml");
      expect(spec.steps[0]!.next_hop?.on).toEqual({ failed: "remediate" });
      const gated = parseWorkflowSpec(readFixture(GATED_HUMAN_SPEC), "gated.yaml");
      expect(gated.steps[1]!.gate).toEqual({
        target: "human@kernel",
        summary: "批准发布",
        evidence_ref: "proof/PROOF.md",
      });
      const harness = parseWorkflowSpec(readFixture(HARNESS_SPEC), "harness.yaml");
      expect(harness.steps[0]!.harness).toBe("codex");
    });

    function readFixture(body: string): string {
      return body;
    }
  });

  // ── FR-1：分支语言校验 ─────────────────────────────────────────────

  describe("FR-1 分支校验", () => {
    it("拒绝不存在的分支目标", () => {
      const spec = parseWorkflowSpec(
        BRANCHED_SPEC.replace("on: { failed: remediate }", "on: { failed: nowhere }"),
        "x.yaml",
      );
      const result = new WorkflowValidator().validate(spec);
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === "branch_target_not_found")).toBe(true);
    });

    it("拒绝分支创建但无护栏的循环，并指出 max_hops 修复方案", () => {
      const noGuard = BRANCHED_SPEC.replace("  loop_guards:\n    max_hops: 8\n", "");
      const spec = parseWorkflowSpec(noGuard, "x.yaml");
      const result = new WorkflowValidator().validate(spec);
      expect(result.ok).toBe(false);
      const cycleIssue = result.issues.find((i) => i.code === "cycle_without_max_hops");
      expect(cycleIssue).toBeDefined();
      expect(cycleIssue!.message).toContain("max_hops");
    });

    it("max_hops 允许时，同一个循环校验通过", () => {
      const spec = parseWorkflowSpec(BRANCHED_SPEC, "x.yaml");
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("将仅经分支可达的步骤计为可达（无不可达假阳性）", () => {
      const spec = parseWorkflowSpec(BRANCHED_SPEC, "x.yaml");
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.some((i) => i.code === "step_unreachable")).toBe(false);
    });

    it("resolveNextStep：已映射退出优先；无退出/未映射退出保持结构语义", () => {
      const spec = parseWorkflowSpec(BRANCHED_SPEC, "x.yaml");
      const build = spec.steps[0]!;
      expect(resolveNextStep(spec, build, "failed")?.id).toBe("remediate");
      expect(resolveNextStep(spec, build, "handoff")?.id).toBe("verify");
      expect(resolveNextStep(spec, build)?.id).toBe("verify");
    });
  });

  // ── FR-1：分支执行（唯一引擎扩展）──────────────────────────────────

  describe("FR-1 分支执行", () => {
    async function startBranched(): Promise<{ instanceId: string; entryQitemId: string }> {
      const specPath = writeSpec(tmp, "branched.yaml", BRANCHED_SPEC);
      const result = await runtime.instantiate({
        specPath,
        rootObjective: "分支遍历",
        createdBySession: "ops@rig",
      });
      return { instanceId: result.instance.instanceId, entryQitemId: result.entryQitemId };
    }

    it("已映射的 failed 退出在同一事务中路由到分支目标：创建下一 qitem，实例在目标上保持活跃，轨迹与决策记录分支", async () => {
      const { instanceId, entryQitemId } = await startBranched();
      const before = runtime.instanceStore.getByIdOrThrow(instanceId);
      const result = await runtime.project({
        instanceId,
        currentPacketId: entryQitemId,
        exit: "failed",
        actorSession: "builder@rig",
        resultNote: "构建失败",
      });
      // 已路由，并非终态：
      expect(result.nextQitemId).not.toBeNull();
      expect(result.nextStepId).toBe("remediate");
      expect(result.nextOwnerSession).toBe("fixer@rig");
      const instance = runtime.instanceStore.getByIdOrThrow(instanceId);
      expect(instance.status).toBe("active");
      expect(instance.currentStepId).toBe("remediate");
      expect(instance.currentFrontier).toEqual([result.nextQitemId]);
      // 分支路由就是推进（固定项 2）：hop 与 version 均递增。
      expect(instance.hopCount).toBe(before.hopCount + 1);
      expect(instance.version).toBeGreaterThan(before.version);
      // 数据包保留 failed 的如实关闭形态：
      const closed = queueRepo.getById(entryQitemId);
      expect(closed?.state).toBe("done");
      expect(closed?.closureReason).toBe("denied");
      // 决策与轨迹携带增量的已采用分支记录（固定项 1）：
      expect(instance.lastContinuationDecision?.branchTaken).toBe("remediate");
      const trail = runtime.trailLog.listForInstance(instanceId);
      const row = trail.find((t) => t.priorQitemId === entryQitemId);
      expect(row?.closureReason).toBe("failed");
      expect(row?.closureEvidence).toMatchObject({
        branch_taken: { exit: "failed", target: "remediate" },
      });
      expect(row?.nextQitemId).toBe(result.nextQitemId);
      // 新数据包存在，并发往分支目标所有者：
      const next = queueRepo.getById(result.nextQitemId!);
      expect(next?.destinationSession).toBe("fixer@rig");
      expect(next?.state).toBe("pending");
    });

    it("未映射的 failed 与当前行为完全一致，保持终态（分支路径外零回归）", async () => {
      const specPath = writeSpec(tmp, "linear.yaml", LINEAR_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "反例",
        createdBySession: "ops@rig",
      });
      const result = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "failed",
        actorSession: "builder@rig",
      });
      expect(result.nextQitemId).toBeNull();
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("failed");
      expect(after.currentStepId).toBeNull();
      expect(after.lastContinuationDecision?.branchTaken).toBeNull();
    });

    it("相同实例状态 → 重放时走相同分支：第二次相同 failed 投影被 frontier 护栏拒绝（数据包已路由）", async () => {
      const { instanceId, entryQitemId } = await startBranched();
      await runtime.project({
        instanceId,
        currentPacketId: entryQitemId,
        exit: "failed",
        actorSession: "builder@rig",
      });
      await expect(
        runtime.project({
          instanceId,
          currentPacketId: entryQitemId,
          exit: "failed",
          actorSession: "builder@rig",
        }),
      ).rejects.toMatchObject({ code: "packet_not_on_frontier" });
    });

    it("max_hops 护栏在分支路由上触发（受保护循环在护栏处如实失败，绝不无限运行）", async () => {
      const tight = BRANCHED_SPEC.replace("max_hops: 8", "max_hops: 2");
      const specPath = writeSpec(tmp, "tight.yaml", tight);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "护栏遍历",
        createdBySession: "ops@rig",
      });
      // hop 1：build --failed--> remediate（分支路由）
      const r1 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "failed",
        actorSession: "builder@rig",
      });
      // hop 2：remediate --handoff--> verify（结构路由）
      const r2 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: r1.nextQitemId!,
        exit: "handoff",
        actorSession: "fixer@rig",
      });
      // hop 3 会超过 max_hops=2 → 即使退出已映射到分支，也由引擎生成如实失败。
      const r3 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: r2.nextQitemId!,
        exit: "failed",
        actorSession: "prover@rig",
      });
      expect(r3.closureReason).toBe("failed");
      expect(r3.nextQitemId).toBeNull();
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("failed");
      const trail = runtime.trailLog.listForInstance(instance.instanceId);
      const guardRow = trail.find((t) => t.priorQitemId === r2.nextQitemId);
      expect(guardRow?.closureEvidence).toMatchObject({
        max_hops_guard: { code: "max_hops_exceeded" },
      });
    });
  });

  // ── FR-2：harness 固定 ─────────────────────────────────────────────

  describe("FR-2 harness 固定", () => {
    it("将固定步骤路由到首个运行时匹配的 preferred_target", async () => {
      seedSeat("claude-seat@rig", "claude-code", "n-claude");
      seedSeat("codex-seat@rig", "codex", "n-codex");
      const specPath = writeSpec(tmp, "harness.yaml", HARNESS_SPEC);
      const result = await runtime.instantiate({
        specPath,
        rootObjective: "harness 遍历",
        createdBySession: "ops@rig",
      });
      // 入口步骤固定 codex；claude-seat 在 preferred_targets 中排第一，但 codex-seat
      // 才匹配固定值。
      expect(result.entryOwnerSession).toBe("codex-seat@rig");
      const entry = queueRepo.getById(result.entryQitemId);
      expect(entry?.destinationSession).toBe("codex-seat@rig");
    });

    it("无法满足的固定值明确失败，并指出固定值及每个候选的运行时", async () => {
      seedSeat("claude-seat@rig", "claude-code", "n-claude");
      seedSeat("codex-seat@rig", "claude-code", "n-codex-mislabeled");
      const specPath = writeSpec(tmp, "harness.yaml", HARNESS_SPEC);
      await expect(
        runtime.instantiate({
          specPath,
        rootObjective: "无法满足",
          createdBySession: "ops@rig",
        }),
      ).rejects.toMatchObject({ code: "harness_pin_unsatisfied" });
    });

    it("拒绝违反固定值的显式所有者覆盖（绝不静默绕过固定值）", async () => {
      seedSeat("claude-seat@rig", "claude-code", "n-claude");
      seedSeat("codex-seat@rig", "codex", "n-codex");
      const specPath = writeSpec(tmp, "harness.yaml", HARNESS_SPEC);
      await expect(
        runtime.instantiate({
          specPath,
        rootObjective: "覆盖",
          createdBySession: "ops@rig",
          entryOwnerSession: "claude-seat@rig",
        }),
      ).rejects.toMatchObject({ code: "harness_pin_unsatisfied" });
    });

    it("无固定值步骤仍解析到 preferred_targets[0]（零回归）", async () => {
      const specPath = writeSpec(tmp, "linear.yaml", LINEAR_SPEC);
      const result = await runtime.instantiate({
        specPath,
        rootObjective: "无固定值",
        createdBySession: "ops@rig",
      });
      expect(result.entryOwnerSession).toBe("builder@rig");
    });
  });

  // ── FR-3：host 固定 ─────────────────────────────────────────────────

  describe("FR-3 host 固定", () => {
    it("host:local 的实例化与无固定值完全相同", async () => {
      const local = LINEAR_SPEC.replace(
        "      allowed_exits: [handoff, waiting, done, failed]\n    - id: verify",
        "      allowed_exits: [handoff, waiting, done, failed]\n      host: local\n    - id: verify",
      );
      const specPath = writeSpec(tmp, "local.yaml", local);
      const result = await runtime.instantiate({
        specPath,
        rootObjective: "本地主机",
        createdBySession: "ops@rig",
      });
      expect(result.instance.status).toBe("active");
    });

    it("未知主机 ID 校验失败，并列出已注册 ID", () => {
      const spec = parseWorkflowSpec(
        LINEAR_SPEC.replace(
          "    - id: verify",
          "      host: ghost-host\n    - id: verify",
        ).replace("- id: build\n      actor_role: builder\n      allowed_exits: [handoff, waiting, done, failed]\n      host: ghost-host", "- id: build\n      actor_role: builder\n      allowed_exits: [handoff, waiting, done, failed]\n      host: ghost-host"),
        "x.yaml",
      );
      const result = new WorkflowValidator().validate(spec, undefined, () => ({
        registered: false,
        registeredIds: ["vps-1", "mini-2"],
      }));
      const issue = result.issues.find((i) => i.code === "host_not_registered");
      expect(issue).toBeDefined();
      expect(issue!.message).toContain("vps-1");
    });

    it("已注册远程固定值在实例化时因 MH-3 边界明确失败并给出替代方案，不创建 qitem", async () => {
      const remote = LINEAR_SPEC.replace(
        "      allowed_exits: [handoff, waiting, done, failed]\n    - id: verify",
        "      allowed_exits: [handoff, waiting, done, failed]\n      host: vps-1\n    - id: verify",
      );
      const specPath = writeSpec(tmp, "remote.yaml", remote);
      // 合成 OPENRIG_HOME 注册表（绝非真实远程）：vps-1 确实已注册，因此注册表成员关系
      // 校验通过，随后触发 MH-3 执行边界——证明不会向无法路由的队列创建 qitem，
      // 也不会静默回退到本地。
      const prevHome = process.env.OPENRIG_HOME;
      writeFileSync(
        join(tmp, "hosts.yaml"),
        "hosts:\n  - id: vps-1\n    transport: ssh\n    target: vps-1.invalid\n",
      );
      process.env.OPENRIG_HOME = tmp;
      try {
        const qitemsBefore = db.prepare(`SELECT COUNT(*) as c FROM queue_items`).get() as { c: number };
        await expect(
          runtime.instantiate({
            specPath,
            rootObjective: "远程主机",
            createdBySession: "ops@rig",
          }),
        ).rejects.toMatchObject({ code: "host_pin_remote_unsupported" });
        const qitemsAfter = db.prepare(`SELECT COUNT(*) as c FROM queue_items`).get() as { c: number };
        expect(qitemsAfter.c).toBe(qitemsBefore.c);
        try {
          await runtime.instantiate({ specPath, rootObjective: "远程主机", createdBySession: "ops@rig" });
          expect.unreachable("预期应抛出异常");
        } catch (e) {
          expect((e as Error).message).toContain("MH-3");
          expect((e as Error).message).toContain("local");
        }
      } finally {
        if (prevHome === undefined) delete process.env.OPENRIG_HOME;
        else process.env.OPENRIG_HOME = prevHome;
      }
    });
  });

  // ── FR-5：gate 编译，两种目标类型 ──────────────────────────────────

  describe("FR-5 gate 编译", () => {
    it("人工目标：路由进入受 gate 保护的步骤时，为步骤所有者创建停放在人工席位 blocked_on 上的数据包（summary + evidence_ref），实例等待，发行版 resolve 动词继续流程", async () => {
      const specPath = writeSpec(tmp, "gated-human.yaml", GATED_HUMAN_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "人工 gate",
        createdBySession: "ops@rig",
      });
      const result = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "handoff",
        actorSession: "builder@rig",
      });
      // 护栏阻塞项 1：第 1 段停放形态——数据包属于受 gate 保护步骤的角色所有者，并停放在
      // 人工席位的 blocked_on 上（`zrig queue resolve` 操作的精确形态）——绝不是无法解析的、
      // 发往人工的 pending 条目。
      expect(result.nextOwnerSession).toBe("prover@rig");
      const gateItem = queueRepo.getById(result.nextQitemId!)!;
      expect(gateItem.destinationSession).toBe("prover@rig");
      expect(gateItem.state).toBe("blocked");
      expect(gateItem.blockedOn).toBe("human@kernel");
      expect(gateItem.summary).toBe("批准发布");
      expect(gateItem.evidenceRef).toBe("proof/PROOF.md");
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("waiting");
      expect(after.currentStepId).toBe("signoff");
      expect(after.currentFrontier).toEqual([result.nextQitemId]);

      // 连续性证明：发行版 resolve 动词解除 gate 条目的停放；随后步骤所有者继续投影，
      // 流程完成——无需重启，也无需新机制。
      const writeContract = new MissionControlWriteContract({
        db,
        eventBus: bus,
        queueRepo,
        actionLog: new MissionControlActionLog(db),
      });
      await writeContract.act({
        verb: "resolve",
        qitemId: result.nextQitemId!,
        actorSession: "human@kernel",
        decision: "已批准——可以发布",
      });
      const resolved = queueRepo.getById(result.nextQitemId!)!;
      expect(resolved.state).toBe("in-progress");
      const done = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: result.nextQitemId!,
        exit: "done",
        actorSession: "prover@rig",
      });
      expect(done.nextQitemId).toBeNull();
      const finished = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(finished.status).toBe("completed");
    });

    it("处理者角色目标：路由进入受 gate 保护的步骤时，将普通智能体条目路由到处理者席位，并带轨迹证据进入等待", async () => {
      const specPath = writeSpec(tmp, "gated-handler.yaml", GATED_HANDLER_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "处理者 gate",
        createdBySession: "ops@rig",
      });
      const result = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "handoff",
        actorSession: "builder@rig",
      });
      expect(result.nextOwnerSession).toBe("checker@rig");
      const gateItem = queueRepo.getById(result.nextQitemId!);
      expect(gateItem?.destinationSession).toBe("checker@rig");
      // 普通智能体条目——不强制走人工路径：
      expect(gateItem?.tier).not.toBe("human-gate");
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("waiting");
      const trail = runtime.trailLog.listForInstance(instance.instanceId);
      expect(trail.find((t) => t.priorQitemId === entryQitemId)?.nextQitemId).toBe(
        result.nextQitemId,
      );
    });

    it("rev1-r2 阻塞项：处理者 gate 步骤上的 harness 固定绑定处理者席位——路由到首个运行时匹配目标，绝不盲选 preferred_targets[0]", async () => {
      seedSeat("claude-check@rig", "claude-code", "n-cc");
      seedSeat("codex-check@rig", "codex", "n-cx");
      const specPath = writeSpec(tmp, "gated-handler-pinned.yaml", GATED_HANDLER_PINNED_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "固定处理者 gate",
        createdBySession: "ops@rig",
      });
      const result = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "handoff",
        actorSession: "builder@rig",
      });
      // claude-check@rig 在 preferred_targets 中排第一，但步骤固定 codex——必须由 codex
      // 席位胜出。
      expect(result.nextOwnerSession).toBe("codex-check@rig");
      expect(queueRepo.getById(result.nextQitemId!)?.destinationSession).toBe("codex-check@rig");
    });

    it("rev1-r2 阻塞项：处理者 gate 步骤上无法满足的固定值在实例化时明确失败，并指出固定值与候选（静态循环覆盖受 gate 保护步骤）", async () => {
      seedSeat("claude-check@rig", "claude-code", "n-cc");
      seedSeat("codex-check@rig", "claude-code", "n-cx-mislabeled");
      const specPath = writeSpec(tmp, "gated-handler-pinned.yaml", GATED_HANDLER_PINNED_SPEC);
      await expect(
        runtime.instantiate({
          specPath,
          rootObjective: "无法满足的固定处理者 gate",
          createdBySession: "ops@rig",
        }),
      ).rejects.toMatchObject({ code: "harness_pin_unsatisfied" });
      try {
        await runtime.instantiate({ specPath, rootObjective: "x", createdBySession: "ops@rig" });
        expect.unreachable("预期应抛出异常");
      } catch (e) {
        expect((e as Error).message).toContain("codex");
        expect((e as Error).message).toContain("claude-check@rig");
      }
    });

    it("gate 目标既非人工席位也非已声明角色时明确校验失败", () => {
      const spec = parseWorkflowSpec(
        GATED_HANDLER_SPEC.replace("target: checker", "target: nobody-anywhere"),
        "x.yaml",
      );
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.some((i) => i.code === "gate_target_unresolved")).toBe(true);
    });

    it("人工 gate 缺少 summary/evidence_ref 时校验失败（在编写时失败，而非运行中途）", () => {
      const spec = parseWorkflowSpec(
        GATED_HUMAN_SPEC.replace("        evidence_ref: proof/PROOF.md\n", ""),
        "x.yaml",
      );
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.some((i) => i.code === "gate_human_fields_missing")).toBe(true);
    });
  });

  // ── FR-4 + 零回归主干 ──────────────────────────────────────────────

  describe("FR-4 处置 + BR-3 零回归", () => {
    it("每个发行版内建规范仍能解析并通过校验（无错误拒绝）", () => {
      const builtinDir = join(__dirname, "..", "src", "builtins", "workflow-specs");
      for (const name of [
        "conveyor.yaml",
        "basic-loop.yaml",
        "linear-build.yaml",
        "gated-release.yaml",
        "branched-remediation.yaml",
      ]) {
        const raw = readFileSync(join(builtinDir, name), "utf-8");
        const spec = parseWorkflowSpec(raw, name);
        const result = new WorkflowValidator().validate(spec);
        expect(
          result.issues.filter((i) => i.severity === "error"),
          `${name} 应没有校验错误`,
        ).toEqual([]);
      }
    });

    it("skill_refs 仍产生失败开放且明确标注 v2 的建议（warning、ok=true）", () => {
      const raw = readFileSync(
        join(__dirname, "..", "src", "builtins", "workflow-specs", "conveyor.yaml"),
        "utf-8",
      );
      const spec = parseWorkflowSpec(raw, "conveyor.yaml");
      const result = new WorkflowValidator().validate(spec);
      expect(result.ok).toBe(true);
      expect(
        result.issues.some(
          (i) => i.code === "declared_not_enforced_v1" && i.severity === "warning",
        ),
      ).toBe(true);
    });

    it("不含 WF-2 功能的规范以逐字节一致方式路由：所有者、关闭形态和状态均相同", async () => {
      const specPath = writeSpec(tmp, "linear.yaml", LINEAR_SPEC);
      const { instance, entryQitemId } = await runtime.instantiate({
        specPath,
        rootObjective: "回归主干",
        createdBySession: "ops@rig",
      });
      const r1 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: entryQitemId,
        exit: "handoff",
        actorSession: "builder@rig",
      });
      expect(r1.nextOwnerSession).toBe("prover@rig");
      expect(queueRepo.getById(entryQitemId)?.closureReason).toBe("handed_off_to");
      const r2 = await runtime.project({
        instanceId: instance.instanceId,
        currentPacketId: r1.nextQitemId!,
        exit: "done",
        actorSession: "prover@rig",
      });
      expect(r2.nextQitemId).toBeNull();
      const after = runtime.instanceStore.getByIdOrThrow(instance.instanceId);
      expect(after.status).toBe("completed");
    });
  });
});
