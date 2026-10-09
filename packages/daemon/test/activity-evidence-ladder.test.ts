import { describe, it, expect, beforeEach } from "vitest";
import {
  SeatActivityService,
  HOOK_AUTHORITY_WINDOW_MS,
  CROSS_RUNG_CONTRADICTION_WINDOW_MS,
  SAMPLING_IDLE_DEBOUNCE_TICKS,
  RUNG_PROMOTION_AGREEMENT_COUNT,
  RUNG_PROMOTION_MIN_WINDOW_MS,
} from "../src/domain/seat-activity-service.js";
import type {
  ActivityEvidence,
  AdapterRungInventory,
  RungHealthEvent,
  ActivityValue,
  EvidenceRungId,
} from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A3——在唯一 oracle 上的排序证据阶梯。这里每个 pin 都用注入时钟
// 经 S19 表面驱动 SeatActivityService；无 tmux、无 daemon。非推断契约不动：
// 这些 fixture 中绝无任何东西把 queue 状态呈现给该服务。

const SEAT = "node-claude-1";
const SESSION = "dev50-qa@v-openrig-build";

function makeHarness(startMs = 1_000_000) {
  const clock = { now: startMs };
  const svc = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(clock.now),
  });
  const health: RungHealthEvent[] = [];
  return { clock, svc, health };
}

const CLAUDE_INVENTORY: AdapterRungInventory = {
  adapterId: "claude-code-adapter",
  runtime: "claude-code",
  rungs: [
    { rung: "self-report", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "needs-input-chrome", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" },
  ],
};

const CODEX_INVENTORY: AdapterRungInventory = {
  adapterId: "codex-runtime-adapter",
  runtime: "codex",
  rungs: [
    // AM-2：经 fixture 验证的 hook 梯级从 TRIAL 进入，绝不直接到 authority。
    { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "trial" },
    { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" },
  ],
};

let seqCounter = 0;
function ev(
  clock: { now: number },
  rung: EvidenceRungId,
  sourceId: string,
  activity: ActivityValue | undefined,
  extra: Partial<ActivityEvidence> = {},
): ActivityEvidence {
  return {
    seatNodeId: SEAT,
    sessionName: SESSION,
    rung,
    sourceId,
    seq: ++seqCounter,
    observedAt: new Date(clock.now).toISOString(),
    ...(activity ? { activity } : {}),
    ...extra,
  };
}

describe("S19 A3——证据层级如实排序并降级", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
  });

  it("自我报告决定工作/空闲（当存在时），高于挂钩和采样", () => {
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "idle-at-prompt"));
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "working"));
    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working");
    expect(s.decidedBy).toBe("self-report");
  });

  it("缺少自我报告（文件不可读即无证据）时依次回退到 hook、采样和 unknown", () => {
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("unknown"); // nothing yet — honest
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "working"));
    expect(h.svc.getSeatState(SEAT)!.decidedBy).toBe("window-sampling");
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "idle-at-prompt"));
    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("idle-at-prompt");
    expect(s.decidedBy).toBe("lifecycle-hooks");
  });

  it("陈旧或重新排序的每个源 seq 被丢弃：后期的较低 seq“工作”永远不会恢复空闲席位", () => {
    const idle = ev(h.clock, "lifecycle-hooks", "claude:hooks", "idle-at-prompt");
    const lateWorking: ActivityEvidence = { ...ev(h.clock, "lifecycle-hooks", "claude:hooks", "working"), seq: idle.seq - 5 };
    h.svc.reportEvidence(idle);
    h.svc.reportEvidence(lateWorking);
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt");
  });

  it("可见的 needs-input chrome 仅对 needs-input 信号优先于 working 自我报告", () => {
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "working"));
    h.svc.reportEvidence(ev(h.clock, "needs-input-chrome", "tmux:chrome", undefined, {
      needsInput: { count: 1, reason: "permission prompt" },
    }));
    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working"); // chrome never decides working/idle
    expect(s.needsInput).toEqual({ count: 1, reason: "permission prompt" });
  });

  it("hook 权威有时效限制：过期的 hook 证据不再参与判定，层级继续回退", () => {
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "working"));
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working"); // hook fresh, hook decides
    h.clock.now += HOOK_AUTHORITY_WINDOW_MS + 1_000;
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("idle-at-prompt");
    expect(s.decidedBy).toBe("window-sampling"); // fell through, no error, no lie
  });
});

describe("S19 A3 —— AM-1：存活但部分降级，且清晰可见", () => {
  it("持续的挂钩与采样器矛盾会通过梯级运行状况事件将挂钩梯级降级为仅身份", () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
    const events: RungHealthEvent[] = [];
    h.svc.onRungHealth((e) => events.push(e));

    // The orch-lead specimen shape: the hook source fired once (working) then silently
    // drops every Stop. The sampler keeps seeing idle-at-prompt.
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "working"));
    for (let i = 0; i < 12; i++) {
      h.clock.now += 1_000; // 1Hz sampler cadence
      h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    }
    expect(h.clock.now - 1_000_000).toBeGreaterThan(CROSS_RUNG_CONTRADICTION_WINDOW_MS);

    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("idle-at-prompt"); // never working-forever off a dead-dropping hook
    const hookRung = s.rungs.find((r) => r.rung === "lifecycle-hooks")!;
    expect(hookRung.trust).toBe("identity-only");
    const degradation = events.find((e) => e.rung === "lifecycle-hooks" && e.to === "identity-only");
    expect(degradation, "degradation must be VISIBLE as a rung-health event").toBeDefined();
    expect(degradation!.reason).toMatch(/contradiction|disagree/i);
  });
});

describe("S19 A3 —— 消除抖动，等待过程无竞态", () => {
  it("采样决定的工作→空闲去抖对于指定的刻度线；权威转弯边界瞬间绕过", () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "working"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working");

    // The mid-turn render lull: one idle observation must NOT flip the state…
    h.clock.now += 1_000;
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working");
    // …the stated consecutive count does.
    for (let i = 1; i < SAMPLING_IDLE_DEBOUNCE_TICKS; i++) {
      h.clock.now += 1_000;
      h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    }
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt");

    // Bypass: back to working, then a hook Stop (authoritative idle) publishes instantly.
    h.clock.now += 1_000;
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "working"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working");
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "idle-at-prompt"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt"); // no debounce on a real turn boundary
  });

  it("状态变化带有单调的 seq，并且 wait-after-seq 观察到快速瞬态转换（丢失唤醒装置）", async () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "idle-at-prompt"));
    const s0 = h.svc.getSeatState(SEAT)!;

    const waiter = h.svc.waitForSeatState(SEAT, { afterSeq: s0.seq, timeoutMs: 2_000 });
    // A fast transient: working then immediately idle again. The waiter must resolve
    // with a state whose seq passed afterSeq — a pass-through transition still satisfies.
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "working"));
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "idle-at-prompt"));
    const woke = await waiter;
    expect(woke).not.toBeNull();
    expect(woke!.seq).toBeGreaterThan(s0.seq);
  });
});

describe("S19 A3 — AM-2：对称录取（试用→衡量晋升）", () => {
  it("TRIAL 级别的证据永远不会决定状态；计量生产协议明显地促进了它", () => {
    const h = makeHarness();
    const codexSeat = "node-codex-1";
    const codexSession = "orch-lead@v-openrig-build";
    h.svc.declareRungInventory({ seatNodeId: codexSeat, sessionName: codexSession }, CODEX_INVENTORY);
    const events: RungHealthEvent[] = [];
    h.svc.onRungHealth((e) => events.push(e));

    const cev = (rung: EvidenceRungId, sourceId: string, activity: ActivityValue): ActivityEvidence => ({
      seatNodeId: codexSeat,
      sessionName: codexSession,
      rung,
      sourceId,
      seq: ++seqCounter,
      observedAt: new Date(h.clock.now).toISOString(),
      activity,
    });

    // Trial hook says working; authoritative sampling says idle — sampling decides.
    h.svc.reportEvidence(cev("lifecycle-hooks", "codex:hooks", "working"));
    h.svc.reportEvidence(cev("window-sampling", "tmux:window-activity", "idle-at-prompt"));
    expect(h.svc.getSeatState(codexSeat)!.activity).toBe("idle-at-prompt");
    expect(h.svc.getSeatState(codexSeat)!.rungs.find((r) => r.rung === "lifecycle-hooks")!.trust).toBe("trial");

    // Production agreement: trial evidence AGREES with the arbitrated state, spread over
    // more than the minimum window, for the stated count.
    // N agreements span N-1 intervals — size the step so the TOTAL span crosses the window.
    const stepMs = Math.ceil(RUNG_PROMOTION_MIN_WINDOW_MS / (RUNG_PROMOTION_AGREEMENT_COUNT - 1)) + 1_000;
    for (let i = 0; i < RUNG_PROMOTION_AGREEMENT_COUNT; i++) {
      h.clock.now += stepMs;
      const value: ActivityValue = i % 2 === 0 ? "working" : "idle-at-prompt";
      h.svc.reportEvidence(cev("window-sampling", "tmux:window-activity", value));
      h.svc.reportEvidence(cev("lifecycle-hooks", "codex:hooks", value)); // agrees
    }
    const promoted = h.svc.getSeatState(codexSeat)!.rungs.find((r) => r.rung === "lifecycle-hooks")!;
    expect(promoted.trust).toBe("authoritative");
    expect(events.some((e) => e.rung === "lifecycle-hooks" && e.to === "authoritative")).toBe(true);

    // And now the promoted hook rung outranks sampling:
    h.clock.now += 1_000;
    h.svc.reportEvidence(cev("window-sampling", "tmux:window-activity", "idle-at-prompt"));
    h.svc.reportEvidence(cev("lifecycle-hooks", "codex:hooks", "working"));
    expect(h.svc.getSeatState(codexSeat)!.decidedBy).toBe("lifecycle-hooks");
  });
});

describe("S19 A3 —— 占用者切换期间保持按席位键控的状态", () => {
  it("交换是其自己的可见事件：无活动闪烁、无出血、梯级信任重置（AM-1 推论）", () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "working"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working");

    h.clock.now += 1_000;
    h.svc.declareOccupantSwap(SEAT, "gen-successor-1");

    const s = h.svc.getSeatState(SEAT)!;
    expect(s.lastSwap).toEqual({ generation: "gen-successor-1", at: new Date(h.clock.now).toISOString() });
    expect(s.activity).toBe("unknown"); // the swap window reads as the swap event, never idle/working flicker
    // The predecessor's evidence and rung authority never bleed onto the successor:
    expect(s.rungs.every((r) => r.trust === "absent" || r.lastEvidenceAt === null)).toBe(true);

    // Re-declaration starts the successor UNPROMOTED per its inventory's initial trust:
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CODEX_INVENTORY);
    const after = h.svc.getSeatState(SEAT)!;
    expect(after.rungs.find((r) => r.rung === "lifecycle-hooks")!.trust).toBe("trial");
  });

  it("两个席位是独立的（席位键控，从不会话全局）", () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: "node-a", sessionName: "a@rig" }, CLAUDE_INVENTORY);
    h.svc.declareRungInventory({ seatNodeId: "node-b", sessionName: "b@rig" }, CLAUDE_INVENTORY);
    h.svc.reportEvidence({ ...ev(h.clock, "self-report", "claude:pid-json", "working"), seatNodeId: "node-a", sessionName: "a@rig" });
    expect(h.svc.getSeatState("node-a")!.activity).toBe("working");
    expect(h.svc.getSeatState("node-b")!.activity).toBe("unknown");
  });
});
