import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createTestApp } from "./helpers/test-app.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


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

const SKILL_CONTENT = "# Helper Skill\nDo helpful things.";

const GUIDANCE_MANIFEST_YAML = `
schema_version: 1
name: guidance-pkg
version: "1.0.0"
summary: A guidance package
compatibility:
  runtimes:
    - claude-code
exports:
  guidance:
    - source: guidance/rules.md
      name: rules
      kind: claude_md
      supported_scopes:
        - project_shared
      default_scope: project_shared
      merge_strategy: managed_block
`.trim();

const MIXED_MANIFEST_YAML = `
schema_version: 1
name: mixed-pkg
version: "1.0.0"
summary: Skills + guidance
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/tool
      name: tool
      supported_scopes:
        - project_shared
      default_scope: project_shared
  guidance:
    - source: guidance/rules.md
      name: rules
      kind: claude_md
      supported_scopes:
        - project_shared
      default_scope: project_shared
      merge_strategy: managed_block
`.trim();

describe("Package API 路由", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;
  let pkgDir: string;
  let targetDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-routes-"));
    pkgDir = path.join(tmpDir, "pkg");
    targetDir = path.join(tmpDir, "target");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePkg(dir: string, manifestYaml: string, files?: Record<string, string>) {
    fs.writeFileSync(path.join(dir, "package.yaml"), manifestYaml);
    if (files) {
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
    }
  }

  // --- 测试 1：POST /validate 有效 manifest → 200 ---
  it("POST /api/packages/validate 有效 manifest → 200，并返回 manifest 摘要", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    const res = await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.manifest.name).toBe("test-pkg");
    expect(body.manifest.version).toBe("1.0.0");
    expect(body.manifest.summary).toBe("A test package");
    expect(body.manifest.runtimes).toContain("claude-code");
    expect(body.manifest.exportCounts.skills).toBe(1);
  });

  // --- 测试 2：POST /validate 无效 manifest → 400，并返回 errors[] ---
  it("POST /api/packages/validate 无效 manifest → 400，并返回 errors 数组", async () => {
    writePkg(pkgDir, "schema_version: 1\n# missing name, version, etc.");

    const res = await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    // validation failure 不使用单数 "error" 字段。
    expect(body.error).toBeUndefined();
  });

  // --- 测试 3：POST /validate 缺少 package.yaml → 400，并返回 error 字符串 ---
  it("POST /api/packages/validate 缺少 package.yaml → 400，并返回 error 字符串", async () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });

    const res = await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: emptyDir }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(typeof body.error).toBe("string");
    // resolution failure 不使用 errors 数组。
    expect(body.errors).toBeUndefined();
  });

  // --- 测试 4：POST /plan → 200，并返回已分类 entry ---
  it("POST /api/packages/plan → 200，并返回已分类 entry", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    const res = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.packageName).toBe("test-pkg");
    expect(body.packageVersion).toBe("1.0.0");
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(typeof body.actionable).toBe("number");
    expect(typeof body.deferred).toBe("number");
    expect(typeof body.conflicts).toBe("number");
    expect(typeof body.noOps).toBe("number");
  });

  // --- 测试 5：POST /install 干净 repo → 201，并返回 applied + verification ---
  it("POST /api/packages/install 干净 repo → 201，并返回 install 结果", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.installId).toBeTruthy();
    expect(body.packageId).toBeTruthy();
    expect(body.packageName).toBe("test-pkg");
    expect(Array.isArray(body.applied)).toBe(true);
    expect(body.applied.length).toBeGreaterThan(0);
    expect(body.verification).toBeTruthy();
    expect(body.verification.passed).toBe(true);

    // 验证文件确实已写入。
    const skillPath = path.join(targetDir, ".claude", "skills", "helper", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(fs.readFileSync(skillPath, "utf-8")).toBe(SKILL_CONTENT);
  });

  // --- 测试 6：POST /install 存在 conflict → 409 ---
  it("POST /api/packages/install 存在 conflict → 409 conflict_blocked", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // 预先创建内容不同且发生冲突的 skill。
    const conflictPath = path.join(targetDir, ".claude", "skills", "helper", "SKILL.md");
    fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
    fs.writeFileSync(conflictPath, "# Different content");

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("conflict_blocked");
    expect(Array.isArray(body.conflicts)).toBe(true);
    expect(body.conflicts.length).toBeGreaterThan(0);
  });

  // --- 测试 7：POST /install 使用 allowMerge → 201 merged guidance ---
  it("POST /api/packages/install 使用 allowMerge → 201 merged guidance", async () => {
    writePkg(pkgDir, GUIDANCE_MANIFEST_YAML, {
      "guidance/rules.md": "Follow these rules.",
    });

    // 预先创建 CLAUDE.md，使 guidance 分类为 managed_merge。
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing content\n");

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
        allowMerge: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.applied.length).toBeGreaterThan(0);

    // 验证 managed block 已插入。
    const claudeMd = fs.readFileSync(path.join(targetDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("<!-- BEGIN OpenRig MANAGED BLOCK: guidance-pkg -->");
    expect(claudeMd).toContain("<!-- END OpenRig MANAGED BLOCK: guidance-pkg -->");
    expect(claudeMd).toContain("# Existing content");
  });

  // --- 测试 8：POST /install 混合 policy：skill 获批，guidance 被拒绝 ---
  it("POST /api/packages/install 混合 policy → 201，并返回 applied + policyRejected", async () => {
    writePkg(pkgDir, MIXED_MANIFEST_YAML, {
      "skills/tool/SKILL.md": "# Tool skill",
      "guidance/rules.md": "Follow these rules.",
    });

    // 预先创建 CLAUDE.md，使 guidance 分类为 managed_merge。
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing\n");

    // 不设置 allowMerge——skill 属于 safe_projection（获批），guidance 属于 managed_merge（被拒绝）。
    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    // skill 已应用。
    expect(body.applied.length).toBeGreaterThan(0);
    expect(body.applied.some((e: { exportType: string }) => e.exportType === "skill")).toBe(true);
    // guidance 被 policy 拒绝。
    expect(Array.isArray(body.policyRejected)).toBe(true);
    expect(body.policyRejected.length).toBeGreaterThan(0);
    expect(body.policyRejected.some((r: { entry: { exportType: string } }) => r.entry.exportType === "guidance")).toBe(true);
  });

  // --- 测试 9：POST /install 只有 guidance 且无 allowMerge → 422 ---
  it("POST /api/packages/install 只有 guidance 且无 allowMerge → 422 policy_rejected", async () => {
    writePkg(pkgDir, GUIDANCE_MANIFEST_YAML, {
      "guidance/rules.md": "Follow these rules.",
    });

    // 预先创建 CLAUDE.md，使 guidance 分类为 managed_merge。
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing\n");

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
        // 未设置 allowMerge。
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("policy_rejected");
    expect(Array.isArray(body.rejected)).toBe(true);
    expect(body.rejected.length).toBeGreaterThan(0);
  });

  // --- 测试 10：POST /rollback → 200 ---
  it("POST /api/packages/:installId/rollback → 200 rollback 结果", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // 首次 install。
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    const { installId } = await installRes.json();

    // 现在 rollback。
    const res = await app.request(`/api/packages/${installId}/rollback`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installId).toBe(installId);
    expect(Array.isArray(body.restored)).toBe(true);
    expect(Array.isArray(body.deleted)).toBe(true);

    // skill 文件应已消失（它是新文件，无 backup → 删除）。
    const skillPath = path.join(targetDir, ".claude", "skills", "helper", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(false);
  });

  // --- 测试 11：POST /rollback 未找到 → 404 ---
  it("POST /api/packages/:installId/rollback 未找到 → 404", async () => {
    const res = await app.request("/api/packages/nonexistent-id/rollback", {
      method: "POST",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("未找到安装记录");
  });

  // --- 测试 12：GET /packages → 200 列表 ---
  it("GET /api/packages → 200 package 列表", async () => {
    const res = await app.request("/api/packages");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  // --- 测试 13：GET /:packageId/installs → 200 列表 ---
  it("GET /api/packages/:packageId/installs → 200 install 列表", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // 先 install。
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    const { packageId } = await installRes.json();

    const res = await app.request(`/api/packages/${packageId}/installs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
  });

  // --- 测试 14：GET /installs/:installId/journal → 200 entry ---
  it("GET /api/packages/installs/:installId/journal → 200 journal 条目", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    const { installId } = await installRes.json();

    const res = await app.request(`/api/packages/installs/${installId}/journal`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  // --- 测试 15：GET /installs/:installId/journal 未找到 → 404 ---
  it("GET /api/packages/installs/:installId/journal 未找到 → 404", async () => {
    const res = await app.request("/api/packages/installs/nonexistent/journal");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("未找到安装记录");
  });

  // --- 测试 16：去重——install 相同 name+version 两次 → 1 个 package、2 个 install ---
  it("install 相同 package 两次 → 1 个 package row、2 个 install row", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // 第一次 install。
    const res1 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res1.status).toBe(201);
    const body1 = await res1.json();
    const packageId = body1.packageId;

    // rollback 第一次 install，使第二次的 target 保持干净。
    await app.request(`/api/packages/${body1.installId}/rollback`, { method: "POST" });

    // 第二次 install——相同 package。
    const res2 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res2.status).toBe(201);
    const body2 = await res2.json();

    // 复用相同 package ID。
    expect(body2.packageId).toBe(packageId);

    // GET /packages → 1 个 package。
    const pkgRes = await app.request("/api/packages");
    const pkgs = await pkgRes.json();
    expect(pkgs.length).toBe(1);

    // GET /:packageId/installs → 2 个 install。
    const installsRes = await app.request(`/api/packages/${packageId}/installs`);
    const installs = await installsRes.json();
    expect(installs.length).toBe(2);
  });

  // --- 测试 17：POST /plan 使用无效 manifest → 400，并返回 errors[] ---
  it("POST /api/packages/plan 使用无效 manifest → 400，并返回 errors 数组", async () => {
    writePkg(pkgDir, "schema_version: 1\n# missing name, version, etc.");

    const res = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  // --- 测试 18：POST /install 使用无效 manifest → 400，并返回 errors[] ---
  it("POST /api/packages/install 使用无效 manifest → 400，并返回 errors 数组", async () => {
    writePkg(pkgDir, "schema_version: 1\n# missing name, version, etc.");

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  // --- 测试 19：POST /install verification 失败 → 500 verification_failed ---
  it("POST /api/packages/install verification 失败 → 500 verification_failed", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, {
      "skills/helper/SKILL.md": SKILL_CONTENT,
    });

    // spy verifier 以强制失败。
    vi.spyOn(setup.installVerifier, "verify").mockReturnValueOnce({
      passed: false,
      installId: "will-be-overridden",
      entries: [],
      statusCheck: { name: "forced_failure", passed: false, expected: "pass", actual: "forced fail" },
    });

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("verification_failed");
    expect(body.error).toBe("应用后校验失败");
    expect(typeof body.installId).toBe("string");
    expect(body.verification).toBeTruthy();
    expect(body.verification.passed).toBe(false);

    vi.restoreAllMocks();
  });

  // === PUX-T02：Summary endpoint ===

  // --- 测试：GET /api/packages/summary 返回 install count 与最新 status ---
  it("GET /api/packages/summary 返回包含 installCount 与 latestInstallStatus 的 package", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // install 一个 package。
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(installRes.status).toBe(201);

    const res = await app.request("/api/packages/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe("test-pkg");
    expect(body[0].installCount).toBe(1);
    expect(body[0].latestInstallStatus).toBe("applied");
  });

  // --- 测试：GET /api/packages/summary 的 latestInstallStatus 遵循实际最新 install ---
  it("GET /api/packages/summary 的 latestInstallStatus 确定性反映最新 install", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // 第一次 install——成功（applied）。
    const res1 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res1.status).toBe(201);
    const { installId } = await res1.json();

    // rollback 第一次 install（status -> rolled_back）。
    await app.request(`/api/packages/${installId}/rollback`, { method: "POST" });

    // 第二次 install——成功（applied）。
    const res2 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res2.status).toBe(201);

    // summary 应显示 2 个 install，且最新 status = applied（不是 rolled_back）。
    const summaryRes = await app.request("/api/packages/summary");
    const summary = await summaryRes.json();
    expect(summary.length).toBe(1);
    expect(summary[0].installCount).toBe(2);
    expect(summary[0].latestInstallStatus).toBe("applied");
  });

  // === PUX-T03：扩展的 API endpoint 测试 ===

  // --- 测试：POST /validate 返回 roles + requirements ---
  it("POST /api/packages/validate 返回 roles 与 requirements", async () => {
    const richManifest = `
schema_version: 1
name: rich-pkg
version: "1.0.0"
summary: Package with roles and requirements
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/tool
      name: tool
      supported_scopes:
        - project_shared
      default_scope: project_shared
roles:
  - name: dev
    description: Developer role
    skills:
      - tool
requirements:
  cli_tools:
    - name: jq
  system_packages:
    - name: git
`.trim();

    writePkg(pkgDir, richManifest, {
      "skills/tool/SKILL.md": "# Tool\nDo things.",
    });

    const res = await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);

    // 角色。
    expect(Array.isArray(body.manifest.roles)).toBe(true);
    expect(body.manifest.roles.length).toBe(1);
    expect(body.manifest.roles[0].name).toBe("dev");
    expect(body.manifest.roles[0].description).toBe("Developer role");

    // 要求。
    expect(Array.isArray(body.manifest.requirements.cliTools)).toBe(true);
    expect(body.manifest.requirements.cliTools.length).toBe(1);
    expect(body.manifest.requirements.cliTools[0].name).toBe("jq");

    expect(Array.isArray(body.manifest.requirements.systemPackages)).toBe(true);
    expect(body.manifest.requirements.systemPackages.length).toBe(1);
    expect(body.manifest.requirements.systemPackages[0].name).toBe("git");
  });

  // --- 测试：POST /plan 使用 allowMerge 返回带 policy annotation 的 entry ---
  it("POST /api/packages/plan 使用 allowMerge 返回带 policy annotation 的 entry", async () => {
    writePkg(pkgDir, GUIDANCE_MANIFEST_YAML, {
      "guidance/rules.md": "Follow these rules.",
    });

    // 预先创建 CLAUDE.md，使 guidance 分类为 managed_merge。
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing content\n");

    // 不使用 allowMerge——guidance 应被拒绝。
    const resRejected = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
        allowMerge: false,
      }),
    });

    expect(resRejected.status).toBe(200);
    const bodyRejected = await resRejected.json();
    const rejectedEntry = bodyRejected.entries.find(
      (e: { exportType: string }) => e.exportType === "guidance",
    );
    expect(rejectedEntry).toBeTruthy();
    expect(rejectedEntry.policyStatus).toBe("rejected");
    expect(bodyRejected.rejected).toBeGreaterThan(0);

    // 使用 allowMerge——guidance 应获批。
    const resApproved = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: pkgDir,
        targetRoot: targetDir,
        runtime: "claude-code",
        allowMerge: true,
      }),
    });

    expect(resApproved.status).toBe(200);
    const bodyApproved = await resApproved.json();
    const approvedEntry = bodyApproved.entries.find(
      (e: { exportType: string }) => e.exportType === "guidance",
    );
    expect(approvedEntry).toBeTruthy();
    expect(approvedEntry.policyStatus).toBe("approved");
    expect(bodyApproved.actionable).toBeGreaterThan(0);
  });

  // === PUX-T04：Package detail + install history ===

  // --- 测试：GET /api/packages/:packageId 返回 package 或 404 ---
  it("GET /api/packages/:packageId 返回 package 或 404", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // install package 以创建 package record。
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(installRes.status).toBe(201);
    const { packageId } = await installRes.json();

    // GET 已有 package → 200。
    const res = await app.request(`/api/packages/${packageId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("test-pkg");
    expect(body.version).toBe("1.0.0");

    // GET 不存在 package → 404。
    const res404 = await app.request("/api/packages/nonexistent");
    expect(res404.status).toBe(404);
  });

  // --- 测试：GET /api/packages/:packageId/installs 返回带 appliedCount 与 deferredCount 的 InstallSummary ---
  it("GET /api/packages/:packageId/installs 返回带 appliedCount 与 deferredCount 的 InstallSummary", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // install 一个 package。
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(installRes.status).toBe(201);
    const { packageId } = await installRes.json();

    // GET 此 package 的 install → 200 数组。
    const res = await app.request(`/api/packages/${packageId}/installs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);

    // 断言 appliedCount 是大于 0 的数字。
    expect(typeof body[0].appliedCount).toBe("number");
    expect(body[0].appliedCount).toBeGreaterThan(0);

    // 显式断言 deferredCount === null。
    expect(body[0].deferredCount).toBe(null);
  });

  // --- 测试：install history 确定性排序同一秒内的 install ---
  it("GET /api/packages/:packageId/installs 按 rowid DESC 排序同一秒的 install", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // 第一次 install。
    const res1 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res1.status).toBe(201);
    const { installId: id1, packageId } = await res1.json();

    // rollback，使第二次 install 的 target 保持干净。
    await app.request(`/api/packages/${id1}/rollback`, { method: "POST" });

    // 第二次 install——同一秒（内存 DB 中二者获得相同 datetime('now')）。
    const res2 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res2.status).toBe(201);
    const { installId: id2 } = await res2.json();

    // 最新项在前（id2 先于 id1）。
    const listRes = await app.request(`/api/packages/${packageId}/installs`);
    const installs = await listRes.json();
    expect(installs.length).toBe(2);
    expect(installs[0].id).toBe(id2);
    expect(installs[1].id).toBe(id1);
  });

  // === PUX-T00：Event 发出测试 ===

  function getEvents(database: Database.Database): Array<{ type: string; payload: string }> {
    return database.prepare("SELECT type, payload FROM events ORDER BY seq").all() as Array<{ type: string; payload: string }>;
  }

  // --- 测试 20：Install 发出 package.installed event ---
  it("POST /api/packages/install 发出 package.installed event", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    const events = getEvents(db).filter((e) => e.type === "package.installed");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.type).toBe("package.installed");
    expect(payload.packageName).toBe("test-pkg");
    expect(payload.packageVersion).toBe("1.0.0");
    expect(typeof payload.installId).toBe("string");
    expect(typeof payload.applied).toBe("number");
    expect(typeof payload.deferred).toBe("number");
  });

  // --- 测试 21：Rollback 发出 package.rolledback event ---
  it("POST /api/packages/:installId/rollback 发出 package.rolledback event", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    const { installId } = await installRes.json();

    await app.request(`/api/packages/${installId}/rollback`, { method: "POST" });

    const events = getEvents(db).filter((e) => e.type === "package.rolledback");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.installId).toBe(installId);
    expect(typeof payload.restored).toBe("number");
  });

  // --- 测试 22：Install conflict 发出 package.install_failed ---
  it("POST /api/packages/install 存在 conflict 时发出 package.install_failed", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // 创建发生冲突的 skill。
    const conflictPath = path.join(targetDir, ".claude", "skills", "helper", "SKILL.md");
    fs.mkdirSync(path.dirname(conflictPath), { recursive: true });
    fs.writeFileSync(conflictPath, "# Different");

    await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    const events = getEvents(db).filter((e) => e.type === "package.install_failed");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.code).toBe("conflict_blocked");
    expect(payload.packageName).toBe("test-pkg");
  });

  // --- 测试 23：SSE 全局 stream 收到 package.installed event ---
  it("GET /api/events（全局）通过 SSE 收到 package.installed", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // 启动 SSE stream（无 rigId = 全局）。
    const ssePromise = app.request("/api/events");

    // 短暂等待 SSE 完成订阅。
    await new Promise((r) => setTimeout(r, 50));

    // 触发 install。
    await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    // 读取 SSE event。
    const sseRes = await ssePromise;
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 1000;
    const sseEvents: Array<{ id: string; data: string }> = [];

    while (sseEvents.length < 1 && Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))
        ),
      ]);
      if (done && !value) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const block of blocks) {
        if (!block.trim()) continue;
        let id = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (data) sseEvents.push({ id, data });
      }
    }
    reader.cancel().catch(() => {});

    // 在 SSE stream 中查找 package.installed event。
    const installedEvents = sseEvents.filter((e) => {
      const parsed = JSON.parse(e.data);
      return parsed.type === "package.installed";
    });
    expect(installedEvents.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(installedEvents[0]!.data);
    expect(parsed.packageName).toBe("test-pkg");
  });

  // --- 测试 24：Validate 发出 package.validated event ---
  it("POST /api/packages/validate 发出 package.validated event", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    const events = getEvents(db).filter((e) => e.type === "package.validated");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.packageName).toBe("test-pkg");
    expect(payload.valid).toBe(true);
  });

  // --- 测试 25：Plan 发出 package.planned event ---
  it("POST /api/packages/plan 发出 package.planned event", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });

    const events = getEvents(db).filter((e) => e.type === "package.planned");
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.packageName).toBe("test-pkg");
    expect(typeof payload.actionable).toBe("number");
    expect(typeof payload.deferred).toBe("number");
    expect(typeof payload.conflicts).toBe("number");
  });

  // --- 测试 26：带 rigId 的 SSE 仍有效（向后兼容）---
  it("GET /api/events?rigId=X 只返回 rig-scoped event，不返回 package event", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // 先发出 rig event。
    setup.eventBus.emit({ type: "rig.created", rigId: "test-rig" });

    // 触发 package event。
    await app.request("/api/packages/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir }),
    });

    // 带 rigId 的 SSE 应只收到 rig event。
    const sseRes = await app.request("/api/events?rigId=test-rig");
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 500;
    const sseEvents: Array<{ data: string }> = [];

    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))
        ),
      ]);
      if (done && !value) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      const blocks = buffer.split("\n\n");
      buffer = blocks.pop()!;
      for (const block of blocks) {
        if (!block.trim()) continue;
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) data = line.slice(5).trim();
        }
        if (data) sseEvents.push({ data });
      }
    }
    reader.cancel().catch(() => {});

    // 应有 rig.created，但无 package.validated。
    const types = sseEvents.map((e) => JSON.parse(e.data).type);
    expect(types).toContain("rig.created");
    expect(types).not.toContain("package.validated");
  });

  // --- 测试 27：manifest_hash_mismatch 发出 package.install_failed ---
  it("POST /api/packages/install 遇到 manifest_hash_mismatch 时发出 package.install_failed", async () => {
    // 使用原始 manifest 首次 install。
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });
    const res1 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(res1.status).toBe(201);

    // 修改 manifest（内容不同，name+version 相同）。
    const altManifest = VALID_MANIFEST_YAML.replace("A test package", "A DIFFERENT test package");
    writePkg(pkgDir, altManifest, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // 第二次 install——name+version 相同，manifest hash 不同。
    const altTargetDir = path.join(tmpDir, "target2");
    fs.mkdirSync(altTargetDir, { recursive: true });
    const res2 = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: altTargetDir, runtime: "claude-code" }),
    });

    expect(res2.status).toBe(409);
    const body = await res2.json();
    expect(body.code).toBe("manifest_hash_mismatch");

    // 验证已发出 event。
    const events = getEvents(db).filter((e) => e.type === "package.install_failed");
    const hashMismatchEvents = events.filter((e) => JSON.parse(e.payload).code === "manifest_hash_mismatch");
    expect(hashMismatchEvents.length).toBe(1);
    const payload = JSON.parse(hashMismatchEvents[0]!.payload);
    expect(payload.packageName).toBe("test-pkg");
    expect(payload.code).toBe("manifest_hash_mismatch");
  });

  // --- 测试 28：package.planned event actionable count 与响应匹配（R2-M1）---
  it("POST /api/packages/plan event 的 actionable count 与应用 policy 后的响应匹配", async () => {
    // 只有 guidance 的 package：allowMerge:false 时，policy 拒绝 managed_merge entry，因此响应
    // actionable=0，但 policy 前 actionable=1。
    writePkg(pkgDir, GUIDANCE_MANIFEST_YAML, { "guidance/rules.md": "# Rules" });
    // 创建已有 CLAUDE.md，使 guidance 分类为 managed_merge。
    fs.writeFileSync(path.join(targetDir, "CLAUDE.md"), "# Existing");

    const res = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code", allowMerge: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // 响应为 0 actionable，因为没有 allowMerge 时 policy 拒绝 managed_merge。
    expect(body.actionable).toBe(0);
    expect(body.rejected).toBe(1);

    // event 必须与响应匹配——actionable:0，而非 policy 前的 1。
    const events = getEvents(db).filter((e) => e.type === "package.planned");
    expect(events.length).toBe(1);
    const eventPayload = JSON.parse(events[0]!.payload);
    expect(eventPayload.actionable).toBe(body.actionable);
  });

  // --- 测试 29：/plan 遇到不存在 role 时返回 400（R2-M2）---
  it("POST /api/packages/plan 使用不存在 role 时返回 400", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    const res = await app.request("/api/packages/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code", roleName: "nonexistent" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("plan_error");
    expect(body.error).toContain("nonexistent");
  });

  // --- 测试 30：/install 遇到不存在 role 时返回 400（R2-M2）---
  it("POST /api/packages/install 使用不存在 role 时返回 400", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    const res = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code", roleName: "nonexistent" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("plan_error");
    expect(body.error).toContain("nonexistent");
  });

  // --- 测试 31：重复 rollback 返回 409，journal/event 不增长（R2-M3）---
  it("对已 rollback 的 install 再次 POST rollback 返回 409，journal/event 不增长", async () => {
    writePkg(pkgDir, VALID_MANIFEST_YAML, { "skills/helper/SKILL.md": SKILL_CONTENT });

    // 安装。
    const installRes = await app.request("/api/packages/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: pkgDir, targetRoot: targetDir, runtime: "claude-code" }),
    });
    expect(installRes.status).toBe(201);
    const { installId } = await installRes.json();

    // 第一次 rollback——应成功。
    const rollback1 = await app.request(`/api/packages/${installId}/rollback`, { method: "POST" });
    expect(rollback1.status).toBe(200);

    // 捕获第一次 rollback 后的 journal 与 event 数量。
    const journalAfterFirst = db.prepare("SELECT COUNT(*) AS cnt FROM install_journal WHERE install_id = ?").get(installId) as { cnt: number };
    const eventsAfterFirst = getEvents(db).filter((e) => e.type === "package.rolledback").length;

    // 第二次 rollback——应被拒绝。
    const rollback2 = await app.request(`/api/packages/${installId}/rollback`, { method: "POST" });
    expect(rollback2.status).toBe(409);
    const body = await rollback2.json();
    expect(body.code).toBe("not_applied");
    expect(body.status).toBe("rolled_back");

    // journal 数量不得增长。
    const journalAfterSecond = db.prepare("SELECT COUNT(*) AS cnt FROM install_journal WHERE install_id = ?").get(installId) as { cnt: number };
    expect(journalAfterSecond.cnt).toBe(journalAfterFirst.cnt);

    // event 数量不得增长。
    const eventsAfterSecond = getEvents(db).filter((e) => e.type === "package.rolledback").length;
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
  });
});

describe("AgentSpec 校验路由", () => {
  let db: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createTestApp>["app"];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const setup = createTestApp(db);
    app = setup.app;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /api/agents/validate 使用有效 YAML 时返回 valid:true", async () => {
    const yaml = 'name: test-agent\nversion: "1.0"\nprofiles: {}';
    const res = await app.request("/api/agents/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
  });

  it("POST /api/agents/validate 使用空 body 时返回 400", async () => {
    const res = await app.request("/api/agents/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "  ",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors).toContain("空的 YAML 请求体");
  });

  it("POST /api/agents/validate 使用无效 spec 时返回错误", async () => {
    const yaml = "summary: missing name and version";
    const res = await app.request("/api/agents/validate", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });
});
