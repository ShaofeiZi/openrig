import { describe, it, expect } from "vitest";
import { assembleFourBlock } from "../src/domain/provider/provider-read-model.js";
import type { ProviderAccount, ProviderSignal } from "../src/domain/provider/provider-types.js";

// 切片 04（OPR.0.5.0.4）——四块组装（证明项 4，单元结构）。这是针对已收集
// accounts/rawBindings/signals 的纯组装器：发出真实绑定行与显式未绑定行
//（seat_with_no_account），仅根据重复的真实 account ID 计算 same_account_on_n_seats，
// 原样保留 signals，不虚构任何内容。

const ASOF = "2026-08-03T12:00:00.000Z";

// 混合 provider 账户集：2 个 codex（托管，已设置 profileRef）+ 1 个 claude（未托管，null）。
const ACCOUNTS: ProviderAccount[] = [
  { accountId: "cdx-a", label: "Codex A", provider: "codex", authState: "active", profileRef: "prof-a", asOf: ASOF },
  { accountId: "cdx-b", label: "Codex B", provider: "codex", authState: "needs_reauth", profileRef: "prof-b", asOf: ASOF },
  { accountId: "cla-x", label: "Claude X", provider: "claude", authState: "active", profileRef: null, asOf: ASOF },
];

const SIGNALS: ProviderSignal[] = [
  {
    provider: "codex",
    accountRef: "cdx-a",
    sourceClass: "provider_structured_read",
    authority: "account_cross_device",
    window: "primary",
    usedPercent: 40,
    asOf: ASOF,
    staleAfter: "2026-08-03T12:05:00.000Z",
    supportsNotification: true,
    automationUse: "allow_switch_decision",
  },
];

describe("assembleFourBlock——proof-4 混合 provider 结构", () => {
  it("原样保留混合 provider 账户（包括未托管 claude 的 profileRef=null）和 signals", () => {
    const m = assembleFourBlock({ accounts: ACCOUNTS, rawBindings: [], signals: SIGNALS, asOf: ASOF });
    expect(m.accounts).toEqual(ACCOUNTS);
    expect(m.signals).toEqual(SIGNALS); // 原样保留
    expect(m.asOf).toBe(ASOF);
    const claude = m.accounts.find((a) => a.provider === "claude");
    expect(claude!.profileRef).toBeNull();
  });

  it("在共享同一真实账户的每个绑定行上标记 same_account_on_n_seats（数量 + 已排序 seat）", () => {
    const m = assembleFourBlock({
      accounts: ACCOUNTS,
      rawBindings: [
        { accountId: "cdx-a", seatSession: "seat-2", rigName: "rig-1", boundAt: ASOF, bindingSource: "adopt" },
        { accountId: "cdx-a", seatSession: "seat-1", rigName: "rig-1", boundAt: ASOF, bindingSource: "adopt" },
        { accountId: "cdx-b", seatSession: "seat-3", rigName: "rig-2", boundAt: ASOF, bindingSource: "adopt" },
      ],
      signals: [],
      asOf: ASOF,
    });
    // 两个 cdx-a 行各自携带 same_account 异常；cdx-b（单个 seat）则没有。
    const shared = m.bindings.filter((b) => b.accountId === "cdx-a");
    expect(shared).toHaveLength(2);
    for (const row of shared) {
      const anomaly = row.anomalies.find((a) => a.kind === "same_account_on_n_seats");
      expect(anomaly).toBeDefined();
      if (anomaly && anomaly.kind === "same_account_on_n_seats") {
        expect(anomaly.count).toBe(2);
        expect(anomaly.seats).toEqual(["seat-1", "seat-2"]); // 确定性排序
        expect(anomaly.asOf).toBe(ASOF);
      }
    }
    const solo = m.bindings.find((b) => b.accountId === "cdx-b");
    expect(solo!.anomalies.some((a) => a.kind === "same_account_on_n_seats")).toBe(false);
  });

  it("为没有账户的 seat 发出显式未绑定行，并携带 seat_with_no_account", () => {
    const m = assembleFourBlock({
      accounts: ACCOUNTS,
      rawBindings: [
        { accountId: null, seatSession: "seat-9", rigName: "rig-3", boundAt: null, bindingSource: null },
      ],
      signals: [],
      asOf: ASOF,
    });
    const unbound = m.bindings.find((b) => b.seatSession === "seat-9");
    expect(unbound).toBeDefined();
    expect(unbound!.accountId).toBeNull();
    expect(unbound!.boundAt).toBeNull();
    const anomaly = unbound!.anomalies.find((a) => a.kind === "seat_with_no_account");
    expect(anomaly).toBeDefined();
    if (anomaly && anomaly.kind === "seat_with_no_account") {
      expect(anomaly.seat).toBe("seat-9");
      expect(anomaly.asOf).toBe(ASOF);
    }
  });

  it("同一个 seat 出现在重复且相同的绑定行中时，不标记 same_account_on_n_seats", () => {
    const m = assembleFourBlock({
      accounts: ACCOUNTS,
      rawBindings: [
        { accountId: "cdx-a", seatSession: "seat-1", rigName: "rig-1", boundAt: ASOF, bindingSource: "adopt" },
        { accountId: "cdx-a", seatSession: "seat-1", rigName: "rig-1", boundAt: ASOF, bindingSource: "adopt" },
      ],
      signals: [],
      asOf: ASOF,
    });
    // 虽有两行，但只有一个不同 seat → 并非真实的跨 seat 共享。
    for (const b of m.bindings) {
      expect(b.anomalies.some((a) => a.kind === "same_account_on_n_seats")).toBe(false);
    }
  });

  it("不会根据未绑定（账户为 null）的 seat 虚构 same_account_on_n_seats", () => {
    const m = assembleFourBlock({
      accounts: ACCOUNTS,
      rawBindings: [
        { accountId: null, seatSession: "seat-a", rigName: "r", boundAt: null, bindingSource: null },
        { accountId: null, seatSession: "seat-b", rigName: "r", boundAt: null, bindingSource: null },
      ],
      signals: [],
      asOf: ASOF,
    });
    for (const b of m.bindings) {
      expect(b.anomalies.some((a) => a.kind === "same_account_on_n_seats")).toBe(false);
    }
  });
});
