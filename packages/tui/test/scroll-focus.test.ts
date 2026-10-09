// TUI scroll-focus 修复（class-(b) focus-model 缺陷，诊断 360e37d3）。
//
// Founder 缺陷：在 spec 详情页，反射性 Down 键产生零可见变化——
// 箭头驱动（隐藏的）explorer 树；body 滚动只活于不可发现的 PageUp/Down + content-focus，
// 滚动提示被门控在它所教的状态之后（catch-22），且可见的 "content ↑/↓"
// 指示向键盘用户点名鼠标区。
//
// 修复形状（诚实最小，保 focus 模型）：在可滚 spec
// 详情上，反射性 ↑↓ 滚动 body，不论哪个窗格持焦；
// 滚动 affordance 在 body 真可滚时呈现（不
// 门控在已聚焦之后）；溢出指示命名滚动
// 控件，非错误的键。路由 + 提示经一个 helper 保持同步。

import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { decodeInput, resolveKeyAction } from "../src/input.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot, ViewStateStore, Screen } from "../src/types.js";

function syncLayout(s: ViewStateStore, snap: FleetSnapshot, cols: number, rows: number): Screen {
  const screen = renderScreen(s.get(), snap, { cols, rows });
  s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
  return renderScreen(s.get(), snap, { cols, rows });
}

function pressKey(s: ViewStateStore, snap: FleetSnapshot, bytes: string, screen: Screen): void {
  const ev = decodeInput(bytes)[0];
  if (!ev || ev.type !== "key") throw new Error("expected a key event");
  const action = resolveKeyAction(ev, s.get(), screen, computeExplorerRows(s.get(), snap).length);
  if (action) s.dispatch(action);
}

const DOWN = "\x1b[B";

function scrollableSpecSnapshot(): FleetSnapshot {
  const longDescription = Array.from({ length: 40 }, (_, i) =>
    `paragraph ${i}: this agent guidance body is deliberately long so the detail overflows a small viewport`,
  ).join(" ");
  return {
    ...emptySnapshot(),
    specs: [{
      name: "driver-agent",
      kind: "agent",
      description: longDescription,
      runtime: "claude-code",
      skills: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"],
    }],
  };
}

describe("TUI scroll-focus 修复——founder 场景 + 可操作项", () => {
  it("founder 关键：可滚 spec 详情上 Down 滚正文，explorer 不动", () => {
    const snap = scrollableSpecSnapshot();
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch({ type: "drill", resource: "spec", name: "driver-agent" });
    const screen = syncLayout(s, snap, 100, 12);

    // 前置：我们在可滚 spec 详情上
    expect(s.get().section).toBe("specs");
    expect(s.get().drill.length).toBeGreaterThan(0);
    expect(s.get().contentMaxOffset).toBeGreaterThan(0);

    const selectionBefore = s.get().selection;
    expect(s.get().contentOffset).toBe(0);

    pressKey(s, snap, DOWN, screen);

    // body 滚动了（可见变化）且 explorer 光标未动
    expect(s.get().contentOffset).toBeGreaterThan(0);
    expect(s.get().selection).toBe(selectionBefore);
  });

  it("catch-22 关键：可滚正文即使 explorer 聚焦且不在 yaml tab 也浮现滚动提示", () => {
    const snap = demoSnapshot();
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = syncLayout(s, snap, 100, 8);

    // 前置：可滚，但 explorer 聚焦且非 yaml 标签
    //（正是旧提示门压制 affordance 的状态）
    expect(s.get().contentMaxOffset).toBeGreaterThan(0);
    expect(s.get().focusedPane).toBe("explorer");
    expect(s.get().viewTab).not.toBe("yaml");

    // footer 被宽度裁剪；quit 是此视口之外的后续提示。
    const hint = screen.lines.find((l) => l.includes("↑↓ 移动"));
    expect(hint).toBeDefined();
    expect(hint).toContain("⇞⇟ 滚动");
  });

  it("指示器关键：溢出指示器点名滚动控件，而非过去不滚的键", () => {
    const snap = scrollableSpecSnapshot();
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch({ type: "drill", resource: "spec", name: "driver-agent" });
    const screen = syncLayout(s, snap, 100, 12);

    const indicator = screen.lines.find((l) => /\d+-\d+ \/ \d+/.test(l));
    expect(indicator).toBeDefined();
    expect(indicator).not.toContain("内容 ↑/↓");
    expect(indicator).toMatch(/滚动/);
  });

  it("回归守卫：topology 根上 Down 仍移动 explorer 树（非 spec 详情）", () => {
    const snap = demoSnapshot();
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = syncLayout(s, snap, 120, 32);
    const selectionBefore = s.get().selection;
    const offsetBefore = s.get().contentOffset;

    pressKey(s, snap, DOWN, screen);

    // topology 根：箭头导航 explorer，body 不滚动
    expect(s.get().selection).not.toBe(selectionBefore);
    expect(s.get().contentOffset).toBe(offsetBefore);
  });
});
