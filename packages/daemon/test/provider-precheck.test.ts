import { describe, it, expect } from "vitest";
import { precheckSwitch } from "../src/domain/provider/provider-policy.js";
import type { ProviderSignal } from "../src/domain/provider/provider-types.js";

// 切片 04（OPR.0.5.0.4）——§1 预检契约（证明项 7，单元测试部分）。precheck 返回
// { safe: true } | { safe: false, reasons[] }，使 UI/自动化绝不提供不安全切换。原因至少包括：
// would_strand_live_conversation、target_needs_reauth（使用时校验）、
// signal_unknown_or_stale、rebind_unsupported_for_runtime。每种不安全条件都明确且失败可见；
// 多个原因会组合。

const NOW = "2026-08-03T12:00:00.000Z";
const FRESH = "2026-08-03T12:05:00.000Z";
const STALE = "2026-08-03T11:55:00.000Z";

const FRESH_KNOWN_SIGNAL: ProviderSignal = {
  provider: "codex",
  accountRef: "acct-1",
  sourceClass: "provider_structured_read",
  authority: "account_cross_device",
  window: "primary",
  usedPercent: 96,
  asOf: NOW,
  staleAfter: FRESH,
  supportsNotification: true,
  automationUse: "allow_switch_decision",
};

describe("precheckSwitch——§1 切换安全门禁", () => {
  it("认证活跃、无实时对话且信号已知且新鲜的 codex 目标是安全的", () => {
    const r = precheckSwitch({
      targetProvider: "codex",
      targetAuthState: "active",
      seatHasLiveConversation: false,
      triggeringSignal: FRESH_KNOWN_SIGNAL,
      now: NOW,
    });
    expect(r.safe).toBe(true);
  });

  it("claude 目标为 rebind_unsupported_for_runtime（rig auth 仅支持 codex）", () => {
    const r = precheckSwitch({ targetProvider: "claude", targetAuthState: "active", seatHasLiveConversation: false });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("rebind_unsupported_for_runtime");
  });

  it("需要重新认证的目标为 target_needs_reauth（使用时校验）", () => {
    const r = precheckSwitch({ targetProvider: "codex", targetAuthState: "needs_reauth", seatHasLiveConversation: false });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("target_needs_reauth");
  });

  it("认证状态未知的目标以独立原因 target_auth_unknown 闭合失败", () => {
    const r = precheckSwitch({ targetProvider: "codex", targetAuthState: "unknown", seatHasLiveConversation: false });
    expect(r.safe).toBe(false);
    if (!r.safe) {
      expect(r.reasons).toContain("target_auth_unknown");
      // unknown 不会被重新标记为需要重新认证。
      expect(r.reasons).not.toContain("target_needs_reauth");
    }
  });

  it("seat 上存在实时对话时为 would_strand_live_conversation", () => {
    const r = precheckSwitch({ targetProvider: "codex", targetAuthState: "active", seatHasLiveConversation: true });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("would_strand_live_conversation");
  });

  it("未知/陈旧的触发信号为 signal_unknown_or_stale（复用 BR-2 谓词）", () => {
    const staleSignal: ProviderSignal = { ...FRESH_KNOWN_SIGNAL, staleAfter: STALE };
    const r = precheckSwitch({
      targetProvider: "codex",
      targetAuthState: "active",
      seatHasLiveConversation: false,
      triggeringSignal: staleSignal,
      now: NOW,
    });
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("signal_unknown_or_stale");
  });

  it("建议性（非未知、非陈旧）触发信号不会添加 signal_unknown_or_stale", () => {
    const advisory: ProviderSignal = { ...FRESH_KNOWN_SIGNAL, automationUse: "advisory_only" };
    const r = precheckSwitch({
      targetProvider: "codex",
      targetAuthState: "active",
      seatHasLiveConversation: false,
      triggeringSignal: advisory,
      now: NOW,
    });
    // advisory 属于 BR-2 关注项，而非未知/陈旧预检关注项——此次切换安全。
    expect(r.safe).toBe(true);
  });

  it("闭合失败：无类型调用方传入触发信号但没有 now 时不安全（signal_unknown_or_stale）", () => {
    // 刻意采用无类型/JS 风格调用（配对联合类型会禁止类型化调用方这么做）：存在触发信号，
    // 但省略 `now`。缺少时钟便无法证明新鲜度，因此绝不能静默返回安全。
    const r = precheckSwitch({
      targetProvider: "codex",
      targetAuthState: "active",
      seatHasLiveConversation: false,
      triggeringSignal: FRESH_KNOWN_SIGNAL,
    } as unknown as Parameters<typeof precheckSwitch>[0]);
    expect(r.safe).toBe(false);
    if (!r.safe) expect(r.reasons).toContain("signal_unknown_or_stale");
  });

  it("多个不安全条件会组合全部对应原因", () => {
    const r = precheckSwitch({
      targetProvider: "claude",
      targetAuthState: "needs_reauth",
      seatHasLiveConversation: true,
    });
    expect(r.safe).toBe(false);
    if (!r.safe) {
      expect(r.reasons).toContain("rebind_unsupported_for_runtime");
      expect(r.reasons).toContain("target_needs_reauth");
      expect(r.reasons).toContain("would_strand_live_conversation");
    }
  });
});
