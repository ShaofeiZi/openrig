// Slice-04（OPR.0.5.0.4）—— BR-2 禁止触发策略谓词（packet 3ffa3c22 §2 + BR-2）。
// 这是纯谓词（无副作用、不执行动作、不参与编排），只判断信号是否具备触发自动
// 切换的资格。对于未知、非 allow_switch_decision 或无法证明新鲜的信号，自动化
// 绝不触发。每个失败条件都会产生显式、可见的拒绝原因。

import type {
  AccountAuthState,
  PrecheckReason,
  PrecheckResult,
  ProviderKind,
  ProviderSignal,
} from "./provider-types.js";

export type AutomationRefusal =
  | "sourceClass_unknown"
  | "authority_unknown"
  | "not_allow_switch_decision"
  | "no_freshness_bound"
  | "unparsable_freshness_bound"
  | "stale";

export interface AutomationEligibility {
  eligible: boolean;
  refusals: AutomationRefusal[];
}

/**
 * BR-2 资格判断。只有信号已知（来源和权限明确）、显式为 `allow_switch_decision`，
 * 且可证明新鲜时才合格。新鲜度采用失败关闭：`staleAfter` 缺失或无法解析时均不合格
 * （NaN 绝不能比较为新鲜）。过期边界包含等号：`now >= staleAfter` 即为陈旧；
 * 无法解析的 `now` 同样不能证明新鲜，因此视为陈旧。
 */
export function signalEligibleForAutomation(
  signal: ProviderSignal,
  nowIso: string,
): AutomationEligibility {
  const refusals: AutomationRefusal[] = [];

  if (signal.sourceClass === "unknown") refusals.push("sourceClass_unknown");
  if (signal.authority === "unknown") refusals.push("authority_unknown");
  if (signal.automationUse !== "allow_switch_decision") refusals.push("not_allow_switch_decision");

  if (signal.staleAfter === undefined) {
    refusals.push("no_freshness_bound");
  } else {
    const staleMs = Date.parse(signal.staleAfter);
    if (Number.isNaN(staleMs)) {
      refusals.push("unparsable_freshness_bound");
    } else {
      const nowMs = Date.parse(nowIso);
      // 失败关闭：`now` 无法解析，或达到/超过边界时，都视为陈旧。
      if (Number.isNaN(nowMs) || nowMs >= staleMs) refusals.push("stale");
    }
  }

  return { eligible: refusals.length === 0, refusals };
}

// ── 预检：§1 切换安全门禁 ─────────────────────────────────────────────────────────
// precheckSwitch 判断把席位切换到目标账号是否安全，确保 UI 和自动化绝不提供不安全
// 动作。每个不安全条件都对应显式可见的原因，并按确定顺序组合。该谓词无副作用。

// BR-2 拒绝原因中表示触发信号未知/陈旧的子集；仅为 advisory 属于 BR-2 本身的关注点，
// 不属于预检的未知/陈旧问题。
const SIGNAL_UNKNOWN_OR_STALE_REFUSALS: readonly AutomationRefusal[] = [
  "sourceClass_unknown",
  "authority_unknown",
  "no_freshness_bound",
  "unparsable_freshness_bound",
  "stale",
];

/** 手动预检与自动预检共用字段。 */
interface PrecheckBase {
  /** 要切换到的目标账号所属提供方。 */
  targetProvider: ProviderKind;
  /** 使用时验证：在预检时检查目标认证状态，绝不预设。 */
  targetAuthState: AccountAuthState;
  /** 席位当前是否有正在进行的实时轮次/对话。 */
  seatHasLiveConversation: boolean;
}

/**
 * 手动预检既不携带触发信号，也不携带时钟；自动预检则两者都必须提供。配对联合类型
 * 让有类型调用方无法表达“有 trigger 但无 now”（在类型层封闭失败关闭漏洞）；下方
 * 运行时守卫覆盖无类型/JavaScript 调用方。
 */
export type PrecheckInput = PrecheckBase &
  ({ triggeringSignal?: undefined; now?: undefined } | { triggeringSignal: ProviderSignal; now: string });

export function precheckSwitch(input: PrecheckInput): PrecheckResult {
  const reasons: PrecheckReason[] = [];

  // 当前切换基础层的 rig auth 仅支持 codex，因此不能重新绑定 claude 目标。
  if (input.targetProvider === "claude") reasons.push("rebind_unsupported_for_runtime");

  // 使用时验证：只有确认 active 的目标才安全。needs_reauth 与 unknown 分别按自身原因
  // 失败关闭，绝不把 unknown 重新标记为需要重新认证。
  if (input.targetAuthState === "needs_reauth") reasons.push("target_needs_reauth");
  else if (input.targetAuthState === "unknown") reasons.push("target_auth_unknown");

  if (input.seatHasLiveConversation) reasons.push("would_strand_live_conversation");

  // 只有自动切换才携带触发信号。对无类型/JavaScript 调用方同样失败关闭：若 `now`
  // 缺失或无法解析，就无法证明新鲜；共享谓词把这种 now 映射为 NaN → stale，归入
  // 未知/陈旧子集。
  if (input.triggeringSignal !== undefined) {
    const { refusals } = signalEligibleForAutomation(input.triggeringSignal, input.now as string);
    if (refusals.some((r) => SIGNAL_UNKNOWN_OR_STALE_REFUSALS.includes(r))) {
      reasons.push("signal_unknown_or_stale");
    }
  }

  // 确定性去重，并保留插入顺序。
  const deduped = [...new Set(reasons)];
  return deduped.length === 0 ? { safe: true } : { safe: false, reasons: deduped };
}
