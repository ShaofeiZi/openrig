import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

// OPR.0.4.6.FAC1 commit 2——instance 在 instantiation 时绑定到 rig
//（AC-1；ARCH Q4；migration 052）。
//
// 绑定契约：
//   effective = input.targetRig ?? spec.target.rig ?? null
//   - spec 的 target.rig 是 DEFAULT，instantiate 参数可覆盖；
//   - null = unbound = 与 FAC-1 之前 byte 一致；
//   - 命名 rig 必须在 instantiate 时 EXIST（`bound_rig_unknown`，loud、结构化、
//     在任何 mutation 之前——不创建 instance 行）；
//   - 绑定把 rig NAME（Q4：持久 operator-space 坐标）持久化到
//     workflow_instances.bound_rig。

const SPEC_WITH_DEFAULT = `workflow:
  id: fac1-default-rig
  version: 1
  objective: bound-rig default test
  target:
    rig: factory-a
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - dev-worker@rig
  steps:
    - id: act
      actor_role: worker
      allowed_exits:
        - handoff
        - done
`;

const SPEC_NO_TARGET = `workflow:
  id: fac1-no-target
  version: 1
  objective: unbound test
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - dev-worker@rig
  steps:
    - id: act
      actor_role: worker
      allowed_exits:
        - done
`;


describe("FAC-1 C2：workflow instance 绑定 rig（migration 052）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let defaultSpecPath: string;
  let noTargetSpecPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    // 已注册 rig：spec 默认（factory-a）、override 目标（factory-b）、
    // worker@rig 的 queue-destination rig。
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-a', 'factory-a')`).run();
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-b', 'factory-b')`).run();
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    // 全 schema fixture 真实性（P13）：在 SHIPPED migration 列表下 member-existence probe
    // 工作正常（旧 subset schema 让它 error 并 skip——静默压制 advisory）。种子 spec 命名的
    // member，使 no-advisory 断言测它们一直想测的东西。
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('n-w', 'r-1', 'dev.worker', 'claude-code')`).run();
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-w', 'n-w', 'dev-worker@rig', 'running')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    tmp = mkdtempSync(join(tmpdir(), "wf-boundrig-"));
    defaultSpecPath = join(tmp, "default-rig.yaml");
    writeFileSync(defaultSpecPath, SPEC_WITH_DEFAULT);
    noTargetSpecPath = join(tmp, "no-target.yaml");
    writeFileSync(noTargetSpecPath, SPEC_NO_TARGET);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function boundRigColumn(instanceId: string): string | null {
    const row = db
      .prepare(`SELECT bound_rig FROM workflow_instances WHERE instance_id = ?`)
      .get(instanceId) as { bound_rig: string | null } | undefined;
    expect(row).toBeDefined();
    return row!.bound_rig;
  }

  it("default-from-spec：无 override → boundRig = spec target.rig，按 NAME 持久化", async () => {
    const result = await runtime.instantiate({
      specPath: defaultSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
    });
    expect(result.instance.boundRig).toBe("factory-a");
    expect(boundRigColumn(result.instance.instanceId)).toBe("factory-a");
    // 可解析的 spec 默认干净绑定——无 advisory。
    expect(result.advisories).toEqual([]);
  });

  it("override-wins：instantiate targetRig 胜过 spec 默认（default-with-override，AC-1）", async () => {
    const result = await runtime.instantiate({
      specPath: defaultSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
      targetRig: "factory-b",
    });
    expect(result.instance.boundRig).toBe("factory-b");
    expect(boundRigColumn(result.instance.instanceId)).toBe("factory-b");
  });

  it("null-unbound：无 spec 默认且无 override → boundRig null（今日行为 byte 一致）", async () => {
    const result = await runtime.instantiate({
      specPath: noTargetSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
    });
    expect(result.instance.boundRig).toBeNull();
    expect(boundRigColumn(result.instance.instanceId)).toBeNull();
    // unbound 且无坏默认——无 advisory。
    expect(result.advisories).toEqual([]);
  });

  // AUTHORITATIVE-PATH NEGATIVE（guard-critical，arch 裁决 2026-07-07）：
  // 显式运维 `--rig X`（input.targetRig）是 authoritative——未知 X HARD-FAIL
  // `bound_rig_unknown`，绝不进入 spec-default degrade 分支。这是窄 guard confirm
  // 检查的命名负例（provenance split 不得软化显式要求）。与下方 spec-default degrade
  // 测试对照。
  it("显式 --rig 未知仍在任何 mutation 之前 hard-fail bound_rig_unknown（绝不 degrade）", async () => {
    const before = db.prepare(`SELECT COUNT(*) as c FROM workflow_instances`).get() as { c: number };
    let thrown: unknown;
    try {
      await runtime.instantiate({
        specPath: noTargetSpecPath,
        rootObjective: "test",
        createdBySession: "orch@rig",
        targetRig: "no-such-rig",
      });
    } catch (err) {
      thrown = err;
    }
    // 它 THROW（未退化为带 advisory 的 unbound 结果）。
    expect(thrown).toBeInstanceOf(WorkflowProjectorError);
    const e = thrown as WorkflowProjectorError;
    expect(e.code).toBe("bound_rig_unknown");
    // what/why/fix 契约：命名 rig，列出已注册 rig。
    expect(e.message).toContain("no-such-rig");
    expect(e.message).toContain("factory-a");
    expect((e.details?.["registeredRigs"] as string[]) ?? []).toContain("factory-b");
    // 未创建 instance 行（validation-before-mutation）。
    const after = db.prepare(`SELECT COUNT(*) as c FROM workflow_instances`).get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  // 反向也守卫：显式 --rig 存在，而 spec 默认坏时，绑定到显式 rig 且不发 advisory
  //（显式要求被遵守；坏默认无意义）。
  it("显式 --rig（已知）覆盖坏 spec 默认时显式绑定，无 advisory", async () => {
    const badSpecPath = join(tmp, "bad-default-explicit.yaml");
    writeFileSync(badSpecPath, SPEC_WITH_DEFAULT.replace("rig: factory-a", "rig: vanished-rig"));
    const result = await runtime.instantiate({
      specPath: badSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
      targetRig: "factory-b",
    });
    expect(result.instance.boundRig).toBe("factory-b");
    expect(result.advisories).toEqual([]);
  });

  // OPR.0.4.6.FAC1 arch 裁决 2026-07-07（target-rig zero-regression，
  // "Option A refined by PROVENANCE"）：未知 SPEC-DEFAULT target.rig 是 ADVISORY，
  // 不是 authoritative——它 DEGRADE 到 unbound 并带 loud advisory，而非 hard-fail。
  //（此前在此断言的行为是 AC-1 zero-regression 违规：shipped builtins 如 `conveyor`
  // 声明 target.rig 且经 preferred_targets 路由，所以对默认 hard-fail 会让 shipped spec 的
  // instantiate 回归。）显式 `--rig` 路径保留 hard-fail——见上面 authoritative-negative 测试。
  // SPEC_WITH_DEFAULT 声明 preferred_targets: [worker@rig] 且 `rig` 已注册，
  // 故 unbound instance 仍能路由并成功。
  it("spec 默认未知 DEGRADE 到 unbound + LOUD advisory（advisory provenance，不是 hard-fail）", async () => {
    const badSpecPath = join(tmp, "bad-default.yaml");
    writeFileSync(badSpecPath, SPEC_WITH_DEFAULT.replace("rig: factory-a", "rig: vanished-rig"));
    const before = db.prepare(`SELECT COUNT(*) as c FROM workflow_instances`).get() as { c: number };
    const result = await runtime.instantiate({
      specPath: badSpecPath,
      rootObjective: "test",
      createdBySession: "orch@rig",
    });
    // 退到 unbound（经 preferred_targets 路由——对带描述性 target.rig 的 spec，与 FAC-1
    // 之前 byte 一致）。
    expect(result.instance.boundRig).toBeNull();
    expect(boundRigColumn(result.instance.instanceId)).toBeNull();
    // advisory 真正 LOUD（守卫不变量）：命名缺席的默认 rig 以及 unbound 后果——绝不静默。
    expect(result.advisories.length).toBeGreaterThan(0);
    const advisory = result.advisories.join(" ");
    expect(advisory).toContain("vanished-rig");
    expect(advisory).toContain("UNBOUND");
    // instance 已创建（degrade，不是 fail）。
    const after = db.prepare(`SELECT COUNT(*) as c FROM workflow_instances`).get() as { c: number };
    expect(after.c).toBe(before.c + 1);
  });

  it("legacy-fixture degrade：无 migration 052 时 store 的列探针保留 legacy INSERT（boundRig 读 null，不崩）", () => {
    const legacyDb = createDb();
    migrate(legacyDb, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
    ]);
    const store = new WorkflowInstanceStore(legacyDb);
    const instance = store.create({
      workflowName: "legacy",
      workflowVersion: "1",
      createdBySession: "orch@rig",
      boundRig: "factory-a", // 052 之前静默未跟踪——探针 degrade
    });
    expect(instance.boundRig).toBeNull();
    legacyDb.close();
  });
});
