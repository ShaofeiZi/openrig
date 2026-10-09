import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigExpansionService } from "../src/domain/rig-expansion-service.js";
import type { ExpansionRequest } from "../src/domain/types.js";

describe("Expansion → Snapshot/Restore/Export 兼容性", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let service: RigExpansionService;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    service = new RigExpansionService({
      db,
      rigRepo: setup.rigRepo,
      eventBus: setup.eventBus,
      nodeLauncher: setup.nodeLauncher,
      podInstantiator: setup.podInstantiator,
      sessionRegistry: setup.sessionRegistry,
    });
  });

  afterEach(() => { db.close(); });

  function terminalPod(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // T1：expand -> snapshot 捕获扩展后的 pod + node
  it("snapshot 捕获扩展后的 pod 与 node", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const result = await service.expand({ rigId: rig.id, pod: terminalPod() });
    expect(result.ok).toBe(true);

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "test");
    expect(snapshot).toBeDefined();

    // snapshot 应包含扩展后的 pod
    const snapshotData = snapshot!.data;
    expect(snapshotData.pods.some((p) => p.namespace === "infra")).toBe(true);
    expect(snapshotData.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  // T2：expand -> snapshot -> teardown -> restore 恢复扩展后的 node
  it("expand -> snapshot -> teardown -> restore 恢复扩展后的 node", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    const expandResult = await service.expand({ rigId: rig.id, pod: terminalPod() });
    expect(expandResult.ok).toBe(true);

    // 创建 snapshot
    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "pre-restore");
    expect(snapshot).toBeDefined();

    // teardown（终止 session，标记 stopped）
    const teardown = await setup.teardownOrchestrator.teardown(rig.id);
    expect(teardown.errors).toHaveLength(0);

    // restore
    const restoreResult = await setup.restoreOrchestrator.restore(snapshot!.id);
    expect(restoreResult.ok).toBe(true);

    // 验证扩展后的 node 已恢复
    const restoredRig = setup.rigRepo.getRig(rig.id);
    expect(restoredRig!.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  // T3：expand -> export spec 包含具有 authored namespace 的扩展 pod
  it("export spec 包含具有 authored namespace 的扩展 pod", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    await service.expand({ rigId: rig.id, pod: terminalPod("monitoring", "collector") });

    const spec = setup.rigSpecExporter.exportRig(rig.id) as Record<string, unknown>;
    const pods = spec["pods"] as Array<{ id: string; members: Array<{ id: string }> }>;
    expect(pods.some((p) => p.id === "monitoring")).toBe(true);
    const monPod = pods.find((p) => p.id === "monitoring")!;
    expect(monPod.members.some((m) => m.id === "collector")).toBe(true);
  });

  // T4：restore 后保留扩展 pod namespace
  it("restore 往返后保留扩展 pod namespace", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    await service.expand({ rigId: rig.id, pod: terminalPod("custom-ns", "worker") });

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "ns-test");
    await setup.teardownOrchestrator.teardown(rig.id);
    await setup.restoreOrchestrator.restore(snapshot!.id);

    // Pod namespace 应仍为 "custom-ns"
    const pods = db.prepare("SELECT namespace FROM pods WHERE rig_id = ?").all(rig.id) as Array<{ namespace: string }>;
    expect(pods.some((p) => p.namespace === "custom-ns")).toBe(true);

    // Node logical ID 应仍使用 authored namespace
    const restoredRig = setup.rigRepo.getRig(rig.id);
    expect(restoredRig!.nodes.some((n) => n.logicalId === "custom-ns.worker")).toBe(true);
  });

  // T5：cross-pod edge 在 snapshot/restore 后存留
  it("cross-pod edge 在 snapshot/restore 往返后存留", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    await service.expand({ rigId: rig.id, pod: terminalPod("orch", "lead") });
    await service.expand({
      rigId: rig.id,
      pod: terminalPod("dev", "impl"),
      crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }],
    });

    // 验证 snapshot 前 edge 存在
    const rigBefore = setup.rigRepo.getRig(rig.id);
    expect(rigBefore!.edges.some((e) => e.kind === "delegates_to")).toBe(true);

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "edge-test");
    await setup.teardownOrchestrator.teardown(rig.id);
    await setup.restoreOrchestrator.restore(snapshot!.id);

    // edge 应存留
    const rigAfter = setup.rigRepo.getRig(rig.id);
    expect(rigAfter!.edges.some((e) => e.kind === "delegates_to")).toBe(true);
  });

  // T6：expanded pod 与原始 pod 的 snapshot data shape 相同
  it("expanded pod 的 snapshot data 具有相同 pod structure", async () => {
    const rig = setup.rigRepo.createRig("test-rig");
    await service.expand({ rigId: rig.id, pod: terminalPod() });

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "shape-test");
    const pod = snapshot!.data.pods.find((p) => p.namespace === "infra");

    // 应具有标准 Pod field——没有特殊 "expanded" flag
    expect(pod).toBeDefined();
    expect(pod!.id).toBeTruthy();
    expect(pod!.rigId).toBe(rig.id);
    expect(pod!.namespace).toBe("infra");
    expect(pod!.label).toBe("Infrastructure");
    // 没有 "expanded" 或 "source" field
    expect((pod as Record<string, unknown>)["expanded"]).toBeUndefined();
    expect((pod as Record<string, unknown>)["source"]).toBeUndefined();
  });
});
