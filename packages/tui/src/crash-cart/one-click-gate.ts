// 故障诊断 C3 —— 一键门禁（创建者规则，对 ⏎ 有约束力）。⏎ 是单次按键当且仅当恢复
// 计划为零代（每个席位恢复原始）。后台服务停止时，我们从 C2 读取计算代理：
// 当 resumableCount == seatCount 时工作组完全可恢复。任何有不可恢复席位的工作组
// 使 ⏎ 进入确认屏幕，列出这些差异——绝不静默恢复→全新降级。

export interface OneClickRigInput {
  rigName: string;
  seatCount: number;
  resumableCount: number;
}

/** 不完全可恢复的工作组——将被全新初始化/等待决策的席位。 */
export interface OneClickDelta {
  rigName: string;
  seatCount: number;
  resumableCount: number;
  nonResumable: number;
}

export interface OneClickGate {
  /** True ⇒ ⏎ 恢复全部是单次按键（无需确认）。 */
  zeroGeneration: boolean;
  /** 有不可恢复席位的工作组——确认屏幕精确列出这些。空 ⇔ zeroGeneration。 */
  deltas: OneClickDelta[];
}

/** 非零代恢复的确认屏幕消息。诚实（r2 HIGH-2）：恢复不会自动全新初始化——
 *  不可恢复席位落入诊断列表，等待决策（全新初始化或跳过）。它列出差异
 *  （R7：无静默恢复→全新降级）并描述后续决策；绝不承诺恢复不请求的动作。 */
export function restoreConfirmMessage(deltas: OneClickDelta[]): string {
  const names = deltas.map((d) => `${d.rigName} (${d.nonResumable}/${d.seatCount})`).join(", ");
  return `⏎ 恢复：${names} 有无法恢复的席位——它们需要在诊断列表中做出决策（全新初始化或跳过）。按 ⏎ 继续，按 Esc 取消。`;
}

/** 在 C2 发现的按工作组可恢复/席位计数上评估一键门禁。 */
export function evaluateOneClickGate(discovery: { foundOnHost: OneClickRigInput[] }): OneClickGate {
  const deltas: OneClickDelta[] = discovery.foundOnHost
    .filter((r) => r.resumableCount < r.seatCount)
    .map((r) => ({
      rigName: r.rigName,
      seatCount: r.seatCount,
      resumableCount: r.resumableCount,
      nonResumable: r.seatCount - r.resumableCount,
    }));
  return { zeroGeneration: deltas.length === 0, deltas };
}
