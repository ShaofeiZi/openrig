// S19 验证捕获原子——charter 携带的正向 explorer 缺席回归
//（planner 携带需求；QA 在 5348bb66 锁定范围清零后继项 1）：对 CLAUDE、CODEX、TERMINAL agent
// 行，explorer 必须在纯层与已编译 styled 流中都肯定证明
// 无 runtime-mark 字形、标记 token/背景 SGR 或拼写 runtime 词渲染。
// Round-3 founder 记录裁决：标记仅活于 AGENT-DETAIL + TOPOLOGY 卡。
//
// 每个缺席匹配器经对照阳性证明敏感：同一
// snapshot 的 agent-detail 页必恰含 explorer 行被要求缺少的
// 那个字形/SGR——一个匹配器永不触发的缺席断言不是回归锚点。
import { describe, it, expect } from "vitest";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import type { FleetSnapshot } from "../src/types.js";

// 名字刻意与任何 runtime 词不共享子串
const AGENTS = [
  { name: "alpha", runtime: "claude-code", status: "active" },
  { name: "beta", runtime: "codex", status: "idle" },
  { name: "gamma", runtime: "terminal", status: "unknown" },
] as const;

function snap(): FleetSnapshot {
  return {
    hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "p", agents: AGENTS.map((a) => ({
      name: a.name, runtime: a.runtime, spec: "", context: 12, tokens: null, status: a.status, live: true,
    })) }] }] }],
    specs: [], needs: [], humanQueueProbed: true, hostsDown: [], stream: [], readErrors: [],
  };
}

/** 标记身份 SGR 类（theme mark token、truecolor 精确值） */
const MARK_SGR = {
  clawdBodyBg: "48;2;173;103;85", // clawd terracotta field  #ad6755
  clawdBodyFg: "38;2;173;103;85", // clawd body ink (downsample forms)
  clawdEyeFg: "38;2;24;24;24", // clawd eyes             #181818
  terminalCellBg: "48;2;12;10;9", // terminal mark dark cell
  markInkFg: "38;2;250;250;249", // codex `>_` light ink
  codexBlueFg: "38;2;104;103;170", // OFFICIAL sampled       #6867aa
} as const;
const MARK_GLYPHS = /[▘▝▖▗▚▞▐▌█▀▄╹]|>_|></; // incl. the picks-v4 eyes pair
const RUNTIME_WORDS = /claude|codex|terminal|tty/i;

function explorerRowsFor(view: ReturnType<typeof createViewState>, s: FleetSnapshot) {
  const screen = renderScreen(view.get(), s, { cols: 140, rows: 34 });
  const styled = stylizeLines(screen, createStyle("truecolor"));
  styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i])); // strip-invariant holds throughout
  return AGENTS.map((a) => {
    const idx = screen.lines.findIndex((l) => l.includes(a.name));
    expect(idx, `explorer row for ${a.name}`).toBeGreaterThan(0);
    // 范围限定到 EXPLORER 格（窗格边框左侧）——content 窗格
    // 在 drill 页合法渲染标记
    const border = screen.lines[idx]!.indexOf("┃");
    return { agent: a, plain: screen.lines[idx]!.slice(0, border), styledFull: styled[idx]! };
  });
}

describe("POSITIVE explorer-absence 回归——claude/codex/terminal 行无 mark 字形、mark SGR 或 runtime 词", () => {
  const s = snap();
  const view = createViewState({ instanceId: "abs", getSnapshot: () => s });
  view.dispatch({ type: "drill", resource: "pod", name: "p", target: { host: "h", rig: "r" } }); // expands the pod → agent rows visible

  it("纯层：每个 runtime 的 agent 行无 mark 字形与拼写的 runtime 词", () => {
    for (const { agent, plain } of explorerRowsFor(view, s)) {
      expect(plain, `${agent.runtime} row plain glyphs`).not.toMatch(MARK_GLYPHS);
      expect(plain, `${agent.runtime} row runtime word`).not.toMatch(RUNTIME_WORDS);
    }
  });

  it("样式流：每个 runtime 的 agent 行无任何 mark token/背景 SGR 类", () => {
    for (const { agent, styledFull } of explorerRowsFor(view, s)) {
      for (const [cls, sgr] of Object.entries(MARK_SGR))
        expect(styledFull, `${agent.runtime} row ${cls}`).not.toContain(sgr);
    }
  });

  it("CONTROL-POSITIVE：同快照的 agent-detail 页确实渲染 explorer 缺失的每个 mark（匹配器灵敏度）", () => {
    const detail = (name: string): string => {
      const v = createViewState({ instanceId: `abs-${name}`, getSnapshot: () => s });
      v.dispatch({ type: "drill", resource: "agent", name, target: { host: "h", rig: "r", pod: "p" } });
      const screen = renderScreen(v.get(), s, { cols: 150, rows: 40 });
      return stylizeLines(screen, createStyle("truecolor")).join("\n");
    };
    const claude = detail("alpha");
    expect(claude).toMatch(/38;2;24;24;24;48;2;173;103;85m[^\x1b]*>/); // left inward eye (picks v4)
    expect(claude).toMatch(/38;2;24;24;24;48;2;173;103;85m[^\x1b]*</); // right inward eye
    expect(claude).toContain(MARK_SGR.clawdEyeFg);
    expect(claude).toContain(MARK_SGR.clawdBodyBg);
    const codex = detail("beta");
    expect(stripAnsi(codex)).toContain(">_"); // codex ASCII prompt mark
    expect(codex).toContain(MARK_SGR.markInkFg);
    expect(codex).toContain(MARK_SGR.codexBlueFg); // picks-v4 chevron hint on detail
    const term = detail("gamma");
    expect(stripAnsi(term)).toContain(">_");
    expect(term).toContain(MARK_SGR.terminalCellBg);
  });
});
