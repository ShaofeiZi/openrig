import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createStyle, stripAnsi, detectColorMode } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";

// Founder 视觉润色指令：styling 是零宽后处理。
// 承重不变量：每个视图每一行 stripAnsi(styled[i]) === plain[i]——
// 颜色绝不能移动命中目标、改变宽度或剪切
// 帧（稳定帧保证持续成立）。

const snap = demoSnapshot();

function screenFor(...commands: string[]) {
  const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
  for (const c of commands) s.dispatch(parseCommand(c));
  return renderScreen(s.get(), snap, { cols: 140, rows: 34 });
}

const VIEWS: Array<[string, string[]]> = [
  ["topology table", ["rig openrig-build"]],
  ["topology overview", ["rig openrig-build", "tab overview"]],
  ["agent detail", ["agent dev50.driver"]],
  ["specs library", [":specs"]],
  ["rig spec", ["spec openrig-build-rig"]],
  ["agent spec", ["spec driver-agent"]],
  ["needs", [":needs"]],
  ["cross-nav running", ["running driver-agent"]],
  ["filtered", ["rig openrig-build", "/dev50"]],
  ["named error", ["agent nobody.here"]],
];

describe("stylize 不变量：strip(styled) === plain，每视图、每模式", () => {
  for (const mode of ["truecolor", "256", "16"] as const) {
    it(`holds in ${mode} mode across all views`, () => {
      const style = createStyle(mode);
      for (const [name, commands] of VIEWS) {
        const screen = screenFor(...commands);
        const styled = stylizeLines(screen, style);
        expect(styled.length, name).toBe(screen.lines.length);
        for (let i = 0; i < styled.length; i++) {
          expect(stripAnsi(styled[i]!), `${name} line ${i + 1} (${mode})`).toBe(screen.lines[i]!);
        }
      }
    });
  }

  it("none 模式原样返回纯行（NO_COLOR 诚实）", () => {
    const screen = screenFor("rig openrig-build");
    expect(stylizeLines(screen, createStyle("none"))).toEqual(screen.lines);
  });
});

describe("treatment（mockup 调色板语义）", () => {
  const style = createStyle("truecolor");

  it("按语义给 STATUS 着色：active=ok-green，needs-attention=amber，unknown=dim", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), style).join("\n");
    expect(styled).toContain("\x1b[38;2;152;195;121m工作中\x1b[0m");
    expect(styled).toContain("\x1b[38;2;244;190;92m需要你\x1b[0m");
    expect(styled).toContain("\x1b[38;2;109;116;128m未知\x1b[0m");
  });

  it("把选择绘为反色强调条（可见高亮，非仅字形）", () => {
    const styled = stylizeLines(screenFor(), style);
    const bar = styled.find((l) => l.includes("\x1b[1;38;2;111;168;255;48;2;34;52;82m"));
    expect(bar).toBeDefined();
    expect(stripAnsi(bar!)).toMatch(/^▶/);
  });

  it("链接/动作获 G2 强调色（term ▸、open ▸、tabs）", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), style).join("\n");
    expect(styled).toContain("\x1b[1;38;2;111;168;255m终端 ▸\x1b[0m");
  });

  it("Attention 样式保留不可用真相，无遗留 fleet 告警", () => {
    const styled = stylizeLines(screenFor(":needs"), style).join("\n");
    expect(stripAnsi(styled)).toContain("不可用: 待关注");
    expect(stripAnsi(styled)).not.toContain("✖ remote-host");
    expect(styled).not.toMatch(/\x1b\[5;38;2;244;190;92m⚑/);
  });

  it("chrome 规则带窗格标题；提示条与状态行被样式化", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), style);
    expect(stripAnsi(styled[1]!)).toMatch(/资源管理器.*╋.*拓扑/);
    const hint = styled.find((l) => stripAnsi(l).includes("q 退出"));
    expect(hint).toBeDefined();
    expect(hint).toContain("\x1b[");
  });

  it("16 色模式仅发基础 SGR（无 38;2 / 38;5）——合理降级", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), createStyle("16")).join("\n");
    expect(styled).not.toContain("38;2;");
    expect(styled).not.toContain("38;5;");
    expect(styled).toContain("\x1b[");
  });

  it("256 模式用 38;5 索引色", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), createStyle("256")).join("\n");
    expect(styled).toContain("38;5;");
    expect(styled).not.toContain("38;2;");
  });
});

describe("颜色模式检测", () => {
  it("遵守 NO_COLOR、哑终端、COLORTERM 与 256color TERM", () => {
    expect(detectColorMode({ NO_COLOR: "1", TERM: "xterm-256color" })).toBe("none");
    expect(detectColorMode({ TERM: "dumb" })).toBe("none");
    expect(detectColorMode({ TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectColorMode({ TERM: "xterm-256color" })).toBe("256");
    expect(detectColorMode({ TERM: "xterm" })).toBe("16");
  });
});
