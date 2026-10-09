import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

describe("SessionRegistry——W2a producer generation 预留", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let nodeId: string;
  let secondNodeId: string;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    const rig = rigRepo.createRig("producer-rig");
    nodeId = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" }).id;
    secondNodeId = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" }).id;
  });

  afterEach(() => db.close());

  it("预留无副作用，且两个登记动词精确持久化传入 UUID", () => {
    const initialGeneration = registry.reserveOccupantGeneration();
    expect(initialGeneration).toMatch(/^[0-9a-f-]{36}$/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM occupant_tenures").get()).toEqual({ n: 0 });

    registry.registerSession(nodeId, "dev-impl@producer-rig", "initial", initialGeneration);
    expect(registry.currentOccupantTenure(nodeId)?.generationUuid).toBe(initialGeneration);

    const claimedGeneration = registry.reserveOccupantGeneration();
    registry.registerClaimedSession(secondNodeId, "dev-qa@producer-rig", "handover", claimedGeneration);
    expect(registry.currentOccupantTenure(secondNodeId)?.generationUuid).toBe(claimedGeneration);
  });

  it("tenure ledger 不可用时返回 null 且不修改状态", () => {
    db.exec("DROP TABLE occupant_tenures");
    expect(registry.reserveOccupantGeneration()).toBeNull();
  });

  it("native session continuation 优先，并丢弃未使用预留", () => {
    const first = registry.mintOccupantTenure(nodeId, "initial", "native-A");
    const reserved = registry.reserveOccupantGeneration();
    expect(reserved).not.toBeNull();

    const continued = registry.mintOccupantTenure(nodeId, "initial", "native-A", reserved);

    expect(continued.generationUuid).toBe(first.generationUuid);
    expect(registry.isOccupantGenerationRegistered(nodeId, reserved!)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM occupant_tenures WHERE node_id = ?").get(nodeId)).toEqual({ n: 1 });
  });

  it("已登记 generation 成员关系以节点为范围", () => {
    const generation = registry.reserveOccupantGeneration();
    registry.registerSession(nodeId, "dev-impl@producer-rig", "initial", generation);

    expect(registry.isOccupantGenerationRegistered(nodeId, generation!)).toBe(true);
    expect(registry.isOccupantGenerationRegistered(secondNodeId, generation!)).toBe(false);
  });
});
