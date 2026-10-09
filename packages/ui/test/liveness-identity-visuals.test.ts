// OPR.0.4.3.19 前瞻修复——活动圆点（getActivityStateWithSource）
// 必须消费 liveness identity 判定，而非静默忽略。
// mismatch/pane_missing 判定覆盖输出派生活动，使
// dead/orphaned/squatted pane 绝不渲染 active/running 绿——即使
//（orphan 的）tmux 输出使 terminalActive 为 true（guard 阻断的
// 可见假绿）。

import { describe, it, expect } from "vitest";
import {
  getActivityState,
  getActivityStateWithSource,
  identityVerdictDownranksRunning,
} from "../src/lib/activity-visuals.js";
import type { AgentActivitySummary, SeatIdentityVerdictSummary } from "../src/hooks/useNodeInventory.js";

const freshHookRunning: AgentActivitySummary = {
  state: "running",
  reason: "user_prompt",
  evidenceSource: "runtime_hook",
  sampledAt: "2026-07-02T12:00:00.000Z",
  stale: false,
  fallback: false,
};

function v(kind: SeatIdentityVerdictSummary["verdict"]): SeatIdentityVerdictSummary {
  return { verdict: kind, reason: kind === "mismatch" ? "process_identity_mismatch" : null };
}

describe("identityVerdictDownranksRunning", () => {
  it("only mismatch/pane_missing down-rank; verified/tmux_unavailable/absent do not", () => {
    expect(identityVerdictDownranksRunning(v("mismatch"))).toBe(true);
    expect(identityVerdictDownranksRunning(v("pane_missing"))).toBe(true);
    expect(identityVerdictDownranksRunning(v("verified"))).toBe(false);
    expect(identityVerdictDownranksRunning(v("tmux_unavailable"))).toBe(false);
    expect(identityVerdictDownranksRunning(null)).toBe(false);
    expect(identityVerdictDownranksRunning(undefined)).toBe(false);
  });
});

describe("getActivityStateWithSource identity gate (no false-green dot)", () => {
  it("PRIMARY — mismatch + terminalActive=true → NON-GREEN (needs_input), NOT running", () => {
    const r = getActivityStateWithSource(null, true, v("mismatch"));
    expect(r.state).toBe("needs_input");
    expect(r.state).not.toBe("running");
  });

  it("mismatch overrides even a fresh runtime-hook 'running'", () => {
    const r = getActivityStateWithSource(freshHookRunning, true, v("mismatch"));
    expect(r.state).toBe("needs_input");
  });

  it("pane_missing + terminalActive=true → NON-GREEN, NOT running", () => {
    expect(getActivityStateWithSource(null, true, v("pane_missing")).state).toBe("needs_input");
  });

  it("verified verdict does NOT down-rank — terminalActive=true still renders running (no-regression)", () => {
    expect(getActivityStateWithSource(null, true, v("verified")).state).toBe("running");
  });

  it("absent verdict preserves existing behavior (no-regression)", () => {
    expect(getActivityState(null, true)).toBe("running");
    expect(getActivityState(freshHookRunning, false)).toBe("running");
  });
});
