// OPR.0.3.2.20——QA BLOCKING-A（qitem-20260518195533）回归
// 测试。For You 注意表面在 queue 事件经 SSE 到达时必须重取；
// 若无失效，useAttentionItems 保留其 react-query 缓存，
// 打开的 lens 显示陈旧数据，直到硬刷新或 window-focus 重取。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useActivityFeed } from "../src/hooks/useActivityFeed.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";

let OriginalEventSource: typeof EventSource | undefined;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

beforeEach(() => {
  OriginalEventSource = globalThis.EventSource;
  // @ts-expect-error——为测试替换全局
  globalThis.EventSource = createMockEventSourceClass();
});

afterEach(() => {
  cleanup();
  if (OriginalEventSource) {
    globalThis.EventSource = OriginalEventSource;
  }
});

function wrapper(client: QueryClient) {
  // eslint-disable-next-line react/display-name
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useActivityFeed — attention-items invalidation on queue events (QA BLOCKING-A fix)", () => {
  it("invalidates ['attention-items'] on queue.created SSE event", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    // 等 EventSource 订阅创建。
    await act(() => Promise.resolve());
    const source = instances[0];
    expect(source).toBeDefined();

    // 模拟 daemon 发出 queue.created 事件。
    act(() => {
      source!.simulateMessage(JSON.stringify({
        seq: 1,
        type: "queue.created",
        qitemId: "qitem-test-live-1",
        destinationSession: "human-bob@kernel",
        createdAt: new Date().toISOString(),
      }));
    });

    // useAttentionItems 的缓存键是 ["attention-items", <limit>]。
    // react-query 中键 ["attention-items"] 的 invalidateQueries 是前缀匹配——
    // 验证我们用该精确前缀调用。
    expect(spy).toHaveBeenCalledWith({ queryKey: ["attention-items"] });
  });

  it("invalidates ['attention-items'] on queue.handed_off, queue.updated, queue.claimed, queue.unclaimed", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    for (const type of ["queue.handed_off", "queue.updated", "queue.claimed", "queue.unclaimed"]) {
      act(() => {
        source.simulateMessage(JSON.stringify({
          seq: 100,
          type,
          qitemId: "qitem-test-X",
          createdAt: new Date().toISOString(),
        }));
      });
    }

    // 4 种事件类型各自都失效 attention-items。
    const attentionCalls = spy.mock.calls.filter(
      ([arg]) => arg && (arg as { queryKey?: unknown[] }).queryKey?.[0] === "attention-items",
    );
    expect(attentionCalls.length).toBeGreaterThanOrEqual(4);
  });

  it("invalidates ['attention-items'] on qitem.* events (fallback_routed, closure_overdue)", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    for (const type of ["qitem.fallback_routed", "qitem.closure_overdue"]) {
      act(() => {
        source.simulateMessage(JSON.stringify({
          seq: 200,
          type,
          qitemId: "qitem-test-Y",
          createdAt: new Date().toISOString(),
        }));
      });
    }

    const attentionCalls = spy.mock.calls.filter(
      ([arg]) => arg && (arg as { queryKey?: unknown[] }).queryKey?.[0] === "attention-items",
    );
    expect(attentionCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("invalidates ['attention-items'] on inbox.absorbed / inbox.denied", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    for (const type of ["inbox.absorbed", "inbox.denied"]) {
      act(() => {
        source.simulateMessage(JSON.stringify({
          seq: 300,
          type,
          createdAt: new Date().toISOString(),
        }));
      });
    }

    const attentionCalls = spy.mock.calls.filter(
      ([arg]) => arg && (arg as { queryKey?: unknown[] }).queryKey?.[0] === "attention-items",
    );
    expect(attentionCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("invalidates ['queue','item',qitemId] when payload includes qitemId so already-fetched detail refreshes", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    act(() => {
      source.simulateMessage(JSON.stringify({
        seq: 400,
        type: "queue.updated",
        qitemId: "qitem-abc-123",
        createdAt: new Date().toISOString(),
      }));
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["queue", "item", "qitem-abc-123"] });
  });

  it("accepts qitem_id snake-case payload key for queue detail invalidation", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    act(() => {
      source.simulateMessage(JSON.stringify({
        seq: 401,
        type: "queue.created",
        qitem_id: "qitem-snake-1",
        createdAt: new Date().toISOString(),
      }));
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["queue", "item", "qitem-snake-1"] });
  });

  it("does NOT invalidate ['attention-items'] for non-queue events (no over-invalidation)", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    for (const type of ["rig.imported", "snapshot.created", "session.discovered", "chat.message"]) {
      act(() => {
        source.simulateMessage(JSON.stringify({
          seq: 500,
          type,
          createdAt: new Date().toISOString(),
        }));
      });
    }

    const attentionCalls = spy.mock.calls.filter(
      ([arg]) => arg && (arg as { queryKey?: unknown[] }).queryKey?.[0] === "attention-items",
    );
    expect(attentionCalls.length).toBe(0);
  });
});
