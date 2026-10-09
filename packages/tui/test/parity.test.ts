import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { decodeInput, sgrClick } from "../src/input.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { ViewState } from "../src/types.js";

// PIN 1：command / mouse / keyboard 都是同一 dispatch 之上的适配器。对等性
// 经每种输入到达相同状态来证明。

const snap = demoSnapshot();

function fresh(id: string) {
  return createViewState({ instanceId: id, getSnapshot: () => snap });
}

function comparable(state: ViewState) {
  const { instanceId: _i, sections: _s, history: _history, ...rest } = state;
  return rest;
}

describe("构造即对等（FR-7 / PIN 1）", () => {
  it("explorer 上命令 vs 鼠标点击到达相同状态", () => {
    const byCommand = fresh("cmd");
    const byMouse = fresh("ui");

    byCommand.dispatch(parseCommand(":specs"));

    const screen = renderScreen(byMouse.get(), snap, { cols: 100, rows: 30 });
    const target = screen.hitMap.find((h) => h.action.type === "jump" && h.action.section === "specs");
    expect(target).toBeDefined();
    const click = decodeInput(sgrClick(target!.x1, target!.y)).find((e) => e.type === "mouse");
    expect(click).toBeDefined();
    if (click?.type !== "mouse") throw new Error("unreachable");
    const hit = screen.hitMap.find((h) => h.y === click.y && click.x >= h.x1 && click.x <= h.x2);
    expect(hit).toBeDefined();
    byMouse.dispatch(hit!.action);

    expect(comparable(byMouse.get())).toEqual(comparable(byCommand.get()));
  });

  it("命令 vs 键盘（箭头+enter）到达相同状态", () => {
    const byCommand = fresh("cmd");
    const byKeys = fresh("kbd");

    byCommand.dispatch(parseCommand("rig openrig-build"));

    const screen = renderScreen(byKeys.get(), snap, { cols: 100, rows: 30 });
    const rigIndex = screen.explorerRows.findIndex((r) => r.action.type === "drill" && r.action.resource === "rig");
    expect(rigIndex).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < rigIndex; i++)
      for (const ev of decodeInput("\x1b[B"))
        if (ev.type === "key" && "action" in ev) byKeys.dispatch(ev.action);
    const enter = decodeInput("\r")[0];
    if (enter && enter.type === "key" && "action" in enter) byKeys.dispatch(enter.action);

    expect(comparable(byKeys.get())).toEqual(comparable(byCommand.get()));
  });

  it("以固定宽列与右对齐数字渲染 agents 表（honest-unknown 显示 —）", () => {
    const s = fresh("t");
    s.dispatch(parseCommand("rig openrig-build"));
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 30 });
    const header = screen.lines.find((l) => l.includes("席位") && l.includes("状态"));
    expect(header).toBeDefined();
    const rows = screen.lines.filter((l) => l.includes("终端 ▸") && /(工作中|空闲|需要你|未知)/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row).toMatch(/(?:\d+%[\u25aa▫]{3}|—)\s+(?:工作中|空闲|需要你|未知)/);
    }
  });

  it("STATUS 逐字取自快照——绝不伪造（PIN 2 渲染腿）", () => {
    const s = fresh("t");
    s.dispatch(parseCommand("rig openrig-build"));
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 30 });
    const qaRow = screen.lines.find((l) => /\? qa\s/.test(l));
    expect(qaRow).toBeDefined();
    expect(qaRow).toMatch(/未知/);
    const deadRow = screen.lines.find((l) => /\b(?:◐ )?lead\s/.test(l));
    expect(deadRow).toMatch(/需要你/);
  });
});
