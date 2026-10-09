// OPR.0.4.0.1 二轮 QA 修复：rig 范围 graph 节点 popover
//（RigNode -> TerminalPreviewPopover）必须参与渐进式
// default-static -> 点内转 live 模型，而非立即打开
// always-live FocusedTerminal。QA BLOCKING（qitem-20260621025642-b4c89c72）
// 证明 RigNode 挂载 popover 时无 `progressive` prop，故
// 打开即立即产生 live xterm/WebSocket。重叶子
//（FocusedTerminal -> xterm+WS，SessionPreviewPane -> 轮询）被 stub，
// 使测试走 RigNode -> popover -> ProgressiveTerminal 接线。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

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

import { RigNode } from "../src/components/RigNode.js";
import { __resetFallbackRegistryForTests } from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

describe("RigNode terminal popover (OPR.0.4.0.1 round-two QA fix)", () => {
  it("opens default-STATIC (ProgressiveTerminal), not an immediate live FocusedTerminal", () => {
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
            startupStatus: "ready" as const,
            canonicalSessionName: "dev-impl@test-rig",
            binding: { tmuxSession: "dev-impl@test-rig", cmuxSurface: "s1" },
            resumeToken: "abc-123",
          }}
        />
      </ReactFlowProvider>,
    );

    fireEvent.click(screen.getByTestId("rig-node-dev.impl-terminal-open"));

    // popover 渲染 ProgressiveTerminal，其默认模式是 STATIC
    // SessionPreviewPane——故静态预览在场…
    expect(screen.getByTestId("preview-dev-impl@test-rig")).toBeTruthy();
    // …且打开时不挂载 live xterm/WebSocket 终端。
    expect(screen.queryByTestId("live-dev-impl@test-rig")).toBeNull();
  });
});
