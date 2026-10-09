// 构建 B——使用真实数据库测试 bundle-export 偏移警告。
//
// 领域比较器已单独固定；尚未证明的是接线：导出路径能否按名称找到运行中的工作组、
// 读取其实时席位，并在确实无事可报时保持静默？若新建工作组首次导出就触发警告，
// 每次首次导出都会产生噪声，而真正的警告正会因此被忽略。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { describeSpecLiveDrift } from "../src/routes/bundles.js";

const SPEC = {
  name: "drift-rig",
  pods: [{ id: "orch", members: [{ id: "lead" }] }, { id: "dev", members: [{ id: "driver" }] }],
};

describe("bundle export——spec 与实时状态的偏移警告", () => {
  let db: Database.Database;
  let repo: RigRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = new RigRepository(db);
  });
  afterEach(() => db.close());

  function seedRig(name: string, logicalIds: string[]): string {
    const rigId = `rig-${name}`;
    db.prepare("INSERT INTO rigs (id, name, created_at, updated_at) VALUES (?,?,datetime('now'),datetime('now'))").run(rigId, name);
    for (const [i, lid] of logicalIds.entries()) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?,?,?)").run(`${rigId}-n${i}`, rigId, lid);
    }
    return rigId;
  }

  it("发出警告，并点名 bundle 会静默丢弃的 pod", () => {
    seedRig("drift-rig", ["orch.lead", "dev.driver", "dev50.driver", "dev50.qa"]);
    const w = describeSpecLiveDrift(SPEC, repo);
    expect(w).toBeTruthy();
    expect(w).toContain("dev50");
    expect(w).toContain("2 pods/2 seats");
    expect(w).toContain("3");   // live pods
    expect(w).toContain("4");   // live seats
    expect(w!.toLowerCase()).toContain("spec");
  });

  it("运行中的工作组与 spec 匹配时保持静默", () => {
    seedRig("drift-rig", ["orch.lead", "dev.driver"]);
    expect(describeSpecLiveDrift(SPEC, repo)).toBeNull();
  });

  it("没有同名工作组在运行时保持静默——编写新工作组不属于偏移", () => {
    seedRig("some-other-rig", ["orch.lead", "dev.driver", "dev50.driver"]);
    expect(describeSpecLiveDrift(SPEC, repo)).toBeNull();
  });

  // 已于 2026-08-12 被取代；旧预期在此保留名称，而不是直接删除。
  //
  // 构建 B 曾以“对不感知 pod 的旧版 spec 保持静默”交付——这是刻意的范围限制，
  // 并非旧版 spec 的固有属性。它在关键处是错误的：v1 spec 经同一个创建端点导出，
  // 会生成同样确定却错误的产物；当时的静默只是被通过测试掩盖的缺陷。现在旧版也会比较
  //（扁平 `nodes:` id 对扁平 `logical_id`），路由会拒绝会丢弃实时席位的旧版 spec。
  it("对不感知 pod 的旧版 spec 发出警告——旧格式不会让偏移变得安全", () => {
    seedRig("drift-rig", ["orch.lead", "dev.driver", "dev50.driver"]);
    const warning = describeSpecLiveDrift({ name: "drift-rig", nodes: [{ id: "dev" }] }, repo);
    expect(warning).not.toBeNull();
    expect(warning).toContain("dev.driver");
  });

  // 这里仍保持静默，理由不受旧版改动影响：没有 `name:` 就没有可查询的工作组，
  // 因而既无比较对象，也没有可诚实报告的内容。
  it("对无名称 spec 保持静默", () => {
    seedRig("drift-rig", ["orch.lead", "dev.driver", "dev50.driver"]);
    expect(describeSpecLiveDrift({ pods: SPEC.pods }, repo)).toBeNull();
  });

  it("完全没有 repository 时保持静默而非抛错", () => {
    expect(describeSpecLiveDrift(SPEC, undefined)).toBeNull();
  });

  // 两个辅助函数在 repository 失败时有意采用不同策略，本测试固定报告侧。
  // `describeSpecLiveDrift` 会吞掉错误——对横幅而言最坏结果只是缺少横幅；执行侧
  // `assessSpecLiveDrift` 则会向上传播，使创建路由失败关闭，而不是在比较根本未运行时导出；
  // 该侧由路由测试固定。
  it("拓扑查询本身失败时保持静默而非抛错", () => {
    seedRig("drift-rig", ["orch.lead", "dev.driver"]);
    db.prepare("DROP TABLE nodes").run();
    expect(() => describeSpecLiveDrift(SPEC, repo)).not.toThrow();
    expect(describeSpecLiveDrift(SPEC, repo)).toBeNull();
  });

  it("即使 spec 值异常，也绝不向导出路径抛错", () => {
    seedRig("drift-rig", ["orch.lead"]);
    for (const bad of [null, undefined, 42, "a string", { name: "drift-rig", pods: "not-an-array" }]) {
      expect(() => describeSpecLiveDrift(bad, repo)).not.toThrow();
    }
  });
});
