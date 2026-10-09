import { describe, it, expect } from "vitest";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";
import type { WorkflowSpec } from "../src/domain/workflow-types.js";

function spec(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    id: "test",
    version: "1",
    objective: "Test workflow",
    target: { rig: "test-rig" },
    entry: { role: "producer" },
    roles: {
      producer: { preferred_targets: ["producer@rig"] },
      reviewer: { preferred_targets: ["reviewer@rig"] },
    },
    steps: [
      { id: "produce", actor_role: "producer", allowed_exits: ["handoff"] },
      { id: "review", actor_role: "reviewer", allowed_exits: ["done"] },
    ],
    invariants: { allowed_exits: ["handoff", "waiting", "done"] },
    ...overrides,
  };
}

describe("WorkflowValidator（PL-004 Phase D）", () => {
  const validator = new WorkflowValidator();

  it("有效 spec 返回 ok=true", () => {
    const result = validator.validate(spec());
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.summary.workflowId).toBe("test");
    expect(result.summary.stepCount).toBe(2);
    expect(result.summary.entryRole).toBe("producer");
  });

  it.each([undefined, 100])("rejects a prerequisite cycle even with max_hops=%s", (maxHops) => {
    const result = validator.validate(spec({
      steps: [
        { id: "produce", actor_role: "producer", depends_on: [] },
        { id: "review", actor_role: "reviewer", depends_on: ["produce", "ship"] },
        { id: "ship", actor_role: "producer", depends_on: ["review"] },
      ],
      loop_guards: maxHops === undefined ? undefined : { max_hops: maxHops },
    }));
    expect(result.ok).toBe(false);
    expect(result.issues.find((issue) => issue.code === "dependency_cycle")).toMatchObject({
      severity: "error", field: "workflow.steps",
      message: expect.stringContaining("review → ship → review"),
    });
    expect(result.issues.some((issue) => issue.code === "cycle_without_max_hops")).toBe(false);
  });

  it("发现 entry 可达组件之外的 prerequisite 环", () => {
    const result = validator.validate(spec({
      steps: [
        { id: "produce", actor_role: "producer", depends_on: [] },
        { id: "review", actor_role: "reviewer", depends_on: ["ship"] },
        { id: "ship", actor_role: "producer", depends_on: ["review"] },
      ],
      loop_guards: { max_hops: 100 },
    }));
    expect(result.issues.some((issue) => issue.code === "dependency_cycle")).toBe(true);
  });

  it.each([undefined, 100])("keeps routing-loop guard semantics with acyclic prerequisites, max_hops=%s", (maxHops) => {
    const result = validator.validate(spec({
      steps: [
        { id: "produce", actor_role: "producer", depends_on: [] },
        { id: "review", actor_role: "reviewer", depends_on: ["produce"], next_hop: { on: { failed: "produce" } } },
      ],
      loop_guards: maxHops === undefined ? undefined : { max_hops: maxHops },
    }));
    expect(result.ok).toBe(maxHops !== undefined);
    expect(result.issues.some((issue) => issue.code === "dependency_cycle")).toBe(false);
    expect(result.issues.some((issue) => issue.code === "cycle_without_max_hops")).toBe(maxHops === undefined);
  });

  it("不会把缺失的 prerequisite 误标为环", () => {
    const result = validator.validate(spec({
      steps: [{ id: "produce", actor_role: "producer", depends_on: ["missing"] }],
    }));
    expect(result.issues.some((issue) => issue.code === "dependency_step_not_found")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "dependency_cycle")).toBe(false);
  });

  it("entry.role 不在 roles 中时返回 entry_role_not_declared", () => {
    const result = validator.validate(spec({ entry: { role: "ghost" } }));
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "entry_role_not_declared")).toBeDefined();
  });

  it("step 引用未声明角色时返回 step_actor_role_not_declared", () => {
    const result = validator.validate(
      spec({
        steps: [{ id: "produce", actor_role: "ghost", allowed_exits: ["handoff"] }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_actor_role_not_declared")).toBeDefined();
  });

  it("两个 step 共用 id 时返回 step_id_duplicate", () => {
    const result = validator.validate(
      spec({
        steps: [
          { id: "x", actor_role: "producer", allowed_exits: ["handoff"] },
          { id: "x", actor_role: "reviewer", allowed_exits: ["done"] },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_id_duplicate")).toBeDefined();
  });

  it("step exit 不在 invariants.allowed_exits 中时返回 step_exit_not_allowed", () => {
    const result = validator.validate(
      spec({
        invariants: { allowed_exits: ["done"] },
        steps: [{ id: "produce", actor_role: "producer", allowed_exits: ["handoff"] }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_exit_not_allowed")).toBeDefined();
  });

  it("step 没有 id 时返回 step_id_missing", () => {
    const result = validator.validate(
      spec({
        steps: [{ id: "", actor_role: "producer" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_id_missing")).toBeDefined();
  });

  it("step 没有 actor_role 时返回 step_actor_role_missing", () => {
    const result = validator.validate(
      spec({
        steps: [{ id: "x", actor_role: "" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.code === "step_actor_role_missing")).toBeDefined();
  });

  it("角色的 preferred_targets 全部死亡时发出席位 liveness 警告", () => {
    const result = validator.validate(spec(), () => ({ alive: false, reason: "no session" }));
    expect(result.ok).toBe(true); // warnings don't fail
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings.find((w) => w.code === "role_no_live_preferred_target")).toBeDefined();
  });

  it("至少一个 preferred_target 存活时不发出席位 liveness 警告", () => {
    const result = validator.validate(spec(), () => ({ alive: true }));
    expect(result.issues.filter((i) => i.code === "role_no_live_preferred_target")).toEqual([]);
  });
});
