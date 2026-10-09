// Slice Story View v1——workflow_spec → 逐 tab 投影辅助函数。
//
// 固定以下关键行为：
//   - projectSpecGraph：节点来自 spec.steps；边来自各 step 的 next_hop.suggested_roles；
//     isCurrent / isEntry / isTerminal 标记；按声明的 step 顺序检测回环
//   - projectPhaseDefinitions：按声明顺序为每个 spec step 生成一个带 role 标签的条目
//   - projectCurrentStep：解析 current_step_id；allowed_exits + next_hop suggested_roles
//     → allowed_next_steps；current_step_id 为 null 或无法解析时返回 null

import { describe, it, expect } from "vitest";
import type { WorkflowSpec } from "../src/domain/workflow-types.js";
import {
  projectSpecGraph,
  projectPhaseDefinitions,
  projectCurrentStep,
} from "../src/domain/workflow/slice-workflow-projection.js";

const RSI_LIKE_SPEC: WorkflowSpec = {
  id: "test-loop",
  version: "1",
  objective: "测试",
  entry: { role: "discovery-router" },
  invariants: { allowed_exits: ["handoff", "waiting", "done", "failed"] },
  roles: {
    "discovery-router": { preferred_targets: ["intake@r"] },
    "product-lab-planner": { preferred_targets: ["planner@r"] },
    "delivery-driver": { preferred_targets: ["driver@r"] },
    "qa-tester": { preferred_targets: ["qa@r"] },
  },
  steps: [
    {
      id: "discovery", actor_role: "discovery-router", objective: "确定候选范围",
      allowed_exits: ["handoff", "waiting", "failed"],
      next_hop: { suggested_roles: ["product-lab-planner"] },
    },
    {
      id: "product-lab", actor_role: "product-lab-planner", objective: "塑造 slice",
      allowed_exits: ["handoff", "waiting", "failed"],
      next_hop: { suggested_roles: ["delivery-driver"] },
    },
    {
      id: "delivery", actor_role: "delivery-driver", objective: "实现",
      allowed_exits: ["handoff", "waiting", "failed"],
      next_hop: { suggested_roles: ["qa-tester"] },
    },
    {
      id: "qa", actor_role: "qa-tester", objective: "dogfood + 修复循环",
      allowed_exits: ["handoff", "done", "waiting", "failed"],
      // 回环边——qa 可交还给 discovery 以跟进信号。
      next_hop: { suggested_roles: ["discovery-router"] },
    },
  ],
};

describe("PL-slice-story-view-v1 projectSpecGraph", () => {
  it("按声明顺序为每个 step 生成一个节点", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.nodes.map((n) => n.stepId)).toEqual(["discovery", "product-lab", "delivery", "qa"]);
  });

  it("在 payload 上派生 spec 名称与版本", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.specName).toBe("test-loop");
    expect(g.specVersion).toBe("1");
  });

  it("为每对（step、next_hop 建议 role）生成一条边，并把 role 解析回 step id", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.edges).toEqual([
      { fromStepId: "discovery", toStepId: "product-lab", routingType: "direct", isLoopBack: false },
      { fromStepId: "product-lab", toStepId: "delivery", routingType: "direct", isLoopBack: false },
      { fromStepId: "delivery", toStepId: "qa", routingType: "direct", isLoopBack: false },
      { fromStepId: "qa", toStepId: "discovery", routingType: "direct", isLoopBack: true },
    ]);
  });

  it("在 spec.entry step 上标记 isEntry（按 role 解析）", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.nodes.find((n) => n.stepId === "discovery")?.isEntry).toBe(true);
    expect(g.nodes.find((n) => n.stepId === "delivery")?.isEntry).toBe(false);
  });

  it("只为指定的 current_step_id 标记 isCurrent", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, "delivery");
    expect(g.nodes.find((n) => n.stepId === "delivery")?.isCurrent).toBe(true);
    expect(g.nodes.find((n) => n.stepId === "discovery")?.isCurrent).toBe(false);
    expect(g.nodes.filter((n) => n.isCurrent)).toHaveLength(1);
  });

  it("有 next_hop 建议的 step 标记 isTerminal=false，否则为 true", () => {
    const allHopSpec: WorkflowSpec = {
      ...RSI_LIKE_SPEC,
      steps: [
        { id: "step-a", actor_role: "discovery-router", allowed_exits: ["handoff"], next_hop: { suggested_roles: ["product-lab-planner"] } },
        { id: "step-b", actor_role: "product-lab-planner", allowed_exits: ["done"] },
      ],
    };
    const g = projectSpecGraph(allHopSpec, null);
    expect(g.nodes.find((n) => n.stepId === "step-a")?.isTerminal).toBe(false);
    expect(g.nodes.find((n) => n.stepId === "step-b")?.isTerminal).toBe(true);
  });

  it("从 role 的首个 preferred_targets 条目填充 preferredTarget", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.nodes.find((n) => n.stepId === "discovery")?.preferredTarget).toBe("intake@r");
    expect(g.nodes.find((n) => n.stepId === "qa")?.preferredTarget).toBe("qa@r");
  });

  it("role 没有 preferred_targets 时 preferredTarget 为 null", () => {
    const noTargetSpec: WorkflowSpec = {
      ...RSI_LIKE_SPEC,
      roles: { "x": {} },
      steps: [{ id: "s1", actor_role: "x", allowed_exits: ["done"] }],
    };
    const g = projectSpecGraph(noTargetSpec, null);
    expect(g.nodes[0]!.preferredTarget).toBeNull();
  });

  it("v1 例外：每条边均携带 routingType=direct（Phase D 尚无 routing_type 字段）", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    for (const edge of g.edges) {
      expect(edge.routingType).toBe("direct");
    }
  });
});

describe("PL-slice-story-view-v1 projectPhaseDefinitions", () => {
  it("按声明顺序为每个 step 生成一个 phase", () => {
    const phases = projectPhaseDefinitions(RSI_LIKE_SPEC);
    expect(phases.map((p) => p.id)).toEqual(["discovery", "product-lab", "delivery", "qa"]);
  });

  it("phase label = step.actor_role", () => {
    const phases = projectPhaseDefinitions(RSI_LIKE_SPEC);
    expect(phases.find((p) => p.id === "discovery")?.label).toBe("discovery-router");
    expect(phases.find((p) => p.id === "qa")?.label).toBe("qa-tester");
  });
});

describe("PL-slice-story-view-v1 projectCurrentStep", () => {
  it("current_step_id 为 null（终态 instance）时返回 null", () => {
    expect(projectCurrentStep(RSI_LIKE_SPEC, null, 5, "completed")).toBeNull();
  });

  it("current_step_id 无法在 spec 中解析时返回 null", () => {
    expect(projectCurrentStep(RSI_LIKE_SPEC, "step-from-different-spec", 1, "active")).toBeNull();
  });

  it("为 spec 内当前 step 返回 step metadata + allowed_next_steps", () => {
    const cs = projectCurrentStep(RSI_LIKE_SPEC, "delivery", 3, "active");
    expect(cs).not.toBeNull();
    expect(cs!.stepId).toBe("delivery");
    expect(cs!.role).toBe("delivery-driver");
    expect(cs!.objective).toBe("实现");
    expect(cs!.allowedExits).toEqual(["handoff", "waiting", "failed"]);
    expect(cs!.allowedNextSteps).toEqual([
      { stepId: "qa", role: "qa-tester", reason: "next_hop" },
    ]);
    expect(cs!.hopCount).toBe(3);
    expect(cs!.instanceStatus).toBe("active");
  });

  it("step 没有 next_hop（终态）时 allowedNextSteps 为空", () => {
    const terminalSpec: WorkflowSpec = {
      ...RSI_LIKE_SPEC,
      steps: [
        { id: "only", actor_role: "discovery-router", allowed_exits: ["done"] },
      ],
    };
    const cs = projectCurrentStep(terminalSpec, "only", 0, "active");
    expect(cs!.allowedNextSteps).toEqual([]);
  });

  it("qa step 的 allowedNextSteps 包含回到 discovery 的回环", () => {
    const cs = projectCurrentStep(RSI_LIKE_SPEC, "qa", 4, "active");
    expect(cs!.allowedNextSteps).toEqual([
      { stepId: "discovery", role: "discovery-router", reason: "next_hop" },
    ]);
  });
});
