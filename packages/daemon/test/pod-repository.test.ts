import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";

describe("PodRepository + RigRepository 演进（AS-T08a）", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // T1：pod 记录可正确持久化和加载
  it("正确持久化并加载 pod 记录", () => {
    const rig = rigRepo.createRig("test-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Development", {
      summary: "Dev pod",
      continuityPolicyJson: JSON.stringify({ enabled: true, sync_triggers: ["manual"] }),
    });

    expect(pod.id).toBeDefined();
    expect(pod.rigId).toBe(rig.id);
    expect(pod.namespace).toBe("dev");
    expect(pod.label).toBe("Development");
    expect(pod.summary).toBe("Dev pod");
    expect(pod.continuityPolicyJson).toContain("enabled");
    expect(pod.createdAt).toBeDefined();

    // 通过 getPod 往返
    const loaded = podRepo.getPod(pod.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.namespace).toBe("dev");
    expect(loaded!.label).toBe("Development");
    expect(loaded!.summary).toBe("Dev pod");

    // getPodsForRig 查询
    const pods = podRepo.getPodsForRig(rig.id);
    expect(pods).toHaveLength(1);
    expect(pods[0]!.id).toBe(pod.id);
  });

  // T2：创建节点时持久化 agent_ref、profile 和 pod_id
  it("创建节点时持久化 agent_ref、profile 和 pod_id", () => {
    const rig = rigRepo.createRig("test-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Dev");

    const node = rigRepo.addNode(rig.id, "impl", {
      runtime: "claude-code",
      podId: pod.id,
      agentRef: "local:agents/implementer",
      profile: "tdd",
      label: "Implementer",
    });

    expect(node.podId).toBe(pod.id);
    expect(node.agentRef).toBe("local:agents/implementer");
    expect(node.profile).toBe("tdd");
    expect(node.label).toBe("Implementer");

    // 通过 getRig 往返
    const full = rigRepo.getRig(rig.id);
    const loadedNode = full!.nodes.find((n) => n.logicalId === "impl");
    expect(loadedNode!.podId).toBe(pod.id);
    expect(loadedNode!.agentRef).toBe("local:agents/implementer");
    expect(loadedNode!.profile).toBe("tdd");
  });

  // T3：创建节点时持久化已解析的 spec 身份
  it("创建节点时持久化已解析的 spec 身份", () => {
    const rig = rigRepo.createRig("test-rig");

    const node = rigRepo.addNode(rig.id, "impl", {
      runtime: "claude-code",
      resolvedSpecName: "implementer",
      resolvedSpecVersion: "0.2",
      resolvedSpecHash: "sha256:abc123def456",
    });

    expect(node.resolvedSpecName).toBe("implementer");
    expect(node.resolvedSpecVersion).toBe("0.2");
    expect(node.resolvedSpecHash).toBe("sha256:abc123def456");

    // 往返验证
    const full = rigRepo.getRig(rig.id);
    const loaded = full!.nodes[0]!;
    expect(loaded.resolvedSpecName).toBe("implementer");
    expect(loaded.resolvedSpecVersion).toBe("0.2");
    expect(loaded.resolvedSpecHash).toBe("sha256:abc123def456");
  });

  // T4：rig/pod/node 之间的 FK 行为符合设计
  it("FK 行为：不存在 rig 的 pod 抛错，跨 rig 的 pod_id 抛错，同 rig 时成功", () => {
    // pod 指向 rig 的 FK：不存在的 rig_id 会抛错
    expect(() => podRepo.createPod("nonexistent-rig", "bad", "Bad")).toThrow();

    // 创建两个 rig，并在 rig A 中创建一个 pod
    const rigA = rigRepo.createRig("rig-a");
    const rigB = rigRepo.createRig("rig-b");
    const podA = podRepo.createPod(rigA.id, "pod-a", "Pod A");

    // 跨 rig 的 pod_id：rig B 中的节点使用 rig A 的 pod -> 抛错
    expect(() => {
      rigRepo.addNode(rigB.id, "impl", { podId: podA.id });
    }).toThrow(/另一个工作组/);

    // 同一 rig 的 pod_id 成功
    const node = rigRepo.addNode(rigA.id, "impl", { podId: podA.id });
    expect(node.podId).toBe(podA.id);
  });

  // T5：删除 pod 或 rig 时，成员节点行为正确
  it("删除 pod -> node.pod_id 为 NULL；删除 rig -> 级联删除 pod + 节点", () => {
    const rig = rigRepo.createRig("test-rig");
    const pod = podRepo.createPod(rig.id, "dev", "Dev");
    const node = rigRepo.addNode(rig.id, "impl", { podId: pod.id, runtime: "claude-code" });

    // 删除 pod -> node.pod_id 变为 NULL
    podRepo.deletePod(pod.id);
    expect(podRepo.getPod(pod.id)).toBeNull();

    const full = rigRepo.getRig(rig.id);
    const loadedNode = full!.nodes.find((n) => n.logicalId === "impl");
    expect(loadedNode!.podId).toBeNull();

    // 删除 rig -> 级联删除 pod 和节点
    const pod2 = podRepo.createPod(rig.id, "arch", "Arch");
    rigRepo.deleteRig(rig.id);
    expect(podRepo.getPodsForRig(rig.id)).toHaveLength(0);
    expect(rigRepo.getRig(rig.id)).toBeNull();
  });

  // T6：repository 方法正确使用共享 DB handle
  it("repository 方法使用共享 DB handle", () => {
    expect(rigRepo.db).toBe(db);
    expect(podRepo.db).toBe(db);
    expect(rigRepo.db).toBe(podRepo.db);
  });
});
