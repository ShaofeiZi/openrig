import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

describe("WhoamiService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let transcriptStore: TranscriptStore;
  let svc: WhoamiService;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: true });
    svc = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore });
  });

  afterEach(() => { db.close(); });

  function seedRig() {
    const rig = rigRepo.createRig("my-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev", rig.id, "dev", "Development");
    const nodeA = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code", label: "Implementer", podId: "pod-dev" });
    const nodeB = rigRepo.addNode(rig.id, "dev.qa", { role: "reviewer", runtime: "codex", label: "QA", podId: "pod-dev" });
    rigRepo.addEdge(rig.id, nodeA.id, nodeB.id, "delegates_to");

    const sessA = sessionRegistry.registerSession(nodeA.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(sessA.id, "running");
    sessionRegistry.updateBinding(nodeA.id, { tmuxSession: "dev-impl@my-rig" });

    const sessB = sessionRegistry.registerSession(nodeB.id, "dev-qa@my-rig");
    sessionRegistry.updateStatus(sessB.id, "running");
    sessionRegistry.updateBinding(nodeB.id, { tmuxSession: "dev-qa@my-rig" });

    return { rig, nodeA, nodeB, sessA, sessB };
  }

  it("按 nodeId 解析时返回包含 memberLabel、peers 和 edges 的完整身份", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    expect(result).not.toBeNull();
    expect(result!.resolvedBy).toBe("node_id");
    expect(result!.identity.logicalId).toBe("dev.impl");
    expect(result!.identity.memberId).toBe("impl");
    expect(result!.identity.memberLabel).toBe("Implementer");
    expect(result!.identity.podNamespace).toBe("dev");
    expect(result!.identity.sessionName).toBe("dev-impl@my-rig");
    expect(result!.identity.runtime).toBe("claude-code");
    expect(result!.identity.rigName).toBe("my-rig");
  });

  it("按 sessionName 解析时返回相同结果", () => {
    seedRig();
    const result = svc.resolve({ sessionName: "dev-impl@my-rig" });

    expect(result).not.toBeNull();
    expect(result!.resolvedBy).toBe("session_name");
    expect(result!.identity.logicalId).toBe("dev.impl");
  });

  it("edges classified correctly as outgoing/incoming relative to queried node", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    // nodeA delegates_to nodeB，从 A 的视角属于 outgoing。
    expect(result!.edges.outgoing).toHaveLength(1);
    expect(result!.edges.outgoing[0]!.kind).toBe("delegates_to");
    expect(result!.edges.outgoing[0]!.to.logicalId).toBe("dev.qa");
    expect(result!.edges.incoming).toHaveLength(0);
  });

  it("peers 列表排除所查询节点自身，并使用当前会话", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    expect(result!.peers).toHaveLength(1);
    expect(result!.peers[0]!.logicalId).toBe("dev.qa");
    expect(result!.peers[0]!.sessionName).toBe("dev-qa@my-rig");
    expect(result!.peers[0]!.podNamespace).toBe("dev");
    // 不应包含自身。
    expect(result!.peers.find((p) => p.logicalId === "dev.impl")).toBeUndefined();
  });

  // OPR.99.0.6.1——peers[] 成员名单契约，在此陈述并断言。
  it("peers[] 是排除自身的同工作组成员名单，与有向边无关（契约）", () => {
    const { rig, nodeA } = seedRig();
    // 第三个节点与所查询节点没有任何出入边，但仍属于 peer。
    rigRepo.addNode(rig.id, "dev.unedged", { role: "worker", runtime: "terminal", podId: "pod-dev" });

    const result = svc.resolve({ nodeId: nodeA.id });

    const peerIds = result!.peers.map((p) => p.logicalId).sort();
    expect(peerIds).toEqual(["dev.qa", "dev.unedged"]);
    // dev.unedged 与 dev.impl 没有方向关系；peers[] 成员资格基于名单，而非边。
    expect(result!.edges.outgoing.find((e) => e.to.logicalId === "dev.unedged")).toBeUndefined();
    expect(result!.edges.incoming.find((e) => e.from.logicalId === "dev.unedged")).toBeUndefined();
    // 形状兼容：peer 条目的 key 保持不变（不重命名或移除）。
    expect(Object.keys(result!.peers[0]!).sort()).toEqual(
      ["logicalId", "memberId", "podId", "podNamespace", "runtime", "sessionName"],
    );
  });

  it("结果增量携带 peersNote，说明修正后的含义", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id });

    expect(result!.peersNote).toContain("排除自身后的 roster");
    expect(result!.peersNote).toContain("edges");
    expect(result!.peersNote).toContain("zrig ps --nodes");
  });

  it("不输出 roster/podRoster 字段（评审裁决：peers[] 已是成员名单）", () => {
    const { nodeA } = seedRig();
    const result = svc.resolve({ nodeId: nodeA.id }) as unknown as Record<string, unknown>;

    expect(result["roster"]).toBeUndefined();
    expect(result["podRoster"]).toBeUndefined();
  });

  it("未知 nodeId 返回 null", () => {
    seedRig();
    const result = svc.resolve({ nodeId: "nonexistent" });
    expect(result).toBeNull();
  });

  it("会话名匹配多个工作组时返回歧义错误", () => {
    // 创建两个拥有相同会话名的工作组。
    const rig1 = rigRepo.createRig("rig-a");
    const node1 = rigRepo.addNode(rig1.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@shared");

    const rig2 = rigRepo.createRig("rig-b");
    const node2 = rigRepo.addNode(rig2.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@shared");

    expect(() => svc.resolve({ sessionName: "dev-impl@shared" })).toThrow(/存在歧义/);
  });

  it("解析结果暴露 external_cli attachment 类型和外部会话名", () => {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", { role: "orchestrator", runtime: "claude-code" });
    sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch1-lead@rigged-buildout",
    });

    const result = svc.resolve({ nodeId: node.id });

    expect(result).not.toBeNull();
    expect(result!.identity.attachmentType).toBe("external_cli");
    expect(result!.identity.sessionName).toBe("orch1-lead@rigged-buildout");
  });

  it("未绑定节点的解析结果返回 null session，且不提供 transcript 操作入口", () => {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      role: "worker",
      runtime: "claude-code",
    });

    const result = svc.resolve({ nodeId: node.id });

    expect(result).not.toBeNull();
    expect(result!.identity.sessionName).toBeNull();
    expect(result!.transcript.enabled).toBe(false);
    expect(result!.transcript.path).toBeNull();
    expect(result!.transcript.tailCommand).toBeNull();
    expect(result!.transcript.grepCommand).toBeNull();
    expect(result!.commands.sendExamples).toEqual([]);
    expect(result!.commands.captureExamples).toEqual([]);
  });

  // ——PL-012 Token / Context Usage 表面 v0：runtimeContext 块——

  it("PL-012：claude-code 席位暴露 runtimeContext，并从 sessions 表取得 resumeToken", () => {
    const { nodeA, sessA } = seedRig();
    db.prepare("UPDATE sessions SET resume_token = ? WHERE id = ?").run("claude-resume-abc", sessA.id);
    const result = svc.resolve({ nodeId: nodeA.id });
    expect(result).not.toBeNull();
    expect(result!.runtimeContext).not.toBeNull();
    expect(result!.runtimeContext?.runtime).toBe("claude-code");
    if (result!.runtimeContext?.runtime === "claude-code") {
      expect(result!.runtimeContext.resumeToken).toBe("claude-resume-abc");
    }
  });

  it("PL-012：codex 席位暴露 runtime=codex 的 runtimeContext（v0 中 threadId 为 null）", () => {
    const { nodeB } = seedRig();
    const result = svc.resolve({ nodeId: nodeB.id });
    expect(result).not.toBeNull();
    expect(result!.runtimeContext?.runtime).toBe("codex");
    if (result!.runtimeContext?.runtime === "codex") {
      // v0：threadId 解析需要 pid 接线；如实暴露 null，而非伪造值。
      expect(result!.runtimeContext.threadId).toBeNull();
      expect(result!.runtimeContext.conversationId).toBeNull();
    }
  });

  it("PL-012: terminal runtime surfaces null runtimeContext (no conversation)", () => {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "tools.shell", { role: "worker", runtime: "terminal", label: "Shell" });
    const result = svc.resolve({ nodeId: node.id });
    expect(result).not.toBeNull();
    expect(result!.runtimeContext).toBeNull();
  });

  it("PL-012：未知 runtime 暴露 null runtimeContext（如实降级）", () => {
    const rig = rigRepo.createRig("future-rig");
    const node = rigRepo.addNode(rig.id, "future.experimental", { role: "worker", runtime: "future-runtime-xyz", label: "Future" });
    const result = svc.resolve({ nodeId: node.id });
    expect(result).not.toBeNull();
    expect(result!.runtimeContext).toBeNull();
  });

  // ——OPR.0.4.0.27 AC-4：compact 跳过 contextUsage/runtimeContext 计算——

  const sampleContextUsage = {
    availability: "known",
    totalInputTokens: 10,
    totalOutputTokens: 5,
    sampledAt: "2026-06-20T00:00:00Z",
  };

  it("AC-4：紧凑解析不调用 contextUsageStore 查询，并省略 contextUsage/runtimeContext", () => {
    const getForNode = vi.fn(() => sampleContextUsage as never);
    const svcWithCtx = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore, contextUsageStore: { getForNode } as never });
    const { nodeA } = seedRig();

    const result = svcWithCtx.resolve({ nodeId: nodeA.id, compact: true });

    expect(result).not.toBeNull();
    // 上游短路收益：绝不执行逐调用的 contextUsageStore 查询。
    expect(getForNode).not.toHaveBeenCalled();
    expect(result!.contextUsage).toBeUndefined();
    expect(result!.runtimeContext).toBeUndefined();
  });

  it("AC-4 向后兼容：完整解析（非 compact）执行 contextUsage 查询并构建 runtimeContext", () => {
    const getForNode = vi.fn(() => sampleContextUsage as never);
    const svcWithCtx = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore, contextUsageStore: { getForNode } as never });
    const { nodeA } = seedRig();

    const result = svcWithCtx.resolve({ nodeId: nodeA.id });

    expect(result).not.toBeNull();
    expect(getForNode).toHaveBeenCalledTimes(1);
    expect(result!.contextUsage).toEqual(sampleContextUsage);
    // nodeA 使用 claude-code，因此构建 runtimeContext，而不是跳过。
    expect(result!.runtimeContext).not.toBeNull();
    expect(result!.runtimeContext?.runtime).toBe("claude-code");
  });
});
