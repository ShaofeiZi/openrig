// OPR.0.4.6.WF1 FR-7（G7）：解析严格性 + 图校验。
//
//   - 每一层的未知 key 都会在解析时针对导出的封闭 keyset 显著失败，并说明 what/why/fix
//     （WF-2 会扩展这些 keyset）；
//   - next_hop.suggested_roles 指向未声明 role，或没有 step 满足的 role 时显著失败；
//   - 不可达 step 显著失败（从 entry 开始做确定性单后继遍历，直接使用 projector 自己导出的
//     resolveNextStep——绝不并行重新实现）；
//   - 不带 max_hops 的 cycle 失败并说明修复方法；带 max_hops 时通过校验（FR-6 允许）；
//   - 无误拒绝负向控制：随附的两个内置 starter spec 仍能干净解析并通过校验。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseWorkflowSpec,
  WorkflowSpecError,
  WORKFLOW_TOP_LEVEL_KEYS,
  WORKFLOW_STEP_KEYS,
} from "../src/domain/workflow-spec-cache.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";

const BASE = `workflow:
  id: strictness
  version: 1
  entry:
    role: worker
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
      next_hop:
        suggested_roles:
          - next
    - id: follow
      actor_role: next
      allowed_exits:
        - done
`;

function validateYaml(yaml: string) {
  const spec = parseWorkflowSpec(yaml, "test://strictness.yaml");
  return new WorkflowValidator().validate(spec);
}

describe("FR-7 解析严格性：每一层的未知 key 都显著失败", () => {
  const CASES: Array<{ label: string; yaml: string; key: string; path: string }> = [
    {
      label: "top-level",
      yaml: BASE.replace("  roles:", "  retry_policy: aggressive\n  roles:"),
      key: "retry_policy",
      path: "workflow",
    },
    {
      label: "step-level",
      // OPR.0.4.6.WF2：`harness` 已成为合法 step key——未知 key 示例现在使用其拼写错误。
      yaml: BASE.replace("      actor_role: worker", "      actor_role: worker\n      harnesss: codex"),
      key: "harnesss",
      path: "workflow.steps[0]",
    },
    {
      label: "role-level",
      yaml: BASE.replace(
        "      preferred_targets:\n        - worker@rig",
        "      fallback: none\n      preferred_targets:\n        - worker@rig",
      ),
      key: "fallback",
      path: "workflow.roles.worker",
    },
    {
      label: "next_hop-level",
      yaml: BASE.replace(
        "      next_hop:\n        suggested_roles:",
        "      next_hop:\n        on_failure: retry\n        suggested_roles:",
      ),
      key: "on_failure",
      path: "workflow.steps[0].next_hop",
    },
    {
      label: "entry-level",
      yaml: BASE.replace("    role: worker", "    role: worker\n    fallback_role: next"),
      key: "fallback_role",
      path: "workflow.entry",
    },
  ];

  for (const c of CASES) {
    it(`${c.label}：拒绝未知 key "${c.key}"，并点名 key、path 与允许集合`, () => {
      let thrown: unknown;
      try {
        parseWorkflowSpec(c.yaml, "test://strictness.yaml");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkflowSpecError);
      const e = thrown as WorkflowSpecError;
      expect(e.code).toBe("spec_unknown_key");
      expect(e.message).toContain(`"${c.key}"`);
      expect(e.message).toContain(c.path);
      expect(e.message).toContain("允许的键");
    });
  }

  it("封闭 keyset 以具名常量导出（WF-2 扩展接缝）", () => {
    expect(WORKFLOW_TOP_LEVEL_KEYS).toContain("loop_guards");
    expect(WORKFLOW_STEP_KEYS).toContain("next_hop");
    // WF-2 会扩展这些数组；在其他位置冻结字面量会破坏该契约。
  });

  it("只含已知 key 的 spec 可干净解析", () => {
    expect(() => parseWorkflowSpec(BASE, "test://ok.yaml")).not.toThrow();
  });
});

describe("基于真实解析语义的 FR-7 图校验", () => {
  it("suggested role 未声明 → 错误；已声明但无 step 承载 → 错误", () => {
    const undeclared = validateYaml(
      BASE.replace("          - next", "          - phantom-role"),
    );
    expect(undeclared.ok).toBe(false);
    expect(
      undeclared.issues.some((i) => i.code === "next_hop_role_not_declared"),
    ).toBe(true);

    const noStep = validateYaml(
      BASE.replace(
        "    next:\n      preferred_targets:\n        - next@rig",
        "    next:\n      preferred_targets:\n        - next@rig\n    ghost:\n      preferred_targets:\n        - ghost@rig",
      ).replace("          - next", "          - ghost"),
    );
    expect(noStep.ok).toBe(false);
    expect(noStep.issues.some((i) => i.code === "next_hop_role_has_no_step")).toBe(true);
  });

  it("不可达 step 显著失败，并点名遍历路径", () => {
    // `work` 通过 suggested_roles 路由到 `follow`；`orphan` 位于 forbid 终点之后——遍历永远
    // 无法到达它。
    const yaml = `workflow:
  id: unreachable
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
      next_hop:
        suggested_roles:
          - next
    - id: follow
      actor_role: next
      allowed_exits:
        - done
      next_hop:
        mode: forbid
    - id: orphan
      actor_role: worker
      allowed_exits:
        - done
`;
    const result = validateYaml(yaml);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "step_unreachable")!;
    expect(issue).toBeDefined();
    expect(issue.message).toContain('"orphan"');
    // OPR.0.4.6.WF2：可达性是图遍历（structural ∪ branch edge）；message 点名 entry step，
    // 而非线性遍历。
    expect(issue.message).toContain('"work"');
    expect(issue.message).toContain("branch edge");
  });

  it("不带 max_hops 的 cycle 失败并点名 cycle 与修复方法；带 max_hops 时通过（FR-6 许可）", () => {
    const cyclic = `workflow:
  id: cyclic
  version: 1
  roles:
    ping:
      preferred_targets:
        - ping@rig
    pong:
      preferred_targets:
        - pong@rig
  steps:
    - id: ping-step
      actor_role: ping
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - pong
    - id: pong-step
      actor_role: pong
      allowed_exits:
        - handoff
      next_hop:
        suggested_roles:
          - ping
`;
    const unguarded = validateYaml(cyclic);
    expect(unguarded.ok).toBe(false);
    const issue = unguarded.issues.find((i) => i.code === "cycle_without_max_hops")!;
    expect(issue).toBeDefined();
    expect(issue.message).toContain("ping-step → pong-step → ping-step");
    expect(issue.message).toContain("loop_guards.max_hops");

    const guarded = validateYaml(
      cyclic + "  loop_guards:\n    max_hops: 5\n",
    );
    expect(guarded.issues.some((i) => i.code === "cycle_without_max_hops")).toBe(false);
    expect(guarded.ok).toBe(true);
  });

  it("声明顺序 fallback edge 计入可达性（完全没有 next_hop 的线性 spec 通过校验）", () => {
    const plain = `workflow:
  id: plain-linear
  version: 1
  roles:
    worker:
      preferred_targets:
        - worker@rig
  steps:
    - id: a
      actor_role: worker
    - id: b
      actor_role: worker
    - id: c
      actor_role: worker
`;
    const result = validateYaml(plain);
    expect(result.ok).toBe(true);
  });
});

describe("FR-7 无误拒绝负向控制：每个随附的内置 starter spec 仍可解析并通过校验", () => {
  const BUILTIN_DIR = join(
    __dirname,
    "..",
    "src",
    "builtins",
    "workflow-specs",
  );
  for (const name of ["basic-loop.yaml", "conveyor.yaml"]) {
    it(`${name} 在新严格性规则下可干净解析并通过校验`, () => {
      const raw = readFileSync(join(BUILTIN_DIR, name), "utf-8");
      const spec = parseWorkflowSpec(raw, `builtin://${name}`);
      const result = new WorkflowValidator().validate(spec);
      expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});

// ── OPR.0.4.6.WF1 guard 阻塞项 2 + 3 回归 ───────────────────

describe("guard 阻塞项 2：loop_guards 形状校验——无法执行的 guard 绝不能许可 cycle", () => {
  const CYCLIC_WITH = (maxHopsYaml: string) => `workflow:
  id: shape-cycle
  version: 1
  roles:
    ping:
      preferred_targets:
        - ping@rig
    pong:
      preferred_targets:
        - pong@rig
  steps:
    - id: ping-step
      actor_role: ping
      next_hop:
        suggested_roles:
          - pong
    - id: pong-step
      actor_role: pong
      next_hop:
        suggested_roles:
          - ping
  loop_guards:
    max_hops: ${maxHopsYaml}
`;

  for (const bad of ['nope', '"3"', "3.5", "0", "-2"]) {
    it(`max_hops: ${bad} 在解析时显著拒绝（spec_field_invalid）——绝不让 NaN guard 许可无限 loop`, () => {
      let thrown: unknown;
      try {
        parseWorkflowSpec(CYCLIC_WITH(bad), "test://shape.yaml");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkflowSpecError);
      const e = thrown as WorkflowSpecError;
      expect(e.code).toBe("spec_field_invalid");
      expect(e.message).toContain("max_hops");
    });
  }

  it("解析时将 max_hops: null 视为缺失——随后 cycle 规则校验失败（无 null 漏洞）", () => {
    const spec = parseWorkflowSpec(CYCLIC_WITH("null"), "test://null.yaml");
    const result = new WorkflowValidator().validate(spec);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "cycle_without_max_hops")).toBe(true);
  });

  it("spawn_budget 形状：拒绝负数/非整数；0 仍合法（随附内置项使用 0）", () => {
    expect(() =>
      parseWorkflowSpec(CYCLIC_WITH("3").replace("max_hops: 3", "max_hops: 3\n    spawn_budget: -1"), "t://x"),
    ).toThrow(/spawn_budget/);
    expect(() =>
      parseWorkflowSpec(CYCLIC_WITH("3").replace("max_hops: 3", "max_hops: 3\n    spawn_budget: 0"), "t://x"),
    ).not.toThrow();
  });

  it("document root 严格性：YAML 根部 `workflow:` 旁的游离 sibling 会被显著拒绝", () => {
    const yaml = BASE + "extra_root_key: true\n";
    let thrown: unknown;
    try {
      parseWorkflowSpec(yaml, "test://root.yaml");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkflowSpecError);
    expect((thrown as WorkflowSpecError).code).toBe("spec_unknown_key");
    expect((thrown as WorkflowSpecError).message).toContain("(document root)");
  });

  it("validator 第二层：max_hops 为字符串的 cached-blob spec 不会许可 cycle（修复前 spec_json 防护）", () => {
    // 有意绕过 parser——这是陈旧 cached blob 的形态。
    const spec = parseWorkflowSpec(CYCLIC_WITH("5"), "test://ok.yaml");
    (spec.loop_guards as Record<string, unknown>).max_hops = "5";
    const result = new WorkflowValidator().validate(spec);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "cycle_without_max_hops")).toBe(true);
  });
});

describe("guard 阻塞项 3：steps[0] 是 entry 权威——不一致的 entry.role 会被显著拒绝", () => {
  it("entry.role != steps[0].actor_role → entry_role_mismatch 错误，并点名修复方法", () => {
    const yaml = BASE.replace("    role: worker", "    role: next");
    const result = validateYaml(yaml);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === "entry_role_mismatch")!;
    expect(issue).toBeDefined();
    expect(issue.message).toContain('steps[0]');
    expect(issue.message).toContain('"next"');
  });

  it("entry.role 与 steps[0].actor_role 匹配时干净通过（上述随附内置项继续通过）", () => {
    expect(validateYaml(BASE).ok).toBe(true);
  });
});
