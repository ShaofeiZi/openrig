import type Database from "better-sqlite3";
import { resolveActiveOccupantRow, resolveActiveSnapshotSession } from "./active-occupant.js";
import { readFreshOccupantRelations } from "./fresh-occupant-relation.js";
import type { RigWithRelations, Snapshot } from "./types.js";

export interface CurrentStateRehydrateEligibility {
  ok: boolean;
  blockers: string[];
}

/**
 * 只有当崩溃快照仍列出持久当前状态认定为活跃的每个占用者时，快照才可信。
 * 启动对账会转换底层突然丢失后分离的行，因此分离行也必须参与：不同的会话 id 或原生
 * resume 身份，是快照属于旧占用者的肯定证据。当前状态有歧义也不代表可以恢复历史占用者；
 * 当前状态捕获会保留歧义，恢复流程会明确拒绝。
 */
export function snapshotMatchesCurrentOccupants(
  db: Database.Database,
  rig: RigWithRelations,
  snapshot: Snapshot,
): boolean {
  if (rig.nodes.length === 0) return true;
  const rows = db.prepare(
    `SELECT s.id, s.node_id AS nodeId, s.status,
            s.resume_type AS resumeType, s.resume_token AS resumeToken
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
       WHERE n.rig_id = ? AND s.status NOT IN ('superseded', 'exited')`
  ).all(rig.rig.id) as Array<{
    id: string;
    nodeId: string;
    status: string;
    resumeType: string | null;
    resumeToken: string | null;
  }>;

  const recorded = readFreshOccupantRelations(db, rig.rig.id);
  for (const node of rig.nodes) {
    const current = resolveActiveOccupantRow(rows, Object.prototype.hasOwnProperty.call(recorded, node.id) ? recorded : undefined, node.id);
    if (current.kind === "none") continue;
    if (current.kind === "ambiguous") return false;
    const captured = resolveActiveSnapshotSession(snapshot.data, node.id);
    if (
      captured.kind !== "resolved"
      || captured.session.id !== current.session.id
      || (captured.session.resumeType ?? null) !== current.session.resumeType
      || (captured.session.resumeToken ?? null) !== current.session.resumeToken
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 判断易失运行时状态（tmux）消失后，当前持久数据库状态是否足以合成恢复快照。
 *
 * 此判定有意保持保守。它本身不声明 provider 连续性，只表示现有恢复编排器拥有足够的
 * 持久输入，可尝试从按需快照执行普通恢复。
 */
export function assessCurrentStateRehydrateEligibility(
  db: Database.Database,
  rig: RigWithRelations,
): CurrentStateRehydrateEligibility {
  const blockers: string[] = [];

  if (rig.nodes.length === 0) {
    blockers.push("rig has no nodes to rehydrate");
  }

  const sessions = db.prepare(
    `SELECT node_id, resume_token
       FROM sessions
       WHERE node_id IN (${rig.nodes.map(() => "?").join(",") || "NULL"})
         AND status NOT IN ('superseded', 'exited')
       ORDER BY id DESC`
  ).all(...rig.nodes.map((node) => node.id)) as Array<{ node_id: string; resume_token: string | null }>;

  if (rig.nodes.length > 0 && sessions.length === 0) {
    blockers.push("rig has no persisted sessions to rehydrate");
  }

  const sessionByNode = new Map<string, Array<{ resume_token: string | null }>>();
  for (const session of sessions) {
    const rows = sessionByNode.get(session.node_id) ?? [];
    rows.push(session);
    sessionByNode.set(session.node_id, rows);
  }

  for (const node of rig.nodes) {
    const runtime = node.runtime ?? "";
    const isAgentRuntime = runtime.length > 0 && runtime !== "terminal";
    const hasStartupContext = !!db.prepare(
      "SELECT 1 FROM node_startup_context WHERE node_id = ? LIMIT 1"
    ).get(node.id);
    const hasResumeToken = (sessionByNode.get(node.id) ?? []).some((session) =>
      typeof session.resume_token === "string" && session.resume_token.length > 0
    );

    if (node.podId && !hasStartupContext) {
      blockers.push(`node ${node.logicalId} is pod-aware but has no persisted startup context`);
      continue;
    }

    if (isAgentRuntime && !hasStartupContext && !hasResumeToken) {
      blockers.push(`node ${node.logicalId} has runtime ${runtime} but no startup context or resume token`);
    }
  }

  return { ok: blockers.length === 0, blockers };
}
