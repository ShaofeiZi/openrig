// OPR.0.5.7.1——唯一的活动占用者真相，以纯叶子模块实现。
//
// 执行（restore-orchestrator）、预览（restore-plan-preview）、快照可用性
//（rig-repository）和生命周期投影（node-inventory）都使用下方同一个四路判定阶梯；
// 捕获（snapshot-capture）与实时无快照预览也通过同一个辅助函数派生关系。
// R2 的 HOLD 正是本模块要消除的漂移：报告表面选中了执行路径绝不会恢复的历史行。
//
// 四路占用者真相（修复裁决 qitem-20260829080039-c47a571e）：仅当整个关系映射缺失
//（约定建立前的快照）时才允许旧版推断。只要映射存在，它就是权威——null 值、
// 缺失的节点键或悬空 id 都必须响亮失败；绝不能通过 truthiness 把映射折叠回旧阶梯。

import type { SnapshotData, Session, SnapshotOccupantState } from "./types.js";

/** 判定阶梯所需的最小行形状——Session 与预览所用的窄化会话行都满足它，
 *  因而同一个阶梯可服务所有消费者，无需复制变体。 */
export interface OccupantCandidateRow {
  id: string;
  nodeId: string;
  status: string | null;
}

export type ActiveOccupantResolution<T extends OccupantCandidateRow> =
  | { kind: "resolved"; session: T }
  | { kind: "none" }
  | { kind: "ambiguous"; candidateIds: string[]; detail: string };

export type ActiveSnapshotSessionResolution =
  | { kind: "resolved"; session: Session }
  | { kind: "none" }
  | { kind: "ambiguous"; candidateIds: string[]; detail: string };

/** 四路判定阶梯（从 restore-orchestrator.ts 移入，行为逐字节保持一致）；
 *  对行形状使用泛型，使消费者无需复制实现。 */
export function resolveActiveOccupantRow<T extends OccupantCandidateRow>(
  sessions: T[],
  relationMap: Record<string, string | null> | undefined,
  nodeId: string,
): ActiveOccupantResolution<T> {
  const rows = sessions.filter((s) => s.nodeId === nodeId);
  const map = relationMap;
  if (map === undefined) {
    // 约定建立前的快照：只有这个分支可把零行解释为“从未运行”（none）并执行旧版推断——
    // 有且仅有一行则选它；否则选唯一 running 行；再否则就是歧义。
    if (rows.length === 0) return { kind: "none" };
    if (rows.length === 1) return { kind: "resolved", session: rows[0]! };
    const running = rows.filter((s) => s.status === "running");
    if (running.length === 1) return { kind: "resolved", session: running[0]! };
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: "没有显式活动关系（约定建立前的快照），也没有唯一的 running 行" };
  }
  // 映射已存在：即使会话行为零，它仍是权威；无论历史如何，null、缺键或悬空关系都必须响亮暴露。
  if (!Object.prototype.hasOwnProperty.call(map, nodeId)) {
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: "快照的 activeSessionIdByNode 映射没有此节点的条目" };
  }
  const rel = map[nodeId];
  if (rel === null) {
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: "快照捕获时未记录唯一存活占用者（显式 null）" };
  }
  const hit = rows.find((s) => s.id === rel);
  if (!hit) {
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: `记录的活动关系 ${rel} 在此快照中没有对应会话行（悬空）` };
  }
  return { kind: "resolved", session: hit };
}

/** 快照形态的入口（原有公开签名）；保持执行调用点不变的薄包装。 */
export function resolveActiveSnapshotSession(data: SnapshotData, nodeId: string): ActiveSnapshotSessionResolution {
  const explicit = data.activeOccupantsByNode;
  if (explicit !== undefined) {
    const state = explicit[nodeId];
    const rows = data.sessions.filter((session) => session.nodeId === nodeId);
    if (!state) {
      return { kind: "ambiguous", candidateIds: rows.map((row) => row.id), detail: "快照的 activeOccupantsByNode 映射没有此节点的条目" };
    }
    if (state.kind === "absent") return { kind: "none" };
    if (state.kind === "ambiguous") {
      return { kind: "ambiguous", candidateIds: [...state.candidateIds], detail: "快照捕获时记录了多个存活占用者候选" };
    }
    const session = rows.find((row) => row.id === state.sessionId);
    if (!session) {
      return { kind: "ambiguous", candidateIds: rows.map((row) => row.id), detail: `记录的活动占用者 ${state.sessionId} 在此快照中没有对应会话行（悬空）` };
    }
    return { kind: "resolved", session };
  }
  return resolveActiveOccupantRow(data.sessions, data.activeSessionIdByNode, nodeId);
}

/** 所有位置共用一套响亮失败措辞——不同措辞会形成第二份真相。 */
export function activeOccupantAmbiguityError(candidateIds: string[], detail?: string): string {
  return `活动占用者有歧义：${candidateIds.length} 个候选会话行（${candidateIds.join(", ")}）` +
    `${detail ? `——${detail}` : ""}。解决前席位不可恢复。` +
    `拒绝“最新行胜出”，也拒绝替换占用者。`;
}

/** 捕获规则，由 SnapshotCapture 与实时无快照预览原样共享，避免两个同级派生漂移：
 *  节点恰有一个 RUNNING 行时取其 id；否则取显式 null（如实记录，恢复时响亮解析而不猜测）。 */
export function deriveActiveSessionIdByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
): Record<string, string | null> {
  const relation: Record<string, string | null> = {};
  for (const nodeId of nodeIds) {
    const running = sessions.filter((s) => s.nodeId === nodeId && s.status === "running");
    relation[nodeId] = running.length === 1 ? running[0]!.id : null;
  }
  return relation;
}

/** 捕获同一实时关系，同时保持 absent 与 ambiguous 的区别。 */
export function deriveActiveOccupantsByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
): Record<string, SnapshotOccupantState> {
  const relation: Record<string, SnapshotOccupantState> = {};
  for (const nodeId of nodeIds) {
    const running = sessions.filter((session) => session.nodeId === nodeId && session.status === "running");
    relation[nodeId] = running.length === 0
      ? { kind: "absent" }
      : running.length === 1
        ? { kind: "resolved", sessionId: running[0]!.id }
        : { kind: "ambiguous", candidateIds: running.map((session) => session.id) };
  }
  return relation;
}

/** 重启捕获的等价规则：尽可能解析一个持久的非终态占用者，否则保留精确的 absent/ambiguous 候选集。 */
export function deriveRehydrateOccupantsByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
  recorded: Record<string, string | null> = {},
): Record<string, SnapshotOccupantState> {
  const candidates = sessions.filter((session) => session.status !== "superseded" && session.status !== "exited");
  const relation: Record<string, SnapshotOccupantState> = {};
  for (const nodeId of nodeIds) {
    const rows = candidates.filter((session) => session.nodeId === nodeId);
    const resolved = resolveActiveOccupantRow(candidates, Object.prototype.hasOwnProperty.call(recorded, nodeId) ? recorded : undefined, nodeId);
    relation[nodeId] = resolved.kind === "resolved"
      ? { kind: "resolved", sessionId: resolved.session.id }
      : resolved.kind === "none"
        ? { kind: "absent" }
        : { kind: "ambiguous", candidateIds: rows.map((row) => row.id) };
  }
  return relation;
}

/** 仅用于重启的捕获规则。启动对账已把丢失进程的行从 running 改为 detached，
 *  普通实时捕获规则无法再识别它。因此在持久行上复用旧关系阶梯：一个非终态行，
 *  或多行中唯一的 running 行即可；所有歧义形态仍保留为显式 null，从而失败关闭。 */
export function deriveRehydrateSessionIdByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
  recorded: Record<string, string | null> = {},
): Record<string, string | null> {
  const candidates = sessions.filter((session) => session.status !== "superseded" && session.status !== "exited");
  const relation: Record<string, string | null> = {};
  for (const nodeId of nodeIds) {
    const resolved = resolveActiveOccupantRow(candidates, Object.prototype.hasOwnProperty.call(recorded, nodeId) ? recorded : undefined, nodeId);
    relation[nodeId] = resolved.kind === "resolved" ? resolved.session.id : null;
  }
  return relation;
}
