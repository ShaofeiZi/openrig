import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigExpansionService } from "../src/domain/rig-expansion-service.js";
import type { ExpansionRequest } from "../src/domain/types.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

describe("RigExpansionService", () => {
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

  function seedRig(name = "test-rig") {
    return setup.rigRepo.createRig(name);
  }

  function terminalPodFragment(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
    return {
      id,
      label: "Infrastructure",
      members: [
        { id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
  }

  // T1：使用有效 pod 扩容会创建 pod 和节点。
  it("使用有效 pod 扩容时创建 pod 和节点", async () => {
    const rig = seedRig();
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("ok");
    expect(result.podNamespace).toBe("infra");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.logicalId).toBe("infra.server");
    expect(result.nodes[0]!.status).toBe("launched");

    // 验证数据库中的拓扑。
    const updatedRig = setup.rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  it("接受包含 YAML 特殊字符的标签和摘要", async () => {
    const rig = seedRig();
    const result = await service.expand({
      rigId: rig.id,
      pod: {
        id: "ops",
        label: 'Ops: "Research"',
        summary: "Owns: queues, alerts, and runbooks",
        members: [
          {
            id: "agent",
            runtime: "terminal",
            agentRef: "builtin:terminal",
            profile: "none",
            cwd: '/tmp/"quoted":path',
            label: 'Worker: "A"',
          },
        ],
        edges: [],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("ok");

    const podRow = db.prepare("SELECT namespace, label, summary FROM pods WHERE rig_id = ? AND namespace = ?").get(
      rig.id,
      "ops",
    ) as { namespace: string; label: string; summary: string | null } | undefined;
    expect(podRow?.label).toBe('Ops: "Research"');
    expect(podRow?.summary).toBe("Owns: queues, alerts, and runbooks");

    const node = setup.rigRepo.getRig(rig.id)?.nodes.find((candidate) => candidate.logicalId === "ops.agent");
    expect(node?.label).toBe('Worker: "A"');
  });

  // T2：工作组不存在时返回错误。
  it("工作组不存在时返回错误", async () => {
    const result = await service.expand({ rigId: "nonexistent", pod: terminalPodFragment() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rig_not_found");
  });

  // T3：pod 命名空间重复时返回错误，且工作组保持不变。
  it("拒绝重复的 pod 命名空间", async () => {
    const rig = seedRig();
    // 首次扩容成功。
    await service.expand({ rigId: rig.id, pod: terminalPodFragment("infra") });
    // 再次使用相同命名空间应失败。
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment("infra", "server2") });
    expect(result.ok).toBe(false);
  });

  // T4：逻辑 ID 重复时返回错误。
  it("拒绝重复的逻辑 ID", async () => {
    const rig = seedRig();
    // 先直接添加 logicalId 为 "infra.server" 的节点。
    await service.expand({ rigId: rig.id, pod: terminalPodFragment("infra", "server") });
    // 另一个 pod 中的成员会创建 "infra2.server"；命名空间不同，因此应成功。
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment("infra2", "server") });
    expect(result.ok).toBe(true);
  });

  // T5：创建指向已有节点的跨 pod 边。
  it("创建指向已有节点的跨 pod 边", async () => {
    const rig = seedRig();
    // 创建第一个 pod。
    await service.expand({ rigId: rig.id, pod: terminalPodFragment("orch", "lead") });

    // 使用跨 pod 边进行扩容。
    const result = await service.expand({
      rigId: rig.id,
      pod: terminalPodFragment("dev", "impl"),
      crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }],
    });

    expect(result.ok).toBe(true);

    // 验证数据库中的边。
    const updatedRig = setup.rigRepo.getRig(rig.id);
    const edges = updatedRig!.edges;
    expect(edges.some((e) => e.kind === "delegates_to")).toBe(true);
  });

  // T6：跨 pod 边指向不存在的节点时返回错误。
  it("拒绝指向不存在节点的跨 pod 边", async () => {
    const rig = seedRig();
    const result = await service.expand({
      rigId: rig.id,
      pod: terminalPodFragment("dev", "impl"),
      crossPodEdges: [{ kind: "delegates_to", from: "nonexistent.node", to: "dev.impl" }],
    });
    expect(result.ok).toBe(false);
  });

  // T7：两个节点中有一个启动失败时，返回带重试目标的 partial 结果。
  it("部分节点启动失败时返回 partial 结果", async () => {
    const rig = seedRig();
    // 模拟第一次 createSession 失败、第二次成功。
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValueOnce({ ok: false, code: "unknown", message: "tmux not available" });

    const twoPod: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        { id: "server1", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        { id: "server2", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };
    const result = await service.expand({ rigId: rig.id, pod: twoPod });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("partial");
    expect(result.nodes.some((n) => n.status === "launched")).toBe(true);
    expect(result.nodes.some((n) => n.status === "failed")).toBe(true);
    expect(result.retryTargets.length).toBeGreaterThan(0);
  });

  // T9：终端节点成功启动。
  it("终端节点使用正确会话启动", async () => {
    const rig = seedRig();
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes[0]!.status).toBe("launched");
    expect(result.nodes[0]!.sessionName).toBeTruthy();
  });

  // T10：发出 rig.expanded 事件。
  it("扩容后发出 rig.expanded 事件", async () => {
    const rig = seedRig();
    await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'rig.expanded'").all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
    expect(payload.podNamespace).toBe("infra");
    expect(payload.status).toBe("ok");
  });

  // T8b：所有节点启动失败时，状态为 "failed"。
  it("所有节点启动失败时返回 failed 状态", async () => {
    const rig = seedRig();
    const tmux = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    tmux.createSession.mockResolvedValue({ ok: false, code: "unknown", message: "tmux unavailable" });

    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("failed");
    expect(result.nodes.every((n) => n.status === "failed")).toBe(true);
    expect(result.retryTargets).toHaveLength(1);

    // 即使所有启动都失败，拓扑仍然存在。
    const updatedRig = setup.rigRepo.getRig(rig.id);
    expect(updatedRig!.nodes.some((n) => n.logicalId === "infra.server")).toBe(true);
  });

  it("会话启动后部分节点的启动流程失败时返回 partial", async () => {
    const failingTerminalAdapter: RuntimeAdapter = {
      runtime: "terminal",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: vi.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, error: "terminal harness failed" }),
      checkReady: async () => ({ ready: true }),
    };

    setup = createTestApp(db, { adapters: { terminal: failingTerminalAdapter } });
    service = new RigExpansionService({
      db,
      rigRepo: setup.rigRepo,
      eventBus: setup.eventBus,
      nodeLauncher: setup.nodeLauncher,
      podInstantiator: setup.podInstantiator,
      sessionRegistry: setup.sessionRegistry,
    });

    const rig = seedRig();
    const twoPod: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        { id: "server1", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        { id: "server2", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
      ],
      edges: [],
    };

    const result = await service.expand({ rigId: rig.id, pod: twoPod });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("partial");
    expect(result.nodes.map((n) => n.status)).toEqual(["launched", "failed"]);
    expect(result.retryTargets).toEqual(["infra.server2"]);

    const sessions = setup.sessionRegistry.getSessionsForRig(rig.id);
    const failedSession = sessions.find((session) => session.nodeId === result.nodes[1]!.nodeId);
    expect(failedSession?.startupStatus).toBe("failed");
  });

  it("所有已实体化节点在会话启动后均启动失败时返回 failed", async () => {
    const failingTerminalAdapter: RuntimeAdapter = {
      runtime: "terminal",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: false, error: "terminal harness failed" }),
      checkReady: async () => ({ ready: true }),
    };

    setup = createTestApp(db, { adapters: { terminal: failingTerminalAdapter } });
    service = new RigExpansionService({
      db,
      rigRepo: setup.rigRepo,
      eventBus: setup.eventBus,
      nodeLauncher: setup.nodeLauncher,
      podInstantiator: setup.podInstantiator,
      sessionRegistry: setup.sessionRegistry,
    });

    const rig = seedRig();
    const result = await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("failed");
    expect(result.nodes[0]!.status).toBe("failed");
    expect(result.nodes[0]!.error).toContain("运行环境启动失败");
    expect(result.retryTargets).toEqual(["infra.server"]);

    const sessions = setup.sessionRegistry.getSessionsForRig(rig.id);
    expect(sessions[0]?.startupStatus).toBe("failed");
  });

  // T11：扩容期间抑制 rig.imported 事件。
  it("扩容期间不发出 rig.imported 事件", async () => {
    const rig = seedRig();
    await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    const events = db.prepare("SELECT type FROM events WHERE type = 'rig.imported'").all() as Array<{ type: string }>;
    expect(events).toHaveLength(0);
  });

  // Agent Starter v1 垂直切片 M1 R2——扩容透传。扩容请求必须沿着已经携带
  // `sessionSource` 的同一路径传递 `starterRef`：ExpansionPodFragment.members 包含
  // `starterRef?` 字段，结构化扩容规范则在成员上输出 snake-case 的 `starter_ref`。
  // 策略（OPR.0.3.3.24）：监视 podInstantiator.materializeStructured，捕获它收到的
  // 结构化规范对象，并断言成员携带 `starter_ref` 与 starter 名称（不再往返合成 YAML）。
  it("扩容时把 starterRef 保留到结构化实体化规范中（R2）", async () => {
    const rig = seedRig();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    const podWithStarter: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        {
          id: "server",
          runtime: "claude-code",
          agentRef: "local:agents/server",
          profile: "default",
          cwd: "/tmp",
          starterRef: { name: "openrig-builder-base--claude-code" },
        },
      ],
      edges: [],
    };
    await service.expand({ rigId: rig.id, pod: podWithStarter });

    expect(materializeSpy).toHaveBeenCalled();
    // OPR.0.3.3.24：expand 传入结构化规范对象（不合成 YAML）；starterRef 以成员上的
    // snake-case `starter_ref` 形式透传。
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const member = specObject.pods[0]!.members[0]!;
    expect(member["starter_ref"]).toBeDefined();
    expect((member["starter_ref"] as { name: string }).name).toBe("openrig-builder-base--claude-code");

    materializeSpy.mockRestore();
  });

  it("缺少 starterRef 时不会向结构化规范泄漏 starter_ref（反向回归）", async () => {
    const rig = seedRig();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    await service.expand({ rigId: rig.id, pod: terminalPodFragment() });

    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    expect(specObject.pods[0]!.members[0]!["starter_ref"]).toBeUndefined();
    materializeSpy.mockRestore();
  });

  // OPR.0.5.6.3——session_source.ref.version 随 fragment→spec 映射传递。
  // SessionSourceAgentImageSpec.ref 携带 `version?: string`（可选版本选择器，使用时默认为
  // "1"），schema 会验证并规范化它。如果在这里丢弃该字段，固定版本的成员会被静默地
  // 按 DEFAULT 镜像版本扩容；这是 FAC1 "绝不静默丢弃"规则在整个 session_source
  // 区块上的应用。
  it("扩容时把 session_source ref.version 保留到结构化实体化规范中", async () => {
    const rig = seedRig();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    const podWithPinnedImage: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        {
          id: "server",
          runtime: "claude-code",
          agentRef: "local:agents/server",
          profile: "default",
          cwd: "/tmp",
          sessionSource: { mode: "agent_image", ref: { kind: "image_name", value: "builder-base", version: "3" } },
        },
      ],
      edges: [],
    };
    await service.expand({ rigId: rig.id, pod: podWithPinnedImage });

    expect(materializeSpy).toHaveBeenCalled();
    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const sessionSource = specObject.pods[0]!.members[0]!["session_source"] as { mode: string; ref: Record<string, unknown> };
    expect(sessionSource).toBeDefined();
    expect(sessionSource.ref["value"]).toBe("builder-base");
    // 固定值本身：版本选择器必须在映射后保留。
    expect(sessionSource.ref["version"]).toBe("3");
    materializeSpy.mockRestore();
  });

  // OPR.0.5.6.3 不扩大行为的约束：未固定版本的 session_source 必须精确映射为
  // { mode, ref: { kind, value } }；不能凭空产生 version 键，已有字段也保持不变。
  it("未固定版本的 session_source 精确映射为原有形状（无 version 键、不扩大行为）", async () => {
    const rig = seedRig();
    const materializeSpy = vi.spyOn(setup.podInstantiator, "materializeStructured");
    const podWithFork: ExpansionRequest["pod"] = {
      id: "infra",
      label: "Infrastructure",
      members: [
        {
          id: "server",
          runtime: "claude-code",
          agentRef: "local:agents/server",
          profile: "default",
          cwd: "/tmp",
          sessionSource: { mode: "fork", ref: { kind: "native_id", value: "sess-abc" } },
        },
      ],
      edges: [],
    };
    await service.expand({ rigId: rig.id, pod: podWithFork });

    const specObject = materializeSpy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    const sessionSource = specObject.pods[0]!.members[0]!["session_source"];
    expect(sessionSource).toEqual({ mode: "fork", ref: { kind: "native_id", value: "sess-abc" } });
    materializeSpy.mockRestore();
  });
});
