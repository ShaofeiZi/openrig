// VM-005（release-0.4.7）——TIER A：observable 处的差分套件
//（ARCH-RULING-b3-differential-test-architecture-2026-07-11，sha 632ff319…）。
//
// 仅 import 两端表面（组件 + DOM harness + router/query）。断言是 CANDIDATE
// 契约值逐字（PRD observable）；在 base 8757593f 它们以命名 expected/received
// 失败（chip 渲染 "active"/"unknown" 而预期 "complete"/"idle"/"draft"）。一条代码
// 路径——任何地方不 branch-on-symbol（裁决 P1）。V5 向量在两个 SHA 都从这些
// 同一文件通过。
//
// 向量：V1 authored-wins（tree + portfolio）· V2 idle-not-unknown ·
// V3 all-draft->draft · V4 时钟跳变无衰减（authored 稳定；derived 移
// active->idle，绝不到退役词）· V5 byte-identity（derived 语料在两端
// 渲染一致）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { ProjectTreeView } from "../src/components/project/ProjectTreeView.js";
import { WorkspacePortfolioPanel } from "../src/components/project/WorkspacePortfolioPanel.js";
import { WorkspaceScopePage } from "../src/components/project/ScopePages.js";
import { buildStorytellingFeedItems } from "../src/components/feed/cards/storytelling-cards.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => mockFetch.mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type SliceRowFixture = {
  name: string;
  missionId: string | null;
  displayName: string;
  railItem: string | null;
  status: string;
  rawStatus: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
};

function sliceRow(over: Partial<SliceRowFixture>): SliceRowFixture {
  return {
    name: "s1",
    missionId: "m1",
    displayName: "S1",
    railItem: null,
    status: "active",
    rawStatus: null,
    qitemCount: 0,
    hasProofPacket: false,
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

function setupFetch(opts: {
  slices: SliceRowFixture[];
  missions?: Record<string, { authoredStatus: string | null }>;
}) {
  // harness 健壮性：fetch 可能以 Request/URL 对象调用（或传递 undefined 的
  // 间接调用方）——路由前强转为字符串。仅机制；断言强度不变。
  mockFetch.mockImplementation(async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input ?? "");
    if (url.includes("/api/hosts")) {
      return new Response(
        JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/config")) {
      return new Response(
        JSON.stringify({
          settings: {
            "workspace.name": { value: "testws" },
            "workspace.root": { value: "/ws" },
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/api/files/roots")) {
      return new Response(JSON.stringify({ roots: [] }), { status: 200 });
    }
    if (url.includes("/api/slices")) {
      return new Response(
        JSON.stringify({
          slices: opts.slices,
          totalCount: opts.slices.length,
          filter: "all",
          missions: opts.missions ?? {},
        }),
        { status: 200 },
      );
    }
    return new Response("[]");
  });
}

function mount(node: React.ReactNode): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{node}</>,
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

const WINDOW_MS = 36 * 60 * 60 * 1000; // PROJECT_CURRENT_ACTIVITY_WINDOW_MS (literal: no lib import needed)

describe("V1 — authored-when-present wins at the observable (FR-1)", () => {
  it("tree chip renders the authored word 'complete' over a recently-active slice", async () => {
    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    const badge = await findByTestId("project-mission-relx-badge");
    expect(badge.textContent).toContain("complete");
    // Q1 Option A：零 PROGRESS.md status 读取——live override 已退役。
    const fileReads = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/files/read"));
    expect(fileReads).toEqual([]);
  });

  it("portfolio badge renders the authored word", async () => {
    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const { findByText } = mount(<WorkspacePortfolioPanel />);
    expect(await findByText("complete")).toBeTruthy();
  });

  it("the workspace OVERVIEW tab renders the authored word; FR-4 buckets it under ARCHIVE in the tree", async () => {
    // 落地（fallback-run 发现）：WorkspaceOverviewPanel 是孤儿——
    // ScopePages:744 在 overview tab 渲染 WorkspacePortfolioPanel
    //（"Supersedes the prior WorkspaceOverviewPanel mission grid"）。真正
    // overview observable 是 WorkspaceScopePage 内的 portfolio 行；FR-4
    // bucket observable 是 tree 的 Current/Archive 段。
    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const page = mount(<WorkspaceScopePage />);
    await page.findByTestId("portfolio-open-relx"); // the overview-tab surface exists
    expect(await page.findByText("complete")).toBeTruthy(); // authored word renders
    page.unmount();

    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const tree = mount(<ProjectTreeView />);
    await tree.findByTestId("project-mission-relx"); // the mission node exists
    // section testid 是 header <li>；missions 作兄弟渲染——bucket observable
    // 是 header COUNT（base："Archive · 0"）。
    const archive = await tree.findByTestId("project-mission-section-archive");
    expect(archive.textContent).toContain("归档 · 1");
    tree.unmount();
  });

  it("storytelling complete-and-hide agrees: the authored-complete mission is filtered from the band", () => {
    // C8 读 RAW authored 词（两端表面，byte 不变）；这锁定矩阵的 V1 fixture
    // storytelling 单元。
    const items = buildStorytellingFeedItems(
      [{ name: "relx", path: "/ws/missions/relx", status: "complete" }],
      [],
    );
    expect(items.some((i) => JSON.stringify(i).includes("relx"))).toBe(false);
  });

  // Mission DETAIL 单元（plan §C-v 可达性）：detail 页面完全不渲染
  // mission-status chip（grep 验证：MissionScopePage 仅渲染 per-slice chip）
  // ——detail 表面的 status observable 是携带 RAW authored 词的
  // GET /api/missions/:id payload（C7，byte 不变；由 daemon lockstep 测试 +
  // proof bar 的 missions-routes 套件锁定）。矩阵按 §C-v 把 detail DOM 单元
  // 标 N/A，而非假装 chip 存在。
});

describe("V2 — honest known states at the observable (FR-2)", () => {
  it("an aged-out mission with no authored status renders 'idle', never the retired word", async () => {
    const stale = new Date(Date.now() - WINDOW_MS - 4 * 60 * 60 * 1000).toISOString();
    setupFetch({
      slices: [sliceRow({ missionId: "sleepy", name: "old-slice", lastActivityAt: stale })],
      missions: {},
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    const badge = await findByTestId("project-mission-sleepy-badge");
    expect(badge.textContent).toContain("空闲");
    expect(badge.textContent).not.toContain("unknown");
  });
});

describe("V3 — an all-draft mission reads 'draft', not active (Q2 / FR-3)", () => {
  it("fresh scaffolded drafts with recent activity render the draft chip", async () => {
    setupFetch({
      slices: [
        sliceRow({ missionId: "fresh", name: "d1", status: "draft" }),
        sliceRow({ missionId: "fresh", name: "d2", status: "draft" }),
      ],
      missions: {},
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    const badge = await findByTestId("project-mission-fresh-badge");
    expect(badge.textContent).toContain("草稿");
  });
});

describe("V4 — no clock decay at the observable (FR-2)", () => {
  it("an AUTHORED chip is byte-stable across a clock jump; a DERIVED chip moves active→idle (never the retired word)", async () => {
    // t0：authored mission + derived mission，都带 recent slice。
    // 跳变前不做值断言——边界先跨越，使 base RED 是裁决的 V4 时钟差分而非
    // V1 重复（guard 复查 R4）。t0 文本被捕获以供稳定性比较。
    const recent = new Date(Date.now() - 60_000).toISOString();
    setupFetch({
      slices: [
        sliceRow({ missionId: "auth", name: "a1", lastActivityAt: recent }),
        sliceRow({ missionId: "derv", name: "d1", lastActivityAt: recent }),
      ],
      missions: { auth: { authoredStatus: "complete" } },
    });
    const first = mount(<ProjectTreeView />);
    const t0Auth = (await first.findByTestId("project-mission-auth-badge")).textContent;
    const t0Derv = (await first.findByTestId("project-mission-derv-badge")).textContent;
    expect(t0Derv).toContain("进行中"); // t0 两端一致（基线同样派生为 active）。
    first.unmount();

    // 跨越边界：把 wall clock 跳远过 recency 窗口；全新挂载，数据相同。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.now() + WINDOW_MS * 10);
    setupFetch({
      slices: [
        sliceRow({ missionId: "auth", name: "a1", lastActivityAt: recent }),
        sliceRow({ missionId: "derv", name: "d1", lastActivityAt: recent }),
      ],
      missions: { auth: { authoredStatus: "complete" } },
    });
    const second = mount(<ProjectTreeView />);
    const t1Auth = (await second.findByTestId("project-mission-auth-badge")).textContent;
    const t1Derv = (await second.findByTestId("project-mission-derv-badge")).textContent;
    // V4 差分，跳变后：derived 诚实衰减到 idle——在 base 这是命名 RED
    //（badge 读退役词）。
    expect(t1Derv).toContain("空闲");
    expect(t1Derv).not.toContain("unknown");
    // authored：纯时间流逝中 BYTE 稳定（t1 == t0），candidate anchor 锁定
    // 实际词。
    expect(t1Auth).toBe(t0Auth);
    expect(t1Auth).toContain("complete");
    second.unmount();
  });
});

describe("V5 — byte-identity carve at the observable (both-ends green)", () => {
  it("authored == derived AGREE-cases render the same word at both SHAs", async () => {
    // (a) authored 'shipped' + all-done stale 语料：base derive shipped，
    // candidate 渲染 authored 词——两路同一 observable。
    // (b) authored 'active' + recent-active 语料：同样一致。
    const stale = new Date(Date.now() - WINDOW_MS - 4 * 60 * 60 * 1000).toISOString();
    setupFetch({
      slices: [
        sliceRow({ missionId: "agree-ship", name: "as1", status: "done", lastActivityAt: stale }),
        sliceRow({ missionId: "agree-act", name: "aa1" }),
      ],
      missions: {
        "agree-ship": { authoredStatus: "shipped" },
        "agree-act": { authoredStatus: "active" },
      },
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    expect((await findByTestId("project-mission-agree-ship-badge")).textContent).toContain("shipped");
    expect((await findByTestId("project-mission-agree-act-badge")).textContent).toContain("active");
  });

  it("derived corpora render today's words identically (active · blocked · shipped)", async () => {
    setupFetch({
      slices: [
        sliceRow({ missionId: "run", name: "r1" }), // recent active → active
        sliceRow({ missionId: "stuck", name: "b1", status: "blocked" }),
        sliceRow({ missionId: "landed", name: "l1", status: "done", lastActivityAt: null, qitemCount: 0 }),
      ],
      missions: {},
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    expect((await findByTestId("project-mission-run-badge")).textContent).toContain("进行中");
    expect((await findByTestId("project-mission-stuck-badge")).textContent).toContain("已阻塞");
    expect((await findByTestId("project-mission-landed-badge")).textContent).toContain("已发布");
  });
});
