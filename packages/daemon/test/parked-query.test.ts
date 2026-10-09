import { describe, it, expect } from "vitest";
import {
  diagnoseSeatParked,
  diagnoseRigParked,
  PARKED_OBLIGATION_LIMIT,
  type ParkedQueryDeps,
  type ObligationRow,
} from "../src/domain/parked-query.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A7——停滞查询，先红后绿且双侧取证（AM-3）。基线中没有任何接口回答
//“我们是否停滞？”——这些固定项定义派生诊断，包括逐输入置信度、具名义务范围和数量限制防护。

const SEAT = { seatNodeId: "node-1", sessionName: "dev50-qa@v-openrig-build" };

function oracleState(overrides: Partial<ArbitratedSeatState>): ArbitratedSeatState {
  return {
    seatNodeId: SEAT.seatNodeId,
    activity: "idle-at-prompt",
    needsInput: { count: 0, reason: null },
    decidedBy: "window-sampling",
    seq: 7,
    changedAt: "2026-08-26T23:00:00.000Z",
    rungs: [],
    lastSwap: null,
    ...overrides,
  };
}

function deps(
  state: ArbitratedSeatState | null,
  rows: ObligationRow[],
  limit = PARKED_OBLIGATION_LIMIT,
  wakes: Record<string, unknown> = {},
): ParkedQueryDeps & { scopes: string[]; getParkWake: (qitemId: string) => unknown } {
  const scopes: string[] = [];
  return {
    scopes,
    getSeatState: () => state,
    getParkWake: (qitemId) => wakes[qitemId] ?? null,
    listOpenObligations: (destination, lim) => {
      scopes.push(`${destination}:${lim}`);
      return { rows: rows.slice(0, lim), limit: lim };
    },
  };
}

const pendingRow: ObligationRow = { qitemId: "qitem-1", state: "pending", summary: "review the thing" };
const heldRow: ObligationRow = { qitemId: "qitem-2", state: "blocked", summary: "deliberately held" };

describe("S19 A7——涵盖两类停滞原因的派生诊断", () => {
  it("接棒中断停滞：提示处空闲 × 存在开放待处理行 → PARKED，并包含双侧证据", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [pendingRow]), SEAT);
    expect(d.parked).toBe(true);
    expect(d.activity.value).toBe("idle-at-prompt");
    expect(d.activity.confidence).toBe("oracle");
    expect(d.obligations.openCount).toBe(1);
    expect(d.obligations.items[0]!.qitemId).toBe("qitem-1");
    expect(d.reason).toMatch(/idle/i);
  });

  it("等待输入停滞：带义务的待处理阻塞 → PARKED（创始人观察到的第二类原因）", () => {
    const state = oracleState({ activity: "working", needsInput: { count: 1, reason: "permission prompt" } });
    const d = diagnoseSeatParked(deps(state, [pendingRow]), SEAT);
    expect(d.parked).toBe(true);
    expect(d.reason).toMatch(/needs.input|permission/i);
  });

  it("正在履行义务时不是停滞", () => {
    const d = diagnoseSeatParked(deps(oracleState({ activity: "working" }), [pendingRow]), SEAT);
    expect(d.parked).toBe(false);
  });

  it("看板为空时的空闲不是停滞（没有待办工作的空闲只是空闲）", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), []), SEAT);
    expect(d.parked).toBe(false);
  });

  it("R25：无唤醒的 HELD 行驱动诊断，并内联说明每条修复路径", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow]), SEAT);
    expect(d.parked).toBe(true);
    expect(d.obligations.heldCount).toBe(1);
    expect(d.obligations.openCount).toBe(0);
    expect(d.reason).toMatch(/watchdog ID/i);
    expect(d.reason).toMatch(/timer/i);
    expect(d.reason).toMatch(/有效的 blocker/i);
    expect(d.reason).toMatch(/并非即将执行.*工作区归属/i);
  });

  it("R25 负向对照：HELD 行有存活且已启用的唤醒时保持健康", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow], PARKED_OBLIGATION_LIMIT, {
      "qitem-2": { kind: "watchdog", ref: "job-1", live: true, unconsumed: false },
    }), SEAT);
    expect(d.parked).toBe(false);
    expect(d.reason).toMatch(/有效 wake.*状态健康/i);
  });

  it("S16 保留具名 provider-limit 唤醒的可选绝对到期时间", () => {
    const expiresAt = "2026-08-28T13:00:00.000Z";
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow], PARKED_OBLIGATION_LIMIT, {
      "qitem-2": {
        kind: "blocker",
        ref: "qitem-provider-limit",
        live: true,
        phase: "armed",
        deliveryStatus: null,
        unconsumed: false,
        expiresAt,
      },
    }), SEAT);

    expect(d.parked).toBe(false);
    expect(d.obligations.held[0]?.wake).toMatchObject({ expiresAt });
  });

  it("R25：已触发但仍阻塞的唤醒显示为未消费", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow], PARKED_OBLIGATION_LIMIT, {
      "qitem-2": { kind: "timer", ref: "job-timer", live: true, unconsumed: true, deliveryStatus: "ok" },
    }), SEAT);
    expect(d.parked).toBe(true);
    expect(d.reason).toMatch(/未消费/i);
  });

  it("HELD 与 pending 同时存在：停滞于 pending 行，并在旁边公开 held", () => {
    const d = diagnoseSeatParked(deps(oracleState({}), [heldRow, pendingRow]), SEAT);
    expect(d.parked).toBe(true);
    expect(d.obligations.openCount).toBe(1);
    expect(d.obligations.heldCount).toBe(1);
    expect(d.reason).toMatch(/watchdog ID|timer|有效的 blocker/i);
  });
});

describe("S19 A7——AM-3：双侧置信度、具名范围与数量限制防护", () => {
  it("活动状态为 UNKNOWN → 判定为 INDETERMINATE，绝不猜测为 NOT-PARKED", () => {
    const d = diagnoseSeatParked(deps(oracleState({ activity: "unknown", decidedBy: null }), [pendingRow]), SEAT);
    expect(d.parked).toBe("indeterminate");
    expect(d.confidence.activity).toBe("none");
    expect(d.reason).toMatch(/未知|无法/i);
  });

  it("完全没有 oracle 状态 → INDETERMINATE，并指明缺失输入", () => {
    const d = diagnoseSeatParked(deps(null, [pendingRow]), SEAT);
    expect(d.parked).toBe("indeterminate");
    expect(d.confidence.activity).toBe("none");
  });

  it("输出中明确义务范围（destination + open-state，即实际执行的读取）", () => {
    const dp = deps(oracleState({}), [pendingRow]);
    const d = diagnoseSeatParked(dp, SEAT);
    expect(d.obligations.scope).toContain(SEAT.sessionName);
    expect(d.obligations.scope).toMatch(/pending/);
    expect(dp.scopes).toHaveLength(1); // exactly one read, matching the named scope
  });

  it("数量限制防护：达到上限的看板如实返回可能截断，绝不静默推导计数", () => {
    const many: ObligationRow[] = Array.from({ length: PARKED_OBLIGATION_LIMIT + 50 }, (_, i) => ({
      qitemId: `qitem-load-${i}`,
      state: "pending" as const,
    }));
    const d = diagnoseSeatParked(deps(oracleState({}), many), SEAT);
    expect(d.parked).toBe(true); // truncation can only UNDERCOUNT — parked stands
    expect(d.obligations.complete).toBe(false);
    expect(d.confidence.obligations).toBe("truncation-possible");
  });

  it("读取时派生：看板变化后的两次调用给出不同答案（从不存储）", () => {
    const state = oracleState({});
    expect(diagnoseSeatParked(deps(state, [pendingRow]), SEAT).parked).toBe(true);
    expect(diagnoseSeatParked(deps(state, []), SEAT).parked).toBe(false);
  });
});

describe("S19 A7——工作组级：“我们是否停滞？”", () => {
  it("任何席位停滞时工作组即停滞，并指明停滞席位", () => {
    const seats = [
      { seatNodeId: "node-1", sessionName: "a@rig" },
      { seatNodeId: "node-2", sessionName: "b@rig" },
    ];
    const states: Record<string, ArbitratedSeatState> = {
      "node-1": oracleState({ seatNodeId: "node-1", activity: "working" }),
      "node-2": oracleState({ seatNodeId: "node-2" }), // idle
    };
    const d = diagnoseRigParked({
      getSeatState: (id) => states[id] ?? null,
      listOpenObligations: (dest) => ({ rows: dest === "b@rig" ? [pendingRow] : [], limit: PARKED_OBLIGATION_LIMIT }),
    }, seats);
    expect(d.parked).toBe(true);
    expect(d.seats.find((s) => s.seatNodeId === "node-2")!.parked).toBe(true);
    expect(d.seats.find((s) => s.seatNodeId === "node-1")!.parked).toBe(false);
  });

  it("所有席位工作中或无待办 → 不停滞；任何不确定席位都会使工作组判定不确定（绝不误报全部正常）", () => {
    const seats = [
      { seatNodeId: "node-1", sessionName: "a@rig" },
      { seatNodeId: "node-2", sessionName: "b@rig" },
    ];
    const states: Record<string, ArbitratedSeatState | null> = {
      "node-1": oracleState({ seatNodeId: "node-1", activity: "working" }),
      "node-2": null, // oracle has nothing — indeterminate
    };
    const d = diagnoseRigParked({
      getSeatState: (id) => states[id] ?? null,
      listOpenObligations: () => ({ rows: [pendingRow], limit: PARKED_OBLIGATION_LIMIT }),
    }, seats);
    expect(d.parked).toBe("indeterminate");
    expect(d.reason).toMatch(/node-2|indeterminate/i);
  });
});
