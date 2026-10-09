import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";
import type { FleetSnapshot } from "../src/types.js";

// 并行 polish 锚点：可见窗格焦点、content 选择条，以及
// content 库镜像 explorer 的文件夹分组。

const snap = demoSnapshot();

describe("活动窗格强调（k9s chrome）", () => {
  it("在顶规则中给聚焦窗格标题加括号", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    let screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    expect(screen.lines[1]).toContain("{ 资源管理器 }");
    expect(screen.lines[1]).not.toContain("{ 拓扑 }");
    s.dispatch(parseCommand("rig openrig-build"));
    s.dispatch({ type: "focus", pane: "content" });
    screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    expect(screen.lines[1]).toContain("{ 拓扑 }");
    expect(screen.lines[1]).not.toContain("{ 资源管理器 }");
  });
});

describe("content 选择条", () => {
  it("把聚焦 content 行渲染为反色高亮条（strip 不变量完整）", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch(parseCommand("rig openrig-build"));
    const pre = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    s.dispatch({ type: "layout", contentMaxOffset: pre.contentMaxOffset, contentTargetCount: pre.contentTargets.length });
    s.dispatch({ type: "focus", pane: "content" });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const barIndex = screen.lines.findIndex((l) => l.includes("┃›"));
    expect(barIndex).toBeGreaterThan(0);
    expect(styled[barIndex]).toContain("\x1b[1;38;2;111;168;255;48;2;34;52;82m›");
    for (let i = 0; i < styled.length; i++) expect(stripAnsi(styled[i]!)).toBe(screen.lines[i]!);
  });
});

describe("content 库镜像 explorer 分组", () => {
  const nsSnap: FleetSnapshot = {
    ...snap,
    specs: [
      { name: "rig-a", kind: "rig" },
      { name: "rev-1", kind: "agent", namespace: "review" },
      { name: "rev-2", kind: "agent", namespace: "review" },
    ],
  };

  it("在 content 窗格也折叠 agent 文件夹，遵守同一展开状态", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => nsSnap });
    s.dispatch(parseCommand(":specs"));
    s.dispatch({ type: "toggle-expand", key: "specs-kind:agent" });
    let lines = renderScreen(s.get(), nsSnap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(lines).toContain("review/ (2)");
    expect(lines).not.toContain("rev-1");
    s.dispatch({ type: "toggle-expand", key: "folder:review" });
    lines = renderScreen(s.get(), nsSnap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(lines).toContain("rev-1");
  });
});

describe("失焦窗格光标变暗（pm 批准的微调）", () => {
  it("explorer 聚焦时 explorer 条为强调色，content 聚焦时为暗反色", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch(parseCommand("rig openrig-build"));
    let styled = stylizeLines(renderScreen(s.get(), snap, { cols: 140, rows: 34 }), createStyle("truecolor"));
    expect(styled.join("\n")).toContain("\x1b[1;38;2;111;168;255;48;2;34;52;82m▶");
    const pre = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    s.dispatch({ type: "layout", contentMaxOffset: pre.contentMaxOffset, contentTargetCount: pre.contentTargets.length });
    s.dispatch({ type: "focus", pane: "content" });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    styled = stylizeLines(screen, createStyle("truecolor"));
    const barIndex = screen.lines.findIndex((l) => /^▶/.test(l));
    expect(styled[barIndex]).toContain("\x1b[38;2;109;116;128;48;2;34;52;82m");
    for (let i = 0; i < styled.length; i++) expect(stripAnsi(styled[i]!)).toBe(screen.lines[i]!);
  });
});

describe("截断读作省略号，绝不硬切词中", () => {
  it("用 … 截断长 explorer 标签与长单元格", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = renderScreen(s.get(), snap, { cols: 60, rows: 20 });
    const clipped = screen.lines.filter((l) => l.includes("…"));
    expect(clipped.length).toBeGreaterThan(0);
    for (const line of screen.lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});
