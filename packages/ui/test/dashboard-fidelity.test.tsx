// OPR.0.4.1.14——Dashboard 路由视觉刷新。
//
// 守卫纯视觉刷新不得回归的两件事：六个
// destination affordances + 其路由（行为不变），以及
// Field Environment 真实数据接线。与锁定 twin 的视觉 fidelity
// 由 qa real-live 截图门禁单独证明。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";

vi.mock("../src/hooks/useRigSummary.js", () => ({
  useRigSummary: () => ({ data: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] }),
}));
vi.mock("../src/hooks/usePsEntries.js", () => ({
  usePsEntries: () => ({
    data: [{ nodeCount: 23, runningCount: 12, activeCount: 9 }],
    isError: false,
  }),
}));
vi.mock("../src/hooks/useSettings.js", () => ({
  useSettings: () => ({
    data: { settings: { "agents.operator_session": { value: "orch-lead@openrig-delivery" } } },
  }),
  // OPR.0.4.6.MH1 FR-5：HostConfigCard（挂载于 Dashboard）从本模块导入
  // settings write hook——模块 mock 必须携带它，否则 import 解析为 undefined。
  useSetSetting: () => ({ mutateAsync: async () => ({}) }),
}));
vi.mock("../src/hooks/useDaemonVersion.js", () => ({
  useDaemonVersion: () => ({ data: { version: "0.4.0" } }),
}));
// OPR.0.4.6.MH1 FR-5：HostConfigCard 的 data hooks——被 mock，使 Dashboard
// 无需 QueryClientProvider 渲染（本测试关注的是
// field-environment 接线；卡片有自己的测试）。
vi.mock("../src/hooks/useHosts.js", () => ({
  useHosts: () => ({ data: { ownName: "localhost", selected: "local", hosts: [] }, error: null }),
  usePairHost: () => ({ mutateAsync: async () => ({}), data: undefined, error: null, isPending: false, reset: () => {} }),
  usePairPoll: () => ({ data: undefined }),
}));

import { Dashboard } from "../src/components/dashboard/Dashboard.js";

function renderDashboard() {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Dashboard });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const routeTree = rootRoute.addChildren([
    indexRoute,
    stub("/topology"),
    stub("/project"),
    stub("/for-you"),
    stub("/specs"),
    stub("/search"),
    stub("/settings"),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // 强制转型：测试 stub 树与 app 生成的路由树不同。
  return render(<RouterProvider router={router as never} />);
}

afterEach(cleanup);

describe("Dashboard route visual refresh (OPR.0.4.1.14)", () => {
  it("renders the launcher surface with greeting + field environment", async () => {
    renderDashboard();
    expect(await screen.findByTestId("dashboard-surface")).toBeTruthy();
    expect(screen.getByTestId("dashboard-greeting").textContent?.toLowerCase()).toContain(
      "欢迎回来",
    );
    expect(screen.getByTestId("dashboard-field-environment")).toBeTruthy();
    expect(screen.getByTestId("dashboard-footer")).toBeTruthy();
  });

  it("keeps all six destinations + their routes (no behaviour change)", async () => {
    renderDashboard();
    await screen.findByTestId("dashboard-surface");
    const expected: Array<[string, string, string]> = [
      ["dashboard-card-01", "/topology", "拓扑"],
      ["dashboard-card-02", "/project", "项目"],
      ["dashboard-card-03", "/for-you", "为你"],
      ["dashboard-card-04", "/specs", "库"],
      ["dashboard-card-05", "/search", "搜索与审计"],
      ["dashboard-card-06", "/settings", "设置"],
    ];
    for (const [testId, href, label] of expected) {
      const card = screen.getByTestId(testId);
      expect(card.getAttribute("href")).toBe(href);
      expect(card.textContent).toContain(label);
    }
  });

  it("wires real runtime data into the Field Environment (functional refinement)", async () => {
    renderDashboard();
    const fe = await screen.findByTestId("dashboard-field-environment");
    const text = fe.textContent ?? "";
    // RIGS + AGENTS 拆到各自行，作单一 live 计数
    //（mock hooks 给 3 rigs、23 agents）；active 子计数弃。
    expect(text).toContain("工作组");
    expect(text).toContain("03");
    expect(text).toContain("智能体");
    expect(text).toContain("23");
    expect(text).not.toContain("03 / 23"); // old combined RIGS / AGENTS row is gone
    // OPERATOR ID 仍接到配置的 operator_session（真实源）。
    expect(text).toContain("ORCH-LEAD");
    // VERSION 显示来自 useDaemonVersion 的真实运行中 daemon 版本。
    expect(text).toContain("版本");
    expect(text).toContain("0.4.0");
    // 占位 SESSION 行 + 装饰 DECLINATION 行已弃。
    expect(text).not.toContain("SESSION");
    expect(text).not.toContain("OPENRIG-DELIVERY");
    expect(text).not.toContain("DECLINATION");
  });
});
