// OPR.0.5.6.1——第 5 节投递规则引擎。
//
// 已存储的逐人 A-D 登记项与 availability 共同为每条消息确定且仅确定一个
// 与连接器无关的结果：interrupt、notify、digest 或 log。引擎使用 F-8 的
// owner-notification level 枚举和两个配置旋钮（同一套词汇、同一个分类器——来自 S14）；
// 不自行创建 transport 字面量或平行分类。派发仍归网关所有；availability 的时序
//（away 延迟）归引擎所有，并复用 watchdog 底座（AM-F1：不引入第三套定时器引擎）。
//
// 登记映射，只在此定义一次（mini-req 1，A1.5 词汇）：
//   A——interrupt-always   → interrupt
//   B——hub-exceptions     → notify（升级后为 interrupt）
//   C——worker-parked      → digest，4 小时窗口
//   D——milestones         → digest，每日窗口
//   log 绝不是登记单元格；它是低于 minimum-level-that-posts 旋钮的消息结果
//   （F-8 RECORD）——只保留持久行，不发布。
//
// AVAILABILITY（全新枚举；仅当 availability 字段整体缺失时，旧 `away: true` 才按
// availability=away 读取——D1 约定）：
//   available — 不调整
//   focus     — 将普通 interrupt 降为 notify；escalation 仍会 interrupt
//   away      — 静音普通 mention；非 A 类 escalation 变为 T+30 向同一人的一次延迟
//               interrupt（M1 第 5 节预设，AM-F3）；A 类仍立即执行
//               （interrupt-ALWAYS 是人自己给出的更强指示）
//   off       — 原样遵守 F-7：escalation 也不能覆盖 off。投递不会被抑制（F-8）：
//               post 仍会落下但不 mention，并响亮记录单人终止。
//
// 投递状态表（AM-F4——只在一处定义，并以 S14 回执戳记为准；引擎绝不改写 transport 裁决）：
//   queued    = 行已存在，尚无投递迁移
//   posted    = 行上已有 S14 posted 回执迁移
//   notified  = 已 posted 且决定为 interrupt（mention 已投递）
//   replied   = 某条入站回复行引用该会话
//   transport-failed = S14 transport-failed 迁移（没有第二种拼写；"post-failed" 不存在）
//   `seen` 不存在且无法表示（设计第 6 节：不可证明）。

import type { OwnerNotificationLevel } from "../queue-transition-log.js";
import { ownerNotificationLevelAtLeast } from "../queue-transition-log.js";
import { WAKE_ESCALATION_TAG } from "../queue-wake-ladder.js";

export const DELIVERY_OUTCOMES = ["interrupt", "notify", "digest", "log"] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export const AVAILABILITY_MODES = ["available", "focus", "away", "off"] as const;
export type AvailabilityMode = (typeof AVAILABILITY_MODES)[number];

export const AWAY_ESCALATION_DEFER_MINUTES = 30;

export const DIGEST_WINDOWS = { C: "4h", D: "daily" } as const;

/** 单人终止记录（A1.1）：对 away/off 人员的 escalation 终止于记录的底线——
 *  who、availability、no-fallback-available，以及裁决出的投递结果。
 *  多人回退边属于 0.5.7；本接缝无需改变词汇即可承接。 */
export interface DeliveryTermination {
  who: string;
  availability: AvailabilityMode;
  noFallbackAvailable: true;
  deliveryOutcome: DeliveryOutcome;
}

export interface DeliveryDecision {
  outcome: DeliveryOutcome;
  /** 当且仅当 interrupt 时 mention；quiet 单元格从构造上绝不 mention。 */
  mention: boolean;
  digestWindow?: "4h" | "daily";
  /** 仅延迟的 away-escalation interrupt 存在；在 T+N 触发一次。 */
  deferMinutes?: number;
  termination?: DeliveryTermination;
}

export interface DeliveryDecisionInput {
  level: OwnerNotificationLevel | null;
  escalation: boolean;
  human: {
    entityId: string;
    deliveryClass: "A" | "B" | "C" | "D";
    availability: AvailabilityMode;
  };
  dials: {
    minimumLevelThatPosts: OwnerNotificationLevel;
    minimumLevelThatInterrupts: OwnerNotificationLevel;
  };
}

/** 整字段缺失时的旧版推断（D1 约定）：仅当 availability 字段缺失时，
 *  `away: true` 才读取为 availability=away。已存在的 availability 是权威；
 *  冲突在 fragment 校验时拒绝，绝不在此静默解决。 */
export function resolveAvailability(prefs: { availability?: string; away?: boolean }): AvailabilityMode {
  if (prefs.availability !== undefined) return prefs.availability as AvailabilityMode;
  if (prefs.away === true) return "away";
  return "available";
}

/** escalation 类别派生——只用一个谓词（阶梯聚合 tag 或显式 escalation tag），绝不读取文案。 */
export function isEscalationClass(tags: readonly string[] | null | undefined): boolean {
  if (!tags) return false;
  return tags.includes(WAKE_ESCALATION_TAG) || tags.includes("escalation");
}

export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  const level = input.level ?? "RECORD";
  const { deliveryClass, availability, entityId } = input.human;

  // 低于 posts 旋钮：只持久化——行始终落地，但不发布。
  if (!ownerNotificationLevelAtLeast(level, input.dials.minimumLevelThatPosts)) {
    return { outcome: "log", mention: false };
  }

  // 登记基线由 escalation 提升；escalation 绝不进入 digest。
  let outcome: DeliveryOutcome =
    input.escalation ? "interrupt"
    : deliveryClass === "A" ? "interrupt"
    : deliveryClass === "B" ? "notify"
    : "digest";

  // interrupts 旋钮（引擎保持 S14 语义）：低于旋钮的 interrupt 降为 notify——
  // 发布资格与打断资格是两个独立轴（F-8）。
  if (outcome === "interrupt" && !ownerNotificationLevelAtLeast(level, input.dials.minimumLevelThatInterrupts)) {
    outcome = "notify";
  }

  let deferMinutes: number | undefined;
  let termination: DeliveryTermination | undefined;

  switch (availability) {
    case "available":
      break;
    case "focus":
      // focus 静音普通 interrupt；escalation 仍会 interrupt（设计第 3 节）。
      // A 类是两种 quiet 模式的例外（此处 focus、下方 away）：
      // interrupt-ALWAYS 是人自己给出的更强指示。
      if (outcome === "interrupt" && !input.escalation && deliveryClass !== "A") outcome = "notify";
      break;
    case "away":
      if (input.escalation) {
        // 为每个 away/off escalation 记录单人底线（A1.1）。
        if (outcome === "interrupt" && deliveryClass !== "A") {
          // 泛化 M1 第 5 节预设（有文档的统一非 A 规则）：T+30 时向同一人
          // 延迟 interrupt 一次，绝不是立即一次再延迟一次（AM-F3）。
          deferMinutes = AWAY_ESCALATION_DEFER_MINUTES;
        }
        termination = { who: entityId, availability, noFallbackAvailable: true, deliveryOutcome: outcome };
      } else if (outcome === "interrupt" && deliveryClass !== "A") {
        outcome = "notify"; // 设计第 3 节：away 的普通消息会 post，但不 mention
      }
      break;
    case "off":
      // 原样遵守 F-7：escalation 不能覆盖 off；会打断的 off 就不是 off。
      // 投递绝不被抑制（F-8）：持久行、post 和回执仍会落下，但不 mention。
      if (outcome === "interrupt") outcome = "notify";
      if (input.escalation) {
        termination = { who: entityId, availability, noFallbackAvailable: true, deliveryOutcome: outcome };
      }
      break;
  }

  // 当且仅当 interrupt 时 mention。对延迟 interrupt，mention 随 T+30 触发而非 sweep；
  // 投递层持有 post，该标志描述已裁决的响度，所有单元格共用一条规则。
  return {
    outcome,
    mention: outcome === "interrupt",
    ...(outcome === "digest" ? { digestWindow: DIGEST_WINDOWS[deliveryClass as "C" | "D"] ?? "4h" } : {}),
    ...(deferMinutes !== undefined ? { deferMinutes } : {}),
    ...(termination !== undefined ? { termination } : {}),
  };
}

/** 终止迁移字面量——归引擎所有且只定义一次。它是行侧记录；读取方匹配前缀，
 *  与阶梯 marker 词汇采用相同纪律。 */
export const DELIVERY_TERMINATION_PREFIX = "delivery-termination:";

export function formatDeliveryTermination(t: DeliveryTermination, notificationKey: string): string {
  return [
    DELIVERY_TERMINATION_PREFIX,
    `who=${t.who}`,
    `availability=${t.availability}`,
    "no-fallback-available",
    `outcome=${t.deliveryOutcome}`,
    `notification_key=${notificationKey}`,
  ].join(" ");
}
