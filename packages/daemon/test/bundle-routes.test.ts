import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { createTestApp } from "./helpers/test-app.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


const VALID_SPEC = `
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

const VALID_PKG = `
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
`.trim();

describe("捆绑 API 路由", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-routes-"));
    setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPackage(): { specPath: string } {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, VALID_SPEC);
    const pkgDir = path.join(tmpDir, "test-pkg");
    fs.mkdirSync(path.join(pkgDir, "skills/h"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.yaml"), VALID_PKG);
    fs.writeFileSync(path.join(pkgDir, "skills/h/SKILL.md"), "# H");
    return { specPath };
  }

  // T1：Create 返回元数据
  it("POST /api/bundles/create 返回包元数据", async () => {
    const { specPath } = seedPackage();
    const outputPath = path.join(tmpDir, "test.rigbundle");

    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "test", bundleVersion: "0.1.0", outputPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bundleName).toBe("test");
    expect(body.archiveHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  // Item 1 / slice-05：经 /create + /inspect 的出处往返
  it("POST /api/bundles/create 接受出处 + /inspect 表面（v1 往返）", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "prov-test.rigbundle");

    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "prov-test", bundleVersion: "0.1.0", outputPath: bundlePath,
        provenance: {
          sourceHost: "route-test-host",
          authorSession: "velocity-driver@openrig-velocity",
          cliVersion: "0.3.2",
          notes: "route-test fixture",
        },
      }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.provenance).toBeDefined();
    expect(inspectBody.manifest.provenance.sourceHost).toBe("route-test-host");
    expect(inspectBody.manifest.provenance.authorSession).toBe("velocity-driver@openrig-velocity");
    expect(inspectBody.manifest.provenance.cliVersion).toBe("0.3.2");
    expect(inspectBody.manifest.provenance.notes).toBe("route-test fixture");
    // 服务端 daemonVersion 注入——调用时从 daemon package.json 读取
    expect(typeof inspectBody.manifest.provenance.daemonVersion).toBe("string");
    expect(inspectBody.manifest.provenance.daemonVersion.length).toBeGreaterThan(0);
    // createdAt 从 root 镜像
    expect(inspectBody.manifest.provenance.createdAt).toBe(inspectBody.manifest.createdAt);
  });

  it("没有出处的 POST /api/bundles/create 会生成一个清单忽略出处的包（向后兼容）", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "no-prov.rigbundle");

    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "no-prov", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.provenance).toBeUndefined();
  });

  it("POST /api/bundles/create 拒绝遗留最终暂存树中不安全的生成来源", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "legacy-unsafe-generated.rigbundle");

    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath,
        bundleName: "legacy-unsafe-generated",
        bundleVersion: "0.1.0",
        outputPath: bundlePath,
        provenance: { notes: "See substrate/shared-docs/rigs/private for details." },
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/internal-path/);
    expect(body.error).toMatch(/bundle\.yaml/);
    expect(fs.existsSync(bundlePath)).toBe(false);
  });

  // T2: Inspect returns manifest
  it("POST /api/bundles/inspect 返回清单 + 完整性", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "test.rigbundle");

    // 先创建
    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "test", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    const res = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.name).toBe("test");
    expect(body.digestValid).toBe(true);
    expect(body.integrityResult.passed).toBe(true);
  });

  // T6：Create 发出 bundle.created 事件
  it("POST /api/bundles/create 发出 bundle.created 事件", async () => {
    const { specPath } = seedPackage();
    const outputPath = path.join(tmpDir, "evt.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "evt-bundle", bundleVersion: "1.0", outputPath }),
    });

    const events = db.prepare("SELECT type, payload FROM events WHERE type = 'bundle.created'").all() as Array<{ type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.bundleName).toBe("evt-bundle");
  });

  // T7：缺 specPath -> 400
  it("缺少specPath 的 POST /api/bundles/create 返回 400", async () => {
    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleName: "x", bundleVersion: "1.0", outputPath: "/tmp/x.rigbundle" }),
    });
    expect(res.status).toBe(400);
  });

  // T10：启动装配
  it("createDaemon 接入 bundle 路由", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app: daemonApp, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });
    try {
      // POST 无 body -> 400（证明路由已挂载）
      const res = await daemonApp.request("/api/bundles/create", { method: "POST" });
      expect(res.status).toBe(400);
    } finally {
      daemonDb.close();
    }
  });

  // T10b：不带 targetRoot 的 install apply -> 400
  it("没有 targetRoot 的 POST /api/bundles/install 对于 apply 返回 400", async () => {
    const res = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: "/tmp/x.rigbundle" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("targetRoot");
  });

  // T10c：无 targetRoot 的 Install --plan -> OK
  it("没有 targetRoot 的 POST /api/bundles/install plan 模式成功", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "plan.rigbundle");
    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "plan-test", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    // plan 模式——无需 targetRoot
    const res = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true }),
    });

    // 会失败，因为测试 app 没有真实 bundle resolver，但应越过 400 检查
    // plan 模式下路由不应因缺 targetRoot 返回 400
    expect(res.status).not.toBe(400);
  });

  // T4：用被篡改的 bundle inspect -> integrityResult.passed=false
  it("POST /api/bundles/inspect 从结构上报告完整性故障", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "tamper.rigbundle");

    // 创建合法 bundle
    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "tamper-test", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    // 通过追加字节篡改归档（破坏 digest，但 tar 仍可解压）
    fs.appendFileSync(bundlePath, Buffer.from([0]));
    // 更新 .sha256 以匹配被篡改的归档，使 digest 通过；但内容完整性应失败，因为 tar 内容未变
    // 实际上——往 tar.gz 追加字节可能损坏它。改为：只验证 inspect 路径返回 200 与结构化数据
    const res = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });

    // 应为 200 与结构化响应（非 500）；由于我们篡改过，digest 将无效
    const body = await res.json();
    // digestValid 应为 false（sha256 不匹配）
    expect(body.digestValid).toBe(false);
  });

  // T6-AS-T12：pod 感知的 bundle create
  it("使用 pod 感知规范的 POST /api/bundles/create 返回 schemaVersion:2", async () => {
    // 在磁盘上预置一个 pod 感知的 rig spec + agent
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent',
      'version: "1.0.0"',
      'resources:',
      '  skills: []',
      'profiles:',
      '  default:',
      '    uses:',
      '      skills: []',
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: pod-test-rig',
      'pods:',
      '  - id: dev',
      '    label: Dev',
      '    members:',
      '      - id: impl',
      '        agent_ref: "local:agents/impl"',
      '        profile: default',
      '        runtime: claude-code',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const outputPath = path.join(tmpDir, "pod.rigbundle");
    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "pod-test", bundleVersion: "0.1.0", outputPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schemaVersion).toBe(2);
    expect(body.bundleName).toBe("pod-test");
    expect(body.archiveHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("POST /api/bundles/create 接受内置终端 pod 成员", async () => {
    const specPath = path.join(tmpDir, "terminal-rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: terminal-test-rig',
      'pods:',
      '  - id: infra',
      '    label: Infra',
      '    members:',
      '      - id: daemon',
      '        agent_ref: "builtin:terminal"',
      '        profile: none',
      '        runtime: terminal',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const outputPath = path.join(tmpDir, "terminal.rigbundle");
    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "terminal-test", bundleVersion: "0.1.0", outputPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.schemaVersion).toBe(2);
    expect(body.agents).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  // T11-AS-T12：旧 bundle create 仍可用（回归护栏）
  it("使用旧规范的 POST /api/bundles/create 仍然有效", async () => {
    const { specPath } = seedPackage();
    const outputPath = path.join(tmpDir, "legacy.rigbundle");

    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "legacy-test", bundleVersion: "0.1.0", outputPath }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bundleName).toBe("legacy-test");
    expect(body.packages).toBeDefined();
    expect(body.schemaVersion).toBeUndefined();
  });

  // T11-AS-T12：v2 bundle install 走 pod 感知 bootstrap 路径
  it("使用 v2 包的 POST /api/bundles/install 进入 pod 感知路径", async () => {
    // 在磁盘上创建一个 v2 bundle
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
      'profiles:', '  default:', '    uses:', '      skills: []',
    ].join("\n"));
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"', 'name: v2-install-test', 'pods:', '  - id: dev', '    label: Dev',
      '    members:', '      - id: impl', '        agent_ref: "local:agents/impl"',
      '        profile: default', '        runtime: claude-code', '        cwd: .',
      '    edges: []', 'edges: []',
    ].join("\n"));
    const bundlePath = path.join(tmpDir, "v2-install.rigbundle");
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "v2-install", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });
    expect(createRes.status).toBe(201);

    // 安装 v2 bundle——测试 app 的 podInstantiator 带 mock fsOps，因此 agent 解析会失败，但 bootstrap 应检测到 v2 并进入 pod 感知路径
    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, targetRoot: tmpDir }),
    });
    const installBody = await installRes.json();
    // 结果应含 stages，证明进入了 pod 感知路径（resolve_spec stage 的 source 为 "pod_bundle"，或 bootstrap 经 handlePodAwareSpec 运行）
    expect(installBody.stages).toBeDefined();
    const resolveStage = installBody.stages.find((s: { stage: string }) => s.stage === "resolve_spec");
    expect(resolveStage).toBeDefined();
    expect(resolveStage.detail.source).toBe("pod_bundle");
  });

  // T9-AS-T14：inspect v2 bundle 返回 schemaVersion 2 与 agents 数组
  it("使用 v2 包的 POST /api/bundles/inspect 返回 schemaVersion 2 和智能体", async () => {
    // 在磁盘上创建一个 v2 bundle
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent',
      'version: "1.0.0"',
      'resources:',
      '  skills: []',
      'profiles:',
      '  default:',
      '    uses:',
      '      skills: []',
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: v2-inspect-test',
      'pods:',
      '  - id: dev',
      '    label: Dev',
      '    members:',
      '      - id: impl',
      '        agent_ref: "local:agents/impl"',
      '        profile: default',
      '        runtime: claude-code',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const bundlePath = path.join(tmpDir, "v2-inspect.rigbundle");
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "v2-inspect", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });
    expect(createRes.status).toBe(201);

    const res = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.schemaVersion).toBe(2);
    expect(Array.isArray(body.manifest.agents)).toBe(true);
    expect(body.manifest.agents.length).toBeGreaterThan(0);
    expect(body.manifest.agents[0].name).toBe("impl-agent");
    expect(body.digestValid).toBe(true);
  });

  // Item 2 / slice-05 / Checkpoint 3.2：v1 create -> inspect 兼容性往返。
  // 判别点：删除 v1 inspect 归一化器的兼容性呈现，或删除 /create 路由的兼容性提取，都必须使本测试失败。
  it("POST /api/bundles/create 接受兼容性信息，/inspect 将其呈现（v1 往返）", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "compat-test.rigbundle");

    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "compat-test", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "0.3.2", minCliVersion: "0.3.2", schemaVersion: 1 },
      }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.compatibility).toBeDefined();
    expect(inspectBody.manifest.compatibility.minDaemonVersion).toBe("0.3.2");
    expect(inspectBody.manifest.compatibility.minCliVersion).toBe("0.3.2");
    expect(inspectBody.manifest.compatibility.schemaVersion).toBe(1);
    // 否定断言——不得出现 snake_case 键（camelCase 契约）
    expect(inspectBody.manifest.compatibility.min_daemon_version).toBeUndefined();
  });

  // Item 2 / slice-05 / Checkpoint 3.2：v2 create -> inspect 兼容性往返。
  // 规避 Item 1 的 B1 陷阱：本测试与 routes/bundles.ts 中 v2 inspect 兼容性投影同批提交。
  // 判别点：删除 v2 兼容性投影那一行必须使本测试失败。
  it("POST /api/bundles/inspect 与 v2 包在驼峰命名法中表面兼容性（创建 -> 检查往返）", async () => {
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent',
      'version: "1.0.0"',
      'resources:',
      '  skills: []',
      'profiles:',
      '  default:',
      '    uses:',
      '      skills: []',
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: v2-compat-test',
      'pods:',
      '  - id: dev',
      '    label: Dev',
      '    members:',
      '      - id: impl',
      '        agent_ref: "local:agents/impl"',
      '        profile: default',
      '        runtime: claude-code',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const bundlePath = path.join(tmpDir, "v2-compat.rigbundle");
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "v2-compat", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "0.3.2", minCliVersion: "0.3.2" },
      }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.schemaVersion).toBe(2);
    expect(inspectBody.manifest.compatibility).toBeDefined();
    expect(inspectBody.manifest.compatibility.minDaemonVersion).toBe("0.3.2");
    expect(inspectBody.manifest.compatibility.minCliVersion).toBe("0.3.2");
    // 否定断言——不得出现 snake_case 键（camelCase 契约）
    expect(inspectBody.manifest.compatibility.min_daemon_version).toBeUndefined();
    expect(inspectBody.manifest.compatibility.min_cli_version).toBeUndefined();
  });

  // Item 1 / slice-05 / guard B1 修复：pod 感知（v2）create -> inspect 出处往返。
  // 断言 inspect 响应以归一化 camelCase 呈现出处，与 v1 契约一致。
  // 判别点：删除 routes/bundles.ts 中 v2 inspect 投影那一行必须使本测试失败。
  it("POST /api/bundles/inspect v2 包以驼峰命名法显示出处（创建 -> 检查往返）", async () => {
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      'name: impl-agent',
      'version: "1.0.0"',
      'resources:',
      '  skills: []',
      'profiles:',
      '  default:',
      '    uses:',
      '      skills: []',
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      'name: v2-prov-test',
      'pods:',
      '  - id: dev',
      '    label: Dev',
      '    members:',
      '      - id: impl',
      '        agent_ref: "local:agents/impl"',
      '        profile: default',
      '        runtime: claude-code',
      '        cwd: .',
      '    edges: []',
      'edges: []',
    ].join("\n"));

    const bundlePath = path.join(tmpDir, "v2-prov.rigbundle");
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "v2-prov", bundleVersion: "0.1.0", outputPath: bundlePath,
        provenance: {
          sourceHost: "v2-route-test-host",
          authorSession: "velocity-driver@openrig-velocity",
          cliVersion: "0.3.2",
          notes: "v2 route round-trip fixture",
        },
      }),
    });
    expect(createRes.status).toBe(201);

    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath }),
    });
    expect(inspectRes.status).toBe(200);
    const inspectBody = await inspectRes.json();
    expect(inspectBody.manifest.schemaVersion).toBe(2);
    // 契约：出处以归一化 camelCase 返回（与 v1 一致）
    expect(inspectBody.manifest.provenance).toBeDefined();
    expect(inspectBody.manifest.provenance.sourceHost).toBe("v2-route-test-host");
    expect(inspectBody.manifest.provenance.authorSession).toBe("velocity-driver@openrig-velocity");
    expect(inspectBody.manifest.provenance.cliVersion).toBe("0.3.2");
    expect(inspectBody.manifest.provenance.notes).toBe("v2 route round-trip fixture");
    expect(typeof inspectBody.manifest.provenance.daemonVersion).toBe("string");
    expect(inspectBody.manifest.provenance.daemonVersion.length).toBeGreaterThan(0);
    // 否定断言——不得出现 snake_case 键（camelCase 契约）
    expect(inspectBody.manifest.provenance.source_host).toBeUndefined();
    expect(inspectBody.manifest.provenance.author_session).toBeUndefined();
  });

  it("POST /api/bundles/create 拒绝 pod 感知的最终暂存树中不安全的生成来源", async () => {
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      "name: impl-agent",
      'version: "1.0.0"',
      "resources:",
      "  skills: []",
      "profiles:",
      "  default:",
      "    uses:",
      "      skills: []",
    ].join("\n"));

    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      "name: v2-unsafe-generated",
      "pods:",
      "  - id: dev",
      "    label: Dev",
      "    members:",
      "      - id: impl",
      '        agent_ref: "local:agents/impl"',
      "        profile: default",
      "        runtime: claude-code",
      "        cwd: .",
      "    edges: []",
      "edges: []",
    ].join("\n"));
    const bundlePath = path.join(tmpDir, "v2-unsafe-generated.rigbundle");

    const res = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath,
        bundleName: "v2-unsafe-generated",
        bundleVersion: "0.1.0",
        outputPath: bundlePath,
        provenance: { notes: "See substrate/shared-docs/rigs/private for details." },
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/internal-path/);
    expect(body.error).toMatch(/bundle\.yaml/);
    expect(fs.existsSync(bundlePath)).toBe(false);
  });

  // Item 2 / slice-05 Checkpoint 3.3：install 时版本检查
  it("当 min_daemon_version 超过正在运行的后台服务时，POST /api/bundles/install 失败并出现 3 部分错误", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "incompat.rigbundle");

    // 创建 min_daemon_version 远高于当前版本的 bundle
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "incompat", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "99.0.0" },
      }),
    });
    expect(createRes.status).toBe(201);

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true }),
    });
    expect(installRes.status).toBe(400);
    const body = await installRes.json();
    expect(body.error).toBe("bundle 兼容性检查失败");
    expect(Array.isArray(body.failures)).toBe(true);
    expect(body.failures.length).toBeGreaterThan(0);
    const daemonFailure = body.failures.find((f: { reason: string }) => f.reason === "daemon_version_mismatch");
    expect(daemonFailure).toBeDefined();
    expect(daemonFailure.required).toBe("99.0.0");
    expect(typeof daemonFailure.actual).toBe("string");
    expect(typeof daemonFailure.description).toBe("string");
    expect(Array.isArray(body.resolutions)).toBe(true);
    expect(body.resolutions.length).toBeGreaterThanOrEqual(2);
  });

  it("POST /api/bundles/install 并使用skipVersionCheck=true绕过不兼容的bundle的兼容性检查", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "incompat-skip.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "incompat-skip", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "99.0.0" },
      }),
    });

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true, skipVersionCheck: true }),
    });
    // 兼容性检查已跳过；我们只需不看到 "Bundle compatibility check failed" 错误。bootstrap 仍可返回任何其他状态；我们断言的是不存在 compat-check 失败形状。
    if (installRes.status === 400) {
      const body = await installRes.json();
      expect(body.error).not.toBe("Bundle compatibility check failed");
    }
  });

  it("当 min_cli_version 超过正文中发送的 CLI 版本时，POST /api/bundles/install 失败并出现 3 部分错误", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "cli-incompat.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "cli-incompat", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minCliVersion: "99.0.0" },
      }),
    });

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true, cliVersion: "0.3.1" }),
    });
    expect(installRes.status).toBe(400);
    const body = await installRes.json();
    expect(body.error).toBe("bundle 兼容性检查失败");
    const cliFailure = body.failures.find((f: { reason: string }) => f.reason === "cli_version_mismatch");
    expect(cliFailure).toBeDefined();
    expect(cliFailure.required).toBe("99.0.0");
    expect(cliFailure.actual).toBe("0.3.1");
  });

  it("当捆绑包需要版本 <= 当前版本时，POST /api/bundles/install 通过兼容性检查", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "compat.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath, bundleName: "compat-ok", bundleVersion: "0.1.0", outputPath: bundlePath,
        compatibility: { minDaemonVersion: "0.0.1", minCliVersion: "0.0.1" },
      }),
    });

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true, cliVersion: "0.3.1" }),
    });
    // 绝不能是 compat-fail 形状。bootstrap 可返回任意状态。
    if (installRes.status === 400) {
      const body = await installRes.json();
      expect(body.error).not.toBe("Bundle compatibility check failed");
    }
  });

  // Item 2 / slice-05 Checkpoint 3.3 / guard B1 修复：install 在 bootstrap 委派之前，
  // 通过安全错误路径拒绝不安全归档。判别点：把 extractManifestForCompatCheck 回退为裸 tar.extract
  //（不带 unpack 的 verifyArchiveDigest + tar.list 不安全条目预扫）必须使本测试失败——
  // 不安全符号链接会被静默解压，bootstrap 会看到攻击者可控的链接目标。
  it("POST /api/bundles/install 通过安全路径拒绝包含符号链接条目的存档（B1 修复）", async () => {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-unsafe-staging-"));
    const bundlePath = path.join(tmpDir, "unsafe-symlink.rigbundle");
    try {
      // 最小合法 manifest 内容（含 bundle.yaml），外加安全预扫必须拒绝的不安全符号链接。
      fs.writeFileSync(path.join(stagingDir, "bundle.yaml"), [
        'schema_version: 1',
        'name: unsafe-test',
        'version: "0.1.0"',
        'created_at: "2026-05-18T00:00:00Z"',
        'rig_spec: rig.yaml',
        'packages: []',
      ].join("\n"));
      fs.writeFileSync(path.join(stagingDir, "rig.yaml"), 'schema_version: 1\nname: x\nversion: "1.0"\nnodes: []\nedges: []');
      fs.symlinkSync("/etc/passwd", path.join(stagingDir, "evil-symlink"));

      const tar = await import("tar");
      await tar.create(
        { gzip: { level: 9 }, file: bundlePath, cwd: stagingDir, portable: true },
        ["bundle.yaml", "rig.yaml", "evil-symlink"],
      );

      // 写一个合法的兄弟 .sha256，使 digest 校验通过——证明是预扫捕获符号链接，而非 digest 检查。
      const { createHash } = await import("node:crypto");
      const archiveHash = createHash("sha256").update(fs.readFileSync(bundlePath)).digest("hex");
      fs.writeFileSync(`${bundlePath}.sha256`, archiveHash, "utf-8");

      const installRes = await app.request("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath, plan: true }),
      });
      expect(installRes.status).toBe(400);
      const body = await installRes.json();
      // 无论显式 extraction-failed 形状（安全拒绝发生在 unpack 内），还是 compat-check-failed 形状（detail 里带安全信息）。
      // 无论哪种，符号链接串必须出现，且 bootstrap 绝不能已进入。
      const text = JSON.stringify(body);
      expect(text).toMatch(/Unsafe archive entries|SymbolicLink|symlink/i);
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  // Item 3 / slice-05 Checkpoint 4.2：install 冲突闸门。冲突路径：
  // 与 bundle 的 rig 同名的运行中 rig，必须在 bootstrap 委派之前由 /install 产出三段式错误响应。
  // 强制绕过路径：同一 bundle 带 force=true 必须跳过冲突检查。
  it("bundle 工作组名称与运行中工作组冲突时，POST /api/bundles/install 返回三段式冲突错误", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "conflict-test.rigbundle");

    // 创建一个 rig.yaml 声明 name 为 'test-rig'（匹配 VALID_SPEC）的 bundle
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "conflict-test", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });
    expect(createRes.status).toBe(201);

    // 种下一个与 bundle 的 rig 同名的运行中 rig
    setup.rigRepo.createRig("test-rig");

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true }),
    });
    expect(installRes.status).toBe(400);
    const body = await installRes.json();
    expect(body.error).toBe("bundle 安装冲突检查失败");
    expect(Array.isArray(body.conflicts)).toBe(true);
    expect(body.conflicts.length).toBeGreaterThan(0);
    const rigConflict = body.conflicts.find((c: { kind: string }) => c.kind === "rig_name_collision");
    expect(rigConflict).toBeDefined();
    expect(rigConflict.bundleRigName).toBe("test-rig");
    expect(typeof rigConflict.collisionWith.rigId).toBe("string");
    expect(rigConflict.collisionWith.rigName).toBe("test-rig");
    expect(Array.isArray(body.resolutions)).toBe(true);
    expect(body.resolutions.length).toBeGreaterThanOrEqual(2);
  });

  it("POST /api/bundles/install 并使用 force=true 绕过名称冲突的冲突检查", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "conflict-force.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "conflict-force", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    setup.rigRepo.createRig("test-rig");

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true, force: true }),
    });
    // 冲突检查已绕过。bootstrap 可返回任何状态；我们断言的是不存在冲突检查失败形状。
    if (installRes.status === 400) {
      const body = await installRes.json();
      expect(body.error).not.toBe("Bundle install conflict check failed");
    }
  });

  it("当没有正在运行的装备与捆绑包的装备名称匹配时，POST /api/bundles/install 通过冲突检查", async () => {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, "no-conflict.rigbundle");

    await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "no-conflict", bundleVersion: "0.1.0", outputPath: bundlePath }),
    });

    // 未创建任何 rig——运行集为空

    const installRes = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath, plan: true }),
    });
    // 绝不能是冲突失败形状。bootstrap 可返回任何状态。
    if (installRes.status === 400) {
      const body = await installRes.json();
      expect(body.error).not.toBe("Bundle install conflict check failed");
    }
  });

  // Item 3 / slice-05 Checkpoint 4.2 / guard B1 修复：install 通过 extractInstallTimeMetadata 的
  // manifest 验证器，拒绝 bundle.yaml 携带不安全 rig_spec 值（../traversal）的 bundle。
  // 判别点：删除验证器块会使测试失败（无校验错误；路径包含检查仍触发，但错误串与验证器拒绝断言不同）。
  it("POST /api/bundles/install 通过清单验证器拒绝 rig_spec 不安全的包（B1 修复）", async () => {
    const { specPath } = seedPackage();
    const goodBundlePath = path.join(tmpDir, "good.rigbundle");
    const tamperedBundlePath = path.join(tmpDir, "tampered.rigbundle");

    // 经 /create 构建一个普通合法 bundle（得到合法 integrity + digest）
    const createRes = await app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath, bundleName: "tamper-test", bundleVersion: "0.1.0", outputPath: goodBundlePath }),
    });
    expect(createRes.status).toBe(201);

    // 解压，修改 bundle.yaml 注入不安全 rig_spec（bundle.yaml 本身不在 integrity.files 中——
    // 其哈希不能引用自身——因此编辑它不破坏 verifyIntegrity）。
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-tamper-staging-"));
    try {
      const tar = await import("tar");
      await tar.extract({ file: goodBundlePath, cwd: stagingDir });
      const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
      const original = fs.readFileSync(bundleYamlPath, "utf-8");
      // 替换 rig_spec 行。原值为 `rig_spec: rig.yaml`（来自 /create）。
      const tampered = original.replace(/^rig_spec:.*$/m, 'rig_spec: "../escape.yaml"');
      expect(tampered).toContain('rig_spec: "../escape.yaml"');
      fs.writeFileSync(bundleYamlPath, tampered);

      // 经 pack() 重新打包，它会写入合法的兄弟 .sha256

      // 尝试安装
      const { pack } = await import("../src/domain/bundle-archive.js");
      await pack(stagingDir, tamperedBundlePath);

      // 尝试 install
      const installRes = await app.request("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath: tamperedBundlePath, plan: true }),
      });
      expect(installRes.status).toBe(400);
      const body = await installRes.json();
      // 验证器运行在 extractInstallTimeMetadata 内，后者由路由的 try/catch 调用。
      // 错误路径把它包成 "could not run (extraction failed)" 形状，验证器信息在 detail 里。
      const text = JSON.stringify(body);
      expect(text).toMatch(/非法 v1 bundle manifest|非法 v2 bundle manifest|rig_spec.*不安全|逃出 bundle 工作区/i);
      // 否定断言——bootstrap 绝不能已进入。冲突检查错误形状意味着我们越过了验证器进入冲突检测；断言它没有。
      expect(body.error).not.toBe("Bundle install conflict check failed");
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  // Item 4 / slice-05 Checkpoint 5.2：GET /api/bundles/history 呈现
  // bundle-audit JSONL 记录（可过滤）。空文件 -> []；rig 过滤限定范围；
  // since 过滤限定范围。
  it("当不存在审计记录时 GET /api/bundles/history 返回空列表", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-history-test-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const res = await app.request("/api/bundles/history");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.records).toEqual([]);
      expect(body.total).toBe(0);
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("GET /api/bundles/history 返回审计文件中的记录并遵循过滤器", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-history-test-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      // 直接预置 audit JSONL（绕过任何 writer；测试 reader 路径）
      const auditPath = path.join(auditHome, "bundle-audit.jsonl");
      const recs = [
        { installedAt: "2026-05-18T10:00:00Z", bundlePath: "/tmp/a.rigbundle", targetRigName: "alpha", outcome: "success" },
        { installedAt: "2026-05-18T11:00:00Z", bundlePath: "/tmp/b.rigbundle", targetRigName: "beta", outcome: "failed" },
        { installedAt: "2026-05-18T12:00:00Z", bundlePath: "/tmp/c.rigbundle", targetRigName: "alpha", outcome: "partial" },
      ];
      fs.writeFileSync(auditPath, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");

      // 未过滤：全部 3 条
      const all = await app.request("/api/bundles/history");
      expect(all.status).toBe(200);
      const allBody = await all.json();
      expect(allBody.total).toBe(3);
      expect(allBody.records).toHaveLength(3);

      // Filter rig=alpha: 2 records
      const alpha = await app.request("/api/bundles/history?rig=alpha");
      const alphaBody = await alpha.json();
      expect(alphaBody.total).toBe(2);
      expect(alphaBody.records.every((r: { targetRigName: string }) => r.targetRigName === "alpha")).toBe(true);

      // 过滤 since=11:00：2 条（11:00 与 12:00 那两条）
      const since = await app.request("/api/bundles/history?since=2026-05-18T11:00:00Z");
      const sinceBody = await since.json();
      expect(sinceBody.total).toBe(2);
      expect(sinceBody.records.map((r: { installedAt: string }) => r.installedAt)).toEqual([
        "2026-05-18T11:00:00Z",
        "2026-05-18T12:00:00Z",
      ]);

      // 组合 rig=alpha + since=11:00：1 条（12:00 那条 alpha）
      const combo = await app.request("/api/bundles/history?rig=alpha&since=2026-05-18T11:00:00Z");
      const comboBody = await combo.json();
      expect(comboBody.total).toBe(1);
      expect(comboBody.records[0].installedAt).toBe("2026-05-18T12:00:00Z");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 4 / slice-05 Checkpoint 5.3：/install 在 apply 完成路径写 audit 记录；
  // plan 模式不写（计划不改变状态）。端到端：install -> GET /api/bundles/history 反映该记录。
  // 测试隔离通过 OPENRIG_HOME env 覆盖到逐用例 tmpDir。
  it("POST /api/bundles/install 计划模式不会写入审核记录（计划不会更改状态）", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-plan-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "plan-mode.rigbundle");
      await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specPath, bundleName: "plan-mode", bundleVersion: "0.1.0", outputPath: bundlePath }),
      });

      await app.request("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath, plan: true }),
      });

      const history = await app.request("/api/bundles/history");
      const body = await history.json();
      expect(body.total).toBe(0);
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  /**
   * Item 4 Checkpoint 5.3 B1 修复：逐分支确定性 audit-write 测试。
   * 每个用例用 vi.fn() stub setup.bootstrapOrchestrator.bootstrap 以强制特定结果，
   * 然后断言该结果精确落到 /api/bundles/history。
   * 判别点：禁用每个分支的 writeInstallAudit 调用必须使其配对用例专门失败。
   */
  async function runApplyAuditTest(opts: {
    bundleName: string;
    bootstrapResult?: unknown;
    bootstrapThrows?: Error;
    expectedOutcome: "success" | "failed" | "partial";
    expectedRigId?: string;
  }): Promise<{ records: Array<Record<string, unknown>>; total: number }> {
    const { specPath } = seedPackage();
    const bundlePath = path.join(tmpDir, `${opts.bundleName}.rigbundle`);
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${opts.bundleName}-target-`));
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specPath, bundleName: opts.bundleName, bundleVersion: "0.1.0", outputPath: bundlePath }),
      });

      const stub = opts.bootstrapThrows
        ? vi.fn().mockRejectedValue(opts.bootstrapThrows)
        : vi.fn().mockResolvedValue(opts.bootstrapResult);
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

      await app.request("/api/bundles/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
      });

      const history = await app.request("/api/bundles/history");
      const body = await history.json();
      // Item 4 收尾 / guard B2 修复：helper 级 bundlePath 断言适用于全部 4 个分支测试（DRY）。
      // 判别点：在 routes/bundles.ts 里把 record.bundlePath 设错路径必须使每个 apply 模式分支测试失败。
      expect(body.total).toBe(1);
      expect(body.records[0].bundlePath).toBe(bundlePath);
      return body;
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  }

  it("POST /api/bundles/install apply/completed 分支写入审核记录，结果=成功", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-completed-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const body = await runApplyAuditTest({
        bundleName: "completed-test",
        bootstrapResult: {
          status: "completed",
          runId: "test-run-completed",
          rigId: "01H000000000000000COMPL01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        },
        expectedOutcome: "success",
      });
      expect(body.total).toBe(1);
      expect(body.records[0].outcome).toBe("success");
      expect(body.records[0].targetRigId).toBe("01H000000000000000COMPL01");
      expect(typeof body.records[0].daemonVersion).toBe("string");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install apply/partial 分支写入结果=partial 的审核记录", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-partial-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const body = await runApplyAuditTest({
        bundleName: "partial-test",
        bootstrapResult: {
          status: "partial",
          runId: "test-run-partial",
          rigId: "01H000000000000000PARTI01",
          stages: [
            { stage: "resolve_spec", status: "ok" },
            { stage: "instantiate_rig", status: "failed" },
          ],
          errors: ["partial fail"],
        },
        expectedOutcome: "partial",
      });
      expect(body.total).toBe(1);
      expect(body.records[0].outcome).toBe("partial");
      expect(body.records[0].targetRigId).toBe("01H000000000000000PARTI01");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install apply / failed-result 分支写入结果=失败的审核记录", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-failed-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const body = await runApplyAuditTest({
        bundleName: "failed-result-test",
        bootstrapResult: {
          status: "failed",
          runId: "test-run-failed",
          stages: [{ stage: "resolve_spec", status: "failed" }],
          errors: ["resolve failed"],
        },
        expectedOutcome: "failed",
      });
      expect(body.total).toBe(1);
      expect(body.records[0].outcome).toBe("failed");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("POST /api/bundles/install apply / throwed-error 分支写入结果 = 失败的审核记录", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-audit-thrown-"));
    process.env.OPENRIG_HOME = auditHome;
    try {
      const body = await runApplyAuditTest({
        bundleName: "thrown-test",
        bootstrapThrows: new Error("simulated bootstrap explosion"),
        expectedOutcome: "failed",
      });
      expect(body.total).toBe(1);
      expect(body.records[0].outcome).toBe("failed");
    } finally {
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / slice-05 Checkpoint 7.3：bootstrap 成功后，/install 把声明的 skills 路由到 operator skills 库。
  // 用 bootstrap stub 强制 completed 结果；bundle manifest 带 skills[]；验证 skills 落到 OPENRIG_HOME/skills/。
  it("成功引导后 POST /api/bundles/install 路由声明技能（已完成分支）", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-skills-route-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-skills.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-target-"));
      try {
        // 构建一个声明 skills[] 的 bundle。往 package 目录加一个 skill 文件，使其打包时落入 bundle 归档。
        const skillSourceDir = path.join(tmpDir, "test-pkg", "skills");
        fs.mkdirSync(skillSourceDir, { recursive: true });
        fs.writeFileSync(path.join(skillSourceDir, "FOO.md"), "# foo skill body");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-skills", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        // 篡改已创建 bundle 的 bundle.yaml 注入 skills[] 字段。bundle.yaml 自身哈希被排除在 integrity.files 之外，因此编辑它不破坏 verifyIntegrity。
        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // 追加 skills 字段，引用我们放进 bundled package 的文件
          const tampered = `${original}\nskills:\n  - packages/test-pkg/skills/FOO.md\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        // stub bootstrap 返回 completed，使 audit-write + skills 路由触发
        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-skills",
          rigId: "01H000000000000000SKILLS01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        // 响应携带 skillsRouting 块
        expect(body.skillsRouting).toBeDefined();
        expect(body.skillsRouting.routedCount).toBe(1);
        expect(body.skillsRouting.records).toHaveLength(1);
        expect(body.skillsRouting.records[0].status).toBe("routed");
        // package 形状的 legacy skill payload 不进入受管 catalog。
        const expectedTarget = path.join(auditHome, "packages", "test-pkg", "skills", "FOO.md");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe("# foo skill body");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3a / guard B1 修复（qitem-20260518220247）：即使 operator 同时用 --skip-version-check 与 --force 预检覆盖，skills 路由也必须触发。
  // 路由独立于预检提取闸门。判别点：把 routeSkillsAfterBootstrap 重新耦合到 installMeta 会使本测试失败（两个覆盖 flag 都设时 skillsRouting 为 undefined）。
  it("即使同时设置了 --skip-version-check 和 --force，POST /api/bundles/install 也会路由声明的技能（B1 修复）", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-skills-dual-override-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-target-"));
      try {
        const skillSourceDir = path.join(tmpDir, "test-pkg", "skills");
        fs.mkdirSync(skillSourceDir, { recursive: true });
        fs.writeFileSync(path.join(skillSourceDir, "DUAL.md"), "# dual-override skill body");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nskills:\n  - packages/test-pkg/skills/DUAL.md\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-dual-override",
          rigId: "01H000000000000000DUAL0001",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        // 关键：两个覆盖 flag 都设——这曾触发 B1 bug
        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.skillsRouting).toBeDefined();
        expect(body.skillsRouting.routedCount).toBe(1);
        expect(body.skillsRouting.records[0].status).toBe("routed");
        const expectedTarget = path.join(auditHome, "packages", "test-pkg", "skills", "DUAL.md");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe("# dual-override skill body");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3d：bootstrap 成功后，/install 路由声明的 plugins。
  // 仿 skills 路由测试；bundle 带 plugins[]，source 指向 bundle 树中的一个目录。
  // 验证 plugin 目录落到 OPENRIG_HOME/plugins/<id>/。
  it("成功引导后 POST /api/bundles/install 路由声明插件（已完成分支）", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-plugins-route-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-plugins.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-target-"));
      try {
        // 把 plugin 树放进 bundle 的 package 源，使其落入归档
        const pluginSrc = path.join(tmpDir, "test-pkg", "plugins", "myplugin");
        fs.mkdirSync(pluginSrc, { recursive: true });
        fs.writeFileSync(path.join(pluginSrc, "plugin.json"), '{"name":"myplugin","version":"1.0"}');
        fs.writeFileSync(path.join(pluginSrc, "README.md"), "# myplugin");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-plugins", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        // 篡改 bundle.yaml 注入引用 bundle 内路径的 plugins[]
        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nplugins:\n  - id: myplugin\n    source:\n      kind: local\n      path: packages/test-pkg/plugins/myplugin\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-plugins",
          rigId: "01H000000000000000PLUG0001",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.pluginsRouting).toBeDefined();
        expect(body.pluginsRouting.routedCount).toBe(1);
        expect(body.pluginsRouting.records[0].id).toBe("myplugin");
        expect(body.pluginsRouting.records[0].status).toBe("routed");
        // Plugin 目录落在 OPENRIG_HOME/plugins/myplugin
        const expectedPluginDir = path.join(auditHome, "plugins", "myplugin");
        expect(fs.existsSync(expectedPluginDir)).toBe(true);
        expect(fs.existsSync(path.join(expectedPluginDir, "plugin.json"))).toBe(true);
        expect(fs.existsSync(path.join(expectedPluginDir, "README.md"))).toBe(true);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3d / guard B1：5f410eee skills 教训的镜像：即使 operator 同时用 --skip-version-check 与 --force 预检覆盖，plugins 路由也必须触发。
  // routePluginsAfterBootstrap 只取 bundlePath（与 installMeta 解耦），使双覆盖路径——它在预检点留下 installMeta 为 null——仍路由声明的 plugins。
  // 判别点：把 routePluginsAfterBootstrap 重新耦合到 installMeta 会使本测试失败（声明 plugins[] 的 bundle 上两个覆盖 flag 都设时 pluginsRouting 为 undefined）。
  it("即使同时设置了 --skip-version-check 和 --force，POST /api/bundles/install 也会路由声明的插件（B1 镜像）", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-plugins-dual-override-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override-plugins.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-plugins-target-"));
      try {
        const pluginSrc = path.join(tmpDir, "test-pkg", "plugins", "dualplugin");
        fs.mkdirSync(pluginSrc, { recursive: true });
        fs.writeFileSync(path.join(pluginSrc, "plugin.json"), '{"name":"dualplugin","version":"1.0"}');
        fs.writeFileSync(path.join(pluginSrc, "README.md"), "# dualplugin body");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override-plugins", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-plugins-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nplugins:\n  - id: dualplugin\n    source:\n      kind: local\n      path: packages/test-pkg/plugins/dualplugin\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-plugins-dual",
          rigId: "01H000000000000000DUAL0002",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        // 关键：两个覆盖 flag 都设——此路径下预检点 installMeta 为 null；plugins-routing 包装器仍必须触发
        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.pluginsRouting).toBeDefined();
        expect(body.pluginsRouting.routedCount).toBe(1);
        expect(body.pluginsRouting.records[0].id).toBe("dualplugin");
        expect(body.pluginsRouting.records[0].status).toBe("routed");
        const expectedPluginDir = path.join(auditHome, "plugins", "dualplugin");
        expect(fs.existsSync(expectedPluginDir)).toBe(true);
        expect(fs.existsSync(path.join(expectedPluginDir, "plugin.json"))).toBe(true);
        expect(fs.existsSync(path.join(expectedPluginDir, "README.md"))).toBe(true);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.5（QA-20260601 A2 修复）：/create 自动检测作者 bundle.yaml + 把声明的跨原语内容 vendor 进归档 + 把跨原语字段带到构建出的 bundle.yaml。
  // 端到端证明：作者可声明全部 5 种类型，create CLI 产出一个 install 侧会路由的 bundle。
  it("POST /api/bundles/create 自动检测作者 bundle.yaml + 供应商所有 5 种跨基元类型（pod 感知）", async () => {
    // 1. 在 sourceRoot 构建 pod 感知的 rig.yaml + agents/impl/agent.yaml
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "create-author-bundle-src-"));
    const outputPath = path.join(tmpDir, "create-author-test.rigbundle");
    try {
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent',
        'version: "1.0.0"',
        'resources:',
        '  skills: []',
        'profiles:',
        '  default:',
        '    uses:',
        '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: author-bundle-test-rig', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));

      // 2. 为全部 5 种跨原语类型撰写内容
      // skills：文件
      fs.mkdirSync(path.join(sourceRoot, "skills/author-skill"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "skills/author-skill/SKILL.md"), "# Author skill body");
      // plugins：目录
      fs.mkdirSync(path.join(sourceRoot, "plugins/author-plugin"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "plugins/author-plugin/plugin.json"), '{"name":"author-plugin","version":"1.0"}');
      fs.writeFileSync(path.join(sourceRoot, "plugins/author-plugin/README.md"), "plugin readme");
      // workflow_specs：文件（YAML）
      fs.mkdirSync(path.join(sourceRoot, "workflows"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "workflows/author-flow.yaml"), "workflow:\n  id: author-flow\n  version: '1'\n  roles: { producer: {} }\n  steps:\n    - id: produce\n      actor_role: producer\n");
      // context_packs：目录内的 manifest.yaml（vendor 拷贝父目录）
      fs.mkdirSync(path.join(sourceRoot, "context-packs/author-pack"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "context-packs/author-pack/manifest.yaml"), "name: author-pack\nversion: '1'\ntaxonomy: mission\nfiles:\n  - path: brief.md\n    role: brief\n");
      fs.writeFileSync(path.join(sourceRoot, "context-packs/author-pack/brief.md"), "# brief");
      // agent_images：目录
      fs.mkdirSync(path.join(sourceRoot, "agent-images/author-image"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agent-images/author-image/manifest.yaml"), "name: author-image\nversion: '1'\nruntime: claude-code\nsource_seat: x@y\nsource_session_id: aaa\nsource_resume_token: aaa\ncreated_at: '2026-05-31T00:00:00Z'\nfiles: []\n");

      // 3. 在 sourceRoot 撰写 bundle.yaml，声明全部 5 种类型
      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        'skills:',
        '  - skills/author-skill/SKILL.md',
        'plugins:',
        '  - id: author-plugin',
        '    source:',
        '      kind: local',
        '      path: plugins/author-plugin',
        'workflow_specs:',
        '  - workflows/author-flow.yaml',
        'context_packs:',
        '  - context-packs/author-pack/manifest.yaml',
        'agent_images:',
        '  - agent-images/author-image',
      ].join("\n"));

      // 4. /api/bundles/create —— pod 感知路径
      const createRes = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specPath, rigRoot: sourceRoot,
          bundleName: "author-bundle-test", bundleVersion: "0.1.0", outputPath,
        }),
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json();
      expect(createBody.archiveHash).toMatch(/^[a-f0-9]{64}$/);

      // 5. 解压归档，校验全部 5 种类型的内容 + manifest 字段
      const unpackDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-author-bundle-unpack-"));
      try {
        const tar = await import("tar");
        await tar.extract({ file: outputPath, cwd: unpackDir });

        // 构建出的 bundle.yaml 含全部 5 个跨原语字段
        const builtYaml = fs.readFileSync(path.join(unpackDir, "bundle.yaml"), "utf-8");
        expect(builtYaml).toContain("skills:");
        expect(builtYaml).toContain("skills/author-skill/SKILL.md");
        expect(builtYaml).toContain("plugins:");
        expect(builtYaml).toContain("id: author-plugin");
        expect(builtYaml).toContain("workflow_specs:");
        expect(builtYaml).toContain("workflows/author-flow.yaml");
        expect(builtYaml).toContain("context_packs:");
        expect(builtYaml).toContain("context-packs/author-pack/manifest.yaml");
        expect(builtYaml).toContain("agent_images:");
        expect(builtYaml).toContain("agent-images/author-image");

        // vendored 内容确实落到 staging 树（即归档）
        expect(fs.existsSync(path.join(unpackDir, "skills/author-skill/SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "plugins/author-plugin/plugin.json"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "plugins/author-plugin/README.md"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "workflows/author-flow.yaml"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "context-packs/author-pack/manifest.yaml"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "context-packs/author-pack/brief.md"))).toBe(true);
        expect(fs.existsSync(path.join(unpackDir, "agent-images/author-image/manifest.yaml"))).toBe(true);
      } finally {
        fs.rmSync(unpackDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  it("LP-3 在创建档案之前拒绝作者声明的目录中的内部内容", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s12-lp3-internal-src-"));
    const outputPath = path.join(tmpDir, "s12-lp3-internal.rigbundle");
    try {
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: s12-lp3-internal', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));
      fs.mkdirSync(path.join(sourceRoot, "plugins/private"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "plugins/private/README.md"), "See substrate/shared-docs/rigs/private.\n");
      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        "plugins:", "  - id: private", "    source:", "      kind: local", "      path: plugins/private",
      ].join("\n"));

      const response = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specPath, rigRoot: sourceRoot, bundleName: "s12-lp3", bundleVersion: "1", outputPath }),
      });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toMatch(/internal-path[\s\S]*(通用化|公开来源|内部内容包)/i);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  it("LP-3 在创建档案之前拒绝作者声明的知识包", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "s12-lp3-lore-src-"));
    const outputPath = path.join(tmpDir, "s12-lp3-lore.rigbundle");
    try {
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: s12-lp3-lore', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));
      fs.mkdirSync(path.join(sourceRoot, "context-packs/private-lore"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "context-packs/private-lore/manifest.yaml"), [
        "name: private-lore", 'version: "1"', "taxonomy: lore", "files: []",
      ].join("\n"));
      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        "context_packs:", "  - context-packs/private-lore/manifest.yaml",
      ].join("\n"));

      const response = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specPath, rigRoot: sourceRoot, bundleName: "s12-lp3", bundleVersion: "1", outputPath }),
      });
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toMatch(/lore-class|taxonomy:\s*lore/i);
      expect(body.error).toMatch(/通用化|公开来源|内部内容包/i);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  // Item 6 / QA-20260601 C1 修复：/api/bundles/inspect 对含跨原语块的 v2 归档的归一化响应，
  // 必须在 provenance + compatibility 之外呈现 skills + plugins + workflowSpecs + contextPacks + agentImages。
  // 构建出的 bundle.yaml 含 snake_case 字段（Checkpoint 7.5）；inspect 响应按 v2 归一化 manifest 契约把它们镜像为 camelCase。
  it("POST /api/bundles/inspect 为从作者 bundle.yaml 构建的 v2 存档显示跨原始字段", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-crossprim-src-"));
    const outputPath = path.join(tmpDir, "inspect-crossprim.rigbundle");
    try {
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: inspect-crossprim-rig', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));
      // 全部 5 种跨原语类型——据 dc4df12f 留存的护栏捕获：只测 2 种会让 workflow_specs/context_packs/agent_images 的 snake_case→camelCase 映射未被证明。下面逐一给出每种类型的内容 + 作者声明 + 响应断言。
      fs.mkdirSync(path.join(sourceRoot, "skills/inspect-skill"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "skills/inspect-skill/SKILL.md"), "# inspect skill");
      fs.mkdirSync(path.join(sourceRoot, "plugins/inspect-plugin"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "plugins/inspect-plugin/plugin.json"), '{"name":"inspect-plugin","version":"1.0"}');
      fs.mkdirSync(path.join(sourceRoot, "workflows"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "workflows/inspect-flow.yaml"), "workflow:\n  id: inspect-flow\n  version: '1'\n  roles: { producer: {} }\n  steps:\n    - id: produce\n      actor_role: producer\n");
      fs.mkdirSync(path.join(sourceRoot, "context-packs/inspect-pack"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "context-packs/inspect-pack/manifest.yaml"), "name: inspect-pack\nversion: '1'\nfiles:\n  - path: brief.md\n    role: brief\n");
      fs.writeFileSync(path.join(sourceRoot, "context-packs/inspect-pack/brief.md"), "# brief");
      fs.mkdirSync(path.join(sourceRoot, "agent-images/inspect-image"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agent-images/inspect-image/manifest.yaml"), "name: inspect-image\nversion: '1'\nruntime: claude-code\nsource_seat: x@y\nsource_session_id: aaa\nsource_resume_token: aaa\ncreated_at: '2026-05-31T00:00:00Z'\nfiles: []\n");
      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        'skills:',
        '  - skills/inspect-skill/SKILL.md',
        'plugins:',
        '  - id: inspect-plugin',
        '    source:',
        '      kind: local',
        '      path: plugins/inspect-plugin',
        'workflow_specs:',
        '  - workflows/inspect-flow.yaml',
        'context_packs:',
        '  - context-packs/inspect-pack/manifest.yaml',
        'agent_images:',
        '  - agent-images/inspect-image',
      ].join("\n"));

      const createRes = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specPath, rigRoot: sourceRoot,
          bundleName: "inspect-crossprim-test", bundleVersion: "0.1.0", outputPath,
        }),
      });
      expect(createRes.status).toBe(201);

      const inspectRes = await app.request("/api/bundles/inspect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundlePath: outputPath }),
      });
      expect(inspectRes.status).toBe(200);
      const inspectBody = await inspectRes.json();
      // QA-C1 修复：归一化 manifest 中呈现全部 5 个跨原语字段。v2 归档 -> response.manifest 携带 camelCase 键。
      // 据 dc4df12f 留存的护栏捕获：每个 snake_case→camelCase 映射单独被证明，而非只证明 skills+plugins。
      expect(inspectBody.manifest.skills).toEqual(["skills/inspect-skill/SKILL.md"]);
      expect(inspectBody.manifest.plugins).toHaveLength(1);
      expect(inspectBody.manifest.plugins[0].id).toBe("inspect-plugin");
      expect(inspectBody.manifest.workflowSpecs).toEqual(["workflows/inspect-flow.yaml"]);
      expect(inspectBody.manifest.contextPacks).toEqual(["context-packs/inspect-pack/manifest.yaml"]);
      expect(inspectBody.manifest.agentImages).toEqual(["agent-images/inspect-image"]);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  // Item 6 / Checkpoint 7.5 B1 修复（留存的 79a89d40 护栏捕获）：经作者 bundle.yaml 的 symlink 逃逸——FILE 形状。
  // 词面上看似受限、实则符号链接到外部文件的 skill 路径必须被拒绝。没有 realpath 校验时，vendor 时的解引用会把外部内容当普通文件拷进归档。
  it("POST /api/bundles/create 拒绝作者的 bundle.yaml 技能，该技能是针对 sourceRoot 外部的符号链接", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "create-symlink-escape-file-src-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-symlink-escape-file-outside-"));
    const outputPath = path.join(tmpDir, "symlink-escape-file.rigbundle");
    try {
      // 外部内容（bundle 绝不该包含的私有/机密文件）
      const outsideFile = path.join(outsideDir, "secret.md");
      fs.writeFileSync(outsideFile, "SECRET CONTENT");

      // pod 感知的 sourceRoot fixture
      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: symlink-escape-file-rig', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));

      // sourceRoot 内的符号链接 -> 外部文件
      fs.mkdirSync(path.join(sourceRoot, "skills/escape"), { recursive: true });
      fs.symlinkSync(outsideFile, path.join(sourceRoot, "skills/escape/SKILL.md"));

      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        'skills:',
        '  - skills/escape/SKILL.md',
      ].join("\n"));

      const createRes = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specPath, rigRoot: sourceRoot,
          bundleName: "symlink-escape-file-test", bundleVersion: "0.1.0", outputPath,
        }),
      });
      // /create catch 返回 500 与信息（据留存的 79a89d40 comment-honesty 更新）。body.error 点名该 symlink 逃逸。
      expect(createRes.status).toBe(500);
      const body = await createRes.json();
      expect(body.error).toMatch(/symlink 逃逸|bundle 源根外/i);
      // 关键：outputPath 处无归档（create 在 pack 之前失败）
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  // Item 6 / Checkpoint 7.5 B1 修复（留存的 79a89d40 护栏捕获）：经作者 bundle.yaml 的 symlink 逃逸——DIR 形状。
  // 词面上看似受限、实则符号链接到外部目录的 plugin 路径必须被拒绝。没有 realpath 校验时，cpSync 解引用会把外部目录树拷进归档。
  it("POST /api/bundles/create 拒绝作者的 bundle.yaml 插件，该插件是针对 sourceRoot 外部的符号链接", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "create-symlink-escape-dir-src-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-symlink-escape-dir-outside-"));
    const outputPath = path.join(tmpDir, "symlink-escape-dir.rigbundle");
    try {
      // 外部目录树（bundle 绝不该包含的私有内容）
      fs.writeFileSync(path.join(outsideDir, "private.json"), '{"secret":"data"}');

      fs.mkdirSync(path.join(sourceRoot, "agents/impl"), { recursive: true });
      fs.writeFileSync(path.join(sourceRoot, "agents/impl/agent.yaml"), [
        'name: impl-agent', 'version: "1.0.0"', 'resources:', '  skills: []',
        'profiles:', '  default:', '    uses:', '      skills: []',
      ].join("\n"));
      const specPath = path.join(sourceRoot, "rig.yaml");
      fs.writeFileSync(specPath, [
        'version: "0.2"', 'name: symlink-escape-dir-rig', 'pods:',
        '  - id: dev', '    label: Dev', '    members:',
        '      - id: impl', '        agent_ref: "local:agents/impl"',
        '        profile: default', '        runtime: claude-code', '        cwd: .',
        '    edges: []', 'edges: []',
      ].join("\n"));

      // sourceRoot/plugins 内的符号链接 -> 外部目录
      fs.mkdirSync(path.join(sourceRoot, "plugins"), { recursive: true });
      fs.symlinkSync(outsideDir, path.join(sourceRoot, "plugins/escape"));

      fs.writeFileSync(path.join(sourceRoot, "bundle.yaml"), [
        'plugins:',
        '  - id: escape',
        '    source:',
        '      kind: local',
        '      path: plugins/escape',
      ].join("\n"));

      const createRes = await app.request("/api/bundles/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          specPath, rigRoot: sourceRoot,
          bundleName: "symlink-escape-dir-test", bundleVersion: "0.1.0", outputPath,
        }),
      });
      expect(createRes.status).toBe(500);
      const body = await createRes.json();
      expect(body.error).toMatch(/symlink 逃逸|bundle 源根外/i);
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(sourceRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
    }
  });

  // Item 6 / Checkpoint 7.3e step 3: /install routes declared workflow_specs
  // after successful bootstrap. Target = SettingsStore-resolved
  // <workspaceSpecsRoot>/workflows。Bundle 含 workflow_specs[]，其 path
  // 指向 bundle 树中的 workflow YAML 文件。Router 将
  // 文件落在 <specsRoot>/workflows 下顶层 basename。扫描器
  // 可达性经对真实 scanWorkflowSpecFolder 调用证明
  // target dir (guard d43b7729 + 9f9ebe0a scanner-reachability lesson).
  it("POST /api/bundles/install 成功引导后声明的workflow_specs路由（已完成的分支） - 证明扫描仪的可达性", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origSpecsRoot = process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-workflow-specs-route-test-"));
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-workflow-specs-route-target-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_WORKSPACE_SPECS_ROOT = specsRoot;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-workflow-specs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wflow-target-"));
      try {
        // 合法 workflow YAML fixture，仿 workflow-spec-folder-scanner.test.ts:22-43
        //（workflow.id + workflow.version + workflow.roles + workflow.steps 非空）。
        // 缺这些，spec-library-workflow-scanner 会把它记为错误诊断行而非合法 workflow——破坏 scanner-reachability 证明。
        const validWorkflowYaml = `workflow:
  id: bundle-routed-test
  version: '1'
  objective: A bundle-routed workflow fixture
  target:
    rig: test-fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@test-fixture
  steps:
    - id: produce
      actor_role: producer
      objective: Draft.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;
        // 把合法 YAML 放进 bundle 的 package 源
        const workflowSrcDir = path.join(tmpDir, "test-pkg", "workflows");
        fs.mkdirSync(workflowSrcDir, { recursive: true });
        fs.writeFileSync(path.join(workflowSrcDir, "onboarding.yaml"), validWorkflowYaml);

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-workflow-specs", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "wflow-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // 声明路径可为逐字 package 路径；router 用 basename() 落到顶层（scanner-reachability 契约）。
          const tampered = `${original}\nworkflow_specs:\n  - packages/test-pkg/workflows/onboarding.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-workflow-specs",
          rigId: "01H000000000000000WSPEC01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.workflowSpecsRouting).toBeDefined();
        expect(body.workflowSpecsRouting.routedCount).toBe(1);
        expect(body.workflowSpecsRouting.records[0].status).toBe("routed");
        // router 用 basename()：声明的 "packages/test-pkg/workflows/onboarding.yaml" -> 落到 <specsRoot>/workflows/onboarding.yaml（仅顶层）。
        const expectedTarget = path.join(specsRoot, "workflows", "onboarding.yaml");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe(validWorkflowYaml);

        // Scanner-reachability 证明：用全新 WorkflowSpecCache 对 target 目录调用真实 scanWorkflowSpecFolder；
        // 断言至少有一条合法（非诊断）缓存 spec 匹配 fixture 的 id+version。
        // 这证明路由出的文件经实时 Library 扫描路径对 operator 可见（d43b7729 / 9f9ebe0a 契约）。
        const { createDb } = await import("../src/db/connection.js");
        const { migrate } = await import("../src/db/migrate.js");
        const { coreSchema } = await import("../src/db/migrations/001_core_schema.js");
        const { eventsSchema } = await import("../src/db/migrations/003_events.js");
        const { workflowSpecsSchema } = await import("../src/db/migrations/033_workflow_specs.js");
        const { workflowSpecsDiagnosticSchema } = await import("../src/db/migrations/040_workflow_specs_diagnostic.js");
        const { WorkflowSpecCache } = await import("../src/domain/workflow-spec-cache.js");
        const { scanWorkflowSpecFolder } = await import("../src/domain/spec-library-workflow-scanner.js");
        const scanDb = createDb();
        migrate(scanDb, [coreSchema, eventsSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
        const scanCache = new WorkflowSpecCache(scanDb);
        try {
          const scanResult = scanWorkflowSpecFolder({
            db: scanDb,
            cache: scanCache,
            folder: path.join(specsRoot, "workflows"),
            builtinDir: null,
          });
          // 该 fixture 是合法 workflow spec（workflow.id + version + roles + steps）；scanner 把它缓存为 `valid`，而非 `errors`。
          expect(scanResult.scanned).toBe(1);
          expect(scanResult.valid).toBe(1);
          expect(scanResult.errors).toBe(0);
          // 确认缓存行匹配 fixture 的 workflow.id + version。
          const cached = scanDb.prepare(`SELECT name, version FROM workflow_specs ORDER BY name, version`).all() as Array<{ name: string; version: string }>;
          expect(cached.length).toBeGreaterThanOrEqual(1);
          const found = cached.find((r) => r.name === "bundle-routed-test");
          expect(found).toBeDefined();
          expect(found!.version).toBe("1");
        } finally {
          scanDb.close();
        }
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origSpecsRoot === undefined) delete process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
      else process.env.OPENRIG_WORKSPACE_SPECS_ROOT = origSpecsRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
      fs.rmSync(specsRoot, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3e step 3 / B1 镜像纪律（留存的 5f410eee 解耦教训）：即使 operator 同时用 --skip-version-check 与 --force 预检覆盖，workflow_specs 路由也必须触发。
  // 路由独立于预检提取闸门。判别点：把 routeWorkflowSpecsAfterBootstrap 重新耦合到 installMeta 会使本测试失败（声明 workflow_specs[] 的 bundle 上两个 flag 都设时 workflowSpecsRouting 为 undefined）。
  it("即使同时设置了 --skip-version-check 和 --force （B1 镜像），POST /api/bundles/install 路由也会声明工作流规范", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origSpecsRoot = process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-wflow-dual-override-"));
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-wflow-dual-override-target-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_WORKSPACE_SPECS_ROOT = specsRoot;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override-wflow.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-wflow-target-"));
      try {
        const workflowSrcDir = path.join(tmpDir, "test-pkg", "workflows");
        fs.mkdirSync(workflowSrcDir, { recursive: true });
        fs.writeFileSync(path.join(workflowSrcDir, "dualflow.yaml"), "name: dualflow\nversion: '2.0'\nsteps: []\n");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override-wflow", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-wflow-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nworkflow_specs:\n  - packages/test-pkg/workflows/dualflow.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-wflow-dual",
          rigId: "01H000000000000000WDUAL01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        // 关键：两个覆盖 flag 都设——此路径下预检点 installMeta 为 null；workflow_specs-routing 包装器仍必须触发
        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.workflowSpecsRouting).toBeDefined();
        expect(body.workflowSpecsRouting.routedCount).toBe(1);
        expect(body.workflowSpecsRouting.records[0].status).toBe("routed");
        // router 用 basename() -> 落到 <specsRoot>/workflows 顶层
        const expectedTarget = path.join(specsRoot, "workflows", "dualflow.yaml");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe("name: dualflow\nversion: '2.0'\nsteps: []\n");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origSpecsRoot === undefined) delete process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
      else process.env.OPENRIG_WORKSPACE_SPECS_ROOT = origSpecsRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
      fs.rmSync(specsRoot, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3e step 3 / guard B1 在集成边界的镜像：
  // 重复 basename 的声明路径必须产出 routedCount=1 + 1 条 conflict 记录，
  // 而非 2 条 claim 同一 installedAt 的 routed 记录（d81456dc 捕获的误报类护栏）。
  it("POST /api/bundles/install 重复基名工作流规范：routedCount=1，第二个标记的冲突（真实的routedCount）", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origSpecsRoot = process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-wflow-dup-basename-"));
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-wflow-dup-basename-target-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_WORKSPACE_SPECS_ROOT = specsRoot;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dup-basename.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dup-basename-target-"));
      try {
        const wflowA = path.join(tmpDir, "test-pkg", "workflows-a");
        const wflowB = path.join(tmpDir, "test-pkg", "workflows-b");
        fs.mkdirSync(wflowA, { recursive: true });
        fs.mkdirSync(wflowB, { recursive: true });
        fs.writeFileSync(path.join(wflowA, "shared.yaml"), "content-A");
        fs.writeFileSync(path.join(wflowB, "shared.yaml"), "content-B");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dup-basename", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dup-basename-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // 两个声明路径共享 basename "shared.yaml"
          const tampered = `${original}\nworkflow_specs:\n  - packages/test-pkg/workflows-a/shared.yaml\n  - packages/test-pkg/workflows-b/shared.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-dup-basename",
          rigId: "01H000000000000000WDUPBN",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.workflowSpecsRouting).toBeDefined();
        // 如实的 routedCount：只有第一个声明路径真正被写入。第二个被标记 conflict，而非被静默覆盖。
        expect(body.workflowSpecsRouting.routedCount).toBe(1);
        expect(body.workflowSpecsRouting.rejectedCount).toBe(1);
        expect(body.workflowSpecsRouting.records).toHaveLength(2);
        expect(body.workflowSpecsRouting.records[0].status).toBe("routed");
        expect(body.workflowSpecsRouting.records[1].status).toBe("conflict");
        // 确认第一份内容存活（未被第二份静默覆盖）
        const expectedTarget = path.join(specsRoot, "workflows", "shared.yaml");
        expect(fs.existsSync(expectedTarget)).toBe(true);
        expect(fs.readFileSync(expectedTarget, "utf-8")).toBe("content-A");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origSpecsRoot === undefined) delete process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
      else process.env.OPENRIG_WORKSPACE_SPECS_ROOT = origSpecsRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
      fs.rmSync(specsRoot, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3f step 3：bootstrap 成功后，/install 路由声明的 context_packs。
  // target = 配置的 context.root（startup.ts:496 user-file root）。bundle 带 context_packs[]，路径指向 context-pack manifest.yaml；
  // router 把父目录拷到 <context.root>/<dirname>/。经对路由根调用真实 ContextPackLibraryService.scan() 证明消费者扫描可达（d491eca9 + 3cd581e3 file-vs-dir 判别的教训）。
  it("成功引导后声明 context_packs 的 POST /api/bundles/install 路由（已完成分支） — 证明消费者扫描可达性", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origContextRoot = process.env.OPENRIG_CONTEXT_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-context-packs-route-test-"));
    const configuredContextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-context-root-test-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_CONTEXT_ROOT = configuredContextRoot;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-context-packs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cpacks-target-"));
      try {
        // 构建一个合法 context-pack：含 manifest.yaml（name + version + files[]）的目录 + files[] 引用的文件。
        // 据 packages/daemon/src/domain/context-packs/manifest-parser.ts：manifest 需要 name、version、files[{path, role}]。
        const packDir = path.join(tmpDir, "test-pkg", "context-packs", "intent");
        fs.mkdirSync(packDir, { recursive: true });
        const validManifest = `name: bundle-routed-intent
version: '1'
taxonomy: mission
purpose: A bundle-routed context-pack fixture
files:
  - path: brief.md
    role: brief
    summary: One-line summary
`;
        fs.writeFileSync(path.join(packDir, "manifest.yaml"), validManifest);
        fs.writeFileSync(path.join(packDir, "brief.md"), "# Brief\nContent.");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-context-packs", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpacks-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\ncontext_packs:\n  - packages/test-pkg/context-packs/intent/manifest.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-cpacks",
          rigId: "01H000000000000000CPCK01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.contextPacksRouting).toBeDefined();
        expect(body.contextPacksRouting.routedCount).toBe(1);
        expect(body.contextPacksRouting.records[0].status).toBe("routed");
        // router 拷贝 manifest.yaml 的父目录：声明的 "packages/test-pkg/context-packs/intent/manifest.yaml" -> 父 basename "intent" -> target/intent/
        const expectedPackDir = path.join(configuredContextRoot, "intent");
        expect(fs.existsSync(expectedPackDir)).toBe(true);
        expect(fs.existsSync(path.join(expectedPackDir, "manifest.yaml"))).toBe(true);
        expect(fs.existsSync(path.join(expectedPackDir, "brief.md"))).toBe(true);

        // 消费者扫描可达性证明：对路由出的 target 根实例化真实 consumer + 断言该 pack 可见。
        const { ContextPackLibraryService } = await import("../src/domain/context-packs/context-pack-library-service.js");
        const consumer = new ContextPackLibraryService({
          roots: [{ path: configuredContextRoot, sourceType: "user_file" }],
        });
        const scanResult = consumer.scan();
        expect(scanResult.count).toBeGreaterThanOrEqual(1);
        expect(scanResult.errors).toEqual([]);
        // 确认 consumer 按 id 索引了我们路由出的 pack（name+version 来自 manifest 内部，而非目录名）。
        const entries = consumer.list();
        const found = entries.find((e) => e.name === "bundle-routed-intent");
        expect(found).toBeDefined();
        expect(found!.version).toBe("1");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origContextRoot === undefined) delete process.env.OPENRIG_CONTEXT_ROOT;
      else process.env.OPENRIG_CONTEXT_ROOT = origContextRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
      fs.rmSync(configuredContextRoot, { recursive: true, force: true });
    }
  });

  // B1 镜像：即使 operator 同时用 --skip-version-check 与 --force 预检覆盖，context_packs 路由也必须触发（留存的 5f410eee 解耦教训；主动发货）。
  it("POST /api/bundles/install 路由声明 context_packs 即使同时设置了 --skip-version-check 和 --force (B1 镜像)", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origContextRoot = process.env.OPENRIG_CONTEXT_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-cpacks-dual-override-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_CONTEXT_ROOT = path.join(auditHome, "context");
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override-cpacks.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-cpacks-target-"));
      try {
        const packDir = path.join(tmpDir, "test-pkg", "context-packs", "dualcontext");
        fs.mkdirSync(packDir, { recursive: true });
        fs.writeFileSync(path.join(packDir, "manifest.yaml"), `name: dualcontext-pack
version: '2'
files:
  - path: notes.md
    role: notes
`);
        fs.writeFileSync(path.join(packDir, "notes.md"), "dual content");

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override-cpacks", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-cpacks-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\ncontext_packs:\n  - packages/test-pkg/context-packs/dualcontext/manifest.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-cpacks-dual",
          rigId: "01H000000000000000CPDUAL",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        // 两个覆盖 flag 都设——预检点 installMeta 为 null；context-packs router 仍必须触发。
        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.contextPacksRouting).toBeDefined();
        expect(body.contextPacksRouting.routedCount).toBe(1);
        expect(body.contextPacksRouting.records[0].status).toBe("routed");
        expect(fs.existsSync(path.join(auditHome, "context", "dualcontext", "manifest.yaml"))).toBe(true);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origContextRoot === undefined) delete process.env.OPENRIG_CONTEXT_ROOT;
      else process.env.OPENRIG_CONTEXT_ROOT = origContextRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // 退化输入 dogfood（据 guard 3cd581e3 沿用"若廉价则纳入畸形 pack 拒绝"）：bundle 声明一个 context_pack，
  // 其 manifest.yaml 文件不在 bundle 树中。routedCount=0、status=missing、不拷任何 pack 到 target。
  it("POST /api/bundles/install 的 context_packs 退化输入：声明清单缺失时 status=missing，routedCount 不误报", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origContextRoot = process.env.OPENRIG_CONTEXT_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-cpacks-degenerate-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_CONTEXT_ROOT = path.join(auditHome, "context");
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "absent-cpacks.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "absent-cpacks-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "absent-cpacks", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "absent-cpacks-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // manifest 声明了一个 bundle 中不存在的 pack 路径
          const tampered = `${original}\ncontext_packs:\n  - packages/test-pkg/context-packs/nonexistent/manifest.yaml\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-cpacks-absent",
          rigId: "01H000000000000000CPABS0",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.contextPacksRouting).toBeDefined();
        // 如实的 routedCount：0（manifest 缺失——consumer 会跳过）
        expect(body.contextPacksRouting.routedCount).toBe(0);
        expect(body.contextPacksRouting.rejectedCount).toBe(1);
        expect(body.contextPacksRouting.records[0].status).toBe("missing");
        // 关键：没有任何东西落到 target
        expect(fs.existsSync(path.join(auditHome, "context", "nonexistent"))).toBe(false);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origContextRoot === undefined) delete process.env.OPENRIG_CONTEXT_ROOT;
      else process.env.OPENRIG_CONTEXT_ROOT = origContextRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // Item 6 / Checkpoint 7.3g step 3：bootstrap 成功后，/install 路由声明的 agent_images。
  // 据 PRD 第 197 行 + e7a0b253 契约：声明路径是图像目录（非 manifest 路径）。
  // target = <openrigHome>/agent-images（startup.ts:523 user-file root）。router 把整个图像目录拷到 <openrigHome>/agent-images/<basename>/。
  // 经对路由根调用真实 AgentImageLibraryService.scan 证明消费者扫描可达（cb0bf7b9 context_packs 证明的镜像）。
  it("POST /api/bundles/install 在成功引导后路由声明的 agent_images（completed 分支），证明消费者扫描可达", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-agent-images-route-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "with-agent-images.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aimgs-target-"));
      try {
        // 构建一个合法 agent_image：含 manifest.yaml（name + version + runtime + sourceSeat + sourceSessionId + sourceResumeToken + createdAt + files[]）的目录，据 agent-image-types.ts schema。
        const imageDir = path.join(tmpDir, "test-pkg", "agent-images", "seat-a");
        fs.mkdirSync(imageDir, { recursive: true });
        const validManifest = `name: bundle-routed-seat-a
version: '1'
runtime: claude-code
source_seat: velocity-driver@openrig-velocity
source_session_id: 01HABCDEF000000000000000
source_resume_token: 01HABCDEF000000000000000
created_at: '2026-05-31T00:00:00Z'
files: []
`;
        fs.writeFileSync(path.join(imageDir, "manifest.yaml"), validManifest);

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "with-agent-images", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimgs-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          // 与 PRD 一致：声明路径是图像目录，而非 manifest
          const tampered = `${original}\nagent_images:\n  - packages/test-pkg/agent-images/seat-a\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-aimgs",
          rigId: "01H000000000000000AIMG01",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.agentImagesRouting).toBeDefined();
        expect(body.agentImagesRouting.routedCount).toBe(1);
        expect(body.agentImagesRouting.records[0].status).toBe("routed");
        // router 拷贝整个图像目录：声明的 "packages/test-pkg/agent-images/seat-a" -> basename "seat-a" -> target/seat-a/
        const expectedImageDir = path.join(auditHome, "agent-images", "seat-a");
        expect(fs.existsSync(expectedImageDir)).toBe(true);
        expect(fs.existsSync(path.join(expectedImageDir, "manifest.yaml"))).toBe(true);

        // 消费者扫描可达性证明：对路由根实例化真实 AgentImageLibraryService + 断言该图像按 name+version 可见。
        const { AgentImageLibraryService } = await import("../src/domain/agent-images/agent-image-library-service.js");
        const consumer = new AgentImageLibraryService({
          roots: [{ path: path.join(auditHome, "agent-images"), sourceType: "user_file" }],
        });
        const scanResult = consumer.scan();
        expect(scanResult.count).toBeGreaterThanOrEqual(1);
        expect(scanResult.errors).toEqual([]);
        const entries = consumer.list();
        const found = entries.find((e) => e.name === "bundle-routed-seat-a");
        expect(found).toBeDefined();
        expect(found!.version).toBe("1");
        expect(found!.runtime).toBe("claude-code");
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // B1 镜像：即使 operator 同时用 --skip-version-check 与 --force 预检覆盖，agent_images 路由也必须触发。
  it("即使同时设置 --skip-version-check 和 --force，POST /api/bundles/install 仍路由声明的 agent_images（B1 镜像）", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-aimgs-dual-override-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "dual-override-aimgs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-aimgs-target-"));
      try {
        const imageDir = path.join(tmpDir, "test-pkg", "agent-images", "dualseat");
        fs.mkdirSync(imageDir, { recursive: true });
        fs.writeFileSync(path.join(imageDir, "manifest.yaml"), `name: dualseat-image
version: '2'
runtime: codex
source_seat: velocity-driver@openrig-velocity
source_session_id: 01HABCDEFDUAL00000000000
source_resume_token: 01HABCDEFDUAL00000000000
created_at: '2026-05-31T00:00:00Z'
files: []
`);

        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "dual-override-aimgs", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "dual-override-aimgs-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nagent_images:\n  - packages/test-pkg/agent-images/dualseat\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-aimgs-dual",
          rigId: "01H000000000000000AIMDUL",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bundlePath, targetRoot, autoApprove: true,
            skipVersionCheck: true, force: true,
          }),
        });
        const body = await installRes.json();
        expect(body.agentImagesRouting).toBeDefined();
        expect(body.agentImagesRouting.routedCount).toBe(1);
        expect(body.agentImagesRouting.records[0].status).toBe("routed");
        expect(fs.existsSync(path.join(auditHome, "agent-images", "dualseat", "manifest.yaml"))).toBe(true);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // 退化输入：声明的图像目录缺失。routedCount=0、status=missing、target 处无图像。
  it("POST /api/bundles/install 的 agent_images 退化输入：声明镜像缺失时 status=missing，routedCount 不误报", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-aimgs-degenerate-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "absent-aimgs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "absent-aimgs-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "absent-aimgs", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "absent-aimgs-stage-"));
        try {
          const tar = await import("tar");
          await tar.extract({ file: bundlePath, cwd: stagingDir });
          const bundleYamlPath = path.join(stagingDir, "bundle.yaml");
          const original = fs.readFileSync(bundleYamlPath, "utf-8");
          const tampered = `${original}\nagent_images:\n  - packages/test-pkg/agent-images/nonexistent\n`;
          fs.writeFileSync(bundleYamlPath, tampered);
          const { pack } = await import("../src/domain/bundle-archive.js");
          await pack(stagingDir, bundlePath);
        } finally {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }

        const stub = vi.fn().mockResolvedValue({
          status: "completed",
          runId: "test-run-aimgs-absent",
          rigId: "01H000000000000000AIMABS",
          stages: [{ stage: "resolve_spec", status: "ok" }],
          errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.agentImagesRouting).toBeDefined();
        expect(body.agentImagesRouting.routedCount).toBe(0);
        expect(body.agentImagesRouting.rejectedCount).toBe(1);
        expect(body.agentImagesRouting.records[0].status).toBe("missing");
        expect(fs.existsSync(path.join(auditHome, "agent-images", "nonexistent"))).toBe(false);
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("bundle 没有 agent_images[] 时 POST /api/bundles/install 不包含 agentImagesRouting", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-aimgs-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-aimgs.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-aimgs-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-aimgs-installer", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-aimgs",
          rigId: "01H000000000000000NOAIMG",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.agentImagesRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("bundle 没有 context_packs[] 时 POST /api/bundles/install 不包含 contextPacksRouting", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-cpacks-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-cpacks.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-cpacks-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-cpacks-installer", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-cpacks",
          rigId: "01H000000000000000NOCPCK",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.contextPacksRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("bundle 没有 workflow_specs[] 时 POST /api/bundles/install 不包含 workflowSpecsRouting", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const origSpecsRoot = process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-wflow-test-"));
    const specsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-wflow-target-"));
    process.env.OPENRIG_HOME = auditHome;
    process.env.OPENRIG_WORKSPACE_SPECS_ROOT = specsRoot;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-wflow.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-wflow-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-wflow-installer", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-wflow",
          rigId: "01H000000000000000NOWFLW",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.workflowSpecsRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      if (origSpecsRoot === undefined) delete process.env.OPENRIG_WORKSPACE_SPECS_ROOT;
      else process.env.OPENRIG_WORKSPACE_SPECS_ROOT = origSpecsRoot;
      fs.rmSync(auditHome, { recursive: true, force: true });
      fs.rmSync(specsRoot, { recursive: true, force: true });
    }
  });

  it("bundle 没有 plugins[] 时 POST /api/bundles/install 不包含 pluginsRouting", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-no-plugins-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-plugins.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-plugins-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-plugins-installer", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-plugins",
          rigId: "01H000000000000000NOPLG01",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.pluginsRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  it("bundle 没有 skills[] 时 POST /api/bundles/install 不包含 skillsRouting", async () => {
    const origHome = process.env.OPENRIG_HOME;
    const auditHome = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-skills-no-test-"));
    process.env.OPENRIG_HOME = auditHome;
    const origBootstrap = setup.bootstrapOrchestrator.bootstrap.bind(setup.bootstrapOrchestrator);
    try {
      const { specPath } = seedPackage();
      const bundlePath = path.join(tmpDir, "no-skills.rigbundle");
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-skills-target-"));
      try {
        await app.request("/api/bundles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specPath, bundleName: "no-skills", bundleVersion: "0.1.0", outputPath: bundlePath }),
        });

        const stub = vi.fn().mockResolvedValue({
          status: "completed", runId: "test-run-no-skills",
          rigId: "01H000000000000000NOSKIL01",
          stages: [], errors: [],
        });
        (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof stub }).bootstrap = stub;

        const installRes = await app.request("/api/bundles/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundlePath, targetRoot, autoApprove: true }),
        });
        const body = await installRes.json();
        expect(body.skillsRouting).toBeUndefined();
      } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
      }
    } finally {
      (setup.bootstrapOrchestrator as unknown as { bootstrap: typeof origBootstrap }).bootstrap = origBootstrap;
      if (origHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = origHome;
      fs.rmSync(auditHome, { recursive: true, force: true });
    }
  });

  // T11: Install concurrency lock
  it("并发安装 bundle 时返回 409", async () => {
    // Acquire lock manually
    setup.bootstrapOrchestrator.tryAcquire("/tmp/locked.rigbundle");

    const res = await app.request("/api/bundles/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: "/tmp/locked.rigbundle", targetRoot: "/tmp/target" }),
    });

    expect(res.status).toBe(409);
    setup.bootstrapOrchestrator.release("/tmp/locked.rigbundle");
  });
});
