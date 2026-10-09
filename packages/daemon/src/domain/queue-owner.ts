import type Database from "better-sqlite3";

/** 持久的 session→node 绑定，沿用 session-registry 的先例：取规范名称对应的最新 session
 *  记录。规范 session 名（短横线形式，如 `review-r2@rig`）与节点 logical id（点分形式，
 *  如 `review.r2`）是相互独立的身份；线上 fleet 中没有二者相同的情况，因此解析时绝不能
 *  在它们之间做字符串转换。 */
export function resolveSessionNodeId(db: Database.Database, session: string): string | null {
  const row = db
    .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1")
    .get(session) as { node_id: string } | undefined;
  return row?.node_id ?? null;
}

/** 默认 orchestrator 推导链：目标的已绑定节点 → 其 delegates_to 边的 source → 该父节点
 *  当前的规范 session 绑定。若 session 不在已记录拓扑中，或父节点没有 session 绑定，则
 *  解析为 null；此时没有可唤醒的 orchestrator session，绝不能凭空合成。 */
export function defaultResolveOrchestrator(db: Database.Database, session: string): string | null {
  const nodeId = resolveSessionNodeId(db, session);
  if (!nodeId) return null;
  const row = db
    .prepare(
      `SELECT s.session_name AS parentSession FROM edges e
         JOIN sessions s ON s.node_id = e.source_id
        WHERE e.target_id = ? AND e.kind = 'delegates_to'
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 1`,
    )
    .get(nodeId) as { parentSession: string } | undefined;
  return row?.parentSession ?? null;
}
