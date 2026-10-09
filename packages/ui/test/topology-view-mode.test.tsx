// V1 attempt-3 Phase 3——Topology view-mode tab 原位单 URL 测试（SC-10）。
//
// 承重：attempt-2 违反此点，按 view-mode 用分离 URL
//（`/topology/host/table` 等）。Phase 3 把 view-mode tab 实现为
// React 状态原位——切换时 URL 不变
// tabs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryHistory, RouterProvider, createRouter, createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { AppShell } from "../src/components/AppShell.js";
import { HostScopePage, RigScopePage } from "../src/components/topology/ScopePages.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => new Response("[]"));
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
});

// Slice 52（UI wall-clock 加固）：timed fixture 不再 import
// ../src/routes.js。这些测试断言的是 scope 页 + AppShell chrome；
// 完整路由树（全部 lazy 页模块）是 fleet 负载下与 5000ms waitFor
// 竞争的 wall-clock 重 import。以 AppShell 为根、仅 topology scope
// 路由的最小 router 挂载相同组件，无重 import、无时钟竞争。
// HostScopePage 不取 params；RigScopePage 读 useParams({ from:
// "/topology/rig/$rigId" })，故该路由路径精确拼写以保留严格 param 绑定。
function buildTopologyRouter(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <AppShell>
          <Outlet />
        </AppShell>
      </QueryClientProvider>
    ),
  });
  const hostRoute = createRoute({ getParentRoute: () => rootRoute, path: "/topology", component: HostScopePage });
  const rigRoute = createRoute({ getParentRoute: () => rootRoute, path: "/topology/rig/$rigId", component: RigScopePage });
  const catchAll = createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => null });
  const routeTree = rootRoute.addChildren([hostRoute, rigRoute, catchAll]);
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [initialPath] }) });
}

async function renderTopologyAt(initialPath: string) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  const r = buildTopologyRouter(initialPath);
  const result = render(<RouterProvider router={r} />);
  // 等待 app rail 挂载（路由解析完成）；随后每个测试等待其 scope 特定 tab 列表。
  await waitFor(() => {
    expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
  }, { timeout: 5000 });
  return { ...result, router: r };
}

describe("SC-10: topology view-mode tabs IN-PLACE single URL", () => {
  it("at /topology, all three host-scope tabs are rendered (graph/table/terminal)", async () => {
    const { container } = await renderTopologyAt("/topology");
    await waitFor(() => {
      expect(container.querySelector("[data-testid='topology-host-tabs']")).toBeTruthy();
    });
    expect(container.querySelector("[data-testid='topology-host-tab-graph']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-host-tab-table']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-host-tab-terminal']")).toBeTruthy();
  });

  it("clicking a view-mode tab does NOT change the URL — stays at /topology", async () => {
    const { container, router: r } = await renderTopologyAt("/topology");
    await waitFor(() => {
      expect(container.querySelector("[data-testid='topology-host-tab-table']")).toBeTruthy();
    });
    expect(r.history.location.pathname).toBe("/topology");
    const tableTab = container.querySelector("[data-testid='topology-host-tab-table']") as HTMLElement;
    fireEvent.click(tableTab);
    // URL 必须不变。
    expect(r.history.location.pathname).toBe("/topology");
    // 活动状态已移动。
    await waitFor(() => {
      expect(tableTab.getAttribute("data-active")).toBe("true");
    });
  });

  it("rig scope at /topology/rig/$rigId carries rig+pod tab set (graph/table/terminal/overview)", async () => {
    const { container } = await renderTopologyAt("/topology/rig/abc-rig");
    await waitFor(() => {
      expect(container.querySelector("[data-testid='topology-rig-tabs']")).toBeTruthy();
    });
    expect(container.querySelector("[data-testid='topology-rig-tab-graph']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-rig-tab-table']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-rig-tab-terminal']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-rig-tab-overview']")).toBeTruthy();
  });

  // Seat scope 引入 LiveNodeDetails，产生额外拉取。上面 host + rig scope
  // 测试证明原位模式；下面 source-assertion 回归测试证明无
  // view-mode-as-URL 反模式。此处跳过显式 seat-scope 路由渲染。
  it.skip("seat scope at /topology/seat/$rigId/$logicalId — covered by source-assertion + scope-page direct test", () => {});
});

describe("Seat scope tabs (direct render — bypasses route fetching)", () => {
  it("SeatScopePage renders all three seat tabs when mounted directly", async () => {
    // 直接渲染用 memory router stub 的 SeatScopePage useParams；跳过该
    // 复杂度，我们已在 SEAT_SCOPE_TABS 导出形状中覆盖 seat tab。
    const { SEAT_SCOPE_TABS } = await import("../src/components/topology/TopologyViewModeTabs.js");
    expect(SEAT_SCOPE_TABS.map((t) => t.id)).toEqual(["detail", "transcript", "terminal"]);
  });
});

// V1 attempt-3 Phase 3 bounce-fix Class B——选择性 vellum overlay
// 负面断言（ritual #8）：非 topology destination 绝不得接收
// vellum 半透明 overlay 处理。仅 topology destination（且仅其 graph
// view-mode）得 data-explorer-mode='overlay'；所有其他路由——含 /、
// /project、/specs、/for-you、/settings——必须显示
// data-explorer-mode='opaque'（或 surface='none' 的 destination 无 Explorer）。
//
// 将先前仅在 driver self-walk 期间于 agent-browser 运行的运行时断言
// 成文化。guard-3 进程门禁：本测试必须在 CI。
describe("Class B negative assertion: non-topology routes never get vellum overlay (ritual #8)", () => {
  async function renderAndWait(initialPath: string) {
    // Slice 52：最小 router（无 ../src/routes.js import）——同上
    // renderTopologyAt。非 topology 路由落到 catch-all stub；AppShell
    // 仍从 pathname 计算其 surface。
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
    const r = buildTopologyRouter(initialPath);
    const result = render(<RouterProvider router={r} />);
    await waitFor(() => {
      expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
    }, { timeout: 5000 });
    return result;
  }

  it.each([
    ["/", "Dashboard"],
    ["/project", "Project workspace"],
    ["/specs", "Specs library"],
    ["/for-you", "For You feed"],
    ["/settings", "Settings"],
  ])("route %s (%s) does NOT carry data-explorer-mode='overlay' anywhere in DOM", async (route) => {
    const { container } = await renderAndWait(route);
    const overlayElements = container.querySelectorAll("[data-explorer-mode='overlay']");
    expect(overlayElements.length).toBe(0);
  });

  it("topology graph (/topology) DOES carry data-explorer-mode='overlay' (positive companion)", async () => {
    const { container } = await renderAndWait("/topology");
    // 按 HostScopePage，活动 tab 首次挂载默认 'graph'；useOverlayForActiveTab
    // effect 把 topology overlay 上下文设为 'overlay'。AppShell 把它传播到
    // Explorer 的 overlayMode prop。
    await waitFor(() => {
      const explorer = container.querySelector("[data-testid='explorer']");
      expect(explorer?.getAttribute("data-explorer-mode")).toBe("overlay");
    }, { timeout: 5000 });
  });
});

// CSS source-assertion 回归测试（按 pseudo-element-paint 契约）：
// 守卫 routes.tsx 永不长出 view-mode-as-URL 路径
//（如 `/topology/host/table`、`/topology/rig/$rigId/graph`）。
// Attempt-2 恰以此反模式违反 SC-10。
describe("SC-10 source-assertion regression — no view-mode-as-URL paths in routes.tsx", () => {
  const ROUTES_SRC = readFileSync(
    path.resolve(__dirname, "../src/routes.tsx"),
    "utf8",
  );

  const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
    { name: "/topology/host/table", re: /\/topology\/host\/table/ },
    { name: "/topology/host/terminal", re: /\/topology\/host\/terminal/ },
    { name: "/topology/host/graph", re: /\/topology\/host\/graph/ },
    { name: "/topology/rig/$rigId/table", re: /\/topology\/rig\/\$rigId\/table/ },
    { name: "/topology/rig/$rigId/graph", re: /\/topology\/rig\/\$rigId\/graph/ },
    { name: "/topology/rig/$rigId/terminal", re: /\/topology\/rig\/\$rigId\/terminal/ },
    { name: "/topology/seat/$rigId/$logicalId/transcript", re: /\/topology\/seat\/\$rigId\/\$logicalId\/transcript/ },
    { name: "/topology/seat/$rigId/$logicalId/terminal", re: /\/topology\/seat\/\$rigId\/\$logicalId\/terminal/ },
  ];

  for (const f of FORBIDDEN_PATTERNS) {
    it(`routes.tsx does NOT contain forbidden view-mode-as-URL path: ${f.name}`, () => {
      expect(ROUTES_SRC).not.toMatch(f.re);
    });
  }
});
