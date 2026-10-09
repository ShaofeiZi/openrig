// OPR.0.4.6.WF1 FR-8（G6）+ FR-9（G8）。
//
// FR-8：`continue` 标签与实际接线必须诚实一致。重新命名后，CLI 描述、route 注释和行为
// 都明确表示只读检视语义，`project` 仍是唯一的推进写入路径（BR-2）。测试同时覆盖描述行为
//（源码文本不包含推进措辞）和实际行为（两次 continue 调用不产生任何变更）。
//
// FR-9：每个已声明但尚未执行的 spec key 都产生 fail-open 的
// `declared_not_enforced_v1` advisory（warning，ok 保持 true），不存在静默的第三种状态。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";

const SPEC = `workflow:
  id: fr8-honesty
  version: 1
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
    - id: follow
      actor_role: next
      allowed_exits:
        - done
`;

describe("FR-8：continue 是诚实的只读检视器，标签与实际接线一致", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
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
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    tmp = mkdtempSync(join(tmpdir(), "wf-honesty-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("接线：两次 continue 返回相同状态且不改变任何内容（version、trail、frontier、queue 均不变）", async () => {
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "honesty walk",
      createdBySession: "ops@rig",
    });
    const before = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    const qitemCountBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }
    ).n;

    const first = runtime.continue(inst.instance.instanceId);
    const second = runtime.continue(inst.instance.instanceId);
    expect(second.instance).toEqual(first.instance);
    expect(second.trail).toEqual(first.trail);

    const after = runtime.instanceStore.getByIdOrThrow(inst.instance.instanceId);
    expect(after.version).toBe(before.version);
    expect(after.currentFrontier).toEqual(before.currentFrontier);
    expect(after.status).toBe(before.status);
    expect(runtime.trailLog.countForInstance(inst.instance.instanceId)).toBe(0);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n,
    ).toBe(qitemCountBefore);
  });

  it("标签：CLI 命令描述与 route 注释表达检视语义，不声称机械推进", () => {
    const cliSource = readFileSync(
      join(__dirname, "..", "..", "cli", "src", "commands", "workflow.ts"),
      "utf-8",
    );
    // 旧的误导性描述已移除……
    expect(cliSource).not.toContain("Mechanically advance an instance");
    expect(cliSource).not.toContain("Advanced instance ${instanceId}");
    // ……且保留诚实的标签与 project() 指引。
    expect(cliSource).toContain(
      "检视实例当前前沿 + 步骤轨迹（只读",
    );
    expect(cliSource).toContain("zrig workflow project");

    const routeSource = readFileSync(
      join(__dirname, "..", "src", "routes", "workflow.ts"),
      "utf-8",
    );
    expect(routeSource).toContain("continue  inspect（幂等）");
  });
});

describe("FR-9：每个未生效 key 都产生 fail-open 的 declared_not_enforced_v1 提示，不静默忽略配置", () => {
  function advisoriesFor(yaml: string) {
    const spec = parseWorkflowSpec(yaml, "test://fr9.yaml");
    const result = new WorkflowValidator().validate(spec);
    return {
      result,
      advisories: result.issues.filter((i) => i.code === "declared_not_enforced_v1"),
    };
  }

  it("使用全部 v2 key 的规范按 key 类别各获一条提示，均为 warning，ok 保持 true", () => {
    const yaml = `workflow:
  id: fr9-all
  version: 1
  roles:
    worker:
      skill_refs: [some-skill]
      preferred_targets:
        - worker@rig
  steps:
    - id: only
      actor_role: worker
      allowed_exits:
        - done
  invariants:
    continuation_required: true
    preserve_lineage: true
    closure_required: true
    allowed_exits: [handoff, waiting, done, failed]
  closure:
    success: done well
  loop_guards:
    max_hops: 5
    spawn_budget: 2
`;
    const { result, advisories } = advisoriesFor(yaml);
    expect(result.ok).toBe(true); // fail-open：warning 永不阻塞。
    const advisedKeys = advisories.map((a) => a.message.split('"')[1]);
    expect(advisedKeys).toContain("invariants.continuation_required");
    expect(advisedKeys).toContain("invariants.preserve_lineage");
    expect(advisedKeys).toContain("invariants.closure_required");
    expect(advisedKeys).toContain("closure.{success,degraded,failed}");
    expect(advisedKeys).toContain("loop_guards.spawn_budget");
    expect(advisedKeys).toContain("skill_refs");
    // OPR.0.4.6.WF2：gates[] 与 next_hop.mode "prefer" 已从 advisory 升级为解析时
    // 移除（spec_gates_removed / spec_prefer_mode_removed），由
    // workflow-wf2-spec-language.test.ts 覆盖。
    for (const a of advisories) expect(a.severity).toBe("warning");
    // spawn_budget 的 advisory 点明 WF-2/WF-6 验收指引。
    const spawn = advisories.find((a) => a.message.includes("spawn_budget"))!;
    expect(spawn.message).toContain("parallel-frontier");
  });

  it("只使用已消费 key（max_hops、preferred_targets、allowed_exits）的规范不产生提示", () => {
    const yaml = `workflow:
  id: fr9-clean
  version: 1
  roles:
    worker:
      preferred_targets:
        - worker@rig
  steps:
    - id: only
      actor_role: worker
      allowed_exits:
        - done
  invariants:
    allowed_exits: [handoff, waiting, done, failed]
  loop_guards:
    max_hops: 5
`;
    const { advisories } = advisoriesFor(yaml);
    expect(advisories).toEqual([]);
  });
});
