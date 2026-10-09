// V1 attempt-3 Phase 5 P5-2——SliceScopePage tab 内容管道可达性。
//
// 每个规范 slice tab（story/overview/progress/artifacts/tests/queue/
// topology）在 /api/slices/:name 解析后渲染其挂载组件。Loading + 错误状态
// 各自有 EmptyState 渲染。折叠映射（AcceptanceTab -> progress；
// ArtifactsNavigator -> artifacts 按 OPR.0.4.1 AC-4-FF；
// QueueItemTrigger -> queue）经 testid 存在性验证。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { SliceScopePage } from "../src/components/project/ScopePages.js";
import type { SliceDetail } from "../src/hooks/useSlices.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderSliceScope(opts: {
  sliceId: string;
  detail?: SliceDetail | null;
  status?: number;
}): { setSelection: ReturnType<typeof vi.fn> } & ReturnType<typeof render> {
  const setSelection = vi.fn();
  // mock /api/slices/:name 响应。
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes(`/api/slices/${opts.sliceId}/doc/`)) {
      return new Response(JSON.stringify({ relPath: "README.md", content: "# Readme" }), { status: 200 });
    }
    if (url.includes(`/api/slices/${opts.sliceId}`)) {
      if (opts.status && opts.status !== 200) {
        return new Response("not found", { status: opts.status });
      }
      return new Response(JSON.stringify(opts.detail), { status: 200 });
    }
    if (url.includes("/api/queue/qitem-A")) {
      return new Response(JSON.stringify(makeQueueItem("qitem-A", "Body for qitem-A")));
    }
    if (url.includes("/api/queue/qitem-B")) {
      return new Response(JSON.stringify(makeQueueItem("qitem-B", "Body for qitem-B")));
    }
    if (url.includes("/api/files/roots")) {
      // OPR.0.4.1 AC-4-FF：Artifacts tab 现挂载 ArtifactsNavigator。无
      // allowlist root 时它确定性渲染其不可用 setup 提示（仅 navigator
      // 渲染该 testid——证明从 card wall 切换）。
      return new Response(JSON.stringify({ roots: [] }));
    }
    return new Response("[]");
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const sliceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/slice/$sliceId",
    component: () => (
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
        <SliceScopePage />
      </DrawerSelectionContext.Provider>
    ),
  });
  // stub tab 可能尝试 Link 的其他路由（TopologyTab 用 /topology/seat/...
  // 链接等）。
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([sliceRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: [`/project/slice/${opts.sliceId}`] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { setSelection, ...utils };
}

function makeQueueItem(qitemId: string, body: string) {
  return {
    qitemId,
    tsCreated: "2026-05-06T18:00:00Z",
    tsUpdated: "2026-05-06T18:00:00Z",
    sourceSession: "source@rig",
    destinationSession: "dest@rig",
    state: "in-progress",
    priority: "routine",
    tier: "mode2",
    tags: ["demo"],
    body,
  };
}

function makeDetail(overrides: Partial<SliceDetail> = {}): SliceDetail {
  return {
    name: "idea-ledger",
    displayName: "Idea Ledger",
    railItem: null,
    status: "active",
    rawStatus: "active",
    qitemIds: ["qitem-A", "qitem-B"],
    commitRefs: ["abc1234"],
    lastActivityAt: "2026-05-06T18:00:00Z",
    workflowBinding: null,
    story: { events: [], phaseDefinitions: null },
    acceptance: {
      totalItems: 3,
      doneItems: 1,
      percentage: 33,
      items: [
        {
          text: "item one",
          done: true,
          source: { file: "PROGRESS.md", line: 1 },
        },
      ],
      closureCallout: null,
      currentStep: null,
    },
    decisions: { rows: [] },
    docs: { tree: [{ name: "README.md", relPath: "README.md", type: "file" } as any] },
    tests: { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } },
    topology: { affectedRigs: [], totalSeats: 0, specGraph: null },
    ...overrides,
  };
}

describe("SliceScopePage P5-2 tab content piping", () => {
  it("loading state renders EmptyState with slice id", async () => {
    // 不 resolve fetch——保持 query in-flight。
    mockFetch.mockImplementation(() => new Promise(() => {}));
    const { findByTestId } = renderSliceScope({ sliceId: "idea-ledger", detail: null });
    expect(await findByTestId("slice-scope-loading")).toBeTruthy();
  });

  it("error/404 renders EmptyState with not-available message", async () => {
    const { findByTestId } = renderSliceScope({ sliceId: "missing-slice", status: 404 });
    expect(await findByTestId("slice-scope-error")).toBeTruthy();
  });

  it("default landing tab is 'review' for P2 needs-you review; story tab still mounts TimelineTab when activated", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    // ScopeShell 挂载；project-tab-nav 已渲染。
    await findByTestId("project-tab-nav");
    // OPR.0.4.4.20 FR-4——P2 把 slices 先落在 Review，使 NEEDS YOU
    // 和 phase-aware compare 成为首个可见表面。
    const reviewTab = container.querySelector("[data-testid='project-tab-review']");
    const overviewTab = container.querySelector("[data-testid='project-tab-overview']");
    const storyTabBefore = container.querySelector("[data-testid='project-tab-story']");
    expect(reviewTab?.getAttribute("data-active")).toBe("true");
    expect(overviewTab?.getAttribute("data-active")).toBe("false");
    expect(storyTabBefore?.getAttribute("data-active")).toBe("false");
    // 点 story tab 仍激活 TimelineTab 面板。
    fireEvent.click(storyTabBefore!);
    const storyTabAfter = container.querySelector("[data-testid='project-tab-story']");
    expect(storyTabAfter?.getAttribute("data-active")).toBe("true");
  });

  it("OPR.0.4.1.20: the project-area Topology tab is relabeled WORKFLOW (id stays 'topology')", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    // id 稳定重命名：tab 保持 id=topology（路由 / 活动状态 / test-id 不变），
    // 但可见标签现为 Workflow。
    const tab = container.querySelector("[data-testid='project-tab-topology']");
    expect(tab).toBeTruthy();
    expect(tab?.textContent).toContain("工作流");
    expect(tab?.textContent).not.toContain("拓扑");
  });

  it("progress tab mounts AcceptanceTab (FOLDED per code-map)", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-progress']")!);
    // AcceptanceTab 渲染带百分比的 header 进度条。冒烟测试：tabpanel 存在
    // 且不显示占位。
    await waitFor(() => {
      expect(container.querySelector("[data-testid='project-tab-placeholder-slice progress']")).toBeNull();
    });
  });

  it("artifacts tab mounts the ArtifactsNavigator; the old Files/Commits/Docs/Decisions card wall is gone (OPR.0.4.1 AC-4-FF)", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-artifacts']")!);
    // slice Artifacts 视图现即 ArtifactsNavigator（slice 21 在 slice 高度的
    // 模式）。无 allowlist root 时挂载 navigator 不可用 setup 提示——仅
    // navigator 渲染此，证明从 card wall 切换。
    expect(await findByTestId("artifacts-navigator-unavailable")).toBeTruthy();
    // 被弃 section 消失：Commits + Decisions 重新归位；Files + Docs 被
    // navigator 吞并；SliceArtifactsTab 包装移除。
    expect(container.querySelector("[data-testid='slice-artifacts-tab']")).toBeNull();
    expect(container.querySelector("[data-testid='slice-artifacts-files']")).toBeNull();
    expect(container.querySelector("[data-testid='slice-artifacts-commits']")).toBeNull();
    expect(container.querySelector("[data-testid='slice-artifacts-docs']")).toBeNull();
    expect(container.querySelector("[data-testid='slice-artifacts-decisions']")).toBeNull();
  });

  it("overview tab mounts a distinct summary surface rather than the docs browser", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-overview']")!);
    expect(await findByTestId("slice-overview-tab")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-overview-summary']")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-overview-current-step']")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-artifacts-docs']")).toBeNull();
  });

  it("queue tab lists qitemIds wrapped in QueueItemTrigger; click fires setSelection", async () => {
    const { container, findByTestId, setSelection } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-queue']")!);
    const trigger = await findByTestId("slice-queue-trigger-qitem-A");
    await waitFor(() => expect(trigger.textContent).toContain("Body for qitem-A"));
    fireEvent.click(trigger);
    expect(setSelection).toHaveBeenCalledWith({
      type: "qitem",
      data: {
        qitemId: "qitem-A",
        source: "source@rig",
        destination: "dest@rig",
        state: "in-progress",
        tags: ["demo"],
        createdAt: "2026-05-06T18:00:00Z",
        body: "Body for qitem-A",
      },
    });
  });

  it("queue tab empty-state when slice has no qitemIds", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail({ qitemIds: [] }),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-queue']")!);
    expect(await findByTestId("slice-queue-empty")).toBeTruthy();
  });

  it("topology tab mounts TopologyTab", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-topology']")!);
    // 无 rigs + 无 specGraph 时 TopologyTab 渲染空状态；tab 面板本身只需
    // 存在 + 无占位。
    await waitFor(() => {
      expect(container.querySelector("[data-testid='project-tab-placeholder-slice topology']")).toBeNull();
    });
  });

  it("proof tab mounts SliceProofTab (Tests renamed → Proof, OPR.0.4.1.23)", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-proof']")!);
    // PROOF tab 经 /api/files 原样投影 slice 的 proof/ + PROOF.md。
    expect(await findByTestId("proof-tab")).toBeTruthy();
  });
});
