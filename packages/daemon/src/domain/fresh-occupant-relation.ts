import type Database from "better-sqlite3";

/** 读取已有的 fresh-launch 生效关系，并以当前 generation 为边界。
 * 旧版本可能留下未被 supersede 的已分离前任。归属事件仍会明确记录预期继任者，因此无需根据
 * 时间戳或最新记录猜测。这里不会改写任何历史记录或原生身份。
 */
export function readFreshOccupantRelations(db: Database.Database, rigId: string): Record<string, string | null> {
  const generations = db.prepare(`
    SELECT t.node_id AS nodeId, t.generation_uuid AS generation
    FROM occupant_tenures t JOIN nodes n ON n.id = t.node_id
    WHERE n.rig_id = ? AND t.generation_ordinal =
      (SELECT MAX(t2.generation_ordinal) FROM occupant_tenures t2 WHERE t2.node_id = t.node_id)
  `).all(rigId) as Array<{ nodeId: string; generation: string }>;
  const current = new Map(generations.map((row) => [row.nodeId, row.generation]));
  const events = db.prepare("SELECT payload FROM events WHERE rig_id = ? AND type = 'seat.fresh_launched' ORDER BY seq")
    .all(rigId) as Array<{ payload: string }>;
  const relation: Record<string, string | null> = {};
  for (const row of events) {
    const event = JSON.parse(row.payload) as Record<string, unknown>;
    if (typeof event.nodeId !== "string" || !current.has(event.nodeId)
      || event.newGeneration !== current.get(event.nodeId)) continue;
    const id = typeof event.sessionId === "string" && event.sessionId ? event.sessionId : null;
    if (Object.prototype.hasOwnProperty.call(relation, event.nodeId) && relation[event.nodeId] !== id) {
      relation[event.nodeId] = null; // 当前生效关系互相矛盾时，结果仍视为不可用。
    } else relation[event.nodeId] = id;
  }
  return relation;
}
