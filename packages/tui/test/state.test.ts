import { describe, expect, it } from "vitest";
import { agentsRunningSpec, createViewState, defaultSections } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { NeedsItem, SectionDef } from "../src/types.js";

const snap = demoSnapshot();
const withSnap = { getSnapshot: () => snap };

describe("单一实例级视图状态（PIN 1，FR-12/13）", () => {
  it("按实例作用域：两实例绝不共享状态（FR-13 负向 AC）", () => {
    const a = createViewState({ instanceId: "tui-a", ...withSnap });
    const b = createViewState({ instanceId: "tui-b", ...withSnap });
    a.dispatch({ type: "jump", section: "specs" });
    expect(a.get().section).toBe("specs");
    expect(b.get().section).toBe("topology");
    expect(a.get().instanceId).toBe("tui-a");
    expect(b.get().instanceId).toBe("tui-b");
  });

  it("把区段集保持为单一代码内 registry：加区段是局部编辑（FR-12 负向 AC）", () => {
    const extra: SectionDef = { name: "extra", sourceRead: "GET /api/ps (existing read)", drillShape: "flat" };
    const s = createViewState({ instanceId: "t", sections: [...defaultSections(), extra], ...withSnap });
    expect(s.dispatch({ type: "jump", section: "extra" }).section).toBe("extra");
  });

  it("经命令到达每个已注册视图（R1.2 构造上可驱动）", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    for (const sec of s.get().sections) {
      s.dispatch({ type: "jump", section: sec.name });
      expect(s.get().section).toBe(sec.name);
    }
  });

  it("drill 到已知 agent；未知目标在 state 中是命名错误", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.driver" });
    expect(s.get().section).toBe("topology");
    expect(s.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.driver" });
    expect(s.get().lastError).toBeNull();

    s.dispatch({ type: "drill", resource: "agent", name: "nobody.here" });
    expect(s.get().lastError).toMatch(/无此智能体 "nobody\.here"/);
  });

  it("拒绝歧义 fleet 简写，接受精确 scoped agent 目标", () => {
    const duplicate = demoSnapshot();
    duplicate.hosts[0]!.rigs.push({
      name: "other-rig",
      pods: [{ name: "dev50", agents: [{ name: "dev50.qa", runtime: "codex", spec: "qa-agent", context: null, tokens: null, status: "idle", live: true }] }],
    });
    const s = createViewState({ instanceId: "t", getSnapshot: () => duplicate });
    expect(s.dispatch({ type: "drill", resource: "agent", name: "dev50.qa" }).lastError).toMatch(/智能体歧义/);
    expect(s.dispatch({
      type: "drill",
      resource: "agent",
      name: "dev50.qa",
      target: { host: "vm-host", rig: "other-rig", pod: "dev50" },
    }).drill.map((part) => part.name)).toEqual(["vm-host", "other-rig", "dev50", "dev50.qa"]);
    expect(s.dispatch(parseCommand("agent vm-host/openrig-build/dev50/dev50.qa")).drill.map((part) => part.name))
      .toEqual(["vm-host", "openrig-build", "dev50", "dev50.qa"]);
  });

  it("cross-nav spec-of：运行中 agent → 其 agent spec", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "cross", kind: "spec-of", name: "dev50.driver" });
    expect(s.get().section).toBe("specs");
    expect(s.get().drill.at(-1)).toEqual({ kind: "spec", name: "driver-agent" });
  });

  it("cross-nav running：spec → 限定到其席的 topology", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "cross", kind: "running", name: "driver-agent" });
    expect(s.get().section).toBe("topology");
    expect(s.get().runningOf).toBe("driver-agent");
  });

  it("把 spec 反向导航过滤到真正 live 的席", () => {
    const copy = demoSnapshot();
    copy.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!.live = false;
    expect(agentsRunningSpec(copy, "driver-agent")).toEqual([]);
  });

  it("缺失 spec-of 目标时保留原位并给命名错误", () => {
    const copy = demoSnapshot();
    copy.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!.spec = "materialized-only";
    const s = createViewState({ instanceId: "t", getSnapshot: () => copy });
    const before = s.get().section;
    const next = s.dispatch({ type: "cross", kind: "spec-of", name: "dev50.driver" });
    expect(next.section).toBe(before);
    expect(next.lastError).toMatch(/规范 .*不在库中/);
  });

  it("拒绝当前内容上下文中不存在的 tab", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    expect(s.dispatch({ type: "tab", tab: "yaml" }).lastError).toMatch(/不可用/);
    s.dispatch({ type: "drill", resource: "spec", name: "openrig-build-rig" });
    expect(s.dispatch({ type: "tab", tab: "yaml" }).lastError).toBeNull();
  });

  it("过滤当前视图，空文本清除", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "filter", text: "dev50" });
    expect(s.get().filter).toBe("dev50");
    s.dispatch({ type: "filter", text: "" });
    expect(s.get().filter).toBe("");
  });

  it("在 state 中约束 content 滚动，使 PageUp 立即从底移动", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "layout", contentMaxOffset: 15, contentTargetCount: 0 });
    for (let i = 0; i < 20; i++) s.dispatch({ type: "content-scroll", delta: 10 });
    expect(s.get().contentOffset).toBe(15);
    s.dispatch({ type: "content-scroll", delta: -10 });
    expect(s.get().contentOffset).toBe(5);
  });

  it("对空快照渲染诚实空：错误点出缺失，不伪造任何东西", () => {
    const s = createViewState({ instanceId: "t" }); // default emptySnapshot
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.driver" });
    expect(s.get().lastError).toMatch(/无此智能体/);
    expect(s.get().drill).toEqual([]);
  });

  it("仅经 registry 数据变更 needs 快照（无隐藏全局）", () => {
    const localNeeds: NeedsItem[] = [{ source: "derived", kind: "idle-with-work", target: "x", detail: "d" }];
    const s = createViewState({
      instanceId: "t",
      getSnapshot: () => ({ ...demoSnapshot(), needs: localNeeds }),
    });
    s.dispatch({ type: "jump", section: "needs" });
    expect(s.get().section).toBe("needs");
  });
});
