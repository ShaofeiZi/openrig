import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { ContinuityPolicyMaterializer } from "../src/domain/continuity-policy-materializer.js";
import { parseWatchdogSpec } from "../src/domain/watchdog-policy-engine.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockAdapter(runtime = "claude-code"): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}

const RIG_ROOT = "/project/rigs/my-rig";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function makeRigSpec(overrides?: Partial<RigSpec>): RigSpec {
  return {
    version: "0.2", name: "test-rig",
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
    edges: [],
    ...overrides,
  };
}

describe("PodRigInstantiator", () => {
  function setup(
    fsFiles?: Record<string, string>,
    extraAdapters?: Record<string, RuntimeAdapter>,
    topologyRootResolver?: () => string,
    onboardingEnabledResolver?: () => boolean,
    continuityPolicyMaterializer?: Pick<ContinuityPolicyMaterializer, "arm">,
    extraDeps?: Record<string, unknown>,
  ) {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const adapter = mockAdapter();
    const codexAdapter = mockAdapter("codex");
    const files = fsFiles ?? { [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") };
    const fsOps = mockFs(files);

    const instDeps: any = {
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal"), ...(extraAdapters ?? {}) },
      tmuxAdapter: tmux,
      ...(topologyRootResolver ? { topologyRootResolver } : {}),
      ...(onboardingEnabledResolver ? { onboardingEnabledResolver } : {}),
      ...(continuityPolicyMaterializer ? { continuityPolicyMaterializer } : {}),
      ...(extraDeps ?? {}),
    };
    const inst = new PodRigInstantiator(instDeps);

    return { db, rigRepo, podRepo, sessionRegistry, eventBus, inst, adapter, codexAdapter, tmux };
  }

  // T1：有效工作组规范会正确实体化 pod、节点与边。
  it("正确实体化 pod 和节点", async () => {
    const { db, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.rigId).toBeDefined();
      expect(result.result.nodes).toHaveLength(1);
    }
    db.close();
  });

  // T2：在节点上持久化已解析的规范身份。
  it("在节点上持久化已解析的规范身份", async () => {
    const { db, rigRepo, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      const node = rig!.nodes[0]!;
      expect(node.resolvedSpecName).toBe("impl");
      expect(node.resolvedSpecVersion).toBe("1.0.0");
      expect(node.resolvedSpecHash).toBeTruthy();
    }
    db.close();
  });

  // T3：调用启动编排器。
  it("使用适配器调用启动编排器", async () => {
    const { db, inst, adapter } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    expect(adapter.project).toHaveBeenCalled();
    expect(adapter.checkReady).toHaveBeenCalled();
    db.close();
  });

  // Slice 51-01 stub-runtime——仅测试 RED（无争议的机械事实 2）：NORMAL-SEAT 的
  // preflight→materialize→instantiate 路径会分派到注入 instantiator 的 runtime: stub 适配器，
  // 证据是注入适配器的真实生命周期方法确实被调用。此前为 RED，是因为 instantiate() 先运行
  // rigPreflight（rigspec-instantiator.ts:1039），而 SUPPORTED_RUNTIMES 拒绝 "stub"（与 FACT1
  // 使用同一个 source gate），导致分派从未发生。这不是生产 registry 的证明；startup.ts
  // :710/:898 的注册是修订 packet 中另一个首个生产 RED（通过 createDaemon/组装后的
  // instantiator + 真实 restore/successor 路径组合）。不能把本测试中的直接注入误读为已经满足
  // 那项要求；这里没有争议表面。
  it("FACT2：普通 seat 的 instantiate 会分派到注入的 stub 适配器（真实生命周期调用）", async () => {
    const stubAdapter = mockAdapter("stub");
    const { db, inst } = setup(undefined, { stub: stubAdapter });
    const spec = makeRigSpec({
      pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "stub", cwd: "." }], edges: [] }],
    });
    const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
    expect(result.ok, `runtime: stub 的 instantiate 必须成功；实际结果：${JSON.stringify(result)}`).toBe(true);
    // 分派证明：注入的 stub 适配器真实生命周期方法确实被调用。
    expect(stubAdapter.project, "instantiate 必须把 project() 分派给注入的 stub 适配器").toHaveBeenCalled();
    expect(stubAdapter.checkReady, "instantiate 必须把 checkReady() 分派给注入的 stub 适配器").toHaveBeenCalled();
    if (result.ok) expect(result.result.nodes).toHaveLength(1);
    db.close();
  });

  it("把 RigSpec 成员模型传入 Codex runtime binding", async () => {
    const { db, inst, codexAdapter } = setup();
    const spec = makeRigSpec({
      pods: [{
        id: "dev",
        label: "Dev",
        members: [{
          id: "impl",
          agentRef: "local:agents/impl",
          profile: "default",
          runtime: "codex",
          model: "gpt-5.5",
          cwd: ".",
        }],
        edges: [],
      }],
    });

    const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);

    expect(result.ok).toBe(true);
    const launchHarness = codexAdapter.launchHarness as ReturnType<typeof vi.fn>;
    expect(launchHarness).toHaveBeenCalled();
    expect(launchHarness.mock.calls[0]?.[0].model).toBe("gpt-5.5");
    db.close();
  });

  it("对已启动节点使用 cwdOverride，且不改变相对规范的 agent 解析", async () => {
    const { db, rigRepo, sessionRegistry, inst, adapter } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT, { cwdOverride: "/workspace/project" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId)!;
      expect(rig.nodes[0]!.cwd).toBe("/workspace/project");
      const sessions = sessionRegistry.getSessionsForRig(result.result.rigId);
      expect(sessions[0]!.startupStatus).toBe("ready");
      const planArg = (adapter.project as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(planArg.cwd).toBe("/workspace/project");
    }
    db.close();
  });

  it("受管 Skill 投影失败时拒绝启动运行环境", async () => {
    const skillReconciler = vi.fn(() => ({
      ok: false,
      applied: false,
      freshLaunchRequired: false,
      runtime: "claude-code",
      targetRoot: "/project/.claude/skills",
      manifestPath: "/project/.openrig/skill-loadouts/claude-code.json",
      receipts: [],
      removed: [],
      errors: [{ code: "target_conflict", message: "operator-owned skill differs" }],
    }));
    const { db, inst, adapter } = setup(undefined, undefined, undefined, undefined, undefined, { skillReconciler });

    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);

    expect(result.ok).toBe(false);
    expect(skillReconciler).toHaveBeenCalledOnce();
    expect(adapter.project).not.toHaveBeenCalled();
    if (!result.ok && "message" in result) expect(result.message).toContain("target_conflict: operator-owned skill differs");
    db.close();
  });

  it("预检与启动解析都使用配置的目录", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-instantiator-skill-catalog-"));
    let db: ReturnType<typeof createFullTestDb> | undefined;
    try {
      const catalog = nodePath.join(root, "managed-skills");
      const project = nodePath.join(root, "project");
      fs.mkdirSync(nodePath.join(catalog, "topology-skill"), { recursive: true });
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(nodePath.join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      fs.writeFileSync(
        nodePath.join(catalog, "topology-skill", "SKILL.md"),
        "---\nname: topology-skill\ndescription: Use when testing configured catalog launch resolution.\n---\n\n# Topology skill\n",
      );
      execFileSync("git", ["-C", catalog, "init", "-q"]);
      execFileSync("git", ["-C", catalog, "config", "user.email", "test@openrig.invalid"]);
      execFileSync("git", ["-C", catalog, "config", "user.name", "OpenRig Test"]);
      execFileSync("git", ["-C", catalog, "add", "."]);
      execFileSync("git", ["-C", catalog, "commit", "-qm", "fixture"]);

      const skillReconciler = vi.fn(() => ({
        ok: true,
        applied: false,
        freshLaunchRequired: false,
        runtime: "codex",
        targetRoot: nodePath.join(project, ".agents", "skills"),
        manifestPath: nodePath.join(project, ".openrig", "skill-loadouts", "codex.json"),
        receipts: [],
        removed: [],
        errors: [],
      }));
      const files = {
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl
version: "1.0.0"
imports:
  - ref: local:../shared
resources:
  skills: []
profiles:
  default:
    uses:
      skills: [topology-skill]`,
        [`${RIG_ROOT}/agents/shared/agent.yaml`]: "name: shared\nversion: \"1.0.0\"\nresources:\n  skills: []\nprofiles: {}\n",
      };
      const setupResult = setup(undefined, undefined, undefined, undefined, undefined, {
        fsOps: mockFs(files),
        skillsRootResolver: () => catalog,
        skillReconciler,
      });
      db = setupResult.db;
      const rig = makeRigSpec({
        pods: [{
          id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: project }],
          edges: [],
        }],
      });

      const result = await setupResult.inst.instantiate(RigSpecCodec.serialize(rig), RIG_ROOT);

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(skillReconciler).toHaveBeenCalledOnce();
      expect(skillReconciler.mock.calls[0]?.[0].loadout.entries.map((entry: { id: string }) => entry.id)).toContain("topology-skill");
    } finally {
      db?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resources.guidance 与 startup.files 引用同一文件时对 role guidance 去重", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const adapter = mockAdapter();
    const fsOps = mockFs({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `
name: impl
version: "1.0.0"
resources:
  skills: []
  guidance:
    - id: role
      path: guidance/role.md
      target: claude_md
      merge: managed_block
startup:
  files:
    - path: guidance/role.md
      delivery_hint: guidance_merge
profiles:
  default:
    uses:
      skills: []
      guidance: [role]
      subagents: []
      runtime_resources: []
`.trim(),
      [`${RIG_ROOT}/agents/impl/guidance/role.md`]: "# role",
    });

    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": adapter, codex: mockAdapter(), terminal: mockAdapter() },
      tmuxAdapter: tmux,
    });

    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true);
    const deliveredFiles = (adapter.deliverStartup as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as Array<{ path: string }>);
    expect(deliveredFiles.some((f) => f.path === "guidance/role.md")).toBe(false);
    const projectedPlan = (adapter.project as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(projectedPlan.entries.some((entry: { category: string; effectiveId: string }) => entry.category === "guidance" && entry.effectiveId === "role")).toBe(true);
    db.close();
  });

  it("向已启动 agent 的启动操作注入工作组身份上下文", async () => {
    const { db, inst, tmux } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(true);

    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    const identityCall = sendText.mock.calls.find(([, text]) =>
      typeof text === "string" && text.includes("zrig session 身份："),
    );

    expect(identityCall).toBeDefined();
    expect(identityCall?.[0]).toBe("dev-impl@test-rig");
    expect(identityCall?.[1]).toMatch(/^dev-impl@test-rig\nzrig session 身份：/);
    // identity 字段保持不变
    expect(identityCall?.[1]).toContain("- rig: test-rig");
    expect(identityCall?.[1]).toContain("- pod: dev");
    expect(identityCall?.[1]).toContain("- member: impl");
    expect(identityCall?.[1]).toContain("- logical_id: dev.impl");
    expect(identityCall?.[1]).toContain("- session: dev-impl@test-rig");
    // Whoami 指引
    expect(identityCall?.[1]).toContain("zrig whoami --json");

    db.close();
  });

  it("在已解析的启动文件中包含 openrig-start.md 入门 overlay", async () => {
    const { db, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);

    // 检查启动上下文中是否包含 openrig-start.md。
    const ctxRows = db.prepare("SELECT * FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    expect(ctxRows.length).toBeGreaterThan(0);
    const allFiles = ctxRows.flatMap((r) => JSON.parse(r.resolved_files_json) as Array<{ path: string }>);
    const onboarding = allFiles.find((f) => f.path === "openrig-start.md");
    expect(onboarding).toBeDefined();

    db.close();
  });

  it("全新启动时交付由两部分组成的默认入门包", async () => {
    const { db, inst } = setup();
    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true);

    const rows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const files = rows.flatMap((row) => JSON.parse(row.resolved_files_json) as Array<{
      path: string;
      required: boolean;
      appliesOn: string[];
    }>);
    expect(files.filter((file) => file.path.startsWith("openrig-onboarding-"))).toEqual([
      expect.objectContaining({
        path: "openrig-onboarding-01.md",
        required: true,
        appliesOn: ["fresh_start"],
      }),
      expect.objectContaining({
        path: "openrig-onboarding-02.md",
        required: true,
        appliesOn: ["fresh_start"],
      }),
    ]);

    db.close();
  });

  it("类型化设置关闭时省略默认入门包", async () => {
    const { db, inst } = setup(undefined, undefined, undefined, () => false);
    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true);

    const rows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const paths = rows.flatMap((row) =>
      (JSON.parse(row.resolved_files_json) as Array<{ path: string }>).map((file) => file.path),
    );
    expect(paths).toContain("openrig-start.md");
    expect(paths.some((path) => path.startsWith("openrig-onboarding-"))).toBe(false);

    db.close();
  });

  it("为未来启动启用 onboarding 时不重写已有工作组", async () => {
    let onboardingEnabled = false;
    const { db, inst } = setup(undefined, undefined, undefined, () => onboardingEnabled);
    const existing = await inst.instantiate(
      RigSpecCodec.serialize(makeRigSpec({ name: "existing-rig" })),
      RIG_ROOT,
    );
    expect(existing.ok).toBe(true);
    if (!existing.ok) throw new Error(existing.error);

    const existingNodeId = existing.result.nodes[0]!.id;
    const readStartup = (nodeId: string) => db.prepare(`
      SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime
        FROM node_startup_context
       WHERE node_id = ?
    `).get(nodeId) as Record<string, unknown>;
    const before = readStartup(existingNodeId);

    onboardingEnabled = true;
    const future = await inst.instantiate(
      RigSpecCodec.serialize(makeRigSpec({ name: "future-rig" })),
      RIG_ROOT,
    );
    expect(future.ok).toBe(true);
    if (!future.ok) throw new Error(future.error);

    expect(readStartup(existingNodeId)).toEqual(before);

    db.close();
  });

  it("工作组没有 culture_file 时始终包含默认文化文件", async () => {
    const { db, inst } = setup();
    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true);

    const ctxRows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const allFiles = ctxRows.flatMap((row) => JSON.parse(row.resolved_files_json) as Array<{
      path: string;
      deliveryHint: string;
      required: boolean;
    }>);
    expect(allFiles).toContainEqual(expect.objectContaining({
      path: "CULTURE-default.md",
      deliveryHint: "guidance_merge",
      required: true,
    }));

    db.close();
  });

  it("将默认文化文件排在工作组文化 overlay 之前", async () => {
    const { db, inst } = setup();
    const spec = makeRigSpec({ cultureFile: "CULTURE.md" });
    const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
    expect(result.ok).toBe(true);

    const ctxRows = db.prepare("SELECT resolved_files_json FROM node_startup_context").all() as Array<{ resolved_files_json: string }>;
    const paths = ctxRows.flatMap((row) =>
      (JSON.parse(row.resolved_files_json) as Array<{ path: string }>).map((file) => file.path),
    );
    expect(paths).toContain("CULTURE-default.md");
    expect(paths).toContain("CULTURE.md");
    expect(paths.indexOf("CULTURE-default.md")).toBeLessThan(paths.indexOf("CULTURE.md"));

    db.close();
  });

  it("CULTURE-default.md 提供轻量级 operating-model 基线", () => {
    const { existsSync, readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const assetPath = resolve(import.meta.dirname, "../src/domain/../../assets/guidance/CULTURE-default.md");
    expect(existsSync(assetPath)).toBe(true);
    const content = readFileSync(assetPath, "utf8");
    expect(content).toContain("Pragmatic truth-seeking");
    expect(content).toContain("Principles over rules");
    expect(content).toContain("Ship good, working product");
    expect(content).toContain("Match rigor to stakes");
    expect(content).not.toContain("full stop on new production");
  });

  it("openrig-start.md 资源存在于磁盘并守护精简 overlay 契约", () => {
    const { existsSync, readFileSync } = require("node:fs");
    const { resolve } = require("node:path");
    const assetPath = resolve(import.meta.dirname, "../src/domain/../../assets/guidance/openrig-start.md");
    expect(existsSync(assetPath)).toBe(true);
    const content = readFileSync(assetPath, "utf8");
    // 精简 overlay 的正向保证：身份优先、两个 peer 动词、精简 transcript 警告（守护一个
    // 按 runtime 实时记录的条件），以及明确要求“询问而非推断”的结尾。
    expect(content).toContain("rig whoami --json");
    expect(content).toContain("rig send");
    expect(content).toContain("rig capture");
    // 使用不受换行影响的片段，因为源文件是硬换行 Markdown。
    expect(content).toContain("transcript capture is unreliable");
    expect(content).toContain("mean the session was quiet");
    expect(content).toContain("say so rather than inferring");
    // 通过“不应出现的内容”锁定保持启动 overlay 精简的产品决策：默认启动 overlay 不得携带
    // operating-model SDLC 或 skill-library 路由（它们是由 profile/startup 配置交付的可选层，
    // 绝不硬编码在这里）。
    expect(content).not.toContain("mission-slice-sop");
    expect(content).not.toContain("plan-lock");
    expect(content).not.toContain("openrig-user");
    expect(content).not.toContain("openrig-skills");
    expect(content).toContain("openrig-onboarding-01.md");
    expect(content).toContain("onboarding.default_pack.enabled");
    // 精简就必须真正精简：设置硬上限，使内容重新膨胀到裁剪前 3.6KB 的趋势明确失败，
    // 而不是静默发生。
    expect(content.length).toBeLessThan(2500);
  });

  // T4：部分失败——一个节点启动失败，另一个成功。
  it("部分节点启动失败不会破坏其他节点", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    };

    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

    // 为 qa 返回失败的启动编排器。
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const origStartNode = startupOrch.startNode.bind(startupOrch);
    let callCount = 0;
    startupOrch.startNode = async (input) => {
      callCount++;
      if (callCount === 2) {
        // 让第二个节点的启动流程失败。
        sessionRegistry.updateStartupStatus(input.sessionId, "failed");
        return { ok: false, startupStatus: "failed", errors: ["simulated failure"] };
      }
      return origStartNode(input);
    };

    const adapter = mockAdapter();
    const fsOps = mockFs(files);
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch, fsOps,
      adapters: { "claude-code": adapter },
    });

    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const launched = result.result.nodes.filter((n) => n.status === "launched");
      const failed = result.result.nodes.filter((n) => n.status === "failed");
      expect(launched.length).toBe(1);
      expect(failed.length).toBe(1);
    }
    db.close();
  });

  // T5：共享同一个数据库句柄。
  it("验证各依赖共享同一个数据库句柄", () => {
    const db = createFullTestDb();
    const db2 = createFullTestDb();
    const rigRepo = new RigRepository(db);
    expect(() => new PodRigInstantiator({
      db: db2, rigRepo, podRepo: new PodRepository(db2), sessionRegistry: new SessionRegistry(db2),
      eventBus: new EventBus(db2), nodeLauncher: new NodeLauncher({ db: db2, rigRepo: new RigRepository(db2), sessionRegistry: new SessionRegistry(db2), eventBus: new EventBus(db2), tmuxAdapter: mockTmux() }),
      startupOrchestrator: new StartupOrchestrator({ db: db2, sessionRegistry: new SessionRegistry(db2), eventBus: new EventBus(db2), tmuxAdapter: mockTmux() }),
      fsOps: mockFs({}), adapters: {},
    })).toThrow(/PodRigInstantiator：rigRepo 必须共享同一个数据库句柄/);
    db.close();
    db2.close();
  });

  // T7：发出启动生命周期事件。
  it("发出启动生命周期事件", async () => {
    const { db, eventBus, inst } = setup();
    const events: string[] = [];
    eventBus.subscribe((e) => events.push(e.type));
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    await inst.instantiate(yaml, RIG_ROOT);
    expect(events).toContain("node.startup_pending");
    expect(events).toContain("node.startup_ready");
    db.close();
  });

  // T8：持久化 pod 成员关系。
  it("在节点上持久化 pod 成员关系", async () => {
    const { db, rigRepo, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig!.nodes[0]!.podId).toBeTruthy();
    }
    db.close();
  });

  // CP2-R1：两个 pod 中同名成员会创建不同节点（使用限定 logical_id）。
  it("两个 pod 中同名成员会创建不同节点", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, rigRepo, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [
        { id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] },
        { id: "arch", label: "Arch", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] },
      ],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig!.nodes).toHaveLength(2);
      const logicalIds = rig!.nodes.map((n) => n.logicalId).sort();
      expect(logicalIds).toEqual(["arch.impl", "dev.impl"]);
    }
    db.close();
  });

  // CP2-R2：把收窄后的 restore-policy 同时持久化到节点和会话。
  it("把收窄后的 restore-policy 持久化到节点和会话", async () => {
    // Agent 规范默认 checkpoint_only，成员请求 resume_if_possible 会扩大权限，应失败。
    // 此处改为规范允许 resume_if_possible，而成员收窄为 relaunch_fresh。
    const narrowingAgent = `name: impl\nversion: "1.0.0"\ndefaults:\n  lifecycle:\n    compaction_strategy: harness_native\n    restore_policy: resume_if_possible\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
    const files = { [`${RIG_ROOT}/agents/impl/agent.yaml`]: narrowingAgent };
    const { db, rigRepo, sessionRegistry, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", restorePolicy: "relaunch_fresh" }], edges: [] }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rig = rigRepo.getRig(result.result.rigId);
      expect(rig!.nodes[0]!.restorePolicy).toBe("relaunch_fresh");
      // 同时检查会话。
      const sessions = sessionRegistry.getSessionsForRig(result.result.rigId);
      expect(sessions[0]!.restorePolicy).toBe("relaunch_fresh");
    }
    db.close();
  });

  it("经真实启动路径把三级解析后的 mechanic 传递到 cutover 注册", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `
version: "0.2"
name: impl
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
    mechanic: default-mechanic@default-rig
resources:
  skills: []
profiles:
  default:
    lifecycle:
      mechanic: profile-mechanic@profile-rig
    uses:
      skills: []
`.trim(),
    };
    const register = vi.fn()
      .mockReturnValueOnce({ jobId: "prepare-job" })
      .mockReturnValueOnce({ jobId: "cutover-job" });
    const materializer = new ContinuityPolicyMaterializer({ register }, () => null);
    const { db, inst } = setup(files, undefined, undefined, undefined, materializer);
    const yaml = `
version: "0.2"
name: test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        mechanic: member-mechanic@member-rig
    edges: []
edges: []
`;

    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
    const cutover = parseWatchdogSpec(register.mock.calls[1]![0].specYaml);
    expect(cutover.context).toMatchObject({
      continuity_action: { destination: "member-mechanic@member-rig" },
    });
    db.close();
  });

  it("缺少 mechanic 时拒绝启用 apprentice，并给出字段、分层与 SOP 指引", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `
version: "0.2"
name: impl
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`.trim(),
    };
    const register = vi.fn().mockReturnValue({ jobId: "must-not-arm" });
    const materializer = new ContinuityPolicyMaterializer({ register }, () => "/tmp/transcript.jsonl");
    const { db, inst } = setup(files, undefined, undefined, undefined, materializer);

    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);

    expect(result.ok).toBe(true);
    expect(register).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toMatch(
      /mechanic.*spec-default.*profile.*成员.*continuity\/apprentice-cutover\.md/i,
    );
    db.close();
  });

  // CP2-R3：根据 delegates_to 边强制执行拓扑顺序。
  it("根据边的拓扑顺序启动节点", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/orch/agent.yaml`]: agentYaml("orch"),
    };
    const { db, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "worker", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "lead", agentRef: "local:agents/orch", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [{ kind: "delegates_to", from: "lead", to: "worker" }],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // lead 应先于 worker 启动，因为 delegates_to: lead -> worker 表示 lead 优先。
      const leadIdx = result.result.nodes.findIndex((n) => n.logicalId === "dev.lead");
      const workerIdx = result.result.nodes.findIndex((n) => n.logicalId === "dev.worker");
      expect(leadIdx).toBeLessThan(workerIdx);
    }
    db.close();
  });

  // NS-T01：规范 session 名为 {pod}-{member}@{rig}。
  it("使用规范 session 名启动节点", async () => {
    const { db, tmux, inst } = setup();
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    // tmux createSession 使用规范名称调用。
    const createSession = tmux.createSession as ReturnType<typeof vi.fn>;
    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0]![0]).toBe("dev-impl@test-rig");
    db.close();
  });

  // NS-T01：实体化预检会捕获无效的 session 名字符。
  it("预检以逐组件错误拒绝无效 session 名字符", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, inst } = setup(files);
    const spec = makeRigSpec({
      name: "my rig",
      pods: [{
        id: "dev 1", label: "Dev",
        members: [{ id: "impl!", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok && "errors" in result) {
      expect(result.errors.some((e: string) => e.includes("pod 名称") && e.includes(" "))).toBe(true);
      expect(result.errors.some((e: string) => e.includes("member 名称") && e.includes("!"))).toBe(true);
      expect(result.errors.some((e: string) => e.includes("rig 名称") && e.includes(" "))).toBe(true);
    }
    db.close();
  });

  // NS-T03：实体化 terminal 成员时跳过 agent 解析并执行启动。
  it("不解析 agent 即可实体化 terminal 成员", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, tmux, rigRepo, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [
        {
          id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
          edges: [],
        },
        {
          id: "infra", label: "Infrastructure",
          members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: ".", startup: { files: [], actions: [{ type: "send_text", value: "npm run dev", phase: "after_ready", idempotent: true, appliesOn: ["fresh_start"] }] } }],
          edges: [],
        },
      ],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes).toHaveLength(2);
      const launched = result.result.nodes.filter((n) => n.status === "launched");
      expect(launched).toHaveLength(2);
      // Terminal 节点使用规范名称启动。
      const createSession = tmux.createSession as ReturnType<typeof vi.fn>;
      const sessionNames = createSession.mock.calls.map((c: string[]) => c[0]);
      expect(sessionNames).toContain("infra-server@test-rig");
    }
    db.close();
  });

  // NS-T03：terminal 成员的 restore_policy 传播到 session。
  it("terminal 成员把 checkpoint_only restore_policy 传播到 session 行", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{
        id: "infra", label: "Infra",
        members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." }],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 检查 session 是否为 checkpoint_only。
      const sessions = db.prepare("SELECT restore_policy FROM sessions").all() as Array<{ restore_policy: string }>;
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions[0]!.restore_policy).toBe("checkpoint_only");
    }
    db.close();
  });

  // NS-T03：terminal 节点在 node-inventory 中显示为 infrastructure。
  it("通过 terminal 实体化的节点以 nodeKind infrastructure 出现在 inventory 中", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    const { db, rigRepo, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{
        id: "infra", label: "Infra",
        members: [{ id: "server", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." }],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 通过 node-inventory 投影验证。
      const { getNodeInventory } = await import("../src/domain/node-inventory.js");
      const inventory = getNodeInventory(db, result.result.rigId);
      expect(inventory).toHaveLength(1);
      expect(inventory[0]!.nodeKind).toBe("infrastructure");
      expect(inventory[0]!.runtime).toBe("terminal");
    }
    db.close();
  });

  // CP2-R5：两个节点之间存在环时必须拒绝实体化。
  it("拒绝两个节点之间的依赖环", async () => {
    const files = {
      [`${RIG_ROOT}/agents/a/agent.yaml`]: agentYaml("a"),
      [`${RIG_ROOT}/agents/b/agent.yaml`]: agentYaml("b"),
    };
    const { db, inst } = setup(files);
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "a", agentRef: "local:agents/a", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "b", agentRef: "local:agents/b", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [
          { kind: "delegates_to", from: "a", to: "b" },
          { kind: "delegates_to", from: "b", to: "a" },
        ],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe("cycle_error");
      expect(result.message).toMatch(/cycle/i);
    }
    db.close();
  });

  // OPR.0.3.2.22 Bug 2——cycle_error 时不留下孤立工作组记录。重排修复要求
  // computePodLaunchOrder 必须在 createRig 之前运行，使检测到环时在任何数据库写入前返回。
  // 修复前，每次失败的 `zrig up <builtin>` 都会留下 stopped 状态的孤立工作组记录，导致重试
  // 报告 "ambiguous library-spec vs restore-target"；这是 openrig-comms 主流程瑕疵背后的
  // 二阶 UX 陷阱。
  it("cycle_error：不持久化孤立工作组记录（Bug 2 重排）", async () => {
    const files = {
      [`${RIG_ROOT}/agents/a/agent.yaml`]: agentYaml("a"),
      [`${RIG_ROOT}/agents/b/agent.yaml`]: agentYaml("b"),
    };
    const { db, rigRepo, inst } = setup(files);
    const specName = "orphan-cycle-test-rig";
    const spec = makeRigSpec({
      name: specName,
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "a", agentRef: "local:agents/a", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "b", agentRef: "local:agents/b", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [
          { kind: "delegates_to", from: "a", to: "b" },
          { kind: "delegates_to", from: "b", to: "a" },
        ],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe("cycle_error");
    }
    // 承重断言：规范名称下没有持久化任何工作组记录。
    const orphans = rigRepo.findRigsByName(specName);
    expect(orphans, `expected no orphan rig records after cycle_error, found ${JSON.stringify(orphans)}`).toHaveLength(0);
    db.close();
  });

  // OPR.0.3.2.22 Bug 2——service_boot_failed（prelaunch-hook 失败）时回滚。与
  // cycle_error 不同，hook 运行时工作组记录与 pod 已创建（hook 需要 rigId），因此修复会在
  // 返回失败前调用 rigRepo.deleteRig(rigId)。
  it("service_boot_failed：回滚已创建的工作组记录（Bug 2 prelaunch-hook 回滚）", async () => {
    const { db, rigRepo, inst } = setup();
    const specName = "orphan-prelaunch-test-rig";
    const yaml = RigSpecCodec.serialize(makeRigSpec({ name: specName }));
    const result = await inst.instantiate(yaml, RIG_ROOT, {
      prelaunchHook: async () => ({ ok: false, code: "service_boot_failed", message: "test: service boot refused" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok && "code" in result) {
      expect(result.code).toBe("service_boot_failed");
    }
    const orphans = rigRepo.findRigsByName(specName);
    expect(orphans, `expected no orphan rig records after service_boot_failed, found ${JSON.stringify(orphans)}`).toHaveLength(0);
    db.close();
  });

  // NS-T05：完全失败时终止孤立的 tmux session。
  it("完全失败时终止孤立的 tmux session", async () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    };
    // 构造启动后 startup 始终失败的环境。
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const tmux = mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    // 在 project 阶段（启动后）失败的适配器。
    const failAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [{ effectiveId: "x", error: "disk full" }] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true })),
    };
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const fsOps = mockFs(files);
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
      fsOps, adapters: { "claude-code": failAdapter, "codex": failAdapter, "terminal": failAdapter },
      tmuxAdapter: tmux,
    });

    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);
    expect(result.ok).toBe(false);

    // 应为孤立 session 调用 tmux.killSession。
    const killSession = tmux.killSession as ReturnType<typeof vi.fn>;
    expect(killSession).toHaveBeenCalled();

    db.close();
  });

  // Agent Starter v1 垂直切片 M1——前向兼容 smoke。携带新 `starter_ref` 字段（规范化为
  // `starterRef`）的成员规范必须通过 pod-aware 实体化，且不能破坏现有 pipeline。M1 只落地
  // schema 与 resolver 脚手架；M2 把 `starterRef` 接入启动路径。本测试验证存在新字段时，
  // M1 不会让现有实体化流程回归。
  //
  // R2 修复：实体化前断言序列化 YAML 确实包含 `starter_ref:`。R1 codec 曾丢弃该字段
  //（伪证明），因此 R2 在修复 codec 输出的同时加入此断言。没有它，smoke 测试会空洞地
  // 通过，因为现有 pipeline 本来就能处理不含 `starter_ref:` 的 YAML。
  it("前向兼容：成员带 starter_ref 的 pod 可无错实体化，且 codec 会输出该字段（R2 修复）", async () => {
    // M2 更新：设置 starterRef 后，resolver 现在会主动读取 registry（M2.1/M2.2 接线）。
    // 提供一个 fixture registry 条目使 resolver 成功；smoke 测试证明字段能传入启动路径，
    // 且不破坏现有 pipeline。专门的端到端与 abort 行为位于
    // agent-starter-instantiator.test.ts；本测试继续作为前向兼容回归防线。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpRegistry = fs.mkdtempSync(path.join(os.tmpdir(), "starter-fwd-compat-"));
    fs.writeFileSync(path.join(tmpRegistry, "fixture-starter.yaml"), `draft: false
starter_id: fixture-starter
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fwd-compat-fixture"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`);
    process.env.OPENRIG_AGENT_STARTER_ROOT = tmpRegistry;
    try {
      const { db, inst, rigRepo } = setup();
      const yaml = RigSpecCodec.serialize(makeRigSpec({
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
            starterRef: { name: "fixture-starter" },
          }],
          edges: [],
        }],
      }));
      // R2：先证明序列化 YAML 确实携带新字段，再验证字段存在时实体化仍成功。
      expect(yaml).toContain("starter_ref:");
      expect(yaml).toContain("fixture-starter");
      const result = await inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const rig = rigRepo.getRig(result.result.rigId);
        expect(rig).not.toBeNull();
        expect(rig!.nodes).toHaveLength(1);
      }
      db.close();
    } finally {
      delete process.env.OPENRIG_AGENT_STARTER_ROOT;
      fs.rmSync(tmpRegistry, { recursive: true, force: true });
    }
  });

  // --- Conveyor-Trust 最小修复（OPR.0.3.2.CT）---
  //
  // QA baseline-deep-dogfood 发现 `zrig up conveyor --yes` 会在 workspace-trust gate
  // 陷入死路：返回 instantiate_error，且失败会清理为零（rigs=0、nodes=0、sessions=0），
  // 操作员没有任何可批准对象。PRD：
  // missions/release-0.3.2/slices/conveyor-trust-minimal-fix/IMPLEMENTATION-PRD.md。
  //
  // 根因：launchExistingAgentMember 把
  // startupResult={ok:false, startupStatus:"attention_required"} 折叠为 status:"failed"，
  // 随后 allFailed → 拆除。
  //
  // 最小修复（HG-2、HG-5 gate-zero）：
  //   - 通过 launchExistingAgentMember 传播 attention_required
  //   - 仅当所有节点都终结性失败时才执行 allFailed 拆除
  //     （attention_required 节点可恢复，保留工作组与 session）
  //   - session 的 startup_status="attention_required" 已存在（由 startupOrchestrator 设置）；
  //     工作组现在可通过 zrig ps 看到，并处于 attention_required 状态
  //   - HG-5：不改变 trust model、新用户 UX 或 auto-trust，只触及失败处理路径

  it("HG-1 复现（修复前）：所有节点命中 trust-gate → instantiate_error + 清零", async () => {
    // 修复前，本测试本应呈现错误的清零行为。修复后，它记录旧行为以明确判别条件；现在
    // 测试通过，是因为系统会保留可恢复状态，并断言新的预期形状（不拆除）。
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    // 为所有节点返回 attention_required 的启动编排器，用于模拟一次性工作区的 trust-gate。
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    startupOrch.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return {
        ok: false,
        startupStatus: "attention_required",
        errors: ["Harness launch requires attention: trust_gate"],
        evidence: "Claude is waiting for workspace trust approval before the session can become interactive.",
      };
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
      }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });

    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const yaml = RigSpecCodec.serialize(spec);
    const result = await inst.instantiate(yaml, RIG_ROOT);

    // HG-2：不再清零。结果返回 ok:false 与新的 attention_required code（而非旧的
    // instantiate_error），并在磁盘上保留工作组与 session，供操作员处理。
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("attention_required");
      expect(result.message).toMatch(/需要处理|关注/);
    }
    // 保留工作组与 session，操作员可通过 zrig ps 列出它们。
    expect(rigRepo.listRigs()).toHaveLength(1);
    if (!result.ok && result.code === "attention_required") {
      const fullRig = rigRepo.getRig(result.rigId);
      expect(fullRig).not.toBeNull();
      expect(fullRig!.nodes.length).toBe(2);
    }
    // 不终止 tmux session（attention_required 不执行清理 pass）。
    expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // Session 行携带 startup_status='attention_required'（startupOrchestrator 已持久化）；
    // 在此锁定该值，作为 approve-and-resume 路径的锚点。
    const sessions = db.prepare("SELECT startup_status FROM sessions").all() as Array<{ startup_status: string }>;
    expect(sessions.length).toBe(2);
    for (const s of sessions) {
      expect(s.startup_status).toBe("attention_required");
    }
    db.close();
  });

  it("HG-3 attention_required 结果携带 attentionNodes 列表（操作员 approve→resume 路径）", async () => {
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    startupOrch.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return {
        ok: false,
        startupStatus: "attention_required",
        errors: ["Harness launch requires attention: trust_gate"],
        evidence: "Claude is waiting for workspace trust approval before the session can become interactive.",
      };
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "attention_required") {
      expect(result.message).toMatch(/检查/);
      expect(result.message).not.toMatch(/approve and resume|NOT failed/);
      expect(result.rigId).toBeDefined();
      expect(result.attentionNodes).toBeInstanceOf(Array);
      expect(result.attentionNodes!.length).toBe(1);
      expect(result.attentionNodes![0]!.logicalId).toBe("dev.impl");
      expect(result.attentionNodes![0]!.sessionName).toContain("@test-rig");
    }
    db.close();
  });

  it("HG-2 混合场景：一个 attention_required + 一个 launched → 保留工作组并返回 attention 警告", async () => {
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const origStartNode = startupOrch.startNode.bind(startupOrch);
    let callCount = 0;
    startupOrch.startNode = async (input) => {
      callCount++;
      if (callCount === 2) {
        sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
        return {
          ok: false,
          startupStatus: "attention_required",
          errors: ["trust_gate on qa"],
          evidence: "trust prompt",
        };
      }
      return origStartNode(input);
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
      }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });

    const yaml = RigSpecCodec.serialize(makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    }));
    const result = await inst.instantiate(yaml, RIG_ROOT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const attention = result.result.nodes.filter((n) => n.status === "attention_required");
      const launched = result.result.nodes.filter((n) => n.status === "launched");
      expect(launched.length).toBe(1);
      expect(attention.length).toBe(1);
      expect(attention[0]!.logicalId).toBe("dev.qa");
    }
    // 工作组保留，session 完整。
    expect(rigRepo.listRigs()).toHaveLength(1);
    expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    db.close();
  });

  it("HG-2 反例：全部终结性失败时仍会拆除（终结失败清理无回归）", async () => {
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    startupOrch.startNode = async (input) => {
      sessionRegistry.updateStartupStatus(input.sessionId, "failed");
      return {
        ok: false,
        startupStatus: "failed",
        errors: ["terminal failure (NOT trust-gate)"],
      };
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });
    const yaml = RigSpecCodec.serialize(makeRigSpec());
    const result = await inst.instantiate(yaml, RIG_ROOT);

    // 保留终结失败的拆除行为，不让现有清理路径回归。
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("instantiate_error");
    }
    expect(rigRepo.listRigs()).toHaveLength(0);
    db.close();
  });

  it("HG-2 反例：至少一个终结失败和一个 attention_required 时保留工作组（可恢复优先）", async () => {
    const { db, rigRepo, sessionRegistry, eventBus, podRepo, adapter, codexAdapter, tmux } = setup({
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
      [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
    let callCount = 0;
    startupOrch.startNode = async (input) => {
      callCount++;
      if (callCount === 1) {
        sessionRegistry.updateStartupStatus(input.sessionId, "failed");
        return { ok: false, startupStatus: "failed", errors: ["terminal failure"] };
      }
      sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
      return {
        ok: false,
        startupStatus: "attention_required",
        errors: ["trust_gate"],
        evidence: "trust prompt",
      };
    };
    const inst = new PodRigInstantiator({
      db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
      startupOrchestrator: startupOrch,
      fsOps: mockFs({
        [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl"),
        [`${RIG_ROOT}/agents/qa/agent.yaml`]: agentYaml("qa"),
      }),
      adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
      tmuxAdapter: tmux,
    });
    const yaml = RigSpecCodec.serialize(makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "qa", agentRef: "local:agents/qa", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    }));
    const result = await inst.instantiate(yaml, RIG_ROOT);

    // 任意 attention_required 都表示可恢复；即使其他节点终结性失败，也保留工作组。
    expect(rigRepo.listRigs()).toHaveLength(1);
    // 操作员仍能看到并批准 attention_required 节点。
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("attention_required");
    }
    db.close();
  });

  // r2-B1（slice-06 BLOCKING 1）：真正的 rig-up 入口是 instantiate()，而不是
  // materializeValidatedSpec；bootstrap apply 路径会调用 instantiate()
  //（bootstrap-orchestrator.ts），所以只接入 materialize 的 installer 会在 import/expand 时
  // 安装默认值，却不会在 `zrig up` 时安装。此约束用一个包含 topology/ 默认值的真实临时规范
  // 目录驱动 instantiate()，并断言文件落到真实文件系统中解析后的 topology root 下。
  it("r2-B1：instantiate() 作为 rig-up 入口，会在 topology.root 下安装规范的拓扑默认值", async () => {
    const realFs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const specDir = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "s06-spec-"));
    const topoRoot = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "s06-topo-"));
    try {
      realFs.mkdirSync(nodePath.join(specDir, "topology", "rig"), { recursive: true });
      realFs.mkdirSync(nodePath.join(specDir, "topology", "instance"), { recursive: true });
      realFs.writeFileSync(nodePath.join(specDir, "topology", "rig", "CRAFT.md"), "rig default", "utf-8");
      realFs.writeFileSync(nodePath.join(specDir, "topology", "instance", "CRAFT.md"), "instance default", "utf-8");

      const files = { [`${specDir}/agents/impl/agent.yaml`]: agentYaml("impl") };
      const { db, inst } = setup(files, undefined, () => topoRoot);
      const yaml = RigSpecCodec.serialize(makeRigSpec());
      const result = await inst.instantiate(yaml, specDir);
      expect(result.ok).toBe(true);
      // 入口证明：rig-up 后，默认值存在于真实文件系统。
      expect(realFs.readFileSync(nodePath.join(topoRoot, "rigs", "test-rig", "CRAFT.md"), "utf-8")).toBe("rig default");
      expect(realFs.readFileSync(nodePath.join(topoRoot, "CRAFT.md"), "utf-8")).toBe("instance default");
      db.close();
    } finally {
      realFs.rmSync(specDir, { recursive: true, force: true });
      realFs.rmSync(topoRoot, { recursive: true, force: true });
    }
  });

  it("r2-B1 对照：没有 topologyRootResolver 时 instantiate() 不安装内容且仍成功", async () => {
    const realFs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const specDir = realFs.mkdtempSync(nodePath.join(os.tmpdir(), "s06-spec-"));
    try {
      realFs.mkdirSync(nodePath.join(specDir, "topology", "rig"), { recursive: true });
      realFs.writeFileSync(nodePath.join(specDir, "topology", "rig", "CRAFT.md"), "x", "utf-8");
      const files = { [`${specDir}/agents/impl/agent.yaml`]: agentYaml("impl") };
      const { db, inst } = setup(files);
      const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), specDir);
      expect(result.ok).toBe(true);
      db.close();
    } finally {
      realFs.rmSync(specDir, { recursive: true, force: true });
    }
  });
});
