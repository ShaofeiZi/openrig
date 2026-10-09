import { describe, it, expect } from "vitest";
import { signalEligibleForAutomation } from "../src/domain/provider/provider-policy.js";
import type { ProviderSignal } from "../src/domain/provider/provider-types.js";

// Slice-04（OPR.0.5.0.4）——BR-2，承重负向（packet 3ffa3c22 §2 policy + BR-2）：
// 自动化绝不在未知、陈旧或非 allow_switch_decision 的信号上触发。此处
// RED 是判别性的——一个无法拒绝的谓词证明不了什么，故每个
// 取消资格项必须产出 eligible:false，并带显式、失败可见的拒绝原因。

const NOW = "2026-08-03T12:00:00.000Z";
const FUTURE = "2026-08-03T12:05:00.000Z"; // after NOW → fresh
const PAST = "2026-08-03T11:55:00.000Z"; // before NOW → stale

// 一次真实、可自动化的结构化读：已知 source/authority、allow_switch_decision、新鲜。
const AUTOMATABLE: ProviderSignal = {
  provider: "codex",
  accountRef: "acct-1",
  sourceClass: "provider_structured_read",
  authority: "account_cross_device",
  window: "primary",
  usedPercent: 95,
  resetsAt: FUTURE,
  asOf: NOW,
  staleAfter: FUTURE,
  supportsNotification: true,
  automationUse: "allow_switch_decision",
};

describe("signalEligibleForAutomation —— BR-2 禁止触发", () => {
  it("新鲜、已知且为 allow_switch_decision 的结构化读取具备资格（谓词可以返回是）", () => {
    const r = signalEligibleForAutomation(AUTOMATABLE, NOW);
    expect(r.eligible).toBe(true);
    expect(r.refusals).toEqual([]);
  });

  it("拒绝未知信号（sourceClass/authority unknown、do_not_automate）", () => {
    const unknown: ProviderSignal = {
      provider: "codex",
      accountRef: "acct-1",
      sourceClass: "unknown",
      authority: "unknown",
      asOf: NOW,
      staleAfter: FUTURE,
      unknownReason: "codex_app_server_unavailable",
      supportsNotification: false,
      automationUse: "do_not_automate",
    };
    const r = signalEligibleForAutomation(unknown, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("sourceClass_unknown");
    expect(r.refusals).toContain("authority_unknown");
    expect(r.refusals).toContain("not_allow_switch_decision");
  });

  it("即使其他条件允许自动化，也拒绝陈旧信号（now 超过 staleAfter）", () => {
    const r = signalEligibleForAutomation({ ...AUTOMATABLE, staleAfter: PAST }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("stale");
  });

  it("拒绝 advisory_only 信号（automationUse != allow_switch_decision）", () => {
    const r = signalEligibleForAutomation({ ...AUTOMATABLE, automationUse: "advisory_only" }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("not_allow_switch_decision");
  });

  it("拒绝没有新鲜度边界的信号（无法确认新鲜时安全失败）", () => {
    const noStale = { ...AUTOMATABLE };
    delete (noStale as { staleAfter?: string }).staleAfter;
    const r = signalEligibleForAutomation(noStale, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("no_freshness_bound");
  });

  it("对无法解析的 staleAfter 失败关闭（NaN 绝不能比较为新鲜）", () => {
    const r = signalEligibleForAutomation({ ...AUTOMATABLE, staleAfter: "not-a-timestamp" }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("unparsable_freshness_bound");
    // must NOT be silently treated as fresh/stale-by-accident
    expect(r.refusals).not.toContain("stale");
  });

  it("将精确过期边界 now == staleAfter 视为 stale（now >= staleAfter）", () => {
    const r = signalEligibleForAutomation({ ...AUTOMATABLE, staleAfter: NOW }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("stale");
  });
});
