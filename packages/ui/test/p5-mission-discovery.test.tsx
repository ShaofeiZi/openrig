// V1 attempt-3 Phase 5 P5-5 + P5-6——基于文件系统的 mission discovery +
// MissionStatusBadge live PROGRESS.md 抓取。
//
// 两个特性都依托既有 /api/files/list + /api/files/read daemon 路由（无新 daemon
// 端点；遵守 SC-29）。当 allowlist 不暴露 workspace.root 时，树回退到旧
// railItem 分组 slice 列表——也在此测试。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { parseMissionStatus } from "../src/components/MissionStatusBadge.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

// -----------------------------------------------------------------------
// parseMissionStatus——unit 级（Phase 3 已覆盖多数路径；为不变量守卫补几条
// P5-6 路径特定用例）。
// -----------------------------------------------------------------------

describe("parseMissionStatus (P5-6 invariants)", () => {
  it("parses status:active from PROGRESS.md frontmatter", () => {
    expect(
      parseMissionStatus("---\nname: Mission X\nstatus: active\n---\n# body"),
    ).toBe("active");
  });

  it("parses status:shipped variants", () => {
    expect(parseMissionStatus("---\nstatus: shipped\n---")).toBe("shipped");
    expect(parseMissionStatus("---\nstatus: complete\n---")).toBe("shipped");
    expect(parseMissionStatus("---\nstatus: completed\n---")).toBe("shipped");
    expect(parseMissionStatus("---\nstatus: done\n---")).toBe("shipped");
  });

  it("parses status:blocked variants", () => {
    expect(parseMissionStatus("---\nstatus: blocked\n---")).toBe("blocked");
    expect(parseMissionStatus("---\nstatus: stalled\n---")).toBe("blocked");
  });

  it("returns 'unknown' on missing/empty/malformed input", () => {
    expect(parseMissionStatus(null)).toBe("unknown");
    expect(parseMissionStatus(undefined)).toBe("unknown");
    expect(parseMissionStatus("")).toBe("unknown");
    expect(parseMissionStatus("# no frontmatter")).toBe("unknown");
    expect(parseMissionStatus("---\nfoo: bar\n---")).toBe("unknown");
  });
});

// -----------------------------------------------------------------------
// useMissionDiscovery——经 ProjectTreeView（真实消费者）集成。
// -----------------------------------------------------------------------

import { ProjectTreeView } from "../src/components/project/ProjectTreeView.js";

interface RenderTreeOpts {
  // Settings 响应：workspace.root 绝对路径。传 null 渲染
  // 未设置/不可达空状态。
  workspaceRoot: string | null;
  settingsAvailable?: boolean;
  // Files API mocks。
  roots: Array<{ name: string; path: string }>;
  // Map "<root>:<path>" -> 目录条目。
  listings?: Record<string, Array<{ name: string; type: "dir" | "file" }>>;
  // Map "<root>:<path>" -> 文件内容。
  reads?: Record<string, { content: string; mtime?: string }>;
  // useSlices 响应。
  slices?: Array<{ name: string; missionId?: string | null; displayName: string; railItem: string | null; status: string; rawStatus: string | null; qitemCount: number; hasProofPacket: boolean; lastActivityAt: string | null }>;
}

function setupFetch(opts: RenderTreeOpts) {
  mockFetch.mockImplementation(async (url: string) => {
    // MH-2：selection-known files gate 需要 hosts payload（local）。
    if (url.includes("/api/hosts")) {
      return new Response(JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }), { status: 200 });
    }
    // /api/config (settings)
    if (url.includes("/api/config")) {
      if (opts.settingsAvailable === false) {
        return new Response("not implemented", { status: 404 });
      }
      const settings: Record<string, { value: unknown }> = {};
      if (opts.workspaceRoot !== null) {
        settings["workspace.root"] = { value: opts.workspaceRoot };
      }
      return new Response(JSON.stringify({ settings }), { status: 200 });
    }
    // /api/files/roots
    if (url.includes("/api/files/roots")) {
      return new Response(JSON.stringify({ roots: opts.roots }), { status: 200 });
    }
    // /api/files/list?root=<name>&path=<rel>
    if (url.includes("/api/files/list")) {
      const u = new URL(url, "http://localhost");
      const root = u.searchParams.get("root") ?? "";
      const path = u.searchParams.get("path") ?? "";
      const key = `${root}:${path}`;
      const entries = opts.listings?.[key] ?? [];
      return new Response(
        JSON.stringify({ root, path, entries: entries.map((e) => ({ ...e, size: null, mtime: null })) }),
        { status: 200 },
      );
    }
    // /api/files/read?root=<name>&path=<rel>
    if (url.includes("/api/files/read")) {
      const u = new URL(url, "http://localhost");
      const root = u.searchParams.get("root") ?? "";
      const path = u.searchParams.get("path") ?? "";
      const key = `${root}:${path}`;
      const data = opts.reads?.[key];
      if (!data) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          root,
          path,
          absolutePath: `/${root}/${path}`,
          content: data.content,
          mtime: data.mtime ?? "2026-05-06T18:00:00Z",
          contentHash: "deadbeef",
          size: data.content.length,
        }),
        { status: 200 },
      );
    }
    // /api/slices?filter=...
    if (url.includes("/api/slices")) {
      return new Response(
        JSON.stringify({
          slices: opts.slices ?? [],
          totalCount: opts.slices?.length ?? 0,
          filter: "all",
        }),
        { status: 200 },
      );
    }
    return new Response("[]");
  });
}

function renderTree(opts: RenderTreeOpts): ReturnType<typeof render> {
  setupFetch(opts);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ProjectTreeView />,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ProjectTreeView P5-5/P5-6 mission discovery", () => {
  it("filesystem-discovered missions surface as tree nodes when allowlist exposes workspace root", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "workspace", path: "/Users/admin/.openrig/workspace" }],
      listings: {
        "workspace:missions": [
          { name: "release-readiness", type: "dir" },
          { name: "shell-redesign-v1", type: "dir" },
          { name: "README.md", type: "file" }, // file → filtered out
        ],
      },
      reads: {
        "workspace:missions/release-readiness/PROGRESS.md": {
          content: "---\nstatus: active\n---\n# Release readiness",
        },
        "workspace:missions/shell-redesign-v1/PROGRESS.md": {
          content: "---\nstatus: shipped\n---\n# Shell V1",
        },
      },
      slices: [],
    });
    expect(await findByTestId("project-mission-release-readiness")).toBeTruthy();
    expect((await findByTestId("project-mission-link-release-readiness")).getAttribute("href")).toBe("/project/mission/release-readiness");
    expect(await findByTestId("project-mission-shell-redesign-v1")).toBeTruthy();
  });

  it("file-type entries under missions/ are not surfaced as missions", async () => {
    const { findByTestId, queryByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "workspace", path: "/Users/admin/.openrig/workspace" }],
      listings: {
        "workspace:missions": [
          { name: "release-readiness", type: "dir" },
          { name: "README.md", type: "file" },
        ],
      },
      slices: [],
    });
    await findByTestId("project-mission-release-readiness");
    expect(queryByTestId("project-mission-README.md")).toBeNull();
  });

  it("falls back to indexed slice grouping when no allowlist root contains workspace.root", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "elsewhere", path: "/Users/admin/code/elsewhere" }],
      slices: [
        {
          name: "slice-a",
          displayName: "Slice A",
          railItem: "release-readiness",
          status: "active",
          rawStatus: "active",
          qitemCount: 1,
          hasProofPacket: false,
          lastActivityAt: null,
        },
      ],
    });
    expect(await findByTestId("project-discovery-degraded")).toBeTruthy();
    expect(await findByTestId("project-mission-release-readiness")).toBeTruthy();
  });

  it("falls back to indexed slice grouping when allowlist is empty", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [],
      slices: [
        {
          name: "slice-x",
          displayName: "Slice X",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 1,
          hasProofPacket: false,
          lastActivityAt: null,
        },
      ],
    });
    expect(await findByTestId("project-discovery-degraded")).toBeTruthy();
    expect(await findByTestId("project-mission-unsorted")).toBeTruthy();
  });

  it("separates live qitem-backed work from stale archived seed slices", async () => {
    const { findByTestId, queryByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [],
      slices: [
        {
          name: "idea-ledger",
          displayName: "Idea Ledger release proof slice",
          railItem: "RELEASE-PROOF",
          status: "done",
          rawStatus: "done",
          qitemCount: 78,
          hasProofPacket: false,
          lastActivityAt: "2026-05-07T22:06:36.083Z",
        },
        {
          name: "seed-slice-active",
          displayName: "seed-slice-active",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 0,
          hasProofPacket: false,
          lastActivityAt: "2000-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(await findByTestId("project-discovery-degraded")).toBeTruthy();
    expect((await findByTestId("project-mission-section-current")).textContent).toContain(
      "当前工作 · 1",
    );
    expect((await findByTestId("project-mission-section-archive")).textContent).toContain(
      "归档 · 1",
    );

    const liveMission = await findByTestId("project-mission-RELEASE-PROOF");
    expect(liveMission.getAttribute("data-mission-bucket")).toBe("current");
    expect((await findByTestId("project-slice-idea-ledger-qitems")).textContent).toContain("78");

    const archiveMission = await findByTestId("project-mission-unsorted");
    expect(archiveMission.getAttribute("data-mission-bucket")).toBe("archive");
    expect(queryByTestId("project-slice-seed-slice-active")).toBeNull();
  });

  // Slice 19 后续：Project 树中 slice 项保留可读 title/aria 元数据，但用两个
  // 紧凑图标替换 inline prose 元数据：qitem count + status dot。长
  // mission/slice 标识符名称可换行。
  it("slice 19 follow-up: project tree slice items render wrapped names with queue/status icons", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/example/workspace",
      slices: [
        {
          name: "density-slice",
          mission: "release-proof",
          slicePath: "/Users/example/workspace/missions/release-proof/slices/density-slice",
          missionPath: "/Users/example/workspace/missions/release-proof",
          status: "active",
          rawStatus: "active",
          qitemCount: 42,
          hasProofPacket: true,
          lastActivityAt: "2030-01-01T00:00:00.000Z",
        },
      ],
    });

    const sliceLink = await findByTestId("project-slice-density-slice");
    expect(sliceLink.className).toMatch(/\bflex\b/);
    expect(sliceLink.className).not.toMatch(/\bblock\b/);
    expect(sliceLink.getAttribute("title")).toContain("42 个队列项");
    expect(sliceLink.getAttribute("aria-label")).toContain("42 个队列项");
    const meta = await findByTestId("project-slice-density-slice-meta");
    expect(meta.className).toMatch(/\bflex\b/);
    expect(meta.className).not.toMatch(/\bblock\b/);
    expect(meta.textContent).toBe("42");
    expect((await findByTestId("project-slice-density-slice-qitems")).getAttribute("aria-label")).toBe("42 个队列项");
    expect((await findByTestId("project-slice-density-slice-status")).getAttribute("data-tone")).toBe("info");
    expect(sliceLink.textContent).not.toContain("qitems");
    expect(sliceLink.textContent).not.toContain("proof");
    expect(sliceLink.firstElementChild?.className).toContain("whitespace-normal");
  });

  it("workspace.root unconfigured renders the no-workspace empty-state (Phase 3 A5 behavior preserved)", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: null,
      roots: [],
      slices: [],
    });
    expect(await findByTestId("project-no-workspace")).toBeTruthy();
  });

  it("matches slices to filesystem missions by missionId first; unmatched mission keys stay reachable", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "workspace", path: "/Users/admin/.openrig/workspace" }],
      listings: {
        "workspace:missions": [{ name: "release-readiness", type: "dir" }],
      },
      reads: {
        "workspace:missions/release-readiness/PROGRESS.md": { content: "---\nstatus: active\n---" },
      },
      slices: [
        {
          name: "slice-release",
          missionId: "release-readiness",
          displayName: "Release Slice",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 0,
          hasProofPacket: false,
          lastActivityAt: null,
        },
        {
          name: "slice-orphan",
          displayName: "Orphan Slice",
          railItem: "no-such-mission",
          status: "active",
          rawStatus: "active",
          qitemCount: 0,
          hasProofPacket: false,
          lastActivityAt: null,
        },
      ],
    });
    expect(await findByTestId("project-mission-release-readiness")).toBeTruthy();
    expect(await findByTestId("project-mission-no-such-mission")).toBeTruthy();
  });

  it("preserves unmatched legacy rail groups when filesystem missions are available", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [{ name: "workspace", path: "/Users/admin/.openrig/workspace" }],
      listings: {
        "workspace:missions": [{ name: "demo-seed", type: "dir" }],
      },
      reads: {
        "workspace:missions/demo-seed/PROGRESS.md": { content: "---\nstatus: active\n---" },
      },
      slices: [
        {
          name: "idea-ledger-find-ideas-cycle-4",
          missionId: "demo-seed",
          displayName: "Find Ideas Cycle 4",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 1,
          hasProofPacket: false,
          lastActivityAt: "2026-05-08T00:00:00.000Z",
        },
        {
          name: "idea-ledger",
          displayName: "Idea Ledger release proof slice",
          railItem: "RELEASE-PROOF",
          status: "done",
          rawStatus: "done",
          qitemCount: 78,
          hasProofPacket: false,
          lastActivityAt: "2026-05-07T22:06:36.083Z",
        },
        {
          name: "seed-slice-active",
          displayName: "seed-slice-active",
          railItem: null,
          status: "active",
          rawStatus: "active",
          qitemCount: 0,
          hasProofPacket: false,
          lastActivityAt: "2000-01-01T00:00:00.000Z",
        },
      ],
    });

    expect((await findByTestId("project-mission-section-current")).textContent).toContain(
      "当前工作 · 2",
    );
    expect((await findByTestId("project-mission-section-archive")).textContent).toContain(
      "归档 · 1",
    );
    expect(await findByTestId("project-slice-idea-ledger-find-ideas-cycle-4")).toBeTruthy();
    expect((await findByTestId("project-mission-demo-seed")).getAttribute("data-mission-bucket")).toBe("current");
    expect((await findByTestId("project-mission-RELEASE-PROOF")).getAttribute("data-mission-bucket")).toBe("current");
    expect((await findByTestId("project-mission-unsorted")).getAttribute("data-mission-bucket")).toBe("archive");
  });

  // qitem-render-driver #3 characterization——sidebar badge 逐字渲染 API 的
  // per-slice qitemCount。观测到 host 355 是 DAEMON producer 缺陷
  //（matchQitems 的 zero-typed fallback 联合 missionId，且 railItem 默认
  // missionId），非 UI fallback：存在非零 mission 聚合时，zero-count slice
  // 仍必须可见显示 0。
  it("#3 pin: a slice whose API qitemCount is 0 visibly stays 0 even alongside nonzero-count siblings in the same mission", async () => {
    const { findByTestId } = renderTree({
      workspaceRoot: "/Users/admin/.openrig/workspace",
      roots: [],
      slices: [
        {
          name: "zero-slice",
          missionId: "release-x",
          displayName: "Zero Slice",
          railItem: "release-x",
          status: "active",
          rawStatus: "placeholder",
          qitemCount: 0,
          hasProofPacket: false,
          lastActivityAt: null,
        },
        {
          name: "busy-sibling",
          missionId: "release-x",
          displayName: "Busy Sibling",
          railItem: "release-x",
          status: "active",
          rawStatus: "active",
          qitemCount: 7,
          hasProofPacket: false,
          lastActivityAt: null,
        },
      ],
    });
    const badge = await findByTestId("project-slice-zero-slice-qitems");
    const shown = (badge.textContent ?? "").trim();
    // 精确可见 0——绝不空，绝非 sibling/mission 聚合。
    expect(shown, "zero-count badge must render a visible 0").toBe("0");
    expect(badge.getAttribute("aria-label"), "accessible label must state 0 个队列项").toBe("0 个队列项");
    expect(badge.getAttribute("title")).toBe("0 个队列项");
    const sibling = await findByTestId("project-slice-busy-sibling-qitems");
    expect((sibling.textContent ?? "").trim(), "sibling keeps its own count").toBe("7");
  });

});
