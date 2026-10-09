// S04（OPR.0.5.5.4）——PICKUP RECEIPT：仅派生。“无人唤醒的持久 row 与正在进行的工作无法区分”——
// 本模块只根据系统已有事实（claimed_at、transition log、last_heartbeat）与 config 指定 threshold
// 派生差异。任何位置都不存在 claimant 编写的 receipt（要求 seat 记得发送 receipt 会重现这里要消除的
// attention gap），这里也没有 sweep loop（S02 拥有常驻 sweep；本模块导出它所消费的 INPUT 契约）。
//
// working activity 是正向 liveness evidence，不是 task progress 证明。否则 grace 依据最近一次有意义的
// queue change；旧 note 不能让 row 永久维持 working。Stalled-after-claim 点名该 evidence，但不根据
// age 推断 idle/dead。Blocked 保持 parked；wake health 单独派生。没有 timestamp 的 legacy caller 保留
// count 语义。Queue row 的 last_heartbeat 已正式 supersede（2026-08-30，S24 F-14）；reader 仍容忍
// null。只有知道 in-flight row 的 0.5.7 mechanized-pull turn-end hook 会重新开启接线，它是首个诚实的
// row-scoped writer。daemon-lifecycle-store.recordHeartbeat 保持 live 且独立。

import { SettingsStore } from "./user-settings/settings-store.js";

export const PICKUP_STALL_THRESHOLD_KEY = "queue.pickup_stall_threshold_minutes";
export const DEFAULT_PICKUP_STALL_THRESHOLD_MINUTES = 3;

export interface PickupReceipt {
  state: "unclaimed" | "working" | "stalled-after-claim" | "parked";
  /** 仅 stalled 时存在：取代手工跨 surface join 的具名 evidence。 */
  evidence?: string;
}

/** Threshold，每次调用都 fresh read（遵循 terminal.status_bar 先例：config flip 在下一次读取生效，
 *  无需 restart）。任何解析错误都 fail-open 到默认值。 */
export function resolvePickupThresholdMinutes(): number {
  try {
    const v = new SettingsStore().resolveOne(PICKUP_STALL_THRESHOLD_KEY).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PICKUP_STALL_THRESHOLD_MINUTES;
  } catch {
    return DEFAULT_PICKUP_STALL_THRESHOLD_MINUTES;
  }
}

export interface PickupFacts {
  state: string;
  claimedAt: string | null | undefined;
  lastHeartbeat: string | null | undefined;
  /** 严格晚于 claim 的 transition 数，不含 claim 自身的 transition。 */
  postClaimMotionCount: number;
  lastMeaningfulAt?: string;
  activity?: string;
  needsInput?: number;
  now?: Date;
  thresholdMinutes?: number;
}

/** 唯一派生规则——每个 projection surface（rowToItem、pickup view lens、S02 finding input）都调用
 *  同一 function，因此规则不会在 surface 间 drift。 */
export function derivePickup(facts: PickupFacts): PickupReceipt {
  if (facts.state === "blocked") return { state: "parked" };
  if (!facts.claimedAt) return { state: "unclaimed" };
  const now = facts.now ?? new Date();
  const claimedMs = Date.parse(facts.claimedAt);
  // 为知道 in-flight row 的 0.5.7 mechanized-pull turn-end hook 保留此 null 分支；它是首个诚实的
  // row-scoped writer，且只有该 slice 会重新开启接线。
  const heartbeatAfterClaim =
    !!facts.lastHeartbeat && Date.parse(facts.lastHeartbeat) > claimedMs;
  if (facts.activity === "working" && !facts.needsInput) return { state: "working" };
  // 没有 timestamp 的 legacy caller 保留历史 count 契约。
  if (facts.lastMeaningfulAt === undefined && (facts.postClaimMotionCount > 0 || heartbeatAfterClaim)) return { state: "working" };
  const thresholdMs = (facts.thresholdMinutes ?? resolvePickupThresholdMinutes()) * 60_000;
  const anchor = Math.max(claimedMs, Date.parse(facts.lastMeaningfulAt ?? facts.claimedAt), heartbeatAfterClaim ? Date.parse(facts.lastHeartbeat!) : claimedMs);
  const ageMs = now.getTime() - anchor;
  if (ageMs <= thresholdMs) return { state: "working" };
  const minutes = Math.floor(ageMs / 60_000);
  return {
    state: "stalled-after-claim",
    evidence: facts.lastMeaningfulAt === undefined
      ? `${minutes} 分钟前已领取，此后没有实质 transition`
      : `${minutes} 分钟内没有有意义的 queue change；owner activity 为 ${facts.activity ?? "unknown"}（queue age 不能证明 idle）`,
  };
}

/** S02 INPUT 契约——常驻 sweep 消费的 finding 形态（先路由到 claimant，再到其 orchestrator——routing
 *  属于 S02；这里只是纯 library 形态，无 loop、无 scheduler）。非 stalled 时返回 null。 */
export interface StalledPickupFinding {
  kind: "stalled-after-claim";
  /** claimant（row 的 destination——领取后沉默的 seat）。 */
  target: string;
  qitemId: string;
  evidence: string;
}

export function stalledPickupFinding(item: {
  qitemId: string;
  destinationSession?: string | null;
  pickup?: PickupReceipt;
}): StalledPickupFinding | null {
  if (item.pickup?.state !== "stalled-after-claim") return null;
  return {
    kind: "stalled-after-claim",
    target: item.destinationSession ?? "",
    qitemId: item.qitemId,
    evidence: item.pickup.evidence ?? "",
  };
}
