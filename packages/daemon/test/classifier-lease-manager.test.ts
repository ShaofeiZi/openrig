import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { EventBus } from "../src/domain/event-bus.js";
import {
  ClassifierLeaseManager,
  ClassifierLeaseError,
} from "../src/domain/classifier-lease-manager.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("ClassifierLeaseManager（PL-004 阶段 B；L2 租约生命周期）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let mgr: ClassifierLeaseManager;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, classifierLeasesSchema]);
    bus = new EventBus(db);
    mgr = new ClassifierLeaseManager(db, bus, { ttlMs: 1000 });
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("acquire 创建活跃租约并发出 classifier.lease_acquired", () => {
    const lease = mgr.acquire("alice@rig");
    expect(lease.classifierSession).toBe("alice@rig");
    expect(lease.state).toBe("active");
    expect(lease.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lease.expiresAt > lease.acquiredAt).toBe(true);
    expect(captured.some((e) => e.type === "classifier.lease_acquired")).toBe(true);
  });

  it("acquire 对同一分类器会话幂等（原样返回现有租约）", () => {
    const a = mgr.acquire("alice@rig");
    const b = mgr.acquire("alice@rig");
    expect(b.leaseId).toBe(a.leaseId);
    // 仅有一个 lease_acquired 事件（幂等路径不会重复发出）。
    expect(captured.filter((e) => e.type === "classifier.lease_acquired")).toHaveLength(1);
  });

  it("已有活跃租约时其他会话调用 acquire 会抛出 lease_held（409）", () => {
    mgr.acquire("alice@rig");
    expect(() => mgr.acquire("bob@rig")).toThrow(ClassifierLeaseError);
    try {
      mgr.acquire("bob@rig");
    } catch (err) {
      expect((err as ClassifierLeaseError).code).toBe("lease_held");
      expect((err as ClassifierLeaseError).meta?.holder).toBe("alice@rig");
    }
  });

  it("heartbeat 延长 expires_at 并更新 last_heartbeat", () => {
    const fakeNow = (() => {
      let t = new Date("2026-05-03T00:00:00.000Z").getTime();
      return () => { const d = new Date(t); t += 100; return d; };
    })();
    const m = new ClassifierLeaseManager(db, bus, { ttlMs: 1000, now: fakeNow });
    const acquired = m.acquire("alice@rig");
    const beat = m.heartbeat(acquired.leaseId, "alice@rig");
    expect(beat.lastHeartbeat > acquired.lastHeartbeat).toBe(true);
    expect(beat.expiresAt > acquired.expiresAt).toBe(true);
  });

  it("不匹配的会话调用 heartbeat 会抛出 lease_session_mismatch（403）", () => {
    const lease = mgr.acquire("alice@rig");
    expect(() => mgr.heartbeat(lease.leaseId, "bob@rig")).toThrow(/lease_session_mismatch|alice@rig/);
  });

  it("对存活持有者调用 evaluateDeadness 返回 null（不失效）", () => {
    mgr.acquire("alice@rig");
    const result = mgr.evaluateDeadness();
    expect(result).toBeNull();
  });

  it("对已死亡持有者调用 evaluateDeadness 会将租约标记为过期并发出 classifier.dead", () => {
    const m = new ClassifierLeaseManager(db, bus, {
      ttlMs: 1000,
      isAlive: (s) => s !== "alice@rig", // alice 被报告为已死亡
    });
    m.acquire("alice@rig");
    const result = m.evaluateDeadness();
    expect(result).not.toBeNull();
    expect(result!.state).toBe("expired");
    expect(captured.some((e) => e.type === "classifier.lease_expired")).toBe(true);
    expect(captured.some((e) => e.type === "classifier.dead")).toBe(true);
  });

  it("对超过 TTL 的租约调用 evaluateDeadness 会标记为过期（不发出 classifier.dead）", () => {
    let t = new Date("2026-05-03T00:00:00.000Z").getTime();
    const m = new ClassifierLeaseManager(db, bus, {
      ttlMs: 100,
      now: () => new Date(t),
    });
    m.acquire("alice@rig");
    t += 200; // 前进到超过 TTL
    const result = m.evaluateDeadness();
    expect(result).not.toBeNull();
    expect(result!.state).toBe("expired");
    expect(captured.some((e) => e.type === "classifier.lease_expired")).toBe(true);
    expect(captured.some((e) => e.type === "classifier.dead")).toBe(false);
  });

  it("evaluateDeadness 使租约过期后，新会话可以获取租约", () => {
    const m = new ClassifierLeaseManager(db, bus, {
      ttlMs: 1000,
      isAlive: (s) => s !== "alice@rig",
    });
    m.acquire("alice@rig");
    m.evaluateDeadness(); // 将 alice 的租约标记为过期
    const fresh = m.acquire("bob@rig");
    expect(fresh.classifierSession).toBe("bob@rig");
    expect(fresh.state).toBe("active");
  });

  it("reclaim 从前一持有者收回活跃租约并发出 classifier.reclaimed", () => {
    mgr.acquire("alice@rig");
    const result = mgr.reclaim("operator@rig", { reason: "alice 无响应" });
    expect(result.state).toBe("reclaimed");
    expect(result.reclaimedBySession).toBe("operator@rig");
    expect(result.reclaimReason).toBe("alice 无响应");
    expect(captured.some((e) => e.type === "classifier.reclaimed")).toBe(true);
  });

  it("持有者存活时 reclaim --if-dead 拒绝操作", () => {
    mgr.acquire("alice@rig"); // 默认 isAlive 返回 true
    try {
      mgr.reclaim("operator@rig", { ifDead: true });
      throw new Error("预期应抛出异常");
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifierLeaseError);
      expect((err as ClassifierLeaseError).code).toBe("lease_still_active");
    }
  });

  it("持有者已死亡时 reclaim --if-dead 成功", () => {
    const m = new ClassifierLeaseManager(db, bus, {
      ttlMs: 1000,
      isAlive: (s) => s !== "alice@rig",
    });
    m.acquire("alice@rig");
    const result = m.reclaim("operator@rig", { ifDead: true });
    expect(result.state).toBe("reclaimed");
  });

  it("requireActiveHolder 验证所提供会话持有活跃租约", () => {
    const lease = mgr.acquire("alice@rig");
    const checked = mgr.requireActiveHolder("alice@rig");
    expect(checked.leaseId).toBe(lease.leaseId);
  });

  it("提供不同会话时 requireActiveHolder 抛出 lease_held", () => {
    mgr.acquire("alice@rig");
    expect(() => mgr.requireActiveHolder("bob@rig")).toThrow(ClassifierLeaseError);
  });

  it("没有任何租约被持有时 requireActiveHolder 抛出 no_active_lease", () => {
    try {
      mgr.requireActiveHolder("alice@rig");
      throw new Error("预期应抛出异常");
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifierLeaseError);
      expect((err as ClassifierLeaseError).code).toBe("no_active_lease");
    }
  });

  it("部分 UNIQUE 索引在数据库层强制单写者约束", () => {
    mgr.acquire("alice@rig");
    // 通过原始 SQL 手工 INSERT state='active' 会被部分 UNIQUE 索引
    // `idx_classifier_leases_active_singleton` 阻止。
    expect(() => {
      db.prepare(
        `INSERT INTO classifier_leases (
          lease_id, classifier_session, acquired_at, expires_at, last_heartbeat, state
        ) VALUES (?, ?, ?, ?, ?, 'active')`
      ).run("dup-lease", "bob@rig", "2026-05-03T00:00:00Z", "2026-05-03T00:00:01Z", "2026-05-03T00:00:00Z");
    }).toThrow(/UNIQUE constraint/);
  });
});
