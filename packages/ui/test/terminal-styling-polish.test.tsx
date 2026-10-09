// OPR.0.4.0.1 终端 STYLING 打磨：烟熏玻璃 CONTENT（live + static）+
// 无边框 + 实测 LIVE 宽度 + FR-5 网格展开。裸表面烟熏
// 必须来自共享层（ProgressiveTerminal static plate + FocusedTerminal
// bg），而非仅 popover/shell plate——使其到达真裸表面。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  SessionPreviewPane: ({ sessionName, variant }: { sessionName: string; variant?: string }) => (
    <div data-testid={`preview-${sessionName}`} data-variant={variant ?? "default"}>static preview</div>
  ),
}));
vi.mock("../src/components/terminal/FocusedTerminal.js", () => ({
  FocusedTerminal: ({ sessionName }: { sessionName: string }) => (
    <div data-testid={`live-${sessionName}`}>live terminal</div>
  ),
}));

import { ProgressiveTerminal } from "../src/components/terminal/ProgressiveTerminal.js";
import {
  LiveTerminalProvider,
  __resetFallbackRegistryForTests,
} from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

const src = (rel: string) => readFileSync(path.join(import.meta.dirname, rel), "utf8");

describe("OPR.0.4.0.1 terminal styling polish", () => {
  it("FR-1/FR-2: the static preview carries a BORDERLESS smoked-glass plate + the compact-terminal variant", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="k:a" testIdPrefix="t" />
      </LiveTerminalProvider>,
    );
    const staticBtn = screen.getByTestId("t-static");
    // 裸表面 static 视图自带其烟熏玻璃板（FR-4）……
    expect(staticBtn.className).toContain("bg-stone-950/85");
    expect(staticBtn.className).toContain("backdrop-blur-sm");
    // ……且无边框（FR-2 浮动板，非带边框盒子）
    expect(staticBtn.className).not.toContain("border");
    // 用无边框 + 透明 compact-terminal 变体（FR-1/FR-2）
    expect(screen.getByTestId("preview-a@r").getAttribute("data-variant")).toBe("compact-terminal");
  });

  it("FR-1: the LIVE terminal keeps an opaque xterm render surface so erase/redraw is cursor-safe", () => {
    const s = src("../src/components/terminal/FocusedTerminal.tsx");
    // OPR.0.4.0.39：几何常量迁到 terminal-geometry.ts（static<->live 镜像共享的
    // 单一真相源）。FocusedTerminal import + 使用它们；不透明 / 90x27 /
    // lineHeight-1 契约不变。
    const geo = src("../src/components/terminal/terminal-geometry.ts");
    expect(geo).toContain('export const LIVE_TERMINAL_RENDER_BACKGROUND = "#0c0a09"');
    expect(geo).toContain("export const LIVE_TERMINAL_COLS = 90");
    expect(geo).toContain("export const LIVE_TERMINAL_ROWS = 27");
    expect(geo).toContain("export const LIVE_TERMINAL_LINE_HEIGHT = 1");
    expect(s).toContain('from "./terminal-geometry.js"');
    expect(s).toContain("cols: LIVE_TERMINAL_COLS");
    expect(s).toContain("rows: LIVE_TERMINAL_ROWS");
    expect(s).toContain("lineHeight: LIVE_TERMINAL_LINE_HEIGHT");
    expect(s).toContain("applyOpaqueTerminalBackground(containerRef.current!)");
    expect(s).toContain("scrollTerminalViewportToPrompt(containerRef.current!)");
    expect(s).toContain("term.scrollToBottom();");
    expect(s).toContain('querySelector<HTMLElement>("textarea.xterm-helper-textarea")');
    expect(s).toContain("const desiredScrollTop = cursorBottom - container.clientHeight + lineHeight * 3");
    expect(s).toContain("container.scrollTop = Math.min(maxScrollTop, Math.max(0, desiredScrollTop))");
    expect(s).toContain("term.focus();");
    expect(s).toContain("allowTransparency: false");
    expect(s).not.toContain("allowTransparency: true");
    expect(s).not.toContain("FitAddon");
    expect(s).not.toContain("fitAddon.fit");
    expect(s).not.toContain('background: "rgba(0,0,0,0)"');
    expect(s).toContain('foreground: "#e0e0e0"'); // text stays OPAQUE (AC-4 legibility)
  });

  it("OPR.0.4.0.39 (founder spec): the popover sizes to the canonical geometry (w-max shell, LIVE_TERMINAL_COLS-ch inner), no hardcoded plate width, no redundant opaque bg", () => {
    const s = src("../src/components/topology/TerminalPreviewPopover.tsx");
    // shell 按内容定尺寸（w-max），内部是规范几何宽度
    //（LIVE_TERMINAL_COLS ch）——追踪列数，无 reshape、无松空宽度、无硬编码 880/904 板。
    expect(s).toContain("w-max");
    expect(s).toContain("LIVE_TERMINAL_COLS");
    expect(s).not.toContain("w-[880px]");
    expect(s).not.toContain("w-[904px]");
    expect(s).not.toContain("bg-stone-950/65"); // live wrapper supplies the plate
    expect(s).toContain("backdrop-blur-sm");
  });

  it("OPR.0.4.0.39 (founder spec, REVERSES slice-01 FR-5): the topology grid card mounts the in-place ProgressiveTerminal, NOT the TerminalPreviewPopover trigger", () => {
    // Founder live-review 反转了网格（及所有表面）的 popover 展开：
    // static 就是原位 click-to-live 目标。
    const s = src("../src/components/topology/TopologyTerminalView.tsx");
    expect(s).toContain("import { ProgressiveTerminal }");
    expect(s).not.toContain("TerminalPreviewPopover");
  });

  it("OPR.0.4.0.39 (node-detail fit): ScaleToFitTerminal has a 'contain' mode (fill both axes, capped upscale, centered) that the node-detail panel opts into; the grid keeps fit-width", () => {
    const scaler = src("../src/components/terminal/ScaleToFitTerminal.tsx");
    // contain 双轴适配（宽/高比的 min），允许有上限放大，
    // 且居中——使大专用面板被填满，而非小留左上。
    expect(scaler).toContain('fit?: "width" | "contain"');
    expect(scaler).toContain("MAX_CONTAIN_SCALE");
    expect(scaler).toContain("availableHeight / naturalHeight");
    expect(scaler).toContain("items-center justify-center");
    // ProgressiveTerminal 把 `fit` 转发给 static + live 两个 scaler（镜像）。
    const prog = src("../src/components/terminal/ProgressiveTerminal.tsx");
    expect(prog).toContain('fit?: "width" | "contain"');
    expect((prog.match(/fit=\{fit\}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // node-detail 面板（大 500px 区域）选用 contain；grid 不选
    //（保持默认 fit-width，使 cell 永不上放大）。
    expect(src("../src/components/LiveNodeDetails.tsx")).toContain('fit="contain"');
    expect(src("../src/components/topology/TopologyTerminalView.tsx")).not.toContain('fit="contain"');
  });

  it("OPR.0.4.0.39 (selection fix #6023): the LIVE xterm scales via fontSize, NOT a CSS transform, so xterm selection/click hit-testing stays native-correct", () => {
    const focused = src("../src/components/terminal/FocusedTerminal.tsx");
    // FocusedTerminal 通过设置 term fontSize 以适配其容器来定 live xterm 尺寸
    //（xterm 上无 CSS transform）——#6023 的 maintainer 认可修复。
    expect(focused).toContain('fit?: "natural" | "width" | "contain"');
    expect(focused).toContain("options.fontSize");
    expect(focused).toContain("MAX_FIT_UPSCALE");
    expect(focused).toContain("#6023");
    // live xterm 不得被 CSS transform 缩放（那会破坏 selection）。
    expect(focused).not.toContain("transform: `scale");
    expect(focused).not.toContain("transformOrigin");
    // ProgressiveTerminal 的 LIVE 分支渲染带 fit（fontSize）的 FocusedTerminal，
    // 不包在基于 transform 的 ScaleToFitTerminal 里（仅 static plate）。
    const prog = src("../src/components/terminal/ProgressiveTerminal.tsx");
    expect(prog).toContain("<FocusedTerminal sessionName={sessionName} fit={fit}");
    // ScaleToFitTerminal（CSS transform）仍被 import + 使用——用于 STATIC plate。
    expect(prog).toContain("ScaleToFitTerminal");
  });
});
