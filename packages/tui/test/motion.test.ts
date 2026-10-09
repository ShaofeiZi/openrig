// ROUND-3 mr7——MOTION 设计语言机制（签收 = open item c；
// 这些锚点覆盖机制 + 纪律：处处 reduced-motion、
// 每区最多一个持久动画、诚实回退）。
import { describe, it, expect } from "vitest";
import { reducedMotion, spinnerFrame, flashActive, barCells } from "../src/motion.js";
import { computeExplorerRows, createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { demoSnapshot } from "../src/demo-data.js";

describe("motion 原语", () => {
  it("reducedMotion 遵守 env 终止开关", () => {
    expect(reducedMotion({ OPENRIG_REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotion({ REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotion({})).toBe(false);
  });

  it("spinner：truecolor/256 用 braille 帧，16-color 用 line 帧，reduced motion 下静态点", () => {
    expect(spinnerFrame(0, "truecolor", false)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(spinnerFrame(1, "truecolor", false)).not.toBe(spinnerFrame(0, "truecolor", false)); // animates
    expect(spinnerFrame(0, "16", false)).toMatch(/[|\/\-\\]/); // 16-color fallback
    expect(spinnerFrame(5, "truecolor", true)).toBe("·"); // reduced: static, honest
  });

  it("flashActive 一次性：窗口内 true，之后 false，reduced motion 下绝不为 true", () => {
    expect(flashActive(1000, 1300, 600, false)).toBe(true);
    expect(flashActive(1000, 1700, 600, false)).toBe(false);
    expect(flashActive(1000, 1300, 600, true)).toBe(false);
  });

  it("barCells 只渲染真实分数——null/NaN 不给条，绝不伪造填充", () => {
    expect(barCells(0.5, 10)).toBe("█████░░░░░");
    expect(barCells(0, 10)).toBe("░░░░░░░░░░");
    expect(barCells(1, 10)).toBe("██████████");
    expect(barCells(null, 10)).toBe("");
    expect(barCells(Number.NaN, 10)).toBe("");
  });
});

describe("motion 接线 + 区域纪律", () => {
  const snap = demoSnapshot();
  it("不可用 Attention 保持静态，不脉冲遗留运营信号", () => {
    const s = createViewState({ instanceId: "m", getSnapshot: () => snap });
    s.dispatch({ type: "jump", section: "needs" });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const body = styled.join("\n");
    expect(body).toContain("不可用: 待关注");
    expect(body).not.toContain("⚑");
    expect(body).not.toMatch(/\x1b\[(?:\d+;)*5(?:;\d+)*m/);
    expect(screen.motionActive).toBeFalsy();
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
  });

  it("详情上下文行对真实 ctx 分数显示安静确定条（未知时无）", () => {
    const s = createViewState({ instanceId: "m2", getSnapshot: () => snap });
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.driver", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toMatch(/62% 已用[^\n]*[█░]{10}/); // driver ctx 62 → a real bar
    const s2 = createViewState({ instanceId: "m3", getSnapshot: () => snap });
    s2.dispatch({ type: "drill", resource: "agent", name: "dev50.qa", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const body2 = renderScreen(s2.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body2).not.toMatch(/— \(尚未知\)[^\n]*█/); // no fabricated bar
  });

  it("输入保持命令焦点稳定，无终端相关闪烁", () => {
    const s = createViewState({ instanceId: "m4", getSnapshot: () => snap });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 }, "rig x");
    const styled = stylizeLines(screen, createStyle("truecolor"));
    expect((styled[0]!.match(/\[[0-9;]*5;[0-9;]*m|\[5m/g) ?? []).length).toBe(0);
    expect(screen.commandMotionActive).toBe(false);
  });
});

describe("motion 跟随加载生命周期——guard round-5 finding 1（spinner=真实 in-flight 状态，绝非数据缺失）", () => {
  const snap = demoSnapshot();
  const LOADING = { inFlight: true, settled: false } as const;
  function graphTabStore(base = snap) {
    const noGraph = structuredClone(base);
    const s = createViewState({ instanceId: "sp", getSnapshot: () => noGraph });
    s.dispatch({ type: "drill", resource: "rig", name: "openrig-build", target: { host: "vm-host" } });
    s.dispatch({ type: "tab", tab: "graph" });
    return { s, noGraph };
  }

  it("in-flight + 未应答 graph：spinner 渲染并动画，标记屏幕 motion-active", () => {
    const { s, noGraph } = graphTabStore();
    const at = (nowMs: number) =>
      renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs, colorMode: "truecolor", load: LOADING }).lines.find((l) => l.includes("读取挂起"))!;
    const f0 = at(0);
    const f1 = at(500);
    expect(f0).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 拓扑 读取挂起/);
    expect(f1).not.toBe(f0); // frame/time transition
    const screen = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING });
    expect(screen.motionActive).toBe(true); // the entry loop keeps redrawing while loading
  });

  it("settled 缺失不转：proven-empty 渲染静态诚实空行（默认选项=settled）", () => {
    const { s, noGraph } = graphTabStore();
    const screen = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    const line = screen.lines.find((l) => l.includes("未服务拓扑图"))!;
    expect(line).toMatch(/未服务拓扑图 — 诚实空/);
    expect(line).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏·] /);
    expect(screen.motionActive).toBeFalsy(); // nothing animates over settled truth
  });

  it("settled 具名读取失败不转：graph 行静态报告失败", () => {
    const { s, noGraph } = graphTabStore();
    noGraph.readErrors.push("graph(openrig-build): fetch failed");
    const screen = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    const line = screen.lines.find((l) => l.includes("拓扑图读取失败"))!;
    expect(line).toMatch(/✕ 拓扑图读取失败/);
    expect(line).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(screen.motionActive).toBeFalsy();
  });

  it("SPECS：in-flight 转，settled proven-empty 与 settled 具名失败静态渲染", () => {
    const empty = structuredClone(snap);
    empty.specs = [];
    const s = createViewState({ instanceId: "sl", getSnapshot: () => empty });
    s.dispatch({ type: "jump", section: "specs" });
    const loading = renderScreen(s.get(), empty, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING }).lines.join("\n");
    expect(loading).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 规范 读取挂起/);
    const settled = renderScreen(s.get(), empty, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    expect(settled.lines.join("\n")).toMatch(/库为空 — 已证明/);
    expect(settled.motionActive).toBeFalsy();
    empty.readErrors.push("specs-library: boom");
    const failed = renderScreen(s.get(), empty, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    expect(failed.lines.join("\n")).toMatch(/✕ 库读取失败/);
    expect(failed.motionActive).toBeFalsy();
  });

  it("Attention 源缺失在首次读取 settle 前为 pending", () => {
    const unprobed = { ...structuredClone(snap), humanQueueProbed: false, needs: [] };
    const s = createViewState({ instanceId: "hq", getSnapshot: () => unprobed });
    s.dispatch({ type: "jump", section: "needs" });
    const loading = renderScreen(s.get(), unprobed, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING }).lines.join("\n");
    expect(loading).toContain("待关注 读取挂起");
    expect(loading).not.toContain("不可用:");
    expect(loading).not.toContain("无当前项");
    const settled = renderScreen(s.get(), unprobed, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor" });
    const line = settled.lines.find((l) => l.includes("不可用: 待关注"))!;
    expect(line).toContain("源尚未应答");
    expect(line).not.toMatch(/读取挂起|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(settled.motionActive).toBeFalsy();
  });

  it("16-color in-flight 渲染 LINE spinner；reduced motion 渲染诚实静态点，无 motion-active", () => {
    const { s, noGraph } = graphTabStore();
    const line16 = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "16", load: LOADING }).lines.find((l) => l.includes("读取挂起"))!;
    expect(line16).toMatch(/[|/\-\\] 拓扑 读取挂起/);
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    try {
      const reduced = renderScreen(s.get(), noGraph, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING });
      expect(reduced.lines.find((l) => l.includes("读取挂起"))!).toMatch(/· 拓扑 读取挂起/);
      expect(reduced.motionActive).toBeFalsy();
    } finally {
      delete process.env["OPENRIG_REDUCED_MOTION"];
    }
  });

  it("Attention 自身源 pending 时只动画当前读取", () => {
    const probing = { ...structuredClone(snap), humanQueueProbed: false };
    const s = createViewState({ instanceId: "rd", getSnapshot: () => probing });
    s.dispatch({ type: "jump", section: "needs" });
    const screen = renderScreen(s.get(), probing, { cols: 140, rows: 34, nowMs: 0, colorMode: "truecolor", load: LOADING });
    expect(screen.lines.join("\n")).toContain("待关注 读取挂起");
    expect(screen.lines.join("\n")).not.toContain("不可用: 待关注");
    expect(screen.motionActive).toBe(true);
  });
});

describe("新鲜 pane-output 行闪烁——guard round-5 finding 2（确切 agent 行，绝非环境流 footer）", () => {
  const snap = demoSnapshot();
  const DRIVER_KEY = "agent:vm-host/openrig-build/dev50/dev50.driver";
  // inverse = 独立 SGR 参数 7（绝非 e.g. 77;189;178 里的那个 7）
  const INVERSE = /\x1b\[(?:[0-9;]+;)?7(?:;[0-9;]+)?m/;
  function agentRowsStore() {
    const s = createViewState({ instanceId: "fl", getSnapshot: () => snap });
    // drill pod 自动展开它——agent 行变为可见 explorer 行
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    return s;
  }

  it("窗口内闪烁恰好反色被闪 agent 的 explorer 行，并标 motion-active", () => {
    const s = agentRowsStore();
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1300, rowFlashes: [{ key: DRIVER_KEY, at: 1000 }] });
    expect(screen.flashRows).toHaveLength(1);
    const y = screen.flashRows![0]!;
    expect(screen.explorerRows.find((row) => row.y === y)?.key).toBe(DRIVER_KEY); // exact-row targeting
    // round-6（guard finding 2）：PLAIN 层也带稳定 ack 字形
    // ——事件在 NO_COLOR 下仍可观察，绝非仅 SGR
    expect(screen.lines[y - 1]!.startsWith("≈")).toBe(true);
    expect(screen.motionActive).toBe(true); // the expiry redraw is scheduled off this
    const styled = stylizeLines(screen, createStyle("truecolor"));
    expect(styled[y - 1]!, "flash = inverse video on the agent row").toMatch(INVERSE);
    const guardRow = screen.explorerRows.find((row) => row.key.endsWith("/dev50.guard"))!.y - 1;
    expect(styled[guardRow]!).not.toMatch(INVERSE); // sibling rows untouched
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
  });

  it("闪烁一次性：过窗口后反色与 ack 字形都消失", () => {
    const s = agentRowsStore();
    const after = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1700, rowFlashes: [{ key: DRIVER_KEY, at: 1000 }] });
    expect(after.flashRows ?? []).toHaveLength(0);
    // driver 自己的行恢复正常绘制（content 窗格选择条
    // 在他处合法用 inverse——把锚点限定到该行）
    const driverIdx = after.explorerRows.find((row) => row.key === DRIVER_KEY)!.y - 1;
    expect(stylizeLines(after, createStyle("truecolor"))[driverIdx]!).not.toMatch(INVERSE);
    expect(after.lines[driverIdx]!.startsWith("≈")).toBe(false); // the ack expires cleanly too
  });

  it("reduced motion 保持稳定静态新鲜输出确认——纯层字形，无 SGR 闪烁，无几何漂移（guard round-6 finding 2）", () => {
    const s = agentRowsStore();
    const base = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1300 }); // same frame, no event
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    try {
      const reduced = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1300, rowFlashes: [{ key: DRIVER_KEY, at: 1000 }] });
      expect(reduced.flashRows ?? []).toHaveLength(0); // no SGR animation under reduced motion…
      const y = reduced.explorerRows.find((row) => row.key === DRIVER_KEY)!.y - 1;
      expect(reduced.lines[y]!.startsWith("≈")).toBe(true); // …but the state SIGNAL survives as the stable marker-slot glyph
      expect(reduced.lines[y]!.length).toBe(base.lines[y]!.length); // no geometry drift
      expect(reduced.lines[y]!.slice(1)).toBe(base.lines[y]!.slice(1).replace(/[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/, "●")); // reduced motion also freezes the approved working mark
      expect(reduced.hitMap).toEqual(base.hitMap); // no hit-map drift
      expect(reduced.motionActive).toBe(true); // one bounded expiry redraw is scheduled — the ack settles cleanly
      // NO_COLOR：确认是字形/文本，绝非仅 SGR
      expect(stylizeLines(reduced, createStyle("none"))[y]!).toContain("≈");
      // reduced-motion 下同样过期
      const after = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1700, rowFlashes: [{ key: DRIVER_KEY, at: 1000 }] });
      expect(after.lines[y]!.startsWith("≈")).toBe(false);
      expect(after.motionActive).toBeFalsy();
    } finally {
      delete process.env["OPENRIG_REDUCED_MOTION"];
    }
  });

  it("选中 agent × 新鲜事件 × reduced motion：选择保持可见且 ack 为不同稳定信号；过期返回确切基线（guard round-7 碰撞矩阵）", () => {
    const s = agentRowsStore();
    const idx = computeExplorerRows(s.get(), snap).findIndex((r) => r.key === DRIVER_KEY);
    expect(idx).toBeGreaterThan(0);
    s.dispatch({ type: "select", index: idx, rowCount: computeExplorerRows(s.get(), snap).length });
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    try {
      const base = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1300 });
      const ev = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1300, rowFlashes: [{ key: DRIVER_KEY, at: 1000 }] });
      const y = ev.explorerRows.find((row) => row.key === DRIVER_KEY)!.y - 1;
      expect(base.lines[y]!.startsWith("▶")).toBe(true); // baseline: G2 selection cue
      expect(ev.lines[y]).not.toBe(base.lines[y]); // the event frame has a VISIBLE delta
      expect(ev.lines[y]!.startsWith("◆")).toBe(true); // selection-preserving fresh-output cue
      expect(ev.lines[y]!.slice(1)).toBe(base.lines[y]!.slice(1)); // ONLY the marker cell differs
      expect(ev.lines[y]!.length).toBe(base.lines[y]!.length); // no geometry drift
      expect(ev.hitMap).toEqual(base.hitMap); // no hit-map drift
      expect(stylizeLines(ev, createStyle("none"))[y]!).toContain("◆"); // NO_COLOR observable
      const after = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1700, rowFlashes: [{ key: DRIVER_KEY, at: 1000 }] });
      expect(after.lines[y]).toBe(base.lines[y]); // expiry returns EXACTLY to baseline
    } finally {
      delete process.env["OPENRIG_REDUCED_MOTION"];
    }
  });

  it("环境 rig-stream footer ticker 绝不反色闪烁（round-4 接线已拒绝：错误事件源）", () => {
    const s = createViewState({ instanceId: "ft", getSnapshot: () => snap }); // footer ticker is on by default
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34, nowMs: 1300 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const footerIdx = screen.lines.findIndex((l) => l.startsWith("≋"));
    expect(footerIdx).toBeGreaterThan(0); // the ticker still renders
    expect(styled[footerIdx]!).not.toMatch(INVERSE);
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
  });
});
