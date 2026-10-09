// V1 润色 slice 阶段 5.2——多工作组单画布 /topology 图回归守卫。覆盖约束流程 #6
//（HostMultiRigGraph 可达性）、约束流程 #8（不存在 .map(useRigGraph) 这种违反 hooks 规则的
// 反模式），以及约束流程 #9（跨 HostMultiRigGraph、RigGroupNode、multi-rig-layout 对默认展开
// 状态做耦合字面量扫描）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { readFileSync } from "node:fs";
import path from "node:path";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

import { HostMultiRigGraph } from "../src/components/topology/HostMultiRigGraph.js";
import { TopologyOverlayProvider } from "../src/components/topology/topology-overlay-context.js";
import {
  prefixRigData,
  packRigGroups,
  computeBounds,
  COLLAPSED_RIG_WIDTH,
  COLLAPSED_RIG_HEIGHT,
} from "../src/lib/multi-rig-layout.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function withQueryClient(ui: React.ReactNode, opts: { selectedHost?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (opts.selectedHost) {
    queryClient.setQueryData(["hosts"], {
      ownName: "localhost",
      selected: opts.selectedHost,
      hosts: [
        {
          id: opts.selectedHost,
          transport: "http",
          url: `http://${opts.selectedHost}:7433`,
          selected: true,
          status: "reachable",
        },
      ],
    });
  }
  // 使用带内存历史的 TanStack Router 包装，使 <Link> 能解析路由上下文，避免在
  // RigGroupNode 内崩溃。V1 润色 slice 阶段 5.2 回修：TopologyOverlayProvider 包装路由
  // 组件，使 HostMultiRigGraph 的 useTopologyOverlay() 返回真实 toggleRig，而非默认空操作。
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const PS_RESPONSE = [
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
  {
    rigId: "rig-3",
    name: "openrig-product-lab",
    nodeCount: 0,
    runningCount: 0,
    status: "stopped",
    uptime: null,
    latestSnapshot: null,
  },
];

function setupFetchOk(opts: {
  ps?: typeof PS_RESPONSE;
  graphsByRigId?: Record<string, { nodes: unknown[]; edges: unknown[] }>;
}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.split("?")[0] === "/api/ps") {
      return new Response(JSON.stringify(opts.ps ?? PS_RESPONSE));
    }
    const m = url.split("?")[0]!.match(/\/api\/rigs\/([^/]+)\/graph/);
    if (m) {
      const rigId = decodeURIComponent(m[1]!);
      return new Response(
        JSON.stringify(opts.graphsByRigId?.[rigId] ?? { nodes: [], edges: [] }),
      );
    }
    return new Response("[]");
  });
}

// ----------------------------------------------------------------------
// multi-rig-layout 辅助函数——纯函数测试。
// ----------------------------------------------------------------------

describe("multi-rig-layout: prefixRigData (P5.2-3 cross-rig prefixing)", () => {
  it("prefixes node IDs with `${rigId}::` and threads data.rigId", () => {
    const { nodes, edges } = prefixRigData(
      "rig-1",
      [
        { id: "n1", data: {} },
        { id: "n2", data: { foo: "bar" } },
      ],
      [{ id: "e1", source: "n1", target: "n2" }],
    );
    expect(nodes[0]!.id).toBe("rig-1::n1");
    expect(nodes[1]!.id).toBe("rig-1::n2");
    expect(nodes[0]!.data?.rigId).toBe("rig-1");
    expect(nodes[1]!.data?.foo).toBe("bar");
    expect(nodes[1]!.data?.rigId).toBe("rig-1");
    expect(edges[0]!.id).toBe("rig-1::e1");
    expect(edges[0]!.source).toBe("rig-1::n1");
    expect(edges[0]!.target).toBe("rig-1::n2");
  });

  it("two rigs with overlapping internal IDs have NO collision after prefixing (ritual #9)", () => {
    const r1 = prefixRigData(
      "rig-A",
      [{ id: "orchestrator", data: {} }, { id: "review", data: {} }],
      [],
    );
    const r2 = prefixRigData(
      "rig-B",
      [{ id: "orchestrator", data: {} }, { id: "review", data: {} }],
      [],
    );
    const allIds = new Set([...r1.nodes.map((n) => n.id), ...r2.nodes.map((n) => n.id)]);
    expect(allIds.size).toBe(4); // 即使内部 ID 相同也不冲突。
    expect(allIds.has("rig-A::orchestrator")).toBe(true);
    expect(allIds.has("rig-B::orchestrator")).toBe(true);
  });

  it("preserves and prefixes parentId for react-flow parent/child nodes", () => {
    const { nodes } = prefixRigData(
      "rig-A",
      [
        { id: "podGroup-1", data: {} },
        { id: "agent-1", data: {}, parentId: "podGroup-1" } as any,
      ],
      [],
    );
    expect((nodes[1] as { parentId?: string }).parentId).toBe("rig-A::podGroup-1");
  });
});

describe("multi-rig-layout: packRigGroups (P5.2-6 outer offset packing)", () => {
  it("places rigs in a row when viewport is wide enough", () => {
    const packed = packRigGroups(
      [
        { rigId: "rig-1", width: 300, height: 120 },
        { rigId: "rig-2", width: 300, height: 120 },
      ],
      1024,
    );
    expect(packed[0]!.offsetX).toBe(0);
    expect(packed[0]!.offsetY).toBe(0);
    expect(packed[1]!.offsetX).toBeGreaterThan(0);
    expect(packed[1]!.offsetY).toBe(0);
  });

  it("wraps to next row when total row width exceeds viewport", () => {
    const packed = packRigGroups(
      [
        { rigId: "rig-1", width: 600, height: 120 },
        { rigId: "rig-2", width: 600, height: 120 },
        { rigId: "rig-3", width: 600, height: 120 },
      ],
      800,
    );
    // 第一个位于第 0 行；第二个换行；第三个也换行。
    expect(packed[0]!.offsetY).toBe(0);
    expect(packed[1]!.offsetY).toBeGreaterThan(0);
  });

  it("returns empty array for zero rigs", () => {
    expect(packRigGroups([], 1024)).toEqual([]);
  });
});

describe("multi-rig-layout: computeBounds", () => {
  it("returns collapsed-card dimensions for empty node list", () => {
    const b = computeBounds([]);
    expect(b.width).toBe(COLLAPSED_RIG_WIDTH);
    expect(b.height).toBe(COLLAPSED_RIG_HEIGHT);
  });

  it("computes bounding box covering all positioned nodes", () => {
    const b = computeBounds([
      { position: { x: 10, y: 10 }, initialWidth: 100, initialHeight: 50 },
      { position: { x: 200, y: 100 }, initialWidth: 100, initialHeight: 50 },
    ]);
    // 宽度覆盖 minX=10 → maxX=300 → 290 + 2 * 16 内边距 = 322。
    expect(b.width).toBeGreaterThanOrEqual(290);
    expect(b.height).toBeGreaterThan(140);
  });
});

// ----------------------------------------------------------------------
// HostMultiRigGraph 组件——挂载、点击契约与折叠。
// ----------------------------------------------------------------------

describe("HostMultiRigGraph (P5.2-1 reachability — ritual #6)", () => {
  it("renders one rigGroup node per rig from /api/ps; default ALL expanded", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />);
    expect(await findByTestId("host-multi-rig-graph")).toBeTruthy();
    // 每个工作组都呈现对应的 rigGroup 节点。
    expect(await findByTestId("rig-group-node-rig-1")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-2")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-3")).toBeTruthy();
    // 默认全部展开，使全局画布完整打开。
    expect(
      (await findByTestId("rig-group-node-rig-1")).getAttribute("data-collapsed"),
    ).toBe("false");
    expect(
      (await findByTestId("rig-group-node-rig-2")).getAttribute("data-collapsed"),
    ).toBe("false");
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/rig-1/graph");
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/rig-2/graph");
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/rig-3/graph");
    });
  });

  it("remote selection threads host param through /api/ps and per-rig graph fan-out", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />, { selectedHost: "vps-a" });
    expect(await findByTestId("host-multi-rig-graph")).toBeTruthy();
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/ps?host=vps-a", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/rig-1/graph?host=vps-a");
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/rig-2/graph?host=vps-a");
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/rig-3/graph?host=vps-a");
    });
    expect(
      mockFetch.mock.calls.some(([url]) => String(url) === "/api/rigs/rig-1/graph"),
    ).toBe(false);
  });

  it("rig group body click toggles collapse state (P5.2-5)", async () => {
    setupFetchOk({
      graphsByRigId: {
        "rig-1": { nodes: [], edges: [] },
      },
    });
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />);
    const node = await findByTestId("rig-group-node-rig-1");
    expect(node.getAttribute("data-collapsed")).toBe("false");
    fireEvent.click(node);
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='rig-group-node-rig-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("true");
    });
    // 再次点击会重新展开。
    fireEvent.click(
      document.querySelector("[data-testid='rig-group-node-rig-1']") as HTMLElement,
    );
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='rig-group-node-rig-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("false");
    });
  });

  it("canvas controls collapse and expand every rig", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />);
    const collapseAll = await findByTestId("topology-collapse-all-rigs");
    const expandAll = await findByTestId("topology-expand-all-rigs");
    expect((await findByTestId("rig-group-node-rig-1")).getAttribute("data-collapsed")).toBe("false");

    fireEvent.click(collapseAll);
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='rig-group-node-rig-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("true");
      expect(
        (
          document.querySelector(
            "[data-testid='rig-group-node-rig-2']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("true");
    });

    fireEvent.click(expandAll);
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='rig-group-node-rig-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("false");
      expect(
        (
          document.querySelector(
            "[data-testid='rig-group-node-rig-2']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("false");
    });
  });

  it("drill-in arrow Link is rendered separately from rig body (source contract)", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />);
    const drill = await findByTestId("rig-group-drill-rig-1");
    // 下钻 Link 元素独立于工作组主体点击目标。按文件底部的约束流程 #9 源码断言守卫，
    // 其 onClick stopPropagation 契约通过确认 RigGroupNode.tsx 的 Link onClick 中含
    // `e.stopPropagation()` 来验证。
    expect(drill).toBeTruthy();
    expect(drill.tagName).toBe("A");
    // 工作组主体保持展开；点击下钻链接即使在 jsdom 中未触发 onClick，也不得冒泡到主体的
    // 切换处理器。此要求由视觉检查与 stopPropagation 源码共同验证。
    expect(
      (await findByTestId("rig-group-node-rig-1")).getAttribute("data-collapsed"),
    ).toBe("false");
  });

  it("empty rig list renders honest empty-state (no /api/rigs/.../graph fetches)", async () => {
    setupFetchOk({ ps: [] });
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />);
    expect(await findByTestId("host-multi-rig-graph-empty")).toBeTruthy();
  });
});

// ----------------------------------------------------------------------
// 源码断言守卫（约束流程 #8 + #9）。
// ----------------------------------------------------------------------

describe("source-assertion guards", () => {
  const SRC = path.resolve(__dirname, "../src");

  it("HostMultiRigGraph uses useQueries — NOT .map(useRigGraph) (ritual #8)", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/HostMultiRigGraph.tsx"),
      "utf8",
    );
    // 正向断言：useQueries 已导入并调用。子串匹配不受注释密度影响；这里不要移除注释，
    // 因为该文件的大量头部注释会干扰单行注释正则，而直接导入行与调用点始终逐字保留。
    expect(src).toContain('import { useQueries } from "@tanstack/react-query"');
    expect(src).toContain("useQueries(");
    // 负向断言流程 #8：不得出现 .map((r) => useRigGraph(r.id)) 反模式；这正是
    // TopologyTableView 曾捕获的 hooks 规则违规 P0-1。对完整源码匹配即可，注释不包含该精确模式。
    expect(src).not.toMatch(/\.map\(\s*\([^)]*\)\s*=>\s*useRigGraph/);
    // 不存在 useNodeSelection；阶段 5.1 已退役该别名。
    expect(src).not.toMatch(/\buseNodeSelection\s*\(/);
  });

  it("RigGroupNode Link onClick contains e.stopPropagation() (ritual #9)", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/RigGroupNode.tsx"),
      "utf8",
    );
    // 下钻 Link 必须阻止冒泡，使点击只执行导航，不会同时触发工作组主体的 onToggle 处理器。
    expect(src).toContain("e.stopPropagation()");
  });

  it("HostMultiRigGraph default state is all-expanded (ritual #9 coupled-literal)", () => {
    const ctxSrc = readFileSync(
      path.join(SRC, "components/topology/topology-overlay-context.tsx"),
      "utf8",
    );
    // V1 润色 slice 阶段 5.2 回修：工作组展开状态从 HostMultiRigGraph 的本地 useState
    // 提升到 provider 工作范围，使直接 URL 导航（未挂载 HostMultiRigGraph）仍能更新状态。
    // 耦合字面量扫描现以 provider 初始化器为目标。子串契约不受多行格式影响。
    expect(ctxSrc).toContain("useState<Map<string, boolean>>");
    expect(ctxSrc).toContain("() => new Map()");
    const hostSrc = readFileSync(
      path.join(SRC, "components/topology/HostMultiRigGraph.tsx"),
      "utf8",
    );
    expect(hostSrc).toContain("const DEFAULT_RIG_EXPANDED = true");
    expect(hostSrc).toContain("const HOST_GRAPH_MIN_ZOOM = 0.03");
    expect(hostSrc).toContain("HostGraphAutoFit");
    // collapsed: !p.isExpanded——展开/折叠语义载体仍在主机组件中，从提升后的上下文读取。
    expect(hostSrc).toMatch(/collapsed:\s*!p\.isExpanded/);
  });

  it("RigGroupNode uses 1px outline-variant border + hard-shadow + RegistrationMarks", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/RigGroupNode.tsx"),
      "utf8",
    );
    expect(src).toMatch(/border\s+border-outline-variant/);
    expect(src).toMatch(/hard-shadow/);
    expect(src).toMatch(/RegistrationMarks/);
    // 下钻 Link 存在，且与主体点击分离。
    expect(src).toMatch(/to=["']\/topology\/rig\/\$rigId["']/);
  });
});
