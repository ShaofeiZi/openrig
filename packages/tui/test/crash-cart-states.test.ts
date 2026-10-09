import { describe, it, expect } from "vitest";
import { buildCrashCartModel, type CrashCartDiscoveryInput } from "../src/crash-cart/crash-cart-model.js";
import { renderCrashCartView, renderUnverifiedView } from "../src/crash-cart/render-crash-cart.js";

// Crash-cart（裁决）——两种非 DOWN 框架；内容级（in-shell 包装由
// crash-cart-in-shell.test.ts 覆盖）：
//  UNVERIFIED = 证据原文 + retry + quit，零恢复动作。
//  FIRST-RUN = DOWN + 未发现 DB（无 rig、无既往活动）→ onboarding 框架，绝非 crash 故事。

describe("renderUnverifiedView——无法验证内容（不提供恢复）", () => {
  const body = renderUnverifiedView({
    pidState: "alive (pid 4242)",
    probeResult: "timeout",
    failedSignal: "healthz timed out after 3 probes",
  })
    .map((l) => l.text)
    .join("\n");

  it("命名为未确认已停止，并逐字展示证据", () => {
    expect(body).toContain("无法验证后台服务");
    expect(body).toContain("未确认已停止");
    expect(body).toContain("alive (pid 4242)");
    expect(body).toContain("timeout");
    expect(body).toContain("healthz timed out after 3 probes");
  });

  it("提供 重试 + 退出 + rig-status 提示，无恢复动作", () => {
    expect(body).toContain("r 重试");
    expect(body).toContain("q 退出");
    expect(body).toContain("zrig status");
    expect(body).not.toContain("恢复全部");
  });
});

describe("buildCrashCartModel——first-run 与 recovery 模式", () => {
  const withRigs: CrashCartDiscoveryInput = {
    header: { lastActivityAt: "2026-08-06T08:12:00Z" },
    foundOnHost: [{ rigName: "alpha", seatCount: 2, resumableCount: 2, lastActiveAt: "2026-08-06T08:00:00Z" }],
    whereWorkStopped: [],
  };
  const empty: CrashCartDiscoveryInput = { header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] };

  it("有先前活动证据（rigs 和/或最后活动）时为 recovery 模式", () => {
    expect(buildCrashCartModel(withRigs).mode).toBe("recovery");
  });

  it("无 rig 且无先前活动时为 first-run 模式（DOWN + 无 DB）", () => {
    expect(buildCrashCartModel(empty).mode).toBe("first-run");
  });
});

describe("renderCrashCartView——first-run 框架是引导，绝非崩溃叙事", () => {
  const firstRun = buildCrashCartModel({ header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] });
  const body = renderCrashCartView(firstRun).map((l) => l.text).join("\n");

  it("显示引导框架，无崩溃头，无恢复空对象", () => {
    expect(body).not.toContain("后台服务未运行");
    expect(body).not.toContain("恢复全部");
    expect(body).toContain("引导");
    expect(body).toMatch(/尚未找到工作组|首次运行|无可恢复内容|新用户/);
  });

  it("recovery 框架仍显示崩溃头 + 恢复全部（不变）", () => {
    const rec = buildCrashCartModel({
      header: { lastActivityAt: "2026-08-06T08:12:00Z" },
      foundOnHost: [{ rigName: "alpha", seatCount: 2, resumableCount: 2, lastActiveAt: "2026-08-06T08:00:00Z" }],
      whereWorkStopped: [],
    });
    const rb = renderCrashCartView(rec).map((l) => l.text).join("\n");
    expect(rb).toContain("◌ 后台服务未运行");
    expect(rb).toContain("⏎ 恢复全部");
  });
});
