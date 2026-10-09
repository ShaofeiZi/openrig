import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProjectionManifestStore } from "../src/domain/projection-manifest-store.js";

describe("ProjectionManifestStore —— P20 atom 1（mig-064）", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createFullTestDb();
  });

  it("没有记录前 get/lastHash 均为 null", () => {
    const s = new ProjectionManifestStore(db);
    expect(s.get("/x/skill.md")).toBeNull();
    expect(s.lastHash("/x/skill.md")).toBeNull();
  });

  it("record 后 get 返回条目，lastHash 返回哈希", () => {
    const s = new ProjectionManifestStore(db);
    s.record({ targetPath: "/x/skill.md", lastHash: "h1", writtenAt: "T0", sourceSpec: "spec-a", category: "skill" });
    const e = s.get("/x/skill.md")!;
    expect(e.lastHash).toBe("h1");
    expect(e.writtenAt).toBe("T0");
    expect(e.sourceSpec).toBe("spec-a");
    expect(e.category).toBe("skill");
    expect(s.lastHash("/x/skill.md")).toBe("h1");
  });

  it("record 按 target_path UPSERT，重写时保留最后哈希（写入即记录）", () => {
    const s = new ProjectionManifestStore(db);
    s.record({ targetPath: "/x/skill.md", lastHash: "h1", writtenAt: "T0" });
    s.record({ targetPath: "/x/skill.md", lastHash: "h2", writtenAt: "T1" });
    expect(s.lastHash("/x/skill.md")).toBe("h2");
    expect(s.get("/x/skill.md")!.writtenAt).toBe("T1");
  });

  it("记录按目标隔离（不同路径绝不冲突）", () => {
    const s = new ProjectionManifestStore(db);
    s.record({ targetPath: "/a", lastHash: "ha", writtenAt: "T" });
    s.record({ targetPath: "/b", lastHash: "hb", writtenAt: "T" });
    expect(s.lastHash("/a")).toBe("ha");
    expect(s.lastHash("/b")).toBe("hb");
  });

  it("可选字段默认为 null", () => {
    const s = new ProjectionManifestStore(db);
    s.record({ targetPath: "/x", lastHash: "h", writtenAt: "T" });
    const e = s.get("/x")!;
    expect(e.sourceSpec).toBeNull();
    expect(e.category).toBeNull();
  });

  // atom-4b——BOOT 时全表可读探针，区别于逐 lookup 抛错。当
  // 整个 projection_manifest 不可读（缺失 / migration 失败 / 损坏），每个 lastHash
  // lookup 抛错 → 每个发散 projection 归类 operator_conflict → 静默 protect-ALL
  // 降级。isReadable 让 boot 检测该系统性案例并大声警告；绝不抛错。
  it("atom-4b：isReadable 探测整表启动状态，已迁移为 true、表缺失为 false，且永不抛错", () => {
    const s = new ProjectionManifestStore(db);
    expect(s.isReadable()).toBe(true); // migrated table (mig-064) → readable at boot
    db.exec("DROP TABLE projection_manifest"); // simulate a boot-unreadable manifest
    expect(s.isReadable()).toBe(false); // the systemic case is reported, never thrown
  });
});
