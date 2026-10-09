import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsForFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { claudeConflictTargetPath } from "../src/domain/projection-planner.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #25——工作组可将 Claude Code 的 OpenRig 受管块发送到 CLAUDE.local.md，
// 而不是通常被 Git 跟踪的 CLAUDE.md。这些测试驱动真实的实例化、恢复、扩容和拆除路径，
// 并由真实 Claude adapter 写入临时工作目录。

const BEGIN = "<!-- BEGIN OpenRig MANAGED BLOCK:";
const LOCAL = "managed_blocks:\n  claude-code: CLAUDE.local.md";
// 一个已跟踪的 CLAUDE.md，其中已有先前默认目标运行写入的块。
const OLD_BLOCKS_CLAUDE_MD = [
  "# Project rules",
  "",
  "Keep this file short.",
  "",
  "<!-- BEGIN OpenRig MANAGED BLOCK: openrig-start.md -->",
  "old managed text",
  "<!-- END OpenRig MANAGED BLOCK: openrig-start.md -->",
  "",
].join("\n");

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n>"),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter;
}

function realFs(home: string): ClaudeAdapterFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (s, d) => fs.copyFileSync(s, d),
    listFiles: (dir) => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : []),
    homedir: home,
  };
}

function noopAdapter(runtime: string): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function rigYaml(managedBlocksYaml: string, cwd: string, name = "issue25-rig"): string {
  return [
    `version: "0.2"`,
    `name: ${name}`,
    managedBlocksYaml,
    `pods:`,
    `  - id: dev`,
    `    label: Dev`,
    `    members:`,
    `      - id: impl`,
    `        agent_ref: "local:agents/impl"`,
    `        profile: default`,
    `        runtime: claude-code`,
    `        cwd: "${cwd}"`,
    `    edges: []`,
    `edges: []`,
  ].filter(Boolean).join("\n") + "\n";
}

function fixture(managedBlocksYaml: string, opts?: { claudeMd?: string; claudeLocalMd?: string }) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-issue25-"));
  tmpDirs.push(root);
  const rigRoot = nodePath.join(root, "rig");
  const cwd = nodePath.join(root, "repo");
  const home = nodePath.join(root, "home");
  const dbFile = nodePath.join(root, "openrig.sqlite");
  fs.mkdirSync(nodePath.join(rigRoot, "agents", "impl"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
  if (opts?.claudeMd !== undefined) fs.writeFileSync(nodePath.join(cwd, "CLAUDE.md"), opts.claudeMd);
  if (opts?.claudeLocalMd !== undefined) fs.writeFileSync(nodePath.join(cwd, "CLAUDE.local.md"), opts.claudeLocalMd);

  const db = createDb(dbFile);
  migrate(db, migrationsForFullTestDb);
  const services = wire(db, home);
  const read = (name: string, dir = cwd) => {
    const p = nodePath.join(dir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
  };
  return { ...services, db, dbFile, root, rigRoot, cwd, home, yaml: rigYaml(managedBlocksYaml, cwd), read };
}

function wire(db: ReturnType<typeof createDb>, home: string) {
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const claude = new ClaudeCodeAdapter({ tmux, fsOps: realFs(home), sleep: async () => {} });
  const resolverFs: AgentResolverFsOps = {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
  };
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: resolverFs, tmuxAdapter: tmux,
    adapters: { "claude-code": claude, codex: noopAdapter("codex"), terminal: noopAdapter("terminal") },
  } as never);
  return { rigRepo, podRepo, sessionRegistry, eventBus, tmux, nodeLauncher, startupOrchestrator, claude, inst };
}

async function launched(f: ReturnType<typeof fixture>): Promise<string> {
  const result = await f.inst.instantiate(f.yaml, f.rigRoot);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as { ok: true; result: { rigId: string } }).result.rigId;
}

describe("#25 使用流程——rig YAML 选择 Claude 受管块目标文件", () => {
  it("managed_blocks: { claude-code: CLAUDE.local.md } 将块写入 CLAUDE.local.md，且绝不触碰 CLAUDE.md", async () => {
    const tracked = "# Project rules\n\nKeep this file short.\n";
    const f = fixture(LOCAL, { claudeMd: tracked });
    await launched(f);
    expect(f.read("CLAUDE.local.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.md")).toBe(tracked);
    f.db.close();
  });

  it("缺少 managed_blocks 时保留当前默认目标 CLAUDE.md", async () => {
    const f = fixture("");
    await launched(f);
    expect(f.read("CLAUDE.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.local.md")).toBeNull();
    f.db.close();
  });

  it("managed_blocks: { claude-code: CLAUDE.md } 是显式默认值", async () => {
    const f = fixture("managed_blocks:\n  claude-code: CLAUDE.md");
    await launched(f);
    expect(f.read("CLAUDE.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.local.md")).toBeNull();
    f.db.close();
  });
});

describe("#25 schema——接受合法 key 和值，并在启动前拒绝非法值", () => {
  const base = (managedBlocks: unknown) => ({
    version: "0.2", name: "r",
    ...(managedBlocks === undefined ? {} : { managed_blocks: managedBlocks }),
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
    edges: [],
  });

  it("接受两个受支持目标以及缺省配置", () => {
    expect(RigSpecSchema.validate(base(undefined)).errors).toEqual([]);
    expect(RigSpecSchema.validate(base({ "claude-code": "CLAUDE.md" })).errors).toEqual([]);
    expect(RigSpecSchema.validate(base({ "claude-code": "CLAUDE.local.md" })).errors).toEqual([]);
    expect(RigSpecSchema.validate(base({})).errors).toEqual([]);
  });

  it("拒绝不支持的值，并点名两个受支持文件", () => {
    for (const bad of ["AGENTS.md", "docs/CLAUDE.md", "../CLAUDE.local.md", "", 7, null]) {
      const errors = RigSpecSchema.validate(base({ "claude-code": bad })).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("managed_blocks.claude-code：必须是 CLAUDE.md, CLAUDE.local.md 之一");
    }
  });

  it("拒绝其他 runtime key，并指出受支持的 key（Codex 仍使用 AGENTS.md）", () => {
    for (const key of ["codex", "pi", "terminal", "claude"]) {
      const errors = RigSpecSchema.validate(base({ [key]: "CLAUDE.local.md" })).errors;
      expect(errors).toEqual([`managed_blocks.${key}：不支持运行时 "${key}"；仅可配置 "claude-code"`]);
    }
  });

  it("拒绝非映射值", () => {
    for (const bad of ["CLAUDE.local.md", ["CLAUDE.local.md"], null]) {
      expect(RigSpecSchema.validate(base(bad)).errors).toEqual(["managed_blocks：必须是映射，例如 { claude-code: CLAUDE.local.md }"]);
    }
  });

  it("无效值会在实例化阶段、任何席位启动或文件写入前被拒绝", async () => {
    const f = fixture("managed_blocks:\n  claude-code: AGENTS.md");
    const result = await f.inst.instantiate(f.yaml, f.rigRoot);
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
    expect(f.tmux.createSession).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.cwd)).toEqual([]);
    f.db.close();
  });
});

describe("#25 所选文件语义——保留、幂等和其他文件", () => {
  it("保留 CLAUDE.local.md 中的用户文本，并让含旧块的 CLAUDE.md 字节不变", async () => {
    const userLocal = "# My local notes\n\nprefer short answers\n";
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD, claudeLocalMd: userLocal });
    await launched(f);
    const local = f.read("CLAUDE.local.md")!;
    expect(local.startsWith(userLocal.trimEnd())).toBe(true);
    expect(local).toContain(BEGIN);
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("重复投影到 CLAUDE.local.md 保持幂等", async () => {
    const f = fixture(LOCAL, { claudeLocalMd: "user line\n" });
    const rigId = await launched(f);
    const first = f.read("CLAUDE.local.md");
    const node = f.rigRepo.getRig(rigId)!.nodes[0]!;
    const ctx = f.db.prepare("SELECT projection_entries_json, resolved_files_json FROM node_startup_context WHERE node_id = ?")
      .get(node.id) as { projection_entries_json: string; resolved_files_json: string };
    const binding = { cwd: f.cwd } as NodeBinding; // no destination on the binding: the rig row decides
    const files = JSON.parse(ctx.resolved_files_json).filter((file: { deliveryHint: string }) => file.deliveryHint === "guidance_merge");
    await f.claude.deliverStartup(files, { ...binding, claudeManagedBlockFile: "CLAUDE.local.md" });
    await f.claude.deliverStartup(files, { ...binding, claudeManagedBlockFile: "CLAUDE.local.md" });
    const again = f.read("CLAUDE.local.md")!;
    // 块会原地替换，绝不重复。mergeManagedBlock 在重新合并时增长尾部空行的行为早于 #25，
    // 且与文件无关（见下方对等性检查）。
    const count = (text: string) => text.split(BEGIN).length - 1;
    expect(count(again)).toBe(count(first!));
    expect(again.trimEnd()).toBe(first!.trimEnd());

    fs.writeFileSync(nodePath.join(f.cwd, "CLAUDE.md"), "user line\n");
    for (let i = 0; i < 3; i++) await f.claude.deliverStartup(files, binding);
    expect(f.read("CLAUDE.md")).toBe(again);
    f.db.close();
  });

  it("profile 的 managed_block 投影也使用所选文件", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-issue25-proj-"));
    tmpDirs.push(root);
    const src = nodePath.join(root, "guide.md");
    fs.writeFileSync(src, "profile guidance body");
    const claude = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: realFs(root), sleep: async () => {} });
    const plan = {
      runtime: "claude-code", cwd: root, conflicts: [], noOps: [], diagnostics: [], startup: { files: [], actions: [] },
      entries: [{ category: "guidance" as const, effectiveId: "guide.md", sourceSpec: "impl", sourcePath: root, resourcePath: "guide.md", absolutePath: src, classification: "safe_projection" as const, mergeStrategy: "managed_block" as const }],
    };
    const result = await claude.project(plan, { cwd: root, claudeManagedBlockFile: "CLAUDE.local.md" } as NodeBinding);
    expect(result.projected).toContain("guide.md");
    expect(fs.readFileSync(nodePath.join(root, "CLAUDE.local.md"), "utf-8")).toContain("profile guidance body");
    expect(fs.existsSync(nodePath.join(root, "CLAUDE.md"))).toBe(false);
  });

  it("冲突目标跟随选择，默认值保持不变", () => {
    expect(claudeConflictTargetPath("guidance", "g", "/cwd")).toBe("/cwd/CLAUDE.md");
    expect(claudeConflictTargetPath("guidance", "g", "/cwd", undefined, "CLAUDE.local.md")).toBe("/cwd/CLAUDE.local.md");
    expect(claudeConflictTargetPath("skill", "s", "/cwd", undefined, "CLAUDE.local.md")).toBe("/cwd/.claude/skills/s/SKILL.md");
  });

  it("Codex adapter 忽略 Claude 的选择，仍使用 AGENTS.md", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-issue25-codex-"));
    tmpDirs.push(root);
    const src = nodePath.join(root, "culture.md");
    fs.writeFileSync(src, "codex guidance");
    const codex = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: realFs(root) as never, sleep: async () => {} } as never);
    await codex.deliverStartup(
      [{ path: "culture.md", absolutePath: src, ownerRoot: root, deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }],
      { cwd: root, claudeManagedBlockFile: "CLAUDE.local.md" } as NodeBinding,
    );
    expect(fs.readFileSync(nodePath.join(root, "AGENTS.md"), "utf-8")).toContain("codex guidance");
    expect(fs.existsSync(nodePath.join(root, "CLAUDE.local.md"))).toBe(false);
    expect(fs.existsSync(nodePath.join(root, "CLAUDE.md"))).toBe(false);
  });
});

describe("#25 携带——选择在整个生命周期中保持", () => {
  // 后台服务重启后恢复：重新打开数据库，并使用真实、感知 pod 的 RestoreOrchestrator。
  // `withResumeToken: false` 强制执行重新准备的新启动，从而重放启动流程；
  // 按设计，精确的原生恢复不会重放任何内容（D6a 边界）。
  async function restoreAfterRestart(withResumeToken: boolean) {
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD });
    const rigId = await launched(f);
    const node = f.rigRepo.getRig(rigId)!.nodes[0]!;
    const session = f.sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === node.id)!;
    f.sessionRegistry.updateStatus(session.id, "running");
    if (!withResumeToken) f.db.prepare("UPDATE sessions SET resume_type = NULL, resume_token = NULL WHERE node_id = ?").run(node.id);
    const snapshotRepo = new SnapshotRepository(f.db);
    const checkpointStore = new CheckpointStore(f.db);
    const snap = new SnapshotCapture({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: f.eventBus, snapshotRepo, checkpointStore })
      .captureSnapshot(rigId, "manual");
    f.sessionRegistry.updateStatus(session.id, "exited"); // the rig is down before restore
    f.db.close();
    fs.rmSync(nodePath.join(f.cwd, "CLAUDE.local.md"));

    const db2 = createDb(f.dbFile);
    const s2 = wire(db2, f.home);
    const snapshotRepo2 = new SnapshotRepository(db2);
    const checkpointStore2 = new CheckpointStore(db2);
    const orch = new RestoreOrchestrator({
      db: db2, rigRepo: s2.rigRepo, sessionRegistry: s2.sessionRegistry, eventBus: s2.eventBus,
      snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2,
      snapshotCapture: new SnapshotCapture({ db: db2, rigRepo: s2.rigRepo, sessionRegistry: s2.sessionRegistry, eventBus: s2.eventBus, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 }),
      nodeLauncher: s2.nodeLauncher, tmuxAdapter: s2.tmux,
      claudeResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    const restored = await orch.restore(snap.id, { adapters: { "claude-code": s2.claude }, ...(withResumeToken ? {} : { freshLogicalIds: ["dev.impl"] }) } as never);
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
    db2.close();
    return { f, restored: restored as { ok: true; result: { nodes: Array<{ status: string }> } } };
  }

  it("重新准备的新启动恢复仅将块重放到 CLAUDE.local.md", { timeout: 30000 }, async () => {
    const { f, restored } = await restoreAfterRestart(false);
    expect(restored.result.nodes[0]!.status, JSON.stringify(restored)).not.toBe("failed");
    expect(f.read("CLAUDE.local.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
  });

  it("精确原生恢复不会写入任一文件（边界保持不变）", { timeout: 30000 }, async () => {
    const { f } = await restoreAfterRestart(true);
    expect(f.read("CLAUDE.local.md")).toBeNull();
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
  });

  it("重新启动或继续时重放持久化启动上下文，即使调用方 binding 省略选择也会绑定工作组选择", async () => {
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD });
    const rigId = await launched(f);
    fs.rmSync(nodePath.join(f.cwd, "CLAUDE.local.md"));
    const node = f.rigRepo.getRig(rigId)!.nodes[0]!;
    const session = f.sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === node.id)!;
    const ctx = f.db.prepare("SELECT projection_entries_json, resolved_files_json, startup_actions_json FROM node_startup_context WHERE node_id = ?")
      .get(node.id) as { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string };
    // 与 seat-lifecycle-service 为 launchFresh/continueFreshStartup 构造的 startNode 输入一致。
    const result = await f.startupOrchestrator.startNode({
      rigId, nodeId: node.id, sessionId: session.id,
      binding: { cwd: f.cwd, tmuxSession: session.sessionName } as NodeBinding,
      adapter: f.claude,
      plan: { runtime: "claude-code", cwd: f.cwd, entries: JSON.parse(ctx.projection_entries_json), startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: JSON.parse(ctx.resolved_files_json),
      startupActions: JSON.parse(ctx.startup_actions_json),
      isRestore: false, sessionName: session.sessionName, skipHarnessLaunch: true,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.read("CLAUDE.local.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("扩容或添加：加入运行中工作组的成员会收到 CLAUDE.local.md", async () => {
    const f = fixture(LOCAL);
    const rigId = await launched(f);
    const cwd2 = nodePath.join(f.root, "repo2");
    fs.mkdirSync(cwd2);
    fs.writeFileSync(nodePath.join(cwd2, "CLAUDE.md"), OLD_BLOCKS_CLAUDE_MD);
    const outcome = await f.inst.addMemberToPod(rigId, "dev",
      { id: "helper", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: cwd2 }, f.rigRoot);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(f.read("CLAUDE.local.md", cwd2)).toContain(BEGIN);
    expect(f.read("CLAUDE.md", cwd2)).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("导出 → YAML → 导入往返会保留选择（默认值不输出）", async () => {
    const f = fixture(LOCAL);
    const rigId = await launched(f);
    const exported = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, podRepo: f.podRepo }).exportRig(rigId);
    const yaml = RigSpecCodec.serialize(exported as never);
    expect(yaml).toContain("managed_blocks:\n  claude-code: CLAUDE.local.md");
    const reparsed = RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>);
    expect(reparsed.managedBlocks).toEqual({ "claude-code": "CLAUDE.local.md" });

    const g = fixture("");
    const defaultRig = await launched(g);
    const defaultYaml = RigSpecCodec.serialize(new RigSpecExporter({ rigRepo: g.rigRepo, sessionRegistry: g.sessionRegistry, podRepo: g.podRepo }).exportRig(defaultRig) as never);
    expect(defaultYaml).not.toContain("managed_blocks");
    f.db.close();
    g.db.close();
  });

  it("重写 bundle rig.yaml（归一化 → 序列化）会保留选择", () => {
    const f = fixture(LOCAL);
    const raw = RigSpecCodec.parse(f.yaml) as Record<string, unknown>;
    const rewritten = RigSpecCodec.serialize(RigSpecSchema.normalize(raw));
    expect(RigSpecCodec.parse(rewritten)).toMatchObject({ managed_blocks: { "claude-code": "CLAUDE.local.md" } });
    f.db.close();
  });
});

describe("#25 拆除——仅清理所选文件", () => {
  function teardown(f: ReturnType<typeof fixture>) {
    return new RigTeardownOrchestrator({
      db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, tmuxAdapter: f.tmux, eventBus: f.eventBus,
      snapshotCapture: { db: f.db, captureSnapshot: vi.fn(() => ({ id: "snap" })) } as never,
    });
  }

  it("从 CLAUDE.local.md 移除块并保留用户文本，同时让含旧块的 CLAUDE.md 字节不变", async () => {
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD, claudeLocalMd: "my local line\n" });
    const rigId = await launched(f);
    for (const s of f.sessionRegistry.getSessionsForRig(rigId)) f.sessionRegistry.updateStatus(s.id, "running");
    await teardown(f).teardown(rigId);
    expect(f.read("CLAUDE.local.md")).toBe("my local line\n");
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("移除仅含受管块的 CLAUDE.local.md", async () => {
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD });
    const rigId = await launched(f);
    await teardown(f).teardown(rigId);
    expect(f.read("CLAUDE.local.md")).toBeNull();
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("默认工作组拆除仍清理 CLAUDE.md，且绝不创建或触碰 CLAUDE.local.md", async () => {
    const f = fixture("", { claudeLocalMd: OLD_BLOCKS_CLAUDE_MD });
    const rigId = await launched(f);
    expect(f.read("CLAUDE.md")).toContain(BEGIN);
    await teardown(f).teardown(rigId);
    expect(f.read("CLAUDE.md")).toBeNull();
    expect(f.read("CLAUDE.local.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });
});
