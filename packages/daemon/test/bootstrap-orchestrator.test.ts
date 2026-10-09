import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import { BootstrapRepository } from "../src/domain/bootstrap-repository.js";
import { RuntimeVerifier } from "../src/domain/runtime-verifier.js";
import { RequirementsProbeRegistry } from "../src/domain/requirements-probe.js";
import { ExternalInstallPlanner } from "../src/domain/external-install-planner.js";
import { ExternalInstallExecutor } from "../src/domain/external-install-executor.js";
import { PackageInstallService } from "../src/domain/package-install-service.js";
import { PackageRepository } from "../src/domain/package-repository.js";
import { InstallRepository } from "../src/domain/install-repository.js";
import { InstallEngine } from "../src/domain/install-engine.js";
import { InstallVerifier } from "../src/domain/install-verifier.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { FsOps } from "../src/domain/package-resolver.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


const SIMPLE_SPEC_YAML = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

const SPEC_WITH_PACKAGES_YAML = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - ./test-pkg
edges: []
`.trim();

const VALID_MANIFEST_YAML = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: A test package
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/helper
      name: helper
      supported_scopes:
        - project_shared
      default_scope: project_shared
`.trim();

function createMockExec(responses: Record<string, string | Error>): ExecFn {
  return vi.fn(async (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    throw new Error("command not found");
  }) as unknown as ExecFn;
}

// 返回成功的最小 mock RigInstantiator。
function createMockInstantiator(db: Database.Database) {
  return {
    db,
    async instantiate() {
      return {
        ok: true as const,
        result: { rigId: "rig-1", specName: "test-rig", specVersion: "1.0", nodes: [{ logicalId: "dev", status: "launched" as const }] },
      };
    },
  };
}

function createMockFailInstantiator(db: Database.Database) {
  return {
    db,
    async instantiate() {
      return { ok: false as const, code: "preflight_failed" as const, errors: ["tmux not found"], warnings: [] };
    },
  };
}

describe("BootstrapOrchestrator", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSpec(yaml: string): string {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, yaml);
    return specPath;
  }

  function writePkg(dir: string, manifestYaml: string, files?: Record<string, string>): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.yaml"), manifestYaml);
    if (files) {
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
    }
  }

  function realFsOps(): FsOps {
    return {
      readFile: (p) => fs.readFileSync(p, "utf-8"),
      exists: (p) => fs.existsSync(p),
      listFiles: (dirPath) => {
        const results: string[] = [];
        function walk(dir: string, prefix: string) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(dir, entry.name), path.join(prefix, entry.name));
            else results.push(prefix ? path.join(prefix, entry.name) : entry.name);
          }
        }
        walk(dirPath, "");
        return results;
      },
    };
  }

  function realEngineFsOps() {
    return {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
      mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
      copyFile: (s: string, d: string) => fs.copyFileSync(s, d),
      deleteFile: (p: string) => fs.unlinkSync(p),
    };
  }

  function buildOrchestrator(opts?: { exec?: ExecFn; instantiator?: unknown; podInstantiator?: unknown }) {
    const exec = opts?.exec ?? createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "codex --version": "codex 0.5.0",
      "cmux capabilities": '{"workspaces":true}',
      "command -v": "/usr/local/bin/tool",
      "brew install": "installed",
      "brew list": new Error("not found"),
    });

    const bootstrapRepo = new BootstrapRepository(db);
    const runtimeVerifier = new RuntimeVerifier({ exec, db });
    const probeRegistry = new RequirementsProbeRegistry(exec, { platform: "darwin" });
    const installPlanner = new ExternalInstallPlanner({ platform: "darwin" });
    const installExecutor = new ExternalInstallExecutor({ exec, db });
    const packageRepo = new PackageRepository(db);
    const installRepo = new InstallRepository(db);
    const installEngine = new InstallEngine(installRepo, realEngineFsOps());
    const installVerifier = new InstallVerifier(installRepo, packageRepo, {
      readFile: (p) => fs.readFileSync(p, "utf-8"),
      exists: (p) => fs.existsSync(p),
    });
    const packageInstallService = new PackageInstallService({ packageRepo, installRepo, installEngine, installVerifier });
    const instantiator = opts?.instantiator ?? createMockInstantiator(db);

    return new BootstrapOrchestrator({
      db,
      bootstrapRepo,
      runtimeVerifier,
      probeRegistry,
      installPlanner,
      installExecutor,
      packageInstallService,
      rigInstantiator: instantiator as any,
      fsOps: realFsOps(),
      bundleSourceResolver: null,
      podInstantiator: opts?.podInstantiator as any,
    });
  }

  // T1：plan 模式返回计划，bootstrap_actions 为 0 行。
  it("plan 模式返回计划且 bootstrap_actions 为 0 行", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("planned");
    expect(result.stages.length).toBeGreaterThan(0);

    const actions = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ?")
      .all(result.runId) as Array<{ action_kind: string }>;
    expect(actions).toHaveLength(0);
  });

  it("pod-aware plan 从已配置 catalog 解析仅 selector 指定的技能", async () => {
    const catalog = path.join(tmpDir, "managed-skills");
    const project = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(tmpDir, "agents", "impl"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "agents", "shared"), { recursive: true });
    fs.mkdirSync(path.join(catalog, "topology-skill"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "agents", "impl", "agent.yaml"), `name: impl
version: "1.0.0"
imports:
  - ref: local:../shared
resources:
  skills: []
profiles:
  default:
    uses:
      skills: [topology-skill]
`);
    fs.writeFileSync(
      path.join(tmpDir, "agents", "shared", "agent.yaml"),
      "name: shared\nversion: \"1.0.0\"\nresources:\n  skills: []\nprofiles: {}\n",
    );
    fs.writeFileSync(path.join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
    fs.writeFileSync(
      path.join(catalog, "topology-skill", "SKILL.md"),
      "---\nname: topology-skill\ndescription: Use when testing bootstrap plan catalog resolution.\n---\n\n# Topology skill\n",
    );
    execFileSync("git", ["-C", catalog, "init", "-q"]);
    execFileSync("git", ["-C", catalog, "config", "user.email", "test@openrig.invalid"]);
    execFileSync("git", ["-C", catalog, "config", "user.name", "OpenRig Test"]);
    execFileSync("git", ["-C", catalog, "add", "."]);
    execFileSync("git", ["-C", catalog, "commit", "-qm", "fixture"]);

    const specPath = writeSpec(`version: "0.2"
name: selector-plan-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: codex
        cwd: ${JSON.stringify(project)}
    edges: []
edges: []
`);
    const resolveSkillsRoot = vi.fn(() => catalog);
    const podInstantiator = {
      db,
      deps: { fsOps: realFsOps() },
      resolveSkillsRoot,
      instantiate: vi.fn(),
    };
    const orch = buildOrchestrator({ podInstantiator });

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath, sourceKind: "rig_spec" });

    expect(result.status, JSON.stringify(result.errors)).toBe("planned");
    expect(result.stages.find((stage) => stage.stage === "preflight")?.status).toBe("ok");
    expect(resolveSkillsRoot).toHaveBeenCalledOnce();
  });

  // T2：apply --yes 执行全部 stage。
  it("apply --yes 执行全部 stage 并完成", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("completed");
    expect(result.rigId).toBeTruthy();
    expect(result.stages.some((s) => s.stage === "resolve_spec")).toBe(true);
    expect(result.stages.some((s) => s.stage === "import_rig")).toBe(true);
  });

  // T3：runtime not_found → blocked。
  it("缺少必需 runtime 时阻止 apply", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const exec = createMockExec({}); // All commands fail
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("未找到"))).toBe(true);
  });

  // T4：plan 中缺少 requirement。
  it("缺失 requirement 会出现在 plan stage", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifestWithReqs = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: missing-tool
`.trim();
    writePkg(pkgDir, manifestWithReqs, { "skills/h/SKILL.md": "# H" });

    const specYaml = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - ./test-pkg
edges: []
`.trim();
    const specPath = writeSpec(specYaml);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'missing-tool'": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("planned");
    const planStage = result.stages.find((s) => s.stage === "build_install_plan");
    expect(planStage).toBeDefined();
  });

  // T6：package install 使用 Phase 4 engine。
  it("package install 通过 bootstrap_id 关联 bootstrap", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": "# Helper" });

    const specYaml = SPEC_WITH_PACKAGES_YAML;
    const specPath = writeSpec(specYaml);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("completed");

    // 检查 package_installs 已设置 bootstrap_id。
    const installs = db.prepare("SELECT * FROM package_installs WHERE bootstrap_id = ?")
      .all(result.runId) as Array<{ id: string; bootstrap_id: string }>;
    expect(installs.length).toBeGreaterThan(0);
    expect(installs[0]!.bootstrap_id).toBe(result.runId);
  });

  // T9：Bootstrap run 状态迁移。
  it("bootstrap run 以正确状态持久化", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    const run = db.prepare("SELECT * FROM bootstrap_runs WHERE id = ?")
      .get(result.runId) as { status: string; rig_id: string | null };
    expect(run.status).toBe("completed");
    expect(run.rig_id).toBeTruthy();
  });

  // T12：manual_only 阻止 apply。
  it("manual_only requirement 阻止 apply", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifestWithSysPkg = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  system_packages:
    - name: libssl
`.trim();
    writePkg(pkgDir, manifestWithSysPkg, { "skills/h/SKILL.md": "# H" });

    const specYaml = SPEC_WITH_PACKAGES_YAML;
    const specPath = writeSpec(specYaml);

    // 非 darwin 平台，因此 system_packages → unsupported → manual_only。
    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "command -v": "/usr/bin/tool",
    });
    const bootstrapRepo = new BootstrapRepository(db);
    const runtimeVerifier = new RuntimeVerifier({ exec, db });
    const probeRegistry = new RequirementsProbeRegistry(exec, { platform: "linux" });
    const installPlanner = new ExternalInstallPlanner({ platform: "linux" });
    const installExecutor = new ExternalInstallExecutor({ exec, db });
    const packageRepo = new PackageRepository(db);
    const installRepo = new InstallRepository(db);
    const installEngine = new InstallEngine(installRepo, realEngineFsOps());
    const installVerifier = new InstallVerifier(installRepo, packageRepo, {
      readFile: (p) => fs.readFileSync(p, "utf-8"),
      exists: (p) => fs.existsSync(p),
    });
    const packageInstallService = new PackageInstallService({ packageRepo, installRepo, installEngine, installVerifier });

    const orch = new BootstrapOrchestrator({
      db, bootstrapRepo, runtimeVerifier, probeRegistry, installPlanner, installExecutor,
      packageInstallService, rigInstantiator: createMockInstantiator(db) as any, fsOps: realFsOps(),
    });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("仅允许手动处理"))).toBe(true);
  });

  // T15：相对 packageRef 按 spec 文件目录解析。
  it("相对 packageRef 按 spec 文件目录解析", async () => {
    const subDir = path.join(tmpDir, "specs");
    fs.mkdirSync(subDir, { recursive: true });
    const pkgDir = path.join(subDir, "my-pkg");
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": "# Helper" });

    const specYaml = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - ./my-pkg
edges: []
`.trim();
    const specPath = path.join(subDir, "rig.yaml");
    fs.writeFileSync(specPath, specYaml);

    const orch = buildOrchestrator();
    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("planned");
    const resolveStage = result.stages.find((s) => s.stage === "resolve_packages");
    expect(resolveStage?.status).toBe("ok");
  });

  // T17：db handle 不匹配时构造即抛错。
  it("db handle 不匹配时构造即抛错", () => {
    const db2 = createDb();
    migrate(db2, ALL_MIGRATIONS);

    expect(() => {
      new BootstrapOrchestrator({
        db,
        bootstrapRepo: new BootstrapRepository(db2), // Wrong db
        runtimeVerifier: new RuntimeVerifier({ exec: vi.fn() as any, db }),
        probeRegistry: new RequirementsProbeRegistry(vi.fn() as any),
        installPlanner: new ExternalInstallPlanner(),
        installExecutor: new ExternalInstallExecutor({ exec: vi.fn() as any, db }),
        packageInstallService: { db } as any,
        rigInstantiator: { db } as any,
        fsOps: realFsOps(),
      });
    }).toThrow(/共享同一个数据库句柄/);

    db2.close();
  });

  // T18：阻止 github: ref。
  it("github: packageRef 被结构化错误阻止", async () => {
    const specYaml = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - github:example/pkg@v1
edges: []
`.trim();
    const specPath = writeSpec(specYaml);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("不支持的软件包引用 scheme"))).toBe(true);
  });

  // T14：Plan 包含全部 stage 类型。
  it("plan 包含 runtime、requirement 与 install plan stage", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    const stageNames = result.stages.map((s) => s.stage);
    expect(stageNames).toContain("resolve_spec");
    expect(stageNames).toContain("resolve_packages");
    expect(stageNames).toContain("verify_runtimes");
    expect(stageNames).toContain("probe_requirements");
    expect(stageNames).toContain("build_install_plan");
  });

  // T19：存在外部安装时，不带 --yes 和 approvedActionKeys 的裸 apply 会阻塞。
  it("存在外部安装但未提供批准时，裸 apply 会阻塞", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifestWithReqs = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: missing-tool
`.trim();
    writePkg(pkgDir, manifestWithReqs, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'missing-tool'": new Error("not found"),
      "brew list": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    // 不带 --yes 或 approvedActionKeys 执行 apply。
    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("需要批准"))).toBe(true);
    expect(result.stages.some((s) => s.stage === "execute_external_installs" && s.status === "blocked")).toBe(true);
  });

  // T5：执行已批准外部安装，并写 journal。
  it("执行已批准外部安装，并记录到 bootstrap_actions", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: rg
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'rg'": new Error("not found"),
      "brew list": new Error("not found"),
      "brew install": "installed",
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    const actions = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ? AND action_kind = ?")
      .all(result.runId, "external_install") as Array<{ subject_name: string; status: string }>;
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.some((a) => a.subject_name === "rg")).toBe(true);
  });

  // T7：工作组 import 使用 instantiator。
  it("工作组 import 使用 Phase 3 instantiator 并记录结果", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.rigId).toBe("rig-1");
    const importActions = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ? AND action_kind = ?")
      .all(result.runId, "rig_import") as Array<{ subject_name: string; status: string }>;
    expect(importActions).toHaveLength(1);
    expect(importActions[0]!.status).toBe("completed");
  });

  // T8：部分外部安装失败后继续。
  it("部分外部安装失败后继续，status = partial", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: fail-tool
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("tmux -V")) return "tmux 3.4";
      if (cmd.includes("claude --version")) return "claude 1.0.0";
      if (cmd.includes("command -v")) throw new Error("not found");
      if (cmd.includes("brew list")) throw new Error("not found");
      if (cmd.includes("brew install")) throw new Error("brew: failed to install");
      throw new Error("unknown");
    }) as unknown as ExecFn;
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    // 外部安装失败 + 工作组 import 成功 → partial。
    expect(result.status).toBe("partial");
    // 工作组 import 仍应发生。
    expect(result.stages.some((s) => s.stage === "import_rig" && s.status === "ok")).toBe(true);
  });

  // T10：全部 action 按 seq 顺序写 journal。
  it("全部 action 以正确 seq 顺序写入 journal", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    const actions = db.prepare("SELECT * FROM bootstrap_actions WHERE bootstrap_id = ? ORDER BY seq ASC")
      .all(result.runId) as Array<{ seq: number; action_kind: string }>;
    // 至少应包含 runtime check 与 rig_import。
    expect(actions.length).toBeGreaterThanOrEqual(2);
    // Seq 应严格递增。
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i]!.seq).toBeGreaterThan(actions[i - 1]!.seq);
    }
  });

  // T11：--yes 自动批准 auto_approvable action（含真实外部安装）。
  it("--yes 自动批准 auto_approvable action，executor 执行它", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: missing-cli
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const brewInstalls: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("tmux -V")) return "tmux 3.4";
      if (cmd.includes("claude --version")) return "claude 1.0.0";
      if (cmd.includes("command -v")) throw new Error("not found");
      if (cmd.includes("brew list")) throw new Error("not found");
      if (cmd.includes("brew install")) { brewInstalls.push(cmd); return "ok"; }
      throw new Error("unknown");
    }) as unknown as ExecFn;
    const orch = buildOrchestrator({ exec });

    // 若无 --yes，此处会阻塞。
    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    // --yes 应自动批准，executor 应执行 brew install。
    expect(brewInstalls.length).toBeGreaterThanOrEqual(1);
    expect(brewInstalls[0]).toContain("missing-cli");
  });

  // T16：orchestrator 与 executor 写入行的混合 seq 顺序（startSeq 交接）。
  it("runtime_check、external_install、package_install、rig_import 使用统一混合 seq 顺序", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: rg
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'rg'": new Error("not found"),
      "brew list": new Error("not found"),
      "brew install": "installed",
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    const actions = db.prepare("SELECT action_kind, seq FROM bootstrap_actions WHERE bootstrap_id = ? ORDER BY seq")
      .all(result.runId) as Array<{ action_kind: string; seq: number }>;

    // 应包含 runtime_check、requirement_check、external_install、package_install、rig_import；
    // 所有 seq 严格递增，orchestrator 与 executor 行之间无断档。
    const kinds = actions.map((a) => a.action_kind);
    expect(kinds).toContain("runtime_check");
    expect(kinds).toContain("external_install"); // Written by executor with startSeq
    expect(kinds).toContain("rig_import");
    // Seq 严格递增。
    for (let i = 1; i < actions.length; i++) {
      expect(actions[i]!.seq).toBeGreaterThan(actions[i - 1]!.seq);
    }
    // runtime check 先于 external_install，后者先于 rig_import。
    const firstRuntime = actions.findIndex((a) => a.action_kind === "runtime_check");
    const firstExternal = actions.findIndex((a) => a.action_kind === "external_install");
    const firstRigImport = actions.findIndex((a) => a.action_kind === "rig_import");
    expect(firstRuntime).toBeLessThan(firstExternal);
    expect(firstExternal).toBeLessThan(firstRigImport);
  });

  // T20：选择性执行 approvedActionKeys。
  it("apply 使用 approvedActionKeys 选择特定 action 执行", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: tool-a
    - name: tool-b
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const execCalls: string[] = [];
    const exec = vi.fn(async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.includes("tmux -V")) return "tmux 3.4";
      if (cmd.includes("claude --version")) return "claude 1.0.0";
      if (cmd.includes("command -v")) throw new Error("not found");
      if (cmd.includes("brew list")) throw new Error("not found");
      if (cmd.includes("brew install")) return "ok";
      throw new Error("unknown");
    }) as unknown as ExecFn;
    const orch = buildOrchestrator({ exec });

    // 只批准 tool-a。
    const result = await orch.bootstrap({
      mode: "apply",
      sourceRef: specPath,
      approvedActionKeys: ["external_install:cli_tool:tool-a"],
    });

    // 应执行 tool-a，跳过 tool-b。
    const brewInstalls = execCalls.filter((c) => c.includes("brew install"));
    expect(brewInstalls.some((c) => c.includes("tool-a"))).toBe(true);
    expect(brewInstalls.some((c) => c.includes("tool-b"))).toBe(false);
  });

  // T21：真实外部安装中出现未知批准 action key → 阻塞。
  it("真实安装使用无效 approvedActionKeys 时仍阻塞", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: missing-tool
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'missing-tool'": new Error("not found"),
      "brew list": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    // 只提供无效 key；没有真实 action 获批，因此仍应阻塞。
    const result = await orch.bootstrap({
      mode: "apply",
      sourceRef: specPath,
      approvedActionKeys: ["external_install:cli_tool:nonexistent"],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.includes("需要批准"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("未知的已批准操作键"))).toBe(true);
  });

  // T22：两个 package 的重叠 requirement 去重。
  it("多个 package 的重叠 requirement 去重为一个 action", async () => {
    // 创建两个都依赖 'ripgrep' 的 package。
    const pkg1Dir = path.join(tmpDir, "pkg-a");
    const pkg2Dir = path.join(tmpDir, "pkg-b");
    const manifest1 = `
schema_version: 1
name: pkg-a
version: "1.0.0"
summary: Package A
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/a
      name: a
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: ripgrep
`.trim();
    const manifest2 = `
schema_version: 1
name: pkg-b
version: "1.0.0"
summary: Package B
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/b
      name: b
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: ripgrep
`.trim();
    writePkg(pkg1Dir, manifest1, { "skills/a/SKILL.md": "# A" });
    writePkg(pkg2Dir, manifest2, { "skills/b/SKILL.md": "# B" });

    const specYaml = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev1
    runtime: claude-code
    package_refs:
      - ./pkg-a
  - id: dev2
    runtime: claude-code
    package_refs:
      - ./pkg-b
edges: []
`.trim();
    const specPath = writeSpec(specYaml);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'ripgrep'": new Error("not found"),
      "brew list": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    expect(result.status).toBe("planned");
    const planStage = result.stages.find((s) => s.stage === "build_install_plan");
    const detail = planStage?.detail as { actions: Array<{ requirementName: string }> };
    // ripgrep 应去重为 1 个 action，而不是 2 个。
    const ripgrepActions = detail.actions.filter((a) => a.requirementName === "ripgrep");
    expect(ripgrepActions).toHaveLength(1);
  });

  // T23：plan probe_requirements.detail 包含逐 requirement 结果。
  it("plan 的 probe_requirements detail 包含带 status 的逐 requirement 结果", async () => {
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: test-pkg
version: "1.0.0"
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
requirements:
  cli_tools:
    - name: git
    - name: missing-tool
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
      "'git'": "/usr/bin/git",
      "'missing-tool'": new Error("not found"),
    });
    const orch = buildOrchestrator({ exec });

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath });

    const reqStage = result.stages.find((s) => s.stage === "probe_requirements");
    expect(reqStage).toBeDefined();
    const detail = reqStage!.detail as { probed: number; results: Array<{ name: string; kind: string; status: string; detectedPath: string | null }> };
    expect(detail.probed).toBe(2);
    expect(detail.results).toHaveLength(2);

    const gitResult = detail.results.find((r) => r.name === "git");
    expect(gitResult).toBeDefined();
    expect(gitResult!.status).toBe("installed");
    expect(gitResult!.detectedPath).toBeTruthy();

    const missingResult = detail.results.find((r) => r.name === "missing-tool");
    expect(missingResult).toBeDefined();
    expect(missingResult!.status).toBe("missing");
  });

  // T24：Package 安装失败时跳过工作组 import（R1-F4.3）。
  it("package 安装失败时跳过工作组 import，并设置 status=failed", async () => {
    // 创建一个会因 runtime 不兼容而安装失败的 package。
    const pkgDir = path.join(tmpDir, "test-pkg");
    const manifest = `
schema_version: 1
name: codex-only-pkg
version: "1.0.0"
summary: Only works on codex
compatibility:
  runtimes:
    - codex
exports:
  skills:
    - source: skills/h
      name: h
      supported_scopes: [project_shared]
      default_scope: project_shared
`.trim();
    writePkg(pkgDir, manifest, { "skills/h/SKILL.md": "# H" });
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    const orch = buildOrchestrator();
    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, autoApprove: true });

    expect(result.status).toBe("failed");
    // 应跳过 import_rig。
    const importStage = result.stages.find((s) => s.stage === "import_rig");
    expect(importStage?.status).toBe("skipped");
    expect(result.errors.some((e) => e.includes("已跳过"))).toBe(true);
  });

  // === P7-T05：Bundle 来源测试 ===

  // T25：真实 bundle bootstrap 正常路径。
  it("从 rig_bundle bootstrap 可解析 vendored package", async () => {
    // 创建真实 bundle。
    const { LegacyBundleAssembler: BundleAssembler } = await import("../src/domain/bundle-assembler.js"); // TODO: AS-T12
    const { computeIntegrity, writeIntegrity } = await import("../src/domain/bundle-integrity.js");
    const { pack } = await import("../src/domain/bundle-archive.js");
    const { LegacyBundleSourceResolver: BundleSourceResolver } = await import("../src/domain/bundle-source-resolver.js"); // TODO: AS-T12

    // 写入 package 来源。
    const pkgDir = path.join(tmpDir, "src-pkg");
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": "# Helper" });

    // 写入 spec。
    const specPath = writeSpec(SPEC_WITH_PACKAGES_YAML);

    // 组装 bundle。
    const staging = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({
      fsOps: {
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        exists: (p: string) => fs.existsSync(p),
        mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
        writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
        copyDir: (s: string, d: string) => fs.cpSync(s, d, { recursive: true }),
      },
    });
    assembler.assemble({
      specPath, outputDir: staging, bundleName: "test-bundle", bundleVersion: "0.1.0",
      packages: [{ name: "test-pkg", version: "1.0.0", sourcePath: pkgDir, originalSource: "./test-pkg", manifestHash: "h1" }],
    });

    // 添加完整性信息。
    const integrityFsOps = {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      readFileBuffer: (p: string) => fs.readFileSync(p),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
      walkFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(path.join(d, e.name), pre ? `${pre}/${e.name}` : e.name); else r.push(pre ? `${pre}/${e.name}` : e.name); } } w(dir, ""); return r; },
    };
    const integrity = computeIntegrity(staging, integrityFsOps);
    writeIntegrity(staging, integrity, integrityFsOps);

    // 打包。
    const bundlePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, bundlePath);

    // 从 bundle 执行 bootstrap。
    const bundleResolver = new BundleSourceResolver({ fsOps: realFsOps() });
    const exec = createMockExec({
      "tmux -V": "tmux 3.4",
      "claude --version": "claude 1.0.0",
    });
    const bootstrapRepo = new (await import("../src/domain/bootstrap-repository.js")).BootstrapRepository(db);
    const runtimeVerifier = new (await import("../src/domain/runtime-verifier.js")).RuntimeVerifier({ exec, db });
    const probeRegistry = new (await import("../src/domain/requirements-probe.js")).RequirementsProbeRegistry(exec, { platform: "darwin" });
    const installPlanner = new (await import("../src/domain/external-install-planner.js")).ExternalInstallPlanner({ platform: "darwin" });
    const installExecutor = new (await import("../src/domain/external-install-executor.js")).ExternalInstallExecutor({ exec, db });
    const packageRepo = new (await import("../src/domain/package-repository.js")).PackageRepository(db);
    const installRepo = new (await import("../src/domain/install-repository.js")).InstallRepository(db);
    const installEngine = new (await import("../src/domain/install-engine.js")).InstallEngine(installRepo, realEngineFsOps());
    const installVerifier = new (await import("../src/domain/install-verifier.js")).InstallVerifier(installRepo, packageRepo, { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) });
    const packageInstallService = new (await import("../src/domain/package-install-service.js")).PackageInstallService({ packageRepo, installRepo, installEngine, installVerifier });

    const { BootstrapOrchestrator: BO } = await import("../src/domain/bootstrap-orchestrator.js");
    const orch = new BO({
      db, bootstrapRepo, runtimeVerifier, probeRegistry,
      installPlanner, installExecutor: installExecutor, packageInstallService,
      rigInstantiator: createMockInstantiator(db) as any,
      fsOps: realFsOps(),
      bundleSourceResolver: bundleResolver,
    });

    const result = await orch.bootstrap({ mode: "plan", sourceRef: bundlePath, sourceKind: "rig_bundle" });

    expect(result.status).toBe("planned");
    expect(result.stages.some((s) => s.stage === "resolve_spec" && s.status === "ok")).toBe(true);
    expect(result.stages.some((s) => s.stage === "resolve_packages" && s.status === "ok")).toBe(true);

    // 验证已记录 source_kind。
    const run = db.prepare("SELECT source_kind FROM bootstrap_runs WHERE id = ?")
      .get(result.runId) as { source_kind: string };
    expect(run.source_kind).toBe("rig_bundle");

    // 验证 orchestrator 的 finally 已清理临时目录。plan 完成后不应残留本测试创建的
    // rigbundle- 临时目录。
    const tmpBase = os.tmpdir();
    const leakedDirs = fs.readdirSync(tmpBase).filter((d) =>
      d.startsWith("rigbundle-") && fs.existsSync(path.join(tmpBase, d, "bundle.yaml"))
    );
    expect(leakedDirs).toHaveLength(0);
  });

  // T26：rig_bundle 的 resolver 为 null 时抛错。
  it("rig_bundle 使用 null bundleSourceResolver 时抛错", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    await expect(
      orch.bootstrap({ mode: "plan", sourceRef: specPath, sourceKind: "rig_bundle" })
    ).rejects.toThrow(/需要 BundleSourceResolver/);
  });

  // T26：bootstrap_runs 从 options 记录 source_kind。
  it("bootstrap_runs 从 options 记录 source_kind", async () => {
    const specPath = writeSpec(SIMPLE_SPEC_YAML);
    const orch = buildOrchestrator();

    const result = await orch.bootstrap({ mode: "plan", sourceRef: specPath, sourceKind: "rig_spec" });

    const run = db.prepare("SELECT source_kind FROM bootstrap_runs WHERE id = ?")
      .get(result.runId) as { source_kind: string };
    expect(run.source_kind).toBe("rig_spec");
  });

  it("实例化前以诚实错误拒绝服务后端 pod-bundle 启动", async () => {
    const { pack } = await import("../src/domain/bundle-archive.js");
    const { computeIntegrity } = await import("../src/domain/bundle-integrity.js");
    const { PodBundleSourceResolver } = await import("../src/domain/bundle-source-resolver.js");

    // 构建一个带服务后端工作组 spec 的最小 v2 pod bundle。
    const staging = path.join(tmpDir, "svc-bundle-staging");
    fs.mkdirSync(staging, { recursive: true });

    const svcSpecYaml = `
version: "0.2"
name: svc-bundle-rig
summary: A service-backed rig in a bundle
services:
  kind: compose
  compose_file: svc.compose.yaml
  wait_for:
    - url: http://127.0.0.1:8200/health
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        runtime: claude-code
        profile: default
        cwd: .
    edges: []
edges: []
`.trim();
    fs.writeFileSync(path.join(staging, "rig.yaml"), svcSpecYaml);
    fs.writeFileSync(path.join(staging, "svc.compose.yaml"), "version: '3.8'\nservices:\n  vault:\n    image: hashicorp/vault:1.15\n");
    // 写入 bundle.yaml 前计算内容文件完整性。
    const integrityFsOps = {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      readFileBuffer: (p: string) => fs.readFileSync(p),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
      walkFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(path.join(d, e.name), pre ? `${pre}/${e.name}` : e.name); else r.push(pre ? `${pre}/${e.name}` : e.name); } } w(dir, ""); return r; },
    };
    const integrity = computeIntegrity(staging, integrityFsOps);
    const integrityYaml = `  algorithm: ${integrity.algorithm}\n  files:\n` +
      Object.entries(integrity.files).map(([k, v]) => `    ${k}: ${v}`).join("\n");

    fs.writeFileSync(path.join(staging, "bundle.yaml"), `
schema_version: 2
name: svc-bundle
version: "0.1.0"
created_at: "2026-04-09T00:00:00Z"
rig_spec: rig.yaml
agents: []
integrity:
${integrityYaml}
`.trim());

    const bundlePath = path.join(tmpDir, "svc-test.rigbundle");
    await pack(staging, bundlePath);

    // 测试前记录既有 podbundle- 目录。
    const tmpBase = os.tmpdir();
    const preExistingDirs = new Set(fs.readdirSync(tmpBase).filter((d) => d.startsWith("podbundle-")));

    const podBundleResolver = new PodBundleSourceResolver();
    const { LegacyBundleSourceResolver: BundleSourceResolver } = await import("../src/domain/bundle-source-resolver.js");
    const legacyBundleResolver = new BundleSourceResolver({ fsOps: realFsOps() });
    const mockPodInstantiator = { db, instantiate: vi.fn() };

    const orch = new BootstrapOrchestrator({
      db,
      bootstrapRepo: new BootstrapRepository(db),
      runtimeVerifier: new RuntimeVerifier({ exec: createMockExec({}), db }),
      probeRegistry: new RequirementsProbeRegistry(createMockExec({})),
      installPlanner: new ExternalInstallPlanner(),
      installExecutor: new ExternalInstallExecutor({ exec: createMockExec({}), db }),
      packageInstallService: new PackageInstallService({
        packageRepo: new PackageRepository(db),
        installRepo: new InstallRepository(db),
        installEngine: new InstallEngine(new InstallRepository(db), realEngineFsOps()),
        installVerifier: new InstallVerifier(new InstallRepository(db), new PackageRepository(db), {
          readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p),
        }),
      }),
      rigInstantiator: createMockInstantiator(db) as any,
      fsOps: realFsOps(),
      bundleSourceResolver: legacyBundleResolver,
      podBundleSourceResolver: podBundleResolver as any,
      podInstantiator: mockPodInstantiator as any,
    });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: bundlePath, sourceKind: "rig_bundle" });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e: string) => e.includes("无法从 .rigbundle 归档启动由服务支持的 rig"))).toBe(true);
    const resolveStage = result.stages.find((s) => s.stage === "resolve_spec" && s.status === "failed");
    expect(resolveStage).toBeDefined();
    expect((resolveStage!.detail as Record<string, unknown>)["code"]).toBe("services_unsupported");
    // 不得调用 instantiate。
    expect(mockPodInstantiator.instantiate).not.toHaveBeenCalled();
    // 即使拒绝也必须清理临时目录；只检查本测试创建的目录。
    const postDirs = fs.readdirSync(tmpBase).filter((d) =>
      d.startsWith("podbundle-") && !preExistingDirs.has(d)
    );
    expect(postDirs).toHaveLength(0);
  });

  // AS-T08b：pod-aware 工作组 spec 委托给 podInstantiator。
  it("pod-aware 工作组 spec 通过 bootstrap 委托给 podInstantiator", async () => {
    const podSpecYaml = `
version: "0.2"
name: pod-test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();
    const specPath = path.join(tmpDir, "pod-spec.yaml");
    fs.writeFileSync(specPath, podSpecYaml);

    // Mock podInstantiator。
    const mockPodInstantiator = {
      db,
      instantiate: vi.fn(async () => ({
        ok: true as const,
        result: { rigId: "rig-pod-1", specName: "pod-test-rig", specVersion: "0.2", nodes: [{ logicalId: "dev.impl", status: "launched" as const }] },
      })),
    };

    const orch = new BootstrapOrchestrator({
      db,
      bootstrapRepo: new BootstrapRepository(db),
      runtimeVerifier: new RuntimeVerifier({ exec: createMockExec({}), db }),
      probeRegistry: new RequirementsProbeRegistry(createMockExec({})),
      installPlanner: new ExternalInstallPlanner(),
      installExecutor: new ExternalInstallExecutor({ exec: createMockExec({}), db }),
      packageInstallService: new PackageInstallService({
        packageRepo: new PackageRepository(db),
        installRepo: new InstallRepository(db),
        installEngine: new InstallEngine(new InstallRepository(db), realEngineFsOps()),
        installVerifier: new InstallVerifier(new InstallRepository(db), new PackageRepository(db), {
          readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p),
        }),
      }),
      rigInstantiator: createMockInstantiator(db) as any,
      fsOps: realFsOps(),
      bundleSourceResolver: null,
      podInstantiator: mockPodInstantiator as any,
    });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, sourceKind: "rig_spec" });
    expect(result.status).toBe("completed");
    expect(result.rigId).toBe("rig-pod-1");
    expect(mockPodInstantiator.instantiate).toHaveBeenCalledTimes(1);
  });

  // --- Conveyor-Trust 最小修复（OPR.0.3.2.CT）——guard 判定
  //     qitem-20260518082933 BLOCKER 1: mixed launched+attention_required
  //     绝不能显示为 "completed"；orchestrator 必须让 attention_required 节点经过
  //     携带 attentionNodes 的 partial+blocked import_rig stage，使路由能构建三段式错误。

  it("OPR.0.3.2.CT 阻断项 1：launched + attention_required 混合 → status=partial，import_rig stage=blocked 且携带 attentionNodes", async () => {
    const podSpecYaml = `
version: "0.2"
name: pod-mixed-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
      - id: qa
        agent_ref: "local:agents/qa"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();
    const specPath = path.join(tmpDir, "pod-mixed-spec.yaml");
    fs.writeFileSync(specPath, podSpecYaml);

    const mockPodInstantiator = {
      db,
      instantiate: vi.fn(async () => ({
        ok: true as const,
        result: {
          rigId: "rig-mixed-1",
          specName: "pod-mixed-rig",
          specVersion: "0.2",
          nodes: [
            { logicalId: "dev.impl", status: "launched" as const, sessionName: "dev-impl@pod-mixed-rig" },
            { logicalId: "dev.qa", status: "attention_required" as const, error: "trust_gate on qa", sessionName: "dev-qa@pod-mixed-rig", evidence: "trust prompt visible" },
          ],
        },
      })),
    };

    const orch = new BootstrapOrchestrator({
      db,
      bootstrapRepo: new BootstrapRepository(db),
      runtimeVerifier: new RuntimeVerifier({ exec: createMockExec({}), db }),
      probeRegistry: new RequirementsProbeRegistry(createMockExec({})),
      installPlanner: new ExternalInstallPlanner(),
      installExecutor: new ExternalInstallExecutor({ exec: createMockExec({}), db }),
      packageInstallService: new PackageInstallService({
        packageRepo: new PackageRepository(db),
        installRepo: new InstallRepository(db),
        installEngine: new InstallEngine(new InstallRepository(db), realEngineFsOps()),
        installVerifier: new InstallVerifier(new InstallRepository(db), new PackageRepository(db), {
          readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p),
        }),
      }),
      rigInstantiator: createMockInstantiator(db) as any,
      fsOps: realFsOps(),
      bundleSourceResolver: null,
      podInstantiator: mockPodInstantiator as any,
    });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, sourceKind: "rig_spec" });

    // 阻断项 1：任一节点 attention_required 时不能是 "completed"。
    expect(result.status).toBe("partial");
    expect(result.rigId).toBe("rig-mixed-1");
    const importStage = result.stages.find((s) => s.stage === "import_rig");
    expect(importStage).toBeDefined();
    expect(importStage!.status).toBe("blocked");
    const detail = importStage!.detail as { code: string; message: string; attentionNodes: Array<{ logicalId: string; sessionName: string; evidence?: string }> };
    expect(detail.code).toBe("attention_required");
    expect(detail.message).toContain("检查受影响的会话");
    expect(detail.message).not.toMatch(/批准并恢复|并非失败/);
    expect(detail.attentionNodes.length).toBe(1);
    expect(detail.attentionNodes[0]!.logicalId).toBe("dev.qa");
    expect(detail.attentionNodes[0]!.sessionName).toBe("dev-qa@pod-mixed-rig");
    expect(detail.attentionNodes[0]!.evidence).toBe("trust prompt visible");
  });

  it("OPR.0.3.2.CT 阻断项 1：全部 launched（无 attention/failed）→ status=completed、import_rig=ok（无回归）", async () => {
    const podSpecYaml = `
version: "0.2"
name: pod-clean-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();
    const specPath = path.join(tmpDir, "pod-clean-spec.yaml");
    fs.writeFileSync(specPath, podSpecYaml);

    const mockPodInstantiator = {
      db,
      instantiate: vi.fn(async () => ({
        ok: true as const,
        result: {
          rigId: "rig-clean-1",
          specName: "pod-clean-rig",
          specVersion: "0.2",
          nodes: [{ logicalId: "dev.impl", status: "launched" as const, sessionName: "dev-impl@pod-clean-rig" }],
        },
      })),
    };

    const orch = new BootstrapOrchestrator({
      db,
      bootstrapRepo: new BootstrapRepository(db),
      runtimeVerifier: new RuntimeVerifier({ exec: createMockExec({}), db }),
      probeRegistry: new RequirementsProbeRegistry(createMockExec({})),
      installPlanner: new ExternalInstallPlanner(),
      installExecutor: new ExternalInstallExecutor({ exec: createMockExec({}), db }),
      packageInstallService: new PackageInstallService({
        packageRepo: new PackageRepository(db),
        installRepo: new InstallRepository(db),
        installEngine: new InstallEngine(new InstallRepository(db), realEngineFsOps()),
        installVerifier: new InstallVerifier(new InstallRepository(db), new PackageRepository(db), {
          readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p),
        }),
      }),
      rigInstantiator: createMockInstantiator(db) as any,
      fsOps: realFsOps(),
      bundleSourceResolver: null,
      podInstantiator: mockPodInstantiator as any,
    });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, sourceKind: "rig_spec" });
    expect(result.status).toBe("completed");
    const importStage = result.stages.find((s) => s.stage === "import_rig");
    expect(importStage!.status).toBe("ok");
  });

  it("OPR.0.3.2.CT 阻断项 1：全部 attention_required → status=partial、import_rig=blocked，并保留 rigId", async () => {
    const podSpecYaml = `
version: "0.2"
name: pod-all-attention-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();
    const specPath = path.join(tmpDir, "pod-all-attention-spec.yaml");
    fs.writeFileSync(specPath, podSpecYaml);

    // 所有节点都 parked 时，PodRigInstantiator 返回新的 attention_required 结果：
    // ok:false，并携带 rigId + attentionNodes。
    const mockPodInstantiator = {
      db,
      instantiate: vi.fn(async () => ({
        ok: false as const,
        code: "attention_required" as const,
        message: "1 node requires attention before becoming interactive (rig parked, NOT failed; approve and resume to proceed).",
        rigId: "rig-all-attention-1",
        attentionNodes: [{ logicalId: "dev.impl", sessionName: "dev-impl@pod-all-attention-rig", evidence: "trust prompt", reason: "trust_gate" }],
      })),
    };

    const orch = new BootstrapOrchestrator({
      db,
      bootstrapRepo: new BootstrapRepository(db),
      runtimeVerifier: new RuntimeVerifier({ exec: createMockExec({}), db }),
      probeRegistry: new RequirementsProbeRegistry(createMockExec({})),
      installPlanner: new ExternalInstallPlanner(),
      installExecutor: new ExternalInstallExecutor({ exec: createMockExec({}), db }),
      packageInstallService: new PackageInstallService({
        packageRepo: new PackageRepository(db),
        installRepo: new InstallRepository(db),
        installEngine: new InstallEngine(new InstallRepository(db), realEngineFsOps()),
        installVerifier: new InstallVerifier(new InstallRepository(db), new PackageRepository(db), {
          readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p),
        }),
      }),
      rigInstantiator: createMockInstantiator(db) as any,
      fsOps: realFsOps(),
      bundleSourceResolver: null,
      podInstantiator: mockPodInstantiator as any,
    });

    const result = await orch.bootstrap({ mode: "apply", sourceRef: specPath, sourceKind: "rig_spec" });
    expect(result.status).toBe("partial");
    expect(result.rigId).toBe("rig-all-attention-1");
    const importStage = result.stages.find((s) => s.stage === "import_rig");
    expect(importStage!.status).toBe("blocked");
    const detail = importStage!.detail as { code: string; attentionNodes: Array<{ logicalId: string }> };
    expect(detail.code).toBe("attention_required");
    expect(detail.attentionNodes.length).toBe(1);
  });
});
