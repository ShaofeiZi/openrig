// Slice Story View v1——4 个 v1 维度的聚焦 tab 测试。
//
// Pins:
//   - TimelineTab：spec 驱动 phase 分组（无 v0 硬编码 legacy enum）
//   - TimelineTab：未 tagged 事件以中性 palette + label 渲染
//   - AcceptanceTab：绑定时渲染 Current Step 面板；未绑定则无
//   - AcceptanceTab：PROGRESS.md checkbox 视图仍并列渲染
//   - TopologyTab：spec graph 渲染 nodes + edges + isCurrent/isEntry/
//     isTerminal badge + 绑定时 loop-back edge 样式
//   - TopologyTab：per-rig 列表仍与 spec graph 并列渲染
//   - TopologyTab：routingType="direct" carved-out——每条 edge 都有

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createTestRouter } from "./helpers/test-router.js";
import { TimelineTab } from "../src/components/slices/tabs/TimelineTab.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { AcceptanceTab } from "../src/components/slices/tabs/AcceptanceTab.js";
import { TopologyTab } from "../src/components/slices/tabs/TopologyTab.js";
import type {
  StoryEvent,
  PhaseDefinition,
  CurrentStepPayload,
  QueueItemDetail,
  SpecGraphPayload,
  SliceDetail,
} from "../src/hooks/useSlices.js";

afterEach(() => cleanup());

function event(overrides: Partial<StoryEvent>): StoryEvent {
  return {
    ts: "2026-05-04T00:00:00.000Z",
    phase: null,
    kind: "queue.created",
    actorSession: "src@r",
    qitemId: "q-1",
    summary: "summary",
    detail: null,
    ...overrides,
  };
}

const SPEC_PHASES: PhaseDefinition[] = [
  { id: "discovery", label: "discovery-router", role: "discovery-router" },
  { id: "delivery", label: "delivery-driver", role: "delivery-driver" },
  { id: "qa", label: "qa-tester", role: "qa-tester" },
];

function renderStory(ui: ReactNode) {
  return render(
    <DrawerSelectionContext.Provider value={{ selection: null, setSelection: vi.fn() }}>
      {ui}
    </DrawerSelectionContext.Provider>,
  );
}

describe("PL-slice-story-view-v1 TimelineTab", () => {
  it("groups events by spec-declared phase labels (NOT v0 hardcoded legacy names)", () => {
    const events = [
      event({ kind: "queue.created", phase: "discovery", qitemId: "q-d" }),
      event({ kind: "queue.handed_off", phase: "delivery", qitemId: "q-x" }),
      event({ kind: "transition.in-progress", phase: "qa", qitemId: "q-q" }),
    ];
    renderStory(<TimelineTab events={events} phaseDefinitions={SPEC_PHASES} />);
    // 每行 phase chip 使用 spec 声明 label（等于 v1 projector 默认的
    // actor_role）。
    expect(screen.getByTestId("story-row-phase-queue.created").textContent).toBe("discovery-router");
    expect(screen.getByTestId("story-row-phase-queue.handed_off").textContent).toBe("delivery-driver");
    expect(screen.getByTestId("story-row-phase-transition.in-progress").textContent).toBe("qa-tester");
  });

  it("untagged events render with the neutral 'untagged' label + stone palette", () => {
    const events = [event({ kind: "doc.edited", phase: null, qitemId: null })];
    renderStory(<TimelineTab events={events} phaseDefinitions={SPEC_PHASES} />);
    const chip = screen.getByTestId("story-row-phase-doc.edited");
    expect(chip.textContent).toBe("未标记");
    expect(chip.getAttribute("data-phase-id")).toBe("untagged");
    expect(chip.className).toContain("surface-low");
  });

  it("when phaseDefinitions is null (unbound slice), spec phase ids on events fall through exactly", () => {
    // 边界情况：某事件携带 phase id 但 slice 未绑定。chip 回退显示原始
    // phase id 而非崩溃。（真实 v1 场景：先前绑定的 slice 失去
    // workflow_instance 绑定——事件在 fetch 时被 tagged，定义没有。）
    const events = [event({ kind: "queue.created", phase: "step-x" })];
    renderStory(<TimelineTab events={events} phaseDefinitions={null} />);
    expect(screen.getByTestId("story-row-phase-queue.created").textContent).toBe("step-x");
  });

  it("renders a newest-first connected step tree", () => {
    const events = [
      event({ kind: "old.event", ts: "2026-05-04T00:00:00.000Z", summary: "older" }),
      event({ kind: "new.event", ts: "2026-05-04T01:00:00.000Z", summary: "newer" }),
    ];
    renderStory(<TimelineTab events={events} phaseDefinitions={null} />);
    expect(screen.getByTestId("story-step-tree").getAttribute("data-order")).toBe("newest-first");
    const rows = screen.getAllByTestId(/story-row-/);
    expect(rows[0]?.getAttribute("data-testid")).toBe("story-row-new.event");
    expect(screen.getByTestId("story-step-connector-new.event")).toBeDefined();
  });

  it("renders qitem body as the primary story content when queue details are loaded", () => {
    const queueItem: QueueItemDetail = {
      qitemId: "q-1",
      tsCreated: "2026-05-04T00:00:00.000Z",
      tsUpdated: "2026-05-04T00:00:00.000Z",
      sourceSession: "src@r",
      destinationSession: "dest@r",
      state: "in-progress",
      priority: "routine",
      tier: "mode2",
      tags: ["demo"],
      body: "Implement the observability body-first story view.\nInclude acceptance evidence.",
    };
    renderStory(
      <TimelineTab
        events={[
          event({
            kind: "queue.created",
            qitemId: "q-1",
            summary: "src@r -> dest@r: truncated metadata summary",
          }),
        ]}
        phaseDefinitions={null}
        queueItemsById={new Map([["q-1", queueItem]])}
      />,
    );
    const body = screen.getByTestId("story-row-body-queue.created");
    expect(body.getAttribute("data-source")).toBe("qitem");
    expect(body.textContent).toContain("Implement the observability body-first story view.");
    expect(screen.getByTestId("story-row-summary-queue.created").textContent).toContain(
      "truncated metadata summary",
    );
  });
});

// --- AcceptanceTab ---

function acceptanceShape(currentStep: CurrentStepPayload | null): SliceDetail["acceptance"] {
  return {
    totalItems: 4,
    doneItems: 2,
    percentage: 50,
    items: [
      { text: "Item 1", done: true, source: { file: "README.md", line: 10 } },
      { text: "Item 2", done: false, source: { file: "README.md", line: 11 } },
    ],
    closureCallout: null,
    currentStep,
  };
}

describe("PL-slice-story-view-v1 AcceptanceTab", () => {
  it("renders Current Step panel when bound (above the v0 checkbox list)", () => {
    const cs: CurrentStepPayload = {
      stepId: "delivery",
      role: "delivery-driver",
      objective: "Implement the slice per packet.",
      allowedExits: ["handoff", "waiting", "failed"],
      allowedNextSteps: [
        { stepId: "lifecycle", role: "lifecycle-router", reason: "next_hop" },
      ],
      hopCount: 3,
      instanceStatus: "active",
    };
    render(<AcceptanceTab acceptance={acceptanceShape(cs)} />);
    expect(screen.getByTestId("acceptance-current-step")).toBeDefined();
    expect(screen.getByTestId("acceptance-current-step-id").textContent).toBe("delivery");
    expect(screen.getByTestId("acceptance-current-step-objective").textContent).toContain("Implement the slice");
    // allowed exits + allowed next steps 都存在。
    const allowed = screen.getByTestId("acceptance-current-step-allowed-exits");
    expect(allowed.textContent).toContain("handoff");
    expect(allowed.textContent).toContain("waiting");
    expect(allowed.textContent).toContain("failed");
    expect(screen.getByTestId("acceptance-next-step-lifecycle")).toBeDefined();
    // v0 checkbox 视图仍并列渲染。
    expect(screen.getByTestId("acceptance-list")).toBeDefined();
    expect(screen.getByTestId("acceptance-progress-bar")).toBeDefined();
  });

  it("does NOT render Current Step panel when unbound (currentStep=null)", () => {
    render(<AcceptanceTab acceptance={acceptanceShape(null)} />);
    expect(screen.queryByTestId("acceptance-current-step")).toBeNull();
    // v0 checkbox 视图仍渲染——确认 fallback 完整。
    expect(screen.getByTestId("acceptance-list")).toBeDefined();
  });

  it("Current Step shows terminal marker when allowedNextSteps is empty", () => {
    const cs: CurrentStepPayload = {
      stepId: "qa",
      role: "qa-tester",
      objective: null,
      allowedExits: ["done"],
      allowedNextSteps: [],
      hopCount: 5,
      instanceStatus: "active",
    };
    render(<AcceptanceTab acceptance={acceptanceShape(cs)} />);
    const nextSteps = screen.getByTestId("acceptance-current-step-allowed-next-steps");
    expect(nextSteps.textContent).toContain("终端");
    expect(screen.getByRole("img", { name: "终端" })).toBeDefined();
  });
});

// --- TopologyTab ---

function topologyShape(specGraph: SpecGraphPayload | null, withRigs = true): SliceDetail["topology"] {
  return {
    affectedRigs: withRigs
      ? [{ rigId: "rig-1", rigName: "demo", sessionNames: ["alpha@demo", "beta@demo"] }]
      : [],
    totalSeats: withRigs ? 2 : 0,
    specGraph,
  };
}

describe("PL-slice-story-view-v1 TopologyTab", () => {
  function makeRouter(topology: SliceDetail["topology"]) {
    return createTestRouter({ component: () => <TopologyTab topology={topology} />, path: "/" });
  }

  it("renders the spec graph panel when specGraph is present", async () => {
    const sg: SpecGraphPayload = {
      specName: "test-loop",
      specVersion: "1",
      nodes: [
        { stepId: "discovery", label: "discovery-router", role: "discovery-router", preferredTarget: "intake@r", isEntry: true, isCurrent: false, isTerminal: false },
        { stepId: "delivery", label: "delivery-driver", role: "delivery-driver", preferredTarget: "driver@r", isEntry: false, isCurrent: true, isTerminal: false },
        { stepId: "qa", label: "qa-tester", role: "qa-tester", preferredTarget: "qa@r", isEntry: false, isCurrent: false, isTerminal: false },
      ],
      edges: [
        { fromStepId: "discovery", toStepId: "delivery", routingType: "direct", isLoopBack: false },
        { fromStepId: "delivery", toStepId: "qa", routingType: "direct", isLoopBack: false },
        { fromStepId: "qa", toStepId: "discovery", routingType: "direct", isLoopBack: true },
      ],
    };
    render(makeRouter(topologyShape(sg)));
    await waitFor(() => expect(screen.getByTestId("topology-spec-graph")).toBeDefined());
    expect(screen.getByTestId("topology-spec-graph").getAttribute("data-layout")).toBe("react-flow-dagre");
    expect(screen.getByTestId("slice-workflow-graph")).toBeDefined();
    expect(screen.getByTestId("topology-spec-name").textContent).toBe("test-loop");
    // per-step nodes 已渲染。
    expect(screen.getByTestId("spec-node-discovery")).toBeDefined();
    expect(screen.getByTestId("spec-node-delivery")).toBeDefined();
    expect(screen.getByTestId("spec-node-qa")).toBeDefined();
    // entry + current badge。
    expect(screen.getByTestId("spec-node-discovery-entry-badge")).toBeDefined();
    expect(screen.getByTestId("spec-node-delivery-current-badge")).toBeDefined();
    expect(screen.queryByTestId("spec-node-qa-current-badge")).toBeNull();
    // edges，含 loop-back。
    expect(screen.getByTestId("spec-edge-discovery-delivery").getAttribute("data-is-loop-back")).toBe("false");
    expect(screen.getByTestId("spec-edge-qa-discovery").getAttribute("data-is-loop-back")).toBe("true");
    // per-rig 列表仍并列渲染。
    expect(screen.getByTestId("topology-rig-listing")).toBeDefined();
    expect(screen.getByTestId("topology-rig-demo")).toBeDefined();
  });

  it("renders a derived runtime graph when unbound but affected seats are present", async () => {
    render(makeRouter(topologyShape(null)));
    await waitFor(() => expect(screen.getByTestId("topology-rig-demo")).toBeDefined());
    expect(screen.getByTestId("topology-spec-graph").getAttribute("data-spec-name")).toBe("runtime-handoff-map");
    expect(screen.getByTestId("spec-node-demo")).toBeDefined();
  });

  it("v1 carve-out: every spec edge carries data-routing-type='direct' (Phase D has no routing_type field yet)", async () => {
    const sg: SpecGraphPayload = {
      specName: "test-loop",
      specVersion: "1",
      nodes: [
        { stepId: "a", label: "a", role: "a", preferredTarget: null, isEntry: true, isCurrent: false, isTerminal: false },
        { stepId: "b", label: "b", role: "b", preferredTarget: null, isEntry: false, isCurrent: false, isTerminal: true },
      ],
      edges: [{ fromStepId: "a", toStepId: "b", routingType: "direct", isLoopBack: false }],
    };
    render(makeRouter(topologyShape(sg, false)));
    await waitFor(() => expect(screen.getByTestId("spec-edge-a-b")).toBeDefined());
    const edge = screen.getByTestId("spec-edge-a-b");
    expect(edge.getAttribute("data-routing-type")).toBe("direct");
    expect(screen.getByTestId("spec-node-b-terminal-badge")).toBeDefined();
    expect(screen.getByRole("img", { name: "终端" })).toBeDefined();
  });

  it("OPR.0.4.1.20: workflow-grammar — Workflow header, per-step state dot bound to isCurrent, read-only + reject->rework legend", async () => {
    const sg: SpecGraphPayload = {
      specName: "triple-gate",
      specVersion: "2",
      nodes: [
        { stepId: "plan", label: "shape the plan", role: "planner", preferredTarget: "dev1-planner@openrig-delivery", isEntry: true, isCurrent: false, isTerminal: false },
        { stepId: "build", label: "one-shot the chunk", role: "driver", preferredTarget: "dev1-driver@openrig-delivery", isEntry: false, isCurrent: true, isTerminal: false },
        { stepId: "merge", label: "merge to main", role: "orch-lead", preferredTarget: "orch-lead@openrig-delivery", isEntry: false, isCurrent: false, isTerminal: true },
      ],
      edges: [
        { fromStepId: "plan", toStepId: "build", routingType: "direct", isLoopBack: false },
        { fromStepId: "build", toStepId: "merge", routingType: "direct", isLoopBack: false },
        { fromStepId: "merge", toStepId: "build", routingType: "direct", isLoopBack: true },
      ],
    };
    render(makeRouter(topologyShape(sg)));
    await waitFor(() => expect(screen.getByTestId("topology-spec-graph")).toBeDefined());
    // Tab 内容 header 由 Topology 改名 Workflow（slice 20）。旧大写
    // "Topology" header 词已消失（小写 "Open topology" rig-listing 链接无关
    // 且未动）。
    expect(screen.getByTestId("topology-tab").textContent).toContain("工作流");
    // 只读 spec viz + reject->rework legend（存在 loop-back edge）。
    const panel = screen.getByTestId("topology-spec-graph").textContent?.toLowerCase() ?? "";
    expect(panel).toContain("只读");
    expect(panel).toContain("拒绝");
    // Topology-grammar card：dark header 携带 step ROLE；state dot 绑定
    // isCurrent（仅当前 step active）。
    expect(screen.getByTestId("spec-node-plan").textContent).toContain("planner");
    expect(screen.getByTestId("spec-node-build-state-dot").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("spec-node-plan-state-dot").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("spec-node-merge-state-dot").getAttribute("data-active")).toBe("false");
  });

  it("renders empty state only when BOTH specGraph is null AND no rigs are present", async () => {
    render(makeRouter({ affectedRigs: [], totalSeats: 0, specGraph: null }));
    await waitFor(() => expect(screen.getByTestId("topology-empty")).toBeDefined());
  });
});

// OPR.0.4.4.19 FR-2——timeline label 优先 qitem 的 summary；body 仍是
// drill-in payload。
describe("OPR.0.4.4.19 FR-2 TimelineTab summary-first labels", () => {
  function qitem(overrides: Partial<QueueItemDetail>): QueueItemDetail {
    return {
      qitemId: "q-1",
      tsCreated: "2026-07-04T00:00:00Z",
      tsUpdated: "2026-07-04T00:00:00Z",
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      state: "pending",
      priority: "routine",
      tier: null,
      tags: null,
      body: "agent-speak body, long and detailed",
      summary: null,
      ...overrides,
    } as QueueItemDetail;
  }

  it("with both summary and body, the summary is the rendered label", () => {
    const events = [event({ kind: "queue.created", qitemId: "q-1" })];
    const byId = new Map([["q-1", qitem({ summary: "Approve the 0.4.4 cut" })]]);
    renderStory(<TimelineTab events={events} phaseDefinitions={SPEC_PHASES} queueItemsById={byId} />);
    const body = screen.getByTestId("story-row-body-queue.created");
    expect(body.textContent).toContain("Approve the 0.4.4 cut");
    expect(body.textContent).not.toContain("agent-speak body");
  });

  it("with no summary, degrades to qitem body, then to the event summary", () => {
    const events = [event({ kind: "queue.created", qitemId: "q-1", summary: "event-level summary" })];
    const byId = new Map([["q-1", qitem({ summary: null })]]);
    renderStory(<TimelineTab events={events} phaseDefinitions={SPEC_PHASES} queueItemsById={byId} />);
    expect(screen.getByTestId("story-row-body-queue.created").textContent).toContain("agent-speak body");
    cleanup();
    // 完全无 qitem -> event summary fallback（既有行为保留）。
    renderStory(<TimelineTab events={events} phaseDefinitions={SPEC_PHASES} />);
    expect(screen.getByTestId("story-row-body-queue.created").textContent).toContain("event-level summary");
  });
});
