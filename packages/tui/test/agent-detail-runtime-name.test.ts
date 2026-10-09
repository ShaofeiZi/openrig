// a4c9548a——S19 后续 founder 裁决（绑定，界定 S19 marks 裁决）：
// 图标是装饰或用于无空间场景；有空间处则写出名字——
// 图标绝不替代文本作为值。agent-DETAIL 页有空间，故其
// runtime 字段须把 runtime 名字渲染为文本（claude-code / codex / ...）；
// 标记可装饰性伴随，但绝不替代值。topology 卡（空间受限）保留其标记——
// 裁决是界定而非反转（见 topology-view / navigator-reskin 套件，本修复未触及）。(qitem a4c9548a)
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";

function renderAgentDetail(name: string): string {
  const snap = demoSnapshot();
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  view.dispatch({
    type: "drill",
    resource: "agent",
    name,
    target: { host: "vm-host", rig: "openrig-build", pod: "dev50" },
  });
  return renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
}

describe("agent-detail runtime 字段把 NAME 渲染为值（founder 规则 a4c9548a）", () => {
  it("claude-code agent 的 runtime 字段把 `claude-code` 显示为 TEXT——名称即值，不只是标记", () => {
    const out = renderAgentDetail("dev50.driver");
    expect(out).toMatch(/运行时:\s+claude-code/);
  });

  it("codex agent 的 runtime 字段把 `codex` 显示为 TEXT", () => {
    const out = renderAgentDetail("dev50.guard");
    expect(out).toMatch(/运行时:\s+codex/);
  });
});
