// OPR.0.4.0.39 FR-2/3/4——topology 终端 grid 的源码守卫：
// 响应式 1/2/3 列、可读性底线 CSS 缩放缩小、收紧
// padding。源码守卫（精确视觉结果由 QA 截图验证）。
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const RAW = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/components/topology/TopologyTerminalView.tsx"),
  "utf-8",
);
// 源码守卫作用于代码而非注释：剥离 /* */（含 JSX {/* */}）与 // 行
// 注释，使一个合法命名被移除 token 的注释（如"无独立
// TerminalPreviewPopover trigger"、"无 overflow-hidden"）不触发下方负向断言。
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("TopologyTerminalView grid (OPR.0.4.0.39 FR-2/3/4)", () => {
  it("FR-2 (founder: 2 columns MAXIMUM): 1-col narrow / 2-col wider, NO 3-col", () => {
    expect(SRC).toContain("grid-cols-1");
    expect(SRC).toContain("md:grid-cols-2");
    // 3 列已弃——3 列并排时缩放的 90 列终端太小而
    // 不可读；2 列使每 cell 宽到可读终端。
    expect(SRC).not.toContain("grid-cols-3");
  });

  it("FR-3: fit-width is delegated to the shared scaler (ProgressiveTerminal -> ScaleToFitTerminal), not a hardcoded grid scale", () => {
    // grid 不得再按断点硬编码 CSS 缩放；ProgressiveTerminal
    // 把 static + live 都包进 ScaleToFitTerminal，后者测量固定 90 列
    // 块并缩放以适配每 cell 宽度（fit-width，绝不裁剪）。
    expect(SRC).not.toContain("origin-top-left");
    expect(SRC).not.toContain("xl:scale-90");
    const PROG = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/ProgressiveTerminal.tsx"),
      "utf-8",
    );
    expect(PROG).toContain("ScaleToFitTerminal");
  });

  it("FR-4: NO white card wrapper + tightened padding/gaps (founder spec-correction)", () => {
    expect(SRC).toContain("p-1.5");
    expect(SRC).toContain("gap-1.5");
    // 白卡包装被整体移除（bg-white/40 对比度过高），
    // 非仅调参；宽松的 gap-3 grid 间距也没了。
    expect(SRC).not.toContain("bg-white/40");
    expect(SRC).not.toContain("gap-3");
  });

  it("FR-1/FR-6: the static IS the in-place click-to-live target (ProgressiveTerminal), no separate popover trigger", () => {
    expect(SRC).toContain("ProgressiveTerminal");
    // grid 不再经独立 expand-out popover trigger 触达 live。
    expect(SRC).not.toContain("TerminalPreviewPopover");
  });
});
