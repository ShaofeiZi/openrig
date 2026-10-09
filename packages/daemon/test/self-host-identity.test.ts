// 51-09 增量 1——持久化的后台服务自身主机身份（先红后绿）。
//
// 依据：架构裁定 cb19867f（规范自身主机身份是全新概念；扩展席位身份底座；绝不使用
// host.name 展示值，也绝不使用 'local' 哨兵）+ 实施计划 426ec065。host.name 仅可作为
// 展示型候选种子。

import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { SelfHostIdentityStore } from "../src/domain/seat-identity-store.js";
import {
  reconcileSelfHostIdentity,
  assertNeverReservedHostId,
} from "../src/domain/seat-identity-reconciler.js";

const RESERVED = ["local", "kernel", "host", "localhost"];

describe("51-09 增量 1：持久化自身主机身份", () => {
  it("基线无记录：全新规范数据库有表，但 reconcile 前没有自身主机记录", () => {
    const db = createFullTestDb();
    // 源头验证已编码：创建前不存在任何持久化自身 id。
    expect(new SelfHostIdentityStore(db).get()).toBeNull();
    // 表已存在（迁移已接线）——查询不得抛出异常。
    expect(() => db.prepare("SELECT * FROM self_host_identity").all()).not.toThrow();
  });

  it("首次启动时创建：第一次 reconcile 创建非空且非保留的 id", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    const r = reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: null });
    expect(r.minted).toBe(true);
    expect(r.hostId).toBeTruthy();
    expect(RESERVED).not.toContain(r.hostId.toLowerCase());
    expect(store.get()?.hostId).toBe(r.hostId);
  });

  it("跨重启稳定：第二次 reconcile 保留 id，更新 reconciled_at，minted_at 不变", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    const first = reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: "mars-01" });
    const rec1 = store.get()!;
    const second = reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T01:00:00.000Z", hostNameCandidate: "mars-01" });
    const rec2 = store.get()!;
    expect(second.minted).toBe(false);
    expect(second.hostId).toBe(first.hostId);
    expect(rec2.mintedAt).toBe(rec1.mintedAt); // minted_at NEVER moves
    expect(rec1.reconciledAt).toBe("2026-08-06T00:00:00.000Z");
    expect(rec2.reconciledAt).toBe("2026-08-06T01:00:00.000Z"); // reconciled_at advances
  });

  it("绝不为 'local'：创建的 id 绝非保留/默认值；断言会拒绝它们；保留种子被拒后重新生成", () => {
    for (const reserved of ["local", "kernel", "host", "localhost", "LOCAL", "Localhost"]) {
      expect(() => assertNeverReservedHostId(reserved), reserved).toThrow();
    }
    expect(() => assertNeverReservedHostId("mars-01")).not.toThrow();
    for (const bad of ["local", "localhost", "kernel", "host"]) {
      const db = createFullTestDb();
      const r = reconcileSelfHostIdentity(new SelfHostIdentityStore(db), { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: bad });
      expect(r.minted).toBe(true);
      expect(r.hostId.toLowerCase()).not.toBe(bad.toLowerCase());
      expect(RESERVED).not.toContain(r.hostId.toLowerCase());
    }
  });

  it("接管：无歧义的 host.name 作为自身 id 种子（对操作者有意义）", () => {
    const db = createFullTestDb();
    const r = reconcileSelfHostIdentity(new SelfHostIdentityStore(db), { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: "mars-01" });
    expect(r.minted).toBe(true);
    expect(r.hostId).toBe("mars-01");
    expect(r.conflict).toBeNull();
  });

  it("冲突：已存 id 与不同 host.name 并存时保留已存 id，并明确报告双方——绝不静默重设键", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: "mars-01" });
    const logs: string[] = [];
    const r = reconcileSelfHostIdentity(store, {
      nowIso: "2026-08-06T02:00:00.000Z",
      hostNameCandidate: "jupiter-02",
      log: (m) => logs.push(m),
    });
    expect(r.hostId).toBe("mars-01"); // never silent re-key
    expect(store.get()?.hostId).toBe("mars-01");
    expect(r.conflict).toEqual({ storedId: "mars-01", candidate: "jupiter-02" });
    expect(logs.join(" ")).toContain("mars-01");
    expect(logs.join(" ")).toContain("jupiter-02");
  });
});
