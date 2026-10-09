import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { getNodeInventoryWithContext, getNodeDetailWithContext } from "../src/domain/node-inventory.js";

describe("上下文用量投影", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let store: ContextUsageStore;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    store = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test" });
  });

  afterEach(() => { db.close(); });

  const KNOWN_USAGE = {
    availability: "known" as const,
    reason: null,
    source: "claude_statusline_json" as const,
    usedPercentage: 67,
    remainingPercentage: 33,
    contextWindowSize: 200000,
    totalInputTokens: 120000,
    totalOutputTokens: 14000,
    currentUsage: "已使用 67%",
    transcriptPath: "/tmp/test.log",
    sessionId: "sess-123",
    sessionName: "dev-impl@test-rig",
    sampledAt: new Date().toISOString(),
    fresh: true,
  };

  // T1：NodeInventoryEntry 为有持久化数据的 Claude 节点包含 contextUsage
  it("getNodeInventoryWithContext 包含已知的 contextUsage", () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    store.persist(node.id, KNOWN_USAGE);

    const inventory = getNodeInventoryWithContext(db, rig.id, store);
    const entry = inventory.find((e) => e.logicalId === "dev.impl");

    expect(entry?.contextUsage).toBeDefined();
    expect(entry?.contextUsage?.availability).toBe("known");
    expect(entry?.contextUsage?.usedPercentage).toBe(67);
  });

  // T2：NodeInventoryEntry 为非 Claude 节点包含 unknown contextUsage
  it("getNodeInventoryWithContext 对非 Claude 节点返回 unknown", () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    setup.sessionRegistry.registerSession(node.id, "dev-qa@test-rig");

    const inventory = getNodeInventoryWithContext(db, rig.id, store);
    const entry = inventory.find((e) => e.logicalId === "dev.qa");

    expect(entry?.contextUsage?.availability).toBe("unknown");
  });

  // T3：NodeDetailEntry 包含完整 contextUsage
  it("getNodeDetailWithContext 包含完整 contextUsage", () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    store.persist(node.id, KNOWN_USAGE);

    const detail = getNodeDetailWithContext(db, rig.id, "dev.impl", store);
    expect(detail?.contextUsage?.availability).toBe("known");
    expect(detail?.contextUsage?.usedPercentage).toBe(67);
    expect(detail?.contextUsage?.contextWindowSize).toBe(200000);
  });

  // T4：图投影覆盖层包含精简上下文数据
  it("图覆盖层包含来自清单的精简上下文数据", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    store.persist(node.id, KNOWN_USAGE);

    // 通过使用上下文感知清单的 HTTP 路由进行测试
    const res = await setup.app.request(`/api/rigs/${rig.id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const graphNode = body.nodes.find((n: any) => n.data?.logicalId === "dev.impl");
    expect(graphNode?.data?.contextAvailability).toBe("known");
    expect(graphNode?.data?.contextUsedPercentage).toBe(67);
    expect(graphNode?.data?.contextTotalInputTokens).toBe(120000);
    expect(graphNode?.data?.contextTotalOutputTokens).toBe(14000);
  });

  // T5：WhoamiResult 包含 contextUsage（通过路由）
  it("whoami 为 Claude 节点包含 contextUsage", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    store.persist(node.id, KNOWN_USAGE);

    const res = await setup.app.request(`/api/whoami?nodeId=${node.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contextUsage).toBeDefined();
    expect(body.contextUsage.availability).toBe("known");
    expect(body.contextUsage.usedPercentage).toBe(67);
  });

  // T6：对不支持的运行时如实返回 unknown
  it("whoami 为 codex 节点返回 unknown contextUsage", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    setup.sessionRegistry.registerSession(node.id, "dev-qa@test-rig");

    const res = await setup.app.request(`/api/whoami?nodeId=${node.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contextUsage).toBeDefined();
    expect(body.contextUsage.availability).toBe("unknown");
  });

  // T7：节点详情路由返回上下文数据
  it("节点详情路由包含 contextUsage", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    store.persist(node.id, KNOWN_USAGE);

    const res = await setup.app.request(`/api/rigs/${rig.id}/nodes/${encodeURIComponent("dev.impl")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contextUsage).toBeDefined();
    expect(body.contextUsage.availability).toBe("known");
  });
});
