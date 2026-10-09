// OPR.0.4.0.1 rev1-r2 修复：渐进终端弹出层（图/表表面）必须能在全局
// LiveTerminalRegistry 上限内共存。旧版单开 TERMINAL_PREVIEW_EVENT 会在一个弹出层打开时
// 强制关闭所有同级项，因此同一时间最多只能存在一个弹出层、也就最多一个实时终端，使 AC-4
//（“在 B 中输入时观察 A”+ 上限 2 时淘汰最早项）在弹出层表面无法实现；只有拓扑网格原位路径
// 能做到。现在各渐进弹出层可独立打开，由全局上限约束实时数量。重量级叶组件
//（FocusedTerminal xterm+WS、SessionPreviewPane 轮询）使用 stub。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

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

import { TerminalPreviewPopover } from "../src/components/topology/TerminalPreviewPopover.js";
import {
  LiveTerminalProvider,
  __resetFallbackRegistryForTests,
} from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

// 打开渐进弹出层，并点击静态触发器转为实时。
function goLive(prefix: string) {
  fireEvent.click(screen.getByTestId(`${prefix}-terminal-open`));
  fireEvent.click(screen.getByTestId(`${prefix}-static`));
}

describe("Progressive terminal popovers coexist under the global cap (rev1-r2 fix)", () => {
  it("opening a second progressive popover does NOT close the first -- two live at once", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <TerminalPreviewPopover rigId="r1" logicalId="a" sessionName="a@r" testIdPrefix="pa" progressive />
        <TerminalPreviewPopover rigId="r1" logicalId="b" sessionName="b@r" testIdPrefix="pb" progressive />
      </LiveTerminalProvider>,
    );
    goLive("pa");
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    goLive("pb");
    // 两者同时在线；第一个弹出层未被强制关闭。
    expect(screen.getByTestId("live-a@r")).toBeTruthy();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
  });

  it("OPR.0.4.0.39 (founder spec, REVERSES rev1-r2 reshape): the popover holds the full-terminal width for BOTH static and live (no reshape on go-live)", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <TerminalPreviewPopover rigId="r1" logicalId="a" sessionName="a@r" testIdPrefix="pa" progressive />
      </LiveTerminalProvider>,
    );
    // 打开弹出层 → 静态状态 → 外壳已是完整终端宽度；静态视图是 90 列镜像，不是小型紧凑预览。
    fireEvent.click(screen.getByTestId("pa-terminal-open"));
    expect(screen.getByTestId("pa-terminal-popover").className).toContain("w-max");
    expect(screen.getByTestId("pa-terminal-popover").className).not.toContain("w-[calc(80ch+24px)]");
    // 点击内部 → 实时状态 → 宽度保持不变；不重塑、不迁移，静态视图只在原位从玻璃态切为
    // 不透明态，符合创建者的镜像要求。
    fireEvent.click(screen.getByTestId("pa-static"));
    expect(screen.getByTestId("pa-terminal-popover").className).toContain("w-max");
    expect(screen.getByTestId("pa-terminal-popover").className).not.toContain("w-[calc(80ch+24px)]");
  });

  it("a third live progressive popover evicts the OLDEST to static (global cap=2)", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <TerminalPreviewPopover rigId="r1" logicalId="a" sessionName="a@r" testIdPrefix="pa" progressive />
        <TerminalPreviewPopover rigId="r1" logicalId="b" sessionName="b@r" testIdPrefix="pb" progressive />
        <TerminalPreviewPopover rigId="r1" logicalId="c" sessionName="c@r" testIdPrefix="pc" progressive />
      </LiveTerminalProvider>,
    );
    goLive("pa");
    goLive("pb");
    goLive("pc");
    // 上限为 2：最早的 a 回到静态，b 与 c 保持实时。
    expect(screen.queryByTestId("live-a@r")).toBeNull();
    expect(screen.getByTestId("live-b@r")).toBeTruthy();
    expect(screen.getByTestId("live-c@r")).toBeTruthy();
  });
});
