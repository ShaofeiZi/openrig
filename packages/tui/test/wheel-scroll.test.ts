import { describe, it, expect } from "vitest";
import { createInputDecoder, resolveMouseAction, sgrClick } from "../src/input.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";

// TUI 滚动（ruling cfec754f Part 1）——founder bug：点击有效，滚轮无效。SGR 鼠标解码
// 只对 button < 32（点击）发事件；滚轮刻（button & 64 → 码 64/65）被解码后丢弃。
// 此用例钉住滚轮 → content-scroll 动作（经 pageup/pagedown 透传路径），
// 并守卫普通点击仍可解码（回归）。

// SGR 滚轮：ESC [ < <button> ; x ; y M——64 = 上滚，65 = 下滚。
const wheel = (button: number, x = 10, y = 5) => `\x1b[<${button};${x};${y}M`;

function events(seq: string) {
  return createInputDecoder().write(seq);
}

describe("滚轮滚动——指针决定哪个窗格移动", () => {
  it("把滚轮坐标保留为鼠标事件", () => {
    const evs = events(wheel(65));
    expect(evs).toEqual([{ type: "mouse", button: 65, x: 10, y: 5 }]);
  });

  it("滚动指针下的 explorer 与指针下的 content", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "wheel", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
    expect(resolveMouseAction({ type: "mouse", button: 65, x: 5, y: 8 }, view.get(), screen, 20)).toEqual({
      type: "select", delta: 3, rowCount: 20,
    });
    expect(resolveMouseAction({ type: "mouse", button: 64, x: 90, y: 8 }, view.get(), screen, 20)).toEqual({
      type: "content-scroll", delta: -3,
    });
  });

  it("普通左键点击仍解码为鼠标事件（回归守卫）", () => {
    const evs = events(sgrClick(10, 5));
    expect(evs.some((e) => e.type === "mouse")).toBe(true);
    expect(evs).toEqual([
      { type: "mouse", button: 0, x: 10, y: 5 },
    ]);
  });
});
