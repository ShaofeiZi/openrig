import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";

// TUI 滚动（ruling cfec754f Part 1）——经真实 store 的滚动契约证明。滚动
// 路径在构造上与视图无关（content-scroll reducer 只动 contentOffset/
// contentMaxOffset，绝不按 viewTab 分支），故这一次端到端证明该契约：
// top/bottom 命令到达真正极值，中间行可一次一行到达
//（行滚动，绝无翻页跳过 → 每行在某偏移可 grep；无分页保证）。
// 每视图接线（每个可滚视图填充 contentMaxOffset）由 render 套件覆盖；
// 枚举（table/overview/graph/topology/yaml/pulse）记于交接。

function store(contentMaxOffset: number) {
  const snap = emptySnapshot();
  const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
  s.dispatch({ type: "layout", contentMaxOffset, contentTargetCount: 0 });
  return s;
}

describe("滚动契约——top/bottom 到极端；中间行逐行可达", () => {
  it("`bottom` 钳到 contentMaxOffset（真底，非一页）", () => {
    const s = store(5);
    s.dispatch(parseCommand("bottom"));
    expect(s.get().contentOffset).toBe(5);
  });

  it("`top` 钳到 0（真顶）", () => {
    const s = store(5);
    s.dispatch(parseCommand("bottom"));
    s.dispatch(parseCommand("top"));
    expect(s.get().contentOffset).toBe(0);
  });

  it("wheel/arrow 一行增量逐行步进（无页跳→每个偏移可 grep）", () => {
    const s = store(3);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      s.dispatch({ type: "content-scroll", delta: 1 });
      seen.push(s.get().contentOffset);
    }
    expect(seen).toEqual([1, 2, 3]); // 0→1→2→3, every intermediate offset visited (no pagination jumps)
  });
});
