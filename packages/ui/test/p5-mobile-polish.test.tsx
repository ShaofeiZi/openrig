// V1 attempt-3 Phase 5 P5-9——移动端响应式打磨。
//
// 覆盖：
//   - MobileBottomNav 在 <lg viewport 渲染 3 slot（For You / Project /
//     Topology）。Talk slot 按 universal-shell.md L144 V2 延后；
//     负面断言 "talk" / advisor / operator 不出现在
//     mobile 底部导航。
//   - Topology graph view-mode 按 universal-shell.md L143 在 <lg viewport
//     降级为 table；tab nav 仍显示 graph 为用户选中模式
//    （故 resize-to-wide 重新激活 graph）。
//   - useShellViewport hook 反映 window.innerWidth 变化。
//   - 底部导航在 >= lg viewport 隐藏（lg:hidden class）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useShellViewport } from "../src/hooks/useShellViewport.js";
import { renderHook, act } from "@testing-library/react";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AppShell } from "../src/components/AppShell.js";
import { HostScopePage } from "../src/components/topology/ScopePages.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify([]));
    if (url.includes("/api/rigs/ps")) return new Response(JSON.stringify([]));
    if (url.includes("/api/inventory")) return new Response(JSON.stringify([]));
    if (url.includes("/api/config")) return new Response("not implemented", { status: 404 });
    return new Response("[]");
  });
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  window.localStorage.clear();
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
});

async function renderAt(initialPath: string, viewportWidth: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: viewportWidth,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
  const result = render(
    createAppTestRouter({
      routes: [
        { path: "/topology", component: HostScopePage },
        { path: "$", component: () => null },
      ],
      rootComponent: ({ children }) => <AppShell>{children}</AppShell>,
      initialPath,
    }),
  );
  await waitFor(() => {
    expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
  }, { timeout: 5000 });
  return result;
}

describe("useShellViewport (P5-9 hook)", () => {
  it("reports isWideLayout=true when innerWidth >= 1024", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
    const { result } = renderHook(() => useShellViewport());
    expect(result.current.isWideLayout).toBe(true);
    expect(result.current.innerWidth).toBeGreaterThanOrEqual(1024);
  });

  it("reports isWideLayout=false when innerWidth < 1024", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375, writable: true });
    const { result } = renderHook(() => useShellViewport());
    expect(result.current.isWideLayout).toBe(false);
  });

  it("reacts to window resize events", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
    const { result } = renderHook(() => useShellViewport());
    expect(result.current.isWideLayout).toBe(true);
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 375, writable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.isWideLayout).toBe(false);
  });
});

describe("MobileBottomNav P5-9 — universal-shell.md L135 + L144", () => {
  it("renders 3 slots (For You / Project / Topology) at mobile viewport", async () => {
    const { container } = await renderAt("/", 375);
    const nav = container.querySelector("[data-testid='mobile-bottom-nav']");
    expect(nav).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-for-you']")).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-project']")).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-topology']")).toBeTruthy();
  });

  it("does NOT render Talk / advisor / operator slots (V2 deferred per L144)", async () => {
    const { container } = await renderAt("/", 375);
    expect(container.querySelector("[data-testid='mobile-nav-advisor']")).toBeNull();
    expect(container.querySelector("[data-testid='mobile-nav-operator']")).toBeNull();
    expect(container.querySelector("[data-testid='mobile-nav-talk']")).toBeNull();
    // 源断言：AppShell.tsx mobile-bottom-nav 块在 slot id 中不得
    // 提及 "advisor" 或 "operator" 或 "talk"。
    const src = readFileSync(
      path.resolve(__dirname, "../src/components/AppShell.tsx"),
      "utf8",
    );
    const navBlock = src.match(/MobileBottomNav[\s\S]*?^}/m)?.[0] ?? "";
    expect(navBlock).not.toMatch(/id:\s*"(advisor|operator|talk)"/);
  });

  it("active route highlights the matching mobile nav slot", async () => {
    const { container } = await renderAt("/topology", 375);
    const topology = container.querySelector("[data-testid='mobile-nav-topology']");
    expect(topology?.getAttribute("data-active")).toBe("true");
    const project = container.querySelector("[data-testid='mobile-nav-project']");
    expect(project?.getAttribute("data-active")).toBe("false");
  });

  it("nav element carries lg:hidden so desktop never shows it (CSS-source contract)", async () => {
    const { container } = await renderAt("/", 375);
    const nav = container.querySelector("[data-testid='mobile-bottom-nav']");
    expect(nav?.className).toMatch(/lg:hidden/);
  });
});

describe("Topology graph degradation P5-9 (universal-shell.md L143)", () => {
  it("at <lg viewport, /topology graph view-mode renders the table view + degraded hint", async () => {
    const { container, findByTestId } = await renderAt("/topology", 375);
    // table view-mode 才是实际挂载的（graph 已降级）。
    expect(await findByTestId("topology-mobile-graph-degraded")).toBeTruthy();
    // graph placeholder 在 mobile 不渲染。
    // V1 polish slice Phase 5.2：host graph placeholder 已替换为
    // HostMultiRigGraph；placeholder testid 在任何 viewport 都不再存在，
    // 故此负面断言结构上仍正确（mobile 路径渲染 table view，
    // 而非 multi-rig canvas）。
    expect(container.querySelector("[data-testid='topology-host-graph-placeholder']")).toBeNull();
    expect(container.querySelector("[data-testid='host-multi-rig-graph']")).toBeNull();
  });

  it("at >= lg viewport, /topology graph view-mode renders the graph (no degradation hint)", async () => {
    const { findByTestId, container } = await renderAt("/topology", 1440);
    // 默认 tab 为 graph；placeholder 可见。
    // V1 polish slice Phase 5.2：HostMultiRigGraph 在 host scope graph view-mode
    // 替换先前 placeholder 卡。在 >= lg viewport，要么 canvas 挂载（带 rigs），
    // 要么 empty-state 挂载（mock 返回 []）。二者均可证明 desktop 路径
    // 未降级为 table；<lg 路径本会渲染 table 降级提示。
    const desktopMount = await waitFor(() =>
      container.querySelector("[data-testid='host-multi-rig-graph']") ??
      container.querySelector("[data-testid='host-multi-rig-graph-empty']"),
    );
    expect(desktopMount).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-mobile-graph-degraded']")).toBeNull();
  });
});
