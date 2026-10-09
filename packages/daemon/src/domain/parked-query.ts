// OPR.0.5.5.19 A7——PARKED 查询是旗舰 consumer（创始人的单命令问题）：工作组层级回答
// “我们是否停滞？”，席位层级回答“此席位是否停滞？”。PARKED 是派生诊断
//（taxonomy 规则：读取时计算，绝不存储）：
//（活动 = 停在提示符处空闲，或等待输入未处理）×（存在开放义务）。
//
// JOIN 位于此处，而非 SeatActivityService，以维持 oracle 的非推断契约；本模块接收 obligation
// READER，绝不写入队列状态。
//
// AM-3（verdict 1229a4b7）：parked 继承两个输入的错误项，而 obligation 界面存在已测量的不诚实模式
//（closure 后仍残留 stale blockedOn、裸 scope 造成错误缺失、limit 截断）。因此查询会具名说明
// obligation scope，通过“返回数量小于 limit”检查守卫上限，并返回两个输入各自的 CONFIDENCE。
// 因遗漏 obligation 而得到错误 NOT-PARKED，等于在更高层重建创始人所说的 undetected-park 类；
// 此输出让这类失败变得可见，而不是任其发生。
//
// S19 A7 RED：尚未接线。

import type { ArbitratedSeatState, NeedsInput } from "./activity-taxonomy.js";

/** 队列 obligation 界面中的一条 open obligation。HELD 行（state=blocked，即带 owner 和解决路径的
 *  有意队列级 hold）属于词表中的 NOT-parked 情形，会单独呈现，绝不计入触发 parked 的行。 */
export interface ObligationRow {
  qitemId: string;
  state: "pending" | "in-progress" | "blocked";
  summary?: string | null;
}

export interface ParkWakeDiagnosis {
  kind: "watchdog" | "timer" | "blocker";
  ref: string;
  live: boolean;
  phase?: "armed" | "fired";
  deliveryStatus?: string | null;
  unconsumed: boolean;
  recoveryOwner?: "queue-stuck-sweep";
  expiresAt?: string;
}

export interface HeldObligation extends ObligationRow {
  state: "blocked";
  wake: ParkWakeDiagnosis | null;
  healthy: boolean;
}

export interface ObligationRead {
  /** reader 返回的行，受 `limit` 限制。 */
  rows: ObligationRow[];
  /** reader 应用的上限，即 guard 输入。 */
  limit: number;
}

export interface ParkedQueryDeps {
  getSeatState: (seatNodeId: string) => ArbitratedSeatState | null;
  /** obligation 界面，限定为 destination + open-state；查询绝不静默放宽或收窄。
   *  结果中的 scope 字符串会准确说明实际执行的范围。 */
  listOpenObligations: (destinationSession: string, limit: number) => ObligationRead;
  /** 仅对 073 前 fixture 可选；缺失时如实视为没有 wake。 */
  getParkWake?: (qitemId: string) => unknown;
}

export interface SeatParkedDiagnosis {
  seatNodeId: string;
  sessionName: string;
  /** true / false；输入不足以支持 verdict 时为 `indeterminate`。 */
  parked: boolean | "indeterminate";
  reason: string;
  activity: {
    value: string;
    needsInput: NeedsInput;
    decidedBy: string | null;
    confidence: "oracle" | "unknown";
  };
  obligations: {
    /** 实际执行的精确 scope；具名记录，便于审计错误缺失。 */
    scope: string;
    openCount: number;
    heldCount: number;
    unhealthyHeldCount: number;
    /** returned == limit 时为 false，表示数量可能被截断；绝不静默。 */
    complete: boolean;
    limit: number;
    items: ObligationRow[];
    held: HeldObligation[];
  };
  confidence: { activity: "high" | "none"; obligations: "complete" | "truncation-possible" | "unavailable" };
}

export interface RigParkedDiagnosis {
  parked: boolean | "indeterminate";
  reason: string;
  seats: SeatParkedDiagnosis[];
}

export const PARKED_OBLIGATION_LIMIT = 500;

const HELD_REMEDY = "处理建议：附加有效的 watchdog ID、设置原子 timer，或指定有效的 blocker qitem。队列是传送带：已延期或并非即将执行、且有工作区归属的工作，应放入对应工作区的任务目标/切片，而不是留在 HELD。";

function parseWake(value: unknown): ParkWakeDiagnosis | null {
  if (!value || typeof value !== "object") return null;
  const wake = value as Record<string, unknown>;
  if (!(["watchdog", "timer", "blocker"] as unknown[]).includes(wake.kind)) return null;
  if (typeof wake.ref !== "string" || typeof wake.live !== "boolean") return null;
  return {
    kind: wake.kind as ParkWakeDiagnosis["kind"],
    ref: wake.ref,
    live: wake.live,
    phase: wake.phase === "armed" || wake.phase === "fired" ? wake.phase : undefined,
    deliveryStatus: typeof wake.deliveryStatus === "string" ? wake.deliveryStatus : null,
    unconsumed: wake.unconsumed === true,
    ...(wake.recoveryOwner === "queue-stuck-sweep" ? { recoveryOwner: "queue-stuck-sweep" as const } : {}),
    ...(typeof wake.expiresAt === "string" ? { expiresAt: wake.expiresAt } : {}),
  };
}

export function diagnoseSeatParked(
  deps: ParkedQueryDeps,
  seat: { seatNodeId: string; sessionName: string },
): SeatParkedDiagnosis {
  const state = deps.getSeatState(seat.seatNodeId);
  const scope = `destination=${seat.sessionName} state=pending,in-progress,blocked limit=${PARKED_OBLIGATION_LIMIT}`;
  const read = deps.listOpenObligations(seat.sessionName, PARKED_OBLIGATION_LIMIT);
  const held: HeldObligation[] = read.rows.filter((r) => r.state === "blocked").map((row) => {
    const wake = parseWake(deps.getParkWake?.(row.qitemId));
    return { ...row, state: "blocked", wake, healthy: wake?.live === true && (!wake.unconsumed || wake.recoveryOwner === "queue-stuck-sweep") };
  });
  const unhealthyHeld = held.filter((row) => !row.healthy);
  const open = read.rows.filter((r) => r.state !== "blocked");
  const complete = read.rows.length < read.limit;

  const obligations: SeatParkedDiagnosis["obligations"] = {
    scope,
    openCount: open.length,
    heldCount: held.length,
    unhealthyHeldCount: unhealthyHeld.length,
    complete,
    limit: read.limit,
    items: open,
    held,
  };

  const activityKnown = state !== null && state.activity !== "unknown";
  const activity: SeatParkedDiagnosis["activity"] = {
    value: state?.activity ?? "unknown",
    needsInput: state?.needsInput ?? { count: 0, reason: null },
    decidedBy: state?.decidedBy ?? null,
    confidence: activityKnown ? "oracle" : "unknown",
  };
  const confidence: SeatParkedDiagnosis["confidence"] = {
    activity: activityKnown ? "high" : "none",
    obligations: complete ? "complete" : "truncation-possible",
  };

  // 诊断公式：(idle-at-prompt OR needs-input pending) × open obligations。activity-unknown
  // 永远不足以支持 verdict，应返回 INDETERMINATE，绝不能猜测 NOT-PARKED（否则会在更高层重建
  // 创始人所说的 undetected-park 类）。截断只会少算 obligation，因此正向 verdict 在截断时仍成立。
  if (!activityKnown) {
    return {
      seatNodeId: seat.seatNodeId,
      sessionName: seat.sessionName,
      parked: "indeterminate",
      reason: `${seat.sessionName} 的 activity 未知，oracle 无法支持 parked verdict（仍已读取 obligation 界面：${open.length} 个 open，${held.length} 个 held）`,
      activity,
      obligations,
      confidence,
    };
  }

  const stopped = state.activity === "idle-at-prompt" || state.needsInput.count > 0;
  const parked = stopped && (open.length > 0 || unhealthyHeld.length > 0);
  const unconsumed = unhealthyHeld.filter((row) => row.wake?.unconsumed);
  const reason = parked
    ? state.needsInput.count > 0
      ? `needs-input（${state.needsInput.reason ?? "存在未响应阻塞"}），有 ${open.length} 个 open obligation 和 ${unhealthyHeld.length} 个不健康 HELD 行。${unconsumed.length > 0 ? `${unconsumed.length} 个 wake 已触发但仍未消费。` : ""}${HELD_REMEDY}`
      : `idle-at-prompt，带有 ${open.length} 个 open obligation 和 ${unhealthyHeld.length} 个不健康 HELD 行。${unconsumed.length > 0 ? `${unconsumed.length} 个 wake 已触发但仍未消费。` : ""}${HELD_REMEDY}`
    : stopped
      ? held.length > 0
        ? `已停止，但 ${held.length} 个 HELD 行都拥有有效 wake 且状态健康，因此并未 parked`
        : "已停止，但任务板为空"
      : `正在工作，并未 parked`;

  return {
    seatNodeId: seat.seatNodeId,
    sessionName: seat.sessionName,
    parked,
    reason,
    activity,
    obligations,
    confidence,
  };
}

export function diagnoseRigParked(
  deps: ParkedQueryDeps,
  seats: Array<{ seatNodeId: string; sessionName: string }>,
): RigParkedDiagnosis {
  const diagnoses = seats.map((s) => diagnoseSeatParked(deps, s));
  const parkedSeats = diagnoses.filter((d) => d.parked === true);
  const indeterminate = diagnoses.filter((d) => d.parked === "indeterminate");
  if (parkedSeats.length > 0) {
    return {
      parked: true,
      reason: `${parkedSeats.length} 个席位已 parked：${parkedSeats.map((d) => d.sessionName).join(", ")}`,
      seats: diagnoses,
    };
  }
  if (indeterminate.length > 0) {
    // 不可读取的席位可能隐藏 park，因此工作组 verdict 不得声称全部正常。
    return {
      parked: "indeterminate",
      reason: `没有可证明已 parked 的席位，但 ${indeterminate.length} 个席位状态不确定（${indeterminate.map((d) => d.seatNodeId).join(", ")}），不能视为全部正常`,
      seats: diagnoses,
    };
  }
  return { parked: false, reason: "没有席位处于 parked 状态", seats: diagnoses };
}
