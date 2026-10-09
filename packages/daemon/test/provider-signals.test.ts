import { describe, it, expect } from "vitest";
import {
  codexRateLimitSignals,
  deriveUsageLimitPools,
  reactiveEventSignal,
} from "../src/domain/provider/provider-signals.js";

// Slice-04（OPR.0.5.0.4）——signals[] 规范化及 §1 契约的如实规则
//（数据包 3ffa3c22 IMPLEMENTATION-PRD §1/§2 + 2026-07-31 RESEARCH 裁决）。
// 关键反例（BR-2 种子）：缺失/不受支持的读数必须是显式 `unknown` 行，绝不是静默零值，
// 也绝不能缺行。

const ASOF = "2026-08-03T12:00:00.000Z";
const RESET = "2026-08-03T17:00:00.000Z";

describe("codexRateLimitSignals——如实规范化", () => {
  it("功能探测反例恰好产生一条显式 unknown 行（不是静默零值，也不是空结果）", () => {
    const sigs = codexRateLimitSignals({
      accountRef: "acct-1",
      probe: { supported: false },
      asOf: ASOF,
    });
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s.provider).toBe("codex");
    expect(s.accountRef).toBe("acct-1");
    expect(s.sourceClass).toBe("unknown");
    expect(s.authority).toBe("unknown");
    expect(s.unknownReason).toBeTruthy();
    // 静默零值陷阱：usedPercent 必须缺省，绝不能默认为 0。
    expect(s.usedPercent).toBeUndefined();
    expect(s.resetsAt).toBeUndefined();
    // BR-2：unknown 信号绝不能用于自动化。
    expect(s.automationUse).toBe("do_not_automate");
    // App server 缺失 → 无通知传输能力。
    expect(s.supportsNotification).toBe(false);
    expect(s.asOf).toBe(ASOF);
  });

  it("保留真实读数中的真正零值（0 是真实数据，不同于缺省 unknown）", () => {
    const sigs = codexRateLimitSignals({
      accountRef: "acct-1",
      probe: { supported: true },
      reading: {
        // usedPercent 0 是真实读数（新鲜窗口、未使用）——必须保留为 0。
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: RESET },
        secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: RESET },
      },
      asOf: ASOF,
    });
    const primary = sigs.find((s) => s.window === "primary");
    expect(primary).toBeDefined();
    expect(primary!.sourceClass).toBe("provider_structured_read");
    expect(primary!.authority).toBe("account_cross_device");
    // 保留真正零值（不缺省，也不视为 unknown）。
    expect(primary!.usedPercent).toBe(0);
    expect(primary!.resetsAt).toBe(RESET);
    expect(primary!.windowDurationMins).toBe(300);
    // Codex app server 提供更新通知；结构化读数可用于自动化。
    expect(primary!.supportsNotification).toBe(true);
    expect(primary!.automationUse).toBe("allow_switch_decision");
    // 保留 provider 原生次级窗口，不进行合并。
    const secondary = sigs.find((s) => s.window === "secondary");
    expect(secondary).toBeDefined();
    expect(secondary!.usedPercent).toBe(88);
  });

  it("受支持但为空的读数降级为 unknown 数据，同时保留已知传输能力", () => {
    const sigs = codexRateLimitSignals({
      accountRef: "acct-1",
      probe: { supported: true },
      reading: {},
      asOf: ASOF,
    });
    expect(sigs).toHaveLength(1);
    expect(sigs[0].sourceClass).toBe("unknown");
    // 仍不伪造零值。
    expect(sigs[0].usedPercent).toBeUndefined();
    expect(sigs[0].automationUse).toBe("do_not_automate");
    // app server 确实存在，因此 account/rateLimits/updated 能力已知为 true——unknown
    // 数据不得抹除已知传输能力。
    expect(sigs[0].supportsNotification).toBe(true);
  });
});

describe("S16 用量限制池推导", () => {
  const NOW = new Date("2026-08-28T12:00:00.000Z");

  it("将所有 Claude 席位归入同一本地限制，并保留声明的最晚重置时间", () => {
    const pools = deriveUsageLimitPools({
      now: NOW,
      fallbackSeconds: 300,
      bindings: [],
      signals: [
        {
          provider: "claude",
          seatSession: "dev-a@rig",
          sourceClass: "provider_statusline",
          authority: "account_cross_device",
          window: "five_hour",
          usedPercent: 100,
          resetsAt: "2026-08-28T13:00:00.000Z",
          asOf: "2026-08-28T11:59:00.000Z",
          staleAfter: "2026-08-28T12:10:00.000Z",
          supportsNotification: false,
          automationUse: "allow_switch_decision",
        },
        {
          provider: "claude",
          seatSession: "dev-b@rig",
          sourceClass: "provider_statusline",
          authority: "account_cross_device",
          window: "five_hour",
          usedPercent: 72,
          resetsAt: "2026-08-28T13:00:00.000Z",
          asOf: "2026-08-28T11:59:00.000Z",
          staleAfter: "2026-08-28T12:10:00.000Z",
          supportsNotification: false,
          automationUse: "allow_switch_decision",
        },
      ],
    });

    expect(pools).toEqual([
      {
        poolKey: "claude:local",
        provider: "claude",
        seatSessions: ["dev-a@rig", "dev-b@rig"],
        expiresAt: "2026-08-28T13:00:00.000Z",
        source: "provider-reset",
      },
    ]);
  });

  it("对无重置时间的新鲜 Codex 到限事件，使用信号 as-of 加配置回退值", () => {
    const pools = deriveUsageLimitPools({
      now: NOW,
      fallbackSeconds: 300,
      bindings: [
        {
          accountId: "acct-codex-1",
          seatSession: "dev-c@rig",
          rigName: "rig",
          boundAt: "2026-08-28T08:00:00.000Z",
          bindingSource: "fixture",
          anomalies: [],
        },
      ],
      signals: [reactiveEventSignal({
        provider: "codex",
        accountRef: "acct-codex-1",
        kind: "at_limit",
        asOf: "2026-08-28T11:59:00.000Z",
        staleAfter: "2026-08-28T12:10:00.000Z",
      })],
    });

    expect(pools).toEqual([
      {
        poolKey: "codex:acct-codex-1",
        provider: "codex",
        seatSessions: ["dev-c@rig"],
        expiresAt: "2026-08-28T12:04:00.000Z",
        source: "config-fallback",
      },
    ]);
  });

  it("绝不根据 unknown、建议性、过期或已失效证据猜测用量限制", () => {
    const pools = deriveUsageLimitPools({
      now: NOW,
      fallbackSeconds: 300,
      bindings: [],
      signals: [
        {
          provider: "claude",
          seatSession: "unknown@rig",
          sourceClass: "unknown",
          authority: "unknown",
          asOf: "2026-08-28T11:59:00.000Z",
          staleAfter: "2026-08-28T12:10:00.000Z",
          unknownReason: "no_reading",
          automationUse: "do_not_automate",
        },
        {
          provider: "claude",
          seatSession: "stale@rig",
          sourceClass: "provider_statusline",
          authority: "account_cross_device",
          usedPercent: 100,
          resetsAt: "2026-08-28T13:00:00.000Z",
          asOf: "2026-08-28T11:00:00.000Z",
          staleAfter: "2026-08-28T11:30:00.000Z",
          automationUse: "allow_switch_decision",
        },
      ],
    });

    expect(pools).toEqual([]);
  });
});
