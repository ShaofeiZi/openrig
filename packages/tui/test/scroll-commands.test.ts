import { describe, it, expect } from "vitest";
import { parseCommand } from "../src/grammar.js";
import { VERB_TABLE } from "../src/commands/registry.js";

// TUI 滚动（ruling cfec754f Part 1）——:top / :bottom / :find 作为一等命令注册表条目
//（非 grammar 特例——P10 教训）。注册为动词（top/bottom/find），因为 ':' 是
// section-jump 前缀（dev50-planner 碰撞标志）：键入 ':top' 会解析为未知
// SECTION。top/bottom 复用 content-scroll（reducer 把极端 delta 钳到边界）；find
// 复用 filter action。registry parity 套件自动覆盖 listing/dump/palette/socket。

describe("滚动命令——top / bottom / find（registry 动词）", () => {
  it("`top` 滚到顶（content-scroll 被 reducer 钳到顶）", () => {
    const a = parseCommand("top");
    expect(a.type).toBe("content-scroll");
    expect((a as { delta: number }).delta).toBeLessThan(0);
  });

  it("`bottom` 滚到底（content-scroll 被 reducer 钳到 max）", () => {
    const a = parseCommand("bottom");
    expect(a.type).toBe("content-scroll");
    expect((a as { delta: number }).delta).toBeGreaterThan(0);
  });

  it("`find <text>` 按文本过滤行（与 / 前缀同动作）", () => {
    expect(parseCommand("find dev")).toEqual({ type: "filter", text: "dev" });
  });

  it("无文本的 `find` 是响亮错误（教学消息），绝非静默 no-op", () => {
    const a = parseCommand("find");
    expect(a.type).toBe("error");
    expect((a as { message: string }).message.toLowerCase()).toContain("find");
  });

  it("三者都注册在动词表（一等、可发现）", () => {
    expect(VERB_TABLE.has("top")).toBe(true);
    expect(VERB_TABLE.has("bottom")).toBe(true);
    expect(VERB_TABLE.has("find")).toBe(true);
  });
});
