// 故障诊断 C3——`zrig crash-cart --json` payload 的唯一真源（计划 c015d9ed §C3，耦合裁定
// 方案 C 的 4 条约束）。一份 JSON 同时包含三态探测结论，以及 DOWN 时的发现结果（约束 3）。
// 本层逐字组合探测器与 C2 读取结果（约束 2，绝不另建平行读取路径）。若读取以 fail-closed
// 方式拒绝，则输出结构化 refusal 说明（不能只有退出码，也不能携带 discovery），避免 TUI 把拒绝
// 错画成恢复控制台。整个流程只读（约束 1）。子步骤均可注入，使决策层保持确定；CLI 动词负责
// 接入真实探测器和读取器。

import type { DaemonState, DaemonUnverifiedEvidence } from "./crash-cart-detect.js";
import type { CrashCartDiscovery } from "./crash-cart-discovery.js";

/** 该动词的 JSON payload。state 只会搭配 {evidence | discovery | refusal} 其中一项：
 *  up 不带附加项；unverified 带 evidence；down 带 discovery，读取 fail-closed 时改带 refusal。 */
export interface CrashCartEmit {
  state: DaemonState;
  evidence?: DaemonUnverifiedEvidence;
  discovery?: CrashCartDiscovery;
  refusal?: string;
}

export interface EmitCrashCartDeps {
  /** 解析三态结论（带有界重试的探测器）。 */
  resolveState: () => Promise<DaemonState>;
  /** 组合 UNVERIFIED 证据（pid 状态和最近一次探测）。 */
  assembleEvidence: () => Promise<DaemonUnverifiedEvidence>;
  /** 原样执行 C2 后台服务离线读取（loadCrashCartDiscovery）；可能 fail-closed 并抛错。 */
  loadDiscovery: () => Promise<CrashCartDiscovery>;
}

/** 组合该动词的结论。UP 只返回 state；UNVERIFIED 返回 state + evidence（不读取）；DOWN 返回
 *  读取到的 discovery，读取 fail-closed 时返回结构化 refusal 说明。 */
export async function emitCrashCartState(deps: EmitCrashCartDeps): Promise<CrashCartEmit> {
  const state = await deps.resolveState();
  if (state === "up") return { state };
  if (state === "unverified") return { state, evidence: await deps.assembleEvidence() };
  // down——尝试 C2 读取；拒绝必须结构化，绝不能渲染成恢复控制台。
  try {
    return { state, discovery: await deps.loadDiscovery() };
  } catch (e) {
    return { state, refusal: e instanceof Error ? e.message : String(e) };
  }
}
