// OPR.0.4.3.06 前瞻修复——topology 节点必须消费 + 渲染
// startup-proof orientation 判定，而非静默藏于节点数据并
// 默认绿。Keystone：`rejected`/`missing` orientation 渲染其
// 自有未验证标签；裸 ACK 派生的 `rejected` 绝不渲染为
// verified/proven；`verified` 渲染 verified；`n-a`（resumed/non-agent）
// 隐藏（镜像 RESTORE 徽章）。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

// 重叶子仅在 terminal popover 打开时挂载；stub 它们，使
// 纯节点渲染永不触达 xterm/WebSocket。
vi.mock("../src/components/terminal/FocusedTerminal.js", () => ({
  FocusedTerminal: ({ sessionName }: { sessionName: string }) => <div data-testid={`live-${sessionName}`} />,
}));
vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  SessionPreviewPane: ({ sessionName }: { sessionName: string }) => <div data-testid={`preview-${sessionName}`} />,
}));

import { RigNode } from "../src/components/RigNode.js";
import { __resetFallbackRegistryForTests } from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

function renderNode(oriented: string | undefined) {
  render(
    <ReactFlowProvider>
      <RigNode
        data={{
          logicalId: "dev.impl",
          rigId: "rig-1",
          role: "worker",
          runtime: "claude-code",
          model: null,
          status: "running",
          // `ready` = delivered/interactive——正是 19/21 缺口
          // 把未验证 orientation 藏在后面的绿默认态。
          startupStatus: "ready" as const,
          canonicalSessionName: "dev-impl@test-rig",
          binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: "s1" },
          oriented,
        }}
      />
    </ReactFlowProvider>,
  );
}

describe("RigNode startup-proof orientation badge (OPR.0.4.3.06)", () => {
  it("renders the verdict label for a REJECTED orientation, never as verified/proven", () => {
    renderNode("rejected");
    const badge = screen.getByTestId("orientation-badge");
    expect(badge.textContent).toContain("rejected");
    // Keystone：rejected（含裸 ACK）proof 绝不读作 verified。
    expect(badge.textContent).not.toMatch(/verified|proven|oriented(?!:)/i);
  });

  it("renders the verdict label for a MISSING orientation (challenged, unproven)", () => {
    renderNode("missing");
    expect(screen.getByTestId("orientation-badge").textContent).toContain("missing");
  });

  it("renders the verdict label for a VERIFIED orientation", () => {
    renderNode("verified");
    expect(screen.getByTestId("orientation-badge").textContent).toContain("verified");
  });

  it("hides the badge for n-a (resumed / non-agent — nothing to prove)", () => {
    renderNode("n-a");
    expect(screen.queryByTestId("orientation-badge")).toBeNull();
  });

  it("hides the badge when the node data carries no orientation", () => {
    renderNode(undefined);
    expect(screen.queryByTestId("orientation-badge")).toBeNull();
  });
});
