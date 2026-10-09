import { describe, it, expect } from "vitest";
import { parseCommand } from "../src/grammar.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";

// P10——topology-graph command-bar 命令（founder 捕获）。graph VIEW 已存在（按 rig，
// 无 graph 服务时诚实空）；此加一等 `graph` 命令以打开它 + 使其可发现，
// 并确认诚实降级轨（unavailable ⇒ 诚实消息，非静默 no-op）被呈现。

describe("parseCommand——`graph` 命令", () => {
  it("打开 graph 视图", () => {
    expect(parseCommand("graph")).toEqual({ type: "tab", tab: "graph" });
    expect(parseCommand("  graph  ")).toEqual({ type: "tab", tab: "graph" });
  });

  it("在命令列表中可被发现（unknown-command help 会点名它）", () => {
    const err = parseCommand("zzz");
    expect(err.type).toBe("error");
    expect((err as { message: string }).message).toContain("graph");
  });
});

describe("graph 视图——不可用时诚实降级（非静默 no-op）", () => {
  it("graph 在当前上下文不可用时显示诚实空态消息", () => {
    const snap = emptySnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand("graph")); // open the graph view via the command
    expect(view.get().viewTab).toBe("graph"); // the command opened the view — NOT a silent no-op
    const body = renderScreen(view.get(), snap, { cols: 120, rows: 32 }).lines.join("\n");
    // 诚实降级：每个 unavailable 态消息表明它是已证/诚实空，"非伪造"。
    expect(body).toContain("伪造");
  });
});
