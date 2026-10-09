// OPR.0.4.6.WF4（C3）——工作流 SSE feed 的绑定契约：Q5-P1 要求订阅不限定工作组范围，
// 永远不带 `?rigId=`；由于 workflow.* 事件持久化时 rig_id=NULL，限定范围的订阅会静默
// 丢失工作流主干。任一 workflow.* 事件都会使 ["workflow"] 查询族失效。

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useWorkflowSse, WORKFLOW_SSE_URL, __test_internals } from "../src/hooks/useWorkflowSse.js";

let constructedUrls: string[] = [];
let messageHandlers: Array<(event: { data: string }) => void> = [];

vi.stubGlobal(
  "EventSource",
  class MockEventSource {
    constructor(url: string) {
      constructedUrls.push(url);
    }
    addEventListener = vi.fn((event: string, handler: (e: { data: string }) => void) => {
      if (event === "message") messageHandlers.push(handler);
    });
    close = vi.fn();
  },
);

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

afterEach(() => {
  constructedUrls = [];
  messageHandlers = [];
  __test_internals.reset();
  cleanup();
});

describe("useWorkflowSse — Q5-P1 rig-unscoped primary feed", () => {
  it("subscribes to /api/workflow/sse with NO rigId scoping (unscoped by contract)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useWorkflowSse(), { wrapper: wrapperWith(qc) });

    expect(constructedUrls).toContain("/api/workflow/sse");
    // 具名负向保证：携带工作流类别的订阅绝不按工作组限定范围。
    for (const url of constructedUrls) {
      expect(url).not.toContain("rigId");
      expect(url).not.toContain("?");
    }
    // URL 的唯一来源是导出的常量，不限定范围，也不带查询串。
    expect(WORKFLOW_SSE_URL).toBe("/api/workflow/sse");
    expect(WORKFLOW_SSE_URL).not.toContain("rigId");
  });

  it("invalidates the ['workflow'] query family on a workflow.* event", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useWorkflowSse(), { wrapper: wrapperWith(qc) });

    act(() => {
      for (const handler of messageHandlers) {
        handler({ data: JSON.stringify({ type: "workflow.step_closed", instanceId: "01WFX" }) });
      }
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["workflow"] });
  });

  it("ignores non-JSON heartbeats (no invalidation)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useWorkflowSse(), { wrapper: wrapperWith(qc) });

    act(() => {
      for (const handler of messageHandlers) {
        handler({ data: ": keep-alive heartbeat" });
      }
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
