import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { PackageRepository } from "../src/domain/package-repository.js";
import { InstallRepository } from "../src/domain/install-repository.js";
import { InstallEngine, type EngineFsOps } from "../src/domain/install-engine.js";
import type { InstallPlanEntry } from "../src/domain/install-planner.js";
import type { RefinedInstallPlan } from "../src/domain/conflict-detector.js";
import type { PolicyResult } from "../src/domain/install-policy.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function realFs(tmpDir: string): EngineFsOps {
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
    exportType: "skill",
    exportName: "test",
    classification: "safe_projection",
    targetPath: "",
    scope: "project_shared",
    deferred: false,
    ...overrides,
  };
}

function makePlan(entries: InstallPlanEntry[]): RefinedInstallPlan {
  return {
    packageName: "test-pkg",
    packageVersion: "1.0.0",
    sourceRef: "/pkg",
    entries,
    actionable: entries.filter((e) => !e.deferred),
    deferred: entries.filter((e) => e.deferred),
    conflicts: [],
    noOps: [],
  };
}

function makePolicy(approved: InstallPlanEntry[]): PolicyResult {
  return { approved, rejected: [] };
}

describe("InstallEngine", () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    repoRoot = path.join(tmpDir, "repo");
    pkgRoot = path.join(tmpDir, "pkg");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(pkgRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedPackage() {
    return pkgRepo.createPackage({
      name: "test-pkg",
      version: "1.0.0",
      sourceKind: "local_path",
      sourceRef: pkgRoot,
      manifestHash: "abc123",
      summary: "Test",
    });
  }

  function writeSource(relPath: string, content: string) {
    const full = path.join(pkgRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return full;
  }

  // 测试 1：全新安装——复制技能
  it("全新安装：将技能复制到目标路径", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "# Foo Skill");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ exportName: "foo", targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("# Foo Skill");
    expect(result.applied).toHaveLength(1);
  });

  // 测试 2：带托管块标记的指导文件
  it("全新安装：创建带托管块标记的指导文件", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("guidance/AGENTS.md", "Review all PRs carefully.");
    const targetPath = path.join(repoRoot, "AGENTS.md");

    const entry = makeEntry({
      exportType: "guidance",
      exportName: "review-guide",
      classification: "safe_projection", // Real planner output for new guidance
      targetPath,
      sourcePath,
    });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const content = fs.readFileSync(targetPath, "utf-8");
    expect(content).toContain("<!-- BEGIN OpenRig MANAGED BLOCK: test-pkg -->");
    expect(content).toContain("Review all PRs carefully.");
    expect(content).toContain("<!-- END OpenRig MANAGED BLOCK: test-pkg -->");
  });

  // 测试 3：带哈希的日志条目
  it("全新安装：写入具有正确哈希的日志条目", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(result.applied[0]!.afterHash).toBeDefined();
    expect(result.applied[0]!.afterHash!.length).toBe(64); // SHA-256
  });

  // 测试 4：安装状态 = applied
  it("全新安装：package_install 状态 = applied", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const install = installRepo.getInstall(result.installId);
    expect(install!.status).toBe("applied");
    expect(install!.appliedAt).toBeDefined();
  });

  // 测试 5：现有指导文件——插入块且不覆盖原内容
  it("现有指导文件：插入托管块且不覆盖原内容", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("guidance/AGENTS.md", "New guidance.");
    const targetPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(targetPath, "# Existing content\nKeep this.\n", "utf-8");

    const entry = makeEntry({
      exportType: "guidance",
      classification: "managed_merge",
      targetPath,
      sourcePath,
    });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const content = fs.readFileSync(targetPath, "utf-8");
    expect(content).toContain("# Existing content");
    expect(content).toContain("Keep this.");
    expect(content).toContain("New guidance.");
    expect(content).toContain("<!-- BEGIN OpenRig MANAGED BLOCK: test-pkg -->");
  });

  // 测试 6：原位更新现有托管块
  it("现有托管块：原位更新", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("guidance/AGENTS.md", "Updated guidance.");
    const targetPath = path.join(repoRoot, "AGENTS.md");
    fs.writeFileSync(targetPath,
      "# Header\n<!-- BEGIN OpenRig MANAGED BLOCK: test-pkg -->\nOld content.\n<!-- END OpenRig MANAGED BLOCK: test-pkg -->\n# Footer\n",
      "utf-8"
    );

    const entry = makeEntry({
      exportType: "guidance",
      classification: "managed_merge",
      targetPath,
      sourcePath,
    });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const content = fs.readFileSync(targetPath, "utf-8");
    expect(content).toContain("# Header");
    expect(content).toContain("Updated guidance.");
    expect(content).not.toContain("Old content.");
    expect(content).toContain("# Footer");
  });

  // 测试 7：覆盖前创建备份
  it("覆盖前创建备份", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "New content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Original content", "utf-8");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(result.applied[0]!.backupPath).toBeDefined();
    expect(fs.existsSync(result.applied[0]!.backupPath!)).toBe(true);
    expect(fs.readFileSync(result.applied[0]!.backupPath!, "utf-8")).toBe("Original content");
  });

  // 测试 8：回滚从备份恢复
  it("回滚从备份恢复原始文件", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "New");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Original", "utf-8");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const installResult = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(fs.readFileSync(targetPath, "utf-8")).toBe("New");

    const rollbackResult = engine.rollback(installResult.installId);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("Original");
    expect(rollbackResult.restored).toContain(targetPath);
  });

  // 测试 9：回滚新文件 -> 删除
  it("回滚新文件 -> 删除文件", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const installResult = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(fs.existsSync(targetPath)).toBe(true);

    const rollbackResult = engine.rollback(installResult.installId);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(rollbackResult.deleted).toContain(targetPath);
  });

  // 测试 10：回滚状态
  it("回滚将 package_install 状态更新为 rolled_back", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const installResult = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    engine.rollback(installResult.installId);

    const install = installRepo.getInstall(installResult.installId);
    expect(install!.status).toBe("rolled_back");
    expect(install!.rolledBackAt).toBeDefined();
  });

  // 测试 11：应用中途失败 -> 补偿回滚
  it("应用中途失败 -> 补偿回滚，状态 = failed", () => {
    const pkg = seedPackage();
    const goodSource = writeSource("skills/foo/SKILL.md", "Good");
    const goodTarget = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    const badTarget = path.join(repoRoot, ".agents/skills/bar/SKILL.md");

    const goodEntry = makeEntry({ exportName: "foo", targetPath: goodTarget, sourcePath: goodSource });
    // 错误条目：来源不存在。
    const badEntry = makeEntry({ exportName: "bar", targetPath: badTarget, sourcePath: "/nonexistent/SKILL.md" });

    const engine = new InstallEngine(installRepo, realFs(tmpDir));

    expect(() => {
      engine.apply(makePolicy([goodEntry, badEntry]), makePlan([goodEntry, badEntry]), pkg.id, repoRoot);
    }).toThrow();

    // 正常文件应被回滚。
    expect(fs.existsSync(goodTarget)).toBe(false);

    // 安装应标记为 failed。
    const installs = installRepo.listInstalls(pkg.id);
    expect(installs[0]!.status).toBe("failed");
  });

  // 测试 12：日志条目追踪哈希
  it("日志条目追踪前后哈希", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "New content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "Old content", "utf-8");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(result.applied[0]!.beforeHash).toBeDefined();
    expect(result.applied[0]!.afterHash).toBeDefined();
    expect(result.applied[0]!.beforeHash).not.toBe(result.applied[0]!.afterHash);
  });

  // 测试 13：创建不存在的目标目录
  it("安装到不存在的目标目录 -> 创建目录", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, "deep/nested/dir/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    expect(fs.existsSync(targetPath)).toBe(true);
  });

  // 测试 14：listInstalls
  it("listInstalls 返回包含状态的正确记录", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    const installs = installRepo.listInstalls(pkg.id);
    expect(installs).toHaveLength(1);
    expect(installs[0]!.status).toBe("applied");
    expect(installs[0]!.packageId).toBe(pkg.id);
  });

  // 测试 15：同名的两个技能备份到不同路径
  it("两个技能备份到不同路径（无冲突）", () => {
    const pkg = seedPackage();
    const src1 = writeSource("skills/foo/SKILL.md", "Foo new");
    const src2 = writeSource("skills/bar/SKILL.md", "Bar new");
    const t1 = path.join(repoRoot, ".agents/skills/foo/SKILL.md");
    const t2 = path.join(repoRoot, ".agents/skills/bar/SKILL.md");

    fs.mkdirSync(path.dirname(t1), { recursive: true });
    fs.mkdirSync(path.dirname(t2), { recursive: true });
    fs.writeFileSync(t1, "Foo original", "utf-8");
    fs.writeFileSync(t2, "Bar original", "utf-8");

    const e1 = makeEntry({ exportName: "foo", targetPath: t1, sourcePath: src1 });
    const e2 = makeEntry({ exportName: "bar", targetPath: t2, sourcePath: src2 });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([e1, e2]), makePlan([e1, e2]), pkg.id, repoRoot);

    // 两个备份都存在且路径不同。
    expect(result.applied[0]!.backupPath).not.toBe(result.applied[1]!.backupPath);
    expect(fs.readFileSync(result.applied[0]!.backupPath!, "utf-8")).toBe("Foo original");
    expect(fs.readFileSync(result.applied[1]!.backupPath!, "utf-8")).toBe("Bar original");
  });

  // 测试 16：回滚追加日志行
  it("回滚追加日志条目（action=rollback）", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "Content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const installResult = engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);

    engine.rollback(installResult.installId);

    const journal = installRepo.getJournalEntries(installResult.installId);
    const rollbackEntries = journal.filter((j) => j.action === "rollback");
    expect(rollbackEntries.length).toBeGreaterThanOrEqual(1);
    expect(rollbackEntries[0]!.status).toBe("rolled_back");
  });

  // 测试 17：日志按 seq 确定性排序
  it("日志条目按 seq 排序，回滚时反向处理", () => {
    const pkg = seedPackage();
    const src1 = writeSource("skills/a/SKILL.md", "A");
    const src2 = writeSource("skills/b/SKILL.md", "B");
    const t1 = path.join(repoRoot, ".agents/skills/a/SKILL.md");
    const t2 = path.join(repoRoot, ".agents/skills/b/SKILL.md");

    const e1 = makeEntry({ exportName: "a", targetPath: t1, sourcePath: src1 });
    const e2 = makeEntry({ exportName: "b", targetPath: t2, sourcePath: src2 });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));
    const result = engine.apply(makePolicy([e1, e2]), makePlan([e1, e2]), pkg.id, repoRoot);

    const journal = installRepo.getJournalEntries(result.installId);
    const applyEntries = journal.filter((j) => j.action !== "rollback");
    // seq 应按插入顺序为 1、2。
    expect(applyEntries[0]!.seq).toBe(1);
    expect(applyEntries[1]!.seq).toBe(2);
    // 验证唯一约束：同一安装，不同 seq。
    expect(applyEntries[0]!.seq).not.toBe(applyEntries[1]!.seq);
  });

  // 测试 18：升级路径——009 -> 010 回填 seq
  it("010 迁移为现有日志行回填 seq", () => {
    // 创建停留在 009（不含 010）的数据库。
    const upgradeDb = createDb();
    migrate(upgradeDb, [
      coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
      checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
      packagesSchema, installJournalSchema,
    ]);

    // 在 009 层级填充数据（尚无 seq 列）。
    upgradeDb.prepare("INSERT INTO packages (id, name, version, source_kind, source_ref, manifest_hash) VALUES (?, ?, ?, ?, ?, ?)").run("p1", "pkg", "1.0.0", "local_path", "/p", "h");
    upgradeDb.prepare("INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)").run("i1", "p1", "/repo", "project_shared");
    upgradeDb.prepare("INSERT INTO install_journal (id, install_id, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?)").run("j1", "i1", "copy", "skill", "safe_projection", "/t1");
    upgradeDb.prepare("INSERT INTO install_journal (id, install_id, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?)").run("j2", "i1", "copy", "skill", "safe_projection", "/t2");
    upgradeDb.prepare("INSERT INTO install_journal (id, install_id, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?)").run("j3", "i1", "merge_block", "guidance", "managed_merge", "/t3");

    // 应用 010。
    migrate(upgradeDb, [
      coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
      checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
      packagesSchema, installJournalSchema, journalSeqSchema,
    ]);

    // 验证 seq 已回填。
    const rows = upgradeDb.prepare("SELECT id, seq FROM install_journal WHERE install_id = ? ORDER BY seq").all("i1") as Array<{ id: string; seq: number }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.seq).toBe(1);
    expect(rows[1]!.seq).toBe(2);
    expect(rows[2]!.seq).toBe(3);

    // 验证唯一约束。
    expect(() => {
      upgradeDb.prepare("INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path) VALUES (?, ?, ?, ?, ?, ?, ?)").run("j4", "i1", 1, "copy", "skill", "safe_projection", "/t4");
    }).toThrow(/UNIQUE/);

    upgradeDb.close();
  });

  // 测试 19：日志写入失败撤销文件修改（R2-H3）
  it("日志写入失败会撤销对应条目的文件修改", () => {
    const pkg = seedPackage();
    const sourcePath = writeSource("skills/foo/SKILL.md", "New content");
    const targetPath = path.join(repoRoot, ".agents/skills/foo/SKILL.md");

    const entry = makeEntry({ targetPath, sourcePath });
    const engine = new InstallEngine(installRepo, realFs(tmpDir));

    // 监视：首次调用 createJournalEntry 时抛错。
    vi.spyOn(installRepo, "createJournalEntry").mockImplementationOnce(() => {
      throw new Error("journal write failed");
    });

    expect(() => {
      engine.apply(makePolicy([entry]), makePlan([entry]), pkg.id, repoRoot);
    }).toThrow("journal write failed");

    // 目标文件不应存在（新文件场景：撤销会将其删除）。
    expect(fs.existsSync(targetPath)).toBe(false);

    // 日志应有 0 条 applied 记录。
    const installs = installRepo.listInstalls(pkg.id);
    expect(installs).toHaveLength(1);
    expect(installs[0]!.status).toBe("failed");

    const journal = installRepo.getJournalEntries(installs[0]!.id);
    const applyEntries = journal.filter((j) => j.action !== "rollback");
    expect(applyEntries).toHaveLength(0);
  });
});
