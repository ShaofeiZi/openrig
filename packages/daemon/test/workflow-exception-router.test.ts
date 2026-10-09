// OPR.0.4.6.WF5 FR-2：maturity dial——resolution-chain 测试、tier split（human-gate 仅用于
// human-routed position）、never-lost fallback、never-retroactive 语义，以及 spec parse seam
// 上严格的 dial grammar。

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_EXCEPTION_HUMAN_TIER,
  WORKFLOW_EXCEPTION_ORCHESTRATOR_TIER,
  resolveExceptionRoute,
  type ExceptionRouteInput,
} from "../src/domain/workflow-exception-router.js";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const base = (over: Partial<ExceptionRouteInput> = {}): ExceptionRouteInput => ({
  exceptionClass: "unmapped_failed",
  spec: {
    roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } },
    exception_routing: { orchestrator_role: "orch" },
  },
  hostDialDefault: null,
  resolveRoleTarget: (role) => (role === "orch" ? "orch-lead@wf5-proof" : null),
  humanFallbackSeat: "human@host",
  ...over,
});

describe("WF-5 FR-2 dial 解析", () => {
  it("engine 默认值（chain link 4）：orchestrator-first、普通 tier——wire 层的反转", () => {
    const r = resolveExceptionRoute(base());
    expect(r.position).toBe("orchestrator");
    expect(r.destinationSession).toBe("orch-lead@wf5-proof");
    expect(r.tier).toBe(WORKFLOW_EXCEPTION_ORCHESTRATOR_TIER);
    expect(r.humanRouted).toBe(false);
    expect(r.resolvedVia).toBe("engine-default");
  });

  it("TIER-SPLIT 负向：orchestrator-routed item 绝不携带 human-gate tier", () => {
    const r = resolveExceptionRoute(base());
    expect(r.tier).not.toBe(WORKFLOW_EXCEPTION_HUMAN_TIER);
  });

  it("human-only（workflow-declared，chain link 2）：human seat 优先、human-gate tier", () => {
    const r = resolveExceptionRoute(
      base({
        spec: {
          roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } },
          exception_routing: { default: "human_only", orchestrator_role: "orch" },
        },
      }),
    );
    expect(r.position).toBe("human_only");
    expect(r.destinationSession).toBe("human@host");
    expect(r.tier).toBe(WORKFLOW_EXCEPTION_HUMAN_TIER);
    expect(r.humanRouted).toBe(true);
    expect(r.resolvedVia).toBe("workflow-declared");
  });

  it("per-class override（chain link 1）优先于 workflow default", () => {
    const r = resolveExceptionRoute(
      base({
        exceptionClass: "stuck_overdue",
        spec: {
          roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } },
          exception_routing: {
            default: "orchestrator",
            orchestrator_role: "orch",
            classes: { stuck_overdue: "human_only" },
          },
        },
      }),
    );
    expect(r.position).toBe("human_only");
    expect(r.resolvedVia).toBe("class-declared");
  });

  it("spec 未声明时应用 host dial default（chain link 3）", () => {
    const r = resolveExceptionRoute(
      base({ spec: { roles: {} }, hostDialDefault: "human_only" }),
    );
    expect(r.position).toBe("human_only");
    expect(r.resolvedVia).toBe("host-default");
  });

  it("NEVER-LOST FALLBACK：没有可解析 role target 的 orchestrator position 路由到带 human-gate tier 的 human@host", () => {
    const r = resolveExceptionRoute(base({ spec: { roles: {} } }));
    expect(r.position).toBe("fallback");
    expect(r.destinationSession).toBe("human@host");
    expect(r.tier).toBe(WORKFLOW_EXCEPTION_HUMAN_TIER);
    expect(r.humanRouted).toBe(true);
  });

  it("class (c) 本质上仅限 human——dial 无法将其重定向", () => {
    const r = resolveExceptionRoute(
      base({
        exceptionClass: "human_gate_trip",
        spec: {
          roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } },
          exception_routing: { default: "orchestrator", orchestrator_role: "orch" },
        },
      }),
    );
    expect(r.position).toBe("human_only");
    expect(r.resolvedVia).toBe("class-intrinsic");
  });

  it("构造上不追溯：resolution 为纯函数——dial 切换仅改变下一次调用", () => {
    const before = resolveExceptionRoute(base({ hostDialDefault: null, spec: { roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } }, exception_routing: { orchestrator_role: "orch" } } }));
    const after = resolveExceptionRoute(base({ hostDialDefault: "human_only", spec: { roles: { orch: { preferred_targets: ["orch-lead@wf5-proof"] } }, exception_routing: { orchestrator_role: "orch" } } }));
    expect(before.position).toBe("orchestrator");
    expect(after.position).toBe("human_only");
    // 确定性：相同 input 在 N 次调用中得到相同 output
    for (let i = 0; i < 3; i++) {
      expect(resolveExceptionRoute(base())).toEqual(before);
    }
  });
});

const specYaml = (routing: string) => `
workflow:
  id: dial-spec
  version: "1"
  roles:
    worker: { preferred_targets: ["crew-worker@wf5-proof"] }
    orch: { preferred_targets: ["orch-lead@wf5-proof"] }
  steps:
    - id: work
      actor_role: worker
${routing}
`;

describe("WF-5 FR-2 dial grammar 严格性（WF-2 rail）", () => {
  it("有效 exception_routing block 可解析", () => {
    const spec = parseWorkflowSpec(
      specYaml(
        "  exception_routing:\n    default: orchestrator\n    orchestrator_role: orch\n    classes:\n      stuck_overdue: human_only\n",
      ),
      "test://dial-ok.yaml",
    );
    expect(spec.exception_routing?.default).toBe("orchestrator");
    expect(spec.exception_routing?.orchestrator_role).toBe("orch");
    expect(spec.exception_routing?.classes?.stuck_overdue).toBe("human_only");
  });

  it("exception_routing 内未知 key 会被拒绝，并列出允许集合", () => {
    expect(() =>
      parseWorkflowSpec(
        specYaml("  exception_routing:\n    escalation_ladder: pagerduty\n"),
        "test://dial-unknown.yaml",
      ),
    ).toThrowError(/exception_routing/);
  });

  it("无效 dial position 会被明确拒绝", () => {
    expect(() =>
      parseWorkflowSpec(
        specYaml("  exception_routing:\n    default: founder-first\n"),
        "test://dial-badpos.yaml",
      ),
    ).toThrowError(/orchestrator.*human_only|human_only.*orchestrator/);
  });

  it("classes.human_gate_trip 不可配置——以 intrinsic-human 说明拒绝", () => {
    expect(() =>
      parseWorkflowSpec(
        specYaml("  exception_routing:\n    classes:\n      human_gate_trip: orchestrator\n"),
        "test://dial-gatetrip.yaml",
      ),
    ).toThrowError(/本质上只能由人工处理/);
  });

  it("未知 class key 会被拒绝，并列出允许的 class", () => {
    expect(() =>
      parseWorkflowSpec(
        specYaml("  exception_routing:\n    classes:\n      disk_full: human_only\n"),
        "test://dial-badclass.yaml",
      ),
    ).toThrowError(/unmapped_failed、stuck_overdue/);
  });

  it("不含 exception_routing 的 spec 仍可解析（zero-regression 负向）", () => {
    const spec = parseWorkflowSpec(specYaml(""), "test://dial-absent.yaml");
    expect(spec.exception_routing).toBeUndefined();
  });
});
