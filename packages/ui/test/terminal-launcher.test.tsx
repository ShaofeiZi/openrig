// OPR.0.4.6.2（FR-5）——TerminalLauncher。视图库构建器和布局计算作为承重逻辑，
// 由纯单元测试覆盖；交互式打开流程与像素保真度由 VM 证明环节 9 覆盖
//（构建后 UI 截图对比 5 个锁定帧，再加一次真实启动），因此本文件不在 jsdom 中
// 强行操纵 Radix 对话框。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NodeInventoryEntry } from "../src/hooks/useNodeInventory.js";

// ── 对话框关闭状态渲染测试使用的 mock（纯函数测试无需 mock）。──
// 节点数据内联在工厂内部：Vitest 会把 vi.mock 提升到文件正文之前，因此工厂不能引用外部 const。
vi.mock("../src/hooks/useHosts.js", () => ({ useSelectedHostId: () => "local" }));
vi.mock("../src/hooks/useNodeInventory.js", () => ({
  useNodeInventory: () => ({
    data: [
      { rigId: "00000000-0000-4000-8000-000000000042", rigName: "v-openrig-build", logicalId: "orch.lead", canonicalSessionName: "orch-lead@acme-build", nodeKind: "agent", podNamespace: "orch", agentActivity: { state: "running" } },
      { rigId: "00000000-0000-4000-8000-000000000042", rigName: "v-openrig-build", logicalId: "dev.d1", canonicalSessionName: "dev-d1@acme-build", nodeKind: "agent", podNamespace: "dev", agentActivity: { state: "idle" } },
      { rigId: "00000000-0000-4000-8000-000000000042", rigName: "v-openrig-build", logicalId: "infra.daemon", canonicalSessionName: "infra@acme-build", nodeKind: "infrastructure", podNamespace: null },
    ],
  }),
}));
vi.mock("../src/hooks/useSlices.js", () => ({
  useSlices: () => ({ data: { slices: [{ name: "02-ride", missionId: "release-0.4.6", displayName: "02 ride" }] } }),
}));
vi.mock("../src/hooks/useTerminalViews.js", () => ({
  useTerminalViews: () => ({ data: { saved: [{ id: "watchtower", name: "Watchtower", members: [{ seat: "lead@acme-ops", readOnly: true }] }], rigs: ["acme-build"] } }),
}));
vi.mock("../src/hooks/useReviewAgents.js", () => ({ useReviewAgents: () => ({ data: undefined }) }));
vi.mock("../src/components/mission-control/missionControlAuth.js", () => ({ terminalAuthHeaders: () => ({}) }));

import {
  TerminalLauncher,
  buildLauncherViews,
  suggestLayout,
  describeOpenResult,
  type OpenViewResult,
} from "../src/components/topology/TerminalLauncher.js";

const node = (partial: Partial<NodeInventoryEntry>): NodeInventoryEntry =>
  ({
    rigId: "rig-1",
    rigName: "acme",
    nodeKind: "agent",
    canonicalSessionName: null,
    logicalId: "x",
    podNamespace: null,
    ...partial,
  } as unknown as NodeInventoryEntry);

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("buildLauncherViews — the view library", () => {
  const slices = [{ name: "02-ride", missionId: "release-0.4.6", displayName: "02 ride" }];
  const saved = [{ id: "watchtower", name: "Watchtower", members: [{ seat: "a@r", readOnly: true }, { seat: "b@r", readOnly: true }] }];

  it("puts the rig first, interactive, with all agent seats (infra excluded)", () => {
    const views = buildLauncherViews({
      nodes: [node({ logicalId: "orch.lead", canonicalSessionName: "orch-lead@acme", podNamespace: "orch" }), node({ nodeKind: "infrastructure", canonicalSessionName: "infra@acme" })],
      rigId: "rig-1",
      rigName: "acme",
      slices: [],
      savedViews: [],
    });
    expect(views[0]).toMatchObject({ id: "rig:rig-1", kind: "rig", label: "acme" });
    expect(views[0]!.crossRig).toBeUndefined(); // 工作组视图可交互。
    expect(views[0]!.seats).toHaveLength(1); // 排除基础设施节点。
  });

  it.each([null, ""])(
    "resolves a missing caller name from the matching node and never labels the rig with its UUID (%j)",
    (rigName) => {
      const rigId = "00000000-0000-4000-8000-000000000042";
      const views = buildLauncherViews({
        nodes: [node({ rigId, rigName: "v-openrig-build" })],
        rigId,
        rigName,
        slices: [],
        savedViews: [],
      });

      expect(views[0]!.label).toBe("v-openrig-build");
      expect(views[0]!.label).not.toContain(rigId);
    },
  );

  it("keeps an explicit nonblank caller name ahead of the node fallback", () => {
    const rigId = "00000000-0000-4000-8000-000000000042";
    const views = buildLauncherViews({
      nodes: [node({ rigId, rigName: "node-name" })],
      rigId,
      rigName: "summary-name",
      slices: [],
      savedViews: [],
    });

    expect(views[0]!.label).toBe("summary-name");
  });

  it("uses the exact honest unavailable label for mismatched or blank node names", () => {
    const rigId = "00000000-0000-4000-8000-000000000042";
    const views = buildLauncherViews({
      nodes: [
        node({ rigId: "00000000-0000-4000-8000-000000000099", rigName: "another-rig" }),
        node({ rigId, rigName: "   " }),
      ],
      rigId,
      rigName: " ",
      slices: [],
      savedViews: [],
    });

    expect(views[0]!.label).toBe("工作组名不可用");
  });

  it("groups agents into pod views by podNamespace and names absent seats", () => {
    const views = buildLauncherViews({
      nodes: [
        node({ logicalId: "dev.d1", canonicalSessionName: "dev-d1@acme", podNamespace: "dev" }),
        node({ logicalId: "dev.d2", canonicalSessionName: null, podNamespace: "dev" }),
        node({ logicalId: "orch.lead", canonicalSessionName: "orch-lead@acme", podNamespace: "orch" }),
      ],
      rigId: "rig-1",
      slices: [],
      savedViews: [],
    });
    const dev = views.find((v) => v.id === "pod:rig-1/dev");
    expect(dev).toBeTruthy();
    expect(dev!.seats).toHaveLength(2);
    expect(dev!.seats!.filter((s) => s.live)).toHaveLength(1); // d2 没有会话，因此缺席。
    expect(dev!.seats!.find((s) => !s.live)!.reason).toBe("未启动");
    expect(views.some((v) => v.id === "pod:rig-1/orch")).toBe(true);
  });

  it("adds derived mission + slice views (seats null, read-only by construction)", () => {
    const views = buildLauncherViews({ nodes: [], rigId: "rig-1", slices, savedViews: [] });
    const mission = views.find((v) => v.id === "mission:release-0.4.6");
    const slice = views.find((v) => v.id === "slice:02-ride");
    expect(mission).toMatchObject({ kind: "mission", seats: null, crossRig: true });
    expect(slice).toMatchObject({ kind: "slice", seats: null, crossRig: true });
  });

  it("marks a fully read-only saved view as read-only (crossRig)", () => {
    const views = buildLauncherViews({ nodes: [], rigId: "rig-1", slices: [], savedViews: saved });
    expect(views.find((v) => v.id === "watchtower")).toMatchObject({ kind: "saved", crossRig: true });
  });

  it("a saved view with an interactive member is NOT read-only", () => {
    const mixed = [{ id: "mix", name: "Mix", members: [{ seat: "a@r", readOnly: true }, { seat: "b@r" }] }];
    const views = buildLauncherViews({ nodes: [], rigId: "rig-1", slices: [], savedViews: mixed });
    expect(views.find((v) => v.id === "mix")!.crossRig).toBe(false);
  });
});

describe("suggestLayout — grid math + paging cap", () => {
  it("caps shown panes at 9 and reports the overflow", () => {
    expect(suggestLayout(12)).toMatchObject({ shown: 9, cols: 3, rows: 3, paged: 3 });
  });
  it("no paging under the cap", () => {
    expect(suggestLayout(4)).toMatchObject({ shown: 4, cols: 2, rows: 2, paged: 0 });
  });
  it("one pane is a 1×1 grid", () => {
    expect(suggestLayout(1)).toMatchObject({ shown: 1, cols: 1, rows: 1, paged: 0 });
  });
});

describe("describeOpenResult — Guard G2: a 200 body is authoritative, not auto-green", () => {
  const base = (over: Partial<OpenViewResult>): OpenViewResult => ({
    provider: "herdr", ok: true, opened: [], absent: [], degraded: [], pages: 0, ...over,
  });

  it("200 provider-failure (ok:false, opened:[], code herdr_unavailable) → NOT success", () => {
    const d = describeOpenResult(base({ ok: false, opened: [], code: "herdr_unavailable", error: "no binary" }));
    expect(d.ok).toBe(false);
    expect(d.headline).toContain("未打开任何磁贴");
    expect(d.headline).toContain("herdr_unavailable");
    expect(d.headline).toContain("no binary");
  });

  it("200 zero-pane with absent/degraded → failure, seats NAMED with reasons (not a count)", () => {
    const d = describeOpenResult(
      base({
        ok: false,
        opened: [],
        absent: [{ seat: "a@r", host: null, reason: "not alive" }],
        degraded: [{ seat: "b@r", host: "front-door", reason: "host front-door is http-registered; tiles need ssh" }],
      }),
    );
    expect(d.ok).toBe(false);
    expect(d.disclosure).toContain("a@r: not alive");
    expect(d.disclosure).toContain("b@r (front-door): host front-door is http-registered; tiles need ssh");
  });

  it("200 partial success (>=1 opened) → success PLUS named absent/degraded disclosure", () => {
    const d = describeOpenResult(
      base({ ok: true, opened: ["x@r"], absent: [{ seat: "y@r", host: null, reason: "not alive" }] }),
    );
    expect(d.ok).toBe(true);
    expect(d.headline).toBe("在 herdr 中打开了 1 个");
    expect(d.disclosure).toContain("y@r: not alive");
  });
});

describe("TerminalLauncher — mounts with its live hooks (collapsed)", () => {
  it("renders the collapsed trigger button", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <TerminalLauncher rigId="rig-1" rigName="acme-build" />
      </QueryClientProvider>,
    );
    const btn = screen.getByTestId("terminal-launcher-button");
    expect(btn.textContent).toContain("在终端中打开");
  });

  it("uses one resolved canonical label in the deep-linked header and rig row without exposing the UUID", () => {
    const rigId = "00000000-0000-4000-8000-000000000042";
    window.history.replaceState(
      {},
      "",
      `/topology/rig/${rigId}?launcher=open&provider=cmux&view=${encodeURIComponent(`rig:${rigId}`)}`,
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    render(
      <QueryClientProvider client={qc}>
        <TerminalLauncher rigId={rigId} rigName={null} />
      </QueryClientProvider>,
    );

    const dialog = screen.getByTestId("terminal-launcher-dialog");
    const rigRow = screen.getByTestId(`launcher-view-rig:${rigId}`);
    expect(dialog.textContent).toContain("v-openrig-build · 拓扑");
    expect(rigRow.textContent).toContain("v-openrig-build");
    expect(dialog.textContent).not.toContain(rigId);
  });

  it("keeps the deep-linked dialog inside a one-rem viewport inset with vertically reachable content", () => {
    window.history.replaceState({}, "", "/topology/rig/rig-1?launcher=open");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    render(
      <QueryClientProvider client={qc}>
        <TerminalLauncher rigId="rig-1" rigName="acme-build" />
      </QueryClientProvider>,
    );

    const classes = screen.getByTestId("terminal-launcher-dialog").className;
    expect(classes).toContain("w-[calc(100vw-2rem)]");
    expect(classes).toContain("max-h-[calc(100vh-2rem)]");
    expect(classes).toContain("overflow-y-auto");
    expect(classes).not.toContain("overflow-hidden");
  });
});
