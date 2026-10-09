import { describe, it, expect, vi, afterEach } from "vitest";
import {
  renderTraceTree,
  renderInstanceList,
  renderInstanceShow,
  humanDuration,
  statusGlyph,
} from "../src/commands/workflow-render.js";
import type { WorkflowDeps } from "../src/commands/workflow.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

/**
 * OPR.0.4.6.WF3 FR-2——renderer pin（commit 2）。仅渲染侧：
 * --json 的字节稳定性在此单元级额外 pin（经 json 分支原始 body 逐字）；
 * before/after diff harness（commit 8）是约束性证明。
 */

const NOW = "2026-07-06T21:10:00.000Z";

const INSTANCE = {
  instanceId: "WF01ABC",
  workflowName: "conveyor",
  workflowVersion: "2",
  status: "active",
  createdBySession: "orch@rig",
  createdAt: "2026-07-06T21:00:00.000Z",
  currentStepId: "review",
  currentFrontier: ["Q3"],
  hopCount: 2,
};

const TRAIL = [
  {
    stepId: "plan",
    closedAt: "2026-07-06T21:02:00.000Z",
    closureReason: "handoff",
    actorSession: "planner@rig",
    nextQitemId: "Q2",
    priorQitemId: "Q1",
  },
  {
    stepId: "build",
    closedAt: "2026-07-06T21:08:00.000Z",
    closureReason: "handoff",
    closureEvidence: { branch_taken: "remediate" },
    actorSession: "builder@rig",
    nextQitemId: "Q3",
    priorQitemId: "Q2",
  },
];

describe("workflow-render (WF3 FR-2)", () => {
  it("trace tree: one screen with step, actor, exit, duration, and the current frontier", () => {
    const lines = renderTraceTree(INSTANCE, TRAIL, NOW);
    const text = lines.join("\n");
    expect(text).toContain("WF01ABC");
    expect(text).toContain("conveyor v2");
    expect(text).toContain("步骤");
    expect(text).toContain("执行者");
    expect(text).toContain("plan");
    expect(text).toContain("planner@rig");
    expect(text).toContain("2m"); // plan duration from createdAt→closedAt
    expect(text).toContain("6m"); // build duration from prior close
    expect(text).toContain("▸ review"); // where it is now
    expect(text).toContain("frontier=[Q3]");
    // 无原始 JSON 泄漏——FR-2 的全部要点。
    expect(text).not.toContain("{");
  });

  it("branch-taken renders when the trail carries it, leaves no residue when absent (present-tolerant)", () => {
    const withBranch = renderTraceTree(INSTANCE, TRAIL, NOW).join("\n");
    expect(withBranch).toContain("↳ 分支：remediate");
    const noBranch = renderTraceTree(INSTANCE, [TRAIL[0]], NOW).join("\n");
    expect(noBranch).not.toContain("branch:");
  });

  it("failed steps carry the ✖ glyph", () => {
    const lines = renderTraceTree(
      { ...INSTANCE, status: "failed", currentStepId: null },
      [{ ...TRAIL[0], closureReason: "failed" }],
      NOW,
    );
    expect(lines.join("\n")).toContain("✖");
    expect(statusGlyph("failed")).toBe("✖");
  });

  it("list table: columns + one row per instance + age", () => {
    const lines = renderInstanceList([INSTANCE, { ...INSTANCE, instanceId: "WF02", status: "waiting", currentStepId: null }], NOW);
    expect(lines[0]).toMatch(/实例\s+工作流\s+状态\s+步骤\s+年龄\s+关注/);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("WF01ABC");
    expect(lines[1]).toContain("10m");
    expect(lines[2]).toContain("◐");
  });

  it("FR-3a attention markers: failed and waiting rows marked; active/completed unmarked", () => {
    const lines = renderInstanceList(
      [
        INSTANCE,
        { ...INSTANCE, instanceId: "WF-F", status: "failed" },
        { ...INSTANCE, instanceId: "WF-W", status: "waiting" },
        { ...INSTANCE, instanceId: "WF-C", status: "completed" },
      ],
      NOW,
    );
    expect(lines.find((l) => l.includes("WF-F"))).toContain("▲ 失败");
    expect(lines.find((l) => l.includes("WF-W"))).toContain("▲ 等待");
    expect(lines.find((l) => l.includes("WF01ABC"))).not.toContain("▲");
    expect(lines.find((l) => l.includes("WF-C"))).not.toContain("▲");
  });

  it("empty list renders the explicit empty statement, never a blank", () => {
    expect(renderInstanceList([], NOW)).toEqual(["没有工作流实例。"]);
  });

  it("show: status-line-headed summary with a next pointer at trace", () => {
    const lines = renderInstanceShow(INSTANCE, NOW);
    expect(lines[0]).toBe("● WF01ABC  status=active");
    expect(lines.join("\n")).toContain("rig workflow trace WF01ABC");
  });

  it("renders every packet and failure with an exact selector, never frontier[0]", () => {
    const lifecycle = {
      ...INSTANCE,
      currentStepId: null,
      currentFrontier: ["Q-LEFT", "Q-RIGHT"],
      frontierPackets: [
        { packetId: "Q-LEFT", stepId: "left", ownerSession: "left@rig", queueState: "in-progress", blockedOn: null, targetedAction: "project" as const },
        { packetId: "Q-RIGHT", stepId: "right", ownerSession: "right@rig", queueState: "blocked", blockedOn: "gate-2", targetedAction: "project" as const },
      ],
      failureOccurrences: [
        { occurrenceId: "Q-FAILED", stepId: "build", status: "unresolved" as const, targetedAction: "resume" as const },
      ],
      unknowns: ["frontier packet Q-GHOST has no queue row"],
    };
    const show = renderInstanceShow(lifecycle, NOW).join("\n");
    expect(show).toContain("Q-LEFT  step=left  owner=left@rig");
    expect(show).toContain("Q-RIGHT  step=right  owner=right@rig  state=blocked  blocked_on=gate-2");
    expect(show).toContain("project --instance WF01ABC --current-packet Q-LEFT --exit <handoff|waiting|done|failed> --actor-session left@rig");
    expect(show).toContain("project --instance WF01ABC --current-packet Q-RIGHT --exit <handoff|waiting|done|failed> --actor-session right@rig");
    expect(show).toContain("--occurrence Q-FAILED");
    expect(show).toContain("unknown： frontier packet Q-GHOST has no queue row");

    const trace = renderTraceTree(lifecycle, TRAIL, NOW).join("\n");
    expect(trace).toContain("packet=Q-LEFT");
    expect(trace).toContain("packet=Q-RIGHT");
    expect(trace).toContain("失败 Q-FAILED");
  });

  it("shows required boundary obligations and missing receipts separately from queue state", () => {
    const body = renderInstanceShow({ ...INSTANCE,
      lifecycleBinding: { graphSource: { mode: "project-profile", profileSource: "/project.yaml#lifecycle.profiles.release" } },
      boundaryObligations: [
        { stepId: "exact-cut-substance", required: true, state: "pending", receiptState: "missing", receipt: null },
        { stepId: "record-shipped", required: true, state: "closed", receiptState: "recorded", receipt: { evidenceRef: "proof/ship.md", actorSession: "orch@rig", closedAt: NOW } },
      ],
    }, NOW).join("\n");
    expect(body).toContain("边界：project-profile");
    expect(body).toContain("exact-cut-substance · required · pending · 收据 missing");
    expect(body).toContain("record-shipped · required · closed · 收据 recorded");
    expect(body).toContain("proof/ship.md · 由 orch@rig 记录于");
  });

  it("renders the typed acceptance command shape on an acceptance frontier", () => {
    const acceptance = {
      ...INSTANCE,
      currentStepId: null,
      frontierPackets: [{
        packetId: "Q-ACCEPT",
        stepId: "accept",
        ownerSession: "reviewer@rig",
        queueState: "in-progress",
        blockedOn: null,
        targetedAction: "project" as const,
        acceptance: {
          candidate: "abc123",
          verdicts: ["CLEAR", "BLOCKING"],
          evidence_ref: "proof/review report.md",
        },
      }],
    };
    const show = renderInstanceShow(acceptance, NOW).join("\n");
    expect(show).toContain("--acceptance-candidate 'abc123'");
    expect(show).toContain("--acceptance-verdict '<CLEAR|BLOCKING>'");
    expect(show).toContain("--acceptance-evidence-ref 'proof/review report.md'");
  });

  it("keeps an aborted unresolved occurrence as non-actionable history in show and trace", () => {
    const aborted = {
      ...INSTANCE,
      status: "aborted",
      currentStepId: null,
      currentFrontier: [],
      failureOccurrences: [{
        occurrenceId: "Q-HISTORY",
        stepId: "build",
        status: "unresolved" as const,
        failureReason: "stopped",
        targetedAction: "none" as const,
      }],
    };
    for (const text of [
      renderInstanceShow(aborted, NOW).join("\n"),
      renderTraceTree(aborted, TRAIL, NOW).join("\n"),
    ]) {
      expect(text).toContain("Q-HISTORY");
      expect(text).toContain("动作：无——终态历史");
      expect(text).not.toContain("rig workflow resume");
    }
    expect(renderInstanceList([aborted], NOW)[1]).not.toContain("▲ 失败分支");
  });

  it("humanDuration compacts sanely", () => {
    expect(humanDuration("2026-07-06T21:00:00Z", "2026-07-06T21:00:30Z")).toBe("30s");
    expect(humanDuration("2026-07-06T21:00:00Z", "2026-07-06T22:30:00Z")).toBe("90m");
    expect(humanDuration(undefined, NOW)).toBe("");
  });
});

describe("BR-2 byte-stability of --json (unit pin; commit-8 harness is the binding proof)", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeDeps(routes: Record<string, { status: number; data: unknown }>): WorkflowDeps {
    return {
      lifecycleDeps: {} as WorkflowDeps["lifecycleDeps"],
      clientFactory: () =>
        ({
          get: async (path: string) => routes[`GET ${path}`] ?? { status: 200, data: {} },
          post: async (path: string) => routes[`POST ${path}`] ?? { status: 200, data: {} },
        }) as never,
    };
  }

  it("trace --json emits the raw daemon body verbatim (no renderer involvement)", async () => {
    const body = { instance: { instanceId: "i1", status: "active" }, trail: [{ stepId: "s", extra: 1 }] };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({ "GET /api/workflow/i1/trace": { status: 200, data: body } }),
    });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "trace", "i1", "--json"]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(body));
  });

  it("list --json emits the raw daemon body verbatim", async () => {
    const body = [{ instanceId: "i1", status: "active" }];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({ "GET /api/workflow/list": { status: 200, data: body } }),
    });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "workflow", "list", "--json"]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(body));
  });
});

it("shows the exception selection, unavailable evidence and owning obligation without inventing success", () => {
  const lines = renderInstanceShow({ ...INSTANCE,
    exceptionReadiness: { selection: { state: "selected", role: "orch", entryRole: "owner", source: "/project.yaml#lifecycle.profiles.release.workflow.exception_routing.orchestrator_role" },
      routes: [{ exceptionClass: "stuck_overdue", state: "unavailable", roleResolution: "unavailable", destinationSession: null, position: "orchestrator", resolvedVia: "engine-default", message: "inventory read failed" }],
      nextAction: "Inspect rig workflow revise WF01ABC; existing obligations keep their owners." },
    exceptionObligations: [{ qitemId: "qitem-existing", ownerSession: "prior@rig", state: "pending", evidenceRef: "rig workflow trace WF01ABC", inspectCommand: "rig queue show qitem-existing --full --json" }],
  }, NOW).join("\n");
  expect(lines).toContain("异常所有者：selected · orch（普通入口：owner）");
  expect(lines).toContain("unavailable · orchestrator，经 engine-default · 无已验证目标");
  expect(lines).toContain("inventory read failed");
  expect(lines).toContain("qitem-existing · owner=prior@rig · state=pending");
  expect(lines).toContain("rig workflow revise WF01ABC");
});
