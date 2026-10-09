import { describe, it, expect } from "vitest";
import { resolveCrashCartKey } from "../src/crash-cart/keys.js";
import type { CrashCartRenderOpts } from "../src/crash-cart/from-emit.js";
import type { CrashCartModel } from "../src/crash-cart/crash-cart-model.js";

// Crash-cart C3 后续——cockpit 动作键，以 daemon-down 屏激活为门。
// RESOLVER 纯（键 + 屏状态 → 动作）；main.ts 执行动作（exec / re-probe）。RESTORE
//（⏎）路由到 C1 批量 conductor——本波排除，故解析为带标签的缝，绝非
// 静默 no-op。键按模式不同：recovery cockpit 提供 restore/inspect；first-run 仅 onboarding+start。

const opts = (daemonState?: "down" | "unverified", mode?: CrashCartModel["mode"]): CrashCartRenderOpts =>
  daemonState === "down"
    ? { daemonState, crashCart: { mode: mode ?? "recovery", header: { lastSeen: "", uptimeText: "", reasonText: "" }, foundOnHost: [], whereWorkStopped: [] } }
    : daemonState === "unverified"
      ? { daemonState, daemonEvidence: { pidState: "", probeResult: "", failedSignal: "" } }
      : {};

describe("resolveCrashCartKey——驾驶舱动作键（daemon-down 门控）", () => {
  it("recovery 驾驶舱：s/i/n/enter → start-daemon/inspect/onboarding/restore", () => {
    expect(resolveCrashCartKey("s", opts("down", "recovery"))).toBe("start-daemon");
    expect(resolveCrashCartKey("i", opts("down", "recovery"))).toBe("inspect");
    expect(resolveCrashCartKey("n", opts("down", "recovery"))).toBe("onboarding");
    expect(resolveCrashCartKey("enter", opts("down", "recovery"))).toBe("restore");
  });

  it("H2：⏎ 咨询一键 gate——零代（所有席位可恢复）→ 直接恢复", () => {
    const zeroGen: CrashCartRenderOpts = {
      daemonState: "down",
      crashCart: {
        mode: "recovery",
        header: { lastSeen: "", uptimeText: "", reasonText: "" },
        foundOnHost: [{ name: "kernel", seatCount: 4, resumableCount: 4, lastActive: "" }],
        whereWorkStopped: [],
      },
    };
    expect(resolveCrashCartKey("enter", zeroGen)).toBe("restore");
  });

  it("H2：⏎ 有不可恢复席位 → restore-confirm（非静默一键）", () => {
    const withDelta: CrashCartRenderOpts = {
      daemonState: "down",
      crashCart: {
        mode: "recovery",
        header: { lastSeen: "", uptimeText: "", reasonText: "" },
        foundOnHost: [
          { name: "kernel", seatCount: 4, resumableCount: 4, lastActive: "" },
          { name: "openrig-pm", seatCount: 13, resumableCount: 7, lastActive: "" }, // 6 non-resumable
        ],
        whereWorkStopped: [],
      },
    };
    expect(resolveCrashCartKey("enter", withDelta)).toBe("restore-confirm");
  });

  it("首次运行：仅 start-daemon + onboarding（无恢复空对象、无 inspect）", () => {
    expect(resolveCrashCartKey("s", opts("down", "first-run"))).toBe("start-daemon");
    expect(resolveCrashCartKey("n", opts("down", "first-run"))).toBe("onboarding");
    expect(resolveCrashCartKey("enter", opts("down", "first-run"))).toBeNull();
    expect(resolveCrashCartKey("i", opts("down", "first-run"))).toBeNull();
  });

  it("UNVERIFIED：r → 重试（重新探测）；无恢复动作", () => {
    expect(resolveCrashCartKey("r", opts("unverified"))).toBe("retry");
    expect(resolveCrashCartKey("s", opts("unverified"))).toBeNull();
    expect(resolveCrashCartKey("enter", opts("unverified"))).toBeNull();
  });

  it("常规 TUI（无 daemon-down 屏）：每键 → null（键落回常规处理）", () => {
    for (const k of ["s", "i", "n", "r", "enter"]) expect(resolveCrashCartKey(k, opts())).toBeNull();
  });
});
