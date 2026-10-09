import { describe, it, expect } from "vitest";
import { projectRigToGraph } from "../src/domain/graph-projection.js";
import type { RigGraphInput } from "../src/domain/graph-projection.js";
import type { Pod, RigWithRelations, Session } from "../src/domain/types.js";

function makeRig(
  nodes: { id: string; logicalId: string; role?: string; runtime?: string; bindingTmux?: string; cmuxSurface?: string }[],
  edges: { id: string; sourceId: string; targetId: string; kind: string }[] = [],
  sessions: Session[] = [],
  pods: Pod[] = []
): RigGraphInput {
  const rig: RigWithRelations = {
    rig: { id: "rig-1", name: "r01", createdAt: "2026-03-23", updatedAt: "2026-03-23" },
    nodes: nodes.map((n) => ({
      id: n.id,
      rigId: "rig-1",
      logicalId: n.logicalId,
      role: n.role ?? null,
      runtime: n.runtime ?? null,
      model: null,
      cwd: null,
      createdAt: "2026-03-23",
      binding: n.bindingTmux
        ? {
            id: `bind-${n.id}`,
            nodeId: n.id,
            tmuxSession: n.bindingTmux,
            tmuxWindow: null,
            tmuxPane: null,
            cmuxWorkspace: null,
            cmuxSurface: n.cmuxSurface ?? null,
            updatedAt: "2026-03-23",
          }
        : null,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      rigId: "rig-1",
      sourceId: e.sourceId,
      targetId: e.targetId,
      kind: e.kind,
      createdAt: "2026-03-23",
    })),
  };
  return { ...rig, sessions, pods };
}

function makeSession(nodeId: string, status: string, createdAt: string): Session {
  return {
    id: `sess-${nodeId}-${createdAt}`,
    nodeId,
    sessionName: `r01-${nodeId}`,
    status,
    lastSeenAt: null,
    createdAt,
  };
}

describe("projectRigToGraph", () => {
  it("3 个节点和 2 条边生成正确的 React Flow 结构", () => {
    const input = makeRig(
      [
        { id: "n1", logicalId: "orchestrator", role: "orchestrator" },
        { id: "n2", logicalId: "worker-a", role: "worker" },
        { id: "n3", logicalId: "worker-b", role: "worker" },
      ],
      [
        { id: "e1", sourceId: "n1", targetId: "n2", kind: "delegates_to" },
        { id: "e2", sourceId: "n1", targetId: "n3", kind: "delegates_to" },
      ]
    );

    const result = projectRigToGraph(input);
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
  });

  it("空工作组生成 { nodes: [], edges: [] }", () => {
    const input = makeRig([], []);
    const result = projectRigToGraph(input);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("所有节点的 type 均为 rigNode", () => {
    const input = makeRig([
      { id: "n1", logicalId: "a" },
      { id: "n2", logicalId: "b" },
    ]);
    const result = projectRigToGraph(input);
    for (const node of result.nodes) {
      expect(node.type).toBe("rigNode");
    }
  });

  it("确定性布局：三节点工作组具有精确位置", () => {
    const input = makeRig([
      { id: "n1", logicalId: "a" },
      { id: "n2", logicalId: "b" },
      { id: "n3", logicalId: "c" },
    ]);

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(result.nodes[1]!.position).toEqual({ x: 0, y: 200 });
    expect(result.nodes[2]!.position).toEqual({ x: 0, y: 400 });
  });

  it("有绑定的节点在 node.data 中包含绑定数据", () => {
    const input = makeRig([
      { id: "n1", logicalId: "worker", bindingTmux: "r01-worker", cmuxSurface: "s-1" },
    ]);

    const result = projectRigToGraph(input);
    const data = result.nodes[0]!.data;
    expect(data.binding).not.toBeNull();
    expect(data.binding.tmuxSession).toBe("r01-worker");
    expect(data.binding.cmuxSurface).toBe("s-1");
  });

  it("无绑定节点在 node.data 中的 binding 为 null", () => {
    const input = makeRig([{ id: "n1", logicalId: "worker" }]);

    const result = projectRigToGraph(input);
    const data = result.nodes[0]!.data;
    expect(data).toHaveProperty("binding");
    expect(data.binding).toBeNull();
  });

  it("RF node.id 等于 nodes.id，edge.source 等于 sourceId，edge.target 等于 targetId", () => {
    const input = makeRig(
      [
        { id: "node-abc", logicalId: "a" },
        { id: "node-xyz", logicalId: "b" },
      ],
      [{ id: "edge-1", sourceId: "node-abc", targetId: "node-xyz", kind: "delegates_to" }]
    );

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.id).toBe("node-abc");
    expect(result.nodes[1]!.id).toBe("node-xyz");
    expect(result.edges[0]!.source).toBe("node-abc");
    expect(result.edges[0]!.target).toBe("node-xyz");
  });

  it("边标签与边 kind 匹配", () => {
    const input = makeRig(
      [
        { id: "n1", logicalId: "a" },
        { id: "n2", logicalId: "b" },
      ],
      [{ id: "e1", sourceId: "n1", targetId: "n2", kind: "can_observe" }]
    );

    const result = projectRigToGraph(input);
    expect(result.edges[0]!.label).toBe("can_observe");
  });

  it("node.data 包含会话状态（按 createdAt 取最新）", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "worker" }],
      [],
      [makeSession("n1", "running", "2026-03-23T01:00:00")]
    );

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data.status).toBe("running");
  });

  it("节点有多个会话时按 createdAt 取最新者", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "worker" }],
      [],
      [
        makeSession("n1", "exited", "2026-03-23T01:00:00"),
        makeSession("n1", "running", "2026-03-23T02:00:00"),
      ]
    );

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data.status).toBe("running");
  });

  it("节点无会话时 node.data.status 为 null", () => {
    const input = makeRig([{ id: "n1", logicalId: "worker" }]);

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data).toHaveProperty("status");
    expect(result.nodes[0]!.data.status).toBeNull();
  });

  it("最新会话未运行时清除 startupStatus，使图中不显示陈旧 READY", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "worker", runtime: "claude-code" }],
      [],
      [makeSession("n1", "exited", "2026-03-23T02:00:00")]
    );

    const overlay = [
      { logicalId: "worker", startupStatus: "ready" as const, canonicalSessionName: "worker@test-rig", restoreOutcome: "n-a" },
    ];

    const result = projectRigToGraph(input, overlay);
    expect(result.nodes[0]!.data.status).toBe("exited");
    expect(result.nodes[0]!.data.startupStatus).toBeNull();
  });

  // NS-T12：富化字段
  it("增强字段包含 overlay 中的 startupStatus、canonicalSessionName、podId 和 restoreOutcome", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "dev.impl", runtime: "claude-code" }],
      [],
      [makeSession("n1", "running", "2026-03-23T03:00:00")]
    );

    const overlay = [
      { logicalId: "dev.impl", startupStatus: "ready" as const, canonicalSessionName: "dev-impl@test-rig", restoreOutcome: "resumed" },
    ];

    const result = projectRigToGraph(input, overlay);
    const node = result.nodes.find((n) => n.data.logicalId === "dev.impl");
    expect(node).toBeDefined();
    expect(node!.data.startupStatus).toBe("ready");
    expect(node!.data.canonicalSessionName).toBe("dev-impl@test-rig");
    expect(node!.data.restoreOutcome).toBe("resumed");
  });

  // NS-T12：pod 组节点
  it("为 pod 创建 React Flow 组节点", () => {
    const input = makeRig([
      { id: "n1", logicalId: "dev.impl", runtime: "claude-code" },
      { id: "n2", logicalId: "dev.qa", runtime: "codex" },
    ], [], [], [
      {
        id: "dev",
        namespace: "dev",
        rigId: "rig-1",
        label: "Implementation",
        summary: null,
        continuityPolicyJson: null,
        createdAt: "2026-03-23",
      },
    ]);
    // 给节点加 podId
    input.nodes[0]!.podId = "dev";
    input.nodes[1]!.podId = "dev";

    const result = projectRigToGraph(input);
    const groupNode = result.nodes.find((n) => n.id === "pod-dev");
    expect(groupNode).toBeDefined();
    expect(groupNode!.type).toBe("podGroup");
    expect(groupNode!.data.podLabel).toBe("Implementation");
    expect(groupNode!.data.podNamespace).toBe("dev");
    expect(groupNode!.data.logicalId).toBe("dev");

    // 子节点 data 中应有 parentId 与 podId
    const childNodes = result.nodes.filter((n) => n.parentId === "pod-dev");
    expect(childNodes).toHaveLength(2);
    expect(childNodes[0]!.data.podId).toBe("dev");
    expect(childNodes[0]!.data.podNamespace).toBe("dev");
  });

  // NS-T03: nodeKind derived from runtime
  it("terminal 运行时的 nodeKind 为 infrastructure，其他为 agent", () => {
    const input = makeRig([
      { id: "n1", logicalId: "impl", runtime: "claude-code" },
      { id: "n2", logicalId: "server", runtime: "terminal" },
      { id: "n3", logicalId: "qa", runtime: "codex" },
    ]);

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data.nodeKind).toBe("agent");
    expect(result.nodes[1]!.data.nodeKind).toBe("infrastructure");
    expect(result.nodes[2]!.data.nodeKind).toBe("agent");
  });

  // 任务 7：graph 投影含 spec hint 字段
  it("节点数据包含节点的 resolvedSpecName 和 profile", () => {
    const input = makeRig([
      { id: "n1", logicalId: "impl", runtime: "claude-code" },
    ]);
    // Manually set spec fields on the node (makeRig doesn't include them)
    (input.nodes[0] as Record<string, unknown>).resolvedSpecName = "impl-agent";
    (input.nodes[0] as Record<string, unknown>).profile = "default";

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data.resolvedSpecName).toBe("impl-agent");
    expect(result.nodes[0]!.data.profile).toBe("default");
  });

  it("节点数据包含反映连接边数量的 edgeCount", () => {
    const input = makeRig(
      [
        { id: "n1", logicalId: "impl" },
        { id: "n2", logicalId: "qa" },
        { id: "n3", logicalId: "lead" },
      ],
      [
        { id: "e1", sourceId: "n1", targetId: "n2", kind: "delegates_to" },
        { id: "e2", sourceId: "n3", targetId: "n1", kind: "reports_to" },
      ],
    );

    const result = projectRigToGraph(input);
    const implNode = result.nodes.find((n) => n.data.logicalId === "impl")!;
    const qaNode = result.nodes.find((n) => n.data.logicalId === "qa")!;
    const leadNode = result.nodes.find((n) => n.data.logicalId === "lead")!;

    expect(implNode.data.edgeCount).toBe(2); // source of e1, target of e2
    expect(qaNode.data.edgeCount).toBe(1);   // target of e1
    expect(leadNode.data.edgeCount).toBe(1);  // source of e2
  });

  it("未设置时节点数据的 resolvedSpecName/profile 默认为 null", () => {
    const input = makeRig([{ id: "n1", logicalId: "impl" }]);

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data.resolvedSpecName).toBeNull();
    expect(result.nodes[0]!.data.profile).toBeNull();
    expect(result.nodes[0]!.data.edgeCount).toBe(0);
  });

  // Task 7: canonicalSessionName uses overlay (binding) first, then newest session by ULID
  it("canonicalSessionName 优先采用 overlay 而非最新会话", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "impl", bindingTmux: "impl@rig" }],
      [],
      [
        makeSession("n1", "running", "2026-04-01T00:00:00Z"),
        makeSession("n1", "running", "2026-04-02T00:00:00Z"),
      ],
    );

    // Overlay provides the canonical name (from binding tmuxSession)
    const overlay = [{ logicalId: "impl", startupStatus: "ready" as const, canonicalSessionName: "impl@rig-overlay", restoreOutcome: "n-a" }];
    const result = projectRigToGraph(input, overlay);

    expect(result.nodes[0]!.data.canonicalSessionName).toBe("impl@rig-overlay");
  });

  it("没有 overlay 时 canonicalSessionName 回退到最新会话", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "impl" }],
      [],
      [
        makeSession("n1", "running", "2026-04-01T00:00:00Z"),
        // Higher ULID-like ID (later date → higher string sort)
        { id: "sess-n1-2026-04-02", nodeId: "n1", sessionName: "r01-impl-latest", status: "running", lastSeenAt: null, createdAt: "2026-04-02" },
      ],
    );

    const result = projectRigToGraph(input);
    // Falls back to latest session by ULID (highest id string)
    expect(result.nodes[0]!.data.canonicalSessionName).toBe("r01-impl-latest");
  });
});
