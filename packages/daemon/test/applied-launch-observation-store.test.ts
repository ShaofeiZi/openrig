import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";

describe("AppliedLaunchObservationStore", () => {
  let db: DatabaseType;
  let registry: SessionRegistry;
  let store: AppliedLaunchObservationStore;

  beforeEach(() => {
    db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r1");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime, cwd) VALUES (?, ?, ?, ?, ?, ?)")
      .run("node-1", "rig-1", "dev.impl", "worker", "claude-code", "/tmp/project");
    registry = new SessionRegistry(db);
    store = new AppliedLaunchObservationStore(db);
  });

  afterEach(() => db.close());

  it("针对显式捕获的 generation 记录，且不修改仅追加的 tenure 行", () => {
    registry.registerSession("node-1", "dev-impl@r1");
    const tenure = registry.currentOccupantTenure("node-1")!;
    expect(store.recordGeneration(tenure.generationUuid, observeClaudePermission("--permission-mode acceptEdits"))).toBe(true);
    expect(store.readCurrent("node-1")).toMatchObject({
      generationUuid: tenure.generationUuid,
      runtime: "claude-code",
      axis: "permission",
      state: "observed",
      value: "acceptEdits",
    });
    expect(registry.currentOccupantTenure("node-1")).toEqual(tenure);
  });

  it("生成新的 occupant generation 后绝不继承前任观察", () => {
    registry.registerSession("node-1", "dev-impl@r1");
    const first = registry.currentOccupantTenure("node-1")!;
    expect(store.recordGeneration(first.generationUuid, observeClaudePermission("--permission-mode acceptEdits"))).toBe(true);

    registry.mintOccupantTenure("node-1", "handover");
    expect(registry.currentOccupantTenure("node-1")!.generationUuid).not.toBe(first.generationUuid);
    expect(store.readCurrent("node-1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observations").get()).toEqual({ n: 1 });
  });

  it("绝不将延迟的 launch 写入重新绑定到后继 generation", () => {
    registry.registerSession("node-1", "dev-impl@r1");
    const launchedGeneration = registry.currentOccupantTenure("node-1")!.generationUuid;
    registry.mintOccupantTenure("node-1", "handover");
    const successorGeneration = registry.currentOccupantTenure("node-1")!.generationUuid;

    expect(store.recordGeneration(launchedGeneration, observeClaudePermission("--permission-mode acceptEdits"))).toBe(true);
    expect(store.readCurrent("node-1")).toBeNull();
    expect(db.prepare("SELECT generation_uuid FROM applied_launch_observations").get()).toEqual({
      generation_uuid: launchedGeneration,
    });
    expect(launchedGeneration).not.toBe(successorGeneration);
  });

  it("只不可逆地使物理上已替换的 generation 失效", () => {
    registry.registerSession("node-1", "dev-impl@r1");
    const generation = registry.currentOccupantTenure("node-1")!.generationUuid;
    store.recordGeneration(generation, observeClaudePermission("--permission-mode acceptEdits"));
    expect(store.invalidateGeneration(generation)).toBe(true);
    expect(store.readCurrent("node-1")).toBeNull();
    expect(store.recordGeneration(generation, observeClaudePermission("--permission-mode acceptEdits"))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observation_invalidations WHERE generation_uuid = ?").get(generation)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observations WHERE generation_uuid = ?").get(generation)).toEqual({ n: 0 });
  });

  it("在成功 launch 记录效果前，将 adopted/discovered/unlaunched occupant 保持为 unknown", () => {
    registry.registerClaimedSession("node-1", "dev-impl@r1", "adopt");
    expect(store.readCurrent("node-1")).toBeNull();
  });

  it("migration 缺失或读写失败时降级为 unknown，且不抛出异常", () => {
    const bare = new Database(":memory:");
    try {
      const missing = new AppliedLaunchObservationStore(bare);
      expect(missing.recordGeneration("missing-generation", observeClaudePermission("--permission-mode acceptEdits"))).toBe(false);
      expect(missing.invalidateGeneration("missing-generation")).toBe(false);
      expect(missing.readCurrent("node-1")).toBeNull();
    } finally {
      bare.close();
    }
  });
});
