// V1 attempt-3 Phase 5 ship-gate bounce P0-1 + P0-2 回归守卫。
//
// P0-1：TopologyTableView 此前在 scopedRigs.map() 内调用 useNodeInventory——
// 当 rigs 从 undefined → [N]，hook 计数跳 0 → N，违反 Rules-of-Hooks。
// 桌面端此问题被掩盖，因 table view-mode 只在用户点击后挂载，
// 彼时 rigs 已解析（首渲染计数一致）。移动端（P5-9）/topology graph
// 首渲染即降级为 table，故 table 在 rigs 解析前挂载 → 崩溃。
// 修复：改用 `useQueries`（无论数组长度仅一次 hook 调用）。
//
// P0-2：NodeDetailPanel 此前自钉
// `absolute inset-y-0 right-0 z-20 w-80`（320px），在 38rem（608px）
// drawer chrome 内留 ~288px 孤立空白。修复：改用 fill-parent
//（`relative w-full h-full`）。
//
// 两个回归都破坏 V1 ship-gate UX；测试须永久守卫。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import path from "node:path";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
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
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// -----------------------------------------------------------------------
// P0-1：TopologyTableView 不崩溃回归——在 rigs 解析前挂载。
// -----------------------------------------------------------------------

import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

describe("TopologyTableView P0-1 regression: no rules-of-hooks crash on first-render-before-rigs-resolved", () => {
  it("mounts cleanly when /api/rigs/summary has not yet resolved (mobile P5-9 first-render path)", async () => {
    let resolveSummary: ((value: unknown) => void) | null = null;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) {
        // 挂起 summary promise，使首渲染见 rigs=undefined，
        // 再解析它 → 第二渲染见 rigs=[N]。修复前此序列
        // 崩溃（hook 计数 0 → N）。
        return new Promise((resolve) => {
          resolveSummary = (value) => {
            resolve(new Response(JSON.stringify(value)));
          };
        });
      }
      const m = url.match(/\/api\/rigs\/([^/]+)\/nodes/);
      if (m) {
        return new Response(JSON.stringify([]));
      }
      return new Response("[]");
    });

    const { container } = withQueryClient(<TopologyTableView />);
    // 初始渲染：rigs 尚未解析；组件不得崩溃。
    expect(container.querySelector("[data-testid='topology-table-view']")).toBeTruthy();

    // 现用多 rigs 解析 summary——旧形状下 hook 计数会变；
    // 修复后（useQueries）保持 1。
    resolveSummary!([
      { id: "rig-1", name: "rig-1" },
      { id: "rig-2", name: "rig-2" },
      { id: "rig-3", name: "rig-3" },
    ]);

    await waitFor(() => {
      // rigs 解析后组件仍存活。
      expect(container.querySelector("[data-testid='topology-table-view']")).toBeTruthy();
    });
  });

  it("remote selection threads host param through table node-inventory fan-out", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary?host=vps-a") {
        return new Response(JSON.stringify([{ id: "rig-1", name: "remote-rig" }]));
      }
      if (url === "/api/rigs/rig-1/nodes?host=vps-a") {
        return new Response(JSON.stringify([]));
      }
      return new Response("[]");
    });

    const { container } = withQueryClient(<TopologyTableView />, { selectedHost: "vps-a" });
    expect(container.querySelector("[data-testid='topology-table-view']")).toBeTruthy();
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/summary?host=vps-a", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(mockFetch).toHaveBeenCalledWith("/api/rigs/rig-1/nodes?host=vps-a");
    });
    expect(
      mockFetch.mock.calls.some(([url]) => String(url) === "/api/rigs/rig-1/nodes"),
    ).toBe(false);
  });

  it("source asserts useQueries replaces the .map(useNodeInventory) loop (ritual #9)", () => {
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../src/components/topology/TopologyTableView.tsx",
      ),
      "utf8",
    );
    // useQueries import + 调用存在。
    expect(src).toMatch(/import\s*\{[^}]*useQueries[^}]*\}\s*from\s*["']@tanstack\/react-query["']/);
    expect(src).toMatch(/useQueries\s*\(/);
    // 负向断言：旧 `.map((r) => ({ ..., inv: useNodeInventory(r.id) }))`
    // 模式不存在——先剥注释。
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    expect(codeOnly).not.toMatch(/inv:\s*useNodeInventory/);
  });
});

// -----------------------------------------------------------------------
// P0-2：NodeDetailPanel fill-parent 回归——不自钉。
// -----------------------------------------------------------------------

describe("NodeDetailPanel P0-2 regression: drawer fill-parent guard", () => {
  // V1 polish slice Phase 5.1 P5.1-D2：NodeDetailPanel.tsx 在 V1 polish
  // 完全退役；规范 agent-detail 表面现为 LiveNodeDetails.tsx（居中页）。
  // 原 P0-2 ship-gate bounce 回归守卫 NodeDetailPanel 的 drawer fill-parent
  // 布局；既然文件已删，守卫变为文件不存在断言（位于
  // node-selection-migration.test.tsx）。本段转为对 LiveNodeDetails 的
  // 配套源码断言：规范表面不得回退到旧 absolute 自钉。
  it("LiveNodeDetails.tsx does not regress into legacy 'absolute inset-y-0 right-0 w-80' self-pinning", async () => {
    const liveSrc = readFileSync(
      path.resolve(__dirname, "../src/components/LiveNodeDetails.tsx"),
      "utf8",
    );
    const codeOnly = liveSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    expect(codeOnly).not.toMatch(/absolute\s+inset-y-0\s+right-0/);
    expect(codeOnly).not.toMatch(/\bw-80\b/);
  });
});
