import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { MissionScopePage, WorkspaceScopePage } from "../src/components/project/ScopePages.js";
import { TopologyOverlayProvider } from "../src/components/topology/topology-overlay-context.js";
import type { SliceDetail } from "../src/hooks/useSlices.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function makeDetail(name: string, missionId: string | null, qitemIds: string[]): SliceDetail {
  return {
    name,
    missionId,
    slicePath: `/workspace/${name}`,
    displayName: name,
    railItem: missionId,
    status: "active",
    rawStatus: "active",
    qitemIds,
    commitRefs: ["abc1234"],
    lastActivityAt: "2026-05-07T22:06:36.083Z",
    workflowBinding: null,
    story: {
      events: qitemIds[0] ? [{
        ts: "2026-05-07T22:06:36.083Z",
        kind: "queue.created",
        actorSession: "driver@rig",
        qitemId: qitemIds[0],
        phase: null,
        summary: `Created ${qitemIds[0]} for ${name}.`,
        detail: { sourceSession: "driver@rig", destinationSession: "human@host" },
      }] : [],
      phaseDefinitions: null,
    },
    acceptance: { totalItems: 1, doneItems: 1, percentage: 100, items: [], closureCallout: null, currentStep: null },
    decisions: { rows: [] },
    docs: { tree: [{ name: "README.md", relPath: "README.md", type: "file", size: 100, mtime: null }] },
    tests: {
      proofPackets: [{
        dirName: `${name}-proof`,
        primaryMarkdown: { relPath: "proof.md", content: "PASS" },
        additionalMarkdown: [],
        screenshots: ["screenshots/proof.png"],
        videos: [],
        traces: [],
        passFailBadge: "pass",
      }],
      aggregate: { passCount: 1, failCount: 0 },
    },
    topology: { affectedRigs: [{ rigId: "rig-1", rigName: "rig-1", sessionNames: ["driver@rig-1"] }], totalSeats: 1, specGraph: null },
  };
}

// V0.3.1 slice 12.5——工作区拓扑现通过 HostMultiRigGraph 渲染；测试可覆盖 /api/ps，
// 以验证 N=1 与 N=2 的工作组聚类路径。
type PsEntry = {
  rigId: string;
  name: string;
  nodeCount: number;
  runningCount: number;
  status: "running" | "partial" | "stopped";
  uptime: null;
  latestSnapshot: null;
};

const SINGLE_RIG_PS: PsEntry[] = [
  {
    rigId: "rig-1",
    name: "rig-1",
    nodeCount: 1,
    runningCount: 1,
    status: "running",
    uptime: null,
    latestSnapshot: null,
  },
];

function installFetchMock(opts: { psEntries?: PsEntry[] } = {}) {
  const psEntries = opts.psEntries ?? SINGLE_RIG_PS;
  mockFetch.mockImplementation(async (url: string) => {
    // MH-2：选择已知文件门禁需要本地主机 payload。
    if (url.includes("/api/hosts")) {
      return new Response(JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }), { status: 200 });
    }
    if (url.includes("/api/config")) {
      return new Response(
        JSON.stringify({ settings: { "workspace.root": { value: "/Users/admin/.openrig/workspace" } } }),
        { status: 200 },
      );
    }
    // HostMultiRigGraph 通过 /api/ps 获取工作组清单，并通过逐工作组
    // /api/rigs/<id>/graph 获取展开内容。提供最小响应，使切换测试渲染时不出现网络错误。
    if (url === "/api/ps" || url.startsWith("/api/ps?")) {
      return new Response(JSON.stringify(psEntries), { status: 200 });
    }
    const rigGraphMatch = url.match(/\/api\/rigs\/([^/]+)\/graph/);
    if (rigGraphMatch) {
      return new Response(JSON.stringify({ nodes: [], edges: [] }), { status: 200 });
    }
    if (url.includes("/api/slices/idea-ledger")) {
      return new Response(JSON.stringify(makeDetail("idea-ledger", "RELEASE-PROOF", ["qitem-A"])), { status: 200 });
    }
    if (url.includes("/api/slices/seed-slice-active")) {
      return new Response(JSON.stringify(makeDetail("seed-slice-active", null, [])), { status: 200 });
    }
    if (url.includes("/api/queue/qitem-A")) {
      return new Response(JSON.stringify({
        qitemId: "qitem-A",
        tsCreated: "2026-05-07T22:06:36.083Z",
        tsUpdated: "2026-05-07T22:06:36.083Z",
        sourceSession: "driver@rig",
        destinationSession: "human@host",
        state: "done",
        priority: "urgent",
        tier: "fast",
        tags: ["RELEASE-PROOF"],
        body: "Full queue body for workspace rollup.",
      }), { status: 200 });
    }
    if (url.includes("/api/slices?")) {
      return new Response(
        JSON.stringify({
          slices: [
            {
              name: "idea-ledger",
              displayName: "Idea Ledger release proof slice",
              railItem: "RELEASE-PROOF",
              status: "done",
              rawStatus: "done",
              qitemCount: 78,
              hasProofPacket: false,
              lastActivityAt: "2026-05-07T22:06:36.083Z",
            },
            {
              name: "seed-slice-active",
              displayName: "seed-slice-active",
              railItem: null,
              status: "active",
              rawStatus: "active",
              qitemCount: 0,
              hasProofPacket: false,
              lastActivityAt: "2000-01-01T00:00:00.000Z",
            },
          ],
          totalCount: 2,
          filter: "all",
        }),
        { status: 200 },
      );
    }
    return new Response("[]");
  });
}

function renderWorkspaceScope(
  opts: { psEntries?: PsEntry[] } = {},
): ReturnType<typeof render> {
  installFetchMock(opts);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // V0.3.1 slice 12.5——TopologyOverlayProvider 必须位于 router 内部，因为
  // HostMultiRigGraph 依赖 useRouterState；所以包装根路由组件中的 <Outlet />，
  // 而不是包装 RouterProvider。
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project",
    component: () => <WorkspaceScopePage />,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/project"] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function renderMissionScope(): ReturnType<typeof render> {
  installFetchMock();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // V0.3.1 slice 12.5——未声明 specGraph 时，任务目标工作范围的拓扑回退仍使用
  // ScopeTopologyRollup，因此此处不严格要求 TopologyOverlayProvider。仍加以包装，以便与上方
  // 工作区辅助函数保持对称，也让未来验证 HostMultiRigGraph 形态回退的测试拥有可用上下文。
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
  const missionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/mission/$missionId",
    component: () => <MissionScopePage />,
  });
  const sliceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/slice/$sliceId",
    component: () => null,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([missionRoute, sliceRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/project/mission/RELEASE-PROOF"] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("WorkspaceScopePage overview", () => {
  // OPR.0.4.1.24——工作区父层级现在落在跨任务目标组合视图，取代原有
  // WorkspaceOverviewPanel 任务目标网格。完整组合行为由 workspace-portfolio.test.tsx 覆盖；
  // 这些集成检查断言入口会在真实外壳中挂载组合视图。
  it("OPR.0.4.1.24: the workspace overview lands on the cross-mission portfolio, missions derived from the slice index", async () => {
    const { findByTestId } = renderWorkspaceScope();

    expect(await findByTestId("workspace-portfolio")).toBeTruthy();
    // 任务目标通过对 slices 分组派生：idea-ledger → RELEASE-PROOF；无 railItem 的 slice →
    // unsorted。每个任务目标都是折叠行。
    expect(await findByTestId("portfolio-mission-RELEASE-PROOF")).toBeTruthy();
    expect(await findByTestId("portfolio-mission-unsorted")).toBeTruthy();
  });

  it("OPR.0.4.1.24: portfolio rows are collapsed by default with an Open-mission jump", async () => {
    const { findByTestId, queryByTestId } = renderWorkspaceScope();
    // 每个任务目标行都有跳转到其页面的“打开”入口。
    expect(await findByTestId("portfolio-open-RELEASE-PROOF")).toBeTruthy();
    // 默认折叠：展开前没有引导概览，也不会获取 MISSION_BRIEF。
    expect(queryByTestId("portfolio-glance-RELEASE-PROOF")).toBeNull();
    expect(queryByTestId("portfolio-glance-loading-RELEASE-PROOF")).toBeNull();
    expect(queryByTestId("portfolio-glance-empty-RELEASE-PROOF")).toBeNull();
  });

  it("workspace progress, queue, and topology tabs render aggregate scoped data", async () => {
    const { findByTestId } = renderWorkspaceScope();

    fireEvent.click(await findByTestId("project-tab-story"));
    expect(await findByTestId("scope-story-rollup")).toBeTruthy();
    // OPR.0.4.1.19——“故事”标签页现在是队列谱系 git 图：每个 qitem 一行，以 qitemId 为键；
    // 缺少摘要时降级为正文首行。
    expect((await findByTestId("story-row-qitem-A")).textContent).toContain("Full queue body");

    fireEvent.click(await findByTestId("project-tab-progress"));
    expect(await findByTestId("scope-progress-rollup")).toBeTruthy();

    fireEvent.click(await findByTestId("project-tab-proof"));
    expect(await findByTestId("proof-tab")).toBeTruthy();

    fireEvent.click(await findByTestId("project-tab-queue"));
    expect(await findByTestId("scope-queue-rollup")).toBeTruthy();
    expect((await findByTestId("scope-queue-trigger-qitem-A")).textContent).toContain("Full queue body");

    // V0.3.1 slice 12.5——工作区拓扑现通过 HostMultiRigGraph 渲染，把工作组显示为独立
    // 视觉集群，而不是平铺会话名的 ScopeTopologyRollup。任务目标工作范围未声明 specGraph 时，
    // 拓扑回退仍使用 ScopeTopologyRollup。
    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("workspace-topology-hostmultirig")).toBeTruthy();
    expect(await findByTestId("host-multi-rig-graph")).toBeTruthy();
  });

  // V0.3.1 slice 12.5 HG-3——N=1 工作组 fixture 在工作区拓扑表面清晰渲染为单个工作组集群，
  // 不平铺聚合会话名。
  it("slice 12.5 HG-3: single-rig workspace renders a single rig cluster on /topology", async () => {
    const { findByTestId, queryByTestId } = renderWorkspaceScope({
      psEntries: SINGLE_RIG_PS,
    });
    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("workspace-topology-hostmultirig")).toBeTruthy();
    expect(await findByTestId("host-multi-rig-graph")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-1")).toBeTruthy();
    expect(queryByTestId("rig-group-node-rig-2")).toBeNull();
    // 向后兼容：工作区拓扑表面不再挂载旧版平铺会话名汇总。
    expect(queryByTestId("scope-topology-rollup")).toBeNull();
  });

  // V0.3.1 slice 12.5 HG-2——N>=2 工作组 fixture 渲染为不同视觉集群。它与 slice 05
  //（kernel-rig-as-default 交付多工作组工作区）共同作用：没有工作组聚类时，kernel 智能体会让
  // 平铺视图更嘈杂；加入聚类后，工作组增多时结构仍清晰可读。
  it("slice 12.5 HG-2: multi-rig workspace renders distinct rig clusters on /topology", async () => {
    const { findByTestId } = renderWorkspaceScope({
      psEntries: [
        ...SINGLE_RIG_PS,
        {
          rigId: "rig-2",
          name: "openrig-kernel",
          nodeCount: 2,
          runningCount: 2,
          status: "running",
          uptime: null,
          latestSnapshot: null,
        },
      ],
    });
    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("workspace-topology-hostmultirig")).toBeTruthy();
    expect(await findByTestId("host-multi-rig-graph")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-1")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-2")).toBeTruthy();
  });

  it("mission scope page filters workspace data to that mission", async () => {
    const { findByTestId, queryByText } = renderMissionScope();

    // OPR.0.4.1.17：任务目标现在默认进入“引导”标签页；导航到“概览”以断言任务目标概览筛选行为。
    fireEvent.click(await findByTestId("project-tab-overview"));
    expect(await findByTestId("mission-overview-panel")).toBeTruthy();
    expect((await findByTestId("mission-overview-panel")).textContent).toContain("Idea Ledger release proof slice");
    expect((await findByTestId("mission-overview-slice-idea-ledger-qitems")).textContent).toContain("78");
    expect((await findByTestId("mission-overview-slice-idea-ledger-status")).getAttribute("data-tone")).toBe("success");
    expect(queryByText("seed-slice-active")).toBeNull();

    fireEvent.click(await findByTestId("project-tab-queue"));
    expect((await findByTestId("scope-queue-trigger-qitem-A")).textContent).toContain("Full queue body");

    fireEvent.click(await findByTestId("project-tab-story"));
    expect(await findByTestId("scope-story-rollup")).toBeTruthy();
    expect(queryByText("seed-slice-active")).toBeNull();
  });
});
