import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { eventsNodeTypeIndexSchema } from "../src/db/migrations/047_events_node_type_index.js";
import { deriveOriented } from "../src/domain/startup-proof.js";

/**
 * OPR.0.4.3 热修证明——后台服务 /healthz-wedge 修复（迁移 047）。
 *
 * 卡顿根因来自实时 98-100% CPU 样本：每个节点都反向扫描无索引支持的只追加 `events` 表，
 * 每次 3 秒一次的 `GET /api/ps` 轮询都会为每个节点完整反向遍历表。这些测试证明迁移 047
 * 将两个热点推导查询从全表 SCAN（卡顿）变为有界索引 SEEK，且查询行为保持不变
 *（仅修索引，不改变推导函数逻辑）。
 */

// 两个热点查询逐字取自推导函数，必须保持同步。
const ORIENTED_SQL =
  "SELECT type, payload, seq FROM events WHERE node_id = ? AND type IN ('node.startup_challenged','node.startup_proof_skipped','node.startup_proof_verified','node.startup_proof_rejected') ORDER BY seq DESC";
const RESTORE_SQL =
  "SELECT type, payload, seq FROM events WHERE rig_id = ? AND type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled') ORDER BY seq DESC";

function mkDb(withIndex: boolean): Database.Database {
  const db = new Database(":memory:");
  migrate(db, withIndex ? [eventsSchema, eventsNodeTypeIndexSchema] : [eventsSchema]);
  return db;
}

function insertEvent(
  db: Database.Database,
  ev: { rigId: string | null; nodeId: string | null; type: string; payload: unknown },
): void {
  db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(
    ev.rigId,
    ev.nodeId,
    ev.type,
    JSON.stringify(ev.payload),
  );
}

function planFor(db: Database.Database, sql: string, param: string): string {
  const rows = db.prepare("EXPLAIN QUERY PLAN " + sql).all(param) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(" | ");
}

describe("OPR.0.4.3 healthz-wedge — migration 047 events indexes", () => {
  describe("查询计划：全表 SCAN（卡顿）→ 有界索引 SEEK", () => {
    it("没有索引时，deriveOriented 查询会全表扫描 events（卡顿）", () => {
      const db = mkDb(false);
      const plan = planFor(db, ORIENTED_SQL, "node-x");
      expect(plan).toMatch(/SCAN events/i);
      expect(plan).not.toMatch(/idx_events_node_type_seq/);
      db.close();
    });

    it("应用迁移 047 后，deriveOriented 查询使用 idx_events_node_type_seq（不再全表扫描）", () => {
      const db = mkDb(true);
      const plan = planFor(db, ORIENTED_SQL, "node-x");
      expect(plan).toMatch(/idx_events_node_type_seq/);
      expect(plan).not.toMatch(/SCAN events/i); // a SEARCH via index, never a full-table SCAN
      db.close();
    });

    it("deriveRestoreOutcome 以工作组为作用域——使用现有 idx_events_rig_seq（有工作组边界，不会全表卡顿）；(rig_id,type,seq) 索引未被使用（规划器为 seq 排序偏好 rig_seq），属于次要问题，将由后续 N+1 收敛处理，而非本次热修", () => {
      const db = mkDb(true);
      const plan = planFor(db, RESTORE_SQL, "rig-x");
      expect(plan).toMatch(/idx_events_rig_seq/); // rig-bounded seek, not a full-table SCAN
      expect(plan).not.toMatch(/SCAN events/i);
      db.close();
    });
  });

  describe("deriveOriented 正确性保持不变（仅修索引）——即使埋在大量其他节点事件中", () => {
    const RIG = "rig-1";
    const TARGET = "node-target";

    function seedNoise(db: Database.Database, n: number): void {
      // 大量属于其他节点的更新 agent.activity 事件——这些记录会让建索引前的反向扫描
      // 为一个静默目标遍历整张表。
      for (let i = 0; i < n; i++) {
        insertEvent(db, { rigId: RIG, nodeId: `other-${i % 7}`, type: "agent.activity", payload: { state: "running" } });
      }
    }

    it("节点从未收到挑战时返回 'n-'", () => {
      const db = mkDb(true);
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("n-a");
      db.close();
    });

    it("已挑战但从未证明时返回 'missing'（即使埋在 300 条更新事件下）", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("missing");
      db.close();
    });

    it("当前挑战有已验证证明时返回 'verified'（即使被埋藏）", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_verified", payload: { challengeId: "c1" } });
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("verified");
      db.close();
    });

    it("当前挑战的证明被拒绝时返回 'rejected'", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_rejected", payload: { challengeId: "c1" } });
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("rejected");
      db.close();
    });

    it("同一挑战的后续验证覆盖先前拒绝", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_rejected", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_verified", payload: { challengeId: "c1" } });
      expect(deriveOriented(db, TARGET)).toBe("verified");
      db.close();
    });

    it("以最新挑战为准——旧挑战的证明不计入", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_verified", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c2" } });
      // c2 是当前挑战且没有证明，因此为 missing；较旧的 c1 验证不得泄漏进来。
      expect(deriveOriented(db, TARGET)).toBe("missing");
      db.close();
    });
  });
});
