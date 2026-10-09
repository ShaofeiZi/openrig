// SCOPES VIEW（plan d64d2f5c）——按 v4 mock 契约 + data-path 规则的 render 锚点。
import { describe, it, expect } from "vitest";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { parseCommand } from "../src/grammar.js";
import { proofBadge, scopeContractLines } from "../src/scopes/scopes-model.js";

function openGateway() {
  const snap = demoSnapshot();
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  view.dispatch(parseCommand(":scopes"));
  view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.2" });
  view.dispatch({ type: "scopes-open", mission: "release-0.5.2", slice: "gateway-m1" });
  return { snap, view };
}

describe("scopes 视图（store 直渲染，v4 mock 契约）", () => {
  it("explorer：选中任务原子打开并揭示其 slices", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.2" });
    expect(view.get().scopesMission).toBe("release-0.5.2");
    expect(view.get().expanded).toContain("scopes-mission:release-0.5.2");
    const labels = computeExplorerRows(view.get(), snap).map((r) => r.label);
    expect(labels.some((l) => l.includes("release-0.5.2"))).toBe(true);
    expect(labels.some((l) => l.includes("● gateway-m1"))).toBe(true);
    expect(labels.some((l) => l.includes("✓ crash-cart"))).toBe(true);
  });

  it("绝不把先前任务的执行数据渲染到新选任务标题下", () => {
    const snap = {
      ...demoSnapshot(),
      executionMission: "older-release",
      execution: { view: "execution" as const, mission: "older-release", sources: {}, q1_lanes: [], q2_sequencing: [], q4_ladder: [], q5_park: [] },
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.2" });
    const out = renderScreen(view.get(), snap, { cols: 160, rows: 40 }).lines.join("\n");
    expect(out).toContain("release-0.5.2 执行");
    expect(out).toContain("读取挂起");
    expect(out).not.toContain("older-release");
  });

  it("详情渲染紧凑身份/状态头，并分隔 Intent、Requirements、Proof 区", () => {
    const { snap, view } = openGateway();
    const out = renderScreen(view.get(), snap, { cols: 160, rows: 220 }).lines.join("\n");
    expect(out).toContain("● gateway-m1 · OPR.0.5.2.9 · release-0.5.2");
    expect(out).toContain("状态 构建中 · 证明 2/9 · 锁定 规范已锁定 · 交付开放");
    expect(out).toContain("── 意图 ");
    expect(out).toContain("Slack 到创建者");
    expect(out).toContain("── 需求 (2)");
    expect(out).toContain("── 证明 · 2/9 已配对");
    expect(out).toMatch(/状态\s+#\s+需求\s+证据/);
    expect(out).toMatch(/已配对\s+1\s+在已发布中继路径上演示的投递后确认修复/);
    expect(out).toMatch(/未配对\s+2\s+已注册实体从 Slack 冷 DM/);
    expect(out).toContain("↳ QA PASS");
    expect(out).toContain("qa-relay.md");
    expect(out).toContain("媒体 relay-repair-e2e.txt");
  });

  it("founder 锁字形形态：仅 delivery-locked 时渲染 🔒；计数承载诚实", () => {
    const snap = demoSnapshot();
    const cc = snap.scopes![0]!.slices.find((s) => s.dirName === "crash-cart")!;
    expect(proofBadge(cc)).toBe("证明: 4/4 已配对 🔒");
    const gm = snap.scopes![0]!.slices.find((s) => s.dirName === "gateway-m1")!;
    expect(proofBadge(gm)).toBe("证明: 2/9 已配对"); // no del token, no unproven suffix — the count speaks
  });

  it("m 折叠 mini-requirements；n 把 PROGRESS.md 作叙事展示（绝不喂计数）", () => {
    const { snap, view } = openGateway();
    view.dispatch(parseCommand("reqs"));
    let out = renderScreen(view.get(), snap, { cols: 160, rows: 220 }).lines.join("\n");
    expect(out).toContain("已折叠 · m 展开");
    view.dispatch(parseCommand("narrative"));
    out = renderScreen(view.get(), snap, { cols: 160, rows: 220 }).lines.join("\n");
    expect(out).toContain("进度 · 仅叙事 · n 关闭");
    expect(out).toContain("A2 等待架构咨询");
    // data-path 规则：narrative 面板不改变 store 派生计数
    expect(out).toContain("证明 2/9");
  });
});


it.each([60, 160])("joins scope states and evidence by ID at width %i, not position", (width) => {
  const detail = demoSnapshot().scopes![0]!.slices[0]!;
  detail.proofContract = [
    { id: "b", index: 1, text: "Second item", paired: false, drops: [] },
    { id: "a", index: 2, text: "First item", paired: false, drops: [] },
    { id: "missing", index: 3, text: "Unknown item", paired: false, drops: [] },
  ];
  detail.readiness = { configured: true, state: "not-ready", revision: "basis", items: [
    { id: "a", index: 1, text: "First item", state: "rejected", reason: "Only A rejected", judgment: { id: "a-receipt" } },
    { id: "b", index: 2, text: "Second item", state: "accepted", reason: "Only B accepted", judgment: { id: "b-receipt" } },
  ] };
  const render = scopeContractLines(detail, { collapseReqs: false, narrative: null, width }).map(l => l.text).join("\n");
  const b = render.indexOf("Second item"), a = render.indexOf("First item"), missing = render.indexOf("Unknown item");
  expect(render).toMatch(width === 60 ? /需求 1 · 已接受/ : /已接受\s+1\s+Second item/);
  expect(render).toMatch(width === 60 ? /需求 2 · 已拒绝/ : /已拒绝\s+2\s+First item/);
  expect(render.slice(b, a)).toContain("Only B accepted");
  expect(render.slice(a, missing)).toContain("Only A rejected");
  expect(render).toContain("未知");
});
