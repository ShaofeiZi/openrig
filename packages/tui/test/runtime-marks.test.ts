// S19 MR2——标记派生自 web 记录身份
//（RuntimeMark.tsx），绝不臆造：grid 数学钉在转写的 rect 列表上，
// 行标记钉在其精确单元格字符串上。
import { describe, it, expect } from "vitest";
import { clawdGrid, clawdFaithfulRows, clawdMiniA, clawdMiniB, codexMark, terminalMark, runtimeMarkSegs, markText } from "../src/topology/runtime-marks.js";

describe("clawd 网格 = RuntimeMark.tsx rect 列表", () => {
  it("身体、臂、腿、眼精确落在 SVG rect 指定处", () => {
    const g = clawdGrid();
    expect(g[2]!.slice(3, 13).every((p) => p === 1)).toBe(true); // body top row
    expect(g[6]![1]).toBe(1); // left arm
    expect(g[6]![14]).toBe(1); // right arm
    expect(g[11]![4]).toBe(1); // leg 1
    expect(g[11]![7]).toBe(1); // leg 2
    expect(g[11]![10]).toBe(1); // leg 3
    expect(g[4]![5]).toBe(2); // left eye (dark, over body)
    expect(g[5]![10]).toBe(2); // right eye
    expect(g[0]!.every((p) => p === 0)).toBe(true); // empty margin
    expect(g[15]!.every((p) => p === 0)).toBe(true);
  });

  it("忠实半块形态为 8 行 x 16 格，眼格带 eye token", () => {
    const rows = clawdFaithfulRows();
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row.reduce((n, s) => n + s.text.length, 0)).toBe(16);
    const flat = rows.flat();
    expect(flat.some((s) => s.token === "clawdEye")).toBe(true);
    expect(flat.some((s) => s.token === "clawd")).toBe(true);
  });
});

describe("行级 mark 族", () => {
  it("runtime → mark 映射：claude 族 = clawd 格，codex = >_，terminal = 暗 >_，unknown = 诚实 ?", () => {
    expect(markText(runtimeMarkSegs("claude-code"))).toBe("><"); // picks v4 amendment 14afeb74: inward squinty eyes (supersedes the round-4 quadrant pair)
    expect(markText(runtimeMarkSegs("codex"))).toBe(">_"); // the LOCKED web token
    expect(markText(runtimeMarkSegs("terminal"))).toBe(">_");
    expect(runtimeMarkSegs("terminal").every((s) => s.bg === "markBg")).toBe(true); // the dark-cell variant
    expect(markText(runtimeMarkSegs("something-else"))).toBe("?");
    expect(runtimeMarkSegs(null)[0]!.token).toBe("dim"); // honest, never fabricated
  });

  it("两个降采样候选都是网格降采样的输出（可证派生——guard finding 4）", async () => {
    const { clawdDownsample } = await import("../src/topology/runtime-marks.js");
    expect(clawdMiniA()).toEqual(clawdDownsample(2, 1)[0]);
    expect(clawdMiniB()).toEqual(clawdDownsample(3, 1)[0]);
    for (const mini of [clawdMiniA(), clawdMiniB()]) {
      expect(mini.length).toBeGreaterThanOrEqual(2);
      expect(mini.length).toBeLessThanOrEqual(3);
      expect(mini.every((s) => s.text === " " || (s.token === "clawd" && s.text.length === 1))).toBe(true);
    }
  });
});
