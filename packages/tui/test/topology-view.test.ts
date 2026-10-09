// Slice-17 TOPOLOGY 腿 Phase 1——hatchet graph 视图移植到
// 已发布 shell：一个 view-state、一个 reducer、已发布 renderScreen/
// stylize/hit-map（PIN-1 在真实路径，非 spike store）。新文件；
// 已发布底线不动。
import { describe, it, expect } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";
import { demoSnapshot } from "../src/demo-data.js";
import { spikeFixtureGraph, FIXTURE_RIG_NAME } from "../src/topology/fixture.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { DaemonClient } from "../src/daemon-client.js";
import type { FleetSnapshot } from "../src/types.js";
import { dropW, strWidth } from "../src/text-width.js";

/** 带全词汇 graph 挂到 rig 的 demo shell snapshot——
 * graph 骑 RigNode.graph，从既有 /graph 读水合 */
function graphSnap(): FleetSnapshot {
  const snap = demoSnapshot();
  const graph = spikeFixtureGraph();
  // snapshot pod 树镜像 graph 的 agents，使 drill 目标可解析
  //（PIN-1 dispatch 对渲染器所绘的同一 snapshot 校验）
  const agentRow = (name: string, runtime: string, context: number | null) =>
    ({ name, runtime, spec: "", context, tokens: null, status: "active", live: true });
  return {
    ...snap,
    hosts: [{
      name: "vm-host",
      reachable: true,
      rigs: [{
        name: FIXTURE_RIG_NAME,
        hasLiveAgents: true,
        pods: [
          { name: "orch", agents: [agentRow("orch.lead", "claude-code", 18)] },
          { name: "dev", agents: [agentRow("dev.driver", "claude-code", 24), agentRow("dev.qa", "codex", 63)] },
          { name: "review", agents: [agentRow("review.r1", "codex", null), agentRow("review.validator", "codex", null)] },
        ],
        graph,
      }],
    }],
  };
}

function makeStore(snap: FleetSnapshot) {
  const view = createViewState({ instanceId: "topo-test", getSnapshot: () => snap });
  view.dispatch({ type: "drill", resource: "rig", name: snap.hosts[0]!.rigs[0]!.name, target: { host: snap.hosts[0]!.name } });
  return view;
}

describe("graph 视图可达性（既有导航，增量扩展）", () => {
  it("`tab graph` 可解析且 topology 区段接受它", () => {
    expect(parseCommand("tab graph")).toEqual({ type: "tab", tab: "graph" });
    const s = makeStore(graphSnap());
    const state = s.dispatch({ type: "tab", tab: "graph" });
    expect(state.viewTab).toBe("graph");
    expect(state.lastError).toBeNull();
  });

  it("默认 graph 样式为 HATCHET（founder flip 2026-08-04：字体依赖=脆弱），braille 一键可达", () => {
    const s = makeStore(graphSnap());
    expect(s.get().graphStyle).toBe("hatchet");
    // 双向都活：braille 可达，且返回
    expect(s.dispatch(parseCommand("style braille")).graphStyle).toBe("braille");
    expect(s.dispatch(parseCommand("style hatchet")).graphStyle).toBe("hatchet");
  });

  it("`style braille` 走命令栏；未知样式是命名错误", () => {
    expect(parseCommand("style braille")).toEqual({ type: "style", name: "braille" });
    const s = makeStore(graphSnap());
    expect(s.dispatch({ type: "style", name: "braille" }).graphStyle).toBe("braille");
    expect(s.dispatch({ type: "style", name: "hatchet" }).graphStyle).toBe("hatchet");
    const err = s.dispatch(parseCommand("style cubist"));
    expect(err.lastError).toMatch(/未知样式/);
    expect(err.graphStyle).toBe("hatchet"); // unchanged on error
  });

  it("graph tab 渲染在 topology tab 条且可点击到达", () => {
    const s = makeStore(graphSnap());
    const screen = renderScreen(s.get(), graphSnap(), { cols: 150, rows: 40 });
    expect(screen.lines.join("\n")).toContain("图");
    const tabTarget = screen.hitMap.find((t) => t.action.type === "tab" && t.action.tab === "graph");
    expect(tabTarget).toBeDefined();
  });
});

describe("发布 content 窗格中的 hatchet 主线（frame-01 视觉契约）", () => {
  function graphScreen(style?: string) {
    const snap = graphSnap();
    const s = makeStore(snap);
    if (style) s.dispatch({ type: "style", name: style });
    s.dispatch({ type: "tab", tab: "graph" });
    return { s, snap, screen: renderScreen(s.get(), snap, { cols: 150, rows: 40 }) };
  }

  it("在 rig 的 graph 投影上渲染带 node 内信息的方框节点", () => {
    const { screen } = graphScreen();
    const body = screen.lines.join("\n");
    expect(body).toMatch(/┌─+┐/);
    expect(body).toContain("● lead"); // member-only title (S19 MR1)
    expect(body).toContain(">< 18%"); // picks v4 (14afeb74): inward squinty eyes + adjacent ctx
    // 直线连接线 + 箭头；在锁定 containment 下，边可合法
    // 穿过 pod 容器墙（─ 在交叉处变 ┼），在其箭头之前
    expect(body).toMatch(/[─┼]+▸/);
    expect(body).not.toMatch(/delegates_to|collaborates_with|escalates_to/); // NO edge labels
  });

  it("诚实未知 ○ 在发布 graph 视图渲染（绝不伪造 ●）", () => {
    const { screen } = graphScreen();
    expect(screen.lines.join("\n")).toContain("○ r1"); // member-only (S19 MR1)
    expect(screen.lines.join("\n")).toContain("✕ validator");
    expect(screen.lines.join("\n")).toMatch(/◐ qa/);
  });

  it("braille 样式渲染子格边；braille 回退降级为 box-drawing", () => {
    const braille = graphScreen("braille").screen.lines.join("\n");
    expect(braille).toMatch(/[⠁-⣿]/);
    const fallback = graphScreen("braille-fallback").screen.lines.join("\n");
    expect(fallback).not.toMatch(/[⠁-⣿]/);
    expect(fallback).toMatch(/[─┼]+▸/);
  });

  it("无 hydrated graph 的 rig 渲染诚实空，绝不伪造方框", () => {
    const snap = graphSnap();
    delete (snap.hosts[0]!.rigs[0]! as { graph?: unknown }).graph;
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toMatch(/拓扑图读取挂起|诚实空/);
    expect(body).not.toMatch(/┌─+┐/);
  });

  it("edge 种类经发布 stylize 按线色绘（strip 不变量完整）", () => {
    const { screen } = graphScreen();
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const joined = styled.join("\n");
    expect(joined).toMatch(/\x1b\[38;2;111;168;255m[^\x1b]*─/); // G2 blue delegates run
    expect(joined).toMatch(/\x1b\[38;2;244;190;92m[^\x1b]*[─│┘└▴]/); // G2 amber escalate run
    styled.forEach((line, i) => expect(stripAnsi(line), `line ${i}`).toBe(screen.lines[i]));
  });
});

describe("发布路径上的 PIN-1——点击 === 键盘，单 store、单 reducer", () => {
  it("点 agent 节点框 drill 到该 agent；命令路径落到相同状态与屏幕", () => {
    const snap = graphSnap();
    const s1 = makeStore(snap);
    s1.dispatch({ type: "tab", tab: "graph" });
    const screen = renderScreen(s1.get(), snap, { cols: 150, rows: 40 });
    const target = screen.contentTargets.find(
      (t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa",
    );
    expect(target, "hit target for dev.qa in the shipped hit-map").toBeDefined();
    const clicked = s1.dispatch(target!.action);
    expect(clicked.drill).toEqual([
      { kind: "host", name: "vm-host" },
      { kind: "rig", name: FIXTURE_RIG_NAME },
      { kind: "pod", name: "dev" },
      { kind: "agent", name: "dev.qa" },
    ]);

    const s2 = makeStore(snap);
    s2.dispatch({ type: "tab", tab: "graph" });
    const byCommand = s2.dispatch(parseCommand("agent vm-host/openrig-build/dev/dev.qa"));
    expect(byCommand.drill).toEqual(clicked.drill);
    // 字节相同的渲染屏——在已发布渲染器上对等
    const a = renderScreen(clicked, snap, { cols: 150, rows: 40 }).lines;
    const b = renderScreen(byCommand, snap, { cols: 150, rows: 40 }).lines;
    expect(a).toEqual(b);
  });
});

describe("hydrate 消费已声明的 /graph 读取（R7——无新数据）", () => {
  it("从 client.rigGraph 填充 RigNode.graph；graph 读取失败是命名错误，视图诚实空", async () => {
    const graph = spikeFixtureGraph();
    const routes: Record<string, unknown> = {
      "/api/rigs/summary": [{ id: "r1", name: "openrig-build" }],
      "/api/rigs/r1/nodes": [],
      "/api/rigs/r1/graph": graph,
      "/api/rigs/r1/spec.json": {},
      "/api/specs/library": [],
      "/api/review/fleet": { needsYou: { items: [] }, hosts: [] },
      "/api/stream/list?limit=5": [],
    };
    const client = new DaemonClient({
      fetchImpl: (async (url: string) => {
        const route = url.replace(/^http[^/]*\/\/[^/]+/, "");
        for (const [k, v] of Object.entries(routes)) if (route.startsWith(k.split("?")[0]!)) return { ok: true, json: async () => v };
        return { ok: false, status: 404, json: async () => ({}) };
      }) as unknown as typeof fetch,
    });
    const snap = await hydrateSnapshot(client);
    expect(snap.hosts[0]!.rigs[0]!.graph?.nodes.length).toBe(graph.nodes.length);

    delete routes["/api/rigs/r1/graph"];
    const snap2 = await hydrateSnapshot(client);
    expect(snap2.hosts[0]!.rigs[0]!.graph).toBeUndefined();
    expect(snap2.readErrors.join("\n")).toMatch(/graph/);
  });
});

describe("fixture 门控（--demo 规则）", () => {
  it("无 live 模块 import fixture——仅测试与 spike 工具触达它", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = join(__dirname, "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith("fixture.ts") && readFileSync(p, "utf-8").match(/from "\.[./]*\/?(topology\/)?fixture\.js"/))
          offenders.push(p);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe("方框不透明度是类不变量，非绘制顺序产物（pm 驳回，planner 精化）", () => {
  // 三个 rank 在一行：a → b → c 经委派；a-collaborates-c 给出一条
  // 直的同行走廊，必须穿过 b 的框——框在两种风格下都字节干净
  //（pm 证伪的 braille 回归是顺序依赖：hatchet 先画边遮蔽它，braille 先画框渗色）
  function crossingGraph() {
    const node = (id: string, name: string) => ({
      id,
      type: "rigNode",
      parentId: "pod-X",
      data: {
        logicalId: name, podNamespace: "p", runtime: "codex", model: null,
        status: "running", nodeKind: "agent" as const, startupStatus: "ready" as const,
        contextUsedPercentage: 10, agentActivity: { state: "running" }, terminalActive: true,
        canonicalSessionName: `${name}@r`,
      },
    });
    return {
      nodes: [
        { id: "pod-X", type: "podGroup", data: { logicalId: "p", podNamespace: "p", runtime: null, model: null, status: null, nodeKind: "agent" as const, startupStatus: null, contextUsedPercentage: null } },
        node("nA", "aa.left"), node("nB", "bb.mid"), node("nC", "cc.right"),
      ],
      edges: [
        { id: "e1", source: "nA", target: "nB", label: "delegates_to" },
        { id: "e2", source: "nB", target: "nC", label: "delegates_to" },
        { id: "e3", source: "nA", target: "nC", label: "collaborates_with" },
      ],
    };
  }

  it("穿过中间框的 edge 走廊绝不绘入其内——hatchet 与 braille", async () => {
    const { renderGraphStyle } = await import("../src/topology/render-graph.js");
    for (const style of ["hatchet", "braille", "braille-fallback"] as const) {
      const plain = renderGraphStyle(style, crossingGraph(), { host: "h", rig: "r", selected: null }, 140).plainLines();
      const nameIdx = plain.findIndex((l) => l.includes("bb.mid"));
      expect(nameIdx, `${style}: bb.mid renders`).toBeGreaterThanOrEqual(0);
      const nameRow = plain[nameIdx]!;
      const metaRow = plain[nameIdx + 1]!; // box rows: border/name/meta/border
      // 框自己的边框必须完整 │（被刺穿的边框会显示 ┼）
      // 且其间内部只带框的内容
      const nameInner = nameRow.match(/│([^│]*● bb\.mid[^│]*)│/);
      expect(nameInner, `${style}: name-row borders intact — got: ${nameRow}`).not.toBeNull();
      expect(nameInner![1]!, `${style}: name interior clean`).not.toMatch(/[─┼⠁-⣿]/);
      const metaInner = metaRow.match(/│([^│]*>_ 10%[^│]*)│/); // S19 MR2 mark meta form
      expect(metaInner, `${style}: meta-row borders intact — got: ${metaRow}`).not.toBeNull();
      expect(metaInner![1]!, `${style}: meta interior clean`).not.toMatch(/[─┼⠁-⣿]/);
    }
  });
});

describe("Phase-3 live 字形诚实（fleet 真正服务的状态）", () => {
  it("分离席（status 'detached'，无 startupStatus）渲染 ○——live 观察形状，绝不伪造 ●", async () => {
    const { statusGlyph } = await import("../src/topology/glyphs.js");
    const detached = statusGlyph({
      logicalId: "dev.impl", podNamespace: "dev", runtime: "claude-code", model: null,
      status: "detached", nodeKind: "agent", startupStatus: null, contextUsedPercentage: null,
      agentActivity: null, terminalActive: null,
    });
    expect(detached.glyph).toBe("○");
    expect(detached.token).toBe("actDetached"); // S19 MR3 role (glyph honesty unchanged)
    // 且 ● 桶专属 ready+running——无其他合格
    for (const status of [null, "detached", "stopped", "pending"]) {
      const g = statusGlyph({
        logicalId: "x", podNamespace: "p", runtime: "codex", model: null,
        status, nodeKind: "agent", startupStatus: status === "stopped" ? null : null, contextUsedPercentage: null,
      });
      expect(g.glyph, `status=${status}`).not.toBe("●");
    }
  });
});

describe("R2 HIGH-3——truecolor 下键盘内容焦点保持可见（segs 路径）", () => {
  it("› 标记经 seg 样式化存活：样式行可见、strip 不变量完整、动作不变", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "style", name: "hatchet" });
    s.dispatch({ type: "tab", tab: "graph" });
    let screen = renderScreen(s.get(), snap, { cols: 150, rows: 40 });
    s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    s.dispatch({ type: "focus", pane: "content" });
    // 选一个不从 content 列 0 开始的 node-box 区（拼接路径）
    const zoneIdx = screen.contentTargets.findIndex(
      (t) => t.action.type === "drill" && t.action.resource === "agent" && t.x1 > 33,
    );
    expect(zoneIdx).toBeGreaterThanOrEqual(0);
    const zoneAction = screen.contentTargets[zoneIdx]!.action;
    s.dispatch({ type: "content-select", index: zoneIdx });
    screen = renderScreen(s.get(), snap, { cols: 150, rows: 40 });
    const rowIdx = screen.lines.findIndex((l, i) => i > 1 && l.slice(31).includes("›"));
    expect(rowIdx, "plain screen carries the marker").toBeGreaterThan(0);
    const styled = stylizeLines(screen, createStyle("truecolor"));
    // 可见：styled 行仍含标记字形
    expect(styled[rowIdx]!, "marker visible after truecolor stylization").toContain("›");
    // 诚实：strip 不变量在标记行上也成立
    expect(stripAnsi(styled[rowIdx]!)).toBe(screen.lines[rowIdx]!);
    // PIN-1：Enter 会 dispatch 与点击区相同的动作
    expect(screen.contentTargets[zoneIdx]!.action).toEqual(zoneAction);
  });
});

describe("MR8——宽度裁剪诚实指示（founder GO；仅指示）", () => {
  it("宽于视口的 graph 在右缘渲染可见裁剪内容指示", async () => {
    const { renderGraphStyle } = await import("../src/topology/render-graph.js");
    // 40 列容不下 fixture 的三个排名列
    const rows = renderGraphStyle("hatchet", spikeFixtureGraph(), { host: "h", rig: "r", selected: null }, 40).plainLines();
    const plain = rows.join("\n");
    expect(plain).toMatch(/内容已裁剪 ▸/);
    expect(rows.every((line) => strWidth(line) <= 40)).toBe(true);
  });

  it("刚好放下的 graph 不渲染指示（无误报）", async () => {
    const { renderGraphStyle } = await import("../src/topology/render-graph.js");
    const plain = renderGraphStyle("hatchet", spikeFixtureGraph(), { host: "h", rig: "r", selected: null }, 200).plainLines().join("\n");
    expect(plain).not.toMatch(/content clipped/);
  });
});

describe("R2 HIGH-1——锁定的 agent-in-pod-in-rig 包含关系可见", () => {
  function containScreen() {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    return { s, snap, screen: renderScreen(s.get(), snap, { cols: 160, rows: 44 }) };
  }

  it("pod 容器包裹其成员 agent 框，rig 容器包裹全部（每个 agent 行上的嵌套指纹）", () => {
    const { screen } = containScreen();
    const body = screen.lines.join("\n");
    expect(body).toMatch(/▦ 工作组 openrig-build/); // rig container tab (round-3 glyph)
    for (const pod of ["orch", "dev", "review"]) expect(body, `pod ${pod} header`).toMatch(new RegExp(`≡ ${pod}`)); // round-3 pod glyph
    // 指纹：rig 双边框 ║，然后 pod 边框 │，然后
    // agent 自己的框边框 │——每个 agent 字形左侧三道嵌套墙
    // S19 MR1：标题仅成员——指纹（字形+成员前三道嵌套墙）
    // 意图不变
    for (const agent of ["lead", "driver", "qa", "r1"]) {
      expect(body, `agent ${agent} nested`).toMatch(new RegExp(`║[^║╗\\n]*│[^│\\n]*│ [●◐○✕] ${agent}`));
    }
  });

  it("嵌套命中区区分：rig tab → rig drill，pod 头 → pod drill，agent 格 → agent drill", () => {
    const { s, screen } = containScreen();
    const podZone = screen.contentTargets.find((t) => t.action.type === "drill" && t.action.resource === "pod" && t.action.name === "dev");
    expect(podZone, "pod-header hit zone").toBeDefined();
    const agentZone = screen.contentTargets.find((t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa");
    expect(agentZone, "agent-cell hit zone").toBeDefined();
    const podState = s.dispatch(podZone!.action);
    expect(podState.drill.at(-1)).toEqual({ kind: "pod", name: "dev" });
    s.dispatch({ type: "tab", tab: "graph" });
    const agentState = s.dispatch(agentZone!.action);
    expect(agentState.drill.at(-1)).toEqual({ kind: "agent", name: "dev.qa" });
  });

  it("键盘导航到达相同嵌套目标（pod 与 agent 区都存在 content-select 索引）", () => {
    const { screen } = containScreen();
    const podIdx = screen.contentTargets.findIndex((t) => t.action.type === "drill" && t.action.resource === "pod" && t.action.name === "dev");
    const agentIdx = screen.contentTargets.findIndex((t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa");
    expect(podIdx).toBeGreaterThanOrEqual(0);
    expect(agentIdx).toBeGreaterThanOrEqual(0);
    // 在选中索引上 Enter 精确 dispatch 该区动作——
    // 鼠标路径用的同一对象（PIN-1，键盘腿）
    expect(screen.contentTargets[podIdx]!.action).toEqual({ type: "drill", resource: "pod", name: "dev", target: { host: "vm-host", rig: FIXTURE_RIG_NAME } });
  });
});

describe("R2 c47219f1——屏外节点既不可键盘选也不可动作", () => {
  function screenAt(cols: number) {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    const screen = renderScreen(s.get(), snap, { cols, rows: 34 });
    return { s, snap, screen };
  }

  it("每个内容目标命中区在 140x34 与 80x34 都与可见窗格相交（区派生自裁剪真相）", () => {
    for (const cols of [140, 80]) {
      const { screen } = screenAt(cols);
      for (const t of screen.contentTargets) {
        expect(t.x1, `cols=${cols}: target ${JSON.stringify(t.action)} starts on-screen`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("键盘走完整目标列表始终显示可见标记，其 Enter 动作匹配（plain + truecolor）", () => {
    for (const cols of [140, 80]) {
      const { s, snap, screen } = screenAt(cols);
      s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
      s.dispatch({ type: "focus", pane: "content" });
      // 走到最后一个可选目标——class R2 命中（140 处 12×Down）
      const last = screen.contentTargets.length - 1;
      s.dispatch({ type: "content-select", index: last });
      const sel = renderScreen(s.get(), snap, { cols, rows: 34 });
      const markerRow = sel.lines.findIndex((l, i) => i > 1 && l.slice(31).includes("›"));
      expect(markerRow, `cols=${cols}: a visible marker exists for the last selectable target`).toBeGreaterThan(0);
      const styled = stylizeLines(sel, createStyle("truecolor"));
      expect(styled[markerRow]!, `cols=${cols}: marker visible in truecolor`).toContain("›");
      expect(stripAnsi(styled[markerRow]!)).toBe(sel.lines[markerRow]!);
      // Enter dispatch 一个真实、可见目标的动作
      expect(sel.contentTargets[Math.min(last, sel.contentTargets.length - 1)]!.action).toBeDefined();
    }
  });

  it("更窄重渲染收缩目标列表时选择诚实归一（resize 类）", () => {
    const { s, snap, screen } = screenAt(150);
    s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    s.dispatch({ type: "focus", pane: "content" });
    s.dispatch({ type: "content-select", index: screen.contentTargets.length - 1 });
    // 收窄 resize：目标变少——layout 动作钳制选择
    const narrow = renderScreen(s.get(), snap, { cols: 80, rows: 34 });
    const after = s.dispatch({ type: "layout", contentMaxOffset: narrow.contentMaxOffset, contentTargetCount: narrow.contentTargets.length });
    expect(after.contentSelection).toBeLessThan(Math.max(narrow.contentTargets.length, 1));
  });
});

describe("逐视图资格（PM 同意 b7f95c4b）：可见真相按视图重估", () => {
  it("rig 级全裁剪的 agent 在其 pod 被 drill 后变为有资格，rig 级再无资格", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    // S19 密度缩小了卡片，故旧 80 列前提不再裁剪任何东西——
    // 56 列（24 列 content 窗格）为此资格锚点恢复一个真
    // 正全裁剪的末 pod
    const rigLevel = renderScreen(s.get(), snap, { cols: 56, rows: 34 });
    const atRig = rigLevel.contentTargets.some((t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa");
    expect(atRig, "dev.qa ineligible while fully clipped at rig level").toBe(false);
    // drill dev pod → pod 范围视图容纳 → dev.qa 可见且合格
    s.dispatch({ type: "drill", resource: "pod", name: "dev", target: { host: "vm-host", rig: FIXTURE_RIG_NAME } });
    s.dispatch({ type: "tab", tab: "graph" });
    const podLevel = renderScreen(s.get(), snap, { cols: 80, rows: 34 });
    expect(podLevel.lines.join("\n")).toContain("◐ qa"); // visible pixels (member-only, S19 MR1)
    const atPod = podLevel.contentTargets.some((t) => t.action.type === "drill" && t.action.resource === "agent" && t.action.name === "dev.qa");
    expect(atPod, "dev.qa eligible in the drilled view (same visible-truth rule, per view)").toBe(true);
  });
});

describe("S19 MR1——消除三重名字（§A1）", () => {
  it("每张 graph 卡只命名其 pod 一次：节点标题仅成员，卡 meta 无 pod 令牌", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "tab", tab: "graph" });
    const body = renderScreen(s.get(), snap, { cols: 160, rows: 44 }).lines.join("\n");
    // pod 只命名一次——容器标签
    expect(body).toMatch(/≡ dev/);
    // 标题仅成员：qa 卡读作 "◐ qa"，绝不 "◐ dev.qa"
    expect(body).toMatch(/[◐] qa/);
    expect(body).not.toMatch(/[◐] dev\.qa/);
    expect(body).toMatch(/● driver/);
    expect(body).not.toMatch(/● dev\.driver/);
    // meta 去掉 pod 后缀：卡 meta 行内无 "· dev" 尾
    expect(body).not.toMatch(/· dev │/);
    expect(body).not.toMatch(/· orch │/);
    // 非 pod 前缀名显示不变（诚实回退镜像
    // navigator 的确认前缀规则）
  });
});

describe("S19 MR3——活动设计语言（角色级、与调色板值无关）", () => {
  it("active / idle / detached / attention 映射到四种不同颜色角色；字形诚实不变", async () => {
    const { statusGlyph } = await import("../src/topology/glyphs.js");
    const base = { logicalId: "x", podNamespace: "p", runtime: "codex", model: null, nodeKind: "agent" as const, contextUsedPercentage: null };
    const active = statusGlyph({ ...base, status: "running", startupStatus: "ready", agentActivity: { state: "running" } });
    const idle = statusGlyph({ ...base, status: "running", startupStatus: "ready", agentActivity: { state: "idle" } });
    const detached = statusGlyph({ ...base, status: "detached", startupStatus: null, agentActivity: null });
    const attention = statusGlyph({ ...base, status: "running", startupStatus: "attention_required", agentActivity: null });
    // 字形保持诚实的 4 词汇
    expect(active.glyph).toBe("●");
    expect(idle.glyph).toBe("●");
    expect(detached.glyph).toBe("○");
    expect(attention.glyph).toBe("◐");
    // 角色是不同的（值 = founder 后选；角色是契约）
    const roles = [active.token, idle.token, detached.token, attention.token];
    expect(new Set(roles).size).toBe(4);
    // 诚实 unknown 不变：无 session/无 activity → ○，绝不 ●
    const unknown = statusGlyph({ ...base, status: null, startupStatus: null });
    expect(unknown.glyph).toBe("○");
  });
});

describe("S19 MR4——详情窗格显示完整绝对工作目录", () => {
  it("有已服务 cwd 的 agent 逐字渲染；缺失 cwd 渲染诚实 —", () => {
    const snap = graphSnap();
    (snap.hosts[0]!.rigs[0]!.pods[1]!.agents[0]! as { cwd?: string | null }).cwd = "/Users/admin/code/openrig-build-source";
    const s = makeStore(snap);
    s.dispatch({ type: "drill", resource: "agent", name: "dev.driver", target: { host: "vm-host", rig: FIXTURE_RIG_NAME, pod: "dev" } });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toContain("/Users/admin/code/openrig-build-source"); // full absolute path, verbatim
    const s2 = makeStore(graphSnap());
    s2.dispatch({ type: "drill", resource: "agent", name: "dev.qa", target: { host: "vm-host", rig: FIXTURE_RIG_NAME, pod: "dev" } });
    const body2 = renderScreen(s2.get(), graphSnap(), { cols: 150, rows: 40 }).lines.join("\n");
    expect(body2).toContain("— (未服务)"); // the literal honest absent value (guard strengthening)
  });
});

describe("命令焦点 + 引导线对比", () => {
  it("命令栏插入格在空与非空输入下都可见（守卫 MR5a：输入前可发现性）", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    // 空 buffer：光标在首键前显示栏已就绪
    const empty = renderScreen(s.get(), snap, { cols: 120, rows: 30 }, "");
    expect(empty.lines[0]).toContain("cmd ▸ ▊");
    const styledE = stylizeLines(empty, createStyle("truecolor"));
    expect(styledE[0]).toContain("▊");
    expect(empty.commandMotionActive).toBe(true);
    styledE.forEach((l, i) => expect(stripAnsi(l)).toBe(empty.lines[i]));
    // 非空：光标骑在文本末端
    const composing = renderScreen(s.get(), snap, { cols: 120, rows: 30 }, "rig ope");
    expect(composing.lines[0]).toContain("rig ope▊");
    const styledC = stylizeLines(composing, createStyle("truecolor"));
    expect(styledC[0]).toContain("▊");
    expect(composing.commandMotionActive).toBe(false);
    styledC.forEach((l, i) => expect(stripAnsi(l)).toBe(composing.lines[i]));
  });

  it("tree 引导线绘制提升后的 chrome 对比（升一档；纯文本高亮 pin 为回归守卫）", () => {
    const s = makeStore(graphSnap());
    const screen = renderScreen(s.get(), graphSnap(), { cols: 120, rows: 30 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const guideLine = styled.find((l) => stripAnsi(l).includes("┣━"))!;
    expect(guideLine).toMatch(/38;2;78;105;145m[^m]*┣━/); // G2 restrained indigo frame
    expect(guideLine).not.toMatch(/38;2;58;63;75m[^m]*┣━/); // not the old faint value
  });
});

describe("ROUND-3 锁定集（orch 锁定范围 GO；pins 02259adb/29a10b62）", () => {
  it("runtime 标记不在 explorer 行：agent meta 仅 ctx%；标记活在详情 + topology 卡上", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "drill", resource: "pod", name: "dev", target: { host: "vm-host", rig: FIXTURE_RIG_NAME } });
    const explorer = renderScreen(s.get(), snap, { cols: 150, rows: 40 });
    const pane = explorer.lines.map((l) => l.slice(0, explorer.explorerWidth)).join("\n");
    expect(pane).not.toMatch(/▐▌|>_|▝▘|▘▝|></); // no marks in the explorer (quadrant orders AND the picks-v4 eyes)
    expect(pane).toMatch(/driver\s+24%/); // name-first untruncated + bare ctx%
    // 卡仍带标记
    s.dispatch({ type: "tab", tab: "graph" });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toMatch(/>< 24%|>< 63%/); // picks-v4 clawd mark in card meta
    // 详情页把标记显示为 runtime 字段——拼写 runtime 已死
    s.dispatch({ type: "drill", resource: "agent", name: "dev.driver", target: { host: "vm-host", rig: FIXTURE_RIG_NAME, pod: "dev" } });
    const detail = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    // a4c9548a（S19 后续 founder 裁决，界定 marks 裁决）：在详情
    // 页有空间，故 runtime NAME 是 VALUE；标记只装饰性伴随，
    // 绝不替代。（取代早先 "标记即值 /
    // 拼写 runtime 已死" 锚点——上方 topology 卡保持仅标记，界定而非反转。）
    expect(detail).toMatch(/运行时:\s+claude-code/); // the NAME is the runtime value
    expect(detail).toMatch(/claude-code\s+></); // the clawd mark still accompanies decoratively
  });

  it("clawd 眼睛是 picks-v4 向内眯眼对 `><`（founder 修正 14afeb74，取代 round-4 象限几何）", async () => {
    const { clawdSquareMark, runtimeMarkSegs, markText } = await import("../src/topology/runtime-marks.js");
    const sq = clawdSquareMark();
    expect(sq).toHaveLength(2); // 2-cell form: literally the characters >< per the amendment
    expect(sq[0]!.text).toBe(">"); // left eye points INWARD
    expect(sq[1]!.text).toBe("<"); // right eye points INWARD — reads as a FACE
    expect(markText(sq)).toBe("><");
    expect(sq.every((g) => g.token === "clawdEye" && g.bg === "clawd")).toBe(true); // dark eyes ON the terracotta field (unchanged)
    expect(markText(runtimeMarkSegs("claude-code"))).toBe("><"); // shipped claude mark = the refined face
  });

  it("agent-detail runtime NAME 是值，且标记在编译输出中保留自有样式（a4c9548a + guard round-4 finding 2）", () => {
    const node = (id: string, name: string, runtime: string) => ({
      id, type: "rigNode", parentId: "pod-D",
      data: { logicalId: name, podNamespace: "d", runtime, model: null, status: "running",
        nodeKind: "agent" as const, startupStatus: "ready" as const, contextUsedPercentage: 10,
        agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: `${name}@r` },
    });
    const graph = {
      nodes: [
        { id: "pod-D", type: "podGroup", data: { logicalId: "d", podNamespace: "d", runtime: null, model: null, status: null, nodeKind: "agent" as const, startupStatus: null, contextUsedPercentage: null } },
        node("n1", "d.cl", "claude-code"), node("n2", "d.tty", "terminal"), node("n3", "d.cx", "codex"),
      ],
      edges: [],
    };
    const trioSnap = {
      ...graphSnap(),
      hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "d", agents: [
        { name: "d.cl", runtime: "claude-code", spec: "", context: 10, tokens: null, status: "active", live: true },
        { name: "d.tty", runtime: "terminal", spec: "", context: 10, tokens: null, status: "active", live: true },
        { name: "d.cx", runtime: "codex", spec: "", context: 10, tokens: null, status: "active", live: true },
      ] }], graph }] }],
    };
    const drillDetail = (agent: string) => {
      const s = makeStore(trioSnap);
      s.dispatch({ type: "drill", resource: "agent", name: agent, target: { host: "h", rig: "r", pod: "d" } });
      const screen = renderScreen(s.get(), trioSnap, { cols: 150, rows: 40 });
      const styled = stylizeLines(screen, createStyle("truecolor"));
      const idx = screen.lines.findIndex((l) => dropW(l, screen.explorerWidth + 1).includes("运行时:"));
      expect(idx, `runtime field row for ${agent}`).toBeGreaterThan(0);
      styled.forEach((l, j) => expect(stripAnsi(l), `${agent} line ${j}`).toBe(screen.lines[j]));
      return { plain: screen.lines[idx]!, styled: styled[idx]! };
    };
    // clawd：深色 #181818 眼睛在 #ad6755 赤陶字段上，编译后 SGR
    const cl = drillDetail("d.cl");
    expect(cl.styled).toMatch(/38;2;24;24;24;48;2;173;103;85m[^\x1b]*>/);
    expect(cl.styled).toMatch(/38;2;24;24;24;48;2;173;103;85m[^\x1b]*</); // both inward eyes carry the eye-on-terracotta SGR
    expect(cl.plain).toMatch(/运行时:\s+claude-code/); // a4c9548a: the NAME is the value (the mark's SGR above proves it still accompanies decoratively)
    // terminal：深色 cell 背景存活到编译后详情行
    const tty = drillDetail("d.tty");
    expect(tty.styled).toMatch(/48;2;12;10;9m?[^\x1b]*>/);
    expect(tty.plain).toMatch(/运行时:\s+terminal/); // a4c9548a: the NAME is the value; the >_ mark still trails (SGR above)
    // codex：NAME `codex` 即值（a4c9548a），配 picks-v4 仅 V 形
    // 蓝色提示——`>` 在详情携带官方采样 #6867aa
    //（38;2;104;103;170）；`_` 保持淡墨；无 ❯，无 outline。
    const cx = drillDetail("d.cx");
    expect(cx.plain).toMatch(/运行时:\s+codex/); // a4c9548a: the NAME is the value
    expect(cx.styled).toMatch(/38;2;104;103;170m[^\x1b]*>/); // chevron pick (picks v4 item a) still accompanies
    expect(cx.plain).not.toMatch(/❯/); // no ❯ outline (the codex name renders as the value, not an icon substitute)
  });

  it("rig 字形为 ▦，pod 字形为 ≡（founder 记录 picks）", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    const pane = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.map((l) => l.slice(0, 30)).join("\n");
    expect(pane).toContain("▦ openrig-build"); // rig icon
    expect(pane).not.toMatch(/▚ /);
    s.dispatch({ type: "tab", tab: "graph" });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toMatch(/▦ 工作组 openrig-build/);
    expect(body).toMatch(/≡ dev/); // pod container tab carries the pod glyph
  });

  it("live rig 图标为明亮单色（颜色仅用于状态）", () => {
    const snap = graphSnap();
    const s = makeStore(snap);
    s.dispatch({ type: "select", index: 0 }); // inspect an unselected icon, not selection paint
    const screen = renderScreen(s.get(), snap, { cols: 150, rows: 40 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const rigLine = styled.find((l) => stripAnsi(l).includes("▦ openrig-build"))!;
    expect(rigLine).not.toMatch(/38;2;77;189;178m[^m]*▦/); // NOT the old accent teal
    expect(rigLine).toContain(createStyle("truecolor").paint("bright", "▦"));
  });

  it("官方 codex 蓝令牌为 #6867aa，三个 hint 候选存在未选", async () => {
    const { codexHintVariants } = await import("../src/topology/runtime-marks.js");
    const { createStyle: cs } = await import("../src/theme.js");
    const t = cs("truecolor");
    expect(t.paint("codexBlue", "x")).toContain("38;2;104;103;170"); // #6867aa exact
    const variants = codexHintVariants();
    expect(Object.keys(variants).sort()).toEqual(["chevron", "none", "outline"]); // candidates only — nothing picked
    const { runtimeMarkSegs, markText } = await import("../src/topology/runtime-marks.js");
    expect(markText(runtimeMarkSegs("codex"))).toBe(">_"); // the SHIPPED mark stays the approved plain form
  });
});
