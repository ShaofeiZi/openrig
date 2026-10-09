// OPR.0.4.0.1 TopologyTab progressive-terminal 前瞻修复。project/scope
// Topology-tab seat 终端（TopologyTab SeatRow）必须用共享
// ProgressiveTerminal——default-static -> 点击 go-live——并加入与其他表面相同
// 的全局 live-terminal 注册表/上限（FR-2），而非在分裂 fallback 注册表上的
// 原始静态 SessionPreviewPane。重叶子
//（FocusedTerminal xterm+WS、SessionPreviewPane 轮询）被 stub。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SliceDetail } from "../src/hooks/useSlices.js";

vi.mock("../src/components/terminal/FocusedTerminal.js", () => ({
  FocusedTerminal: ({ sessionName }: { sessionName: string }) => (
    <div data-testid={`live-${sessionName}`}>live terminal</div>
  ),
}));
vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  SessionPreviewPane: ({ sessionName }: { sessionName: string }) => (
    <div data-testid={`preview-${sessionName}`}>static preview</div>
  ),
}));

import { createTestRouter } from "./helpers/test-router.js";
import { TopologyTab } from "../src/components/slices/tabs/TopologyTab.js";
import { ProgressiveTerminal } from "../src/components/terminal/ProgressiveTerminal.js";
import {
  LiveTerminalProvider,
  __resetFallbackRegistryForTests,
} from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

function topologyWith(sessions: string[]): SliceDetail["topology"] {
  return {
    affectedRigs: [{ rigId: "rig-1", rigName: "demo", sessionNames: sessions }],
    totalSeats: sessions.length,
    specGraph: null,
  } as SliceDetail["topology"];
}

describe("TopologyTab progressive terminal (OPR.0.4.0.1 forward-fix)", () => {
  it("AC-1: the seat preview is default-STATIC, and a click upgrades it to LIVE", async () => {
    render(
      createTestRouter({
        component: () => (
          <LiveTerminalProvider cap={2}>
            <TopologyTab topology={topologyWith(["a@r"])} />
          </LiveTerminalProvider>
        ),
        path: "/",
      }),
    );

    // 展开 seat 行（router 异步挂载）
    fireEvent.click(await screen.findByTestId("topology-seat-a@r-toggle"));
    // default-static：ProgressiveTerminal 静态 trigger 存在，尚无 live
    expect(screen.getByTestId("topology-preview-a@r-static")).toBeTruthy();
    expect(screen.queryByTestId("live-a@r")).toBeNull();
    // 内部点击 -> go live
    fireEvent.click(screen.getByTestId("topology-preview-a@r-static"));
    expect(screen.getByTestId("topology-preview-a@r-live")).toBeTruthy();
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
  });

  it("AC-2: the topology-tab terminal SHARES the global cap with other surfaces (cap=2 evicts oldest)", async () => {
    render(
      createTestRouter({
        component: () => (
          <LiveTerminalProvider cap={2}>
            <TopologyTab topology={topologyWith(["t@r"])} />
            {/* two OTHER-surface terminals under the SAME provider */}
            <ProgressiveTerminal sessionName="n1@r" terminalKey="node-detail:n1@r" testIdPrefix="other-n1" />
            <ProgressiveTerminal sessionName="n2@r" terminalKey="node-detail:n2@r" testIdPrefix="other-n2" />
          </LiveTerminalProvider>
        ),
        path: "/",
      }),
    );

    // 先把 topology-tab 终端置为 live（最旧）；router 异步挂载
    fireEvent.click(await screen.findByTestId("topology-seat-t@r-toggle"));
    fireEvent.click(screen.getByTestId("topology-preview-t@r-static"));
    expect(screen.getByTestId("topology-preview-t@r-live")).toBeTruthy();

    // 把另外两个表面终端置 live -> 第 3 个超 cap=2 ->
    // 最旧者（topology-tab 那个）驱逐回 static。
    fireEvent.click(screen.getByTestId("other-n1-static"));
    fireEvent.click(screen.getByTestId("other-n2-static"));

    // 证明 topology-tab 终端加入同一注册表：它被
    // 其他表面置 live 驱逐 -> 回退 static，而非仍 live。
    expect(screen.queryByTestId("topology-preview-t@r-live")).toBeNull();
    expect(screen.getByTestId("topology-preview-t@r-static")).toBeTruthy();
    expect(screen.getByTestId("live-n1@r")).toBeTruthy();
    expect(screen.getByTestId("live-n2@r")).toBeTruthy();
  });

  it("FR-2: project ScopePages mounts an explicit shared LiveTerminalProvider (not the fallback)", () => {
    // 源码守卫：project scope shell 用显式
    // LiveTerminalProvider（cap 来自 useTerminalCap）包裹其页面，使 Topology-tab 终端
    // + 页面其他终端（如 HostMultiRigGraph）共享一个注册表，
    // 而非 TopologyTab 落到模块单例 fallback。
    const src = readFileSync(path.join(import.meta.dirname, "../src/components/project/ScopePages.tsx"), "utf8");
    expect(src).toContain("LiveTerminalProvider");
    expect(src).toContain("useTerminalCap");
  });
});
