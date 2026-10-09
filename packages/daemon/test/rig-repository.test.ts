import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

describe("RigRepository 装备仓库", () => {
  let db: Database.Database;
  let repo: RigRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new RigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("createRig 持久化并返回带 ID 的类型化 Rig", () => {
    const rig = repo.createRig("test-rig");
    expect(rig.id).toBeDefined();
    expect(typeof rig.id).toBe("string");
    expect(rig.id.length).toBeGreaterThan(0);
    expect(rig.name).toBe("test-rig");
    expect(rig.createdAt).toBeDefined();
  });

  it("addNode 使用装备外键持久化并返回类型化 Node", () => {
    const rig = repo.createRig("test-rig");
    const node = repo.addNode(rig.id, "orchestrator", {
      role: "orchestrator",
      runtime: "claude-code",
      model: "opus",
    });
    expect(node.id).toBeDefined();
    expect(node.rigId).toBe(rig.id);
    expect(node.logicalId).toBe("orchestrator");
    expect(node.role).toBe("orchestrator");
    expect(node.runtime).toBe("claude-code");
    expect(node.model).toBe("opus");
  });

  it("向不存在的装备 addNode 时抛错", () => {
    expect(() => repo.addNode("nonexistent", "worker")).toThrow();
  });

  it("在同一装备中以重复 logical_id 调用 addNode 时抛错", () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker");
    expect(() => repo.addNode(rig.id, "worker")).toThrow();
  });

  it("addEdge 验证两个节点均存在且属于同一装备", () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator");
    const n2 = repo.addNode(rig.id, "worker");
    const edge = repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");
    expect(edge.id).toBeDefined();
    expect(edge.sourceId).toBe(n1.id);
    expect(edge.targetId).toBe(n2.id);
    expect(edge.kind).toBe("delegates_to");
  });

  it("拒绝 addEdge 跨装备连接", () => {
    const rig1 = repo.createRig("rig-one");
    const rig2 = repo.createRig("rig-two");
    const n1 = repo.addNode(rig1.id, "worker-a");
    const n2 = repo.addNode(rig2.id, "worker-b");
    expect(() =>
      repo.addEdge(rig1.id, n1.id, n2.id, "delegates_to")
    ).toThrow(/同一个 rig/);
  });

  it("getRig 返回包含节点、边与绑定的完整图", () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator", { role: "orchestrator" });
    const n2 = repo.addNode(rig.id, "worker", { role: "worker" });
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    // 仅向 n1 添加绑定
    db.prepare(
      "INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)"
    ).run("bind-1", n1.id, "r01-orch1-lead");

    const full = repo.getRig(rig.id);
    expect(full).not.toBeNull();
    expect(full!.rig.name).toBe("test-rig");
    expect(full!.nodes).toHaveLength(2);
    expect(full!.edges).toHaveLength(1);
    expect(full!.edges[0]!.kind).toBe("delegates_to");

    // n1 有绑定
    const orchNode = full!.nodes.find((n) => n.logicalId === "orchestrator");
    expect(orchNode!.binding).not.toBeNull();
    expect(orchNode!.binding!.tmuxSession).toBe("r01-orch1-lead");
  });

  it("getRig：未绑定节点的 binding 为 null（不是 undefined/缺省）", () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker");

    const full = repo.getRig(rig.id);
    const workerNode = full!.nodes.find((n) => n.logicalId === "worker");
    // 必须显式为 null，而非 undefined
    expect(workerNode).toHaveProperty("binding");
    expect(workerNode!.binding).toBeNull();
  });

  it("listRigs 返回所有装备", () => {
    repo.createRig("rig-a");
    repo.createRig("rig-b");
    repo.createRig("rig-c");
    const rigs = repo.listRigs();
    expect(rigs).toHaveLength(3);
    const names = rigs.map((r) => r.name);
    expect(names).toContain("rig-a");
    expect(names).toContain("rig-b");
    expect(names).toContain("rig-c");
  });

  it("deleteRig 级联删除——节点与边均消失", () => {
    const rig = repo.createRig("test-rig");
    const n1 = repo.addNode(rig.id, "orchestrator");
    const n2 = repo.addNode(rig.id, "worker");
    repo.addEdge(rig.id, n1.id, n2.id, "delegates_to");

    repo.deleteRig(rig.id);

    expect(repo.getRig(rig.id)).toBeNull();
    expect(repo.listRigs()).toHaveLength(0);
  });

  // -- P3-T00：扩展节点字段 --

  it("addNode 持久化扩展字段", () => {
    const rig = repo.createRig("test-rig");
    const node = repo.addNode(rig.id, "worker", {
      role: "worker",
      runtime: "claude-code",
      surfaceHint: "tab:workers",
      workspace: "review",
      restorePolicy: "checkpoint_only",
      packageRefs: ["github:example/pkg@v1", "local:./my-pkg"],
    });

    expect(node.surfaceHint).toBe("tab:workers");
    expect(node.workspace).toBe("review");
    expect(node.restorePolicy).toBe("checkpoint_only");
    expect(node.packageRefs).toEqual(["github:example/pkg@v1", "local:./my-pkg"]);
  });

  it("getRig 返回带扩展字段的节点（已解析 packageRefs）", () => {
    const rig = repo.createRig("test-rig");
    repo.addNode(rig.id, "worker", {
      surfaceHint: "tab:main",
      packageRefs: ["pkg-a", "pkg-b"],
    });

    const full = repo.getRig(rig.id);
    const node = full!.nodes[0]!;
    expect(node.surfaceHint).toBe("tab:main");
    expect(node.packageRefs).toEqual(["pkg-a", "pkg-b"]);
    expect(Array.isArray(node.packageRefs)).toBe(true);
  });

  it("addNode 无扩展字段时：surfaceHint=null、workspace=null、restorePolicy=null、packageRefs=[]", () => {
    const rig = repo.createRig("test-rig");
    const node = repo.addNode(rig.id, "worker");

    expect(node.surfaceHint).toBeNull();
    expect(node.workspace).toBeNull();
    expect(node.restorePolicy).toBeNull();
    expect(node.packageRefs).toEqual([]);
  });
});

describe("接线回归", () => {
  it("createFullTestDb schema 包含 007 列", async () => {
    const { createFullTestDb } = await import("./helpers/test-app.js");
    const db = createFullTestDb();
    const cols = db.prepare("PRAGMA table_info(nodes)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("surface_hint");
    expect(names).toContain("workspace");
    expect(names).toContain("restore_policy");
    expect(names).toContain("package_refs");
    db.close();
  });
});

// L2 findLatestUsableSnapshot
describe("RigRepository.findLatestUsableSnapshot（L2）", () => {
  let db: Database.Database;
  let repo: RigRepository;

  beforeEach(() => {
    db = setupDb();
    repo = new RigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSnapshot(
    rigId: string,
    snapshotId: string,
    sessions: Array<{ nodeId: string; resumeToken: string | null }>,
    createdAt?: string,
  ): void {
    const data = {
      rig: { id: rigId, name: "rig-name", createdAt: "2026-04-28T00:00:00Z", updatedAt: "2026-04-28T00:00:00Z" },
      nodes: [],
      edges: [],
      sessions: sessions.map((s, i) => ({
        id: `sess-snap-${i}`,
        nodeId: s.nodeId,
        sessionName: `tmux-${s.nodeId}`,
        status: "detached",
        resumeType: s.resumeToken ? "claude" : null,
        resumeToken: s.resumeToken,
        restorePolicy: "resume_if_possible",
        lastSeenAt: null,
        createdAt: "2026-04-28T00:00:00Z",
        origin: "launched" as const,
        startupStatus: "ready" as const,
        startupCompletedAt: null,
      })),
      checkpoints: {},
    };
    if (createdAt) {
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(snapshotId, rigId, "manual", "complete", JSON.stringify(data), createdAt);
    } else {
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data) VALUES (?, ?, ?, ?, ?)")
        .run(snapshotId, rigId, "manual", "complete", JSON.stringify(data));
    }
  }

  it("装备不存在快照时返回 null", () => {
    const rig = repo.createRig("no-snap");
    expect(repo.findLatestUsableSnapshot(rig.id)).toBeNull();
  });

  it("仅有的快照中所有节点恢复令牌均为 null 时返回 null", () => {
    const rig = repo.createRig("null-tokens");
    seedSnapshot(rig.id, "snap-1", [
      { nodeId: "node-a", resumeToken: null },
      { nodeId: "node-b", resumeToken: null },
    ]);
    expect(repo.findLatestUsableSnapshot(rig.id)).toBeNull();
  });

  it("至少一个会话有非 null 恢复令牌时返回最新快照", () => {
    const rig = repo.createRig("usable");
    seedSnapshot(rig.id, "snap-1", [
      { nodeId: "node-a", resumeToken: "tok-a" },
      { nodeId: "node-b", resumeToken: null },
    ]);

    const result = repo.findLatestUsableSnapshot(rig.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("snap-1");
    expect(result!.data.sessions?.find((s) => s.nodeId === "node-a")?.resumeToken).toBe("tok-a");
  });

  it("即使仅部分节点有有效令牌也返回快照（逐节点 lifecycleState 处理各自可恢复性）", () => {
    const rig = repo.createRig("partial");
    seedSnapshot(rig.id, "snap-1", [
      { nodeId: "node-a", resumeToken: "tok-a" }, // recoverable
      { nodeId: "node-b", resumeToken: null },     // detached
      { nodeId: "node-c", resumeToken: null },     // detached
    ]);

    const result = repo.findLatestUsableSnapshot(rig.id);
    expect(result).not.toBeNull();
    expect(result!.data.sessions).toHaveLength(3);
  });

  it("存在多个可用快照时返回最新项（ORDER BY created_at DESC, id DESC）", () => {
    const rig = repo.createRig("multi-snap");
    seedSnapshot(rig.id, "snap-old", [{ nodeId: "node-a", resumeToken: "tok-old" }], "2026-04-27 00:00:00");
    seedSnapshot(rig.id, "snap-new", [{ nodeId: "node-a", resumeToken: "tok-new" }], "2026-04-28 00:00:00");

    const result = repo.findLatestUsableSnapshot(rig.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("snap-new");
  });
});
