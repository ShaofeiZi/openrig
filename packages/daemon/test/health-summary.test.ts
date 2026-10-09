// 操作员表面对账 v0——health summary 测试。
//
// Pins the daemon-side aggregation helpers consumed by /api/health-summary/*.
// `computeNodeHealthSummary` 与 `computeContextHealthSummary` 二者均为
// 已交付表上的纯函数；测试建一个小 fixture DB 并断言汇总计数。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import {
  computeContextHealthSummary,
  computeNodeHealthSummary,
} from "../src/domain/steering/health-summary.js";

describe("操作员表面对账 v0 —— 健康摘要", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
  });

  afterEach(() => db.close());

  describe("computeNodeHealthSummary", () => {
    it("不存在工作组时返回全零", () => {
      const out = computeNodeHealthSummary({ db, rigRepo });
      expect(out).toEqual({ total: 0, bySessionStatus: {}, byLifecycle: {}, attentionRequired: 0 });
    });

    it("跨工作组聚合节点 sessionStatus", () => {
      const rigA = rigRepo.createRig("rig-a");
      const rigB = rigRepo.createRig("rig-b");
      rigRepo.addNode(rigA.id, "alpha", { role: "worker" });
      rigRepo.addNode(rigA.id, "beta", { role: "worker" });
      rigRepo.addNode(rigB.id, "gamma", { role: "worker" });
      const out = computeNodeHealthSummary({ db, rigRepo });
      expect(out.total).toBe(3);
      // 未播种 session 时，sessionStatus 默认 null/unknown。
      expect(Object.values(out.bySessionStatus).reduce((a, b) => a + b, 0)).toBe(3);
    });
  });

  describe("computeContextHealthSummary", () => {
    function insertContextUsage(nodeId: string, usedPercentage: number | null, sampledAt: string | null): void {
      // Insert a node row so the FK on context_usage(node_id) is satisfied.
      const rig = rigRepo.createRig(`rig-${nodeId}`);
      const node = rigRepo.addNode(rig.id, nodeId, { role: "worker" });
      db.prepare(
        `INSERT INTO context_usage (node_id, availability, used_percentage, sampled_at, updated_at)
         VALUES (?, 'known', ?, ?, ?)`
      ).run(node.id, usedPercentage, sampledAt, new Date().toISOString());
    }

    it("不存在上下文用量记录时返回全零", () => {
      const out = computeContextHealthSummary({ db });
      expect(out.total).toBe(0);
      expect(out.critical).toBe(0);
      expect(out.warning).toBe(0);
      expect(out.stale).toBe(0);
    });

    it("将 usedPercentage 分入紧急程度区间（critical ≥80、warning ≥60，其余为 low）", () => {
      insertContextUsage("crit", 92, new Date().toISOString());
      insertContextUsage("warn", 70, new Date().toISOString());
      insertContextUsage("ok-1", 25, new Date().toISOString());
      insertContextUsage("ok-2", 0, new Date().toISOString());
      insertContextUsage("unknown", null, new Date().toISOString());
      const out = computeContextHealthSummary({ db });
      expect(out.total).toBe(5);
      expect(out.critical).toBe(1);
      expect(out.warning).toBe(1);
      expect(out.byUrgency["low"]).toBe(2);
      expect(out.byUrgency["unknown"]).toBe(1);
    });

    it("将早于 300 秒的样本分类为 stale", () => {
      insertContextUsage("fresh", 50, new Date().toISOString());
      insertContextUsage("stale", 50, new Date(Date.now() - 600_000).toISOString()); // 10 minutes ago
      insertContextUsage("none", 50, null);
      const out = computeContextHealthSummary({ db });
      expect(out.byFreshness["fresh"]).toBe(1);
      expect(out.byFreshness["stale"]).toBe(1);
      expect(out.byFreshness["none"]).toBe(1);
      expect(out.stale).toBe(1);
    });
  });
});
