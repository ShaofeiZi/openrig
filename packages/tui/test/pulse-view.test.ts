import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { resolveKeyAction } from "../src/input.js";
import { demoSnapshot } from "../src/demo-data.js";
import { demoPulseModel } from "../src/pulse/pulse-model.js";
import { renderPulseView, renderLanes } from "../src/pulse/render-pulse.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle } from "../src/theme.js";
import { strWidth } from "../src/text-width.js";
import type { InputEvent } from "../src/types.js";

const snap = demoSnapshot();
const withSnap = { getSnapshot: () => snap };
// 固定 reader 时钟，使 PARKED 空闲时长（派生自 demo 席的
// lastActivityAt）确定性渲染——demo guard 最后输出在 47 分钟前。
const DEMO_NOW = Date.parse("2026-08-06T12:00:00.000Z");

describe("PULSE 视图（5.2 Wave B——增量1：来自批准 mock 的静态骨架）", () => {
  it("把 `pulse` 注册为可达 viewTab（tab pulse + dispatch）", () => {
    expect(parseCommand("tab pulse")).toEqual({ type: "tab", tab: "pulse" });
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    expect(v.get().viewTab).toBe("pulse");
    // pulse 是顶层 VIEW MODE，非区段——区段不变
    expect(v.get().section).toBe("topology");
  });

  it("从快照 + 契约顺序渲染 LIVE 异常区段（增量2）", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW }).lines.join("\n");

    // ▲ NEEDS YOU ← demo attention 读取（subject 来自 summary）
    expect(body).toContain("▲ 需要你 (2)");
    expect(body).toContain("0.5.0 切割包就绪 · 等待你");
    expect(body).toContain("slice-20 路由像素 · 等待你");
    // ◌ PARKED WITH BATON ← LIVE join：demo in-progress qitem，其 owner
    // (dev50-guard) 空闲（terminalActive false）且未交接；空闲时长
    // 在 renderer 由席的 lastActivityAt 派生（DEMO_NOW 前 47 分钟）。
    expect(body).toContain("◌ 停驻待接力 (1)");
    expect(body).toContain("dev50-guard@openrig-build");
    expect(body).toContain("47 分钟空闲");
    expect(body).toContain("无交接");
    expect(body).not.toContain("idle-age read pending"); // placeholder gone — read is live
    // ⧗ BLOCKED ON AGENTS ← demo state=blocked 读取，人工阻塞项排除
    expect(body).toContain("⧗ 被智能体阻塞 (1)");
    expect(body).toContain("dev50-driver@openrig-build");
    // label==referent：阻塞 AGENT 被命名（解析的 blockerSession），非 qitem 指针
    expect(body).toContain("被 review-r1@openrig-build 阻塞");
    expect(body).not.toContain("qitem-20260805-review");
    expect(body).toContain("51209941 的终端裁决");
    expect(body).not.toContain("human sign-off pending"); // human-blocked → not here

    // 顺序 ▲ NEEDS YOU → ◌ PARKED → ⧗ BLOCKED → lanes 为契约
    const iNeeds = body.indexOf("需要你");
    const iParked = body.indexOf("停驻待接力");
    const iBlocked = body.indexOf("被智能体阻塞");
    const iLanes = body.indexOf("刚完成");
    expect(iNeeds).toBeGreaterThanOrEqual(0);
    expect(iNeeds).toBeLessThan(iParked);
    expect(iParked).toBeLessThan(iBlocked);
    expect(iBlocked).toBeLessThan(iLanes);
  });

  it("从 demo 快照构建三 lane + footer LIVE（label==referent 诚实）", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW }).lines.join("\n");

    // NOW ← 活动席（terminalActive true）⋈ 其 in-progress 工作：driver、
    // planner、r1、lead（guard 空闲 → PARKED；qa null → 排除）。lane
    // 显示紧凑 logicalId（incr-4 r1 ruling——drill-in 时恢复完整 session）；
    // 在此断言紧凑席 + 计数。
    expect(body).toContain("现在 (4)");
    expect(body).toContain("dev50.driver");
    expect(body).toContain("orch.lead");
    // JUST FINISHED ← done/已交接，最新完成在前（tsUpdated 降序）+ HH:MM
    expect(body).toContain("刚完成 (3)");
    expect(body).toContain("11:44");
    expect(body).toContain("slice-03 收尾");
    expect(body).toContain("终端 CLEAR");
    expect(body).not.toContain("14:02"); // the old static mock time is gone
    // UP NEXT ← 未认领 pending 按服务顺序；6 个 pending → cap-4 + "…"，计数 6
    expect(body).toContain("下一个 (6)");
    expect(body).toContain("RM 仪式");
    expect(body).toContain("51-02 场景运行器");
    expect(body).toContain("…"); // overflow marker (2 hidden pending)
    // FOOTER live：active=NOW(4) · parked=PARKED(1) · waiting-you=NEEDS YOU(2) · 2 秒前
    expect(body).toContain("4 激活 · 1 暂停 · 2 等待你 · 2 秒前更新");
    // 旧静态 lane 内容消失
    expect(body).not.toContain("slice 51-01 桩");
    expect(body).not.toContain("oversight.watch");
  });

  it("tab 条带 PULSE tab（顶层视图集）", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44 }).lines.join("\n");
    expect(body).toContain("PULSE");
  });

  it("全宽行保留 mock 的 3 列间距 + 规则计数后空格（r1 内边距发现）", () => {
    const lines = renderPulseView(demoPulseModel()).map((l) => l.text);

    // (a) JUST FINISHED → UP NEXT 间隔在 JF 内容填满列时绝不折叠
    //     （"✓ 14:02 slice-03 close-out" 恰为列宽）：
    //     mock 保留 3 空格间隔——"close-out   ○ 51-02"。
    const laneRow = lines.find((l) => l.includes("slice-03 收尾"));
    expect(laneRow).toBeDefined();
    expect(laneRow).toContain("○ 51-02 场景运行器");
    const upNextStart = laneRow!.indexOf("○ 51-02 场景运行器");
    expect(strWidth(laneRow!.slice(0, upNextStart))).toBe(62);

    // (b) 规则行在每个 "(n)" 后、破折号前保留空格：
    //     mock "── NOW (4) ───… JUST FINISHED (3) ───…"（先空格，再破折号）。
    const rule = lines.find((l) => l.includes("现在 (4)"));
    expect(rule).toBeDefined();
    expect(rule).toContain("现在 (4) ─");
    expect(rule).toContain("刚完成 (3) ─");
    expect(rule).not.toContain("现在 (4)─"); // no dash flush against the paren
  });

  it("live NOW 标签溢出时列对齐保持：以 … 截断，绝不挤动 JUST FINISHED 列（incr-3，真实数据宽度）", () => {
    const lanes: Parameters<typeof renderLanes>[0] = [
      { label: "现在", count: 1, rows: [{ glyph: "●", token: "ok", label: "dev50-driver@openrig-build  a very long piece of active work that would overflow the lane" }] },
      { label: "刚完成", count: 1, rows: [{ glyph: "✓", token: "ok", time: "11:44", label: "JFMARK" }] },
      { label: "下一个", count: 1, rows: [{ glyph: "○", token: "dim", label: "UPMARK" }] },
    ];
    const [row0] = renderLanes(lanes);
    // NOW 格截断到恰为 COL[0]（30）→ JF 列始于固定
    // 偏移（30 + 3 空格间隔 = 33），而非被向右推
    expect(row0!.text.indexOf("✓ 11:44 JFMARK")).toBe(33);
    expect(row0!.text.slice(0, 30)).toContain("…"); // 格内标记溢出
    expect(row0!.text).toContain("UPMARK");
    // 且完整活动工作文本不涂到相邻列
    expect(row0!.text).not.toContain("overflow the lane");
  });

  it("按列主序（NOW 优先）把 lane 单元格注册为内容目标，各带 drill 动作", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW });
    // demo NOW = driver/planner/r1/lead（4 活动）→ 前四个目标是
    // NOW 列（列优先）。driver 在 topology 解析 → agent drill。
    expect(s.contentTargets.length).toBeGreaterThanOrEqual(4);
    expect(s.contentTargets[0]!.action).toEqual({ type: "drill", resource: "agent", name: "dev50.driver", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    // JUST FINISHED 格（guard 的 close-out）drill 完成它的席
    const jf = s.contentTargets.find((t) => t.action.type === "drill" && t.action.name === "dev50.guard");
    expect(jf).toBeDefined();
  });

  it("↑↓ 移动 lane 选择，按单元格绘选中（非整个拉链行）", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    v.dispatch({ type: "focus", pane: "content" }); // in-pane: the lane cursor shows on the focused content pane
    const opts = { cols: 140, rows: 44, nowMs: DEMO_NOW };
    let s = renderScreen(v.get(), snap, opts);
    v.dispatch({ type: "layout", contentMaxOffset: s.contentMaxOffset, contentTargetCount: s.contentTargets.length });
    s = renderScreen(v.get(), snap, opts);

    // 默认选择（0）= 第一个 NOW 格；其行 accent 绘制，但
    // 仅 NOW 格——同一 zipped 行上的 JF/UP-NEXT 格不绘制，故
    // 该行同时带 accent 与非 accent seg（按格，非整行）。
    const y0 = s.contentTargets[0]!.y;
    const segs0 = s.segRows![y0]!;
    expect(segs0.some((sg) => sg.bg === "accent")).toBe(true);
    expect(segs0.some((sg) => sg.bg !== "accent")).toBe(true);

    // 下移一格：选择跟随到 target[1]，target[0] 的格清除。
    v.dispatch({ type: "content-select", delta: 1 });
    s = renderScreen(v.get(), snap, opts);
    const y1 = s.contentTargets[1]!.y;
    // 新选格绘制…
    expect(s.segRows![y1]!.some((sg) => sg.bg === "accent")).toBe(true);
    // …且若 target[1] 与 target[0] 在不同行，target[0] 清除。
    if (y1 !== y0) expect((s.segRows![y0] ?? []).some((sg) => sg.bg === "accent")).toBe(false);
  });

  it("选中 NOW 席按 Enter drill 到该 agent——离开 PULSE，恢复紧凑标签丢弃的完整身份", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    v.dispatch({ type: "focus", pane: "content" }); // Enter drills the focused content pane's selected cell
    let s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW });
    v.dispatch({ type: "layout", contentMaxOffset: s.contentMaxOffset, contentTargetCount: s.contentTargets.length });
    s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW });

    const enter: Extract<InputEvent, { type: "key" }> = { type: "key", key: "enter", action: { type: "activate" } };
    const action = resolveKeyAction(enter, v.get(), s, 0);
    expect(action).toEqual({ type: "drill", resource: "agent", name: "dev50.driver", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    // dispatch 它导航到 agent（完整详情），离开 pulse 视图
    v.dispatch(action!);
    expect(v.get().viewTab).toBe("table");
    expect(v.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.driver" });
  });

  it("PULSE 内（in-pane，founder Option-B）：←→ 切窗格（侧栏是 founder 动作路径），↑↓ 移动聚焦窗格——常规 chrome 输入，无特例", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    v.dispatch({ type: "focus", pane: "content" });
    const s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW });
    const down: Extract<InputEvent, { type: "key" }> = { type: "key", key: "down", action: { type: "select", delta: 1 } };
    const left: Extract<InputEvent, { type: "key" }> = { type: "key", key: "left", action: { type: "select", delta: 0 } };
    // content 聚焦时 ↑↓ 走 lane 格；← 切焦点到 explorer 侧栏
    expect(resolveKeyAction(down, v.get(), s, 0)).toEqual({ type: "content-select", delta: 1 });
    expect(resolveKeyAction(left, v.get(), s, 0)).toEqual({ type: "focus", pane: "explorer" });
  });

  it("渲染不抛错，可复用渲染器计数与模型一致", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    expect(() => renderScreen(v.get(), snap, { cols: 120, rows: 32 })).not.toThrow(); // default (table) still fine
    v.dispatch({ type: "tab", tab: "pulse" });
    expect(() => renderScreen(v.get(), snap, { cols: 120, rows: 32 })).not.toThrow();

    // 诚实底线：lane 头计数 == 模型携带的引用集
    const model = demoPulseModel();
    for (const lane of model.lanes) {
      // 注：mock 的 UP NEXT(5) 显示 4 行含 "…" 溢出行——
      // 头计数是真总数，行是渲染引用
      //（increment-1 fixture 精确镜像 mock，含溢出行）。
      expect(lane.rows.length).toBeGreaterThan(0);
    }
    expect(renderPulseView(model).length).toBeGreaterThan(10);
  });
});

// ── increment 5：live refresh-seam + motion 预算，对齐 founder 的
// Option-B 窗内布局。这些锚点断言 STYLIZED 终端输出（
// 此前每个 pulse 锚点跳过的层——它们检查 pre-stylize Screen，
// 故 paint no-op 漏过）。窗内按格 seg 经常规 split-pane 路径绘制；
// content 选择渲染为 accent-bg（mock `.sel` 提示），而侧栏自己的选中行用 inverse——
// 故 BG(48;2) 是干净的 content 选择信号，但 "无 inverse" 检查
// 限定到 content segRows（侧栏选择合法带 inverse）。 ─────────────────
describe("PULSE 视图（5.2 Wave B——增量5：live refresh 缝 + motion 预算，in-pane）", () => {
  const truecolor = createStyle("truecolor");
  const INV = /(?:\x1b\[|;)7(?:;|m)/; // a standalone inverse SGR param (7), not the "7" inside a color triple
  const BG = /48;2;/; // a truecolor background SGR
  const OPTS = { cols: 140, rows: 44, nowMs: DEMO_NOW, colorMode: "truecolor" as const };
  const agentKey = (a: Extract<InputEvent, never> | { type: string; name?: string; target?: { host: string; rig: string; pod: string } }): string =>
    `agent:${a.target!.host}/${a.target!.rig}/${a.target!.pod}/${a.name}`;
  // 仅 content inverse：闪烁的格 seg（segRows 是 content 半），
  // 排除左侧侧栏选中行 inverse 高亮
  const contentInverse = (s: ReturnType<typeof renderScreen>): boolean =>
    Object.values(s.segRows ?? {}).some((segs) => segs.some((g) => g.inverse));

  // 聚焦 content 窗格（lane 光标在那），稳定布局，然后
  // 重渲染——镜像进入循环
  function primed(selectMoves = 0, extra: Record<string, unknown> = {}) {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    v.dispatch({ type: "focus", pane: "content" });
    let s = renderScreen(v.get(), snap, { ...OPTS, ...extra });
    v.dispatch({ type: "layout", contentMaxOffset: s.contentMaxOffset, contentTargetCount: s.contentTargets.length });
    for (let i = 0; i < selectMoves; i++) v.dispatch({ type: "content-select", delta: 1 });
    s = renderScreen(v.get(), snap, { ...OPTS, ...extra });
    return { v, s };
  }

  it("F0：选中 NOW 单元格的强调背景在 stylized in-pane 输出中绘出（经常规分屏路径，非仅 pre-stylize Screen）", () => {
    const { s } = primed();
    const y0 = s.contentTargets[0]!.y;
    // pre-stylize Screen 自 incr-4 起就带 seg——此断言一直通过
    expect(s.segRows![y0]!.some((sg) => sg.bg === "accent")).toBe(true);
    // …现在它真渲染：窗内 content seg 经 split-pane
    // segRows 路径绘制（全宽 no-op 消失——bypass 不复存在）。
    const painted = stylizeLines(s, truecolor);
    expect(BG.test(painted[y0 - 1]!)).toBe(true);
  });

  it("F2：NOW 席窗口内新鲜输出闪烁只反色其单元格（按单元格），在 stylized 输出中渲染", () => {
    // 选行 1，使闪烁（在行 0）与选择绘制隔离
    const { v } = primed(1);
    const targets = renderScreen(v.get(), snap, OPTS).contentTargets;
    const driver = targets[0]!; // NOW row 0 = dev50.driver (unselected now)
    const key = agentKey(driver.action as never);
    const s = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW }] });
    const painted = stylizeLines(s, truecolor);
    const dy = driver.y;
    // 模型层按格：闪烁行同时带 inverse（NOW 格）
    // 与非 inverse（JF/UP-NEXT 兄弟 + 间隔）seg——非整行闪烁
    const segs = s.segRows![dy]!;
    expect(segs.some((sg) => sg.inverse)).toBe(true);
    expect(segs.some((sg) => !sg.inverse)).toBe(true);
    // …且它真渲染（此前锚点从未到达的层）
    expect(INV.test(painted[dy - 1]!)).toBe(true);
    // 选中格（行 1）accent 绘制但非 inverse——闪烁与
    // 选择视觉上不同，共存而不混淆
    const sy = s.contentTargets[1]!.y;
    expect(BG.test(painted[sy - 1]!)).toBe(true);
    expect(INV.test(painted[sy - 1]!)).toBe(false);
  });

  it("F2 预算：席在 JUST FINISHED（非 NOW）的闪烁不移动任何东西——motion 限定在 NOW live 更新区", () => {
    const { s: s0 } = primed();
    const jf = s0.contentTargets.find((t) => (t.action as { name?: string }).name === "dev50.guard"); // guard's close-out lives in JF
    expect(jf).toBeDefined();
    const key = agentKey(jf!.action as never);
    const { v } = primed();
    const s = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW }] });
    // 席键匹配，但仅 lane 0（NOW）闪烁 → 无 content 格 inverse
    expect(contentInverse(s)).toBe(false);
  });

  it("F2 窗口：过期闪烁（老于 600ms 窗口）不反色", () => {
    const { v } = primed(1);
    const driver = renderScreen(v.get(), snap, OPTS).contentTargets[0]!;
    const key = agentKey(driver.action as never);
    const s = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW - 700 }] });
    expect(contentInverse(s)).toBe(false);
  });

  it("F3 reduced-motion 孪生：reduced motion 下闪烁被抑制（无反色），席仍显示", () => {
    const prev = process.env["OPENRIG_REDUCED_MOTION"];
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    try {
      const { v } = primed(1);
      const driver = renderScreen(v.get(), snap, OPTS).contentTargets[0]!;
      const key = agentKey(driver.action as never);
      const s = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW }] });
      expect(contentInverse(s)).toBe(false); // no motion in the content pane
      expect(s.lines[driver.y - 1]!).toContain("dev50.driver"); // state still shown, honestly
      expect(s.motionActive).toBe(false); // reduced kills the redraw loop
    } finally {
      if (prev === undefined) delete process.env["OPENRIG_REDUCED_MOTION"];
      else process.env["OPENRIG_REDUCED_MOTION"] = prev;
    }
  });

  it("F1：活动 NOW 闪烁设 motionActive（有界过期重绘）；无闪烁的 settle 帧平静", () => {
    const { v } = primed(1);
    const driver = renderScreen(v.get(), snap, OPTS).contentTargets[0]!;
    const key = agentKey(driver.action as never);
    const hot = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW }] });
    expect(hot.motionActive).toBe(true);
    const calm = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [] });
    expect(calm.motionActive).toBe(false);
  });

  it("F1：首次加载 in-flight（未 settle）时显示诚实加载指示 + motionActive；settle 空帧平静", () => {
    const { v } = primed();
    const loading = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: true, settled: false } });
    const status = loading.lines[0];
    expect(status).toBeDefined();
    expect(status!.toLowerCase()).toContain("加载中");
    expect(loading.motionActive).toBe(true);
    const settled = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true } });
    const settledStatus = settled.lines.find((l) => l.startsWith("[t]"));
    expect(settledStatus!.toLowerCase()).not.toContain("加载中"); // empty-strip-is-calm
  });

  it("F3 读取时钟纪律：footer updated Ns ago + PARKED 空闲龄随读取时钟在同一快照上重推导（无缓存陈旧）", () => {
    const { v } = primed();
    const foot = (nowMs: number) => renderScreen(v.get(), snap, { ...OPTS, nowMs }).lines.find((l) => l.includes("激活 ·") && l.includes("更新"))!;
    const t0 = foot(DEMO_NOW);
    const t1 = foot(DEMO_NOW + 90_000);
    expect(t0).not.toEqual(t1); // the "updated Ns ago" advanced — the derivation is live, not stamped once
    expect(t1).toContain("更新");
  });
});

// P2——tab-strip 活动 "PULSE" 粗体 no-op。mock 把活动 tab（尾部
// PULSE）渲染为粗体，但其 seg 仅粗体（无 token），故 segRows 绘制器（仅当
// token||bg||inverse 才绘）把它降为纯文本——与 exception subject 同类。
// 按位点强调 token（不改 stylize.ts）。锚在 STYLIZED 层。
describe("PULSE 视图（5.2 Wave B）——tab 条活动 PULSE 渲染加粗 [P2]", () => {
  // 提取活动 BOLD SGR 下渲染的文本（1=开，0/22=关）
  function boldText(styled: string): string {
    let bold = false;
    let out = "";
    let i = 0;
    while (i < styled.length) {
      if (styled[i] === "\x1b" && styled[i + 1] === "[") {
        const m = styled.slice(i).match(/^\x1b\[([0-9;]*)m/);
        if (m) {
          for (const p of m[1]!.split(";").filter(Boolean).map(Number)) {
            if (p === 1) bold = true;
            else if (p === 0 || p === 22) bold = false;
          }
          i += m[0].length;
          continue;
        }
      }
      if (bold) out += styled[i];
      i += 1;
    }
    return out;
  }

  it("活动（尾随）PULSE tab 标签在 stylized 输出中渲染加粗", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const styled = stylizeLines(renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW, colorMode: "truecolor" }), createStyle("truecolor"));
    const tabLine = styled.find((l) => l.includes("表格") && l.includes("概览"))!;
    expect(tabLine).toBeDefined();
    // 尾部活动 "PULSE" 是粗体 token；"[ PULSE ]" 是 dim，非粗体
    expect(boldText(tabLine)).toContain("PULSE");
  });
});
