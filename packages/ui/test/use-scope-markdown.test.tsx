// V0.3.1 slice 12 walk-item 1——useScopeMarkdown 泛化测试。
//
// useScopeMarkdown(scopePath, filename) 将 slice-06 时期的 useSliceTimelineMarkdown 泛化，
// 可读取任意项目工作范围（任务目标、slice、工作区）下的任意 Markdown 文件。
// useSliceTimelineMarkdown.ts 中的向后兼容垫片另行测试；本文件使用任务目标标签页消费的
// README.md 与 PROGRESS.md 文件名直接验证泛化钩子。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  useScopeMarkdown,
  resolveScopePathToAllowlist,
} from "../src/hooks/useScopeMarkdown.js";

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

describe("resolveScopePathToAllowlist (pure)", () => {
  it("matches the deepest root that prefixes the absolute scope path", () => {
    const roots = [
      { name: "home", path: "/Users/x" },
      { name: "substrate", path: "/Users/x/.openrig" },
      { name: "workspace", path: "/Users/x/.openrig/shared-docs/internal-docs" },
    ];
    const r = resolveScopePathToAllowlist(
      roots,
      "/Users/x/.openrig/shared-docs/internal-docs/missions/release-0.3.1",
    );
    expect(r).not.toBeNull();
    expect(r!.rootName).toBe("workspace");
    expect(r!.relPath).toBe("missions/release-0.3.1");
  });

  it("returns null when no allowlist root contains the absolute path", () => {
    const roots = [{ name: "ws", path: "/Users/x/.openrig/shared-docs/internal-docs" }];
    expect(resolveScopePathToAllowlist(roots, "/somewhere/else")).toBeNull();
  });
});

describe("useScopeMarkdown — production wire honors arbitrary filename", () => {
  it("fetches <scopePath>/README.md when filename='README.md' (mission Overview tab path)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) {
        return new Response(JSON.stringify({
          roots: [
            { name: "workspace", path: "/Users/example/.openrig/shared-docs/internal-docs" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("/api/files/read")) {
        return new Response(JSON.stringify({
          root: "workspace",
          path: "missions/getting-started/README.md",
          absolutePath: "/Users/example/.openrig/shared-docs/internal-docs/missions/getting-started/README.md",
          content: "---\nstatus: active\n---\n# Getting Started\n",
          mtime: "2026-05-11T00:00:00Z",
          contentHash: "rdme",
          size: 50,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });

    const { result } = renderHook(
      () => useScopeMarkdown(
        "/Users/example/.openrig/shared-docs/internal-docs/missions/getting-started",
        "README.md",
      ),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.content).toContain("# Getting Started");
    const readCall = fetchSpy.mock.calls.find((c) => String(c[0]).startsWith("/api/files/read"));
    expect(readCall).toBeDefined();
    const url = new URL(`http://localhost${readCall![0]}`);
    expect(url.searchParams.get("root")).toBe("workspace");
    expect(url.searchParams.get("path")).toBe("missions/getting-started/README.md");
  });

  it("fetches <scopePath>/PROGRESS.md when filename='PROGRESS.md' (mission Progress tab path)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) {
        return new Response(JSON.stringify({
          roots: [{ name: "ws", path: "/Users/example/.openrig/shared-docs/internal-docs" }],
        }), { status: 200 });
      }
      if (url.startsWith("/api/files/read")) {
        const reqUrl = new URL(`http://localhost${url}`);
        expect(reqUrl.searchParams.get("path")).toBe("missions/getting-started/PROGRESS.md");
        return new Response(JSON.stringify({
          root: "ws",
          path: "missions/getting-started/PROGRESS.md",
          absolutePath: "/Users/example/.openrig/shared-docs/internal-docs/missions/getting-started/PROGRESS.md",
          content: "# Progress\n\n## Done\n- thing 1\n",
          mtime: "2026-05-11T00:00:00Z",
          contentHash: "prog",
          size: 25,
        }), { status: 200 });
      }
      return new Response("?", { status: 404 });
    });

    const { result } = renderHook(
      () => useScopeMarkdown(
        "/Users/example/.openrig/shared-docs/internal-docs/missions/getting-started",
        "PROGRESS.md",
      ),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.content).toContain("## Done");
  });

  it("returns unavailable=true when scopePath is null (no scope selected) — and issues ZERO file requests", async () => {
    // OPR.0.4.6.MH2 守卫 B1——工作范围路径为 null 时甚至不能获取 /api/files/roots；
    // 选择远程目标的表面会传入 null，而 /api/files/* 仅限本地，不参与透传读取。
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ roots: [] }), { status: 200 }));
    const { result } = renderHook(
      () => useScopeMarkdown(null, "README.md"),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.content).toBeNull();
    expect(result.current.resolved).toBeNull();
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("/api/files/"))).toEqual([]);
  });

  it("returns unavailable=true when file is missing on disk (404 from /api/files/read)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) {
        return new Response(JSON.stringify({
          roots: [{ name: "ws", path: "/Users/example/.openrig/shared-docs/internal-docs" }],
        }), { status: 200 });
      }
      if (url.startsWith("/api/files/read")) return new Response("missing", { status: 404 });
      return new Response("?", { status: 500 });
    });
    const { result } = renderHook(
      () => useScopeMarkdown(
        "/Users/example/.openrig/shared-docs/internal-docs/missions/empty",
        "PROGRESS.md",
      ),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.content).toBeNull();
  });
});
