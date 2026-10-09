import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { workspacePrimitiveSchema } from "../src/db/migrations/038_workspace_primitive.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { LegacyRigSpecSchema as RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { LegacyRigSpecCodec as RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema as PodRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec as PodRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { RigNotFoundError } from "../src/domain/errors.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  const db = createFullTestDb();
  migrate(db, [workspacePrimitiveSchema]);
  return db;
}

describe("RigSpecExporter", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let exporter: RigSpecExporter;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    exporter = new RigSpecExporter({ rigRepo, sessionRegistry });
  });

  afterEach(() => {
    db.close();
  });

  function seedRig() {
    const rig = rigRepo.createRig("r99");
    const n1 = rigRepo.addNode(rig.id, "orchestrator", {
      role: "orchestrator",
      runtime: "claude-code",
      model: "opus",
      cwd: "/repo",
      surfaceHint: "tab:main",
      workspace: "review",
      packageRefs: ["github:example/pkg@v1"],
    });
    const n2 = rigRepo.addNode(rig.id, "worker", {
      role: "worker",
      runtime: "codex",
      cwd: "/repo",
    });
    rigRepo.addEdge(rig.id, n1.id, n2.id, "delegates_to");
    // 为 n1 添加绑定（导出时应排除）。
    sessionRegistry.updateBinding(n1.id, { tmuxSession: "r99-orchestrator", cmuxSurface: "s-1" });
    return { rig, n1, n2 };
  }

  it("导出包含节点和边的工作组 -> 有效 RigSpec", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);

    expect(spec.name).toBe("r99");
    expect(spec.schemaVersion).toBe(1);
    expect(spec.nodes).toHaveLength(2);
    expect(spec.edges).toHaveLength(1);
  });

  it("导出的 spec 通过 schema 校验", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);

    const result = RigSpecSchema.validate(RigSpecCodec.parse(RigSpecCodec.serialize(spec)));
    expect(result.valid).toBe(true);
  });

  it("导出的节点标识为 logical_id（而非数据库主键）", () => {
    const { rig, n1 } = seedRig();
    const spec = exporter.exportRig(rig.id);

    // 节点标识应是 "orchestrator" 等 logical_id，而非 ULID。
    expect(spec.nodes[0]!.id).toBe("orchestrator");
    expect(spec.nodes[1]!.id).toBe("worker");
    // 确认不是数据库主键。
    expect(spec.nodes[0]!.id).not.toBe(n1.id);
  });

  it("导出的边在 from/to 中使用 logical_id", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);

    expect(spec.edges[0]!.from).toBe("orchestrator");
    expect(spec.edges[0]!.to).toBe("worker");
    expect(spec.edges[0]!.kind).toBe("delegates_to");
  });

  it("导出内容排除会话标识、恢复令牌和绑定数据", () => {
    const { rig, n1 } = seedRig();
    // 添加包含恢复数据的会话。
    const sess = sessionRegistry.registerSession(n1.id, "r99-orchestrator");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ? WHERE id = ?")
      .run("claude_name", "secret-token", sess.id);

    const spec = exporter.exportRig(rig.id);
    const yaml = RigSpecCodec.serialize(spec);

    // 这些内容都不应出现在导出的 spec 中。
    expect(yaml).not.toContain("secret-token");
    expect(yaml).not.toContain(sess.id);
    expect(yaml).not.toContain("tmux_session");
    expect(yaml).not.toContain("cmux_surface");
    expect(yaml).not.toContain(n1.id); // DB PK
  });

  it("导出内容包含 role、runtime、model、cwd、surfaceHint、packageRefs", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);

    const orch = spec.nodes.find((n) => n.id === "orchestrator")!;
    expect(orch.role).toBe("orchestrator");
    expect(orch.runtime).toBe("claude-code");
    expect(orch.model).toBe("opus");
    expect(orch.cwd).toBe("/repo");
    expect(orch.surfaceHint).toBe("tab:main");
    expect(orch.packageRefs).toEqual(["github:example/pkg@v1"]);
  });

  it("导出内容包含最新会话的 restorePolicy（最新者优先）", () => {
    const { rig, n1 } = seedRig();
    // 添加两个时间戳明确、策略不同的会话。
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("sess-old", n1.id, "r99-orchestrator", "exited", "relaunch_fresh", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("sess-new", n1.id, "r99-orchestrator", "running", "checkpoint_only", "2026-03-23 02:00:00");

    const spec = exporter.exportRig(rig.id);
    const orch = spec.nodes.find((n) => n.id === "orchestrator")!;
    expect(orch.restorePolicy).toBe("checkpoint_only"); // 最新会话优先
  });

  it("无会话时，导出的 restorePolicy 回退到 node.restore_policy", () => {
    const rig = rigRepo.createRig("r98");
    rigRepo.addNode(rig.id, "worker", {
      runtime: "codex",
      restorePolicy: "relaunch_fresh",
    });

    const spec = exporter.exportRig(rig.id);
    expect(spec.nodes[0]!.restorePolicy).toBe("relaunch_fresh");
  });

  it("存在多个会话时导出 createdAt 最新者", () => {
    const { rig, n2 } = seedRig();
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s1", n2.id, "r99-worker", "exited", "checkpoint_only", "2026-03-23 01:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s2", n2.id, "r99-worker", "running", "relaunch_fresh", "2026-03-23 03:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s3", n2.id, "r99-worker", "idle", "resume_if_possible", "2026-03-23 02:00:00");

    const spec = exporter.exportRig(rig.id);
    const worker = spec.nodes.find((n) => n.id === "worker")!;
    expect(worker.restorePolicy).toBe("relaunch_fresh"); // s2 最新
  });

  it("同秒会话按标识（ULID）打破平局，保证结果确定", () => {
    const { rig, n1 } = seedRig();
    // 两个会话具有相同 createdAt，但标识和策略不同。
    // ULID "B..." 排在 "A..." 之后，因此 sess-b 为“最新”会话。
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("AAAA_sess_first", n1.id, "r99-orchestrator", "running", "relaunch_fresh", "2026-03-23 05:00:00");
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, restore_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("ZZZZ_sess_second", n1.id, "r99-orchestrator", "running", "checkpoint_only", "2026-03-23 05:00:00");

    const spec = exporter.exportRig(rig.id);
    const orch = spec.nodes.find((n) => n.id === "orchestrator")!;
    // ZZZZ 排在 AAAA 之后，因此 checkpoint_only 应胜出。
    expect(orch.restorePolicy).toBe("checkpoint_only");
  });

  it("导出不存在的工作组 -> 抛出 RigNotFoundError", () => {
    expect(() => exporter.exportRig("nonexistent")).toThrow(RigNotFoundError);
  });

  it("导出 runtime 为 null 的节点 -> 抛出明确错误", () => {
    const rig = rigRepo.createRig("r97");
    // 通过原始 SQL 插入没有 runtime 的节点，以绕过 addNode 默认值。
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)")
      .run("node-no-rt", rig.id, "broken-node");

    expect(() => exporter.exportRig(rig.id)).toThrow(/缺少必填 runtime/i);
  });

  it("导出 sourceId 未映射的边 -> 抛错", () => {
    const rig = rigRepo.createRig("r96");
    const n1 = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    // 临时禁用外键以插入损坏的边。
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)")
      .run("bad-edge", rig.id, "nonexistent-source", n1.id, "delegates_to");
    db.pragma("foreign_keys = ON");

    expect(() => exporter.exportRig(rig.id)).toThrow(/source node ID.*未映射/i);
  });

  it("导出 targetId 未映射的边 -> 抛错", () => {
    const rig = rigRepo.createRig("r95");
    const n1 = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)")
      .run("bad-edge", rig.id, n1.id, "nonexistent-target", "delegates_to");
    db.pragma("foreign_keys = ON");

    expect(() => exporter.exportRig(rig.id)).toThrow(/target node ID.*未映射/i);
  });

  it("往返：导出 -> 序列化 -> 解析 -> 校验全部通过", () => {
    const { rig } = seedRig();
    const spec = exporter.exportRig(rig.id);
    const yaml = RigSpecCodec.serialize(spec);
    const parsed = RigSpecCodec.parse(yaml);
    const result = RigSpecSchema.validate(parsed);
    expect(result.valid).toBe(true);
  });

  it("数据库 handle 不匹配时构造函数抛错", () => {
    const otherDb = setupDb();
    const otherRepo = new RigRepository(otherDb);

    expect(() => new RigSpecExporter({ rigRepo: otherRepo, sessionRegistry }))
      .toThrow(/RigSpecExporter：rigRepo 与 sessionRegistry 必须共享同一个数据库句柄/);

    otherDb.close();
  });
});

describe("RigSpecExporter（感知 pod）", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let podRepo: PodRepository;
  let exporter: RigSpecExporter;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    podRepo = new PodRepository(db);
    exporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo });
  });

  afterEach(() => { db.close(); });

  function seedPodRig() {
    const rig = rigRepo.createRig("pod-test");
    const devPod = podRepo.createPod(rig.id, "dev", "Dev", { summary: "dev pod" });
    const archPod = podRepo.createPod(rig.id, "arch", "Arch", { summary: "arch pod" });
    const n1 = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: devPod.id, agentRef: "local:agents/impl", profile: "tdd", cwd: "." });
    const n2 = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", podId: devPod.id, agentRef: "local:agents/qa", profile: "default", cwd: "." });
    const n3 = rigRepo.addNode(rig.id, "arch.reviewer", { runtime: "claude-code", podId: archPod.id, agentRef: "local:agents/reviewer", profile: "default", cwd: "." });
    rigRepo.addEdge(rig.id, n1.id, n2.id, "can_observe");
    rigRepo.addEdge(rig.id, n1.id, n3.id, "escalates_to");
    return { rig, devPod, archPod, n1, n2, n3 };
  }

  it("导出包含 pod、成员和边的 pod 感知工作组", () => {
    const { rig } = seedPodRig();
    const spec = exporter.exportRig(rig.id) as import("../src/domain/types.js").RigSpec;
    expect(spec.version).toBe("0.2");
    expect(spec.workspace).toBeUndefined();
    expect(spec.pods).toHaveLength(2);
    const devPod = spec.pods.find((p) => p.id === "dev")!;
    expect(devPod).toBeDefined();
    expect(devPod.members).toHaveLength(2);
    expect(devPod.members.map((m) => m.id).sort()).toEqual(["impl", "qa"]);
    expect(devPod.members[0]!.agentRef).toContain("agents/");
  });

  it("导出持久化的 workspace 声明", () => {
    const { rig } = seedPodRig();
    const workspace: import("../src/domain/types.js").WorkspaceSpec = {
      workspaceRoot: "/workspace",
      repos: [
        { name: "app", path: "/workspace/app", kind: "project" },
        { name: "docs", path: "/workspace/docs", kind: "knowledge" },
      ],
      defaultRepo: "app",
      knowledgeRoot: "/workspace/docs",
    };
    rigRepo.setRigWorkspace(rig.id, workspace);

    const spec = exporter.exportRig(rig.id) as import("../src/domain/types.js").RigSpec;
    expect(spec.workspace).toEqual(workspace);

    const parsed = PodRigSpecCodec.parse(PodRigSpecCodec.serialize(spec));
    expect(PodRigSpecSchema.validate(parsed).valid).toBe(true);
    expect(PodRigSpecSchema.normalize(parsed as Record<string, unknown>).workspace).toEqual(workspace);
  });

  it("pod 内部边使用成员局部标识", () => {
    const { rig } = seedPodRig();
    const spec = exporter.exportRig(rig.id) as import("../src/domain/types.js").RigSpec;
    const devPod = spec.pods.find((p) => p.id === "dev")!;
    expect(devPod.edges).toHaveLength(1);
    expect(devPod.edges[0]!.from).toBe("impl");
    expect(devPod.edges[0]!.to).toBe("qa");
  });

  it("跨 pod 边使用限定形式 podId.memberId", () => {
    const { rig } = seedPodRig();
    const spec = exporter.exportRig(rig.id) as import("../src/domain/types.js").RigSpec;
    expect(spec.edges).toHaveLength(1);
    expect(spec.edges[0]!.from).toBe("dev.impl");
    expect(spec.edges[0]!.to).toBe("arch.reviewer");
  });

  it("导出空 pod 时使用持久化的 pod namespace，而非 pod ULID", () => {
    const rig = rigRepo.createRig("empty-pod-test");
    const pod = podRepo.createPod(rig.id, "research", "Research", { summary: "empty pod" });

    const spec = exporter.exportRig(rig.id) as import("../src/domain/types.js").RigSpec;
    expect(spec.pods).toHaveLength(1);
    expect(spec.pods[0]!.id).toBe("research");
    expect(spec.pods[0]!.id).not.toBe(pod.id);
  });

  it("往返：导出 -> 序列化 -> 解析 -> 校验通过", () => {
    const { rig } = seedPodRig();
    const spec = exporter.exportRig(rig.id) as import("../src/domain/types.js").RigSpec;
    const yaml = PodRigSpecCodec.serialize(spec);
    const parsed = PodRigSpecCodec.parse(yaml);
    const result = PodRigSpecSchema.validate(parsed);
    expect(result.valid).toBe(true);
  });
});
