// V0.3.1 slice 13.5 mission-progress-artifacts-heatmap。
//
// MissionProgressHeatmap 是 per-slice acceptance-cell 热力图，渲染在既有
// Progress tab 内容之上。测试覆盖：
//
//   T1——组件渲染网格形状，每行 N slices × M acceptance 单元（HG-1）
//   T2——单元颜色经 stateTone 映射 slice 状态（done 单元带 slice status tone；
//        not-done 单元仅 outline）（HG-2）
//   T3——legend 渲染规范 state -> 颜色映射（HG-2）
//   T4——MissionScopePage Progress tab 组合 markdown + 热力图 + per-slice rollup；
//        Artifacts tab 不变（无热力图 mount）
//        (HG-3 + HG-4)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { MissionProgressHeatmap } from "../src/components/project/MissionProgressHeatmap.js";
import { MissionScopePage } from "../src/components/project/ScopePages.js";
import type { SliceDetail, SliceListEntry } from "../src/hooks/useSlices.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function makeRow(name: string, status: SliceListEntry["status"]): SliceListEntry {
  return {
    name,
    displayName: name,
    railItem: "RELEASE-PROOF",
    status,
    rawStatus: status,
    qitemCount: 0,
    hasProofPacket: false,
    lastActivityAt: "2026-05-11T00:00:00.000Z",
  };
}

function makeDetail(
  name: string,
  items: { text: string; done: boolean }[],
): SliceDetail {
  const doneItems = items.filter((it) => it.done).length;
  const totalItems = items.length;
  const percentage = totalItems === 0 ? 0 : Math.round((doneItems / totalItems) * 100);
  return {
    name,
    missionId: "RELEASE-PROOF",
    slicePath: `/workspace/${name}`,
    displayName: name,
    railItem: "RELEASE-PROOF",
    status: "active",
    rawStatus: "active",
    qitemIds: [],
    commitRefs: [],
    lastActivityAt: "2026-05-11T00:00:00.000Z",
    workflowBinding: null,
    story: { events: [], phaseDefinitions: null },
    acceptance: {
      totalItems,
      doneItems,
      percentage,
      items: items.map((it) => ({
        text: it.text,
        done: it.done,
        source: { file: "PROGRESS.md", line: 1 },
      })),
      closureCallout: null,
      currentStep: null,
    },
    decisions: { rows: [] },
    docs: { tree: [] },
    tests: {
      proofPackets: [],
      aggregate: { passCount: 0, failCount: 0 },
    },
    topology: { affectedRigs: [], totalSeats: 0, specGraph: null },
  };
}

function withRouter(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const sliceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/slice/$sliceId",
    component: () => null,
  });
  const fallback = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, sliceRoute, fallback]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("MissionProgressHeatmap (slice 13.5)", () => {
  it("HG-1: renders N rows × M acceptance cells in a grid shape", async () => {
    const rows = [makeRow("alpha", "active"), makeRow("beta", "done")];
    const detailsByName = new Map<string, SliceDetail>([
      [
        "alpha",
        makeDetail("alpha", [
          { text: "a1", done: true },
          { text: "a2", done: true },
          { text: "a3", done: false },
        ]),
      ],
      [
        "beta",
        makeDetail("beta", [
          { text: "b1", done: true },
          { text: "b2", done: true },
        ]),
      ],
    ]);
    const { findByTestId, queryAllByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    expect(await findByTestId("mission-progress-heatmap")).toBeTruthy();
    expect(await findByTestId("mission-progress-heatmap-row-alpha")).toBeTruthy();
    expect(await findByTestId("mission-progress-heatmap-row-beta")).toBeTruthy();

    // 每行 cells 容器持有 per-acceptance-item span。
    const alphaCells = queryAllByTestId(/^mission-progress-heatmap-cell-alpha-\d+$/);
    expect(alphaCells.length).toBe(3);
    const betaCells = queryAllByTestId(/^mission-progress-heatmap-cell-beta-\d+$/);
    expect(betaCells.length).toBe(2);
  });

  it("HG-2: done cells take the slice's status tone; not-done cells render outline-only", async () => {
    const rows = [makeRow("alpha", "active")];
    const detailsByName = new Map<string, SliceDetail>([
      [
        "alpha",
        makeDetail("alpha", [
          { text: "a1", done: true },
          { text: "a2", done: false },
        ]),
      ],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    const row = await findByTestId("mission-progress-heatmap-row-alpha");
    expect(row.getAttribute("data-status")).toBe("active");
    // 共享 sliceStatusTone() 把规范 SliceStatus 值 "active" -> "info"，
    // 故 active slice 上 done 单元与 shipped done slice 上 done 单元视觉有别。
    // 这与 legend 一致。
    expect(row.getAttribute("data-tone")).toBe("info");
    expect(row.textContent).toContain("进行中");
    expect(row.textContent).not.toContain("active");

    const doneCell = await findByTestId("mission-progress-heatmap-cell-alpha-0");
    const notDoneCell = await findByTestId("mission-progress-heatmap-cell-alpha-1");
    expect(doneCell.getAttribute("data-done")).toBe("true");
    expect(notDoneCell.getAttribute("data-done")).toBe("false");
    // Active slice done 单元用 info tone（sky）渲染；not-done 单元仅 outline。
    expect(doneCell.className).toMatch(/bg-sky-200/);
    expect(notDoneCell.className).toMatch(/border-outline-variant/);
    expect(notDoneCell.className).not.toMatch(/bg-sky-200/);
  });

  it("HG-2 (blocked tone): blocked-status slice rows mark done cells with the danger tone", async () => {
    const rows = [makeRow("blockedSlice", "blocked")];
    const detailsByName = new Map<string, SliceDetail>([
      [
        "blockedSlice",
        makeDetail("blockedSlice", [
          { text: "x1", done: true },
          { text: "x2", done: false },
        ]),
      ],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    const row = await findByTestId("mission-progress-heatmap-row-blockedSlice");
    expect(row.getAttribute("data-tone")).toBe("danger");
    const doneCell = await findByTestId("mission-progress-heatmap-cell-blockedSlice-0");
    expect(doneCell.className).toMatch(/bg-rose-300/);
  });

  it("HG-2 (case-insensitive slice status): capitalized Active still renders info-toned cells", async () => {
    const rows = [makeRow("capitalActive", "Active")];
    const detailsByName = new Map<string, SliceDetail>([
      ["capitalActive", makeDetail("capitalActive", [{ text: "a1", done: true }])],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    const row = await findByTestId("mission-progress-heatmap-row-capitalActive");
    expect(row.getAttribute("data-tone")).toBe("info");
    const doneCell = await findByTestId("mission-progress-heatmap-cell-capitalActive-0");
    expect(doneCell.className).toMatch(/bg-sky-200/);
  });

  it("HG-2 (legend): legend renders all five state -> color samples", async () => {
    const rows = [makeRow("alpha", "active")];
    const detailsByName = new Map<string, SliceDetail>([
      ["alpha", makeDetail("alpha", [{ text: "a1", done: true }])],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    const legend = await findByTestId("mission-progress-heatmap-legend");
    expect(legend.textContent).toContain("已完成（进行中）");
    expect(legend.textContent).toContain("已完成（完成）");
    expect(legend.textContent).toContain("已完成（警告）");
    expect(legend.textContent).toContain("已完成（已阻塞）");
    expect(legend.textContent).toContain("未完成");
  });

  // Forward-fix-1 覆盖缺口闭合：legend swatch className 必须匹配为该状态 slice
  // 渲染的真实热力图单元 className。legend 说 "done (active)" 标注 info-toned
  // swatch；active-status slice 的 done 单元必须用同一 className。此前 legend
  // 硬编码 cellToneClass.info，但 active-status 行的 done 单元落到
  // neutral->success（emerald），使 legend 与现实脱节。
  it("HG-2 (legend ↔ cell parity): legend swatch className equals the actual cell className for each canonical SliceStatus", async () => {
    const rows = [
      makeRow("activeSlice", "active"),
      makeRow("doneSlice", "done"),
      makeRow("blockedSlice", "blocked"),
    ];
    const detailsByName = new Map<string, SliceDetail>([
      ["activeSlice", makeDetail("activeSlice", [{ text: "a1", done: true }])],
      ["doneSlice", makeDetail("doneSlice", [{ text: "b1", done: true }])],
      ["blockedSlice", makeDetail("blockedSlice", [{ text: "c1", done: true }])],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );

    // active -> legend-active swatch 应携带与真实 active-row done 单元
    // 相同的颜色类（bg + border）。
    const activeCell = await findByTestId("mission-progress-heatmap-cell-activeSlice-0");
    const activeLegend = await findByTestId("mission-progress-heatmap-legend-active");
    expect(activeLegend.className).toMatch(/bg-sky-200/);
    expect(activeCell.className).toMatch(/bg-sky-200/);

    const doneCell = await findByTestId("mission-progress-heatmap-cell-doneSlice-0");
    const completeLegend = await findByTestId("mission-progress-heatmap-legend-complete");
    expect(completeLegend.className).toMatch(/bg-emerald-400/);
    expect(doneCell.className).toMatch(/bg-emerald-400/);

    const blockedCell = await findByTestId("mission-progress-heatmap-cell-blockedSlice-0");
    const blockedLegend = await findByTestId("mission-progress-heatmap-legend-blocked");
    expect(blockedLegend.className).toMatch(/bg-rose-300/);
    expect(blockedCell.className).toMatch(/bg-rose-300/);

    // warning tone 无规范 SliceStatus 映射，但 legend 仍发布 swatch 形状。
    // 为 warning 断言 legend swatch，为运维人员提供前向兼容参考，覆盖未来任何
    // 解析到 warning tone 的 status 字符串。
    const warningLegend = await findByTestId("mission-progress-heatmap-legend-warning");
    expect(warningLegend.className).toMatch(/bg-amber-300/);
  });

  it("renders an empty-state when the mission has no scoped slices", async () => {
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={[]} detailsByName={new Map()} />,
    );
    expect(await findByTestId("mission-progress-heatmap-empty")).toBeTruthy();
  });

  it("renders the tally column with done/total + percentage when acceptance items exist", async () => {
    const rows = [makeRow("alpha", "active")];
    const detailsByName = new Map<string, SliceDetail>([
      [
        "alpha",
        makeDetail("alpha", [
          { text: "a1", done: true },
          { text: "a2", done: true },
          { text: "a3", done: false },
        ]),
      ],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    const row = await findByTestId("mission-progress-heatmap-row-alpha");
    expect(row.textContent).toContain("2/3");
    expect(row.textContent).toContain("67%");
  });
});

describe("MissionScopePage Progress tab composes heat-map (slice 13.5)", () => {
  function installMissionFetchMock() {
    mockFetch.mockImplementation(async (url: string) => {
      // MH-2：selection-known files gate 需要 hosts payload（local）。
      if (url.includes("/api/hosts")) {
        return new Response(JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }), { status: 200 });
      }
      if (url.includes("/api/config")) {
        return new Response(
          JSON.stringify({
            settings: { "workspace.root": { value: "/Users/admin/.openrig/workspace" } },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/missions/RELEASE-PROOF") && !url.includes("/api/missions/RELEASE-PROOF/")) {
        return new Response(
          JSON.stringify({
            missionId: "RELEASE-PROOF",
            missionPath: "/workspace/missions/release-proof",
            slices: [
              {
                name: "alpha",
                displayName: "alpha",
                railItem: "RELEASE-PROOF",
                status: "active",
                rawStatus: "active",
                qitemCount: 0,
                hasProofPacket: false,
                lastActivityAt: "2026-05-11T00:00:00.000Z",
              },
            ],
            topology: { specGraph: null },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/slices/alpha")) {
        return new Response(JSON.stringify(makeDetail("alpha", [{ text: "a1", done: true }])), {
          status: 200,
        });
      }
      if (url.includes("/api/slices")) {
        return new Response(
          JSON.stringify({
            slices: [
              {
                name: "alpha",
                displayName: "alpha",
                railItem: "RELEASE-PROOF",
                status: "active",
                rawStatus: "active",
                qitemCount: 0,
                hasProofPacket: false,
                lastActivityAt: "2026-05-11T00:00:00.000Z",
              },
            ],
            totalCount: 1,
            filter: "all",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/scope-markdown") || url.includes("PROGRESS.md") || url.includes("README.md")) {
        return new Response(JSON.stringify({ content: "# Mission progress goes here\n" }), {
          status: 200,
        });
      }
      // mission Progress 面板读 useScopeAudit（GET /api/scope/audit）；
      // mock 真实 ScopeAuditResponse 形状，使 MissionScopePage 不在
      // scopeAudit.data.mission 上崩溃（未 mock 的 [] fallback 是 HG-3 /
      // HG-3-DOM ErrorBoundary 失败的既有原因）。
      if (url.includes("/api/scope/audit")) {
        return new Response(
          JSON.stringify({
            ok: true,
            mission: { name: "RELEASE-PROOF", railStatus: "present", frontmatterError: null, findings: [] },
            slices: [],
            totalFindings: 0,
          }),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    });
  }

  function renderMissionScope(): ReturnType<typeof render> {
    installMissionFetchMock();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const missionRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/project/mission/$missionId",
      component: () => <MissionScopePage />,
    });
    const sliceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/project/slice/$sliceId",
      component: () => null,
    });
    const fallback = createRoute({
      getParentRoute: () => rootRoute,
      path: "$",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([missionRoute, sliceRoute, fallback]),
      history: createMemoryHistory({ initialEntries: ["/project/mission/RELEASE-PROOF"] }),
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it("HG-3 (slice 22): Mission Progress tab renders the heat-map and CUTS the per-slice rollup cards", async () => {
    const { findByTestId, queryByTestId } = renderMissionScope();
    // OPR.0.4.1.17：mission 现在落在 Steering tab（非 Overview）；
    // 断言 landing mount，然后导航到下方目标 tab。
    expect(await findByTestId("steering-tab")).toBeTruthy();

    // 切到 Progress tab。
    fireEvent.click(await findByTestId("project-tab-progress"));

    // 热力图（+ legend）保留。
    expect(await findByTestId("mission-progress-heatmap")).toBeTruthy();
    // OPR.0.4.1.22：per-slice rollup CARD 被砍——热力图现在就是
    // per-slice acceptance 视图（founder round-8：去 card，保留 heatmap）。
    expect(queryByTestId("scope-progress-rollup")).toBeNull();
  });

  // 热力图必须在 PROGRESS.md markdown 段之前渲染，使视觉 gestalt 是
  // Progress tab 上第一眼所见。经 Node.compareDocumentPosition 断言 DOM
  // 顺序，防止静默重排。
  it("HG-3 (DOM order): heat-map renders BEFORE the PROGRESS.md markdown section", async () => {
    const { findByTestId, queryByTestId } = renderMissionScope();
    expect(await findByTestId("steering-tab")).toBeTruthy();
    fireEvent.click(await findByTestId("project-tab-progress"));

    const heatmap = await findByTestId("mission-progress-heatmap");
    const panel = await findByTestId("mission-progress-panel");

    // markdown 段仅在 missionProgress.content 非空时渲染；integration mock
    // 返回 "# Mission progress goes here"，故应 mount。若未 mount，本断言跳过
    //（无顺序可比）。
    const readme = panel.querySelector(
      "[data-testid='mission-progress-readme']",
    );
    if (readme) {
      // DOCUMENT_POSITION_FOLLOWING (4) 表示 readme 在 DOM 顺序上位于 heatmap
      // 之后——即 heatmap 先渲染。
      expect(heatmap.compareDocumentPosition(readme)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }

    // OPR.0.4.1.22：per-slice rollup card 被砍——热力图即 per-slice gestalt，
    // 仍为 Progress tab 第一眼所见。
    expect(queryByTestId("scope-progress-rollup")).toBeNull();
  });

  it("HG-4: Mission Artifacts tab does NOT mount the heat-map", async () => {
    const { findByTestId, queryByTestId } = renderMissionScope();
    expect(await findByTestId("steering-tab")).toBeTruthy();

    fireEvent.click(await findByTestId("project-tab-artifacts"));
    expect(queryByTestId("mission-progress-heatmap")).toBeNull();
  });
});
