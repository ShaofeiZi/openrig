import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { PackageRepository } from "../src/domain/package-repository.js";
import { InstallRepository } from "../src/domain/install-repository.js";
import { InstallEngine, type EngineFsOps } from "../src/domain/install-engine.js";
import { InstallVerifier } from "../src/domain/install-verifier.js";
import type { InstallPlanEntry } from "../src/domain/install-planner.js";
import type { RefinedInstallPlan } from "../src/domain/conflict-detector.js";
import type { PolicyResult } from "../src/domain/install-policy.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function realFs(): EngineFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (src, dest) => fs.copyFileSync(src, dest),
    deleteFile: (p) => fs.unlinkSync(p),
  };
}

function makeEntry(overrides: Partial<InstallPlanEntry>): InstallPlanEntry {
  return {
    exportType: "skill", exportName: "test", classification: "safe_projection",
    targetPath: "", scope: "project_shared", deferred: false, ...overrides,
  };
}

function makePlan(entries: InstallPlanEntry[]): RefinedInstallPlan {
  return {
    packageName: "test-pkg", packageVersion: "1.0.0", sourceRef: "/pkg",
    entries, actionable: entries.filter((e) => !e.deferred),
    deferred: [], conflicts: [], noOps: [],
  };
}

describe("InstallVerifier", () => {
  let db: Database.Database;
  let pkgRepo: PackageRepository;
  let installRepo: InstallRepository;
  let tmpDir: string;
  let repoRoot: string;
  let pkgRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    pkgRepo = new PackageRepository(db);
    installRepo = new InstallRepository(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-verify-"));
    repoRoot = path.join(tmpDir, "repo");
    pkgRoot = path.join(tmpDir, "pkg");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(pkgRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedAndInstallSkill(): string {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const srcPath = path.join(pkgRoot, "skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    fs.writeFileSync(srcPath, "# Foo", "utf-8");

    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    const entry = makeEntry({ targetPath, sourcePath: srcPath });
    const engine = new InstallEngine(installRepo, realFs());
    const result = engine.apply({ approved: [entry], rejected: [] }, makePlan([entry]), pkg.id, repoRoot);
    return result.installId;
  }

  function seedAndInstallGuidance(): string {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const srcPath = path.join(pkgRoot, "guidance/AGENTS.md");
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    fs.writeFileSync(srcPath, "Review carefully.", "utf-8");

    const targetPath = path.join(repoRoot, "AGENTS.md");
    const entry = makeEntry({ exportType: "guidance", classification: "safe_projection", targetPath, sourcePath: srcPath });
    const engine = new InstallEngine(installRepo, realFs());
    const result = engine.apply({ approved: [entry], rejected: [] }, makePlan([entry]), pkg.id, repoRoot);
    return result.installId;
  }

  // 测试 1：干净安装 → 所有检查通过。
  it("干净安装 → 所有检查通过", () => {
    const installId = seedAndInstallSkill();
    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(true);
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of result.entries) {
      for (const check of entry.checks) {
        expect(check.passed).toBe(true);
      }
    }
  });

  // 测试 2：缺少目标文件 → 验证失败。
  it("缺少目标文件 → 验证失败", () => {
    const installId = seedAndInstallSkill();
    // 删除目标文件。
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.unlinkSync(targetPath);

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(false);
    const failedCheck = result.entries[0]!.checks.find((c) => c.name === "target_exists");
    expect(failedCheck).toBeDefined();
    expect(failedCheck!.passed).toBe(false);
  });

  // 测试 3：目标已修改（hash 不匹配）→ 验证失败。
  it("目标内容已修改 → 验证失败", () => {
    const installId = seedAndInstallSkill();
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.writeFileSync(targetPath, "# Tampered content", "utf-8");

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(false);
    const hashCheck = result.entries[0]!.checks.find((c) => c.name === "content_hash");
    expect(hashCheck).toBeDefined();
    expect(hashCheck!.passed).toBe(false);
  });

  // 测试 4：缺少 managed block marker → 验证失败。
  it("guidance 缺少 managed block marker → 验证失败", () => {
    const installId = seedAndInstallGuidance();
    const targetPath = path.join(repoRoot, "AGENTS.md");
    // 用缺少 marker 的内容覆盖。
    fs.writeFileSync(targetPath, "No markers here.", "utf-8");

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(false);
    const markerCheck = result.entries[0]!.checks.find((c) => c.name === "managed_block_markers");
    expect(markerCheck).toBeDefined();
    expect(markerCheck!.passed).toBe(false);
  });

  // 测试 5：备份完整性通过。
  it("被覆盖文件的备份完整性检查通过", () => {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const srcPath = path.join(pkgRoot, "skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(srcPath), { recursive: true });
    fs.writeFileSync(srcPath, "# New", "utf-8");

    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "# Original", "utf-8");

    const entry = makeEntry({ targetPath, sourcePath: srcPath });
    const engine = new InstallEngine(installRepo, realFs());
    const result = engine.apply({ approved: [entry], rejected: [] }, makePlan([entry]), pkg.id, repoRoot);

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const verifyResult = verifier.verify(result.installId);

    expect(verifyResult.passed).toBe(true);
    const backupCheck = verifyResult.entries[0]!.checks.find((c) => c.name === "backup_hash");
    expect(backupCheck).toBeDefined();
    expect(backupCheck!.passed).toBe(true);
  });

  // 测试 6：逐 entry status 带检查 detail。
  it("验证结果包含逐 entry 检查 detail", () => {
    const installId = seedAndInstallSkill();
    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.journalId).toBeDefined();
    expect(result.entries[0]!.targetPath).toContain("SKILL.md");
    expect(result.entries[0]!.checks.length).toBeGreaterThanOrEqual(2); // target_exists + content_hash
    for (const check of result.entries[0]!.checks) {
      expect(check.name).toBeDefined();
      expect(typeof check.passed).toBe("boolean");
    }
  });

  // 测试 7：安装 status != applied → 验证失败。
  it("安装 status != applied → 验证失败", () => {
    const installId = seedAndInstallSkill();
    // 手动把 status 设置为 planned。
    installRepo.updateInstallStatus(installId, "planned");

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(installId);

    expect(result.passed).toBe(false);
    expect(result.statusCheck.passed).toBe(false);
    expect(result.statusCheck.actual).toBe("planned");
  });

  // 测试 8：applied 安装没有 journal entry → 验证失败。
  it("applied 安装没有 journal entry → 验证失败", () => {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const install = installRepo.createInstall(pkg.id, repoRoot, "project_shared");
    installRepo.updateInstallStatus(install.id, "applied");

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(install.id);

    expect(result.passed).toBe(false);
  });

  // 测试 9：journal entry 缺少 after_hash → 验证失败。
  it("journal entry 缺少 after_hash → 验证失败", () => {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const install = installRepo.createInstall(pkg.id, repoRoot, "project_shared");
    installRepo.updateInstallStatus(install.id, "applied");

    // 创建目标文件。
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Content", "utf-8");

    // 手动创建不含 afterHash 的 journal entry。
    installRepo.createJournalEntry({
      installId: install.id,
      action: "copy",
      exportType: "skill",
      classification: "safe_projection",
      targetPath,
      // 不提供 afterHash。
    });

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(install.id);

    expect(result.passed).toBe(false);
    const hashCheck = result.entries[0]!.checks.find((c) => c.name === "content_hash" && !c.passed);
    expect(hashCheck).toBeDefined();
    expect(hashCheck!.actual).toContain("缺少");
  });

  // 测试 10：备份存在但缺少 before_hash → 验证失败。
  it("备份存在但缺少 before_hash → 验证失败", () => {
    const pkg = pkgRepo.createPackage({ name: "test-pkg", version: "1.0.0", sourceKind: "local_path", sourceRef: pkgRoot, manifestHash: "h", summary: "Test" });
    const install = installRepo.createInstall(pkg.id, repoRoot, "project_shared");
    installRepo.updateInstallStatus(install.id, "applied");

    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Content", "utf-8");

    const backupPath = path.join(repoRoot, ".rigged-backups", install.id, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.writeFileSync(backupPath, "Original", "utf-8");

    // 创建 after hash，但不创建 before hash。
    const crypto = require("node:crypto");
    const afterHash = crypto.createHash("sha256").update("Content").digest("hex");

    installRepo.createJournalEntry({
      installId: install.id,
      action: "copy",
      exportType: "skill",
      classification: "safe_projection",
      targetPath,
      backupPath,
      afterHash,
      // 不提供 beforeHash。
    });

    const verifier = new InstallVerifier(installRepo, pkgRepo, realFs());
    const result = verifier.verify(install.id);

    expect(result.passed).toBe(false);
    const backupCheck = result.entries[0]!.checks.find((c) => c.name === "backup_hash" && !c.passed);
    expect(backupCheck).toBeDefined();
    expect(backupCheck!.actual).toContain("缺少");
  });
});
