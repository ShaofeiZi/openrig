// R1（release-0.4.7）——C3：useMissionProgressStatus absent 与 read_error 拆分。
//
// 直接 useFilesRead 消费者曾把"404 / 不可读"混为一条
// 静默降级路径。现在它携带 `reason`（absent | read_error | null），
// 派生自 FilesReadError.code，而 `unavailable` 保持今日原样。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useMissionProgressStatus } from "../src/hooks/useMissionProgressStatus.js";

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function settle(root: string | null, missionPath: string | null) {
  const { result } = renderHook(() => useMissionProgressStatus(root, missionPath), {
    wrapper: makeWrapper(),
  });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  return result;
}

describe("useMissionProgressStatus — reason split (R1)", () => {
  it("PROGRESS.md 404 → reason 'absent', unavailable=true, status 'unknown'", async () => {
    fetchSpy.mockImplementation(async () => new Response("missing", { status: 404 }));
    const r = await settle("ws", "/x/missions/m");
    expect(r.current.reason).toBe("absent");
    expect(r.current.unavailable).toBe(true);
    expect(r.current.status).toBe("unknown");
  });

  it("PROGRESS.md 500 → reason 'read_error' (infra, not absence), unavailable=true", async () => {
    fetchSpy.mockImplementation(async () => new Response("boom", { status: 500 }));
    const r = await settle("ws", "/x/missions/m");
    expect(r.current.reason).toBe("read_error");
    expect(r.current.unavailable).toBe(true);
  });

  it("read ok → reason null, unavailable=false", async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({
      root: "ws",
      path: "missions/m/PROGRESS.md",
      absolutePath: "/x/missions/m/PROGRESS.md",
      content: "---\nstatus: active\n---\n# Progress\n",
      mtime: "2026-07-10T00:00:00Z",
      contentHash: "h",
      size: 33,
    }), { status: 200 }));
    const r = await settle("ws", "/x/missions/m");
    expect(r.current.reason).toBeNull();
    expect(r.current.unavailable).toBe(false);
  });

  it("null root (caller gated) → unavailable=true but reason null (not a read failure), zero fetches", async () => {
    fetchSpy.mockImplementation(async () => new Response("x", { status: 500 }));
    const r = await settle(null, "/x/missions/m");
    expect(r.current.unavailable).toBe(true);
    expect(r.current.reason).toBeNull();
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("/api/files/"))).toEqual([]);
  });
});
