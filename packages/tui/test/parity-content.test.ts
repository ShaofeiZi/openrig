import { describe, expect, it } from "vitest";
import { computeExplorerRows, createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { decodeInput, resolveKeyAction, sgrClick } from "../src/input.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot, Screen, ViewState, ViewStateStore } from "../src/types.js";
import { strWidth } from "../src/text-width.js";

// Phase-3 对等强化：content 窗格表面也是命中目标。
// 命中目标真实性：这些测试点击渲染表面上的坐标
// （可见表格格、spec 成员行），而非带标签的控件。

const snap = demoSnapshot();
snap.specs.find(s => s.name === "openrig-build-rig")!.pods = [{ id: "build", namespace: "build", members: [{ id: "guard", agentRef: "guard-agent", runtime: "codex" }], edges: [] }];
// 来自 Attention 权威的显式人工请求，非转换的 agent 信号。
snap.attentionRead = {
  scope: "instance", readAt: "2026-09-10T00:00:00Z", sources: [{ source: "queue", state: "available", detail: "fixture" }],
  items: [{ id: "queue:cover", kind: "action", summary: "Choose the readable cover", unblocks: "Print the edition", urgency: "urgent", at: "2026-09-10T00:00:00Z", scope: "instance", project: null, source: "/api/queue/cover" }],
  detail: null, detailError: null,
};

function fresh(id: string): ViewStateStore {
  return createViewState({ instanceId: id, getSnapshot: () => snap });
}

function comparable(state: ViewState) {
  const { instanceId: _i, sections: _s, history: _history, ...rest } = state;
  return rest;
}

function clickAt(store: ViewStateStore, x: number, y: number): boolean {
  const screen = renderScreen(store.get(), snap, { cols: 120, rows: 32 });
  const click = decodeInput(sgrClick(x, y)).find((e) => e.type === "mouse");
  if (click?.type !== "mouse") throw new Error("no mouse event decoded");
  const hit = screen.hitMap.find((h) => h.y === click.y && click.x >= h.x1 && click.x <= h.x2);
  if (!hit) return false;
  store.dispatch(hit.action);
  return true;
}

function findContentLine(store: ViewStateStore, match: RegExp): { y: number; text: string } {
  const screen = renderScreen(store.get(), snap, { cols: 120, rows: 32 });
  const idx = screen.lines.findIndex((l) => match.test(l));
  if (idx < 0) throw new Error(`no rendered line matches ${match}\n${screen.lines.join("\n")}`);
  return { y: idx + 1, text: screen.lines[idx]! };
}

function columnOf(text: string, needle: string, offset = 0): number {
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`no rendered text ${needle}`);
  return strWidth(text.slice(0, index)) + 1 + offset;
}

function syncedScreen(store: ViewStateStore, snapshot: FleetSnapshot = snap): Screen {
  let screen = renderScreen(store.get(), snapshot, { cols: 120, rows: 32 });
  store.dispatch({
    type: "layout",
    contentMaxOffset: screen.contentMaxOffset,
    contentTargetCount: screen.contentTargets.length,
  });
  screen = renderScreen(store.get(), snapshot, { cols: 120, rows: 32 });
  return screen;
}

function press(store: ViewStateStore, bytes: string, snapshot: FleetSnapshot = snap): void {
  const screen = syncedScreen(store, snapshot);
  const event = decodeInput(bytes)[0];
  if (!event || event.type !== "key") throw new Error("expected key event");
  const action = resolveKeyAction(event, store.get(), screen, computeExplorerRows(store.get(), snapshot).length);
  if (action) store.dispatch(action);
}

describe("content 窗格对等（Phase 3）：点表面，不点控件", () => {
  it("点表格行 STATUS 单元格打开 agent——与命令相同", () => {
    const byCommand = fresh("cmd");
    const byMouse = fresh("ui");
    byCommand.dispatch(parseCommand("agent dev50.guard"));

    byMouse.dispatch(parseCommand("rig openrig-build"));
    const row = findContentLine(byMouse, /guard.*空闲/);
    // 在 STATUS 格文本内部点击（非标签可见格，远离 AGENT 列）
    const statusX = columnOf(row.text, "空闲");
    expect(clickAt(byMouse, statusX, row.y)).toBe(true);
    expect(comparable(byMouse.get())).toEqual(comparable(byCommand.get()));
  });

  it("点 rig-spec 成员行打开该 agent spec——与命令相同", () => {
    const byCommand = fresh("cmd");
    const byMouse = fresh("ui");
    byCommand.dispatch(parseCommand("spec guard-agent"));

    byMouse.dispatch(parseCommand("spec openrig-build-rig"));
    const layout = renderScreen(byMouse.get(), snap, { cols: 120, rows: 32 });
    byMouse.dispatch({ type: "layout", contentMaxOffset: layout.contentMaxOffset, contentTargetCount: layout.contentTargets.length });
    byMouse.dispatch({ type: "content-scroll", delta: layout.contentMaxOffset });
    const member = findContentLine(byMouse, /┃.*▪.*guard-agent/);
    expect(clickAt(byMouse, columnOf(member.text, "guard-agent", 2), member.y)).toBe(true);
    expect(byMouse.get().drill).toEqual(byCommand.get().drill);
    expect(byMouse.get().section).toBe(byCommand.get().section);
  });

  it("点 tab 行切换 TABLE→OVERVIEW——与 `tab overview` 相同", () => {
    const byCommand = fresh("cmd");
    const byMouse = fresh("ui");
    byCommand.dispatch(parseCommand("rig openrig-build"));
    byCommand.dispatch(parseCommand("tab overview"));

    byMouse.dispatch(parseCommand("rig openrig-build"));
    const tabs = findContentLine(byMouse, /表格.*概览/);
    expect(clickAt(byMouse, columnOf(tabs.text, "概览"), tabs.y)).toBe(true);
    expect(byMouse.get().viewTab).toBe("overview");
    expect(comparable(byMouse.get())).toEqual(comparable(byCommand.get()));
    // 且概览渲染 pods，非表头
    const screen = renderScreen(byMouse.get(), snap, { cols: 120, rows: 32 });
    expect(screen.lines.some((l) => l.includes("2 个席位"))).toBe(true);
  });

  it("点人工 Attention 项打开其源详情，不解决它", () => {
    const byMouse = fresh("ui");
    byMouse.dispatch(parseCommand(":needs"));
    const item = findContentLine(byMouse, /\[urgent\] Choose the readable cover/);
    expect(clickAt(byMouse, columnOf(item.text, "Choose"), item.y)).toBe(true);
    expect(byMouse.get().section).toBe("needs");
    expect(byMouse.get().attentionOpen).toBe("queue:cover");
    expect(snap.attentionRead!.items).toHaveLength(1);
  });

  it("任何处都不渲染 resolve/reply 可操作项（B3：那些属 Studio）", () => {
    const s = fresh("t");
    for (const cmd of [":topology", "rig openrig-build", ":specs", "spec openrig-build-rig", ":needs"]) {
      s.dispatch(parseCommand(cmd));
      const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
      expect(screen.lines.join("\n")).not.toMatch(/resolve|reply/i);
    }
  });

  it("drill 把视图 tab 重置为 TABLE（FR-3 默认）", () => {
    const s = fresh("t");
    s.dispatch(parseCommand("rig openrig-build"));
    s.dispatch(parseCommand("tab overview"));
    s.dispatch(parseCommand("agent dev50.driver"));
    expect(s.get().viewTab).toBe("table");
  });

  it("PageDown 滚动内容，不移动 explorer 选择", () => {
    const s = fresh("t");
    const selected = s.get().selection;
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 8 });
    s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    const pageDown = decodeInput("\x1b[6~")[0];
    if (!pageDown || pageDown.type !== "key" || !("action" in pageDown)) throw new Error("PageDown was not decoded");
    s.dispatch(pageDown.action);
    expect(s.get().contentOffset).toBe(Math.min(10, screen.contentMaxOffset));
    expect(s.get().selection).toBe(selected);
  });

  it("原始 right/down/Enter 到达 content tab、表格行、spec 引用与 Needs 链接", () => {
    const structured: FleetSnapshot = {
      ...snap,
      specs: [{
        name: "openrig-build-rig",
        kind: "rig",
        format: "pod_aware",
        pods: [{ id: "dev50", members: [{ id: "guard", agentRef: "guard-agent", runtime: "codex" }], edges: [] }],
        graph: { nodes: [], edges: [] },
        raw: "name: openrig-build-rig",
      }, ...snap.specs.filter((spec) => spec.name !== "openrig-build-rig")],
    };

    const tab = createViewState({ instanceId: "tab", getSnapshot: () => structured });
    tab.dispatch(parseCommand("spec openrig-build-rig"));
    press(tab, "\x1b[C", structured);
    press(tab, "\r", structured);
    expect(tab.get().viewTab).toBe("topology");

    const row = fresh("row");
    row.dispatch(parseCommand("rig openrig-build"));
    press(row, "\x1b[C");
    let screen = syncedScreen(row);
    const rowTarget = screen.contentTargets.findIndex((target) => target.action.type === "drill" && target.action.resource === "agent" && target.action.name === "dev50.guard");
    for (let i = 0; i < rowTarget; i++) press(row, "\x1b[B");
    press(row, "\r");
    expect(row.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.guard" });

    const ref = createViewState({ instanceId: "ref", getSnapshot: () => structured });
    ref.dispatch(parseCommand("spec openrig-build-rig"));
    press(ref, "\x1b[C", structured);
    screen = syncedScreen(ref, structured);
    const refTarget = screen.contentTargets.findIndex((target) => target.action.type === "drill" && target.action.resource === "spec" && target.action.name === "guard-agent");
    for (let i = 0; i < refTarget; i++) press(ref, "\x1b[B", structured);
    press(ref, "\r", structured);
    expect(ref.get().drill.at(-1)).toEqual({ kind: "spec", name: "guard-agent" });

    const needs = fresh("needs");
    needs.dispatch(parseCommand(":needs"));
    press(needs, "\x1b[C");
    press(needs, "\r");
    expect(needs.get().attentionOpen).toBe("queue:cover");
    expect(needs.get().section).toBe("needs");
  });
});

describe("rig-stream footer（FR-10）：环境性、可切换、绝非视图", () => {
  it("开启时渲染最新流项，切换关闭时隐藏", () => {
    const s = fresh("t");
    let screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    expect(screen.lines.some((l) => l.includes("≋") && l.includes("提供商重新认证在 mm2 上完成"))).toBe(true);
    s.dispatch({ type: "footer" });
    screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    expect(screen.lines.some((l) => l.includes("≋"))).toBe(false);
  });

  it("不可导航：无区段、无 grammar 动词、无命中目标", () => {
    const s = fresh("t");
    expect(s.get().sections.some((sec) => sec.name.includes("stream"))).toBe(false);
    expect(parseCommand(":stream").type).toBe("error");
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const footerY = screen.lines.findIndex((l) => l.includes("≋")) + 1;
    expect(screen.hitMap.some((h) => h.y === footerY)).toBe(false);
  });
});
