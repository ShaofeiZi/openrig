import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { computeExplorerRows, createViewState } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";
import { dropW, strWidth } from "../src/text-width.js";

describe("live 视觉回归", () => {
  it("渲染批准的 POD/SEAT 身份列，不重复选中 rig", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const header = screen.lines.find((line) => line.includes("席位") && line.includes("状态"));
    const row = screen.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"));

    expect(header).toMatch(/席位\s+席位\s+运行时\s+模型/);
    expect(row).not.toContain("openrig-build");
  });

  it("140 列下保持批准的运营列", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const header = screen.lines.find((line) => line.includes("席位") && line.includes("状态"));
    expect(header).toContain("上下文");
    expect(header).toContain("队列");
    expect(header).toContain("工作");
    expect(header).toContain("现在");
    expect(header).toContain("动作");
  });

  it("让每个 raw-key 内容目标可见聚焦，包括一行上多个动作", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });
    view.dispatch({ type: "focus", pane: "content" });
    let screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });

    const tabIndex = screen.contentTargets.findIndex((target) => target.action.type === "tab");
    const termIndex = screen.contentTargets.findIndex((target) => target.action.type === "act" && target.action.act === "open-terminal");
    const rowIndex = screen.contentTargets.findIndex((target) => target.action.type === "drill" && target.action.resource === "agent");
    expect([tabIndex, termIndex, rowIndex].every((index) => index >= 0)).toBe(true);

    view.dispatch({ type: "content-select", index: tabIndex });
    screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    // 窗格分隔符按固定边界定位（EXPL_W=30 → content 在 31）：
    // slice-17 navigator 的 │ 轨会遮蔽首 │ 分屏（guard
    // 批准的诚实底线更新；断言不变）
    expect(dropW(screen.lines[screen.contentTargets[tabIndex]!.y - 1]!, screen.explorerWidth + 1)).toMatch(/^›/);

    view.dispatch({ type: "content-select", index: termIndex });
    screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    expect(dropW(screen.lines[screen.contentTargets[termIndex]!.y - 1]!, screen.explorerWidth + 1)).toMatch(/^›/);
    expect(screen.contentTargets[termIndex]!.action).toEqual(expect.objectContaining({ type: "act", act: "open-terminal" }));

    view.dispatch({ type: "content-select", index: rowIndex });
    screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    // 固定边界窗格分隔符（见上方 tab-focus 锚点）
    expect(dropW(screen.lines[screen.contentTargets[rowIndex]!.y - 1]!, screen.explorerWidth + 1)).toMatch(/^›/);
  });

  it("绝不发出宽于终端的组合行", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 80, rows: 20 });
    expect(screen.lines.every((line) => strWidth(line) <= 80)).toBe(true);
  });

  it("把 ticker、rule、status 锚到精确短 140x34 视图底部", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = { ...base, needs: [], hostsDown: [] };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    expect(screen.lines).toHaveLength(34);
    // chrome 契约（visual-polish 指令）：ticker · 窗格线 · keybind
    // 提示条 · 状态行，底部锚定
    expect(screen.lines[30]).toContain("≋");
    expect(screen.lines[31]).toMatch(/^━+╋━+$/);
    expect(screen.lines[32]).toContain("q 退出");
    expect(screen.lines[33]).toContain("[t] 待关注");
  });

  it("滚动 explorer 视口保持键盘选择可见", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: Array.from({ length: 20 }, (_, i) => ({ name: `spec-${i}`, kind: "agent" as const })),
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "specs" });
    view.dispatch({ type: "toggle-expand", key: "specs-kind:agent" });
    const rows = computeExplorerRows(view.get(), snap);
    const target = rows.findIndex((row) => row.label.includes("spec-15"));
    view.dispatch({ type: "select", index: target, rowCount: rows.length });

    const screen = renderScreen(view.get(), snap, { cols: 100, rows: 12 });
    expect(screen.lines.some((line) => line.includes("▶") && line.includes("spec-15"))).toBe(true);
  });

  it("不把遗留 agent 信号转成人工 Attention 请求", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      needs: [{ source: "derived", kind: "overdue", target: "qitem-123", detail: "past closure_required_at" }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 20 });
    expect(screen.lines.join("\n")).not.toContain("qitem-123");
    expect(screen.lines.join("\n")).toContain("不可用: 待关注");
    expect(screen.contentTargets).toHaveLength(0);
  });

  it("绝不给同 canonical session 的远端 Needs 行打开本地席", () => {
    const snap = demoSnapshot();
    snap.needs = [{
      source: "derived",
      kind: "stuck",
      target: "dev50-guard@openrig-build",
      hostId: "remote-a",
      detail: "remote guard needs attention",
    }];
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });
    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    expect(screen.lines.join("\n")).not.toContain("remote guard needs attention");
    expect(screen.lines.join("\n")).toContain("不可用: 待关注");
    expect(screen.contentTargets).toHaveLength(0);
  });

  it("渲染锁定 rig-spec 结构，带可点 agent 引用", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: [{
        name: "adversarial-review",
        kind: "rig",
        sourceState: "library_item",
        sourceType: "user_file",
        sourcePath: "/Users/admin/code/openrig-build-source/packages/daemon/specs/rigs/focused/adversarial-review/rig.yaml",
        relativePath: "rigs/focused/adversarial-review/rig.yaml",
        format: "pod_aware",
        pods: [{
          id: "review",
          label: "Review",
          members: [{ id: "r1", agentRef: "independent-reviewer", runtime: "claude-code", profile: "default" }],
          edges: [],
        }],
        edges: [{ from: "orch.lead", to: "review.r1", kind: "delegates_to" }],
        graph: {
          nodes: [{ id: "orch.lead", label: "lead", pod: "orch", runtime: "claude-code", kind: "agent" }],
          edges: [{ source: "orch.lead", target: "review.r1", kind: "delegates_to" }],
        },
        raw: "name: adversarial-review\nversion: '0.2'",
      }, {
        name: "independent-reviewer",
        kind: "agent",
        relativePath: "agents/review/independent-reviewer/agent.yaml",
      }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "spec", name: "adversarial-review" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const output = screen.lines.join("\n");
    expect(output).toMatch(/源:\s+…\//);
    expect(output).toContain("adversarial-review/rig.yaml · 用户库");
    expect(output).toMatch(/格式:\s+pod-aware/);
    expect(output).toMatch(/形态:\s+1 个席位 · 1 个成员 · 1 条边/);
    expect(output).toMatch(/── 席位 review/);
    expect(output).toMatch(/▪ r1\s+independent-reviewer\s+claude-code\s+配置 default/);
    expect(output).toMatch(/orch\.lead → review\.r1\s+\(delegates_to\)/);
    const memberY = screen.lines.findIndex((line) => line.includes("independent-reviewer")) + 1;
    expect(screen.hitMap).toContainEqual(expect.objectContaining({
      y: memberY,
      action: { type: "drill", resource: "spec", name: "independent-reviewer" },
    }));

    const tabsY = screen.lines.findIndex((line) => line.includes("拓扑") && line.includes("YAML")) + 1;
    expect(screen.hitMap).toContainEqual(expect.objectContaining({
      y: tabsY,
      action: { type: "tab", tab: "topology" },
    }));

    view.dispatch({ type: "tab", tab: "topology" });
    const topology = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(topology).toMatch(/节点\s+标签\s+席位\s+运行时/);
    expect(topology).toMatch(/orch\.lead\s+lead\s+orch\s+claude-code/);
    expect(topology).toMatch(/orch\.lead\s+→\s+review\.r1\s+\(delegates_to\)/);

    view.dispatch({ type: "tab", tab: "yaml" });
    const yaml = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(yaml).toContain("name: adversarial-review");
    expect(yaml).not.toContain("format pod-aware");
  });

  it("长内容独立于 explorer 选择滚动", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: [{
        name: "long-rig",
        kind: "rig",
        format: "pod_aware",
        pods: Array.from({ length: 18 }, (_, i) => ({ id: `pod-${i}`, members: [], edges: [] })),
      }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "spec", name: "long-rig" });
    const selected = view.get().selection;

    const initial = renderScreen(view.get(), snap, { cols: 100, rows: 12 });
    view.dispatch({ type: "layout", contentMaxOffset: initial.contentMaxOffset, contentTargetCount: initial.contentTargets.length });
    expect(initial.lines.join("\n")).not.toContain("pod pod-17");
    const scrollY = initial.lines.findIndex((line) => line.includes("滚动 ↑/↓")) + 1;
    expect(initial.hitMap).toContainEqual(expect.objectContaining({
      y: scrollY,
      action: { type: "content-scroll", delta: 10 },
    }));
    view.dispatch({ type: "content-scroll", delta: initial.contentMaxOffset }); // reach the last section regardless of the detail header height
    const scrolled = renderScreen(view.get(), snap, { cols: 100, rows: 12 }).lines.join("\n");
    expect(scrolled).toContain("席位 pod-17");
    expect(view.get().selection).toBe(selected);
    expect(scrolled).toContain("滚动 ↑/↓");
  });

  it("显示 topology 过滤器可操作项与 N-of-M / 空闲帧", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });

    const output = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(output).toContain("/ 过滤智能体…");
    expect(output).toMatch(/\d+ 个席位 · \d+ 工作中 · \d+ 需要关注 · \d+ 行打开/);
  });

  it("渲染 agent runtime/resources，并让每个 used-by rig 成为真实反向链接", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: [{ name: "adversarial-review", kind: "rig", agentRefs: ["independent-reviewer"] }, {
        name: "independent-reviewer",
        kind: "agent",
        runtime: "claude-code",
        skills: ["using-superpowers", "openrig-user", "mission-slice-sop", "review-team", "systematic-debugging", "verification-before-completion", "writing-plans", "brainstorming"],
        profiles: ["default"],
        resources: {
          skills: ["review-team"], guidance: ["guidance/role.md"], plugins: ["openrig-core"], subagents: ["reviewer"],
        },
        usedByRigs: ["adversarial-review"],
      }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "spec", name: "independent-reviewer" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const output = screen.lines.join("\n");
    expect(output).toMatch(/运行时:\s+claude-code/);
    expect(output).toContain("brainstorming");
    expect(output).toMatch(/资源:\s+guidance guidance\/role\.md · plugins openrig-core · subagents reviewer/);
    const usedY = screen.lines.findIndex((line) => line.includes("工作组 adversarial-review")) + 1;
    expect(screen.hitMap).toContainEqual(expect.objectContaining({
      y: usedY,
      action: { type: "drill", resource: "spec", name: "adversarial-review" },
    }));
  });

  it("显示 specs 过滤器可操作项并按文件夹命名空间分组 agent specs", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: [
        { name: "independent-reviewer", kind: "agent", namespace: "review" },
        { name: "orchestrator", kind: "agent", namespace: "orchestration" },
      ],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "specs" });
    view.dispatch({ type: "toggle-expand", key: "specs-kind:agent" });

    const output = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(output).toContain("/ 过滤规范…");
    expect(output).toContain("review/");
    expect(output).toContain("orchestration/");
  });
});
