// OPR.0.4.3.04 B2 —— 纯净且可复用的恢复令牌派生辅助函数。
//
// 这是 FR-3 接管边界捕获（ClaimService.captureResumeTokenOnAdoption）与席位交接
// discovered 模式捕获共用的派生核心。它只复用现有信息并纯读取派生，不写 pane、
// 不启动、不持久化、不发事件。持久化（updateResumeToken）及 captured/preserved/
// skipped 事件由调用方负责，因此各调用方保留自己的来源与审计语义。
//
// 派生令牌属于凭据：绝不记录、回显或放入任何返回消息/错误。只有调用方的脱敏
// 持久化路径会接触它。如实失败意味着返回结构化跳过原因（无令牌），绝不伪造值。
//
// FR-3 范围保持不变：本辅助函数只做派生，不改变哪些生命周期操作执行接管；
// 它只消除裁定要求共享的两个派生位置之间的重复。

import { resumeTypeForRuntime, validateResumeToken, type ResumeType } from "./resume-token-validation.js";

export interface ResumeTokenCaptureDeps {
  contextUsageStore?: {
    readSidecar(sessionName: string): { ok: true; data: { session_id?: string } } | { ok: false; reason: string };
  } | null;
  resumeTokenCapturer?: {
    captureCodexThreadId(sessionName: string): Promise<string | undefined>;
  } | null;
  /** OPR.0.4.6.PI1 FR-6 —— 读取 pi-runner 的会话状态 sidecar（runner 持久化
   * RPC get_state 返回的 sessionFile/sessionId；这是文件读取，与 claude-code
   * 状态行 sidecar 的策略相同）。 */
  piRunnerStateStore?: {
    readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string };
  } | null;
}

export type ResumeTokenDeriveResult =
  /** 运行时没有恢复令牌（terminal/unknown）；这不是失败，也不发事件。 */
  | { outcome: "exempt" }
  /** 必需的派生依赖缺失（旧接线/测试）；静默不操作。 */
  | { outcome: "noop" }
  /** 已派生实时令牌并通过格式校验；由调用方持久化。 */
  | { outcome: "captured"; resumeType: ResumeType; token: string }
  /** 派生已执行但未产生可用令牌；调用方发送跳过事件。 */
  | { outcome: "skipped"; reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "invalid_token" };

/**
 * 从实时只读来源派生运行时恢复令牌：
 *   claude-code → 状态行 sidecar 的 session_id（文件读取）
 *   codex       → 从按实时 pid 索引的日志派生 thread id
 *   pi          → pi-runner 状态 sidecar 的 sessionFile（文件读取）
 * 返回结构化结果；令牌缺失/无效时绝不抛出异常，而是如实跳过。依赖抛出的任何
 * 意外异常由调用方吞掉（捕获绝不能导致生命周期操作失败或阻塞）。
 */
export async function deriveResumeToken(
  input: { runtime: string | null; sessionName: string },
  deps: ResumeTokenCaptureDeps,
): Promise<ResumeTokenDeriveResult> {
  const resumeType = resumeTypeForRuntime(input.runtime);
  if (!resumeType) return { outcome: "exempt" }; // terminal/unknown 免于处理，不是失败。

  const runtime = input.runtime as string; // 非 null：只为 claude-code/codex/pi 设置 resumeType。

  let token: string | undefined;
  if (runtime === "claude-code") {
    if (!deps.contextUsageStore) return { outcome: "noop" }; // 依赖缺失，静默不操作。
    const sidecar = deps.contextUsageStore.readSidecar(input.sessionName);
    if (!sidecar.ok) {
      return { outcome: "skipped", reason: sidecar.reason === "parse_error" ? "parse_error" : "missing_sidecar" };
    }
    const sid = sidecar.data.session_id;
    if (typeof sid === "string" && sid.trim().length > 0) token = sid.trim();
    else return { outcome: "skipped", reason: "missing_sidecar" };
  } else if (runtime === "codex") {
    if (!deps.resumeTokenCapturer) return { outcome: "noop" }; // 依赖缺失，静默不操作。
    token = await deps.resumeTokenCapturer.captureCodexThreadId(input.sessionName);
    if (!token) return { outcome: "skipped", reason: "probe_timeout" };
  } else if (runtime === "pi") {
    if (!deps.piRunnerStateStore) return { outcome: "noop" }; // 依赖缺失，静默不操作。
    const state = deps.piRunnerStateStore.readSessionFile(input.sessionName);
    if (!state.ok) {
      return { outcome: "skipped", reason: state.reason === "parse_error" ? "parse_error" : "missing_sidecar" };
    }
    if (state.sessionFile.trim().length > 0) token = state.sessionFile.trim();
    else return { outcome: "skipped", reason: "missing_sidecar" };
  } else {
    return { outcome: "noop" }; // 已设置 resumeType，但不是支持派生的运行时；防御性回退。
  }

  // 调用方持久化前执行防御性格式校验；格式错误的令牌应如实跳过，绝不能写入坏值
  // （有效性优先于排序）。
  const validation = validateResumeToken(runtime, token);
  if (!validation.ok) return { outcome: "skipped", reason: "invalid_token" };

  return { outcome: "captured", resumeType: validation.resumeType, token: validation.token };
}
