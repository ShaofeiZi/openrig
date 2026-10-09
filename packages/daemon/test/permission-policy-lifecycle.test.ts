import { mockShellCommand } from "./helpers/shell-command-mock.js";
// OPR.0.4.8.3 接缝 B——守卫修正后的生命周期固定测试（9e94c274 时为 NOT-CLEAR），RED 优先。
// 四项发现的生产高度证明：
//   F1：rig 级自定义来源在重启后完整保留（自然形成的 seat、使用不同操作根的结构化
//       add-member、后继连续性）。
//   F2：实体化时的来源写入承担关键语义（真实写入失败会导致操作失败，绝不静默部分提交）。
//   F3：恢复时自定义内容不可读，则使用已持久化的姿态，绝不静默回退到 floor。
//   F4：真实 RestoreOrchestrator 执行恢复（旧版 + pod 感知高度：resume 适配器收到姿态），
//       并固定三个 harness 上 floor/full_bypass 的真实适配器命令，包括 Codex 原生 fork 路径
//       （Pi 文案表示资源信任）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createFullTestDb, createTestApp, migrationsForFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { ClaudeResumeAdapter, ResumeResult } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { claudePostureFlag, codexPostureArg, piTrust } from "../src/adapters/yolo-mode.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";

const CUSTOM_POLICY = `---
policy_schema_version: 1
name: operator-full
source: custom
description: full-bypass 标志策略（Seam-A-complete fixture）
surface: flag
launch_posture: full_bypass
---
# 操作者完全权限
`;

const DECLARING_ROOT = "/project/rigs/original-root";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function fsOps(policyReadable = true) {
  return {
    readFile: (p: string) => {
      if (p.includes("agents/impl")) return agentYaml("impl");
      if (p.includes("policies/operator-full.md")) {
        if (!policyReadable) throw new Error("EACCES：不可读");
        return CUSTOM_POLICY;
      }
      throw new Error(`未找到：${p}`);
    },
    exists: (p: string) => p.includes("agents/impl") || (policyReadable && p.includes("policies/operator-full.md")),
  };
}

function rigLevelSpec(extraMembers: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    version: "0.2",
    name: "lifecycle-rig",
    permission_policy: "policies/operator-full.md", // RIG 级自定义 flag/full_bypass
    pods: [{
      id: "dev",
      label: "Dev",
      members: [
        { id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
        ...extraMembers,
      ],
      edges: [],
    }],
    edges: [],
  };
}

function mockTmux(): TmuxAdapter {
  return mockShellCommand({
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
  } as unknown as TmuxAdapter);
}

describe("F1——rig 级自定义来源在重启后完整保留", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seamb-f1-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("RED-1：自然形成的 seat（直接 addNode，无 member 引用）+ 重新打开数据库 + 真实旧版恢复会保留 full_bypass", async () => {
    const dbFile = join(dir, "d.sqlite");
    const db1 = createDb(dbFile);
    migrate(db1, migrationsForFullTestDb);
    const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
    const outcome = await setup1.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
    // 自然形成的 seat：claim/self-attach 结构——直接 addNode，无 member 规范，无节点来源
    const organic = setup1.rigRepo.addNode(rigId, "dev.organic", { runtime: "claude-code", cwd: "/w" });
    // 自然形成 seat 的可恢复会话（旧版恢复路径）
    const session = setup1.sessionRegistry.registerSession(organic.id, "dev-organic@lifecycle-rig");
    setup1.sessionRegistry.updateStatus(session.id, "running");
    db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-123' WHERE id = ?").run(session.id);
    const intendedNodeIds = setup1.rigRepo.getRig(rigId)!.nodes.map((node) => node.id);
    const snap = setup1.snapshotCapture.captureSnapshot(rigId, "manual", { intendedNodeIds });
    db1.close(); // ── 重启边界 ──

    const db2 = createDb(dbFile);
    const rigRepo2 = new RigRepository(db2);
    const sessionRegistry2 = new SessionRegistry(db2);
    const eventBus2 = new EventBus(db2);
    const snapshotRepo2 = new SnapshotRepository(db2);
    const checkpointStore2 = new CheckpointStore(db2);
    const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
    const tmux = mockTmux();
    const claudeResume = {
      canResume: vi.fn((t: string | null) => t === "claude_id" || t === "claude_name"),
      resume: vi.fn(async (): Promise<ResumeResult> => ({
        ok: true,
        appliedLaunch: observeClaudePermission("--dangerously-skip-permissions"),
      })),
    } as unknown as ClaudeResumeAdapter;
    const orch = new RestoreOrchestrator({
      db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
      snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
      nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
      tmuxAdapter: tmux,
      claudeResume,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    const snapId = snap.id;
    // 恢复时策略文件可读：从原始声明根目录提供
    await orch.restore(snapId);
    // 生产高度断言：resume 适配器收到了从 rig 继承的姿态
    const call = (claudeResume.resume as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[2] === "tok-123");
    expect(call, "应已尝试恢复自然形成的 seat").toBeDefined();
    expect(call![4]).toBe("full_bypass"); // 第 5 个参数 = 来自 RIG 来源的 resolvedPosture
    expect(new AppliedLaunchObservationStore(db2).readCurrent(organic.id)).toMatchObject({
      runtime: "claude-code",
      axis: "permission",
      state: "observed",
      value: "bypassPermissions",
    });
    db2.close();
  });

  it("RED-2：结构化 add-member 继承原始 rig 附件（原始声明根），member 覆盖值仍优先", async () => {
    const db = createFullTestDb();
    const reads: string[] = [];
    const ops = fsOps();
    const spyOps = {
      readFile: (p: string) => { reads.push(p); return ops.readFile(p); },
      exists: ops.exists,
    };
    const setup = createTestApp(db, { podInstantiatorFsOps: spyOps });
    const outcome = await setup.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;

    // 通过结构化路径执行 add_member，并使用不同的操作根目录
    const OTHER_ROOT = "/somewhere/else/entirely";
    const addOutcome = await setup.podInstantiator.addMemberToPod(
      rigId, "dev",
      { id: "late", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "." },
      OTHER_ROOT,
    );
    expect(addOutcome.ok).toBe(true);
    const lateNode = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.late'").get() as { id: string } | undefined);
    expect(lateNode, "dev.late 节点应存在").toBeDefined();
    const prov = setup.rigRepo.getNodePolicyProvenance(lateNode!.id);
    // 继承的 rig 附件必须基于原始声明根目录解析——绝不能使用 add-member 操作的不相关根目录。
    expect(prov).toMatchObject({
      origin: "custom",
      launchPosture: "full_bypass",
      declaringDir: DECLARING_ROOT,
      resolvedTarget: `${DECLARING_ROOT}/policies/operator-full.md`,
    });
    // member 覆盖值仍然优先
    const addOverride = await setup.podInstantiator.addMemberToPod(
      rigId, "dev",
      { id: "locked1", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: ".", permission_policy: "builtin:locked" },
      OTHER_ROOT,
    );
    expect(addOverride.ok).toBe(true);
    const lockedNode = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.locked1'").get() as { id: string } | undefined);
    expect(lockedNode, "dev.locked1 节点应存在").toBeDefined();
    expect(setup.rigRepo.getNodePolicyProvenance(lockedNode!.id)).toMatchObject({ origin: "builtin", launchPosture: "floor" });
    db.close();
  });

  it("RED-3：继承 rig 附件的后继连续性会保留姿态（自然形成的 seat，无节点来源）", async () => {
    const db = createFullTestDb();
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
    const outcome = await setup.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
    const organic = setup.rigRepo.addNode(rigId, "dev.organic2", { runtime: "claude-code", cwd: "/w" });
    // 与 seat-handover 后继路径执行相同的读取：
    const nodeProv = setup.rigRepo.getNodePolicyProvenance(organic.id);
    const rigProv = setup.rigRepo.getRigPolicyProvenance(rigId);
    const successorPosture = nodeProv?.launchPosture ?? rigProv?.launchPosture;
    expect(successorPosture).toBe("full_bypass"); // 继承的 rig 策略会传递给后继
    db.close();
  });
});

describe("F2——实体化时的来源写入承担关键语义", () => {
  it("RED：真实来源写入失败会导致实体化失败（不静默部分提交）", async () => {
    const db = createFullTestDb();
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
    // 注入真实写入失败（而非缺少旧版列）：迁移后破坏 UPDATE，模拟严重 SQLite 故障。
    const original = setup.rigRepo.setNodePolicyProvenance.bind(setup.rigRepo);
    void original;
    vi.spyOn(setup.rigRepo, "setNodePolicyProvenance").mockImplementation(() => {
      throw new Error("SQLITE_IOERR：磁盘 I/O 错误（已注入）");
    });
    const outcome = await setup.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
    expect(outcome.ok).toBe(false); // 不得报告成功
    // 且不得提交部分节点状态
    const count = (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });
});

describe("F3——恢复时自定义内容不可读，则使用已持久化姿态", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seamb-f3-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("RED：重新打开数据库 + 已持久化 full_bypass + 自定义文件不可读 → 以 full_bypass 启动恢复", async () => {
    const dbFile = join(dir, "d.sqlite");
    const db1 = createDb(dbFile);
    migrate(db1, migrationsForFullTestDb);
    const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
    // 自然形成的 seat（旧版恢复路径）在附着时持久化了节点来源——resolvedTarget 路径在此
    // 真实文件系统中不存在，即恢复时不可读。
    const rig = setup1.rigRepo.createRig("f3-rig");
    const rigId = rig.id;
    const implNode = setup1.rigRepo.addNode(rigId, "dev.impl", { runtime: "claude-code", cwd: "/w" });
    setup1.rigRepo.setNodePolicyProvenance(implNode.id, {
      origin: "custom",
      resolvedTarget: `${DECLARING_ROOT}/policies/operator-full.md`,
      declaringDir: DECLARING_ROOT,
      launchPosture: "full_bypass",
    });
    db1.prepare("UPDATE nodes SET permission_policy = 'policies/operator-full.md' WHERE id = ?").run(implNode.id);
    const session = setup1.sessionRegistry.registerSession(implNode.id, "dev-impl@f3-rig");
    setup1.sessionRegistry.updateStatus(session.id, "running");
    db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-f3' WHERE id = ?").run(session.id);
    const snap = setup1.snapshotCapture.captureSnapshot(rigId, "manual");
    db1.close(); // ── 重启；持久化的目标路径在此真实文件系统中不可读 ──

    const db2 = createDb(dbFile);
    const rigRepo2 = new RigRepository(db2);
    const sessionRegistry2 = new SessionRegistry(db2);
    const eventBus2 = new EventBus(db2);
    const snapshotRepo2 = new SnapshotRepository(db2);
    const checkpointStore2 = new CheckpointStore(db2);
    const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
    const tmux = mockTmux();
    const claudeResume = {
      canResume: vi.fn((t: string | null) => t === "claude_id" || t === "claude_name"),
      resume: vi.fn(async (): Promise<ResumeResult> => ({ ok: true })),
    } as unknown as ClaudeResumeAdapter;
    const orch = new RestoreOrchestrator({
      db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
      snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
      nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
      tmuxAdapter: tmux,
      claudeResume,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    const snapId = snap.id;
    await orch.restore(snapId);
    const call = (claudeResume.resume as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[2] === "tok-f3");
    expect(call, "应已尝试恢复 impl seat").toBeDefined();
    // /project/rigs/original-root/... 在此文件系统中不存在 → 不可读。
    // 必须沿用已持久化姿态——绝不静默回退到 floor。
    expect(call![4]).toBe("full_bypass");
    db2.close();
  });
});

describe("F4——真实适配器命令固定点（每条启动路径上的 floor + full_bypass）", () => {
  function claudeMockFs(): ClaudeAdapterFsOps {
    const store: Record<string, string> = {};
    return {
      readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`未找到：${p}`); },
      writeFile: (p: string, c: string) => { store[p] = c; },
      exists: (p: string) => p in store,
      mkdirp: () => {},
      copyFile: () => {},
      listFiles: () => [],
    } as ClaudeAdapterFsOps;
  }
  function binding(posture?: "floor" | "full_bypass"): NodeBinding {
    return { id: "b1", nodeId: "n1", tmuxSession: "s1", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", ...(posture ? { launchPosture: posture } : {}) } as NodeBinding;
  }

  it("Claude FRESH：binding full_bypass 发出 bypass 标志；即使环境为 YOLO，binding floor 仍固定 acceptEdits", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      for (const [posture, expected] of [["full_bypass", "--dangerously-skip-permissions"], ["floor", "--permission-mode acceptEdits"]] as const) {
        const tmux = mockTmux();
        const adapter = new ClaudeCodeAdapter({ tmux, fsOps: claudeMockFs(), sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" });
        const result = await adapter.launchHarness(binding(posture), { name: "dev-impl@test-rig" });
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain(expected);
        expect(result.ok && result.appliedLaunch).toMatchObject({
          runtime: "claude-code",
          axis: "permission",
          state: "observed",
          value: posture === "floor" ? "acceptEdits" : "bypassPermissions",
        });
        if (posture === "floor") expect(cmd).not.toContain("--dangerously-skip-permissions");
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("Codex FRESH + NATIVE-FORK：binding 姿态决定 -s danger-full-access 或 workspace-write 下限", { timeout: 30000 }, async () => {
    const codexFs = { readFile: () => { throw new Error("nf"); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [] };
    // fresh
    for (const [posture, expected, absent] of [["full_bypass", " -s danger-full-access", ""], ["floor", " -s workspace-write", "danger-full-access"]] as const) {
      const tmux = mockTmux();
      const result = await new CodexRuntimeAdapter({ sleep: async () => {}, tmux, fsOps: codexFs as never }).launchHarness(binding(posture), { name: "dev-qa@test-rig" });
      const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
      expect(cmd).toContain(expected);
      expect(result.ok && result.appliedLaunch).toMatchObject({ axis: "sandbox", state: "observed", value: posture === "floor" ? "workspace-write" : "danger-full-access" });
      if (absent) expect(cmd).not.toContain(absent);
    }
    // 原生 fork（切片 02 辅助函数仍是唯一的标志转换器）
    for (const [posture, expected] of [["full_bypass", " -s danger-full-access"], ["floor", " -s workspace-write"]] as const) {
      const tmux = mockTmux();
      const result = await new CodexRuntimeAdapter({ sleep: async () => {}, tmux, fsOps: codexFs as never }).launchHarness(binding(posture), { name: "dev-qa@test-rig", forkSource: { kind: "native_id", value: "parent-thread-1" } as never });
      const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
      expect(cmd).toContain("fork");
      expect(cmd).toContain(expected);
      if (result.ok) expect(result.appliedLaunch).toMatchObject({ axis: "sandbox", value: posture === "floor" ? "workspace-write" : "danger-full-access" });
    }
  });

  it("Claude RESUME：传递的姿态决定 resume 命令（环境为 YOLO 时 floor 仍固定 acceptEdits）", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      const { ClaudeResumeAdapter: RealClaudeResume } = await import("../src/adapters/claude-resume.js");
      for (const [posture, expected] of [["full_bypass", "--dangerously-skip-permissions"], ["floor", "--permission-mode acceptEdits"]] as const) {
        const tmux = mockTmux();
        const adapter = new RealClaudeResume(tmux);
        const result = await adapter.resume("s1", "claude_id", "tok-1", "/w", posture);
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain("claude");
        expect(cmd).toContain("--resume");
        expect(cmd).toContain(expected);
        expect(result.ok && result.appliedLaunch).toMatchObject({ axis: "permission", value: posture === "floor" ? "acceptEdits" : "bypassPermissions" });
      }
    } finally { vi.unstubAllEnvs(); }
  });
});

// ── Guard 第 2 轮（8232199a 时为 NOT-CLEAR）──────────────────────────────────

const MALFORMED_POLICY = "---\nname: broken\nsurface: flag\nlaunch_posture: full_bypass\n# 未闭合的 frontmatter——没有结束围栏\n# 正文如下\n";
const UNUSABLE_FLAG_POLICY = `---\npolicy_schema_version: 1\nname: no-posture\nsource: custom\ndescription: 缺少 launch_posture 的标志策略（Seam-A 无效标志契约）\nsurface: flag\n---\n正文\n`;

describe("GF1——可读但格式错误/不可用的自定义内容使用已持久化姿态", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seamb-gf1-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function reopenedRestorePosture(kind: "node" | "rig", policyBody: string): Promise<unknown> {
    const { writeFileSync: wf, mkdirSync: mk } = await import("node:fs");
    const declRoot = join(dir, "declaring-root");
    mk(join(declRoot, "policies"), { recursive: true });
    wf(join(declRoot, "policies", "operator-full.md"), policyBody); // 在真实文件系统上可读
    const dbFile = join(dir, `${kind}.sqlite`);
    const db1 = createDb(dbFile);
    migrate(db1, migrationsForFullTestDb);
    const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
    const rig = setup1.rigRepo.createRig(`gf1-${kind}`);
    const node = setup1.rigRepo.addNode(rig.id, "dev.seat", { runtime: "claude-code", cwd: "/w" });
    if (kind === "node") {
      setup1.rigRepo.setNodePolicyProvenance(node.id, {
        origin: "custom", resolvedTarget: join(declRoot, "policies", "operator-full.md"),
        declaringDir: declRoot, launchPosture: "full_bypass",
      });
      db1.prepare("UPDATE nodes SET permission_policy = 'policies/operator-full.md' WHERE id = ?").run(node.id);
    } else {
      setup1.rigRepo.setRigPermissionPolicy(rig.id, "policies/operator-full.md");
      setup1.rigRepo.setRigPolicyProvenance(rig.id, {
        origin: "custom", resolvedTarget: join(declRoot, "policies", "operator-full.md"),
        declaringDir: declRoot, launchPosture: "full_bypass",
      });
    }
    const session = setup1.sessionRegistry.registerSession(node.id, `dev-seat@gf1-${kind}`);
    setup1.sessionRegistry.updateStatus(session.id, "running");
    db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-gf1' WHERE id = ?").run(session.id);
    const snap = setup1.snapshotCapture.captureSnapshot(rig.id, "manual");
    db1.close();

    const db2 = createDb(dbFile);
    const rigRepo2 = new RigRepository(db2);
    const sessionRegistry2 = new SessionRegistry(db2);
    const eventBus2 = new EventBus(db2);
    const snapshotRepo2 = new SnapshotRepository(db2);
    const checkpointStore2 = new CheckpointStore(db2);
    const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
    const tmux = mockTmux();
    const claudeResume = {
      canResume: vi.fn((t: string | null) => t === "claude_id"),
      resume: vi.fn(async (): Promise<ResumeResult> => ({ ok: true })),
    } as unknown as ClaudeResumeAdapter;
    const orch = new RestoreOrchestrator({
      db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
      snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
      nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
      tmuxAdapter: tmux,
      claudeResume,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    await orch.restore(snap.id);
    db2.close();
    const call = (claudeResume.resume as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[2] === "tok-gf1");
    expect(call, "应已尝试恢复 seat").toBeDefined();
    return call![4];
  }

  it("RED：NODE 来源 + 可读但格式错误的 frontmatter → 已持久化 full_bypass（绝不静默回退到 floor）", async () => {
    expect(await reopenedRestorePosture("node", MALFORMED_POLICY)).toBe("full_bypass");
  });

  it("RED：NODE 来源 + 可读但不可用的标志契约（缺少 launch_posture）→ 已持久化 full_bypass", async () => {
    expect(await reopenedRestorePosture("node", UNUSABLE_FLAG_POLICY)).toBe("full_bypass");
  });

  it("RED：继承的 RIG 来源 + 可读但格式错误的 frontmatter → 已持久化 full_bypass", async () => {
    expect(await reopenedRestorePosture("rig", MALFORMED_POLICY)).toBe("full_bypass");
  });

  it("有效可读内容仍会重新派生（裁定要求的重新校验保持生效）", async () => {
    expect(await reopenedRestorePosture("node", CUSTOM_POLICY)).toBe("full_bypass");
  });
});

describe("GF2——完整的生产高度启动/恢复矩阵", () => {
  function binding2(posture?: "floor" | "full_bypass"): NodeBinding {
    return { id: "b1", nodeId: "n1", tmuxSession: "s1", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project", ...(posture ? { launchPosture: posture } : {}) } as NodeBinding;
  }

  it("支持 POD 的恢复：重建 binding 的姿态到达真实适配器的 harness 命令", { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "seamb-podaware-"));
    try {
      const dbFile = join(dir, "d.sqlite");
      const db1 = createDb(dbFile);
      migrate(db1, migrationsForFullTestDb);
      const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
      const outcome = await setup1.podInstantiator.materializeStructured(rigLevelSpec(), DECLARING_ROOT);
      expect(outcome.ok).toBe(true);
      const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
      const implNode = db1.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string };
      // 支持 pod = 快照携带有 podId 的节点；实体化 member 拥有该值
      const session = setup1.sessionRegistry.registerSession(implNode.id, "dev-impl@lifecycle-rig");
      setup1.sessionRegistry.updateStatus(session.id, "running");
      db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-pod' WHERE id = ?").run(session.id);
      const snap = setup1.snapshotCapture.captureSnapshot(rigId, "manual");
      // 支持 pod 的启动重放需要 nodeStartupContext（在原始启动时捕获；
      // 此处按已发布恢复测试的相同方式植入）
      {
        const row = db1.prepare("SELECT data FROM snapshots WHERE id = ?").get(snap.id) as { data: string };
        const data = JSON.parse(row.data);
        data.nodeStartupContext = data.nodeStartupContext ?? {};
        data.nodeStartupContext[implNode.id] = { projectionEntries: [], resolvedStartupFiles: [], startupActions: [], runtime: "claude-code" };
        db1.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);
      }
      db1.close();

      const db2 = createDb(dbFile);
      const rigRepo2 = new RigRepository(db2);
      const sessionRegistry2 = new SessionRegistry(db2);
      const eventBus2 = new EventBus(db2);
      const snapshotRepo2 = new SnapshotRepository(db2);
      const checkpointStore2 = new CheckpointStore(db2);
      const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
      const tmux = mockTmux();
      const realClaude = new ClaudeCodeAdapter({ sleep: async () => {}, tmux, fsOps: (function () {
        const store: Record<string, string> = {};
        return { readFile: (p: string) => { if (p in store) return store[p]!; throw new Error("nf"); }, writeFile: (p: string, c: string) => { store[p] = c; }, exists: (p: string) => p in store, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [] } as ClaudeAdapterFsOps;
      })(), sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" });
      const orch = new RestoreOrchestrator({
        db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
        snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
        nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
        tmuxAdapter: tmux,
        claudeResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter,
        codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
      });
      await orch.restore(snap.id, { adapters: { "claude-code": realClaude } } as never);
      const cmds = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1]));
      const launchCmd = cmds.find((c) => c.includes("claude"));
      expect(launchCmd, `预期下列命令中包含 claude harness 启动：${cmds.join(" | ")}`).toBeDefined();
      // rig 级自定义 flag/full_bypass 来源 → harness 命令携带 bypass
      expect(launchCmd!).toContain("--dangerously-skip-permissions");
      db2.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("Codex RESUME 命令：full_bypass 强制 danger-full-access；环境为 YOLO 时 floor 保持 workspace-write", { timeout: 30000 }, async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      const { CodexResumeAdapter: RealCodexResume } = await import("../src/adapters/codex-resume.js");
      for (const [posture, expected, absent] of [["full_bypass", " -s danger-full-access", ""], ["floor", " -s workspace-write", "danger-full-access"]] as const) {
        const tmux = mockTmux();
        const adapter = new RealCodexResume(tmux, { sleep: async () => {} });
        (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("codex");
        (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("OpenAI Codex (v0.0.0)\n› Ask Codex to do anything");
        const result = await adapter.resume("s1", "codex_id", "thread-1", "/w", null, posture);
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain("codex");
        expect(cmd).toContain("resume");
        expect(cmd).toContain(expected);
        expect(result.ok && result.appliedLaunch).toMatchObject({ axis: "sandbox", value: posture === "floor" ? "workspace-write" : "danger-full-access" });
        if (absent) expect(cmd).not.toContain(absent);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("Pi FRESH + RESUME：姿态决定资源信任（approve 或 no-approve），环境为 YOLO 时保持 floor", { timeout: 30000 }, async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      const { PiRuntimeAdapter } = await import("../src/adapters/pi-runtime-adapter.js");
      const { PiResumeAdapter } = await import("../src/adapters/pi-resume.js");
      const piFs = { readFile: () => "{}", writeFile: () => {}, exists: () => true, mkdirp: () => {}, listFiles: () => [] };
      for (const [posture, expectedTrust] of [["full_bypass", "approve"], ["floor", "no-approve"]] as const) {
        const tmux = mockTmux();
        const adapter = new PiRuntimeAdapter({ tmux, fsOps: piFs as never, stateRoot: "/tmp/pi-state", runnerEntryPath: "/tmp/pi-runner.js", sleep: async () => {} });
        await adapter.launchHarness(binding2(posture), { name: "dev-pi@test-rig" });
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        // 资源信任语义：Pi 的 --approve/--no-approve 控制资源信任，而非权限
        if (expectedTrust === "approve") { expect(cmd).toMatch(/--approve/); expect(cmd).not.toMatch(/--no-approve/); }
        else expect(cmd).toContain("--no-approve");
      }
      for (const [posture, expectedTrust] of [["full_bypass", "approve"], ["floor", "no-approve"]] as const) {
        const tmux = mockTmux();
        const adapter = new PiResumeAdapter(tmux, piFs as never, { stateRoot: "/tmp/pi-state", runnerEntryPath: "/tmp/pi-runner.js" }, { sleep: async () => {} });
        await adapter.resume("s1", "pi_session_file", "/tmp/pi-state/session.json", "/w", null, posture);
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        if (expectedTrust === "approve") { expect(cmd).toMatch(/--approve/); expect(cmd).not.toMatch(/--no-approve/); }
        else expect(cmd).toContain("--no-approve");
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("Claude NATIVE-FORK 命令：姿态同样决定 fork 路径上的标志（环境为 YOLO 时保持 floor）", { timeout: 30000 }, async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      for (const [posture, expected] of [["full_bypass", "--dangerously-skip-permissions"], ["floor", "--permission-mode acceptEdits"]] as const) {
        const tmux = mockTmux();
        const store: Record<string, string> = {};
        const adapter = new ClaudeCodeAdapter({ sleep: async () => {}, tmux, fsOps: { readFile: (p: string) => { if (p in store) return store[p]!; throw new Error("nf"); }, writeFile: (p: string, c: string) => { store[p] = c; }, exists: (p: string) => p in store, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [] } as ClaudeAdapterFsOps, sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" });
        await adapter.launchHarness(binding2(posture), { name: "dev-impl@test-rig", forkSource: { kind: "native_id", value: "parent-session-1" } as never });
        const cmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
        expect(cmd).toContain("claude");
        expect(cmd).toContain(expected);
        if (posture === "floor") expect(cmd).not.toContain("--dangerously-skip-permissions");
      }
    } finally { vi.unstubAllEnvs(); }
  });
});

// ── 954d97a0 的 R2 终局：真正缺失 = 锁定的最小下限 ─────────────────────────────
// README v4（缺失为 "floor-only"；创始人修订“未附加时默认 = 最小下限，仅此而已”）+
// FINAL2：姿态在 fresh/resume/fork 中显式绑定；环境中的 OPENRIG_YOLO 不得扩大无附件 seat
// 的权限。缺失仍如实呈现（不伪造附件，不生成来源行）——只有生命周期绑定携带显式 floor。

describe("缺失 = 每个生命周期界面上的锁定 floor（954d97a0 的 R2 HIGH）", () => {
  const captureAdapter = (bindings: NodeBinding[]): RuntimeAdapter => ({
    runtime: "claude-code",
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: 0, failed: [] }),
    launchHarness: async (binding: NodeBinding) => { bindings.push(binding); return { ok: true }; },
    checkReady: async () => ({ ready: true }),
  } as unknown as RuntimeAdapter);

  it("RED：无附件的 fresh 结构化启动会绑定显式 floor（绝非 undefined），即使环境为 YOLO", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      const bindings: NodeBinding[] = [];
      const db = createFullTestDb();
      const setup = createTestApp(db, {
        adapters: { "claude-code": captureAdapter(bindings) },
        podInstantiatorFsOps: fsOps(),
      });
      const bare = { version: "0.2", name: "bare-rig", pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }], edges: [] };
      const outcome = await setup.podInstantiator.materializeStructured(bare, "/rig");
      expect(outcome.ok).toBe(true);
      const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;
      const added = await setup.podInstantiator.addMemberToPod(rigId, "dev", { id: "late", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "." }, "/rig");
      expect(added.ok).toBe(true);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.launchPosture).toBe("floor"); // 显式值，而非 undefined
      // 保持如实呈现：不会为缺失的附件伪造来源
      const lateId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.late'").get() as { id: string }).id;
      expect(setup.rigRepo.getNodePolicyProvenance(lateId)).toBeNull();
      db.close();
    } finally { vi.unstubAllEnvs(); }
  });

  it("RED：任何位置都无来源时，恢复会向 resume 适配器返回显式 floor，即使环境为 YOLO", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    const dir = mkdtempSync(join(tmpdir(), "seamb-absent-"));
    try {
      const dbFile = join(dir, "d.sqlite");
      const db1 = createDb(dbFile);
      migrate(db1, migrationsForFullTestDb);
      const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
      const rig = setup1.rigRepo.createRig("absent-rig");
      const node = setup1.rigRepo.addNode(rig.id, "dev.bare", { runtime: "claude-code", cwd: "/w" });
      const session = setup1.sessionRegistry.registerSession(node.id, "dev-bare@absent-rig");
      setup1.sessionRegistry.updateStatus(session.id, "running");
      db1.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-abs' WHERE id = ?").run(session.id);
      const snap = setup1.snapshotCapture.captureSnapshot(rig.id, "manual");
      db1.close();

      const db2 = createDb(dbFile);
      const rigRepo2 = new RigRepository(db2);
      const sessionRegistry2 = new SessionRegistry(db2);
      const eventBus2 = new EventBus(db2);
      const snapshotRepo2 = new SnapshotRepository(db2);
      const checkpointStore2 = new CheckpointStore(db2);
      const snapshotCapture2 = new SnapshotCapture({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 });
      const tmux = mockTmux();
      const claudeResume = {
        canResume: vi.fn((t: string | null) => t === "claude_id"),
        resume: vi.fn(async (): Promise<ResumeResult> => ({ ok: true })),
      } as unknown as ClaudeResumeAdapter;
      const orch = new RestoreOrchestrator({
        db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2,
        snapshotRepo: snapshotRepo2, snapshotCapture: snapshotCapture2, checkpointStore: checkpointStore2,
        nodeLauncher: new NodeLauncher({ db: db2, rigRepo: rigRepo2, sessionRegistry: sessionRegistry2, eventBus: eventBus2, tmuxAdapter: tmux }),
        tmuxAdapter: tmux,
        claudeResume,
        codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
      });
      await orch.restore(snap.id);
      const call = (claudeResume.resume as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[2] === "tok-abs");
      expect(call, "应已尝试恢复裸 seat").toBeDefined();
      expect(call![4]).toBe("floor"); // 显式 floor——环境中的 YOLO 不得扩大权限
      db2.close();
    } finally { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); }
  });

  //（后继缺失固定点位于 seat-handover-service.test.ts 的生产高度——仅辅助函数的变体已根据
  // c203812f 的 Guard 移除：它重新计算回退链，而没有驱动 SeatHandoverService。）

  it("环境为 YOLO 时适配器一致：附件缺失的生命周期 binding（显式 floor）在三类适配器上均发出 FLOOR 命令", async () => {
    vi.stubEnv("OPENRIG_YOLO", "1");
    try {
      expect(claudePostureFlag(process.env, "floor")).toBe("--permission-mode acceptEdits");
      expect(codexPostureArg("", process.env, "floor")).toBe(" -s workspace-write");
      expect(piTrust(undefined, process.env, "floor")).toBe("no-approve"); // 资源信任
    } finally { vi.unstubAllEnvs(); }
  });
});
