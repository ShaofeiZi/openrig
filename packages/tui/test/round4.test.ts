import { describe, expect, it } from "vitest";
import { createViewState, computeExplorerRows, locationKey } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot } from "../src/types.js";

// Founder round-4 锚点：explorer 选择同步 + 光标稳定（item 2）、
// topology（item 4）与 specs（item 3）默认展开。

const snap = demoSnapshot();

function fresh() {
  return createViewState({ instanceId: "t", getSnapshot: () => snap });
}

describe("topology 默认展开（item 4）：rigs+pods 可见，agent 按需", () => {
  it("隐藏 agent 直到其 pod 展开", () => {
    const s = fresh();
    const labels = computeExplorerRows(s.get(), snap).map((r) => r.label);
    expect(labels.some((l) => l.includes("dev50 ("))).toBe(true);
    expect(labels.some((l) => l.includes("dev50.driver"))).toBe(false);
    expect(labels.find((l) => l.includes("dev50 ("))).toContain("▸");
  });

  it("drill pod 展开它且光标落在 pod 行上", () => {
    const s = fresh();
    s.dispatch(parseCommand("pod dev50"));
    const rows = computeExplorerRows(s.get(), snap);
    expect(rows.map((r) => r.label).some((l) => l.includes("dev50.driver"))).toBe(true);
    expect(rows[s.get().selection]?.key).toBe("pod:vm-host/openrig-build/dev50");
  });
});

describe("选择同步 + 光标稳定（item 2）", () => {
  it("content 窗格 drill 在 explorer 高亮 agent（auto-expand 其 pod）", () => {
    const s = fresh();
    s.dispatch(parseCommand("rig openrig-build"));
    // 模拟 table 行点击动作形状
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.guard", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const rows = computeExplorerRows(s.get(), snap);
    expect(rows[s.get().selection]?.key).toBe("agent:vm-host/openrig-build/dev50/dev50.guard");
  });

  it("导航链中光标绝不重置到顶", () => {
    const s = fresh();
    const positions: number[] = [];
    for (const cmd of ["rig openrig-build", "pod dev50", "agent dev50.qa", "spec-of dev50.qa"]) {
      s.dispatch(parseCommand(cmd));
      positions.push(s.get().selection);
    }
    // 每步导航落在真实行（非顶部）并匹配位置
    for (const pos of positions) expect(pos).toBeGreaterThan(0);
    expect(computeExplorerRows(s.get(), snap)[s.get().selection]?.key).toBe(locationKey(s.get()));
  });

  it("跨导航 spec-of 把光标落到 spec 行（文件夹 auto-expand）", () => {
    const s = fresh();
    s.dispatch(parseCommand("spec-of dev50.driver"));
    const rows = computeExplorerRows(s.get(), snap);
    expect(rows[s.get().selection]?.key).toBe("spec:driver-agent");
  });
});

describe("过滤器按视图作用域（founder direct-drive catch）", () => {
  it("specs 过滤器绝不跨区段 drill 漏进 topology 表", () => {
    const s = fresh();
    s.dispatch(parseCommand(":specs"));
    s.dispatch(parseCommand("/independent-reviewer"));
    s.dispatch(parseCommand("rig openrig-build"));
    expect(s.get().section).toBe("topology");
    expect(s.get().filter).toBe("");
  });

  it("同区段 drill 保留过滤器（topology rig → pod）", () => {
    const s = fresh();
    s.dispatch(parseCommand("rig openrig-build"));
    s.dispatch(parseCommand("/dev50"));
    s.dispatch(parseCommand("pod dev50"));
    expect(s.get().filter).toBe("dev50");
  });

  it("跨区段 cross-nav 也清过滤器（spec-of）", () => {
    const s = fresh();
    s.dispatch(parseCommand("rig openrig-build"));
    s.dispatch(parseCommand("/dev50"));
    s.dispatch(parseCommand("spec-of dev50.driver"));
    expect(s.get().section).toBe("specs");
    expect(s.get().filter).toBe("");
  });
});

describe("带嵌套 agent 文件夹的 Specs kind 展示", () => {
  const nsSnap: FleetSnapshot = {
    ...snap,
    specs: [
      { name: "rig-a", kind: "rig" },
      { name: "rig-b", kind: "rig" },
      { name: "rev-1", kind: "agent", namespace: "review" },
      { name: "rev-2", kind: "agent", namespace: "review" },
      { name: "orch-1", kind: "agent", namespace: "orchestration" },
    ],
  };

  it("先显示 kind 组，再显示每个 rig spec，打开时折叠 agent 文件夹", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => nsSnap });
    s.dispatch(parseCommand(":specs"));
    expect(computeExplorerRows(s.get(), nsSnap).some(r => r.key?.startsWith("spec:"))).toBe(false);
    s.dispatch({ type: "toggle-expand", key: "specs-kind:rig" });
    s.dispatch({ type: "toggle-expand", key: "specs-kind:agent" });
    const labels = computeExplorerRows(s.get(), nsSnap).map((r) => r.label);
    expect(labels.some((l) => l.includes("rig-a"))).toBe(true);
    expect(labels.some((l) => l.includes("rig-b"))).toBe(true);
    expect(labels.some((l) => l.includes("review/ (2)"))).toBe(true);
    expect(labels.some((l) => l.includes("rev-1"))).toBe(false);
  });

  it("切换文件夹显示其 specs；再切换折叠", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => nsSnap });
    s.dispatch(parseCommand(":specs"));
    s.dispatch({ type: "toggle-expand", key: "specs-kind:agent" });
    s.dispatch({ type: "toggle-expand", key: "folder:review" });
    let labels = computeExplorerRows(s.get(), nsSnap).map((r) => r.label);
    expect(labels.some((l) => l.includes("rev-1"))).toBe(true);
    s.dispatch({ type: "toggle-expand", key: "folder:review" });
    labels = computeExplorerRows(s.get(), nsSnap).map((r) => r.label);
    expect(labels.some((l) => l.includes("rev-1"))).toBe(false);
  });

  it("live 过滤器覆盖折叠，使匹配始终可见", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => nsSnap });
    s.dispatch(parseCommand(":specs"));
    s.dispatch(parseCommand("/rev"));
    const labels = computeExplorerRows(s.get(), nsSnap).map((r) => r.label);
    expect(labels.some((l) => l.includes("rev-1"))).toBe(true);
  });
});
