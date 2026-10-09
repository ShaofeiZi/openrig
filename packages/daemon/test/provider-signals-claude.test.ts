import { describe, it, expect } from "vitest";
import { claudeStatuslineSignals } from "../src/domain/provider/provider-signals.js";

// Slice-04（OPR.0.5.0.4）——Claude statusline 通道归一化（§2 Claude 通道及 2026-07-31
// RESEARCH 裁定）。证明项 6：statusline sidecar 的 rate_limits 对象（Pro/Max 五小时和七天窗口）
// 转为 provider_statusline 行；ABSENT 情况（首次 API 响应前尚无缓存）转为带 unknownReason 的显式
// unknown 行——绝不静默写零，也绝不缺行。方案 A 按 SEAT 定键：Claude statusline 不公开账户身份，
// 因此排除 accountRef/api-key/org。

const ASOF = "2026-08-03T12:00:00.000Z";
const RESET = "2026-08-03T17:00:00.000Z";

describe("claudeStatuslineSignals——Claude 通道真实性", () => {
  it("首次 API 响应前（尚无缓存）的 Claude 席位产生按席位定键的显式 unknown 行", () => {
    const sigs = claudeStatuslineSignals({
      seatSession: "dev-impl@rig",
      cachePresent: false,
      asOf: ASOF,
    });
    expect(sigs).toHaveLength(1);
    expect(sigs[0].provider).toBe("claude");
    expect(sigs[0].seatSession).toBe("dev-impl@rig");
    expect(sigs[0].accountRef).toBeUndefined();
    expect(sigs[0].sourceClass).toBe("unknown");
    expect(sigs[0].authority).toBe("unknown");
    expect(sigs[0].unknownReason).toBeTruthy();
    expect(sigs[0].usedPercent).toBeUndefined();
    expect(sigs[0].automationUse).toBe("do_not_automate");
    expect(sigs[0].supportsNotification).toBe(false);
    expect(sigs[0].asOf).toBe(ASOF);
  });

  it("Pro/Max statusline 读数为 five_hour 和 weekly（七天）生成 provider_statusline 行", () => {
    const sigs = claudeStatuslineSignals({
      seatSession: "dev-impl@rig",
      cachePresent: true,
      reading: {
        five_hour: { usedPercent: 12, resetsAt: RESET },
        seven_day: { usedPercent: 0, resetsAt: RESET }, // 真实零值必须保留为 0。
      },
      asOf: ASOF,
    });
    const fiveHour = sigs.find((s) => s.window === "five_hour");
    expect(fiveHour).toBeDefined();
    expect(fiveHour!.sourceClass).toBe("provider_statusline");
    expect(fiveHour!.authority).toBe("account_cross_device");
    expect(fiveHour!.seatSession).toBe("dev-impl@rig");
    expect(fiveHour!.accountRef).toBeUndefined();
    expect(fiveHour!.usedPercent).toBe(12);
    expect(fiveHour!.resetsAt).toBe(RESET);
    expect(fiveHour!.supportsNotification).toBe(false);
    expect(fiveHour!.automationUse).toBe("allow_switch_decision");
    // seven-day 映射到归一化的 "weekly" 窗口；真实零值保留为 0。
    const weekly = sigs.find((s) => s.window === "weekly");
    expect(weekly).toBeDefined();
    expect(weekly!.usedPercent).toBe(0);
  });

  it("存在缓存但没有窗口的订阅降级为显式 unknown 行", () => {
    const sigs = claudeStatuslineSignals({
      seatSession: "dev-impl@rig",
      cachePresent: true,
      reading: {},
      asOf: ASOF,
    });
    expect(sigs).toHaveLength(1);
    expect(sigs[0].sourceClass).toBe("unknown");
    expect(sigs[0].usedPercent).toBeUndefined();
    expect(sigs[0].automationUse).toBe("do_not_automate");
  });
});
