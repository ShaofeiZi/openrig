// LEG-7 LOW 2——dead-arm 清理（fold-wave qitem 79159e6f）。icon-fix QA（5a70e200，review50-r1）
// 发现 agent-detail runtime 字段的 `?? "— (未服务)"` 占位符经生产 API
// 不可达：daemon 在 null runtime 跨线前把它强制为字符串 "未知"
//（whoami-service.ts 及兄弟文件），故 render.ts 永不见 null runtime。把防御
// 回退重指到 "未知" 以匹配该强制——诚实（实际渲染），消除误导的
// 死 "— (未服务)" 臂，并钉住此前未钉的 null-runtime 情形（icon-fix guard 的
// 常驻建议）。
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

describe("agent-detail runtime 回退 = 与 daemon 一致的 `unknown`，绝不出现失效的 `— (未服务)` (LEG-7 LOW 2)", () => {
  it("runtime 缺失的 agent 渲染 `runtime: unknown`——绝不 `— (未服务)`", () => {
    const snap = structuredClone(demoSnapshot()) as FleetSnapshot;
    // 强制触发类型禁止、但防御臂处理的 absent-runtime 情形（daemon 本会
    // 已把它强制为 "未知"；这里我们直接驱动渲染层）。
    const agent = snap.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!;
    (agent as { runtime?: string }).runtime = undefined;

    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({
      type: "drill",
      resource: "agent",
      name: agent.name,
      target: { host: "vm-host", rig: "openrig-build", pod: "dev50" },
    });
    const lines = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines;
    // 范围限定到 RUNTIME 行——兄弟 `cwd:` 字段对缺失工作目录
    // 合法渲染 "— (未服务)"（占位符的另一诚实用法，我们不动）。
    const runtimeLine = lines.find((l) => l.includes("运行时:"))!;

    expect(runtimeLine).toMatch(/运行时:\s+未知/); // matches the daemon's null→"未知" coercion
    expect(runtimeLine).not.toContain("— (未服务)"); // the misleading dead RUNTIME placeholder is gone
  });
});
