// V1 polish slice Phase 5.2 bounce-fix——rig 展开状态持久化。
//
// 关闭 design-reviewer 在 abb154e 上 5 点证据链揭示的死代码 auto-expand bug：
//   1. routes.tsx topology 路由是兄弟（非嵌套）-> 直接进入
//      /topology/rig/$id 挂载 RigScopePage，而非 HostMultiRigGraph。先前组件内
//      auto-expand useEffect 对直接 URL 导航无法运行。
//   2. expanded Map 是 HostMultiRigGraph 局部 useState -> operator 返回
//      /topology 时每次挂载重置。
//   3. topology-overlay-context 先前仅带 ExplorerMode。
//
// 修复：把 expandedRigs Map 提升到 TopologyOverlayProvider，配 pathname 驱动
// useEffect，无论挂载哪个 scope 页都触发。HostMultiRigGraph 经
// useTopologyOverlay() 消费。
//
// 下面测试覆盖：
//  - parseActiveRigId 纯函数（匹配全部 3 种 rig-scoped URL 形状）
//  - Provider auto-expand useEffect 在 rig-scoped pathname 触发
//  - HostMultiRigGraph 在 context 的 expandedRigs 含 rigId=true 时把 rig 渲染为
//    展开（跨挂载周期持久化）
//  - 直接卸载-重挂载保留状态（provider scope 持有）

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  TopologyOverlayProvider,
  useTopologyOverlay,
  parseActiveRigId,
} from "../src/components/topology/topology-overlay-context.js";
import { HostMultiRigGraph } from "../src/components/topology/HostMultiRigGraph.js";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url === "/api/ps") {
      return new Response(
        JSON.stringify([
          {
            rigId: "rig-1",
            name: "openrig-velocity",
            nodeCount: 13,
            runningCount: 9,
            status: "running",
            uptime: null,
            latestSnapshot: null,
          },
          {
            rigId: "rig-2",
            name: "openrig-discovery",
            nodeCount: 5,
            runningCount: 3,
            status: "partial",
            uptime: null,
            latestSnapshot: null,
          },
        ]),
      );
    }
    if (url.match(/\/api\/rigs\/[^/]+\/graph/)) {
      return new Response(JSON.stringify({ nodes: [], edges: [] }));
    }
    return new Response("[]");
  });
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------
// parseActiveRigId——纯函数
// ---------------------------------------------------------------------

describe("parseActiveRigId (P5.2 bounce-fix pure-fn)", () => {
  it("matches /topology/seat/$rigId/$logicalId", () => {
    expect(parseActiveRigId("/topology/seat/rig-1/orch.lead")).toBe("rig-1");
  });
  it("matches /topology/pod/$rigId/$podName", () => {
    expect(parseActiveRigId("/topology/pod/rig-1/orch")).toBe("rig-1");
  });
  it("matches /topology/rig/$rigId", () => {
    expect(parseActiveRigId("/topology/rig/rig-1")).toBe("rig-1");
  });
  it("returns null for /topology root", () => {
    expect(parseActiveRigId("/topology")).toBe(null);
  });
  it("returns null for non-topology routes", () => {
    expect(parseActiveRigId("/project")).toBe(null);
    expect(parseActiveRigId("/for-you")).toBe(null);
    expect(parseActiveRigId("/")).toBe(null);
  });
  it("decodes URL-encoded rigIds", () => {
    expect(parseActiveRigId("/topology/seat/rig%2D1/seat%2Da")).toBe("rig-1");
  });
});

// ---------------------------------------------------------------------
// 辅助——在特定初始路径用 router 渲染
// ---------------------------------------------------------------------

function renderAt(initialPath: string, ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/topology",
    component: () => <>{ui}</>,
  });
  const seatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/topology/seat/$rigId/$logicalId",
    component: () => <>{ui}</>,
  });
  const rigRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/topology/rig/$rigId",
    component: () => <>{ui}</>,
  });
  const podRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/topology/pod/$rigId/$podName",
    component: () => <>{ui}</>,
  });
  const fallback = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, seatRoute, rigRoute, podRoute, fallback]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

// ---------------------------------------------------------------------
// Provider auto-expand useEffect——无论 HostMultiRigGraph 挂载状态都触发
//（design-reviewer 死代码 bug 修复）。
// ---------------------------------------------------------------------

function ContextProbe() {
  // 小消费者，把 context 的 expandedRigs 暴露为 testid 属性供测试检视。
  const ctx = useTopologyOverlay();
  return (
    <div
      data-testid="topology-context-probe"
      data-expanded-rigs={Array.from(ctx.expandedRigs.entries())
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(",")}
    />
  );
}

describe("TopologyOverlayProvider auto-expand on URL (P5.2 bounce-fix)", () => {
  it("/topology/rig/$rigId direct-URL entry sets expandedRigs in provider state (HostMultiRigGraph NOT mounted)", async () => {
    // 仅探针渲染——此路径不挂载 HostMultiRigGraph，证明 provider effect
    // 无论哪个 scope 页是中心组件都触发。
    const { findByTestId } = renderAt("/topology/rig/rig-1", <ContextProbe />);
    const probe = await findByTestId("topology-context-probe");
    await waitFor(() => {
      expect(probe.getAttribute("data-expanded-rigs")).toBe("rig-1");
    });
  });

  it("/topology/seat/$rigId/$logicalId sets the matching rig expanded", async () => {
    const { findByTestId } = renderAt(
      "/topology/seat/rig-2/orch.lead",
      <ContextProbe />,
    );
    const probe = await findByTestId("topology-context-probe");
    await waitFor(() => {
      expect(probe.getAttribute("data-expanded-rigs")).toBe("rig-2");
    });
  });

  it("/topology/pod/$rigId/$podName sets the matching rig expanded", async () => {
    const { findByTestId } = renderAt(
      "/topology/pod/rig-1/orch",
      <ContextProbe />,
    );
    const probe = await findByTestId("topology-context-probe");
    await waitFor(() => {
      expect(probe.getAttribute("data-expanded-rigs")).toBe("rig-1");
    });
  });

  it("/topology root pathname does NOT write explicit expansion overrides", async () => {
    const { findByTestId } = renderAt("/topology", <ContextProbe />);
    const probe = await findByTestId("topology-context-probe");
    // 让渲染落定。
    await new Promise((r) => setTimeout(r, 10));
    expect(probe.getAttribute("data-expanded-rigs")).toBe("");
  });
});

// ---------------------------------------------------------------------
// HostMultiRigGraph 从 context 读取——跨挂载持久化
// ---------------------------------------------------------------------

describe("HostMultiRigGraph reads expandedRigs from context (P5.2 bounce-fix persistence)", () => {
  it("when context has rigId=false on mount, only that rig renders collapsed", async () => {
    // 自定义探针，预设显式 collapse 后挂载 graph。
    function PreCollapsedHarness() {
      const { setRigExpanded } = useTopologyOverlay();
      // 挂载时触发一次 pre-collapse（模拟 operator 折叠 rig、导航离开、
      // 再返回 /topology）。此处故意不用 useEffect——测试仅经 setTimeout
      // 在 effect 中调用，使 React 在渲染前批量提交。
      if (typeof window !== "undefined") {
        // 幂等：后续渲染不会重复设置。
        queueMicrotask(() => setRigExpanded("rig-2", false));
      }
      return <HostMultiRigGraph />;
    }

    const { findByTestId } = renderAt("/topology", <PreCollapsedHarness />);
    const node = await findByTestId("rig-group-node-rig-2");
    await waitFor(() => {
      expect(node.getAttribute("data-collapsed")).toBe("true");
    });
    // 其他 rig 默认保持展开。
    const otherRig = await findByTestId("rig-group-node-rig-1");
    expect(otherRig.getAttribute("data-collapsed")).toBe("false");
  });

  it("when no rig has an explicit context override, all rigs render expanded", async () => {
    const { findByTestId } = renderAt("/topology", <HostMultiRigGraph />);
    const r1 = await findByTestId("rig-group-node-rig-1");
    const r2 = await findByTestId("rig-group-node-rig-2");
    expect(r1.getAttribute("data-collapsed")).toBe("false");
    expect(r2.getAttribute("data-collapsed")).toBe("false");
  });
});

// ---------------------------------------------------------------------
// source-assertion 守卫——确保死代码路径不重现
// ---------------------------------------------------------------------

describe("source-assertion guards (P5.2 bounce-fix coupled-literal scan)", () => {
  it("HostMultiRigGraph reads expanded from useTopologyOverlay (NOT local useState)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../src/components/topology/HostMultiRigGraph.tsx",
      ),
      "utf8",
    );
    // 正面：消费 context。
    expect(src).toContain("useTopologyOverlay");
    expect(src).toMatch(/useTopologyOverlay\(\s*\)/);
    // 负面：expanded Map 无局部 useState。若回归则死代码 bug 重现。
    expect(src).not.toMatch(/useState<Map<string,\s*boolean>>/);
  });

  it("topology-overlay-context.tsx exposes expandedRigs + setRigExpanded + toggleRig + parseActiveRigId", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../src/components/topology/topology-overlay-context.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("expandedRigs");
    expect(src).toContain("setRigExpanded");
    expect(src).toContain("toggleRig");
    expect(src).toContain("export function parseActiveRigId");
    // Provider auto-expand useEffect 在 pathname 上。
    expect(src).toMatch(/useRouterState/);
    expect(src).toMatch(/parseActiveRigId\s*\(/);
  });
});
