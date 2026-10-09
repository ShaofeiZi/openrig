// V0.3.1 slice 17 walk-item 8 前向修复 #2——聚焦重新获取回归测试。
//
// 资源管理器侧栏在窗口重新聚焦时自动显示，要求操作员切走再返回时由 useFilesList 与
// useSlices 重新获取，即使上次获取距今很短。配置 staleTime（文件 15 秒、slices 30 秒）并使用
// refetchOnWindowFocus: true（slice 17 初始实现）时，react-query 会按过期状态门控重新获取；
// 在 stale 窗口内重新聚焦不会触发请求，这正是 velocity-qa 在 VM 验证证明中观察到的问题。
//
// 修复：`refetchOnWindowFocus: 'always'` 绕过过期状态。本测试断言无论是否过期，聚焦都会
// 触发重新获取。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useFilesList } from "../src/hooks/useFiles.js";
import { useSlices } from "../src/hooks/useSlices.js";

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

function makeWrapper() {
  // 使用生产 QueryClient 随附的同一 staleTime 默认值，使测试针对生产环境遇到的同一门控谓词。
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  // 以聚焦状态开始，使初始查询挂载正常触发。
  focusManager.setFocused(true);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("useFilesList focus-refetch (walk-item 8 forward-fix #2)", () => {
  it("refetches on focus regardless of staleTime (refetchOnWindowFocus: 'always')", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({
        root: "workspace",
        path: "missions",
        entries: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const { result } = renderHook(
      () => useFilesList("workspace", "missions"),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const initialCallCount = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).startsWith("/api/files/list"),
    ).length;
    expect(initialCallCount).toBe(1);

    // 在 staleTime 窗口内模拟标签页失焦再聚焦。修复前使用
    // refetchOnWindowFocus: true 时这是空操作；修复后使用 'always' 时会发出第二次 fetch。
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(
        (c) => String(c[0]).startsWith("/api/files/list"),
      );
      expect(calls.length).toBe(2);
    });
  });
});

describe("useSlices focus-refetch (walk-item 8 forward-fix #2)", () => {
  it("refetches on focus regardless of staleTime (refetchOnWindowFocus: 'always')", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({
        slices: [],
        totalCount: 0,
        filter: "all",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const { result } = renderHook(
      () => useSlices("all"),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const initialCallCount = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).startsWith("/api/slices"),
    ).length;
    expect(initialCallCount).toBe(1);

    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(
        (c) => String(c[0]).startsWith("/api/slices"),
      );
      expect(calls.length).toBe(2);
    });
  });
});
