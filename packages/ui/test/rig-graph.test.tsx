import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { ReactFlowProvider, MarkerType } from "@xyflow/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RigGraph } from "../src/components/RigGraph.js";
import { RigNode } from "../src/components/RigNode.js";
import { DiscoveryPlacementContext, DrawerSelectionContext } from "../src/components/AppShell.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";
import type { MockEventSourceInstance } from "./helpers/mock-event-source.js";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function QueryWrapper({ children }: { children: React.ReactNode }) {
  const qc = createTestQueryClient();
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// 全局 mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

function mockGraphResponse(nodes: object[] = [], edges: object[] = []) {
  return {
    ok: true,
    json: async () => ({ nodes, edges }),
  };
}

function sampleNodes() {
  return [
    {
      id: "n1",
      type: "rigNode",
      position: { x: 0, y: 0 },
      data: {
        logicalId: "orchestrator",
        role: "orchestrator",
        runtime: "claude-code",
        model: "opus",
        status: "running",
        binding: { tmuxSession: "r01-orch1-lead", cmuxSurface: "s-1" },
      },
    },
    {
      id: "n2",
      type: "rigNode",
      position: { x: 0, y: 200 },
      data: {
        logicalId: "worker",
        role: "worker",
        runtime: "codex",
        model: null,
        status: null,
        binding: null,
      },
    },
  ];
}

function nodeWithBindingNoSurface() {
  return {
    id: "n3",
    type: "rigNode",
    position: { x: 0, y: 400 },
    data: {
      logicalId: "reviewer",
      role: "reviewer",
      runtime: "claude-code",
      model: null,
      status: "running",
      binding: { tmuxSession: "r01-rev1-r1", cmuxSurface: null },
    },
  };
}

function sampleEdges() {
  return [
    { id: "e1", source: "n1", target: "n2", label: "delegates_to" },
  ];
}

beforeEach(() => {
  mockFetch.mockReset();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  if (OriginalEventSource) {
    globalThis.EventSource = OriginalEventSource;
  }
  cleanup();
});

describe("RigGraph", () => {
  it("renders pod group graphs with visible group containers when pods are present", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "pod-alpha",
        type: "podGroup",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "alpha",
          podLabel: "Implementation",
          rigId: "rig-1",
          role: null,
          runtime: null,
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        parentId: "pod-alpha",
        data: {
          logicalId: "alpha.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: { tmuxSession: "alpha-impl@test-rig", cmuxSurface: null },
          nodeKind: "agent",
          startupStatus: "ready",
          canonicalSessionName: "alpha-impl@test-rig",
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      const groupNode = container.querySelector(".react-flow__node-podGroup") as HTMLElement | null;
      expect(groupNode).not.toBeNull();
    });

    const label = screen.getByText("alpha 容器组");
    expect(label).toBeDefined();
    expect(label.className).toContain("font-bold");
    expect(label.className).toContain("inline-flex");
    expect(label.className).not.toContain("bg-white");
    expect(label.className).not.toContain("border");
  });

  it("renders pod member nodes as visible so grouped graphs are actually readable", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "pod-alpha",
        type: "podGroup",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "alpha",
          podLabel: "Implementation",
          rigId: "rig-1",
          role: null,
          runtime: null,
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        parentId: "pod-alpha",
        data: {
          logicalId: "alpha.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: { tmuxSession: "alpha-impl@test-rig", cmuxSurface: null },
          nodeKind: "agent",
          startupStatus: "ready",
          canonicalSessionName: "alpha-impl@test-rig",
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      const rigNode = container.querySelector(".react-flow__node-rigNode") as HTMLElement | null;
      expect(rigNode).not.toBeNull();
      expect(rigNode?.style.visibility).toBe("visible");
    });
  });

  // V1 attempt-3 Phase 4 P4-5——RigDetailPanel + 'rig' kind 从 DrawerSelection
  // 退役。Pod-group 点击现在在图层级是 no-op（pods 经 Explorer 树的
  // /topology/pod/$rigId/$podName 链接打开）。测试重命名 + 断言翻转以验证
  // 无 setSelection。
  it("clicking a pod group is a no-op at the graph level (RigDetailPanel retired)", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "pod-alpha",
        type: "podGroup",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "alpha",
          podLabel: "Implementation",
          rigId: "rig-1",
          role: null,
          runtime: null,
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        parentId: "pod-alpha",
        data: {
          logicalId: "alpha.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: { tmuxSession: "alpha-impl@test-rig", cmuxSurface: null },
          nodeKind: "agent",
          startupStatus: "ready",
          canonicalSessionName: "alpha-impl@test-rig",
          podId: "alpha",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const setSelection = vi.fn();
    const { container } = render(
      <QueryWrapper>
        <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
          <RigGraph showDiscovered={false} rigId="rig-1" />
        </DrawerSelectionContext.Provider>
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(container.querySelector(".react-flow__node-podGroup")).not.toBeNull();
    });

    fireEvent.click(container.querySelector(".react-flow__node-podGroup")!);

    // 'rig' kind 在 Phase 4 退役——pod-group 点击不 setSelection。
    expect(setSelection).not.toHaveBeenCalled();
  });

  it("clicking an unbound node in discovery placement mode selects it as a bind target", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "dev.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "dev",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const setPlacementTarget = vi.fn();

    const { container } = render(
      <QueryWrapper>
        <DrawerSelectionContext.Provider value={{ selection: { type: "discovery" }, setSelection: vi.fn() }}>
          <DiscoveryPlacementContext.Provider
            value={{
              selectedDiscoveredId: "disc-1",
              setSelectedDiscoveredId: vi.fn(),
              placementTarget: null,
              setPlacementTarget,
              clearPlacement: vi.fn(),
            }}
          >
            <RigGraph showDiscovered={false} rigId="rig-1" />
          </DiscoveryPlacementContext.Provider>
        </DrawerSelectionContext.Provider>
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(container.querySelector(".react-flow__node-rigNode")).not.toBeNull();
    });

    fireEvent.click(container.querySelector(".react-flow__node-rigNode")!);

    expect(setPlacementTarget).toHaveBeenCalledWith({
      kind: "node",
      rigId: "rig-1",
      logicalId: "dev.impl",
      eligible: true,
    });
  });

  // OPR.0.4.6.MH2 rev1-r2 re-verdict B1：placement target 喂 LOCAL discovery
  // bind/adopt mutation——REMOTE selection 下渲染节点绝不可成为 target，placement
  // banner 不得广告。（上方测试即此精确流程的 local-positive 对照。）
  it("remote-selected: placement-mode click sets NO target and the placement banner is absent (rev1-r2 B1)", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "dev.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "dev",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const setPlacementTarget = vi.fn();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
    });
    qc.setQueryData(["hosts"], {
      ownName: "Linkpix Proof Host",
      selected: "vps-a",
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: true, status: "reachable" }],
    });

    const { container } = render(
      <QueryClientProvider client={qc}>
        <DrawerSelectionContext.Provider value={{ selection: { type: "discovery" }, setSelection: vi.fn() }}>
          <DiscoveryPlacementContext.Provider
            value={{
              selectedDiscoveredId: "disc-1",
              setSelectedDiscoveredId: vi.fn(),
              placementTarget: null,
              setPlacementTarget,
              clearPlacement: vi.fn(),
            }}
          >
            <RigGraph showDiscovered={false} rigId="rig-1" />
          </DiscoveryPlacementContext.Provider>
        </DrawerSelectionContext.Provider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(container.querySelector(".react-flow__node-rigNode")).not.toBeNull();
    });

    // banner 在 remote 数据上绝不广告 placement
    expect(container.querySelector("[data-testid='graph-placement-banner']")).toBeNull();

    fireEvent.click(container.querySelector(".react-flow__node-rigNode")!);

    expect(setPlacementTarget).not.toHaveBeenCalled();
    const postCalls = mockFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toEqual([]);
  });

  it("clicking a pod group in discovery placement mode selects it as an add-to-pod target", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([
      {
        id: "pod-dev",
        type: "podGroup",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "dev",
          podLabel: "Development",
          rigId: "rig-1",
          role: null,
          runtime: null,
          model: null,
          status: null,
          binding: null,
          nodeKind: "agent",
          startupStatus: null,
          canonicalSessionName: null,
          podId: "dev",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        parentId: "pod-dev",
        data: {
          logicalId: "dev.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: null },
          nodeKind: "agent",
          startupStatus: "ready",
          canonicalSessionName: "dev-impl@test-rig",
          podId: "dev",
          restoreOutcome: "n-a",
          resumeToken: null,
        },
      },
    ], []));

    const setPlacementTarget = vi.fn();
    const { container } = render(
      <QueryWrapper>
        <DrawerSelectionContext.Provider value={{ selection: { type: "discovery" }, setSelection: vi.fn() }}>
          <DiscoveryPlacementContext.Provider
            value={{
              selectedDiscoveredId: "disc-1",
              setSelectedDiscoveredId: vi.fn(),
              placementTarget: null,
              setPlacementTarget,
              clearPlacement: vi.fn(),
            }}
          >
            <RigGraph showDiscovered={false} rigId="rig-1" />
          </DiscoveryPlacementContext.Provider>
        </DrawerSelectionContext.Provider>
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(container.querySelector(".react-flow__node-podGroup")).not.toBeNull();
    });

    fireEvent.click(container.querySelector(".react-flow__node-podGroup")!);

    expect(setPlacementTarget).toHaveBeenCalledWith({
      kind: "pod",
      rigId: "rig-1",
      podId: "dev",
      podNamespace: "dev",
      podLabel: "Development",
      eligible: true,
    });
  });

  it("renders nodes from mock graph data", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      // React Flow 以 data-testid="rf__node-{id}" 渲染节点
      const rfNodes = container.querySelectorAll("[data-testid^='rf__node-']");
      expect(rfNodes.length).toBe(2);
    });
  });

  it("passes edges to ReactFlow (edge container rendered)", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      // React Flow 成功渲染节点（证明 graph 数据被接受）
      const rfNodes = container.querySelectorAll("[data-testid^='rf__node-']");
      expect(rfNodes.length).toBe(2);
      // Edge 容器存在（RF 接受 edge 数据）
      // 注：jsdom 缺 layout，故 RF 无法计算 edge 路径，但容器证明 edges
      // 已传给组件
      const edgeContainer = container.querySelector(".react-flow__edges");
      expect(edgeContainer).not.toBeNull();
      // 验证 fetch 在 response 中含 edges
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall).toBeDefined();
    });
  });

  it("loading state rendered when fetching", () => {
    // 永不 resolve——保持 loading
    mockFetch.mockReturnValueOnce(new Promise(() => {}));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);
    expect(screen.getByTestId("graph-loading")).toBeDefined();
  });

  it("empty state rendered when nodes array is empty", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([], []));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByTestId("empty-topology")).toBeDefined();
    });
  });

  it("error state rendered on fetch failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByText(/错误/i)).toBeDefined();
    });
  });

  it("rigId=null shows 'No rig selected' placeholder, no fetch", () => {
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId={null} /></QueryWrapper>);

    expect(screen.getByText(/未选择工作组/i)).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rigId='abc' fetches /api/rigs/abc/graph", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse([], []));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="abc" /></QueryWrapper>);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/abc/graph");
    });
  });

  it("graph view does NOT render a diagonal watermark stamp (OPR.0.4.0.21 ghost removal)", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" rigName="demo-rig" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.queryByTestId("rig-stamp-watermark")).toBeNull();
    });
    const container = document.querySelector("[data-testid]")?.closest("[class]");
    if (container) {
      expect(container.innerHTML).not.toContain("stamp-watermark");
    }
  });

  it("renders custom RigNode content via nodeTypes registration", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      // React Flow 用我们的自定义节点类型——节点有 class react-flow__node-rigNode
      const customNodes = container.querySelectorAll(".react-flow__node-rigNode");
      expect(customNodes.length).toBe(2);
      // RigNode 在紧凑 card 语法中渲染 runtime branding。
      expect(screen.getByRole("img", { name: "Claude" })).toBeDefined();
    });
  });
});

describe("RigNode", () => {
  it("displays logicalId, role, runtime, and status", () => {
    const data = {
      logicalId: "dev.impl",
      role: "worker",
      runtime: "claude-code",
      model: "opus",
      status: "running",
      binding: { tmuxSession: "r01-dev1-impl", cmuxSurface: null },
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    expect(screen.getByText("impl")).toBeDefined();
    expect(screen.getByRole("img", { name: "Claude" })).toBeDefined();
    expect(screen.queryByText("WORKER")).toBeNull();
    // PL-019：dot 现反映 agentActivity（原为 startupStatus）；无
    // agentActivity 附加 -> "unknown" 状态，去饱和 stone。
    expect(screen.getByTestId("activity-dot-dev.impl").getAttribute("aria-label")).toBe("活动：未知");
  });

  it("shows a compact stopped indicator when binding is null and status is null", () => {
    const data = {
      logicalId: "worker",
      role: "worker",
      runtime: "codex",
      model: null,
      status: null,
      binding: null,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    // PL-019：无 agentActivity 附加 -> unknown。
    expect(screen.getByTestId("activity-dot-worker").getAttribute("aria-label")).toBe("活动：未知");
  });

  it("PL-019: activity dot color is driven by agentActivity.state (not startupStatus)", () => {
    // 四态 + 无 activity fallback 覆盖整个 palette 契约。按 orch 设计指引：
    // running 用暖绿/teal，needs_input 是静态吸睛色（amber），idle 是冷静
    //（slate-400），unknown 去饱和（stone-300）。
    const cases = [
      { state: "running" as const, expectedLabel: "活动：运行中", expectedClass: "bg-emerald-500" },
      { state: "needs_input" as const, expectedLabel: "活动：待输入", expectedClass: "bg-amber-500" },
      { state: "idle" as const, expectedLabel: "活动：空闲", expectedClass: "bg-slate-400" },
      { state: "unknown" as const, expectedLabel: "活动：未知", expectedClass: "bg-stone-300" },
    ];

    for (const { state, expectedLabel, expectedClass } of cases) {
      cleanup();
      const data = {
        logicalId: "test-node",
        role: "worker",
        runtime: "claude-code",
        model: null,
        status: "running",
        startupStatus: "ready" as const,
        binding: null,
        agentActivity: {
          state,
          reason: "test",
          evidenceSource: "runtime_hook" as const,
          sampledAt: "",
          evidence: null,
        },
      };

      render(
        <ReactFlowProvider>
          <RigNode data={data} />
        </ReactFlowProvider>
      );

      const dot = screen.getByTestId("activity-dot-test-node");
      expect(dot.getAttribute("aria-label")).toBe(expectedLabel);
      expect(dot.getAttribute("data-activity-state")).toBe(state);
      expect(dot.className).toContain(expectedClass);
    }
  });

  it("PL-019: only running gets the subtle pulse animation; needs_input/idle/unknown stay static", () => {
    const animatingStates = [{ state: "running" as const, shouldPulse: true }];
    const nonAnimatingStates: { state: "needs_input" | "idle" | "unknown"; shouldPulse: boolean }[] = [
      { state: "needs_input", shouldPulse: false },
      { state: "idle", shouldPulse: false },
      { state: "unknown", shouldPulse: false },
    ];
    for (const { state, shouldPulse } of [...animatingStates, ...nonAnimatingStates]) {
      cleanup();
      render(
        <ReactFlowProvider>
          <RigNode data={{
            logicalId: "n",
            role: "worker",
            runtime: "claude-code",
            model: null,
            status: "running",
            startupStatus: "ready" as const,
            binding: null,
            agentActivity: { state, reason: "x", evidenceSource: "pane_heuristic" as const, sampledAt: new Date().toISOString(), evidence: null },
          }} />
        </ReactFlowProvider>
      );
      const dot = screen.getByTestId("activity-dot-n");
      if (shouldPulse) {
        expect(dot.className).toContain("activity-pulse-running");
      } else {
        expect(dot.className).not.toContain("activity-pulse-running");
      }
    }
  });

  it("PL-019: stale activity (sampledAt > threshold) renders the small staleness badge next to the dot", () => {
    const longAgo = new Date(Date.now() - 120_000).toISOString();
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "stale-node",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          startupStatus: "ready" as const,
          binding: null,
          agentActivity: { state: "running", reason: "x", evidenceSource: "pane_heuristic" as const, sampledAt: longAgo, evidence: null },
        }} />
      </ReactFlowProvider>
    );
    expect(screen.getByTestId("activity-staleness-stale-node").textContent).toBe("已停滞");
  });

  it("PL-019: when running with currentQitems, the hover hint includes 'On: <short tail> — <excerpt>'", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "busy-node",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          startupStatus: "ready" as const,
          binding: null,
          agentActivity: { state: "running", reason: "x", evidenceSource: "pane_heuristic" as const, sampledAt: new Date().toISOString(), evidence: null },
          currentQitems: [
            { qitemId: "qitem-20260504001234-tail9999", bodyExcerpt: "Phase B audit", tier: "mode2" },
          ],
        }} />
      </ReactFlowProvider>
    );
    // Hover 提示位于 rig-node title 属性（复合 tooltip）；也作为独立隐藏块渲染。
    // 我们断言 ULID tail 至少在渲染 DOM 中出现一次。
    expect(document.body.innerHTML).toContain("tail9999");
    expect(document.body.innerHTML).toContain("Phase B audit");
  });

  it("node actions use the compact terminal plus cmux toolbar pattern", () => {
    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: "running",
      startupStatus: "ready" as const,
      canonicalSessionName: "dev-impl@test-rig",
      binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: "s1" },
      resumeToken: "abc-123",
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    expect(screen.getByTestId("rig-node-dev.impl-terminal-open")).toBeDefined();
    expect(screen.getByTestId("toolbar-cmux-open")).toBeDefined();
    expect(screen.queryByTestId("toolbar-copy-attach")).toBeNull();
    expect(screen.queryByTestId("toolbar-copy-resume")).toBeNull();
  });

  it("shows an availability marker when the node can receive a discovered session", () => {
    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: null,
      startupStatus: null,
      canonicalSessionName: null,
      binding: null,
      placementState: "available" as const,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    expect(screen.getByTestId("placement-chip-dev.impl").textContent).toBe("可用");
  });

  it("toolbar keeps terminal and cmux actions when no resumeToken", () => {
    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: "running",
      startupStatus: "ready" as const,
      canonicalSessionName: "dev-impl@test-rig",
      binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: null },
      resumeToken: null,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    expect(screen.getByTestId("rig-node-dev.impl-terminal-open")).toBeDefined();
    expect(screen.queryByTestId("toolbar-copy-resume")).toBeNull();
    expect(screen.queryByTestId("toolbar-copy-attach")).toBeNull();
    // CMUX 按钮对未绑定节点仍应存在（open-or-focus）
    expect(screen.getByTestId("toolbar-cmux-open")).toBeDefined();
  });

  it("clicking toolbar cmux on unbound node posts to /open-cmux not /focus", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, action: "created_new" }) });

    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: "running",
      startupStatus: "ready" as const,
      canonicalSessionName: "dev-impl@test-rig",
      binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: null },
      resumeToken: null,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    fireEvent.click(screen.getByTestId("toolbar-cmux-open"));

    await waitFor(() => {
      const openCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/open-cmux")
      );
      expect(openCall).toBeDefined();
      expect(openCall![0]).toBe("/api/rigs/rig-1/nodes/dev.impl/open-cmux");
      expect(openCall![1]).toEqual(expect.objectContaining({ method: "POST" }));
    });

    // 不得调用 /focus
    const focusCall = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
    );
    expect(focusCall).toBeUndefined();
  });

  it("clicking toolbar cmux on bound node posts to /open-cmux and shows feedback", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, action: "focused_existing" }) });

    const data = {
      logicalId: "dev.impl",
      rigId: "rig-1",
      role: "worker",
      runtime: "claude-code",
      model: null,
      status: "running",
      startupStatus: "ready" as const,
      canonicalSessionName: "dev-impl@test-rig",
      binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: "s1" },
      resumeToken: null,
    };

    render(
      <ReactFlowProvider>
        <RigNode data={data} />
      </ReactFlowProvider>
    );

    fireEvent.click(screen.getByTestId("toolbar-cmux-open"));

    await waitFor(() => {
      const openCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/open-cmux")
      );
      expect(openCall).toBeDefined();
      expect(openCall![0]).toBe("/api/rigs/rig-1/nodes/dev.impl/open-cmux");
    });

    // 闪烁反馈
    await waitFor(() => {
      expect(screen.getByTestId("toolbar-cmux-open").textContent).toBe("已打开");
    });
  });

  it("treats nodes as non-draggable so the canvas can pan through them", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      const node = container.querySelector(".react-flow__node-rigNode");
      expect(node).not.toBeNull();
      expect(node?.className).not.toContain("draggable");
    });
  });
});

// UIF-T05：Edge 样式 helper 测试
describe("Edge styles", () => {
  it("delegates_to: solid, secondary blue", async () => {
    const { getEdgeStyle } = await import("../src/lib/edge-styles.js");
    const result = getEdgeStyle("delegates_to");
    expect(result.style.stroke).toBe("#546073");
    expect(result.style.strokeDasharray).toBeUndefined();
    expect(result.markerEnd.type).toBe(MarkerType.ArrowClosed);
    expect(result.label).toBeUndefined();
  });

  it("spawned_by: dashed, secondary blue", async () => {
    const { getEdgeStyle } = await import("../src/lib/edge-styles.js");
    const result = getEdgeStyle("spawned_by");
    expect(result.style.stroke).toBe("#546073");
    expect(result.style.strokeDasharray).toBeDefined();
    expect(result.markerEnd.type).toBe(MarkerType.ArrowClosed);
    expect(result.label).toBeUndefined();
  });

  it("can_observe: dotted, secondary blue", async () => {
    const { getEdgeStyle } = await import("../src/lib/edge-styles.js");
    const result = getEdgeStyle("can_observe");
    expect(result.style.stroke).toBe("#546073");
    expect(result.style.strokeDasharray).toBeDefined();
    expect(result.markerEnd.type).toBe(MarkerType.ArrowClosed);
    expect(result.label).toBeUndefined();
  });

  it("uses: thin dashed, secondary blue", async () => {
    const { getEdgeStyle } = await import("../src/lib/edge-styles.js");
    const result = getEdgeStyle("uses");
    expect(result.style.stroke).toBe("#546073");
    expect(result.style.strokeWidth).toBe(1);
    expect(result.style.strokeDasharray).toBeDefined();
    expect(result.markerEnd.type).toBe(MarkerType.ArrowClosed);
    expect(result.label).toBeUndefined();
  });
});

// UIF-T05：Graph 入场动画
describe("Graph entrance animation", () => {
  it("initial navigation sets data-animated='true'", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      const view = screen.getByTestId("graph-view");
      expect(view.dataset.animated).toBe("true");
    });
  });

  it("after initial render, subsequent renders have data-animated='false'", async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      return Promise.resolve(mockGraphResponse(sampleNodes(), sampleEdges()));
    });

    const { rerender } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    // 等首次带数据渲染
    await waitFor(() => expect(screen.getByTestId("graph-view")).toBeDefined());

    // 强制重渲染（模拟数据刷新）
    rerender(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    // useEffect 设置 animatedRigRef 后，shouldAnimate 应为 false
    await waitFor(() => {
      const view = screen.getByTestId("graph-view");
      expect(view.dataset.animated).toBe("false");
    });
  });

  it("empty topology state renders wireframe ghost", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse([], []));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByTestId("empty-topology")).toBeDefined();
      expect(screen.getByText("空拓扑")).toBeDefined();
    });
  });

  it("loading state shows skeleton", async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByTestId("graph-loading")).toBeDefined();
    });
  });
});

describe("RigGraph SSE integration", () => {
  it("SSE message triggers second fetch to /api/rigs/:id/graph", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    // 等初始 fetch
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // 触发共享 topology 事件消息。
    act(() => {
      const es = instances.find((i) => i.url === "/api/events")!;
      es.simulateMessage('{"type":"node.added","rigId":"rig-1"}');
    });

    // 等 debounced refetch
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1]![0]).toBe("/api/rigs/rig-1/graph");
    });
  });

  it("useRigGraph refetch triggered by SSE produces fresh data", async () => {
    // 首次 fetch：1 节点。第二次 fetch：2 节点。
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(
        [sampleNodes()[0]!],
        []
      ))
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    // 等 1 节点初始渲染
    await waitFor(() => {
      const nodes = container.querySelectorAll("[data-testid^='rf__node-']");
      expect(nodes.length).toBe(1);
    });

    // 触发共享 topology 事件消息以触发 refetch。
    act(() => {
      const es = instances.find((i) => i.url === "/api/events")!;
      es.simulateMessage('{"type":"node.added","rigId":"rig-1"}');
    });

    // 等 2 节点重渲染
    await waitFor(() => {
      const nodes = container.querySelectorAll("[data-testid^='rf__node-']");
      expect(nodes.length).toBe(2);
    });
  });

  it("reconnecting indicator visible on EventSource error", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => expect(instances.length).toBeGreaterThan(0));

    act(() => {
      instances.find((i) => i.url === "/api/events")!.simulateError();
    });

    await waitFor(() => {
      expect(screen.getByText(/实时更新已与后台服务断开/i)).toBeDefined();
    });
  });

  it("reconnect open event clears indicator and triggers refetch", async () => {
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => expect(instances.length).toBeGreaterThan(0));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // 错误
    act(() => {
      instances.find((i) => i.url === "/api/events")!.simulateError();
    });

    await waitFor(() => {
      expect(screen.getByText(/实时更新已与后台服务断开/i)).toBeDefined();
    });

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));

    // 重连（open 事件）
    act(() => {
      instances.find((i) => i.url === "/api/events")!.simulateOpen();
    });

    await waitFor(() => {
      // 指示器清除
      expect(screen.queryByText(/reconnecting/i)).toBeNull();
      // Refetch 触发
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});

describe("RigGraph click-through to focus", () => {
  it("click node with cmux binding -> POST to focus URL", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    // 点击带 cmux binding 的节点（orchestrator, n1）
    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      const focusCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
      );
      expect(focusCall).toBeDefined();
      expect(focusCall![0]).toBe("/api/rigs/rig-1/nodes/orchestrator/focus");
      expect(focusCall![1]).toEqual(expect.objectContaining({ method: "POST" }));
    });
  });

  it("successful focus -> success indicator shown", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/已聚焦/i)).toBeDefined();
    });
  });

  it("click node without binding -> 'not bound' message, no focus fetch", async () => {
    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n2']")).not.toBeNull();
    });

    mockFetch.mockClear();

    // 点击未绑定节点（worker, n2, binding=null）
    const node = container.querySelector("[data-testid='rf__node-n2']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/未绑定/i)).toBeDefined();
    });

    // 未发生 focus API 调用
    const focusCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
    );
    expect(focusCalls).toHaveLength(0);
  });

  it("聚焦 API 返回 cmux 不可用时显示‘cmux 未连接’", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, code: "unavailable" }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/cmux 未连接/i)).toBeDefined();
    });
  });

  it("focus API error -> error message shown", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: false, status: 500 });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/聚焦失败/i)).toBeDefined();
    });
  });

  it("click uses correct rigId and logicalId in URL path", async () => {
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="my-rig-id" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      const focusCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
      );
      expect(focusCall![0]).toBe("/api/rigs/my-rig-id/nodes/orchestrator/focus");
    });
  });

  it("click node with binding but no cmuxSurface -> 'not bound' message", async () => {
    const nodes = [...sampleNodes(), nodeWithBindingNoSurface()];
    mockFetch.mockResolvedValueOnce(mockGraphResponse(nodes, sampleEdges()));

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n3']")).not.toBeNull();
    });

    mockFetch.mockClear();

    // 点击 reviewer 节点（有 binding 但 cmuxSurface=null）
    const node = container.querySelector("[data-testid='rf__node-n3']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(screen.getByText(/未绑定/i)).toBeDefined();
    });

    // 无 focus API 调用
    const focusCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
    );
    expect(focusCalls).toHaveLength(0);
  });

  it("sequential clicks: newer message not cleared by older timer", async () => {
    // 第一次点击：成功。第二次点击：不可用。
    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, code: "unavailable" }) });

    const { container } = render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-1" /></QueryWrapper>);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    const node = container.querySelector("[data-testid='rf__node-n1']")!;

    // 首次点击 -> "Focused"
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByText(/已聚焦/i)).toBeDefined();
    });

    // 紧接着第二次点击 → “cmux 未连接”。
    // 这应取消第一个 timer
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => {
      expect(screen.getByText(/cmux 未连接/i)).toBeDefined();
    });

    // 更新的消息应可见（旧 timer 已取消）
    expect(screen.getByText(/cmux 未连接/i)).toBeDefined();
    // 旧 "Focused" 消息应消失（被替换）
    expect(screen.queryByText(/已聚焦/i)).toBeNull();
  });

  // === PUX-T05: Package badge tests ===

  it("node with packageRefs shows package badge with count and names in title", async () => {
    const nodesWithPkgs = [
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "orchestrator",
          role: "orchestrator",
          runtime: "claude-code",
          model: "opus",
          status: "running",
          packageRefs: ["acme-standards", "test-tools"],
          binding: { tmuxSession: "r01-orch1-lead", cmuxSurface: "s-1" },
        },
      },
    ];

    mockFetch.mockResolvedValue(mockGraphResponse(nodesWithPkgs, []));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-badge-1" /></QueryWrapper>);

    await waitFor(() => {
      const badge = screen.getByTestId("package-badge");
      expect(badge).toBeDefined();
      expect(badge.textContent).toContain("包 2");
      expect(badge.getAttribute("title")).toBe("acme-standards, test-tools");
    });
  });

  it("node without packageRefs has no badge", async () => {
    // sampleNodes() 无 packageRefs
    mockFetch.mockResolvedValue(mockGraphResponse(sampleNodes(), sampleEdges()));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-badge-2" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getAllByTestId("rig-node").length).toBeGreaterThan(0);
    });

    expect(screen.queryByTestId("package-badge")).toBeNull();
  });

  it("badge click does not trigger node focus/cmux handler", async () => {
    const nodesWithPkgs = [
      {
        id: "n1",
        type: "rigNode",
        position: { x: 0, y: 0 },
        data: {
          logicalId: "orchestrator",
          role: "orchestrator",
          runtime: "claude-code",
          model: "opus",
          status: "running",
          packageRefs: ["acme-standards"],
          binding: { tmuxSession: "r01-orch1-lead", cmuxSurface: "s-1" },
        },
      },
    ];

    mockFetch.mockResolvedValue(mockGraphResponse(nodesWithPkgs, []));
    render(<QueryWrapper><RigGraph showDiscovered={false} rigId="rig-badge-3" /></QueryWrapper>);

    await waitFor(() => {
      expect(screen.getByTestId("package-badge")).toBeDefined();
    });

    // 重置 fetch mock 以追踪 focus 调用
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ focused: true }) });

    // 点击 badge
    const badge = screen.getByTestId("package-badge");
    await act(async () => {
      badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // 不应发生 focus POST（stopPropagation 阻止节点点击）
    const focusCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/focus")
    );
    expect(focusCalls.length).toBe(0);
  });
});

describe("RigGraph discovery integration", () => {
  it("discovered sessions appear as dashed nodes when showDiscovered=true", async () => {
    // 同时 mock graph 与 discovery endpoint
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/api/discovery")) {
        return {
          ok: true,
          json: async () => [
            { id: "ds-1", tmuxSession: "organic", tmuxPane: "%0", runtimeHint: "claude-code", confidence: "high", cwd: "/tmp", status: "active" },
          ],
        };
      }
      // Graph endpoint（图端点）
      return {
        ok: true,
        json: async () => ({ nodes: sampleNodes(), edges: sampleEdges() }),
      };
    });

    render(
      <QueryWrapper>
        <RigGraph showDiscovered={true} rigId="rig-1" />
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(screen.getByTestId("graph-view")).toBeTruthy();
    });

    // 等 discovered 节点出现
    await waitFor(() => {
      expect(screen.getByTestId("discovered-graph-node")).toBeTruthy();
    });

    // discovered 节点应有虚线边框
    const discoveredNode = screen.getByTestId("discovered-graph-node");
    expect(discoveredNode.className).toContain("border-dashed");
  });
});

// NS-T12：graph selection——点击 graph 节点导航到规范 agent-detail 中心页
//（LiveNodeDetails）。
//
// V1 polish slice Phase 5.1 P5.1-2 + DRIFT P5.1-D2：graph 节点点击从
// setSelection({type:'seat-detail'}) drawer-open 迁移到
// useNavigate(/topology/seat/$rigId/$logicalId)。与 Explorer 树点击 + topology
// 表行点击对齐。测试断言 useNavigate 以规范 seat URL 调用。

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

describe("RigGraph node selection (P5.1-2 navigate)", () => {
  it("click node -> navigate({ to: '/topology/seat/$rigId/$logicalId', params })", async () => {
    navigateSpy.mockClear();

    mockFetch
      .mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { container } = render(
      <QueryWrapper>
        <RigGraph showDiscovered={false} rigId="rig-1" />
      </QueryWrapper>
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    // 点击 orchestrator 节点（n1）
    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/topology/seat/$rigId/$logicalId",
          params: { rigId: "rig-1", logicalId: encodeURIComponent("orchestrator") },
        }),
      );
    });

    // OPR.0.4.6.MH2 rev1-r2 B1 local 对照：local host 上绑定节点的点击也触发
    // focus POST（由第二个 mock 消费），且 hover toolbar affordance 已挂载。
    await waitFor(() => {
      expect(
        mockFetch.mock.calls.some(
          ([url, init]) =>
            String(url).includes("/focus") && (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true);
    });
    expect(container.querySelector("[data-testid='node-toolbar']")).not.toBeNull();
  });

  // OPR.0.4.6.MH2 rev1-r2 B1：REMOTE selection 下节点点击保留 read drill-in
  //（navigate），但 bare-local focus POST 永不触发，RigNode hover toolbar
  //（cmux-open + terminal preview）永不挂载。
  it("remote-selected: click node navigates but fires ZERO POSTs; node toolbar absent (rev1-r2 B1)", async () => {
    navigateSpy.mockClear();

    mockFetch.mockResolvedValueOnce(mockGraphResponse(sampleNodes(), sampleEdges()));

    // gcTime 保持有限大（非共享 0），使 primed 条目存活直到 disabled observer
    // 订阅。
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
    });
    // gate 原语是 useSelectedHostId CACHE OBSERVER——直接 prime ["hosts"] 条目
    //（无 /api/hosts fetch 走 sequenced mock）。
    qc.setQueryData(["hosts"], {
      ownName: "Linkpix Proof Host",
      selected: "vps-a",
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: true, status: "reachable" }],
    });

    const { container } = render(
      <QueryClientProvider client={qc}>
        <RigGraph showDiscovered={false} rigId="rig-1" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(container.querySelector("[data-testid='rf__node-n1']")).not.toBeNull();
    });

    // RigNode gate：remote graph 节点上无 local action toolbar。
    expect(container.querySelector("[data-testid='node-toolbar']")).toBeNull();

    // 点击绑定 orchestrator 节点（n1——local 时会 focus-POST）。
    const node = container.querySelector("[data-testid='rf__node-n1']")!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // read drill-in 保留……
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/topology/seat/$rigId/$logicalId",
          params: { rigId: "rig-1", logicalId: encodeURIComponent("orchestrator") },
        }),
      );
    });

    // ……但任何 POST 都未触发（focus 支路被 gate）。
    const postCalls = mockFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toEqual([]);
  });
});

// Task 7：RigNode spec hint 渲染
describe("RigNode spec hint", () => {
  afterEach(() => cleanup());

  it("renders spec hint when resolvedSpecName is set", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: null,
          resolvedSpecName: "impl-agent",
          profile: "default",
          edgeCount: 2,
        }} />
      </ReactFlowProvider>
    );

    const hint = screen.getByTestId("spec-hint");
    expect(hint).toBeDefined();
    expect(hint.textContent).toContain("impl-agent");
    expect(hint.textContent).toContain("default");
  });

  it("does not render spec hint when resolvedSpecName is null", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          binding: null,
          resolvedSpecName: null,
          profile: null,
          edgeCount: 0,
        }} />
      </ReactFlowProvider>
    );

    expect(screen.queryByTestId("spec-hint")).toBeNull();
  });

  it("exposes hover metadata for runtime inspection", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: "opus",
          status: "running",
          canonicalSessionName: "dev-impl@test-rig",
          binding: null,
          resolvedSpecName: "impl-agent",
          profile: "default",
          edgeCount: 2,
        }} />
      </ReactFlowProvider>
    );

    const node = screen.getByTestId("rig-node");
    expect(node.getAttribute("title")).toContain("会话：dev-impl@test-rig");
    expect(node.getAttribute("title")).toContain("规格：impl-agent");
    expect(node.getAttribute("title")).toContain("配置档：default");
    expect(node.getAttribute("title")).toContain("边：2");
  });

  // --- Context usage prominence tests ---

  it("renders prominent context percentage for known fresh seat", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl", role: "worker", runtime: "claude-code",
          model: null, status: "running", binding: null,
          contextAvailability: "known", contextUsedPercentage: 85, contextFresh: true,
          contextTotalInputTokens: 120_000, contextTotalOutputTokens: 14_000,
        }} />
      </ReactFlowProvider>
    );

    const badge = screen.getByTestId("context-badge");
    expect(badge.textContent).toContain("85%");
    expect(badge.className).toContain("text-red-600"); // >=80 = red
    expect(badge.className).toContain("font-bold");
    expect(badge.className).not.toContain("opacity-50");
    const tokenTotal = screen.getByTestId("token-total");
    expect(tokenTotal.textContent).toContain("134k");
    expect(tokenTotal.getAttribute("title")).toContain("令牌数：134,000");
  });

  it("renders stale context with reduced opacity", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl", role: "worker", runtime: "claude-code",
          model: null, status: "running", binding: null,
          contextAvailability: "known", contextUsedPercentage: 45, contextFresh: false,
        }} />
      </ReactFlowProvider>
    );

    const badge = screen.getByTestId("context-badge");
    expect(badge.textContent).toContain("45%");
    expect(badge.className).toContain("text-green-700"); // <60 = green
    expect(badge.className).toContain("opacity-50"); // stale
  });

  it("renders '?' for unknown context (Codex/terminal)", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.qa", role: "worker", runtime: "codex",
          model: null, status: "running", binding: null,
          contextAvailability: "unknown", contextUsedPercentage: null, contextFresh: false,
        }} />
      </ReactFlowProvider>
    );

    const badge = screen.getByTestId("context-badge-unknown");
    expect(badge.textContent?.trim()).toBe("?");
  });

  it("renders amber for warning-range context (60-80%)", () => {
    render(
      <ReactFlowProvider>
        <RigNode data={{
          logicalId: "dev.impl", role: "worker", runtime: "claude-code",
          model: null, status: "running", binding: null,
          contextAvailability: "known", contextUsedPercentage: 65, contextFresh: true,
        }} />
      </ReactFlowProvider>
    );

    const badge = screen.getByTestId("context-badge");
    expect(badge.className).toContain("text-amber-600");
  });
});
