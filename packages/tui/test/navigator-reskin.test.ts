// Slice-17 mini-req 1——explorer navigator 重皮肤为文件树
// 美学。纯重皮肤：computeExplorerRows（唯一行模型）
// 不动；渲染器显示分支引导 + 右对齐 meta，而每个动作、键、命中目标
// 保持相同（PIN-1）。折叠字形
// 仅在今日真有折叠处渲染（pods、missions、spec
// 文件夹）——hosts、rigs、不可折叠 section 行去除虚假字形。
import { describe, it, expect } from "vitest";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";

const snap = demoSnapshot();

// 重定位卡锚点用的最小带 graph snapshot
function graphSnapLocal() {
  const graph = {
    nodes: [
      { id: "pod-G", type: "podGroup", data: { logicalId: "g", podNamespace: "g", runtime: null, model: null, status: null, nodeKind: "agent" as const, startupStatus: null, contextUsedPercentage: null } },
      { id: "nG", type: "rigNode", parentId: "pod-G", data: { logicalId: "g.driver", podNamespace: "g", runtime: "claude-code", model: null, status: "running", nodeKind: "agent" as const, startupStatus: "ready" as const, contextUsedPercentage: 24, agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: "g-driver@r" } },
    ],
    edges: [],
  };
  return {
    ...snap,
    hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "g", agents: [
      { name: "g.driver", runtime: "claude-code", spec: "", context: 24, tokens: null, status: "active", live: true },
    ] }], graph }] }],
  };
}

function makeStore() {
  return createViewState({ instanceId: "nav-test", getSnapshot: () => snap });
}

function explorerPane(lines: string[]): string[] {
  // 屏的第3行起，│ 窗格边框左侧（EXPL_W = 30）
  return lines.slice(2).map((l) => l.slice(0, 30));
}

describe("file-tree 重皮肤（Direction B navigator）", () => {
  it("在 explorer 窗格渲染连续分支引导线", () => {
    const s = makeStore();
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const pane = explorerPane(screen.lines).join("\n");
    expect(pane).toMatch(/┣━/);
    expect(pane).toMatch(/┗━/);
  });

  it("host 与 rig 不带折叠字形（无虚假可操作项——那里今天无折叠）", () => {
    const s = makeStore();
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const hostRow = explorerPane(screen.lines).find((l) => l.includes("vm-host"))!;
    const rigRow = explorerPane(screen.lines).find((l) => l.includes("openrig-build"))!;
    expect(hostRow).not.toMatch(/[▾▸]/);
    expect(rigRow).not.toMatch(/[▾▸]/);
  });

  it("pod 保留其真实折叠字形（› 折叠，⌄ 展开经 drill/auto-expand）", () => {
    const s = makeStore();
    let screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const collapsed = explorerPane(screen.lines).find((l) => l.includes("dev50"))!;
    expect(collapsed).toContain("›");
    // drill pod 自动展开——功能不变，外观重皮肤
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const pane = explorerPane(screen.lines);
    expect(pane.find((l) => l.includes("dev50") && !l.includes("●"))).toContain("⌄");
    // agent 行出现（身份按行模型键——显示名可能
    // 在锁定的 meta-恒在策略下截断）
    expect(screen.explorerRows.some((r) => r.key === "agent:vm-host/openrig-build/dev50/dev50.driver")).toBe(true);
  });

  it("agent meta 恒为锁定 `runtime · ctx%` 形式，名字按 pod 相对渲染（guard 裁决）", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const pane = explorerPane(renderScreen(s.get(), snap, { cols: 120, rows: 32 }).lines);
    // pod dev50 下的 dev50.driver 显示 pod 相对名 "driver"（
    // nav-flow 模型约定）；meta 保持完整
    const driver = pane.find((l) => l.trimEnd().endsWith(" 62%"))!;
    expect(driver).toBeDefined();
    // pod 相对名 "driver" 在 depth-4 几何下仍可能截断，但其
    // 可见词干是 agent 自己的名字，绝非共享 pod 前缀
    expect(driver).toMatch(/● driver/); // untruncated under the S19 mark meta
    expect(driver).not.toMatch(/dev50\.driver/); // full identity lives in the row model, not the display
  });

  it("同 pod 内 runtime+context 完全相同的 agent 仍可视觉区分（guard 碰撞复现）", () => {
    const twinSnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "dev50", agents: [
        { name: "dev50.driver", runtime: "codex", spec: "", context: 31, tokens: null, status: "active", live: true },
        { name: "dev50.guard", runtime: "codex", spec: "", context: 31, tokens: null, status: "active", live: true },
      ] }] }] }],
    };
    const s = createViewState({ instanceId: "nav-twin", getSnapshot: () => twinSnap });
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "h", rig: "r" } });
    const pane = explorerPane(renderScreen(s.get(), twinSnap, { cols: 120, rows: 32 }).lines);
    const agentRows = pane.filter((l) => /[●◐○✕] (driver|guard)/.test(l) && l.includes("31%")).map((l) => l.replace(/^./, " "));
    expect(agentRows).toHaveLength(2);
    expect(new Set(agentRows.map((l) => l.trim())).size).toBe(2); // visibly distinct rows
    expect(agentRows.some((l) => l.includes("driv"))).toBe(true);
    expect(agentRows.some((l) => l.includes("guar"))).toBe(true);
  });

  it("未带 pod 前缀的名字显示不变（诚实回退——仅确认前缀才剥离）", () => {
    const soloSnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "dev50", agents: [
        { name: "solo", runtime: "codex", spec: "", context: 7, tokens: null, status: "active", live: true },
      ] }] }] }],
    };
    const s = createViewState({ instanceId: "nav-solo", getSnapshot: () => soloSnap });
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "h", rig: "r" } });
    const row = explorerPane(renderScreen(s.get(), soloSnap, { cols: 120, rows: 32 }).lines).find((l) => l.includes("● solo"))!;
    expect(row.trimEnd()).toMatch(/● solo\s+7%$/); // round-3: bare ctx meta
  });

  it("null context 渲染诚实裸 —（round-3 explorer meta）", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const pane = explorerPane(renderScreen(s.get(), snap, { cols: 120, rows: 32 }).lines);
    expect(pane.some((l) => /qa/.test(l) && l.trimEnd().endsWith("—"))).toBe(true); // demo: dev50.qa ctx null → honest —
  });

  it("短名在 ctx meta 旁不截断渲染（round-3 形式）", () => {
    const shortSnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "p", agents: [
        { name: "ok", runtime: "claude-code", spec: "", context: 5, tokens: null, status: "active", live: true },
      ] }] }] }],
    };
    const s = createViewState({ instanceId: "nav-short", getSnapshot: () => shortSnap });
    s.dispatch({ type: "drill", resource: "pod", name: "p", target: { host: "h", rig: "r" } });
    const row = explorerPane(renderScreen(s.get(), shortSnap, { cols: 120, rows: 32 }).lines).find((l) => l.includes("● ok"))!;
    expect(row).not.toMatch(/…/);
    expect(row.trimEnd()).toMatch(/● ok\s+5%$/);
  });

  it("极端名字完整渲染——meta 全让步，身份绝不省略（guard NOT-CLEAR finding 1）", () => {
    const longSnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "p", agents: [
        { name: "an-extremely-long-agent-name-x", runtime: "codex", spec: "", context: 9, tokens: null, status: "active", live: true },
      ] }] }] }],
    };
    const s = createViewState({ instanceId: "nav-long", getSnapshot: () => longSnap });
    s.dispatch({ type: "drill", resource: "pod", name: "p", target: { host: "h", rig: "r" } });
    const row = explorerPane(renderScreen(s.get(), longSnap, { cols: 120, rows: 32 }).lines).find((l) => l.includes("● an-"))!;
    // 布局绝不截断：名字拿到每个可用格，
    // meta 完全让出；仅物理窗格边缘可裁剪（pad() 在最后列的
    // 诚实边界省略号——与宽度裁剪指示同类，非布局选择）
    expect(row).toContain("an-extremely-lon"); // every cell the pane physically offers
    expect(row).not.toMatch(/9%/); // the meta yielded — name-first
    expect(row.indexOf("…") === -1 || row.indexOf("…") === 29, "ellipsis only at the physical pane edge").toBe(true);
  });

  it("TERMINAL 标记在 topology 卡片上保留暗格背景（round-3：标记活在卡片上；bg 通道区分器随其迁移）", () => {
    const node = (id: string, name: string, runtime: string) => ({
      id, type: "rigNode", parentId: "pod-T",
      data: { logicalId: name, podNamespace: "t", runtime, model: null, status: "running",
        nodeKind: "agent" as const, startupStatus: "ready" as const, contextUsedPercentage: 10,
        agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: `${name}@r` },
    });
    const graph = {
      nodes: [
        { id: "pod-T", type: "podGroup", data: { logicalId: "t", podNamespace: "t", runtime: null, model: null, status: null, nodeKind: "agent" as const, startupStatus: null, contextUsedPercentage: null } },
        node("nT", "t.tty", "terminal"), node("nC", "t.cx", "codex"),
      ],
      edges: [],
    };
    const ttySnap = {
      ...snap,
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "t", agents: [
        { name: "t.tty", runtime: "terminal", spec: "", context: 10, tokens: null, status: "active", live: true },
        { name: "t.cx", runtime: "codex", spec: "", context: 10, tokens: null, status: "active", live: true },
      ] }], graph }] }],
    };
    const s = createViewState({ instanceId: "card-tty", getSnapshot: () => ttySnap });
    s.dispatch({ type: "drill", resource: "rig", name: "r", target: { host: "h" } });
    s.dispatch({ type: "tab", tab: "graph" });
    const screen = renderScreen(s.get(), ttySnap, { cols: 150, rows: 40 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const joined = styled.join("\n");
    expect(joined, "terminal card mark carries the dark bg").toMatch(/48;2;12;10;9[^m]*m>/);
    styled.forEach((line, j) => expect(stripAnsi(line), `line ${j}`).toBe(screen.lines[j]));
  });

  it("clawd 卡片标记经 seg 通道绘为 eye-on-terracotta（fg #181818 在 bg #ad6755）", () => {
    const s = createViewState({ instanceId: "card-clawd", getSnapshot: () => graphSnapLocal() });
    const host = graphSnapLocal().hosts[0]!;
    s.dispatch({ type: "drill", resource: "rig", name: host.rigs[0]!.name, target: { host: host.name } });
    s.dispatch({ type: "tab", tab: "graph" });
    const snap2 = graphSnapLocal();
    const screen = renderScreen(s.get(), snap2, { cols: 150, rows: 40 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const joined = styled.join("\n");
    expect(joined).toMatch(/38;2;24;24;24;48;2;173;103;85m></); // picks-v4 inward squinty eyes on the terracotta field
    styled.forEach((line, j) => expect(stripAnsi(line), `line ${j}`).toBe(screen.lines[j]));
  });

  it("展开的命名空间 spec 文件夹把子级渲染在更深一层，绝不同级（guard finding 2）", () => {
    const nsSnap = {
      ...snap,
      specs: [
        ...snap.specs,
        { name: "vault-specialist", kind: "agent" as const, runtime: "codex", namespace: "vault", usedByRigs: [] },
      ],
    };
    const s = createViewState({ instanceId: "nav-ns", getSnapshot: () => nsSnap });
    s.dispatch({ type: "jump", section: "specs" });
    s.dispatch({ type: "toggle-expand", key: "specs-kind:agent" });
    s.dispatch({ type: "toggle-expand", key: "folder:vault" });
    const screen = renderScreen(s.get(), nsSnap, { cols: 120, rows: 40 });
    const pane = explorerPane(screen.lines);
    const folder = pane.find((l) => l.includes("vault/"))!;
    const child = pane.find((l) => l.includes("vault-specialist"))!;
    const indentOf = (l: string) => (/^\s*(?:┃ )*/.exec(l)?.[0] ?? "").length + (l.match(/┣━|┗━/)?.index ?? 0);
    const branchCol = (l: string) => l.search(/┣━|┗━/);
    expect(branchCol(child)).toBeGreaterThan(branchCol(folder)); // child branch sits deeper
    void indentOf;
    // PIN-1 不动：子项动作仍是行模型的 spec drill
    const rows = computeExplorerRows(s.get(), nsSnap);
    const childRow = rows.find((r) => r.key === "spec:vault-specialist")!;
    expect(childRow.action).toEqual({ type: "drill", resource: "spec", name: "vault-specialist" });
  });

  it("pod 行把 agent 数右对齐（移出内联 label）", () => {
    const s = makeStore();
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const pod = explorerPane(screen.lines).find((l) => l.includes("dev50"))!;
    expect(pod.trimEnd()).toMatch(/3$/); // dev50 pod has 3 agents in the demo fixture
  });

  it("纯重皮肤：hit-map 的 explorer 动作恰为行模型动作（PIN-1 不动）", () => {
    const s = makeStore();
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const rows = computeExplorerRows(s.get(), snap);
    screen.explorerRows.forEach((rendered, i) => {
      expect(rendered.action).toEqual(rows[i]!.action);
      expect(rendered.key).toBe(rows[i]!.key);
    });
    // 点 rig 行仍 drill rig——同动作，同 reducer
    const rigTarget = screen.hitMap.find((h) => h.action.type === "drill" && h.action.resource === "rig");
    expect(rigTarget).toBeDefined();
    const after = s.dispatch(rigTarget!.action);
    expect(after.drill.map((d) => d.name)).toEqual(["vm-host", "openrig-build"]);
  });

  it("选择同步仍落在 drilled agent 上（重皮肤保留 auto-expand）", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.guard", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const rows = computeExplorerRows(s.get(), snap);
    expect(rows[s.get().selection]?.key).toBe("agent:vm-host/openrig-build/dev50/dev50.guard");
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    // 选中行是被 drill 的 agent（行模型身份）…
    const selectedRow = screen.explorerRows.find((r) => r.y === screen.lines.findIndex((l) => l.startsWith("▶")) + 1);
    expect(selectedRow?.key).toBe("agent:vm-host/openrig-build/dev50/dev50.guard");
    // …且该行显示 agent 的可见身份（pod 相对 "guard"）
    // 加其在边缘的锁定 meta（guard：可见身份恢复）
    const selectedLine = screen.lines.find((l) => l.startsWith("▶"))!;
    expect(selectedLine.slice(0, 30)).toMatch(/● guard/);
    expect(selectedLine.slice(0, 30).trimEnd()).toMatch(/31%$/); // demo: guard ctx 31 (round-3 bare meta)
  });

  it("G2 选择给整行选中 explorer 行明亮洗色", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.guard", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const i = screen.lines.findIndex((l) => l.startsWith("▶"));
    expect(i).toBeGreaterThan(0);
    const line = styled[i]!;
    expect(line).toMatch(/\x1b\[1;38;2;111;168;255;48;2;34;52;82m▶[^\x1b]*┣━[^\x1b]*● guard/);
    styled.forEach((l, j) => expect(stripAnsi(l), `line ${j}`).toBe(screen.lines[j]));
  });

  it("explorer agent 状态派生自 served 真相——编译输出中四态视觉区分（guard round-4 finding 4）", () => {
    // demo fixture 提供全部四个：driver active · guard idle · qa unknown
    //（live:false）· orch.lead needs-attention——无一可伪造活性
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    s.dispatch({ type: "drill", resource: "pod", name: "orch", target: { host: "vm-host", rig: "openrig-build" } });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 36 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const styledRow = (needle: string) => styled.find((l) => stripAnsi(l).slice(0, 30).includes(needle))!;
    const plainRow = (needle: string) => screen.lines.find((l) => l.slice(0, 30).includes(needle))!;
    // 诚实字形优先：unknown/offline qa 是 ○（绝不伪造 ●），
    // needs-attention lead 是 ◐——服务真值，非硬编码 ●
    expect(plainRow("driver").slice(0, 30)).toMatch(/● driver/);
    expect(plainRow("guard").slice(0, 30)).toMatch(/● guard/);
    expect(plainRow("qa").slice(0, 30)).toMatch(/○ qa/);
    expect(plainRow("lead").slice(0, 30)).toMatch(/◐ lead/);
    // 四个活动角色不同绘制（Substrate 值，truecolor）
    expect(styledRow("driver"), "active → actActive").toMatch(/38;2;152;195;121m●/);
    expect(styledRow("guard"), "idle → actIdle").toMatch(/38;2;110;142;170m●/);
    expect(styledRow("qa"), "unknown → actDetached (honest)").toMatch(/38;2;109;116;128m○/);
    expect(styledRow("lead"), "needs-attention → actAttention").toMatch(/38;2;230;181;110m◐/);
    styled.forEach((l, i) => expect(stripAnsi(l), `line ${i}`).toBe(screen.lines[i]));
  });

  it("stylize 在重皮肤标签上保持 strip 不变量", () => {
    const s = makeStore();
    s.dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } });
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    styled.forEach((line, i) => expect(stripAnsi(line), `line ${i}`).toBe(screen.lines[i]));
  });
});
