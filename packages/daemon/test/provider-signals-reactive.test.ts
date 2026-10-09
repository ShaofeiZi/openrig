import { describe, it, expect } from "vitest";
import { reactiveEventSignal } from "../src/domain/provider/provider-signals.js";
import { signalEligibleForAutomation } from "../src/domain/provider/provider-policy.js";

// Slice-04（OPR.0.5.0.4）——reactive 通道（packet 3ffa3c22 §2）。达限错误 / 流
// 失败 / stop-error 事件立即消费为 sourceClass=provider_event、
// authority=reactive_error——耗尽证据，而非剩余计量（故无 usedPercent）。
// 达限事件是真实自动化触发；流/stop 错误是提示性上下文。
// 各行必须经 BR-2 谓词诚实流过。

const NOW = "2026-08-03T12:00:00.000Z";
const FRESH = "2026-08-03T12:00:30.000Z"; // short freshness window after NOW

describe("reactiveEventSignal —— 响应式通道", () => {
  it("达到限额的事件是 provider_event/reactive_error 记录，且不伪造计量值", () => {
    const s = reactiveEventSignal({
      provider: "codex",
      accountRef: "acct-1",
      kind: "at_limit",
      asOf: NOW,
      staleAfter: FRESH,
    });
    expect(s.provider).toBe("codex");
    expect(s.sourceClass).toBe("provider_event");
    expect(s.authority).toBe("reactive_error");
    expect(s.usedPercent).toBeUndefined(); // exhaustion evidence, not a remaining meter
    // A generic reactive event does not establish transport capability — must not fabricate it.
    expect(s.supportsNotification).toBeUndefined();
    expect(s.automationUse).toBe("allow_switch_decision");
    expect(s.asOf).toBe(NOW);
  });

  it("stream-failure 和 stop-error 为 advisory_only（只是上下文，并非已证明耗尽）", () => {
    for (const kind of ["stream_failure", "stop_error"] as const) {
      const s = reactiveEventSignal({ provider: "claude", accountRef: "c1", kind, asOf: NOW, staleAfter: FRESH });
      expect(s.sourceClass).toBe("provider_event");
      expect(s.authority).toBe("reactive_error");
      expect(s.automationUse).toBe("advisory_only");
      expect(s.usedPercent).toBeUndefined();
      expect(s.supportsNotification).toBeUndefined();
    }
  });

  it("新鲜的达到限额事件可通过 BR-2 谓词", () => {
    const s = reactiveEventSignal({ provider: "codex", accountRef: "a1", kind: "at_limit", asOf: NOW, staleAfter: FRESH });
    expect(signalEligibleForAutomation(s, NOW).eligible).toBe(true);
  });

  it("BR-2 拒绝 stream-failure 与 stop-error 事件（advisory 而非 allow_switch_decision）", () => {
    for (const kind of ["stream_failure", "stop_error"] as const) {
      const s = reactiveEventSignal({ provider: "codex", accountRef: "a1", kind, asOf: NOW, staleAfter: FRESH });
      const r = signalEligibleForAutomation(s, NOW);
      expect(r.eligible).toBe(false);
      expect(r.refusals).toContain("not_allow_switch_decision");
    }
  });
});
