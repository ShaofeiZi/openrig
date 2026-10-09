// REGISTRY I3（ruling 64f1dbdf）——基于同一注册表的 fuzzy 命令面板。
// PM 锚点：别名在 fuzzy 查找中一等（pin 5）；context-unavailable 行渲染为
// 带原因的 dim，绝不隐藏；palette-execute == 直接命令字节相等
//（执行经 parseCommand -> dispatch 路由，BR-9 单路径）。
import { describe, it, expect } from "vitest";
import { filterPalette, paletteExecuteLine, type PaletteRow } from "../src/commands/palette.js";
import { COMMAND_REGISTRY, type CommandEntry } from "../src/commands/registry.js";
import { parseCommand } from "../src/grammar.js";

describe("命令面板 (I3)", () => {
  it("模糊匹配把 ALIAS 命中当一等：查询 'g' 把 graph 排到顶", () => {
    const rows = filterPalette("g", COMMAND_REGISTRY, "standard");
    expect(rows[0]!.entry.name).toBe("graph"); // via the real alias 'g'
  });

  it("空查询列出每一条 entry（浏览场景）", () => {
    const rows = filterPalette("", COMMAND_REGISTRY, "standard");
    expect(rows.length).toBe(COMMAND_REGISTRY.length);
  });

  it("上下文不可用的 entry 渲染为带原因的暗色，绝不隐藏", () => {
    const foreign = { name: "restore-everything", aliases: [], args: "", description: "crash-cart primary",
      context: "crash-cart", sample: "restore-everything" } as unknown as CommandEntry;
    const rows = filterPalette("restore", [...COMMAND_REGISTRY, foreign], "standard");
    const row = rows.find((r: PaletteRow) => r.entry.name === "restore-everything");
    expect(row).toBeDefined(); // never hidden
    expect(row!.available).toBe(false);
    expect(row!.reason).toMatch(/crash-cart/); // the reason names the required context
  });

  it("'always' entry 在任何上下文都可用", () => {
    const always = { name: "x-always", aliases: [], args: "", description: "d", context: "always", sample: "x-always" } as CommandEntry;
    const rows = filterPalette("x-always", [always], "crash-cart");
    expect(rows[0]!.available).toBe(true);
  });

  it("palette-execute 与直接打字逐字节相同：execute 行解析为同一 action", () => {
    const graph = COMMAND_REGISTRY.find((e) => e.name === "graph")!;
    const line = paletteExecuteLine(graph);
    expect(line.mode).toBe("execute"); // argless -> executes
    expect(parseCommand(line.line)).toEqual(parseCommand("graph")); // the SAME parse, same bytes
  });

  it("带参 entry 预填命令栏，而非盲执行", () => {
    const style = COMMAND_REGISTRY.find((e) => e.name === "style")!;
    const line = paletteExecuteLine(style);
    expect(line.mode).toBe("prefill");
    expect(line.line).toBe("style ");
  });
});

// 状态机腿（dispatch 跟随，PIN：palette 状态仅经 dispatch 变更）
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";

describe("palette 状态随 dispatch (I3)", () => {
  it("help/? 经 grammar 打开；query/move/close 迁移；execute 路径逐字节解析一致", () => {
    const view = createViewState({ instanceId: "t", getSnapshot: () => demoSnapshot() });
    view.dispatch(parseCommand("?"));
    expect(view.get().palette).toEqual({ query: "", selection: 0 });
    view.dispatch({ type: "palette-query", query: "g" });
    expect(view.get().palette!.query).toBe("g");
    view.dispatch({ type: "palette-move", delta: 1 });
    expect(view.get().palette!.selection).toBe(1);
    view.dispatch({ type: "palette-close" });
    expect(view.get().palette).toBeNull();
    // 状态层字节相等证明：经 palette 行执行 graph 与键入它
    const a = createViewState({ instanceId: "a", getSnapshot: () => demoSnapshot() });
    const b = createViewState({ instanceId: "b", getSnapshot: () => demoSnapshot() });
    a.dispatch(parseCommand(paletteExecuteLine(COMMAND_REGISTRY.find((e) => e.name === "graph")!).line));
    b.dispatch(parseCommand("graph"));
    expect(a.get().viewTab).toBe(b.get().viewTab);
  });
});
