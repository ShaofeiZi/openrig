// 活动笔记包 2 —— 表面的操作层（OPR.0.4.4.20）。
//
// BR-9：每个表面操作调用相同的动词/写入路径包 1 落地——
// 绝不并行写入器，绝不合成 qitem。面向创始者的控件恰好两个
//（APPROVE + CHAT，SS14）；路由回和非忠实结果通过 CHAT-then-agent-records
// 经由相同的包 1 机制传递。
//
// 直到包 1 的生产者落地，这些调用呈现诚实的结构化错误
//（端点按契约命名；fixture 替代读取）。操作者来源：真实的解析会话；
// human/on-behalf-of 是后台服务端记录的委派元数据，绝不是操作者（#6）。

import { CHAT_PREAMBLE_SUFFIX } from "./chat.js";

export interface ActionOutcome {
  ok: boolean;
  /** 诚实的失败表面——逐字渲染在控件旁。 */
  message: string;
}

async function post(url: string, body: unknown): Promise<ActionOutcome> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, message: "已记录" };
    let detail = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { error?: string; message?: string; hint?: string };
      detail = json.message ?? json.error ?? detail;
      if (json.hint) detail += ` — ${json.hint}`;
    } catch {
      /* body 非 JSON */
    }
    return { ok: false, message: detail };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * APPROVE（切片终端）：包 1 FR-9 批准动词——frontmatter 唯一写入者 +
 * 审计行；交付戳触发 compose-and-freeze。
 * Body 形状匹配已发布的包 1 路由契约
 *（routes/scope-approve.ts：scopeTier / scopePath / actorSession /
 * approvalScope——rev1-r2 fixback 在 d6135921；早期猜测的字段名
 * 未通过真实路由的 scope_tier_invalid 验证）。
 */
export function approveSlice(scopePath: string, actor: string, scope: "spec" | "delivery" = "delivery"): Promise<ActionOutcome> {
  return post("/api/scope/approve", {
    scopeTier: "slice",
    scopePath,
    actorSession: actor,
    approvalScope: scope,
  });
}

/**
 * slice-04 REV6 —— scope-approve 调用者值的唯一推导，被每个嵌套批准控件
 *（任务板 + 切片 NEEDS YOU）共享，使其不会漂移。后台服务契约
 *（routes/scope-approve.ts）是任务根相对路径 `<mission>/slices/<slice>`；
 * 裸切片名是旧版根切片回退（missionId null/缺省）。这是纯 API 值——
 * 绝不是绝对文件系统路径（例如 SliceDetail.slicePath）：路由（path.resolve +
 * 包含）会接受并规范化包含的绝对路径，所以这不是 404 的问题——而是绝对路径
 * 将 API 值耦合到主机本地文件系统身份，违反任务根相对 scopePath 契约。
 */
export function sliceScopePath(missionId: string | null | undefined, slice: string): string {
  return missionId ? `${missionId}/slices/${slice}` : slice;
}

/**
 * RESOLVE（leg-1 停放）：包 1 FR-7 任务控制动词——一条写入路径，
 * 决策文本落入 queue_transitions.transition_note，同事务中取消停放 +
 * 推动。`resolve` 是已发布动词枚举的附加项；P1 之前路由以结构化错误拒绝它
 *（诚实）。
 */
export function resolveQitem(qitemId: string, decision: string, actorSession: string): Promise<ActionOutcome> {
  return post("/api/mission-control/action", {
    verb: "resolve",
    qitemId,
    decision,
    actorSession,
  });
}

/** 冻结重调用（幂等；FR-6）—— 为 LOCKED 回执暴露。 */
export function refreeze(slice: string, actor: string): Promise<ActionOutcome> {
  return post("/api/review/freeze", { scope: "slice", name: slice, actor });
}

export { CHAT_PREAMBLE_SUFFIX };
