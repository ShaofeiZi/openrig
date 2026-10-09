import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { parseAgentSpec } from "../src/domain/agent-manifest.js";

const DEMO_ROOT = path.resolve(__dirname, "../../../demo");

describe("Demo fixture 验证", () => {
  // 测试 1：Demo rig.yaml 验证通过。
  it("demo rig.yaml 通过 RigSpecSchema 验证", () => {
    const yaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    const raw = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(raw);
    expect(validation.valid).toBe(true);
    if (!validation.valid) {
      console.error("验证错误：", validation.errors);
    }
  });

  // 测试 2：所有 demo agent spec 验证通过。
  it("所有 demo agent spec 都可解析并通过验证", () => {
    const agentDirs = fs.readdirSync(path.join(DEMO_ROOT, "agents"));
    expect(agentDirs.length).toBeGreaterThanOrEqual(6);

    for (const dir of agentDirs) {
      const specPath = path.join(DEMO_ROOT, "agents", dir, "agent.yaml");
      expect(fs.existsSync(specPath)).toBe(true);
      const yaml = fs.readFileSync(specPath, "utf-8");
      const result = parseAgentSpec(yaml);
      expect(result.name).toBe(dir);
    }
  });

  // 测试 3：Demo rig spec 具有正确 topology。
  it("demo rig 有 4 个 pod、共 8 个成员", () => {
    const yaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    const raw = RigSpecCodec.parse(yaml);
    const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
    expect(spec.pods).toHaveLength(4);
    const totalMembers = spec.pods.reduce((sum, pod) => sum + pod.members.length, 0);
    expect(totalMembers).toBe(8);
  });

  it("demo infra.ui startup 把 dev server 绑定到 127.0.0.1，供 rig ui open 使用", () => {
    const yaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    const raw = RigSpecCodec.parse(yaml);
    const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
    const infraPod = spec.pods.find((pod) => pod.id === "infra");
    const uiMember = infraPod?.members.find((member) => member.id === "ui");
    const startupAction = uiMember?.startup?.actions?.[0];

    expect(startupAction?.value).toBe("npm run dev -- --host 127.0.0.1");
  });

  // 测试 4：Demo rig-root 推断正确。
  it("从 rig.yaml 路径将 rig-root 推断为 demo/ 目录", () => {
    const rigYamlPath = path.join(DEMO_ROOT, "rig.yaml");
    const inferredRoot = path.dirname(rigYamlPath);
    expect(inferredRoot).toBe(DEMO_ROOT);
    // Agent ref 应从此 root 解析。
    expect(fs.existsSync(path.join(inferredRoot, "agents", "lead", "agent.yaml"))).toBe(true);
  });

  // 测试 5：Fixture 中没有绝对路径或路径遍历。
  it("demo fixture 不含绝对路径或路径遍历", () => {
    const rigYaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    expect(rigYaml).not.toMatch(/path:\s*\//); // No absolute paths
    expect(rigYaml).not.toContain("../"); // No path traversal

    const agentDirs = fs.readdirSync(path.join(DEMO_ROOT, "agents"));
    for (const dir of agentDirs) {
      const specYaml = fs.readFileSync(path.join(DEMO_ROOT, "agents", dir, "agent.yaml"), "utf-8");
      expect(specYaml).not.toMatch(/path:\s*\//);
      expect(specYaml).not.toContain("../");
    }
  });

  // 测试 6：Culture 文件存在。
  it("demo culture.md 存在", () => {
    expect(fs.existsSync(path.join(DEMO_ROOT, "culture.md"))).toBe(true);
  });

  // 测试 7：Demo rig preflight 解析所有 agent ref。
  it("demo rig preflight 解析所有 agent ref", async () => {
    const { rigPreflight } = await import("../src/domain/rigspec-preflight.js");
    const yaml = fs.readFileSync(path.join(DEMO_ROOT, "rig.yaml"), "utf-8");
    const fsOps = {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
    };
    const result = await rigPreflight({ rigSpecYaml: yaml, rigRoot: DEMO_ROOT, fsOps });
    const agentErrors = result.errors.filter((e: string) => e.includes("agent_ref 解析失败"));
    expect(agentErrors).toHaveLength(0);
    // 完整 preflight 应通过（测试环境可能有 runtime 警告；若唯一问题是 runtime 可用性，ready 应为 true）。
    const nonRuntimeErrors = result.errors.filter((e: string) => !e.includes("不支持运行时") && !e.includes("不可用"));
    expect(nonRuntimeErrors).toHaveLength(0);
    // Demo rig preflight 应通过：所有 agent spec 都存在，且 runtime 受支持。
    expect(result.ready).toBe(true);
  });

  // 测试 8：Demo teardown 留下干净状态（通过 RigTeardownOrchestrator mock）。
  it("demo rig teardown 清理 session 和 binding", async () => {
    const { createFullTestDb } = await import("./helpers/test-app.js");
    const { RigRepository } = await import("../src/domain/rig-repository.js");
    const { SessionRegistry } = await import("../src/domain/session-registry.js");
    const { EventBus } = await import("../src/domain/event-bus.js");
    const { SnapshotCapture } = await import("../src/domain/snapshot-capture.js");
    const { SnapshotRepository } = await import("../src/domain/snapshot-repository.js");
    const { CheckpointStore } = await import("../src/domain/checkpoint-store.js");
    const { RigTeardownOrchestrator } = await import("../src/domain/rig-teardown.js");

    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });

    // 创建带 session 的 rig（模拟 demo 状态）。
    const rig = rigRepo.createRig("demo-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "orch-lead@demo-rig");
    sessionRegistry.updateStatus(session.id, "running");

    const tmux = {
      killSession: async () => ({ ok: true as const }),
      createSession: async () => ({ ok: true as const }),
      listSessions: async () => [],
      hasSession: async () => false,
      sendText: async () => ({ ok: true as const }),
      sendKeys: async () => ({ ok: true as const }),
      listWindows: async () => [],
      listPanes: async () => [],
    } as any;

    const teardown = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, snapshotCapture, eventBus });
    const result = await teardown.teardown(rig.id);

    expect(result.sessionsKilled).toBe(1);
    expect(result.snapshotId).toBeTruthy(); // auto-pre-down snapshot created
    expect(result.errors).toHaveLength(0);

    // Session 应为 exited。
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    const latest = sessions[sessions.length - 1];
    expect(latest?.status).toBe("exited");

    db.close();
  });
});
