import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { strWidth } from "../src/text-width.js";

// QA blocker 1：ACTIONS 必须是真实生命周期路径，非虚假 affordance。
// 两个动作映射到仅有的既有写契约（web 对等）：
// open-terminal → POST /api/terminal/open {view}；run → 每席 launch 路由。

const snap = demoSnapshot();

function drilledScreen() {
  const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
  s.dispatch(parseCommand("rig openrig-build"));
  return { store: s, screen: renderScreen(s.get(), snap, { cols: 140, rows: 32 }) };
}

function hitAt(screen: ReturnType<typeof renderScreen>, x: number, y: number) {
  return screen.hitMap.find((h) => h.y === y && x >= h.x1 && x <= h.x2);
}

function terminalColumnBefore(line: string, marker: string): number {
  const index = line.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  return strWidth(line.slice(0, index)) + 1;
}

describe("ACTIONS 列 = 真实驱动结构动作 (BR-9)", () => {
  it("运行中行仅提供 终端 ▸（无每席运行契约 → 不出现假运行入口）", () => {
    const { screen } = drilledScreen();
    const rowIdx = screen.lines.findIndex((l) => l.includes("┃ dev50") && l.includes("driver"));
    const row = screen.lines[rowIdx]!;
    expect(row).toMatch(/终端 ▸/);
    expect(row).not.toMatch(/运行 ▸/);
  });

  it("未运行行提供 运行 ▸，接到现有每席启动契约", () => {
    const { screen } = drilledScreen();
    const rowIdx = screen.lines.findIndex((l) => /\? qa\s/.test(l));
    const row = screen.lines[rowIdx]!;
    const x = terminalColumnBefore(row, "运行 ▸");
    const hit = hitAt(screen, x, rowIdx + 1);
    expect(hit?.action).toEqual({ type: "act", act: "run", rigId: "openrig-build", agent: "dev50.qa" });
  });

  it("终端 ▸ 区域派发该行 pod 的 open-terminal；点其他位置仍钻取", () => {
    const { screen } = drilledScreen();
    const rowIdx = screen.lines.findIndex((l) => /· guard\s/.test(l));
    const row = screen.lines[rowIdx]!;
    const termHit = hitAt(screen, terminalColumnBefore(row, "终端 ▸"), rowIdx + 1);
    expect(termHit?.action).toEqual({ type: "act", act: "open-terminal", view: "pod:openrig-build/dev50" });
    const cellHit = hitAt(screen, row.indexOf("gpt-5.6") + 1, rowIdx + 1);
    expect(cellHit?.action).toEqual({
      type: "drill",
      resource: "agent",
      name: "dev50.guard",
      target: { host: "vm-host", rig: "openrig-build", pod: "dev50" },
    });
  });

  it("act 绝不修改 view-state；结果以 notice 到达（PIN 1 保持）", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch(parseCommand("rig openrig-build"));
    const before = s.get();
    s.dispatch({ type: "act", act: "open-terminal", view: "pod:openrig-build/dev50" });
    expect(s.get()).toMatchObject({ section: before.section, drill: before.drill, selection: before.selection });
    s.dispatch({ type: "notice", message: "terminal opened: pod:dev50" });
    expect(s.get().notice).toBe("terminal opened: pod:dev50");
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 32 });
    expect(screen.lines.at(-1) ?? screen.lines.join("")).toBeDefined();
    expect(screen.lines.some((l) => l.includes("terminal opened: pod:dev50"))).toBe(true);
  });

  it("agent 详情逐字展示服务端 attach 命令与终端 act（web 对齐）", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch(parseCommand("agent dev50.driver"));
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 32 });
    expect(screen.lines.some((l) => l.includes("附加:"))).toBe(true);
    const termLine = screen.lines.findIndex((l) => l.includes("终端 ▸"));
    const hit = hitAt(screen, 40, termLine + 1);
    expect(hit?.action).toEqual({ type: "act", act: "open-terminal", view: "pod:openrig-build/dev50" });
  });

  it("grammar 不含 act 动词——act 仅为点击面；socket 保持 observe/navigate", () => {
    for (const cmd of ["run openrig-build", "term dev50", "up openrig-build", "open-terminal pod:dev50"]) {
      const parsed = parseCommand(cmd);
      // "run" 等不是资源/动词；非安全核心者皆为命名错误
      expect(parsed.type, cmd).toBe("error");
    }
  });

  it("跨 120 列回退边界仍保持 运行/终端 可见可点", () => {
    for (const cols of [120, 121]) {
      const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
      s.dispatch(parseCommand("rig openrig-build"));
      const screen = renderScreen(s.get(), snap, { cols, rows: 34 });
      const runningRow = screen.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"));
      const runnableRow = screen.lines.find((line) => /\? qa\s/.test(line));
      expect(runningRow, `running row at ${cols}`).toContain("终端 ▸");
      expect(runnableRow, `runnable row at ${cols}`).toContain("运行 ▸ · 终端 ▸");
      const acts = screen.contentTargets.filter((target) => target.action.type === "act");
      expect(acts.length, `act count at ${cols}`).toBeGreaterThan(0);
      expect(acts.every((target) => target.x1 >= 1 && target.x2 <= cols), `act bounds at ${cols}`).toBe(true);
      const runY = screen.lines.findIndex((line) => /\? qa\s/.test(line)) + 1;
      const runX = terminalColumnBefore(runnableRow!, "运行 ▸");
      expect(hitAt(screen, runX, runY)?.action).toEqual({ type: "act", act: "run", rigId: "openrig-build", agent: "dev50.qa" });
    }
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch(parseCommand("rig openrig-build"));
    const fallback = renderScreen(s.get(), snap, { cols: 119, rows: 34 }).lines.join("\n");
    expect(fallback).toContain("模型/当前/动作 在钻取时（回车）");
  });
});
