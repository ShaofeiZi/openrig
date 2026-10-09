// V1 attempt-3 Phase 5 P5-1——site-of-use trigger 可达性证明（ritual #6）。
//
// drawer-primitives.test.tsx（Phase 4 process-gap 修复）覆盖 4 viewer + 4 trigger
// 原语的 unit 级可达性。P5-1 把这些 trigger 接入 4 个生产表面（FeedCard /
// LibraryReview 文件列表 / RigSpecDisplay agentRef 单元 / TopologyTreeView seat
// 叶子）。本文件按 ritual #6 覆盖 ROUTE-COMPONENT 可达性——点击命名 affordance
// 以正确 DrawerSelection discriminator 触发 setSelection。
//
// Project queue tab（ACK 列表中第 5 个 P5-1 表面）在 P5-2 与 slice-tab 内容管道
// 一并接入，使 qitem 行随其余 slice 数据到达；在该处测试。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SubSpecPreview 在 entryId 存在时内部使用 TanStack Link；这些测试中我们不直接
// 渲染 SubSpecPreview（仅其 trigger）。FeedCard 渲染 AuthorAgentTag ->
// useCmuxLaunch（useMutation）和一个 Link，故它同时需要 QueryClientProvider 和
// TanStack Router 上下文。

import { DrawerSelectionContext } from "../src/components/AppShell.js";

beforeEach(() => {
  cleanup();
});

function renderWithDrawerCtx(
  ui: React.ReactNode,
): { setSelection: ReturnType<typeof vi.fn> } & ReturnType<typeof render> {
  const setSelection = vi.fn();
  const utils = render(
    <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
      {ui}
    </DrawerSelectionContext.Provider>,
  );
  return { setSelection, ...utils };
}

// 包裹触碰 TanStack Router（Link）+ React Query 的组件。
// FeedCard 经 AuthorAgentTag -> useCmuxLaunch 路径两者都做。
function renderWithRouterAndQuery(
  ui: React.ReactNode,
): { setSelection: ReturnType<typeof vi.fn> } & ReturnType<typeof render> {
  const setSelection = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
        {ui}
      </DrawerSelectionContext.Provider>
    ),
  });
  const seatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/topology/seat/$rigId/$logicalId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, seatRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { setSelection, ...utils };
}

// -----------------------------------------------------------------------
// FeedCard：source.payload 含 qitem_id 时渲染 "show context" QueueItemTrigger；
// 点击 -> setSelection({ type: 'qitem', data: {...} })。
// -----------------------------------------------------------------------

import { FeedCard } from "../src/components/for-you/FeedCard.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";

function makeCard(overrides: Partial<FeedCardModel> = {}): FeedCardModel {
  return {
    id: "evt-1",
    kind: "action-required",
    title: "Need approval",
    body: "v0.3.0 RC ready, authorize tag/push?",
    authorSession: "orch-lead@openrig-velocity",
    rigId: "rig-1",
    receivedAt: 1_000_000,
    createdAt: "2026-05-06T18:00:00Z",
    source: {
      seq: 1,
      type: "queue.item.created",
      payload: {
        qitem_id: "qitem-20260506-test",
        source_session: "orch-lead@openrig-velocity",
        destination: "human-operator@kernel",
        state: "human-gate",
        body: "Authorize v0.3.0 RC tag/push?",
      },
      createdAt: "2026-05-06T18:00:00Z",
      receivedAt: 1_000_000,
    } as FeedCardModel["source"],
    ...overrides,
  };
}

describe("FeedCard P5-1 wiring: show-context QueueItemTrigger", () => {
  it("renders show-context trigger when source.payload has qitem_id", async () => {
    const card = makeCard();
    const { findByTestId } = renderWithRouterAndQuery(<FeedCard card={card} />);
    const cardRoot = await findByTestId("feed-card-action");
    expect(cardRoot.querySelector("svg")).toBeTruthy();
    expect(await findByTestId(`feed-card-show-context-${card.id}`)).toBeTruthy();
  });

  it("hides show-context trigger when source.payload has no qitem_id", async () => {
    const card = makeCard({
      source: {
        seq: 2,
        type: "git.commit",
        payload: { sha: "abc123" },
        createdAt: "2026-05-06T18:00:00Z",
        receivedAt: 1_000_000,
      } as FeedCardModel["source"],
    });
    const { findByTestId, queryByTestId } = renderWithRouterAndQuery(<FeedCard card={card} />);
    // 等 card body 本身渲染（router 解析异步），然后断言 show-context
    // trigger 缺席。
    await findByTestId("feed-card-action");
    expect(queryByTestId(`feed-card-show-context-${card.id}`)).toBeNull();
  });

  it("show-context click → setSelection({ type: 'qitem', data: { qitemId, ... } })", async () => {
    const card = makeCard();
    const { setSelection, findByTestId } = renderWithRouterAndQuery(<FeedCard card={card} />);
    const trigger = await findByTestId(`feed-card-show-context-${card.id}`);
    fireEvent.click(trigger);
    expect(setSelection).toHaveBeenCalledOnce();
    const arg = setSelection.mock.calls[0][0];
    expect(arg.type).toBe("qitem");
    expect(arg.data.qitemId).toBe("qitem-20260506-test");
    expect(arg.data.source).toBe("orch-lead@openrig-velocity");
    expect(arg.data.destination).toBe("human-operator@kernel");
    expect(arg.data.state).toBe("human-gate");
    expect(arg.data.body).toBe("Authorize v0.3.0 RC tag/push?");
  });

  it("show-context handles queue.created camelCase daemon payloads", async () => {
    const card = makeCard({
      id: "queue-created-1",
      kind: "progress",
      title: "Queue item created",
      body: "orch-lead@openrig-velocity -> driver@openrig-velocity",
      authorSession: "orch-lead@openrig-velocity",
      source: {
        seq: 3,
        type: "queue.created",
        payload: {
          qitemId: "qitem-20260507-daemon",
          sourceSession: "orch-lead@openrig-velocity",
          destinationSession: "driver@openrig-velocity",
          priority: "routine",
          tier: "mode2",
        },
        createdAt: "2026-05-07T21:18:52Z",
        receivedAt: 1_000_000,
      } as FeedCardModel["source"],
    });
    const { setSelection, findByTestId } = renderWithRouterAndQuery(
      <FeedCard card={card} />,
    );
    const trigger = await findByTestId(`feed-card-show-context-${card.id}`);
    fireEvent.click(trigger);
    expect(setSelection).toHaveBeenCalledOnce();
    const arg = setSelection.mock.calls[0][0];
    expect(arg.type).toBe("qitem");
    expect(arg.data.qitemId).toBe("qitem-20260507-daemon");
    expect(arg.data.source).toBe("orch-lead@openrig-velocity");
    expect(arg.data.destination).toBe("driver@openrig-velocity");
    expect(arg.data.body).toBe(
      "orch-lead@openrig-velocity -> driver@openrig-velocity",
    );
  });

  it("prefers hydrated queue body and renders proof screenshots for shipped cards", async () => {
    const card = makeCard({
      id: "queue-shipped-1",
      kind: "shipped",
      title: "Queue item shipped: qitem-demo",
      body: "metadata-only fallback",
      source: {
        seq: 4,
        type: "queue.updated",
        payload: { qitemId: "qitem-demo", toState: "done" },
        createdAt: "2026-05-07T21:18:52Z",
        receivedAt: 1_000_000,
      } as FeedCardModel["source"],
    });
    const { findByTestId, findByText } = renderWithRouterAndQuery(
      <FeedCard
        card={card}
        queueItem={{
          qitemId: "qitem-demo",
          tsCreated: "2026-05-07T21:18:52Z",
          tsUpdated: "2026-05-07T21:20:00Z",
          sourceSession: "driver@rig",
          destinationSession: "human@host",
          state: "done",
          priority: "urgent",
          tier: "fast",
          tags: ["idea-ledger-triage-ideas-cycle-4"],
          body: "Review the completed proof packet and screenshots for the triage slice.",
        }}
        proofPreview={{
          sliceName: "idea-ledger-triage-ideas-cycle-4",
          displayName: "Idea Ledger triage ideas cycle 4",
          passFailBadge: "pass",
          screenshots: ["screenshots/for-you-live-human-pending-final.png"],
        }}
      />,
    );
    expect(await findByText("Review the completed proof packet and screenshots for the triage slice.")).toBeTruthy();
    expect(await findByTestId(`feed-card-proof-preview-${card.id}`)).toBeTruthy();
    const img = await findByTestId("feed-card-proof-screenshot-screenshots/for-you-live-human-pending-final.png") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/api/slices/idea-ledger-triage-ideas-cycle-4/proof-asset/");
  });

  it("renders bare APPROVE + CHAT for actionable human queue cards (corrective \u00a77.1)", async () => {
    const card = makeCard();
    const { findAllByText, findByTestId, queryByText, queryByTestId } = renderWithRouterAndQuery(
      <FeedCard
        card={card}
        queueItem={{
          qitemId: "qitem-20260506-test",
          tsCreated: "2026-05-06T18:00:00Z",
          tsUpdated: "2026-05-06T18:00:00Z",
          sourceSession: "orch-lead@openrig-velocity",
          destinationSession: "human@host",
          state: "human-gate",
          priority: "urgent",
          tier: "fast",
          tags: ["human-review"],
          body: "Review this proof packet and choose a queue action.",
        }}
      />,
    );

    // CORRECTIVE §7.1（创建者 N-1，2026-07-05；守卫回修 2026-07-06）：
    // 可操作卡片只呈现简洁的“批准”与“对话”。“轮到你了”和“选择响应”装饰已移除；
    // 拒绝/路由不再出现在此表面；类型标签是状态文案“需要处理”。
    expect(await findByTestId(`feed-card-actions-${card.id}`)).toBeTruthy();
    expect((await findAllByText("需要处理")).length).toBeGreaterThanOrEqual(1);
    expect(queryByText("轮到你了")).toBeNull();
    expect(queryByText("选择响应")).toBeNull();
    expect(await findByTestId("mc-verb-approve")).toBeTruthy();
    expect(await findByTestId(`feed-card-chat-${card.id}`)).toBeTruthy();
    expect(queryByTestId("mc-verb-deny")).toBeNull();
    expect(queryByTestId("mc-verb-route")).toBeNull();
    expect(queryByTestId("mc-verb-handoff")).toBeNull();
  });

  it("renders approval outcome instead of action controls after an action lands", async () => {
    const card = makeCard();
    const { findByTestId, findByText, queryByTestId } = renderWithRouterAndQuery(
      <FeedCard
        card={card}
        queueItem={{
          qitemId: "qitem-20260506-test",
          tsCreated: "2026-05-06T18:00:00Z",
          tsUpdated: "2026-05-06T18:05:00Z",
          sourceSession: "orch-lead@openrig-velocity",
          destinationSession: "human-operator@kernel",
          state: "pending",
          priority: "urgent",
          tier: "fast",
          tags: ["approval"],
          body: "Review this proof packet and choose a queue action.",
        }}
        actionOutcome={{
          verb: "approve",
          actorSession: "human-operator@kernel",
          actedAt: "2026-05-06T18:06:00Z",
          state: "done",
        }}
      />,
    );

    expect(await findByTestId("feed-card-action-outcome")).toBeTruthy();
    expect(await findByText("已记录决策")).toBeTruthy();
    expect(await findByText("已由 human-operator@kernel 批准。")).toBeTruthy();
    expect(queryByTestId(`feed-card-actions-${card.id}`)).toBeNull();
    expect(queryByTestId("mc-verb-approve")).toBeNull();
  });

  it("renders route outcome with the destination and hides stale action controls", async () => {
    const card = makeCard();
    const { findByText, queryByTestId } = renderWithRouterAndQuery(
      <FeedCard
        card={card}
        actionOutcome={{
          verb: "route",
          actorSession: "human@host",
          actedAt: "2026-05-06T18:06:00Z",
          state: "handed-off",
          destinationSession: "driver@openrig-velocity",
        }}
      />,
    );

    expect(await findByText("已由 human@host 转交至 driver@openrig-velocity。")).toBeTruthy();
    expect(queryByTestId(`feed-card-actions-${card.id}`)).toBeNull();
  });

  it("hides actions for terminal handed-off queue state even before audit hydration", async () => {
    const card = makeCard();
    const { findByTestId, findByText, queryByTestId } = renderWithRouterAndQuery(
      <FeedCard
        card={card}
        queueItem={{
          qitemId: "qitem-20260506-test",
          tsCreated: "2026-05-06T18:00:00Z",
          tsUpdated: "2026-05-06T18:05:00Z",
          sourceSession: "orch-lead@openrig-velocity",
          destinationSession: "human@host",
          state: "handed-off",
          priority: "urgent",
          tier: "fast",
          tags: ["approval"],
          body: "Review this proof packet and choose a queue action.",
          closureReason: "handed_off_to",
          closureTarget: "driver@openrig-velocity",
          handedOffTo: "driver@openrig-velocity",
        }}
      />,
    );

    expect(await findByTestId("feed-card-action-outcome")).toBeTruthy();
    expect(await findByText("已由 human@host 转交至 driver@openrig-velocity。")).toBeTruthy();
    expect(queryByTestId(`feed-card-actions-${card.id}`)).toBeNull();
  });

  it("does not render action controls for completed shipped cards", async () => {
    const card = makeCard({
      id: "queue-shipped-2",
      kind: "shipped",
      title: "Queue item shipped: qitem-demo",
      source: {
        seq: 5,
        type: "queue.updated",
        payload: { qitemId: "qitem-demo", toState: "done" },
        createdAt: "2026-05-07T21:18:52Z",
        receivedAt: 1_000_000,
      } as FeedCardModel["source"],
    });
    const { findByTestId, queryByTestId } = renderWithRouterAndQuery(
      <FeedCard
        card={card}
        queueItem={{
          qitemId: "qitem-demo",
          tsCreated: "2026-05-07T21:18:52Z",
          tsUpdated: "2026-05-07T21:20:00Z",
          sourceSession: "driver@rig",
          destinationSession: "human@host",
          state: "done",
          priority: "urgent",
          tier: "fast",
          tags: ["proof"],
          body: "Completed proof packet.",
        }}
      />,
    );

    expect(await findByTestId("feed-card-shipped")).toBeTruthy();
    expect(queryByTestId(`feed-card-actions-${card.id}`)).toBeNull();
  });
});

// V1 polish slice Phase 5.1 P5.1-D2：TopologyTreeView SeatLeaf details 图标已
// 退役。SeatDetailTrigger 原语已退役。SeatLeaf 现为到
// /topology/seat/$rigId/$logicalId 的 Link-only 导航。退役回归守卫在
// test/node-selection-migration.test.tsx（SeatDetailTrigger.tsx 文件不存在 +
// SharedDetailDrawer 无 'seat-detail' kind）。

// -----------------------------------------------------------------------
// RigSpecDisplay pod-member agentRef 单元 -> SubSpecTrigger -> drawer。
// -----------------------------------------------------------------------

import { SubSpecTrigger } from "../src/components/drawer-triggers/SubSpecTrigger.js";

describe("RigSpecDisplay P5-1 wiring: agentRef SubSpecTrigger contract", () => {
  it("clicking SubSpecTrigger with agent spec data fires setSelection({ type: 'sub-spec', data: {...} })", () => {
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <SubSpecTrigger
        data={{ specKind: "agent", specName: "impl", source: "user_file" }}
        testId="rs-member-test"
      >
        local:agents/impl
      </SubSpecTrigger>,
    );
    fireEvent.click(getByTestId("rs-member-test"));
    expect(setSelection).toHaveBeenCalledWith({
      type: "sub-spec",
      data: { specKind: "agent", specName: "impl", source: "user_file" },
    });
  });

  it("RigSpecDisplay source wraps m.agentRef in SubSpecTrigger (ritual #1+#9)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "../src/components/RigSpecDisplay.tsx"),
      "utf8",
    );
    expect(src).toMatch(/import\s*\{\s*SubSpecTrigger\s*\}/);
    expect(src).toMatch(/<SubSpecTrigger/);
    // parseAgentRef helper 存在（从 local:agents/foo / fork:agents/foo 等
    // 提取 specName + source）。
    expect(src).toMatch(/parseAgentRef/);
  });
});

// -----------------------------------------------------------------------
// LibraryReview Files 列表（context-pack + agent-image）-> FileReferenceTrigger。
// -----------------------------------------------------------------------

import { FileReferenceTrigger } from "../src/components/drawer-triggers/FileReferenceTrigger.js";

describe("LibraryReview P5-1 wiring: file-list FileReferenceTrigger contract", () => {
  it("clicking FileReferenceTrigger fires setSelection({ type: 'file', data: { path } })", () => {
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <FileReferenceTrigger
        data={{ path: "context-pack/role.md" }}
        testId="lib-pack-file-trigger-test"
      >
        role.md
      </FileReferenceTrigger>,
    );
    fireEvent.click(getByTestId("lib-pack-file-trigger-test"));
    expect(setSelection).toHaveBeenCalledWith({
      type: "file",
      data: { path: "context-pack/role.md" },
    });
  });

  it("LibraryReview source wraps both context-pack and agent-image file rows in FileReferenceTrigger (ritual #1+#9)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "../src/components/LibraryReview.tsx"),
      "utf8",
    );
    expect(src).toMatch(/import\s*\{\s*FileReferenceTrigger\s*\}/);
    // 两个 file-list 站点（context-pack lib-pack-file-trigger-* 和
    // agent-image lib-image-file-trigger-*）都必须存在。
    expect(src).toMatch(/lib-pack-file-trigger-/);
    expect(src).toMatch(/lib-image-file-trigger-/);
  });
});
