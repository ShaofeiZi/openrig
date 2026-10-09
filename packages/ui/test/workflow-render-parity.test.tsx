// OPR.0.4.6.WF4——渲染对等（PM 精炼 Rule B，2026-07-07）。两个
// production 不可达的 attention kind（no-item ▲ 兜底和 S2
// overdue ●——引擎原因见 PROOF.md：4h 硬编码 stuck 阈值无 env 覆盖，
// 以及在同一 failure txn 中诞生的 exception 项）通过构造精确行/状态并断言
// 与 LIVE kind 相同的 row.workflow 深链目标 + 相同渲染 banner 来证明——
// 渲染对等，而非单元信任。Q6-P3 反散文在此处跨全部四个 kind 断言
//（每个 kind 的链接仅从 item.workflow 解析）。

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

// NEEDS-YOU chat 表面是 ProgressiveTerminal（xterm）。mock 它，使
// accordion 在 jsdom 中渲染而不启动 canvas（jsdom 未实现 getContext
// → xterm 抛错 → 空渲染）。模式取自
// foryou-bare-approve-chat.test.tsx（OPR.0.4.6.WF4 leg-8 test-only 修复）。
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({
  ProgressiveTerminal: () => <div data-testid="mock-progressive-terminal" />,
}));
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NeedsYouAccordion } from "../src/components/review/NeedsYouAccordion.js";
import { ExceptionBanner } from "../src/components/workflow/WorkflowInstancePage.js";
import type { NeedsYouBand, NeedsYouItem } from "../src/hooks/useReview.js";
import type { WorkflowInstanceWithDeadline } from "../src/hooks/useWorkflow.js";
import type { EvidenceContext } from "../src/components/review/EvidenceOpener.js";

afterEach(() => cleanup());

const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({
  source: "agent",
  identity: "id",
  summary: "s",
  leg: "human-routed",
  where: "human@host",
  ageIso: null,
  priority: null,
  tier: null,
  evidenceRef: null,
  unblocks: null,
  qitemId: "q",
  destinationSession: "human@host",
  derived: null,
  ...over,
});

// 四个 kind，各带 Q6 row.workflow 指针。两个 live 可达
//（parked gate ● · human-routed ●），两个披露为不可达
//（orchestrator awareness 也 live，但在此归为 ▲；no-item
// 兜底是不可达 ▲）。全部必须渲染相同深链。
const FOUR_KINDS: NeedsYouItem[] = [
  item({
    identity: "gate",
    source: "agent",
    leg: "park-on-human",
    workflow: { instanceId: "01GATE", workflowName: "acme-factory", stepId: "ship-signoff" },
  }),
  item({
    identity: "human",
    source: "agent",
    leg: "human-routed",
    workflow: { instanceId: "01HUMAN", workflowName: "linear-build", stepId: "build" },
  }),
  item({
    identity: "aware",
    source: "derived",
    leg: "awareness",
    derived: { kind: "awareness", evidence: "held by floor-lead@acme-factory · 30m", threshold: "awareness" },
    workflow: { instanceId: "01AWARE", workflowName: "acme-factory", stepId: "rework" },
  }),
  item({
    identity: "backstop",
    source: "derived",
    leg: "workflow-failed",
    derived: {
      kind: "workflow-failed",
      evidence: "MISSING-ITEM ANOMALY",
      threshold: "failed instances carry an exception item",
    },
    workflow: { instanceId: "01BACKSTOP", workflowName: "acme-factory" },
  }),
  // S2 overdue/stuck（production 不可达——4h 硬编码阈值，无 env
  // 覆盖）：其 NEEDS-YOU 行也必须渲染相同深链（qa2
  // 复审 #4——不仅 ExceptionBanner）。带 Q6 指针 + stuck step 处
  // ?step= 锚的精确状态行。
  item({
    identity: "overdue",
    source: "derived",
    leg: "stuck",
    derived: {
      kind: "stuck",
      evidence: "step inspect packet qitem-9 held by inspector@acme-factory — 4200s past the created_at anchor",
      threshold: "past the WF-1 deadline evaluator threshold",
    },
    workflow: { instanceId: "01OVERDUE", workflowName: "acme-factory", stepId: "inspect" },
  }),
];

function renderAccordion(band: NeedsYouBand) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <NeedsYouAccordion band={band} slice="acme" actorSession="floor-lead@acme-factory" ctx={{} as EvidenceContext} />
    ),
  });
  const instRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflow/instance/$instanceId",
    validateSearch: (s: Record<string, unknown>): { step?: string } => ({
      step: typeof s.step === "string" ? s.step : undefined,
    }),
    component: () => <div data-testid="instance-stub" />,
  });
  const routeTree = rootRoute.addChildren([indexRoute, instRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
  // NeedsYouAccordion 调 useInvalidateReview() → useQueryClient()，故
  // 渲染需要 QueryClientProvider；无它组件抛错且 band 渲染为空
  //（OPR.0.4.6.WF4 leg-8 test-only 修复；模式取自 rig-graph.test.tsx）。
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("WF-4 render-parity — the NEEDS-YOU deep-link across ALL FOUR kinds", () => {
  it("every kind renders the SAME row.workflow deep-link target (live ● gate/human + ▲ awareness/backstop + the overdue ● row)", async () => {
    const { getByTestId } = renderAccordion({ items: FOUR_KINDS, provenance: "test" });
    // TanStack Router 异步解析路由；查询行前先 await band
    //（OPR.0.4.6.WF4 leg-8 test-only 修复；模式：discovery-overlay）。
    await waitFor(() => expect(getByTestId("needs-you-band")).toBeTruthy());
    for (const row of FOUR_KINDS) {
      fireEvent.click(getByTestId(`needs-you-row-${row.identity}`));
      const link = getByTestId(`needs-you-workflow-link-${row.identity}`);
      const href = link.getAttribute("href") ?? "";
      // 每个 kind 结构相同：到 instance 路由的 anchor，
      // 从 item.workflow.instanceId 解析（Q6-P3：绝不从散文）。
      expect(href).toContain(`/workflow/instance/${row.workflow!.instanceId}`);
      if (row.workflow!.stepId) expect(href).toContain(`step=${row.workflow!.stepId}`);
      expect(link.textContent).toContain("查看实例");
    }
  });

  it("a non-workflow row renders NO deep-link (omit-when-absent render-parity)", async () => {
    const { getByTestId, queryByTestId } = renderAccordion({ items: [item({ identity: "plain" })], provenance: "test" });
    await waitFor(() => expect(getByTestId("needs-you-row-plain")).toBeTruthy());
    fireEvent.click(getByTestId("needs-you-row-plain"));
    expect(queryByTestId("needs-you-workflow-link-plain")).toBeNull();
  });
});

// --- ExceptionBanner 渲染对等：overdue（披露）vs failed（live）---

const EVIDENCE = {
  instanceId: "01OVERDUE",
  stepId: "inspect",
  packetId: "qitem-9",
  ownerSession: "inspector@acme-factory",
  packetState: "in-progress",
  anchor: "created_at" as const,
  anchorAt: "2026-07-07T00:00:00.000Z",
  overdueBySeconds: 4200,
  ageSeconds: 4200,
  claimedAt: null,
};

const inst = (over: Partial<WorkflowInstanceWithDeadline>): WorkflowInstanceWithDeadline => ({
  instanceId: "01INST",
  workflowName: "acme-factory",
  workflowVersion: "2",
  createdBySession: "floor-lead@acme-factory",
  createdAt: "2026-07-07T00:00:00.000Z",
  status: "active",
  currentFrontier: ["qitem-9"],
  currentStepId: "inspect",
  hopCount: 2,
  fallbackSynthesis: null,
  lastContinuationDecision: null,
  completedAt: null,
  version: 1,
  resumeCount: 0,
  hopsBaseline: 0,
  deadline: { state: "healthy", evidence: null },
  ...over,
});

describe("WF-4 render-parity — the ExceptionBanner (overdue disclosed vs failed live)", () => {
  it("the OVERDUE banner (S2, production-unreachable) renders the SAME banner element a live overdue instance would", () => {
    const overdue = inst({ status: "active", deadline: { state: "overdue-unclaimed", evidence: EVIDENCE } });
    const { getByTestId } = render(
      <ExceptionBanner instance={overdue} onResume={() => {}} resuming={false} resumeError={null} />,
    );
    const banner = getByTestId("workflow-exception-banner");
    expect(banner.textContent).toContain("逾期·未认领");
    expect(banner.textContent).toContain("inspector@acme-factory");
  });

  it("the FAILED banner (live) renders + wires Resume (route-from-web omitted)", () => {
    const failed = inst({ status: "failed", currentStepId: null, deadline: { state: "healthy", evidence: null } });
    const { getByTestId, queryByTestId } = render(
      <ExceptionBanner instance={failed} onResume={() => {}} resuming={false} resumeError={null} />,
    );
    expect(getByTestId("workflow-exception-banner").textContent).toContain("已失败");
    expect(getByTestId("workflow-resume")).toBeTruthy();
    // route-from-web 延后——无 re-route 可点击项渲染。
    expect(queryByTestId("workflow-route")).toBeNull();
  });
});
