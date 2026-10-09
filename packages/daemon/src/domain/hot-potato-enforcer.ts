/**
 * Hot-potato 严格拒绝契约（PL-004 Phase A）。
 *
 * 关键 API 契约：任何把 queue_item 转换为 `done` 的代码路径，都必须传入下方枚举中的合法
 * `closure_reason`。该约束在此层执行，而不是在路由或 CLI 层执行，因此所有访问队列的界面
 * 都会继承同一保证。
 *
 * 合法 closure reason：
 *   - handed_off_to  ：工作由另一席位继续（closure_target = 新 owner）
 *   - blocked_on     ：工作暂停，等待另一 qitem（closure_target = blocker qitem_id）
 *   - denied         ：接收方拒绝工作（closure_target = 原因文本）
 *   - canceled       ：发送方或接收方撤回（closure_target = 备注）
 *   - no-follow-on   ：终态完成，无需后续处理
 *   - escalation     ：升级到更高层级（closure_target = 升级目标）
 */

export const CLOSURE_REASONS = [
  "handed_off_to",
  "blocked_on",
  "denied",
  "canceled",
  "no-follow-on",
  "escalation",
  // 0.5.1-53 Atom 2a——通过 cancel-and-replace 修正的行记录 SUPERSEDED，并以 successor 作为
  // closure_target，从而区别于废弃的 cancel（closure_reason=null）。
  "superseded",
] as const;

export type ClosureReason = (typeof CLOSURE_REASONS)[number];

export interface ClosureRequest {
  state: string;
  closureReason?: string | null;
  closureTarget?: string | null;
}

export interface ClosureValidationOk {
  ok: true;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
}

export interface ClosureValidationErr {
  ok: false;
  code: "missing_closure_reason" | "invalid_closure_reason" | "missing_closure_target";
  message: string;
  validReasons?: readonly string[];
}

export type ClosureValidation = ClosureValidationOk | ClosureValidationErr;

/**
 * 校验状态转换的 closure 义务。
 * - state !== `done`：不要求 closure_reason，透传已提供的值。
 * - state === `done`：closure_reason 必填且必须属于 CLOSURE_REASONS。
 *   handed_off_to / blocked_on / escalation 还要求 closure_target。
 */
export function validateClosure(req: ClosureRequest): ClosureValidation {
  if (req.state !== "done") {
    return {
      ok: true,
      closureReason: (req.closureReason ?? null) as ClosureReason | null,
      closureTarget: req.closureTarget ?? null,
    };
  }

  if (!req.closureReason) {
    return {
      ok: false,
      code: "missing_closure_reason",
      message: `state=done 要求 closure_reason；合法值：${CLOSURE_REASONS.join(", ")}`,
      validReasons: CLOSURE_REASONS,
    };
  }

  if (!isClosureReason(req.closureReason)) {
    return {
      ok: false,
      code: "invalid_closure_reason",
      message: `closure_reason=${req.closureReason} 无效；合法值：${CLOSURE_REASONS.join(", ")}`,
      validReasons: CLOSURE_REASONS,
    };
  }

  const requiresTarget = req.closureReason === "handed_off_to"
    || req.closureReason === "blocked_on"
    || req.closureReason === "escalation";

  if (requiresTarget && !req.closureTarget) {
    return {
      ok: false,
      code: "missing_closure_target",
      message: `closure_reason=${req.closureReason} 要求 closure_target`,
    };
  }

  return {
    ok: true,
    closureReason: req.closureReason,
    closureTarget: req.closureTarget ?? null,
  };
}

export function isClosureReason(value: unknown): value is ClosureReason {
  return typeof value === "string" && (CLOSURE_REASONS as readonly string[]).includes(value);
}

/**
 * 根据 claim 时间与 tier 计算 closure_required_at。Phase A 的 tier 策略有意保持简单；
 * 预留此结构，使 Phase B/C 可在不修改契约的情况下替换为操作员可调的 SLA。
 */
const TIER_SLA_SECONDS: Record<string, number> = {
  fast: 30 * 60,
  routine: 4 * 60 * 60,
  deep: 24 * 60 * 60,
  critical: 15 * 60,
};

export function computeClosureRequiredAt(claimedAt: string, tier: string | null): string | null {
  if (!tier) return null;
  const slaSeconds = TIER_SLA_SECONDS[tier];
  if (slaSeconds === undefined) return null;
  const claimed = new Date(claimedAt).getTime();
  return new Date(claimed + slaSeconds * 1000).toISOString();
}
