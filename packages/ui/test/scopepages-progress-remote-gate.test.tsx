// R1 (release-0.4.7) —— C4c req-5（含 v1.2 闸门修复）：任务 PROGRESS 面板的
// 远程闸门。已知为远程的选择会如实显示“未显示本地文件”提示，而不是伪装成本地缺失；
// 未知选择（本地冷启动窗口）绝不可闪现该提示——它应回落到加载/缺失处理。
// 闸门条件 = `hostSelectionKnown && !hostIsLocal`。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { MissionScopePage } from "../src/components/project/ScopePages.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// hosts："local" | "remote-host" | "unknown"（unknown ⇒ /api/hosts 报错 ⇒
// useHosts 数据为 undefined ⇒ hostSelectionKnown=false）。
function install(hostMode: "local" | "remote-host" | "unknown") {
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/hosts")) {
      if (hostMode === "unknown") return json({ error: "down" }, 500);
      return json({ ownName: "localhost", selected: hostMode, hosts: [] });
    }
    if (url.includes("/api/slices")) return json({ slices: [], totalCount: 0, filter: "all" });
    const m = url.match(/\/api\/missions\/([^/?]+)/);
    if (m) return json({ missionId: decodeURIComponent(m[1]!), missionPath: "/ws/missions/m", slices: [], workflow_spec: null, topology: null });
    if (url.includes("/api/files/roots")) return json({ roots: [{ name: "work", path: "/ws" }] });
    if (url.includes("/api/files/read")) return json({ error: "not found" }, 404); // 真实的本地缺失
    return json({}, 404); // scope-audit 及其余 ⇒ 数据为 undefined（跳过侧栏分支）
  });
}

function renderMissionProgress() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const missionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project/mission/$missionId", component: () => <MissionScopePage /> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([missionRoute]),
    history: createMemoryHistory({ initialEntries: ["/project/mission/m"] }),
  });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function openProgressTab() {
  renderMissionProgress();
  const tab = await screen.findByTestId("project-tab-progress");
  fireEvent.click(tab);
  await waitFor(() => expect(screen.getByTestId("mission-progress-panel")).toBeTruthy());
}

beforeEach(() => mockFetch.mockReset());
afterEach(() => cleanup());

describe("R1 C4c —— 任务 PROGRESS 远程闸门（req-5，v1.2 仅已知远程）", () => {
  it("已知远程 → 不显示本地文件，而非“尚无进展”，且零次 /api/files/read", async () => {
    install("remote-host");
    await openProgressTab();
    const el = await screen.findByTestId("mission-progress-remote-gated");
    expect(el.textContent).toContain("不显示本地文件");
    expect(screen.queryByTestId("mission-progress-empty")).toBeNull();
    // 远程在数据层闸门本地读（null 路径）⇒ 不发起读
    const reads = mockFetch.mock.calls.filter(([u]) => String(u).includes("/api/files/read"));
    expect(reads).toEqual([]);
  });

  it("未知选择（冷启动）→ 不闪现闸门提示（v1.2 修复）", async () => {
    install("unknown");
    await openProgressTab();
    // 误导性的闸门闪现绝不能在未知窗口出现
    await waitFor(() =>
      expect(screen.queryByTestId("mission-progress-empty") ?? screen.queryByTestId("mission-progress-panel")).toBeTruthy(),
    );
    expect(screen.queryByTestId("mission-progress-remote-gated")).toBeNull();
  });

  it("本地 + 真实缺失的 PROGRESS.md → 尚无进展，绝不是闸门提示", async () => {
    install("local");
    await openProgressTab();
    const el = await screen.findByTestId("mission-progress-empty");
    expect(el.textContent).toContain("尚无进展");
    expect(screen.queryByTestId("mission-progress-remote-gated")).toBeNull();
  });
});
