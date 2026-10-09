import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoCrashCartModel } from "../src/crash-cart/crash-cart-model.js";

// Crash-cart C3（SUB-3b）——renderScreen 按 RenderOptions 携带的解析信号
// dispatch 到 daemon-down 屏。DOWN → cockpit；UNVERIFIED → 独立 cannot-verify 屏；缺省
// （UP / normal）→ fleet 视图不动。cockpit 仅 DOWN；UNVERIFIED 绝不提供 restore。

const snap = emptySnapshot();
const view = createViewState({ instanceId: "t", getSnapshot: () => snap });

describe("renderScreen——daemon-down 分发", () => {
  it("DOWN → crash-cart 驾驶舱（恢复全部 + daemon-down 头）", () => {
    const body = renderScreen(view.get(), snap, { daemonState: "down", crashCart: demoCrashCartModel() }).lines.join("\n");
    expect(body).toContain("◌ 后台服务未运行");
    expect(body).toContain("⏎ 恢复全部");
  });

  it("UNVERIFIED → 无法验证界面；不提供恢复", () => {
    const body = renderScreen(view.get(), snap, {
      daemonState: "unverified",
      daemonEvidence: { pidState: "alive (pid 7)", probeResult: "timeout", failedSignal: "healthz timed out" },
    }).lines.join("\n");
    expect(body).toContain("无法验证后台服务");
    expect(body).toContain("alive (pid 7)");
    expect(body).not.toContain("恢复全部");
  });

  it("缺省 daemonState（UP/正常）→ fleet 视图，无驾驶舱", () => {
    const body = renderScreen(view.get(), snap, {}).lines.join("\n");
    expect(body).not.toContain("恢复全部");
    expect(body).not.toContain("无法验证后台服务");
  });
});
