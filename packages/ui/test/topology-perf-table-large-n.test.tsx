// V0.3.1 缺陷修复 slice topology-perf——大 N 冒烟 fixture。
//
// 2026-05-11 的生产 VM 巡检报告 /topology 表格视图存在随规模增长的页面挂起：跨多个工作组
// 约 13 个以上席位时 Chrome 挂起，较小拓扑无法复现。本文件是合成 fixture 冒烟门禁：
// 使用跨 4 个工作组的 N=20 个席位渲染 TopologyTableView，并断言渲染路径保持有界。
//
// 本测试断言的内容，以及明确不作断言的内容：
//
//   会断言：
//     - 跨 4 个工作组挂载 N=20 行时，发出有界且确定的 fetch 模式：恰好一次
//       /api/rigs/summary，并为每个工作组恰好调用一次 /api/rigs/rig-N/nodes；无重复，
//       无未知路径。逐行/逐渲染重复查询清单是规模挂起背后的过度获取类别，本测试可确定性捕获。
//       Slice 52 已替换不稳定的 `elapsedMs < 2000` 断言；它测量的是机器负载而非代码，
//       在全局争用下会误报失败。
//     - 每种 DOM 单元格（StatusCell、ContextCell、TokenCell）的数量恰好为 N，即没有重复挂载行。
//     - 使用稳定属性重新渲染父级后，表格 testid 骨架保持稳定；这是 React key 与协调的冒烟检查，
//       不是 memoization 证明。
//
//   不断言：
//     - 任何墙上时钟/渲染耗时上限。happy-dom 耗时取决于机器负载而非代码路径，因此争用时
//       时间阈值无法证明问题，这也是本文件原先的缺陷。
//     - Chrome 在大规模下的绘制/合成性能。happy-dom 不做绘制或合成，只有 Chrome 能判断挂起。
//     - 单元格组件的 React.memo 包装器确实跳过重渲染。本测试无法区分带 memo 与不带 memo 的
//       构建，两者都会通过。
//     - 表格挂起的根因已修复。
//
// 局限：
//   - happy-dom 没有以可让测试区分 memo 子树与非 memo 子树的方式实现 React.Profiler
//     渲染阶段跟踪，除非导出并埋点内部单元格组件。遵循本 slice“范围窄且如实”的约定，
//     我们不导出单元格组件，并如实限定测试范围。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// 按缺陷报告，跨 4 个工作组的 N=20 个席位构成生产规模 fixture。每个工作组 5 个席位，
// 对应典型中型工作组：一对 orch HA 加 3 个专用席位。
const RIG_COUNT = 4;
const SEATS_PER_RIG = 5;
const TOTAL_SEATS = RIG_COUNT * SEATS_PER_RIG;

function makeRig(i: number) {
  return { id: `rig-${i}`, name: `synth-rig-${i}` };
}

function makeSeat(rigId: string, rigName: string, idx: number) {
  return {
    rigId,
    rigName,
    logicalId: `${rigName}.seat-${idx}`,
    podId: idx % 2 === 0 ? "orch" : "specialist",
    podNamespace: idx % 2 === 0 ? "orch" : "specialist",
    canonicalSessionName: `${rigName}-seat-${idx}@${rigName}`,
    nodeKind: "agent",
    runtime: "claude-code",
    sessionStatus: "running",
    startupStatus: "ready",
    contextUsage: {
      usedPercentage: 20 + idx * 5,
      remainingPercentage: 80 - idx * 5,
      contextWindowSize: 320000,
      availability: "known",
      sampledAt: "2026-05-11T10:00:00Z",
      fresh: true,
      totalInputTokens: 100_000 + idx * 5_000,
      totalOutputTokens: 10_000 + idx * 1_000,
    },
    restoreOutcome: "n-a",
    tmuxAttachCommand: null,
    resumeCommand: null,
    latestError: null,
  };
}

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) {
      const rigs = Array.from({ length: RIG_COUNT }, (_, i) => makeRig(i));
      return new Response(JSON.stringify(rigs));
    }
    const m = url.match(/\/api\/rigs\/rig-(\d+)\/nodes/);
    if (m) {
      const rigIdx = Number(m[1]);
      const rig = makeRig(rigIdx);
      const seats = Array.from({ length: SEATS_PER_RIG }, (_, i) =>
        makeSeat(rig.id, rig.name, i),
      );
      return new Response(JSON.stringify(seats));
    }
    return new Response("[]");
  });
});

afterEach(() => {
  cleanup();
});

function withQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("TopologyTableView large-N smoke (bug-fix slice topology-perf)", () => {
  it("mounts N=20 seats with a bounded fetch pattern: exactly 1 summary + one /nodes per rig, no duplicates or unknowns", async () => {
    const { container } = withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-testid^='topology-table-row-']");
      expect(rows.length).toBe(TOTAL_SEATS);
    });

    // Slice 52：用规模挂起真正违反的确定性不变量——清单过度获取——替换不稳定的墙上时钟阈值
    //（elapsedMs < 2000；它测量机器负载，在全局争用下会误报失败）。除单次工作组名册摘要外，
    // TopologyTableView 按需且恰好一次加载每个工作组的节点（useQueries 以工作组为键）。
    const urls = mockFetch.mock.calls.map(([u]) => String(u));
    const NODES_RE = /\/api\/rigs\/rig-(\d+)\/nodes/;
    const summaryCalls = urls.filter((u) => u.includes("/api/rigs/summary"));
    const nodeCalls = urls.filter((u) => NODES_RE.test(u));
    const unknownCalls = urls.filter(
      (u) => !u.includes("/api/rigs/summary") && !NODES_RE.test(u),
    );

    // 恰好一次工作组名册摘要请求。
    expect(summaryCalls).toHaveLength(1);
    // 每个工作组一次 /nodes 获取，且恰好获取一次。Set 大小检查独立于计数，属于承重断言：
    // 若重复查询一个工作组而漏掉另一个（如 [0,1,1,2]），nodeCalls 长度仍为 4，但 Set 会缩为
    // 3，本行应亮红而不能空洞通过。反证只覆盖它扰动的轴，因此两者都要断言。
    const rigIdxSet = new Set(nodeCalls.map((u) => u.match(NODES_RE)![1]));
    expect(nodeCalls).toHaveLength(RIG_COUNT);
    expect(rigIdxSet.size).toBe(RIG_COUNT);
    // 不获取任何意外路径。
    expect(unknownCalls).toHaveLength(0);
    // fetch 总预算恰好为 5：1 次摘要 + 4 份工作组清单。任一工作组重复获取都会让此断言和
    // nodeCalls 断言亮红。
    expect(urls).toHaveLength(1 + RIG_COUNT);
  });

  it("renders exactly N cells of each kind (one per row); count is bounded by N (no double-mounts)", async () => {
    const { container } = withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-testid^='topology-table-row-']");
      expect(rows.length).toBe(TOTAL_SEATS);
    });
    const contextCells = container.querySelectorAll(
      "[data-testid^='topology-table-context-']",
    );
    const tokenCells = container.querySelectorAll(
      "[data-testid^='topology-table-tokens-']",
    );
    const statusCells = container.querySelectorAll(
      "[data-testid^='topology-table-status-']",
    );
    expect(contextCells.length).toBe(TOTAL_SEATS);
    expect(tokenCells.length).toBe(TOTAL_SEATS);
    expect(statusCells.length).toBe(TOTAL_SEATS);
  });

  it("re-rendering the parent with stable props leaves the table testid skeleton stable", async () => {
    // React key 与协调的冒烟检查，不是 memo 证明，见文件头。此断言捕获“重渲染产生新 testid”
    // 或“重渲染卸载行”；它们与本 slice 目标中的 memo 收益属于不同缺陷类别。
    const { container, rerender } = withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-testid^='topology-table-row-']");
      expect(rows.length).toBe(TOTAL_SEATS);
    });
    const before = Array.from(
      container.querySelectorAll("[data-testid^='topology-table-context-']"),
    ).slice(0, 5).map((el) => el.getAttribute("data-testid"));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <TopologyTableView />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-testid^='topology-table-row-']");
      expect(rows.length).toBe(TOTAL_SEATS);
    });
    const after = Array.from(
      container.querySelectorAll("[data-testid^='topology-table-context-']"),
    ).slice(0, 5).map((el) => el.getAttribute("data-testid"));

    expect(after).toEqual(before);
  });
});
