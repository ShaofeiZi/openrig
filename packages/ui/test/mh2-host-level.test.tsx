// OPR.0.4.6.MH2——UI host 层：FR-2 管线（local 的 withHostParam identity =
// 零回归负例）、FR-1 树 host 层（expand = select，单写路径）、FR-3 指示器状态、
// FR-5 经已交付订阅写路径的 HOSTS 切换。

import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { withHostParam, LOCAL_HOST_ID } from "../src/lib/host-param.js";
import { TopologyTreeView } from "../src/components/topology/TopologyTreeView.js";
import { HostIndicator } from "../src/components/HostIndicator.js";
import { SubscriptionToggleList } from "../src/components/for-you/SubscriptionToggleList.js";
import { ProjectTreeView } from "../src/components/project/ProjectTreeView.js";
import { SliceScopePage } from "../src/components/project/ScopePages.js";
import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";
import { TopologyTerminalView } from "../src/components/topology/TopologyTerminalView.js";
import { RigScopePage } from "../src/components/topology/ScopePages.js";
import { DiscoveryPanel } from "../src/components/DiscoveryPanel.js";
import { useClearPlacementOnHostSwitch } from "../src/hooks/useHosts.js";

// DiscoveryPanel 的 discovery hooks 全文件 mock（此处无其他测试消费）——
// 回归断言 AFFORDANCE 状态，adopt POST 路径由 zero-POST fetch 断言覆盖。
const mockUseDiscoveredSessions = vi.fn();
const mockUseDiscoveryScan = vi.fn();
const mockUseAdoptSession = vi.fn();
vi.mock("../src/hooks/useDiscovery.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/hooks/useDiscovery.js")>();
  return {
    ...actual,
    useDiscoveredSessions: (...args: unknown[]) => mockUseDiscoveredSessions(...args),
    useDiscoveryScan: () => mockUseDiscoveryScan(),
    useAdoptSession: () => mockUseAdoptSession(),
  };
});
import { TopologyTab } from "../src/components/slices/tabs/TopologyTab.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

interface HostsPayload {
  ownName: string;
  selected: string;
  hosts: Array<{ id: string; transport: string; url?: string; selected: boolean; status: string }>;
}

const HOSTS_TWO: HostsPayload = {
  ownName: "Linkpix Proof Host",
  selected: "local",
  hosts: [
    { id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: false, status: "reachable" },
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", selected: false, status: "unreachable" },
  ],
};

function wireFetch(opts: { hosts?: HostsPayload; settings?: Record<string, unknown>; feedHostSubscriptions?: Array<{ hostId: string; enabled: boolean }> } = {}) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
    if (url === "/api/hosts") {
      return { ok: true, json: async () => opts.hosts ?? { ownName: "localhost", selected: "local", hosts: [] } };
    }
    if (url === "/api/config") {
      return {
        ok: true,
        json: async () => ({
          settings: opts.settings ?? {},
          feedHostSubscriptions: opts.feedHostSubscriptions ?? [],
        }),
      };
    }
    return { ok: true, json: async () => [] };
  });
}

function renderWithRouter(node: () => ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: node });
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

beforeEach(() => {
  mockFetch.mockReset();
});
// 此 vitest 设置无 RTL auto-cleanup（MH-1 现场教训）——显式 cleanup 防止
// container 跨测试累积。
afterEach(() => {
  cleanup();
});

describe("withHostParam (FR-2 — the zero-regression negative)", () => {
  it("is the IDENTITY for local / absent / empty host", () => {
    expect(withHostParam("/api/ps", LOCAL_HOST_ID)).toBe("/api/ps");
    expect(withHostParam("/api/ps", undefined)).toBe("/api/ps");
    expect(withHostParam("/api/ps", "")).toBe("/api/ps");
    expect(withHostParam("/api/slices?filter=all", LOCAL_HOST_ID)).toBe("/api/slices?filter=all");
  });

  it("appends the host envelope with ?/& awareness and encoding", () => {
    expect(withHostParam("/api/ps", "vps-a")).toBe("/api/ps?host=vps-a");
    expect(withHostParam("/api/slices?filter=all", "vps-a")).toBe("/api/slices?filter=all&host=vps-a");
    expect(withHostParam("/api/ps", "a b")).toBe("/api/ps?host=a%20b");
  });
});

describe("TopologyTreeView host level (FR-1)", () => {
  it("empty registry: single chip-less local node — today's tree shape (zero-regression)", async () => {
    wireFetch(); // no hosts
    renderWithRouter(() => <TopologyTreeView />);
    await waitFor(() => expect(screen.getByTestId("topology-host-localhost")).toBeTruthy());
    expect(screen.queryByTestId("topology-host-chip-local")).toBeNull();
    expect(screen.queryByTestId("topology-host-vps-a")).toBeNull();
  });

  it("registry hosts render as collapsed nodes; local is expanded + viewing", async () => {
    // 树的 local label 读 MH-1 规范存储名——host.name SETTINGS key
    //（settings twins），非 hosts payload。
    wireFetch({ hosts: HOSTS_TWO, settings: { "host.name": { value: "Linkpix Proof Host" } } });
    renderWithRouter(() => <TopologyTreeView />);
    await waitFor(() => expect(screen.getByTestId("topology-host-vps-a")).toBeTruthy());
    const local = screen.getByTestId("topology-host-localhost");
    expect(local.getAttribute("data-selected")).toBe("true");
    await waitFor(() => expect(local.textContent).toContain("Linkpix Proof Host"));
    expect(screen.getByTestId("topology-host-chip-local").textContent).toBe("viewing");
    const vpsA = screen.getByTestId("topology-host-vps-a");
    expect(vpsA.getAttribute("data-selected")).toBe("false");
    // 不可达 registry probe 在折叠行上如实渲染
    expect(screen.getByTestId("topology-host-chip-vps-b").textContent).toBe("unreachable");
  });

  it("clicking a collapsed host writes the ONE selection key (expand = select)", async () => {
    wireFetch({ hosts: HOSTS_TWO });
    renderWithRouter(() => <TopologyTreeView />);
    await waitFor(() => expect(screen.getByTestId("topology-host-vps-a")).toBeTruthy());
    fireEvent.click(screen.getByTestId("topology-host-vps-a").querySelector("button")!);
    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        ([url, init]) => String(url) === "/api/config/host.selected" && (init as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ value: "vps-a" });
    });
  });

  it("remote selected: its node is the expanded one; Archive stays local-only", async () => {
    wireFetch({ hosts: { ...HOSTS_TWO, selected: "vps-a" } });
    renderWithRouter(() => <TopologyTreeView />);
    await waitFor(() =>
      expect(screen.getByTestId("topology-host-vps-a").getAttribute("data-selected")).toBe("true"),
    );
    expect(screen.getByTestId("topology-host-localhost").getAttribute("data-selected")).toBe("false");
    // archived-rigs read 不在 allowlist——remote host 下无 Archive
    expect(screen.queryByTestId("topology-archive-section")).toBeNull();
  });
});

describe("HostIndicator (FR-3 — truthful states)", () => {
  it("defaults to the quiet local state with no hosts payload", async () => {
    wireFetch();
    renderWithRouter(() => <HostIndicator />);
    await waitFor(() => expect(screen.getByTestId("host-indicator")).toBeTruthy());
    const el = screen.getByTestId("host-indicator");
    expect(el.getAttribute("data-state")).toBe("local");
    expect(el.textContent?.toLowerCase()).toContain("localhost");
  });

  it("local with an own-name renders the name (quiet register)", async () => {
    wireFetch({ hosts: HOSTS_TWO });
    renderWithRouter(() => <HostIndicator />);
    await waitFor(() =>
      expect(screen.getByTestId("host-indicator").textContent).toContain("Linkpix Proof Host"),
    );
    expect(screen.getByTestId("host-indicator").getAttribute("data-state")).toBe("local");
  });

  it("remote selected renders the emphasized VIEWING chip naming the host", async () => {
    wireFetch({ hosts: { ...HOSTS_TWO, selected: "vps-a" } });
    renderWithRouter(() => <HostIndicator />);
    await waitFor(() =>
      expect(screen.getByTestId("host-indicator").getAttribute("data-state")).toBe("viewing"),
    );
    expect(screen.getByTestId("host-indicator").textContent?.toLowerCase()).toContain("vps-a");
  });

  it("a selected host whose registry probe reads unreachable renders the red state", async () => {
    wireFetch({ hosts: { ...HOSTS_TWO, selected: "vps-b" } });
    renderWithRouter(() => <HostIndicator />);
    await waitFor(() =>
      expect(screen.getByTestId("host-indicator").getAttribute("data-state")).toBe("unreachable"),
    );
    expect(screen.getByTestId("host-indicator").textContent?.toLowerCase()).toContain("vps-b");
  });
});

describe("guard-B1 files gate — a remote selection issues ZERO /api/files/* requests", () => {
  const SLICE_DETAIL = {
    name: "test-slice",
    displayName: "Test Slice",
    slicePath: "/remote/workspace/missions/m1/slices/test-slice",
    missionId: "m1",
    qitemIds: [],
    status: "active",
    acceptance: { currentStep: null, items: [] },
    tests: { proofPackets: [] },
    topology: null,
  };

  function wireFilesGateFetch(selected: string) {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      if (u === "/api/hosts") return { ok: true, json: async () => ({ ...HOSTS_TWO, selected }) };
      if (u === "/api/config") return { ok: true, json: async () => ({ settings: { "workspace.root": { value: "/local/ws" } }, feedHostSubscriptions: [] }) };
      if (u.startsWith("/api/files/roots")) return { ok: true, json: async () => ({ roots: [{ name: "ws", path: "/local/ws" }] }) };
      if (u.startsWith("/api/files/list")) return { ok: true, json: async () => ({ root: "ws", path: "missions", entries: [] }) };
      if (u.startsWith("/api/slices/test-slice")) return { ok: true, json: async () => SLICE_DETAIL };
      if (u.startsWith("/api/slices")) return { ok: true, json: async () => ({ slices: [] }) };
      // Review composer 故意出错——其 UNAVAILABLE 状态是确定性渲染；届时
      // PROOF.md scope-markdown hook 已运行（hooks 先于 early return），
      // 这正是我们 gate 的对象。
      if (u.startsWith("/api/review")) return { ok: false, status: 500, json: async () => ({}) };
      if (u.startsWith("/api/scope/audit")) return { ok: true, json: async () => ({ slices: [] }) };
      return { ok: true, json: async () => [] };
    });
  }

  const filesCalls = () => mockFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/files/"));
  const reviewCalls = () => mockFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/review"));

  it("ProjectTreeView: remote-selected → zero file requests; local control → discovery fires (non-vacuous)", async () => {
    wireFilesGateFetch("vps-a");
    renderWithRouter(() => <ProjectTreeView />);
    await waitFor(() => expect(screen.getByTestId("project-host-vps-a")).toBeTruthy());
    expect(filesCalls()).toEqual([]);
    cleanup();
    mockFetch.mockClear();
    // Local 对照：同一棵 local 选中的树确实走 discovery——证明此 harness 会
    // 捕获 gate 违规。
    wireFilesGateFetch("local");
    renderWithRouter(() => <ProjectTreeView />);
    await waitFor(() => expect(screen.getByTestId("project-workspace-node")).toBeTruthy());
    await waitFor(() => expect(filesCalls().length).toBeGreaterThan(0));
  });

  it("SliceScopePage default Review path: remote-selected → zero file requests; local control → PROOF.md roots fetch fires", async () => {
    wireFilesGateFetch("vps-a");
    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const rootRoute1 = createRootRoute({ component: () => <Outlet /> });
    const sliceRoute1 = createRoute({ getParentRoute: () => rootRoute1, path: "/project/slice/$sliceId", component: SliceScopePage });
    const router1 = createRouter({
      routeTree: rootRoute1.addChildren([sliceRoute1]),
      history: createMemoryHistory({ initialEntries: ["/project/slice/test-slice"] }),
    });
    render(
      <QueryClientProvider client={qc1}>
        <RouterProvider router={router1} />
      </QueryClientProvider>,
    );
    // remote 下 Review tab 渲染如实 gated 状态（composer 读 LOCAL
    // /api/review——同 A-over-B 类，API flavor）。
    await waitFor(() => expect(screen.getByTestId("slice-review-remote-gated")).toBeTruthy());
    expect(filesCalls()).toEqual([]);
    expect(reviewCalls()).toEqual([]);
    cleanup();
    mockFetch.mockClear();
    // Local 对照：同页，local 选中——PROOF.md scope reader 相对 local roots
    // 解析，故 /api/files/roots 触发。
    wireFilesGateFetch("local");
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const rootRoute2 = createRootRoute({ component: () => <Outlet /> });
    const sliceRoute2 = createRoute({ getParentRoute: () => rootRoute2, path: "/project/slice/$sliceId", component: SliceScopePage });
    const router2 = createRouter({
      routeTree: rootRoute2.addChildren([sliceRoute2]),
      history: createMemoryHistory({ initialEntries: ["/project/slice/test-slice"] }),
    });
    render(
      <QueryClientProvider client={qc2}>
        <RouterProvider router={router2} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(filesCalls().length).toBeGreaterThan(0));
    // Local-positive /api/review 对照：composer 在 known-local 时确实触发——
    // 证明 review-gate 断言非空泛。
    await waitFor(() => expect(reviewCalls().length).toBeGreaterThan(0));
  });

  it("SliceScopePage Review under an UNKNOWN selection: pending state, zero /api/review (the race class)", async () => {
    // /api/hosts 永不 resolve——selection 保持 unknown；review composer 不得在
    // local 假定默认上触发 local read。
    wireFilesGateFetch("vps-a");
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/hosts") return new Promise(() => {});
      return base(url, init);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const sliceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project/slice/$sliceId", component: SliceScopePage });
    const router = createRouter({
      routeTree: rootRoute.addChildren([sliceRoute]),
      history: createMemoryHistory({ initialEntries: ["/project/slice/test-slice"] }),
    });
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("slice-review-selection-pending")).toBeTruthy());
    expect(reviewCalls()).toEqual([]);
    expect(filesCalls()).toEqual([]);
  });

  it("MissionScopePage Review tab: remote-selected → honest gate + zero /api/review; local control → composer fires", async () => {
    const { MissionScopePage } = await import("../src/components/project/ScopePages.js");
    // 默认 steering landing 先渲染——给它有效 payload，使走到 Review tab 是
    // 确定性的；review composer 自身故意 500（其错误状态确定，且对照断言
    // fetch COUNT）。
    const wireMission = (selected: string) => {
      wireFilesGateFetch(selected);
      const base = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith("/api/steering")) {
          return {
            ok: true,
            json: async () => ({ priorityStack: null, roadmapRail: null, laneRails: [], unavailableSources: [] }),
          };
        }
        if (u.startsWith("/api/missions/")) {
          return { ok: true, json: async () => ({ missionId: "m1", missionPath: "/remote/ws/missions/m1", slices: [] }) };
        }
        return base(url, init);
      });
    };
    const mountMission = (qc: QueryClient) => {
      const rootRoute = createRootRoute({ component: () => <Outlet /> });
      const missionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project/mission/$missionId", component: MissionScopePage });
      const router = createRouter({
        routeTree: rootRoute.addChildren([missionRoute]),
        history: createMemoryHistory({ initialEntries: ["/project/mission/m1"] }),
      });
      return render(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    };

    wireMission("vps-a");
    mountMission(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    await waitFor(() => expect(screen.getByTestId("project-tab-review")).toBeTruthy());
    fireEvent.click(screen.getByTestId("project-tab-review"));
    await waitFor(() => expect(screen.getByTestId("mission-review-remote-gated")).toBeTruthy());
    expect(reviewCalls()).toEqual([]);
    cleanup();
    mockFetch.mockClear();

    wireMission("local");
    mountMission(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    await waitFor(() => expect(screen.getByTestId("project-tab-review")).toBeTruthy());
    fireEvent.click(screen.getByTestId("project-tab-review"));
    await waitFor(() => expect(reviewCalls().length).toBeGreaterThan(0));
  });
});

describe("guard-B1 files gate round 2 — mission landing + portfolio glance (remote never touches /api/files)", () => {
  const MISSION_PAYLOAD = {
    missionPath: "/remote/workspace/missions/m1",
    slices: [],
  };

  function wireMissionFetch(selected: string) {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      if (u === "/api/hosts") return { ok: true, json: async () => ({ ...HOSTS_TWO, selected }) };
      if (u === "/api/config") return { ok: true, json: async () => ({ settings: { "workspace.root": { value: "/local/ws" } }, feedHostSubscriptions: [] }) };
      if (u.startsWith("/api/files/roots")) return { ok: true, json: async () => ({ roots: [{ name: "ws", path: "/local/ws" }] }) };
      if (u.startsWith("/api/files/read")) return { ok: true, json: async () => ({ root: "ws", path: "x", absolutePath: "/local/ws/x", content: "## Building\nstuff", mtime: "now", contentHash: "h", size: 1 }) };
      if (u.startsWith("/api/missions/")) return { ok: true, json: async () => MISSION_PAYLOAD };
      if (u.startsWith("/api/slices")) return { ok: true, json: async () => ({ slices: [] }) };
      if (u.startsWith("/api/scope/audit")) return { ok: true, json: async () => ({ slices: [] }) };
      return { ok: true, json: async () => [] };
    });
  }

  const filesCalls2 = () => mockFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/files/"));

  it("MissionScopePage default steering landing: remote-selected → zero file requests (honest gated brief); local control → roots fires", async () => {
    const { MissionScopePage } = await import("../src/components/project/ScopePages.js");
    const mountAt = (qc: QueryClient) => {
      const rootRoute = createRootRoute({ component: () => <Outlet /> });
      const missionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project/mission/$missionId", component: MissionScopePage });
      const router = createRouter({
        routeTree: rootRoute.addChildren([missionRoute]),
        history: createMemoryHistory({ initialEntries: ["/project/mission/m1"] }),
      });
      return render(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    };

    wireMissionFetch("vps-a");
    mountAt(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    await waitFor(() => expect(screen.getByTestId("brief-panel-remote-gated")).toBeTruthy());
    expect(filesCalls2()).toEqual([]);
    cleanup();
    mockFetch.mockClear();

    // Local 对照：同一 landing 确实经 roots resolver 读 MISSION_BRIEF——
    // 证明 harness 捕获 gate 违规。
    wireMissionFetch("local");
    mountAt(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    await waitFor(() => expect(filesCalls2().length).toBeGreaterThan(0));
  });

  it("WorkspacePortfolioPanel expanded MissionGlance: remote-selected → zero file requests (honest gated glance); local control → roots fires", async () => {
    const { WorkspacePortfolioPanel } = await import("../src/components/project/WorkspacePortfolioPanel.js");
    const SLICE_ROW = {
      name: "s1",
      displayName: "S1",
      missionId: "m1",
      status: "active",
      qitemCount: 0,
      hasProofPacket: false,
    };
    const wire = (selected: string) => {
      wireMissionFetch(selected);
      const base = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).startsWith("/api/slices")) return { ok: true, json: async () => ({ slices: [SLICE_ROW] }) };
        return base(url, init);
      });
    };

    wire("vps-a");
    renderWithRouter(() => <WorkspacePortfolioPanel />);
    await waitFor(() => expect(screen.getByTestId("portfolio-toggle-m1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("portfolio-toggle-m1"));
    await waitFor(() => expect(screen.getByTestId("portfolio-glance-remote-gated-m1")).toBeTruthy());
    expect(filesCalls2()).toEqual([]);
    cleanup();
    mockFetch.mockClear();

    // Local 对照：展开 glance 确实经 roots 读 MISSION_BRIEF。
    wire("local");
    renderWithRouter(() => <WorkspacePortfolioPanel />);
    await waitFor(() => expect(screen.getByTestId("portfolio-toggle-m1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("portfolio-toggle-m1"));
    await waitFor(() => expect(filesCalls2().length).toBeGreaterThan(0));
  });
});

describe("SubscriptionToggleList HOSTS section (FR-5 — complete, don't rebuild)", () => {
  it("no hosts + no subscription rows: NO hosts section — today's panel (zero-regression)", async () => {
    wireFetch();
    renderWithRouter(() => <SubscriptionToggleList />);
    await waitFor(() => expect(screen.getByTestId("subscription-toggle-list")).toBeTruthy());
    expect(screen.queryByTestId("subscription-host-toggle-list")).toBeNull();
  });

  it("renders this-host forced ON + per-host rows from registry ∪ persisted subscriptions", async () => {
    wireFetch({
      hosts: HOSTS_TWO,
      feedHostSubscriptions: [
        { hostId: "vps-a", enabled: true },
        { hostId: "vps-gone", enabled: true }, // persisted row outliving its registry entry — still rendered
      ],
    });
    renderWithRouter(() => <SubscriptionToggleList />);
    await waitFor(() => expect(screen.getByTestId("subscription-host-toggle-list")).toBeTruthy());
    expect(screen.getByTestId("subscription-host-toggle-local").textContent).toContain("强制开启");
    expect(screen.getByTestId("subscription-host-toggle-vps-a").getAttribute("data-on")).toBe("true");
    expect(screen.getByTestId("subscription-host-toggle-vps-b").getAttribute("data-on")).toBe("false");
    expect(screen.getByTestId("subscription-host-toggle-vps-gone").getAttribute("data-on")).toBe("true");
  });

  it("toggling a host writes the SHIPPED per-host subscription key (a local config write, never read-through)", async () => {
    wireFetch({ hosts: HOSTS_TWO, feedHostSubscriptions: [{ hostId: "vps-a", enabled: true }] });
    renderWithRouter(() => <SubscriptionToggleList />);
    await waitFor(() => expect(screen.getByTestId("subscription-host-toggle-vps-a-button")).toBeTruthy());
    fireEvent.click(screen.getByTestId("subscription-host-toggle-vps-a-button"));
    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/config/feed.subscriptions.vps-a.enabled" && (init as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ value: "false" });
    });
  });
});

// ── rev1-r2 B1/B2——remote view 不挂载 local action affordance，也不触发
// bare local 请求（FR-7 UI 契约）。每个 remote 零例都带 LOCAL-POSITIVE 对照，
// 证明 harness 会捕获违规。gate 原语是 useSelectedHostId CACHE OBSERVER，
// 故这些测试直接 PRIME ["hosts"] 缓存（无需 /api/hosts fetch）。

describe("rev1-r2 B1/B2 — remote action gates (topology table / terminal grid / slice seats / seat page)", () => {
  let OriginalEventSource: typeof EventSource | undefined;

  beforeEach(() => {
    OriginalEventSource = globalThis.EventSource;
    // useTopologyActivity 表面（table + seat page）订阅 SSE。
    class StubEventSource {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  });
  afterEach(() => {
    if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  });

  const RIG_SUMMARY = [{ id: "r1", name: "rig-one", nodeCount: 1 }];
  const NODES_R1 = [
    {
      logicalId: "a1",
      nodeKind: "agent",
      canonicalSessionName: "a1@rig-one",
      runtime: "claude-code",
      sessionStatus: "running",
      startupStatus: "ready",
    },
  ];
  const NODE_DETAIL_MIN = {
    rigId: "r1", rigName: "rig-one", logicalId: "a1", podId: null,
    canonicalSessionName: "a1@rig-one", nodeKind: "agent", runtime: "claude-code",
    sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
    tmuxAttachCommand: "tmux attach -t a1@rig-one", resumeCommand: null,
    recoveryGuidance: null, latestError: null, model: null, agentRef: null,
    profile: null, resolvedSpecName: null, resolvedSpecVersion: null, cwd: null,
    startupFiles: [], startupActions: [], recentEvents: [],
    infrastructureStartupCommand: null, peers: [],
    edges: { outgoing: [], incoming: [] },
    transcript: { enabled: false, path: null, tailCommand: null },
    compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
    agentActivity: null, currentQitems: [],
  };

  /** hostsSelected 必须匹配 primed-cache selection——带 ACTIVE useHosts 的组件
   * （ProjectTreeView）会 refetch /api/hosts，否则会用冲突 selection 覆盖 primed
   * 条目。 */
  function hostsPayload(selected: string) {
    return {
      ownName: "Linkpix Proof Host",
      selected,
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: selected === "vps-a", status: "reachable" }],
    };
  }

  function wireB1Fetch(hostsSelected: string = LOCAL_HOST_ID) {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      const u = String(url);
      if (u.startsWith("/api/hosts")) {
        return { ok: true, json: async () => hostsPayload(hostsSelected) };
      }
      if (u.startsWith("/api/rigs/summary")) return { ok: true, json: async () => RIG_SUMMARY };
      if (u.includes("/nodes/")) return { ok: true, json: async () => NODE_DETAIL_MIN };
      if (u.includes("/nodes")) return { ok: true, json: async () => NODES_R1 };
      if (u.includes("/api/specs/library")) return { ok: true, json: async () => [] };
      if (u.startsWith("/api/slices")) return { ok: true, json: async () => ({ slices: [] }) };
      if (u.startsWith("/api/config")) return { ok: true, json: async () => ({ settings: {}, feedHostSubscriptions: [] }) };
      return { ok: true, json: async () => ({}) };
    });
  }

  /** 以 PRIMED ["hosts"] 缓存渲染（gate 原语是 cache observer）——gcTime 保持
   *  有限大，使 primed 条目存活。 */
  function renderPrimed(node: () => ReactElement, selected: string, opts: { path?: string; entry?: string } = {}) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
    });
    qc.setQueryData(["hosts"], {
      ownName: "Linkpix Proof Host",
      selected,
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: selected === "vps-a", status: "reachable" }],
    });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const nodePath = opts.path ?? "/";
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: nodePath, component: node });
    const mk = (path: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
    const extras = ["/topology", "/topology/rig/$rigId", "/topology/seat/$rigId/$logicalId", "/rigs/$rigId", "$"]
      .filter((p) => p !== nodePath)
      .map(mk);
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, ...extras]),
      history: createMemoryHistory({ initialEntries: [opts.entry ?? nodePath] }),
    });
    return render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  function postCalls() {
    return mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
  }

  it("TopologyTableView remote: actions cell = honest read-only marker, NO cmux affordance, ZERO POSTs", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTableView />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("topology-table-actions-a1")).toBeTruthy());
    expect(screen.getByTestId("topology-table-actions-a1").getAttribute("data-remote-readonly")).toBe("true");
    expect(screen.queryByTestId("topology-table-cmux-a1")).toBeNull();
    expect(screen.queryByTestId("topology-table-a1-terminal-open")).toBeNull();
    expect(postCalls()).toEqual([]);
  });

  it("TopologyTableView local CONTROL: the cmux affordance renders (the harness catches violations)", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTableView />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("topology-table-cmux-a1")).toBeTruthy());
    expect(screen.getByTestId("topology-table-actions-a1").getAttribute("data-remote-readonly")).toBeNull();
    // 证明 remote 负例断言所依据的 trigger testid 形状（-terminal-popover 面板
    // 仅在 OPEN 时存在；always-rendered affordance 是 -terminal-open trigger
    // 按钮）
    expect(screen.getByTestId("topology-table-a1-terminal-open")).toBeTruthy();
  });

  it("TopologyTerminalView remote: honest gated state, NO terminal grid/picker mounts (zero local session reads)", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTerminalView scope="host" />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("topology-terminal-remote-gated")).toBeTruthy());
    expect(screen.queryByTestId("topology-terminal-host-picker")).toBeNull();
    expect(screen.queryByTestId("topology-terminal-grid")).toBeNull();
    expect(postCalls()).toEqual([]);
  });

  it("TopologyTerminalView local CONTROL: the rig picker renders", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTerminalView scope="host" />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("topology-terminal-host-picker")).toBeTruthy());
    expect(screen.queryByTestId("topology-terminal-remote-gated")).toBeNull();
  });

  const SLICE_TOPOLOGY = {
    affectedRigs: [{ rigId: "r1", rigName: "rig-one", sessionNames: ["a1@rig-one"] }],
    totalSeats: 1,
    specGraph: null,
  } as Parameters<typeof TopologyTab>[0]["topology"];

  it("slice TopologyTab remote: seat rows read-only — NO preview toggle (click-to-live is a local session read)", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTab topology={SLICE_TOPOLOGY} />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("topology-seat-a1@rig-one")).toBeTruthy());
    expect(screen.getByTestId("topology-seat-a1@rig-one").getAttribute("data-remote-readonly")).toBe("true");
    expect(screen.queryByTestId("topology-seat-a1@rig-one-toggle")).toBeNull();
  });

  it("slice TopologyTab local CONTROL: the preview toggle renders", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTab topology={SLICE_TOPOLOGY} />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("topology-seat-a1@rig-one-toggle")).toBeTruthy());
  });

  it("seat page remote (B1+B2): host-keyed detail fetch, NO bare local URL, actions row read-only, inline terminal gated, ZERO POSTs", async () => {
    wireB1Fetch();
    renderPrimed(() => <LiveNodeDetails rigId="r1" logicalId="a1" />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("live-node-actions-remote-readonly")).toBeTruthy());
    // B1：无 local action affordance，terminal 如实 gated
    expect(screen.queryByTestId("detail-cmux-open")).toBeNull();
    expect(screen.queryByTestId("detail-copy-attach")).toBeNull();
    expect(screen.getByTestId("node-detail-terminal-remote-gated")).toBeTruthy();
    // B2：detail read 搭 host envelope；bare local URL 永不触发
    const detailCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/nodes/a1"));
    expect(detailCalls.length).toBeGreaterThan(0);
    expect(detailCalls.every((u) => u === "/api/rigs/r1/nodes/a1?host=vps-a")).toBe(true);
    expect(postCalls()).toEqual([]);
  });

  it("seat page local CONTROL: bare detail URL + the cmux action renders", async () => {
    wireB1Fetch();
    renderPrimed(() => <LiveNodeDetails rigId="r1" logicalId="a1" />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("detail-cmux-open")).toBeTruthy());
    expect(screen.queryByTestId("live-node-actions-remote-readonly")).toBeNull();
    const detailCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/nodes/a1"));
    expect(detailCalls.length).toBeGreaterThan(0);
    expect(detailCalls.every((u) => u === "/api/rigs/r1/nodes/a1")).toBe(true);
  });

  // ── rev1-r2 RE-VERDICT B1——restore/launch 类 + 枚举同类 refresh affordance
  //（mutation-verb 枚举，非 feature 族）。RigGraph 的 placement-target sibling
  // 位于 rig-graph.test.tsx，紧邻其 local-positive 对照。

  const RIG_STATUS = {
    // rigId 在 response 内——RigStatusCard testid 派生自 status.rigId，非页面
    // 参数（run-4 现场发现：省略它渲染 rig-primary-action-undefined）。
    rigId: "r1", rigName: "rig-one", isKernel: false, status: "down",
    seatsTotal: 1, seatsRunning: 0, recoverable: true, perSeat: [], src: ["daemon"],
  };

  function wireRigScopeFetch(hostsSelected: string = LOCAL_HOST_ID) {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      const u = String(url);
      if (u.startsWith("/api/hosts")) return { ok: true, json: async () => hostsPayload(hostsSelected) };
      if (u.startsWith("/api/rigs/summary")) return { ok: true, json: async () => RIG_SUMMARY };
      if (u.includes("/status")) return { ok: true, json: async () => RIG_STATUS };
      if (u.includes("/graph")) return { ok: true, json: async () => ({ nodes: [], edges: [] }) };
      if (u.includes("/nodes/")) return { ok: true, json: async () => NODE_DETAIL_MIN };
      if (u.includes("/nodes")) return { ok: true, json: async () => NODES_R1 };
      return { ok: true, json: async () => ({}) };
    });
  }

  it("rig-scope remote: NO restore/launch control (honest marker), NO rig-primary-action, NO bare local status read, ZERO POSTs", async () => {
    wireRigScopeFetch("vps-a");
    renderPrimed(() => <RigScopePage />, "vps-a", { path: "/topology/rig/$rigId", entry: "/topology/rig/r1" });
    await waitFor(() => expect(screen.getByTestId("rig-status-remote-readonly")).toBeTruthy());
    expect(document.querySelector('[data-testid^="rig-primary-action"]')).toBeNull();
    const statusCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/status"));
    expect(statusCalls).toEqual([]);
    expect(postCalls()).toEqual([]);
  });

  it("rig-scope local CONTROL: RigStatusControl mounts — status read fires + the primary action renders", async () => {
    wireRigScopeFetch();
    renderPrimed(() => <RigScopePage />, LOCAL_HOST_ID, { path: "/topology/rig/$rigId", entry: "/topology/rig/r1" });
    await waitFor(() => expect(screen.getByTestId("rig-primary-action-r1")).toBeTruthy());
    expect(screen.queryByTestId("rig-status-remote-readonly")).toBeNull();
    const statusCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/status"));
    expect(statusCalls).toContain("/api/rigs/r1/status");
  });

  it("project tree remote: the local rescan (refresh) affordance never renders", async () => {
    wireB1Fetch("vps-a");
    renderPrimed(() => <ProjectTreeView />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("project-host-vps-a")).toBeTruthy());
    expect(screen.queryByTestId("project-tree-refresh")).toBeNull();
    expect(postCalls()).toEqual([]);
  });

  it("project tree local CONTROL: the refresh affordance renders", async () => {
    wireB1Fetch();
    renderPrimed(() => <ProjectTreeView />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("project-tree-refresh")).toBeTruthy());
  });

  // ── rev1-r2 RE-RE-VERDICT B1（陈旧 placement/adopt）+ GUARD 三态
  //（lifecycle 表面 unknown-selection fail-open）。

  /** UNPRIMED 渲染——["hosts"] 缓存起始为空，故 selection 真正 UNKNOWN
   * （guard blocker 窗口）。 */
  function renderUnprimed(node: () => ReactElement, opts: { path?: string; entry?: string } = {}) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
    });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const nodePath = opts.path ?? "/";
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: nodePath, component: node });
    const mk = (path: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
    const extras = ["/topology", "/topology/rig/$rigId", "/topology/seat/$rigId/$logicalId", "/rigs/$rigId", "$"]
      .filter((p) => p !== nodePath)
      .map(mk);
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, ...extras]),
      history: createMemoryHistory({ initialEntries: [opts.entry ?? nodePath] }),
    });
    return {
      qc,
      view: render(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    };
  }

  it("rig-scope UNKNOWN selection (never-resolving /api/hosts): NO local lifecycle controls, NO bare status read, pending marker only (guard tri-state)", async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      const u = String(url);
      if (u.startsWith("/api/hosts")) return new Promise(() => {}); // never resolves — selection stays UNKNOWN
      if (u.startsWith("/api/rigs/summary")) return { ok: true, json: async () => RIG_SUMMARY };
      if (u.includes("/status")) return { ok: true, json: async () => RIG_STATUS };
      if (u.includes("/graph")) return { ok: true, json: async () => ({ nodes: [], edges: [] }) };
      return { ok: true, json: async () => ({}) };
    });
    renderUnprimed(() => <RigScopePage />, { path: "/topology/rig/$rigId", entry: "/topology/rig/r1" });
    await waitFor(() => expect(screen.getByTestId("rig-status-selection-pending")).toBeTruthy());
    expect(document.querySelector('[data-testid^="rig-primary-action"]')).toBeNull();
    expect(document.querySelector('[data-testid^="rig-status-control"]')).toBeNull();
    expect(screen.queryByTestId("rig-status-remote-readonly")).toBeNull();
    const statusCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/status"));
    expect(statusCalls).toEqual([]);
    expect(postCalls()).toEqual([]);
  });

  const ELIGIBLE_NODE_TARGET = {
    kind: "node" as const,
    rigId: "r1",
    logicalId: "a1",
    eligible: true,
  };

  function wireDiscoveryMocks() {
    // target-flow 区域渲染在所选 discovered-session 的卡片内——所选 id 必须
    // 解析到真实 session（stage-1 现场发现：空列表既不渲染卡片也不渲染 remote
    // 注记）。
    mockUseDiscoveredSessions.mockReturnValue({
      data: [
        {
          id: "ds-1",
          tmuxSession: "proof-ui-add-pod",
          tmuxWindow: "0",
          tmuxPane: "%7",
          pid: 111,
          cwd: "/Users/example/code/openrig",
          activeCommand: "codex",
          runtimeHint: "codex",
          confidence: "high",
          evidenceJson: null,
          configJson: null,
          status: "active",
          claimedNodeId: null,
          firstSeenAt: "2026-04-02 10:00:00",
          lastSeenAt: "2026-04-02 10:05:00",
        },
      ],
    });
    mockUseDiscoveryScan.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseAdoptSession.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  }

  it("discovery panel remote (rev1-r2 stale-target path): an eligible target renders NO target card / NO adopt — honest note + zero POSTs", async () => {
    wireDiscoveryMocks();
    wireB1Fetch("vps-a");
    renderPrimed(
      () => (
        <DiscoveryPanel
          onClose={() => {}}
          selectedDiscoveredId="ds-1"
          onSelectDiscoveredId={() => {}}
          placementTarget={ELIGIBLE_NODE_TARGET}
          onClearPlacement={() => {}}
        />
      ),
      "vps-a",
    );
    await waitFor(() => expect(screen.getByTestId("discovery-remote-readonly")).toBeTruthy());
    expect(screen.queryByTestId("discovery-target-card")).toBeNull();
    expect(screen.queryByTestId("discovery-confirm-adopt")).toBeNull();
    expect(postCalls()).toEqual([]);
  });

  it("discovery panel local CONTROL: the eligible target renders the card + adopt", async () => {
    wireDiscoveryMocks();
    wireB1Fetch();
    renderPrimed(
      () => (
        <DiscoveryPanel
          onClose={() => {}}
          selectedDiscoveredId="ds-1"
          onSelectDiscoveredId={() => {}}
          placementTarget={ELIGIBLE_NODE_TARGET}
          onClearPlacement={() => {}}
        />
      ),
      LOCAL_HOST_ID,
    );
    await waitFor(() => expect(screen.getByTestId("discovery-target-card")).toBeTruthy());
    expect(screen.getByTestId("discovery-confirm-adopt")).toBeTruthy();
    expect(screen.queryByTestId("discovery-remote-readonly")).toBeNull();
  });

  it("the shell belt: ANY selected-host change clears placement (useClearPlacementOnHostSwitch)", async () => {
    wireB1Fetch();
    const clear = vi.fn();
    function Probe() {
      useClearPlacementOnHostSwitch(clear);
      return <div data-testid="belt-probe" />;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } } });
    qc.setQueryData(["hosts"], {
      ownName: "Linkpix Proof Host",
      selected: "local",
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: false, status: "reachable" }],
    });
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("belt-probe")).toBeTruthy());
    expect(clear).not.toHaveBeenCalled();
    // host 切换——local 时创建的 target 不得在此存活
    qc.setQueryData(["hosts"], {
      ownName: "Linkpix Proof Host",
      selected: "vps-a",
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: true, status: "reachable" }],
    });
    await waitFor(() => expect(clear).toHaveBeenCalled());
  });
});
