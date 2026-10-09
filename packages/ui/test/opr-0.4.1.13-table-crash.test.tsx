// OPR.0.4.1.13——拓扑 table-view 间歇性页面崩溃复现 + 修复。
//
// REPRO-FIRST（崩溃间歇，故先复现 + 根因再修）：拓扑 TABLE 视图
//（不同于丢弃基础设施节点的 GRID）为每个节点建行，且构建时不对
// `rigName`（rig.name）或 `logicalId`（n.logicalId）设默认。
// `globalFilterFn` 随后无守卫地对 `r.rigName` 和 `r.logicalId` 调
// `.toLowerCase()`。当 inventory JSON 中有畸形节点（null logicalId）或
// rig（null name）——真实边缘数据形状——在过滤框输入会抛
// `Cannot read properties of null (reading 'toLowerCase')`，
// 发生在 filtered-row-model 构建期间；table 无 error boundary 时整个
// /topology 页白屏。该间歇性（仅在过滤 + 畸形行时）吻合 founder 报告。
//
// 这些测试复现该精确触发；一旦过滤器守卫字段（且 error boundary 容纳
// 任何残留渲染 throw）即转 GREEN。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

// 一个畸形 inventory：rig-bad name=null，其唯一节点
// logicalId=null + runtime=null（如真实 JSON 那样违反声明类型）。
// rig-ok 正常，使 table 在坏行旁挂一个正常行。
beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) {
      return new Response(JSON.stringify([
        { id: "rig-bad", name: null },
        { id: "rig-ok", name: "ok-rig" },
      ]));
    }
    if (url.includes("/api/rigs/rig-bad/nodes")) {
      return new Response(JSON.stringify([
        {
          logicalId: null, podId: "p", podNamespace: "p", canonicalSessionName: null,
          nodeKind: "agent", runtime: null, sessionStatus: "running", startupStatus: null,
          contextUsage: null,
        },
      ]));
    }
    if (url.includes("/api/rigs/rig-ok/nodes")) {
      return new Response(JSON.stringify([
        {
          logicalId: "ok.seat", podId: "p", podNamespace: "p", canonicalSessionName: "s@ok-rig",
          nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready",
          contextUsage: null,
        },
      ]));
    }
    return new Response("[]");
  });
});

afterEach(() => cleanup());

function withQueryClient(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("OPR.0.4.1.13 — table-view crash repro (malformed row + filter)", () => {
  it("wraps every production ScopePages TopologyTableView mount in the table ErrorBoundary", () => {
    const src = readFileSync("src/components/topology/ScopePages.tsx", "utf8");
    const tableMounts = [...src.matchAll(/<TopologyTableView\b/g)].map((m) => m.index ?? -1);
    expect(tableMounts).toHaveLength(3);

    for (const mountIndex of tableMounts) {
      const beforeMount = src.slice(0, mountIndex);
      const lastTableBoundaryOpen = beforeMount.lastIndexOf('<ErrorBoundary label="表格视图">');
      const lastBoundaryClose = beforeMount.lastIndexOf("</ErrorBoundary>");
      expect(lastTableBoundaryOpen).toBeGreaterThan(lastBoundaryClose);

      const afterMount = src.slice(mountIndex);
      expect(afterMount.indexOf("</ErrorBoundary>")).toBeGreaterThan(-1);
    }
  });

  it("renders a malformed row (null rigName/logicalId) without crashing", async () => {
    withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      expect(screen.getAllByTestId(/^topology-table-row-/).length).toBeGreaterThanOrEqual(2);
    });
    // baseline：页面起来且坏行在场（过滤前正常）。
    expect(screen.getByTestId("topology-table-view")).toBeTruthy();
  });

  it("does NOT crash when the user FILTERS with a malformed row present (the trigger)", async () => {
    withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      expect(screen.getAllByTestId(/^topology-table-row-/).length).toBeGreaterThanOrEqual(2);
    });
    const search = screen.getByTestId("topology-table-search");
    // 输入对每个行（含 null 字段行）跑 globalFilterFn。
    // 修复前：r.rigName.toLowerCase() / r.logicalId.toLowerCase() 抛错 -> 页面崩溃。
    expect(() => {
      fireEvent.change(search, { target: { value: "ok" } });
    }).not.toThrow();
    // table 存活 + 过滤到匹配的正常行。
    expect(screen.getByTestId("topology-table-view")).toBeTruthy();
  });

  it("STRESS: many rows with mixed malformed shapes survive filter + sort (no-recur)", async () => {
    // 一个大而故意难看的 inventory：null name、null/缺 logicalId、
    // null runtime/status、缺 contextUsage——跨多 rigs/nodes。
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) {
        return new Response(JSON.stringify(
          Array.from({ length: 6 }, (_, i) => ({ id: `rig-${i}`, name: i % 2 === 0 ? `rig-${i}` : null })),
        ));
      }
      const m = url.match(/\/api\/rigs\/rig-(\d+)\/nodes/);
      if (m) {
        const idx = Number(m[1]);
        return new Response(JSON.stringify(
          Array.from({ length: 8 }, (_, j) => {
            const bad = (idx + j) % 3 === 0;
            return bad
              ? { logicalId: null, runtime: null, sessionStatus: null, podNamespace: null, canonicalSessionName: null, contextUsage: null }
              : { logicalId: `rig-${idx}.seat-${j}`, runtime: "codex", sessionStatus: "running", podNamespace: "p", canonicalSessionName: `s${j}@rig-${idx}`, startupStatus: "ready", contextUsage: null };
          }),
        ));
      }
      return new Response("[]");
    });

    withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      expect(screen.getAllByTestId(/^topology-table-row-/).length).toBeGreaterThan(10);
    });
    const search = screen.getByTestId("topology-table-search");
    // 用多个 query 猛击过滤器（每个对所有行重跑 globalFilterFn）。
    expect(() => {
      for (const q of ["seat", "rig", "codex", "running", "zzz", ""]) {
        fireEvent.change(search, { target: { value: q } });
      }
    }).not.toThrow();
    // 点每个可排序头排序（对 null 字段重跑 sorted-row-model）。
    expect(() => {
      for (const th of Array.from(document.querySelectorAll("thead th"))) {
        fireEvent.click(th);
        fireEvent.click(th);
      }
    }).not.toThrow();
    expect(screen.getByTestId("topology-table-view")).toBeTruthy();
  });
});
