import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePsEntries } from "../src/hooks/usePsEntries.js";
import { useRigSummary } from "../src/hooks/useRigSummary.js";
import { useArchivedRigs } from "../src/hooks/useArchivedRigs.js";
import { useRigGraph } from "../src/hooks/useRigGraph.js";
import { useSnapshots } from "../src/hooks/useSnapshots.js";
import { useCreateSnapshot, useRestoreSnapshot, useImportRig } from "../src/hooks/mutations.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

let qc: QueryClient;

beforeEach(() => {
  mockFetch.mockReset();
  qc = createTestQueryClient();
});

afterEach(() => { cleanup(); });

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// useRigSummary 测试 harness
function SummaryHarness() {
  const { data, isPending, error } = useRigSummary();
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">data: {data?.length}</div>;
}

// OPR.0.3.3.19——useArchivedRigs harness（仅归档 section feed）。
function ArchivedHarness({ enabled }: { enabled?: boolean }) {
  const { data, isPending, error } = useArchivedRigs({ enabled });
  if (error) return <div data-testid="state">error: {error.message}</div>;
  if (isPending) return <div data-testid="state">pending</div>;
  return <div data-testid="state">archived: {data?.length}</div>;
}

// useRigGraph 测试 harness
function GraphHarness({ rigId }: { rigId: string }) {
  const { data, isPending, error } = useRigGraph(rigId);
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">nodes: {data?.nodes.length}</div>;
}

// useSnapshots 测试 harness
function SnapshotsHarness({ rigId }: { rigId: string }) {
  const { data, isPending, error } = useSnapshots(rigId);
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">snaps: {data?.length}</div>;
}

// Mutation 测试 harness
function CreateSnapshotHarness({ rigId }: { rigId: string }) {
  const mutation = useCreateSnapshot(rigId);
  return (
    <div>
      <button data-testid="create" onClick={() => mutation.mutate()}>Create</button>
      <span data-testid="status">{mutation.isPending ? "pending" : mutation.isSuccess ? "success" : "idle"}</span>
    </div>
  );
}

function RestoreHarness({ rigId }: { rigId: string }) {
  const mutation = useRestoreSnapshot(rigId);
  return (
    <div>
      <button data-testid="restore" onClick={() => mutation.mutate("snap-1")}>Restore</button>
      <span data-testid="status">{mutation.isPending ? "pending" : mutation.isSuccess ? "success" : "idle"}</span>
    </div>
  );
}

function ImportHarness() {
  const mutation = useImportRig();
  return (
    <div>
      <button data-testid="import" onClick={() => mutation.mutate("yaml content")}>Import</button>
      <span data-testid="status">{mutation.isPending ? "pending" : mutation.isSuccess ? "success" : "idle"}</span>
    </div>
  );
}

describe("TanStack Query hooks", () => {
  // 测试 1：QueryClientProvider 包裹 app——组件可 useQuery
  it("component can use useQuery within QueryClientProvider", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    render(<Wrapper><SummaryHarness /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("data: 0"));
  });

  // 测试 2：useRigSummary 返回 summary 数据
  it("useRigSummary returns summary data with loading/success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null }],
    });
    render(<Wrapper><SummaryHarness /></Wrapper>);

    // 初始 pending
    expect(screen.getByTestId("state").textContent).toBe("pending");

    // Then data
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("data: 1"));
  });

  // OPR.0.3.3.19：useArchivedRigs 命中仅归档端点。
  it("useArchivedRigs fetches /api/rigs/summary?archived=only", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "r-arc", name: "tidy-me", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }],
    });
    render(<Wrapper><ArchivedHarness /></Wrapper>);
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("archived: 1"));
    expect(mockFetch).toHaveBeenCalledWith("/api/rigs/summary?archived=only");
  });

  // OPR.0.3.3.19：惰性 fan-out——禁用 query 永不拉取（折叠
  // Archive section 零成本）。
  it("useArchivedRigs does not fetch when disabled", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] });
    render(<Wrapper><ArchivedHarness enabled={false} /></Wrapper>);
    // 给 react-query 一个 tick；query 必须保持 idle（无拉取）。
    await waitFor(() => expect(screen.getByTestId("state")).toBeTruthy());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 测试 3：useRigGraph 返回 graph 数据
  it("useRigGraph returns graph data for specific rigId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ nodes: [{ id: "n1" }, { id: "n2" }], edges: [] }),
    });
    render(<Wrapper><GraphHarness rigId="r1" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("nodes: 2"));
    expect(mockFetch).toHaveBeenCalledWith("/api/rigs/r1/graph");
  });

  // 测试 4：useSnapshots 返回 snapshot 列表
  it("useSnapshots returns snapshot list for rigId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    });
    render(<Wrapper><SnapshotsHarness rigId="r1" /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("snaps: 3"));
    expect(mockFetch).toHaveBeenCalledWith("/api/rigs/r1/snapshots");
  });

  // 测试 5：SSE 事件触发 graph 失效——在 rig-events.test.tsx 覆盖

  // 测试 6：useCreateSnapshot mutation 失效 snapshot 列表
  it("useCreateSnapshot invalidates snapshot query on success", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "snap-new" }) });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><CreateSnapshotHarness rigId="r1" /></Wrapper>);
    act(() => { screen.getByTestId("create").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "r1", "snapshots"] });
  });

  // 测试 7：useRestoreSnapshot mutation 失效 rig 数据
  it("useRestoreSnapshot invalidates rig query on success", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ nodes: [] }) });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><RestoreHarness rigId="r1" /></Wrapper>);
    act(() => { screen.getByTestId("restore").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "r1"] });
  });

  // 测试 8：错误状态从失败 query 传播
  it("error state propagates from failed query", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    render(<Wrapper><SummaryHarness /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId("state").textContent).toContain("error"));
  });

  // 测试 9：useCreateSnapshot 同时失效 snapshots 和 summary
  it("useCreateSnapshot invalidates both snapshots and summary queries", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "snap-new" }) });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><CreateSnapshotHarness rigId="r1" /></Wrapper>);
    act(() => { screen.getByTestId("create").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));

    const calls = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls).toContain(JSON.stringify({ queryKey: ["rig", "r1", "snapshots"] }));
    expect(calls).toContain(JSON.stringify({ queryKey: ["rigs", "summary"] }));
  });

  // 测试 10：useImportRig 在成功 instantiate 后失效 summary query
  it("useImportRig invalidates summary query on success", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rigId: "new-rig", specName: "test", nodes: [] }),
    });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    render(<Wrapper><ImportHarness /></Wrapper>);
    act(() => { screen.getByTestId("import").click(); });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("success"));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rigs", "summary"] });
  });

  // slice-04 qitem-20260721000001-ps-stall-driver——U2（回归锁；test-only
  // 门禁曾真 RED，现绿）：ps 和 default-summary queryFn 都把 TanStack
  // AbortSignal 转发给 fetch，cancelQueries 将其中止。修复前，两个 queryFn
  // 都调 fetch(url) 无 signal。
  function PsSummaryHarness() {
    usePsEntries();
    useRigSummary();
    return <div data-testid="ps-summary">mounted</div>;
  }

  it("U2 regression: usePsEntries + useRigSummary forward the AbortSignal to fetch and honor cancel", async () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // never resolves -> queries stay pending
    render(<Wrapper><PsSummaryHarness /></Wrapper>);

    await waitFor(() => {
      expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/api/ps"))).toBe(true);
      expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/api/rigs/summary"))).toBe(true);
    });

    const psCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("/api/ps"));
    const sumCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("/api/rigs/summary"));
    const psSignal = (psCall?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    const sumSignal = (sumCall?.[1] as { signal?: AbortSignal } | undefined)?.signal;

    // test-only 门禁曾真 RED；现为回归。修复前，fetch 调用无 options/signal。
    expect(psSignal).toBeInstanceOf(AbortSignal);
    expect(sumSignal).toBeInstanceOf(AbortSignal);

    await act(async () => { await qc.cancelQueries(); });
    expect(psSignal?.aborted).toBe(true);
    expect(sumSignal?.aborted).toBe(true);
  });
});
