// OPR.0.4.4.22——工作组范围组合根（slice 22 FR-1..FR-4）。纯 composer 测试：相同输入
// 产生逐字节相同输出；只使用三个具名 ▲ heuristic；如实呈现 unknown；处处保留 provenance。

import { describe, it, expect } from "vitest";
import {
  composeRigAgents,
  deriveAgentScopeExceptions,
  IDLE_WITH_WORK_THRESHOLD_MIN,
  TOO_LONG_IN_STATE_THRESHOLD_MIN,
  type AgentInput,
  type AttentionInput,
  type RigComposeInputs,
} from "../src/domain/review/compose.js";
import type { SettledRow } from "../src/domain/review/types.js";

const NOW = "2026-07-04T18:00:00.000Z";

function agent(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    agentName: "driver1",
    sessionName: "dev44-driver1@openrig-delivery",
    runtime: "claude-code",
    parkedOn: null,
    idle: false,
    idleSinceIso: null,
    doing: "building the follow-mode half",
    holdsCount: 1,
    lastTransitionIso: "2026-07-04T17:50:00.000Z",
    slices: ["19-signal-layer"],
    ...overrides,
  };
}

function park(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    qitemId: "qitem-1",
    summary: "waiting on your follow-mode call",
    leg: "park-on-human",
    where: "human-review@kernel",
    createdAtIso: "2026-07-04T16:00:00.000Z",
    priority: "urgent",
    tier: "critical",
    evidenceRef: "proof/OPTIONS.md",
    unblocks: "qitem-1",
    destinationSession: "human-review@kernel",
    closureRequiredAtIso: null,
    ...overrides,
  };
}

function inputs(overrides: Partial<RigComposeInputs> = {}): RigComposeInputs {
  return {
    agents: [agent()],
    overdue: [],
    attention: [],
    settled: [],
    handoffsToday: 0,
    overdueCount: 0,
    rosterWindow: "today",
    nowIso: NOW,
    ...overrides,
  };
}

describe("composeRigAgents——FR-1 row + provenance", () => {
  it("每个智能体渲染一行 C6 doing 文本，绝不把 id 作为主要标签", () => {
    const composed = composeRigAgents(inputs());
    expect(composed.agents.rows).toHaveLength(1);
    expect(composed.agents.rows[0]!.doing).toBe("building the follow-mode half");
    expect(composed.agents.rows[0]!.agentName).toBe("driver1");
  });

  it("幂等 projection：相同输入 → 逐字节相同输出", () => {
    const a = composeRigAgents(inputs());
    const b = composeRigAgents(inputs());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("已证明为空的 roster 渲染带指定展示窗口的 provenance，绝不留下空区域", () => {
    const composed = composeRigAgents(inputs({ agents: [] }));
    expect(composed.agents.rows).toHaveLength(0);
    expect(composed.agents.provenance).toContain("没有正在或近期持有工作的智能体");
    expect(composed.agents.provenance).toContain("窗口：today");
    expect(composed.agents.provenance).toContain("queue+ps");
  });

  it("scope 负向：row 只携带智能体持有工作的 slice；分组输入按智能体 slice，而非工作组共存关系", () => {
    const composed = composeRigAgents(inputs({
      agents: [agent(), agent({ sessionName: "dev44-qa1@openrig-delivery", agentName: "qa1", slices: ["20-composer"] })],
    }));
    expect(composed.agents.rows[0]!.slices).toEqual(["19-signal-layer"]);
    expect(composed.agents.rows[1]!.slices).toEqual(["20-composer"]);
  });
});

describe("FR-2——真实 state glyph", () => {
  it("telemetry-down 智能体渲染为 unknown，绝不升级为 active/idle", () => {
    const composed = composeRigAgents(inputs({ agents: [agent({ idle: null, idleSinceIso: null })] }));
    expect(composed.agents.rows[0]!.stateGlyph).toBe("unknown");
  });

  it("健康 telemetry 从 recorded state 渲染 active/idle", () => {
    const composed = composeRigAgents(inputs({
      agents: [agent(), agent({ sessionName: "b@r", idle: true, idleSinceIso: "2026-07-04T17:00:00.000Z", holdsCount: 0 })],
    }));
    expect(composed.agents.rows[0]!.stateGlyph).toBe("active");
    expect(composed.agents.rows[1]!.stateGlyph).toBe("idle");
  });

  it("由 queue 证明的 parked work 在 row state 上优先于 runtime activity", () => {
    const composed = composeRigAgents(inputs({
      agents: [agent({ parkedOn: "human-review@kernel", idle: false, doing: "waiting on your follow-mode call" })],
    }));
    expect(composed.agents.rows[0]!.stateGlyph).toBe("parked");
    expect(composed.agents.rows[0]!.doing).toBe("waiting on your follow-mode call");
  });
});

describe("FR-3——智能体范围的三个具名 ▲ heuristic", () => {
  it("idle-with-assigned-work 超过 threshold 时内联携带 evidence + threshold", () => {
    const idleSince = "2026-07-04T17:13:00.000Z"; // 47m before NOW
    const composed = composeRigAgents(inputs({
      agents: [agent({ idle: true, idleSinceIso: idleSince, holdsCount: 2 })],
    }));
    const row = composed.agents.rows[0]!;
    expect(row.exception).not.toBeNull();
    expect(row.exception!.kind).toBe("stuck");
    expect(row.exception!.evidence).toBe(`空闲 47m >= 默认值 ${IDLE_WITH_WORK_THRESHOLD_MIN}m · 持有 2`);
  });

  it("unknown 不是 idle：不能从未知 activity state 派生 ▲", () => {
    const composed = composeRigAgents(inputs({
      agents: [agent({ idle: null, idleSinceIso: null, holdsCount: 3, lastTransitionIso: "2026-07-04T17:55:00.000Z" })],
    }));
    expect(composed.agents.rows[0]!.exception).toBeNull();
    expect(composed.needsYou.items.filter((i) => i.source === "derived")).toHaveLength(0);
  });

  it("只有已知 lastTransition 超过 threshold 时才触发 too-long-in-state，并内联 evidence", () => {
    const old = "2026-07-04T15:00:00.000Z"; // 180m before NOW ≥ 120m default
    const composed = composeRigAgents(inputs({ agents: [agent({ lastTransitionIso: old })] }));
    const row = composed.agents.rows[0]!;
    expect(row.exception).not.toBeNull();
    expect(row.exception!.threshold).toBe(`状态停留过久 >= ${TOO_LONG_IN_STATE_THRESHOLD_MIN}m`);
    expect(row.exception!.evidence).toContain("无转换 180m");
    // 没有 lastTransition → 没有 ▲，即无 evidence 就不指控。
    const unknownTransition = composeRigAgents(inputs({ agents: [agent({ lastTransitionIso: null })] }));
    expect(unknownTransition.agents.rows[0]!.exception).toBeNull();
  });

  it("逾期 handoff（超过 closure_required_at）作为派生 item 进入 NEEDS YOU", () => {
    const composed = composeRigAgents(inputs({
      overdue: [park({ closureRequiredAtIso: "2026-07-04T17:00:00.000Z" })],
    }));
    const overdue = composed.needsYou.items.find((i) => i.derived?.kind === "overdue");
    expect(overdue).toBeDefined();
    expect(overdue!.derived!.evidence).toContain("要求在");
  });

  it("one-count identity：即使 ▲ 同时供给 row 和 NEEDS YOU，也只出现一次", () => {
    const idleSince = "2026-07-04T17:13:00.000Z";
    const composed = composeRigAgents(inputs({
      agents: [agent({ idle: true, idleSinceIso: idleSince, holdsCount: 2 })],
    }));
    const identities = composed.needsYou.items.map((i) => i.identity);
    expect(new Set(identities).size).toBe(identities.length);
    const stuck = composed.needsYou.items.filter((i) => i.derived?.kind === "stuck");
    expect(stuck).toHaveLength(1);
  });

  it("slice-only ▲ class（insufficient-proof / stale-after-change）绝不能在智能体范围触发", () => {
    const items = deriveAgentScopeExceptions([agent()], [], "rig", NOW);
    expect(items.every((i) => i.derived!.kind === "stuck" || i.derived!.kind === "overdue")).toBe(true);
  });
});

describe("FR-4——coordination health + SETTLED（同一计算，两种渲染）", () => {
  it("health 行渲染今日 handoff 数 + overdue 数", () => {
    const composed = composeRigAgents(inputs({ handoffsToday: 4, overdueCount: 1 }));
    expect(composed.agents.coordinationHealth).toBe("今日 4 次交接 · 1 个逾期");
  });

  it("零 handoff 也渲染‘今日 0 次交接’并携带 provenance，绝不为空", () => {
    const composed = composeRigAgents(inputs());
    expect(composed.agents.coordinationHealth).toBe("今日 0 次交接 · 0 个逾期");
    expect(composed.settledProvenance).toContain("今日 0 次交接");
    expect(composed.settledProvenance).toContain("根据队列转换计算");
  });

  it("由同一查询提供时，SETTLED row 与 health 计数一致", () => {
    const settled: SettledRow[] = [
      { fromSession: "a@r", toSession: "b@r", summary: "shipped the panel", closedAtIso: NOW, qitemId: "qitem-9" },
    ];
    const composed = composeRigAgents(inputs({ settled, handoffsToday: settled.length }));
    expect(composed.settled).toHaveLength(1);
    expect(composed.agents.coordinationHealth).toContain("今日 1 次交接");
  });
});

describe("工作组范围 NEEDS YOU——park + 带 provenance 的 one-count", () => {
  it("智能体发起的 park 渲染 C6 summary，provenance 点名窗口", () => {
    const composed = composeRigAgents(inputs({ attention: [park()] }));
    expect(composed.needsYou.items[0]!.summary).toBe("waiting on your follow-mode call");
    expect(composed.needsYou.provenance).toContain("窗口：today");
  });
});
