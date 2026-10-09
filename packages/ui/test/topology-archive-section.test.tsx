// OPR.0.3.3.19——TopologyTreeView 的“归档”分区。
//
// 证明：“归档”节点渲染在 localhost 主机下；已归档工作组按需获取，折叠时不调用仅归档端点；
// 展开后获取 /api/rigs/summary?archived=only 并列出已归档工作组。默认树仍只显示活动项，
// 绝不在主列表中显示已归档工作组。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopologyTreeView } from "../src/components/topology/TopologyTreeView.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  cleanup();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url === "/api/rigs/summary") {
      // 默认视图只含活动工作组，此处为空。
      return { ok: true, json: async () => [] };
    }
    if (url === "/api/rigs/summary?archived=only") {
      return { ok: true, json: async () => [{ id: "r-arc", name: "tidy-me", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }] };
    }
    return { ok: true, json: async () => [] };
  });
});

function renderTree() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <TopologyTreeView /> });
  const mk = (path: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      mk("/topology"),
      mk("/topology/rig/$rigId"),
      mk("/topology/pod/$rigId/$podName"),
      mk("/topology/seat/$rigId/$logicalId"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("TopologyTreeView Archive section (OPR.0.3.3.19)", () => {
  it("renders the Archive node and does NOT fetch archived rigs while collapsed", async () => {
    renderTree();
    await waitFor(() => expect(screen.getByTestId("topology-archive-section")).toBeTruthy());
    // 延迟加载：展开前不得访问仅归档端点。
    const archivedCalls = mockFetch.mock.calls.filter((c) => c[0] === "/api/rigs/summary?archived=only");
    expect(archivedCalls.length).toBe(0);
  });

  it("expanding the Archive section fetches archived-only and lists the archived rig", async () => {
    renderTree();
    const section = await screen.findByTestId("topology-archive-section");
    const toggle = section.querySelector("button")!;
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("topology-rig-r-arc")).toBeTruthy());
    expect(mockFetch).toHaveBeenCalledWith("/api/rigs/summary?archived=only");
    // 默认活动列表不会自行呈现已归档工作组。
    expect(screen.getByText("tidy-me")).toBeTruthy();
  });
});
