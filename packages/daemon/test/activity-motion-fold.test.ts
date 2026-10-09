// ACTIVITY D1+D2——把 window_activity MOTION 信号折进 ACTIVITY 阶梯。RED-first。
//
// 两个成因，同一条代码路径（attachAgentActivity，node-inventory.ts）：
//   D1（Codex → unknown）= 覆盖。Codex 席位没有 hook，正 hook 的提前返回
//     永不触发，缓存的 STRUCTURAL 判定来自一个 Claude 形态 matcher 在固定
//     8 行尾窗口上的匹配。Codex 高大的 footer 把 `◦ Working (… esc to interrupt)`
//     顶到该窗口之上 → 无匹配 → unknown。正在生成的席位上报为空。
//   D2（Claude → idle）= 优先级。正 `idle` hook 提前返回为权威，故实时
//     motion 永不被参考。一个 Stopped 后又 RESUMED 的 Claude 席位仍带陈旧的 idle
//     hook 作为 latest → 正在生成却报 idle。单靠完美 motion 源修不好这个。
//
// 修复 = 运行时无关的 MOTION 源（tmux `#{window_activity}`，SeatActivityService
// 已按席位算好、并作为独立列 `terminalActive` 露出）折进 ACTIVITY 阶梯，
// 顺序为 `needs_input(TEXT) > motion > idle`。motion 只能把状态升级到
// running；它从不伪造 `idle`，故无 hook 的 MOTIONLESS 席位仍读 `unknown`，
// 闭合并集不腐烂。
//
// 为什么用 motion 而不是更好的 matcher：按运行时写的 TUI matcher 是跑步机——每个
// provider 换皮都会再破它。`window_activity` 是 tmux 关于窗格字节的事实，对
// Claude、Codex 以及我们将来坐的任何席位都一致。
//
// LIVE MEASUREMENT BEHIND THIS DESIGN (daemon route, reverted runtime cb662b9d, 2026-08-11 04:52Z):
// terminalActive was TRUE for exactly the two seats generating at that instant (dev-driver,
// dev50-driver) and FALSE for the other 12 — including every Codex seat, whose tall footers do NOT
// keep the window fresh. The motion source discriminates live and is not sprayed by clock-tick
// redraws, which was the design's main risk.
//
// NOTE ON THE NEGATIVE CONTROL: these unit assertions are NOT the gate on their own. The reverted
// runtime is uniformly inert (all 14 seats unknown, reason=generation_unverifiable), so D2 cannot be
// STAGED there — assertions that look satisfied against it can be vacuous. The live control is staged
// separately by deliberately reintroducing the precedence and watching A1 fail BY NAME.

import { describe, it, expect } from "vitest";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import type { AgentActivity } from "../src/domain/types.js";

function mkTmux(counter: { captures: number }) {
  return {
    hasSession: async () => true,
    getPaneCommand: async () => "claude",
    capturePaneContent: async () => {
      counter.captures++;
      return "some pane output\n> awaiting input";
    },
  } as never;
}

function entries(sessionName: string, runtime = "claude-code") {
  return [{ canonicalSessionName: sessionName, runtime, attachmentType: "tmux", logicalId: "dev.impl" }] as never;
}

/** A request clock, so observation age is a variable the tests control independently of the cache. */
const NOW = new Date("2026-08-11T04:52:00.000Z");

/** The cached MOTION observation, as SeatActivityService exposes it. A cache read, never a capture.
 *  `lastActivityAt` defaults FRESH relative to NOW; the stale-cache tests override it. */
function mkMotion(
  isActiveWithinWindow: boolean | null,
  lastActivityAt: string | null = "2026-08-11T04:51:59.000Z",
) {
  return {
    getSeatActivity: () =>
      isActiveWithinWindow === null
        ? null
        : {
          paneId: "s@rig",
          isActiveWithinWindow,
          silenceWindowSeconds: 3,
          lastObservedAt: "2026-08-11T04:52:00.000Z",
          lastActivityAt,
        },
  } as never;
}

function mkStructural(state: "agent_active" | "agent_idle" | "attention" | "unknown" | null) {
  return {
    getStructuralActivity: () =>
      state
        ? { state, reason: `structural_${state}`, evidence: "pane", observedAt: "2026-08-11T04:52:00.000Z" }
        : null,
  } as never;
}

function hook(state: AgentActivity["state"], reason: string, extra: Partial<AgentActivity> = {}): AgentActivity {
  return {
    state,
    reason,
    evidenceSource: "runtime_hook",
    sampledAt: "2026-08-11T04:30:00.000Z",
    evidence: null,
    ...extra,
  };
}

const store = (activity: AgentActivity | null) => ({ getLatestForNode: () => activity }) as never;

async function activityOf(deps: Record<string, unknown>, runtime = "claude-code"): Promise<AgentActivity> {
  const out = (await attachAgentActivity(entries("s@rig", runtime), { now: NOW, ...deps } as never)) as Array<{
    agentActivity: AgentActivity;
  }>;
  return out[0]!.agentActivity;
}

describe("ACTIVITY D1+D2 —— 将活动信号折叠进证据层级", () => {
  it("A1 [D2 优先级] 正 IDLE 挂钩 + LIVE 运动不得报告空闲 — 它报告正在运行", async () => {
    const counter = { captures: 0 };
    const activity = await activityOf({
      tmuxAdapter: mkTmux(counter),
      activityStore: store(hook("idle", "stop_hook")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(true),
    });
    // The assertion the defect fails BY NAME: a generating Claude seat reporting idle is a false
    // ASSERTION of quiet, strictly worse than an honest unknown — the parking watch reports all-clear
    // over a working seat.
    expect(activity.state).not.toBe("idle");
    expect(activity.state).toBe("running");
    expect(counter.captures).toBe(0); // cache read, never a per-request capture (healthz-wedge invariant)
  });

  it("A2 [D1 覆盖] 无 hook 席位在结构匹配器遗漏但有 LIVE 活动时报告 running", async () => {
    // The Codex shape: no hook at all, and the Claude-shaped structural matcher returns unknown
    // because the tall footer pushed the work line out of the 8-line tail window.
    const activity = await activityOf(
      {
        tmuxAdapter: mkTmux({ captures: 0 }),
        activityStore: store(null),
        structuralActivity: mkStructural("unknown"),
        seatActivity: mkMotion(true),
      },
      "codex",
    );
    // RUNNING exactly — "not unknown" is the indicator, and it passes for a generating Codex seat that
    // reads idle (D2 on Codex). Assert the correctness standard, not its shadow.
    expect(activity.state).toBe("running");
  });

  it("A3 [对照] 无 hook 且 MOTIONLESS 的席位仍报告 unknown，修复不得改写默认值", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(false),
    });
    expect(activity.state).toBe("unknown");
  });

  it("A3b [诚实缺席] 根本没有观察到任何运动→未知，从来没有一个安静的席位判决", async () => {
    const noObs = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(null),
    });
    expect(noObs.state).toBe("unknown");

    // And with the dep entirely absent (older wiring), behavior is unchanged.
    const noDep = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
    });
    expect(noDep.state).toBe("unknown");
  });

  it("A4 [order] need_input TEXT 优先于运动 — 等待提示的席位不断重新绘制", async () => {
    // Motion cannot tell "waiting at a prompt" from "working": any per-second redraw keeps the window
    // fresh. So a positive needs_input verdict — from the hook OR from the structural text read — must
    // survive live motion, or the fix converts "answer me" into "busy, leave it alone".
    const fromHook = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("needs_input", "permission_prompt")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(true),
    });
    expect(fromHook.state).toBe("needs_input");

    const fromStructural = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("attention"),
      seatActivity: mkMotion(true),
    });
    expect(fromStructural.state).toBe("needs_input");
  });

  it("A5 [不变] 积极的 RUNNING hook在没有运动观察的情况下保持其权威", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("running", "prompt_submit")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(null),
    });
    expect(activity.state).toBe("running");
    expect(activity.evidenceSource).toBe("runtime_hook");
  });

  it("A6 [不伪造] MOTIONLESS 席位在有明确 idle hook 时仍显示 idle", async () => {
    // The mirror of A1: motion only ever upgrades. Absent motion, the idle hook stands, so the fix
    // cannot be accused of laundering every idle seat into running.
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("idle", "stop_hook")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(false),
    });
    expect(activity.state).toBe("idle");
  });

  it("A7[没有捏造]陈旧/未知的hook+没有动作仍然诚实地传递，从不闲着", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("unknown", "generation_unverifiable", { stale: true })),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(false),
    });
    expect(activity.state).toBe("unknown");
    expect(activity.reason).toBe("generation_unverifiable");
  });

  // ---------------------------------------------------------------------------------------------
  // STALE-CACHE CONTROLS (dev50-guard HOLD on 29ad1b2b9, 2026-08-11T05:12:46Z).
  //
  // `SeatActivityService.pollSeat` returns null on a tmux error BEFORE it replaces or deletes the
  // cached record (seat-activity-service.ts:74), and `pollAllRunningTmuxSeats` only evicts seats that
  // are no longer running in the DB. So a seat still marked running whose tmux read keeps failing
  // KEEPS its last observation indefinitely — including `isActiveWithinWindow: true`.
  //
  // The original fold read that boolean and never aged the raw fact, so a DEAD OBSERVATION became an
  // affirmative liveness claim. That is this atom's own no-fabrication rule broken in the direction
  // nobody was watching: three guards existed against motion inventing IDLE from silence, and none
  // against an unavailable instrument inventing RUNNING.
  //
  // The nine tests above could not catch it because every one of them varies the cached boolean and
  // none varies observation AGE independently of it. These do.
  // ---------------------------------------------------------------------------------------------

  it("A9 [陈旧缓存] isActiveWithinWindow=true 具有一小时前的原始事实，不得升级未知", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("unknown", "generation_unverifiable", { stale: true })),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true, "2026-08-11T03:59:59.000Z"), // 52 minutes before NOW, window is 3s
    });
    expect(activity.state).toBe("unknown");
    expect(activity.reason).not.toBe("window_activity_motion");
  });

  it("A10 [陈旧缓存] 相同的陈旧 true 不得推翻正空闲hook", async () => {
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("idle", "stop_hook")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(true, "2026-08-11T03:59:59.000Z"),
    });
    expect(activity.state).toBe("idle");
  });

  it("A11 [失败关闭] 其原始事实无法老化的缓存 true 不得升级任何内容", async () => {
    // If the observation carries no usable timestamp there is no way to tell live from long-dead, and
    // an un-ageable affirmative is exactly the input that must not become a liveness claim.
    for (const raw of [null, "not-a-timestamp"]) {
      const activity = await activityOf({
        tmuxAdapter: mkTmux({ captures: 0 }),
        activityStore: store(null),
        structuralActivity: mkStructural("unknown"),
        seatActivity: mkMotion(true, raw),
      });
      expect(activity.state).toBe("unknown");
    }
  });

  it("A12 [未过度修正] 一个新的原始事实仍在升级 - 修复不得禁用运动", async () => {
    // The mirror of A9. A correction that made every motion read stale would pass A9/A10/A11 and
    // silently restore the original defect, so freshness is pinned from BOTH sides.
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("idle", "stop_hook")),
      structuralActivity: mkStructural(null),
      seatActivity: mkMotion(true, "2026-08-11T04:51:59.000Z"), // 1s before NOW
    });
    expect(activity.state).toBe("running");
    expect(activity.reason).toBe("window_activity_motion");
  });

  it("A13 [边界] 新鲜度是根据席位两侧的静音窗来判断的", async () => {
    // Just INSIDE the 3s window.
    const inside = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true, "2026-08-11T04:51:57.500Z"), // 2.5s old
    });
    expect(inside.state).toBe("running");

    // Just OUTSIDE it.
    const outside = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true, "2026-08-11T04:51:56.500Z"), // 3.5s old
    });
    expect(outside.state).toBe("unknown");
  });

  it("A14 [时钟偏差] 稍微提前于请求时钟的原始事实仍然读取为实时", async () => {
    // pollSeat deliberately treats negative age as active (the daemon's clock can lag tmux briefly).
    // Read-time aging must keep that behavior rather than reading the future as stale.
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(null),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true, "2026-08-11T04:52:01.000Z"), // 1s in the future
    });
    expect(activity.state).toBe("running");
  });

  it("A8【直播舰队形态】无法验证的代钩+LIVE运动报告运行", async () => {
    // Measured live: all 14 seats carry state=unknown reason=generation_unverifiable, so on this fleet
    // the demoted hook — not a positive idle one — is what stands between a generating seat and a
    // truthful label. Motion must beat it, or the fix changes nothing on the machine it ships to.
    const activity = await activityOf({
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: store(hook("unknown", "generation_unverifiable", { stale: true })),
      structuralActivity: mkStructural("unknown"),
      seatActivity: mkMotion(true),
    });
    expect(activity.state).toBe("running");
  });
});
