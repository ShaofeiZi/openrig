import { describe, it, expect } from "vitest";
import { resolveKeyAction } from "../src/input.js";
import type { Screen, ViewState, InputEvent } from "../src/types.js";

// TUI 滚动（ruling cfec754f Part 1）——选择驱动的箭头自动滚动（k9s）。content 聚焦时，
// 选择在可见目标间移动；在视口边缘且其外还有内容时，箭头滚动视口（reveal）而非钳住——
// 使 ↑↓ 无需 PgUp/PgDn 即到达所有行。远离边缘时仍移动选择。

const keyDown: Extract<InputEvent, { type: "key" }> = { type: "key", key: "down", action: { type: "select", delta: 1 } };
const keyUp: Extract<InputEvent, { type: "key" }> = { type: "key", key: "up", action: { type: "select", delta: -1 } };

function screen(nTargets: number): Screen {
  const contentTargets = Array.from({ length: nTargets }, (_, i) => ({ y: i + 3, x1: 32, x2: 80, action: { type: "noop" as const } }));
  return { lines: [], hitMap: [], contentTargets, contentMaxOffset: 5, explorerRows: [] };
}
function state(over: Partial<ViewState>): ViewState {
  return {
    instanceId: "t", section: "topology", drill: [], selection: 0, filter: "", viewTab: "table",
    focusedPane: "content", contentOffset: 0, contentMaxOffset: 5, contentSelection: 0, contentTargetCount: 3,
    ...over,
  } as ViewState;
}

describe("resolveKeyAction——内容视口边缘的方向键自动滚动 (k9s)", () => {
  it("在最后一个可见目标且下方有更多内容 → content-scroll（揭示），非 clamp", () => {
    const a = resolveKeyAction(keyDown, state({ contentSelection: 2, contentOffset: 0, contentMaxOffset: 5 }), screen(3), 10);
    expect(a).toEqual({ type: "content-scroll", delta: 1 });
  });

  it("不在边缘 → content-select（移动选择）", () => {
    const a = resolveKeyAction(keyDown, state({ contentSelection: 0, contentOffset: 0 }), screen(3), 10);
    expect(a).toEqual({ type: "content-select", delta: 1 });
  });

  it("在最后一个目标且下方无更多内容 → content-select（clamp，无幽灵滚动）", () => {
    const a = resolveKeyAction(keyDown, state({ contentSelection: 2, contentOffset: 5, contentMaxOffset: 5 }), screen(3), 10);
    expect(a).toEqual({ type: "content-select", delta: 1 });
  });

  it("在第一个目标且上方已滚出内容 → content-scroll（向上揭示）", () => {
    const a = resolveKeyAction(keyUp, state({ contentSelection: 0, contentOffset: 3, contentMaxOffset: 5 }), screen(3), 10);
    expect(a).toEqual({ type: "content-scroll", delta: -1 });
  });

  it("在第一个目标且已在顶部 → content-select（clamp）", () => {
    const a = resolveKeyAction(keyUp, state({ contentSelection: 0, contentOffset: 0 }), screen(3), 10);
    expect(a).toEqual({ type: "content-select", delta: -1 });
  });
});
