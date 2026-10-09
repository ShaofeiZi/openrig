// TUI 纯产品渲染 harness（s_000cae46wD0 batch2）——仅调用 packages/tui/dist 已编译产物，
// 不改 TUI 源码，无 daemon。等验证者完成含 text-width 的 build 后运行：
//   node .codex/translation/review-2026-10-08-batch2/tui-render-harness.mjs
// 输出 screen.lines 到 stdout，供真实 Terminal 窗口截图目视。
import { demoSnapshot } from "../../../packages/tui/dist/demo-data.js";
import { createViewState } from "../../../packages/tui/dist/state.js";
import { renderScreen } from "../../../packages/tui/dist/render.js";

function render(label, setup, cols = 140, rows = 34) {
  const snap = demoSnapshot();
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  setup(view);
  const screen = renderScreen(view.get(), snap, { cols, rows });
  console.log("\n===== " + label + " (" + cols + "x" + rows + ") =====");
  for (const line of screen.lines) console.log(line);
}

// 1) rig drill -> 席位 fleet 视图
render("rig-drill:openrig-build", (view) => {
  view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });
});

// 2) topology 视图（tab action topology 可切）
render("topology", (view) => {
  view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });
  view.dispatch({ type: "tab", tab: "topology" });
});
