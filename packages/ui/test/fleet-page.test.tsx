// OPR.0.4.6.MH5 C5——/fleet 路由页双态冒烟（3 个可再生 twin 的深链状态：
// glance、?open=<fleetKey> 展开、band 目标路由存在）+ 契约锁定使锁定帧
// 可视化：页面逐字渲染 DAEMON 的 rollup（绝不客户端重算）、不可达 = 缺席
// 而非零 + 真实 refetch 重试、drawer 上逐字 Q4 fleetKey、FR-5 只读边界
// 行、以及响亮 registryError 状态。
//
// harness = 编写时应用的 WF-4 leg-8 教训：QueryClientProvider
//（无它 hooks 抛错）、memory-history router（页面渲染 TanStack Link）、
// 以及异步 waitFor 路由解析。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FleetPage } from "../src/components/review/FleetPage.js";
import type { ComposedFleet } from "../src/hooks/useFleet.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

const FLEET: ComposedFleet = {
  // 故意非下面行在单 vector 视角下客户端可重算的求和：rollup 是
  // daemon 的数学，页面必须渲染它（见 render-the-daemon-rollup 测试，
  // 其用 SKEWED 数字）。
  rollup: {
    needsYouCount: 1,
    exceptionCount: 2,
    exceptionsByKind: [
      { kind: "overdue", count: 1 },
      { kind: "stuck", count: 1 },
    ],
    hostCount: 3,
    unreachableCount: 1,
  },
  needsYou: {
    items: [
      {
        source: "agent",
        identity: "qi-l1",
        fleetKey: "local|qi-l1",
        hostId: "local",
        seenFrom: ["rig"],
        summary: "sign-off needed: release brief",
        leg: "human-gate",
        where: "rig",
        ageIso: null,
        priority: "urgent",
        tier: "human-gate",
        evidenceRef: null,
        unblocks: null,
        qitemId: "qi-l1",
        destinationSession: "human@host",
        derived: null,
      },
      {
        source: "derived",
        identity: "qi-a2|stuck|t0",
        fleetKey: "vps-a|qi-a2|stuck|t0",
        hostId: "vps-a",
        seenFrom: ["rig"],
        summary: "packer2 idle 47m with work",
        leg: "stuck",
        where: "rig",
        ageIso: null,
        priority: null,
        tier: null,
        evidenceRef: null,
        unblocks: null,
        qitemId: null,
        destinationSession: null,
        derived: { kind: "stuck", evidence: "idle 47m >= 30m default · holds 2", threshold: "stuck >= 30m idle" },
      },
      {
        source: "derived",
        identity: "qi-a3|overdue|t1",
        fleetKey: "vps-a|qi-a3|overdue|t1",
        hostId: "vps-a",
        seenFrom: ["rig"],
        summary: "closeout sitting 2d",
        leg: "overdue",
        where: "rig",
        ageIso: null,
        priority: null,
        tier: null,
        evidenceRef: null,
        unblocks: null,
        qitemId: "qi-a3",
        destinationSession: null,
        derived: { kind: "overdue", evidence: "2d >= 24h ratify window", threshold: "overdue >= 24h" },
      },
    ],
    provenance: "fleet union of each host's own composed set · counted once per identity+host · 2/3 hosts composing (a failed host's items are ABSENT, not zero)",
  },
  hosts: [
    { hostId: "local", kind: "local", status: { hostId: "local", status: "ok" }, needsYouCount: 1, exceptionsByKind: [], seatCount: 3, rigCount: 2, topLine: "● sign-off needed: release brief" },
    { hostId: "vps-a", kind: "remote", status: { hostId: "vps-a", status: "ok" }, needsYouCount: 0, exceptionsByKind: [{ kind: "overdue", count: 1 }, { kind: "stuck", count: 1 }], seatCount: 4, rigCount: 1, topLine: "▲ stuck — packer2 idle 47m with work" },
    { hostId: "vps-b", kind: "remote", status: { hostId: "vps-b", status: "unreachable", error: "ECONNREFUSED", failedStep: "remote-daemon-unreachable" } },
  ],
  settled: [
    { hostId: "vps-a", fromSession: "packer2@factory-fleet", toSession: "lead@factory-fleet", summary: "palette run 118 closed", closedAtIso: "2026-07-08T13:40:00.000Z", qitemId: "qi-s1" },
  ],
  settledProvenance: "today's closed handoffs across 2 composing hosts",
  composedAt: "2026-07-08T14:00:00.000Z",
};

function stubFleetFetch(fleet: ComposedFleet) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/review/fleet")) {
      return Promise.resolve(new Response(JSON.stringify(fleet), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  return urls;
}

function renderFleetPage() {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <FleetPage />,
  });
  const agentsStub = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents",
    component: () => <div data-testid="agents-stub" />,
  });
  const routeTree = rootRoute.addChildren([indexRoute, agentsStub]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("FleetPage — the glance (locked twin fleet-glance-route-dark anatomy)", () => {
  it("renders the fleet union host-attributed with ▲ evidence+threshold inline and the seenFrom provenance line", async () => {
    stubFleetFetch(FLEET);
    const { getByTestId } = renderFleetPage();
    await waitFor(() => expect(getByTestId("fleet-page")).toBeTruthy());
    // ● 与 ▲ 行都带有主机标签。
    const stuck = getByTestId("fleet-needs-you-vps-a|qi-a2|stuck|t0");
    expect(stuck.getAttribute("data-source")).toBe("derived");
    expect(stuck.textContent).toContain("packer2 idle 47m with work");
    expect(stuck.textContent).toContain("idle 47m >= 30m default · holds 2");
    expect(stuck.textContent).toContain("阈值：stuck >= 30m idle");
    expect(stuck.textContent).toContain("计一次 · 从 rig 在 vps-a 上可见");
    const gate = getByTestId("fleet-needs-you-local|qi-l1");
    expect(gate.getAttribute("data-source")).toBe("agent");
    // 联合来源行逐字呈现。
    expect(getByTestId("fleet-needs-you").textContent).toContain("counted once per identity+host");
    // 页脚依据主机内嵌状态如实呈现扇出结果。
    expect(getByTestId("fleet-fanout-footer").textContent).toContain("车队分发 2/3 台主机正常");
  });

  it("renders the DAEMON's rollup VERBATIM — never recomputed from rows client-side", async () => {
    stubFleetFetch({
      ...FLEET,
      // 故意制造偏差：行合计 1●/2▲，但后台服务返回 7●/9▲。
      rollup: { needsYouCount: 7, exceptionCount: 9, exceptionsByKind: [{ kind: "stuck", count: 9 }], hostCount: 3, unreachableCount: 1 },
    });
    const { getByTestId } = renderFleetPage();
    await waitFor(() => expect(getByTestId("fleet-rollup")).toBeTruthy());
    const rollup = getByTestId("fleet-rollup").textContent ?? "";
    expect(rollup).toContain("● 7 需要你处理");
    expect(rollup).toContain("▲ 9 个异常");
    expect(rollup).toContain("3 台主机");
    expect(rollup).toContain("1 台不可达");
  });

  it("HOSTS band: ok rows carry counts + seat/rig math + open →; header math is checkable against them", async () => {
    stubFleetFetch(FLEET);
    const { getByTestId } = renderFleetPage();
    await waitFor(() => expect(getByTestId("fleet-hosts")).toBeTruthy());
    const vpsA = getByTestId("fleet-host-vps-a");
    expect(vpsA.textContent).toContain("▲ 1 overdue");
    expect(vpsA.textContent).toContain("▲ 1 stuck");
    expect(vpsA.textContent).toContain("1 个工作组 · 4 个席位");
    expect(getByTestId("fleet-host-vps-a-open")).toBeTruthy();
    // 如实 payload 的表头算术属性：汇总值等于逐主机之和。
    const local = getByTestId("fleet-host-local");
    expect(local.textContent).toContain("● 1");
    // 1（本地 ●）== rollup.needsYouCount；1+1（vps-a ▲）== rollup.exceptionCount。
  });
});

describe("FleetPage — unreachable honesty (absent-not-zero + a REAL refetch retry)", () => {
  it("a down host renders its structured status + the absent-not-zero line and NO counts", async () => {
    stubFleetFetch(FLEET);
    const { getByTestId } = renderFleetPage();
    await waitFor(() => expect(getByTestId("fleet-hosts")).toBeTruthy());
    const vpsB = getByTestId("fleet-host-vps-b");
    expect(vpsB.textContent).toContain("unreachable — ECONNREFUSED");
    expect(vpsB.textContent).toContain("事项在此概览中缺失，非零");
    expect(vpsB.textContent).not.toContain("rigs ·");
    expect(getByTestId("fleet-host-vps-b-retry")).toBeTruthy();
  });

  it("RETRY fires a REAL refetch (a second /api/review/fleet request — never a decorative button)", async () => {
    const urls = stubFleetFetch(FLEET);
    const { getByTestId } = renderFleetPage();
    await waitFor(() => expect(getByTestId("fleet-host-vps-b-retry")).toBeTruthy());
    const before = urls.filter((u) => u.includes("/api/review/fleet")).length;
    fireEvent.click(getByTestId("fleet-host-vps-b-retry"));
    await waitFor(() => {
      expect(urls.filter((u) => u.includes("/api/review/fleet")).length).toBe(before + 1);
    });
  });
});

describe("FleetPage — ?open=<fleetKey> expanded drawer (locked twin fleet-exception-expanded-dark)", () => {
  it("renders the Q4 one-count key VERBATIM + the evidence + the FR-5 read-only boundary line", async () => {
    window.history.replaceState({}, "", "/?open=vps-a|qi-a2|stuck|t0");
    stubFleetFetch(FLEET);
    const { getByTestId } = renderFleetPage();
    await waitFor(() => expect(getByTestId("fleet-item-expanded-vps-a|qi-a2|stuck|t0")).toBeTruthy());
    const drawer = getByTestId("fleet-item-expanded-vps-a|qi-a2|stuck|t0");
    expect(drawer.textContent).toContain("身份：vps-a|qi-a2|stuck|t0");
    expect(drawer.textContent).toContain("证据：idle 47m >= 30m default · holds 2");
    expect(drawer.textContent).toContain("此处只读——对远端主机事项的操作走跨主机路由 (MH-3/MH-4)");
    expect(drawer.textContent).toContain("打开 vps-a →");
  });
});

describe("FleetPage — the loud registryError state", () => {
  it("an existing-but-unreadable registry renders the LOCAL-ONLY warning, never a silent fleet", async () => {
    stubFleetFetch({ ...FLEET, registryError: "failed to parse host registry YAML at ~/.openrig/hosts.yaml" });
    const { getByTestId } = renderFleetPage();
    await waitFor(() => expect(getByTestId("fleet-registry-error")).toBeTruthy());
    expect(getByTestId("fleet-registry-error").textContent).toContain("此概览仅本地，非车队");
    expect(getByTestId("fleet-registry-error").textContent).toContain("failed to parse");
  });
});
