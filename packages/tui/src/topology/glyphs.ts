// SPIKE——创建者的 4 字形状态词汇作为已存在投影状态之上的渲染映射
//（架构绑定 2，R7 清洁，基于 @12862302）。4 个桶折叠更丰富的已存在状态；
// 此处不发明状态，无值的投影渲染诚实未知 ○
//（PIN-2 作为字形——绝不伪造 ●）。
//
//   ● 活动/完成 = startupStatus ready + 会话运行中；S19 MR3 按活动拆分
//                 颜色（actActive vs actIdle 角色）——
//                 字形保持一个诚实 ●
//   ◐ 部分/%   = 已存在的琥珀待关注族：startupStatus/
//                 生命周期 attention_required、needs_input、heldReason
//                （ps-projection.ts seatNeedsAttention 减去 `failed`，
//                 它有自己的字形）。ctx% 可叠加。
//   ○ 排队/未知= 已发布未知 stateGlyph（compose.ts a.idle===null
//                 → "unknown"）+ pending/queued/no-session——诚实未知
//   ✕ 失败     = startupStatus failed / 会话 stopped-failed
//
// 边类型 → 线颜色（创建者细化：线，无标签）：
//   delegates_to = accent(青) · collaborates_with = ok(绿) ·
//   escalates_to = warn(琥珀)；任何其他服务类型渲染为暗（诚实：
//   类型字符串是数据——未知类型不强制进入桶）。
import type { Token } from "../theme.js";
import type { GraphNodeData } from "./graph-types.js";

export interface StatusGlyph {
  glyph: "●" | "◐" | "○" | "✕";
  token: Token;
  /** 当 ◐ 桶有服务百分比时的 ctx% 叠加文本（"63%"） */
  overlay: string | null;
}

export function statusGlyph(data: GraphNodeData): StatusGlyph {
  const activity = data.agentActivity?.state;
  if (data.startupStatus === "failed" || data.status === "failed" || data.status === "stopped")
    return { glyph: "✕", token: "error", overlay: null };
  if (data.startupStatus === "attention_required" || data.heldReason != null || activity === "needs_input")
    return {
      glyph: "◐",
      token: "actAttention",
      overlay: data.contextUsedPercentage != null ? `${Math.round(data.contextUsedPercentage)}%` : null,
    };
  if (data.startupStatus === "ready" && data.status === "running") {
    // S19 MR3：活动按颜色角色拆分 ● 桶（字形诚实
    // 不变）——主动工作 vs 空闲可见区分
    const working = activity === "running" || data.terminalActive === true;
    return { glyph: "●", token: working ? "actActive" : "actIdle", overlay: null };
  }
  // 其他一切——pending、queued、detached、无会话——是诚实的
  // ○ 桶，在投影无值处渲染（角色：detached）
  return { glyph: "○", token: "actDetached", overlay: null };
}

/** S19 round-4（防护发现 4）：资源管理器行的状态字形+角色，
 *  从服务端 AgentRow 状态词汇折叠（hydrate.toAgentRow
 *  从投影逐字派生：failed / attention_required /
 *  needs_input / active / idle / sessionStatus-or-"unknown"；演示夹具
 *  额外使用遗留 "needs-attention" 拼写）。相同诚实
 *  4 字形词汇 + 活动角色如拓扑 statusGlyph——任何
 *  不正已知的渲染 ○，绝不伪造 ●。 */
export function rowStatusGlyph(agent: { status: string }): Pick<StatusGlyph, "glyph" | "token"> {
  const s = agent.status;
  if (s === "failed") return { glyph: "✕", token: "error" };
  if (s === "attention_required" || s === "needs_input" || s === "needs-attention")
    return { glyph: "◐", token: "actAttention" };
  if (s === "active") return { glyph: "●", token: "actActive" };
  if (s === "idle") return { glyph: "●", token: "actIdle" };
  return { glyph: "○", token: "actDetached" };
}

export function edgeToken(kind: string): Token {
  if (kind === "delegates_to") return "accent";
  if (kind === "collaborates_with") return "ok";
  if (kind === "escalates_to") return "warn";
  return "dim";
}
