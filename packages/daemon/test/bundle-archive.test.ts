import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import * as tar from "tar";
import { pack, unpack, verifyArchiveDigest } from "../src/domain/bundle-archive.js";
// TODO：AS-T12——迁移到感知 pod 的 bundle 类型。
import { serializeLegacyBundleManifest as serializeBundleManifest, type LegacyBundleManifest as BundleManifest } from "../src/domain/bundle-types.js";
import { computeIntegrity, writeIntegrity, type IntegrityFsOps } from "../src/domain/bundle-integrity.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function realIntegrityFsOps(): IntegrityFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    walkFiles: (dir) => {
      const results: string[] = [];
      function walk(d: string, prefix: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(d, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
          else results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
        }
      }
      walk(dir, "");
      return results;
    },
  };
}

describe("Bundle 归档", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-archive-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createStaging(): string {
    const staging = path.join(tmpDir, "staging");
    fs.mkdirSync(path.join(staging, "packages/pkg"), { recursive: true });
    fs.writeFileSync(path.join(staging, "rig.yaml"), "schema_version: 1\nname: test\nversion: '1.0'\nnodes:\n  - id: dev\n    runtime: claude-code\nedges: []");
    fs.writeFileSync(path.join(staging, "packages/pkg/SKILL.md"), "# Skill");

    const manifest: BundleManifest = {
      schemaVersion: 1, name: "test-bundle", version: "0.1.0",
      createdAt: "2026-01-01T00:00:00Z", rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    fs.writeFileSync(path.join(staging, "bundle.yaml"), serializeBundleManifest(manifest));

    // 添加 integrity。
    const integrity = computeIntegrity(staging, realIntegrityFsOps());
    writeIntegrity(staging, integrity, realIntegrityFsOps());

    return staging;
  }

  // T1：打包会创建有效 tar.gz。
  it("pack 创建有效 tar.gz 文件", async () => {
    const staging = createStaging();
    const outputPath = path.join(tmpDir, "test.rigbundle");

    const hash = await pack(staging, outputPath);

    expect(fs.existsSync(outputPath)).toBe(true);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(0);
  });

  // T2：解包到正确结构。
  it("unpack 解压到正确目录结构", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);

    expect(fs.existsSync(path.join(extractDir, "bundle.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, "rig.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(extractDir, "packages/pkg/SKILL.md"))).toBe(true);
  });

  // T3：往返。
  it("往返：pack -> unpack 后文件匹配", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);

    const origSkill = fs.readFileSync(path.join(staging, "packages/pkg/SKILL.md"), "utf-8");
    const extractedSkill = fs.readFileSync(path.join(extractDir, "packages/pkg/SKILL.md"), "utf-8");
    expect(extractedSkill).toBe(origSkill);
  });

  // T4：拒绝路径遍历——通过底层 tar pack 创建含 ../ 的归档。
  it("解压时拒绝归档条目中的路径遍历", async () => {
    // 创建含文件的 staging 目录，再手工使用 ../ 前缀打包。
    const malDir = path.join(tmpDir, "mal-staging");
    fs.mkdirSync(malDir, { recursive: true });
    fs.writeFileSync(path.join(malDir, "evil.txt"), "escape!");

    const malArchive = path.join(tmpDir, "mal.rigbundle");
    // 使用带 prefix 的 tar.create，把 ../ 注入条目名称。
    await tar.create(
      { gzip: true, file: malArchive, cwd: malDir, prefix: "../escape" },
      ["evil.txt"],
    );

    // 写入有效 .sha256 摘要，使流程通过摘要检查。
    const archiveHash = createHash("sha256").update(fs.readFileSync(malArchive)).digest("hex");
    fs.writeFileSync(`${malArchive}.sha256`, archiveHash);

    await expect(unpack(malArchive, path.join(tmpDir, "out")))
      .rejects.toThrow(/不安全的归档 entry|路径穿越/i);
  });

  // T4b：拒绝 symlink 条目。
  it("解压时拒绝归档中的 symlink", async () => {
    // 创建包含 symlink 条目的归档。
    const symlinkDir = path.join(tmpDir, "sym-staging");
    fs.mkdirSync(symlinkDir, { recursive: true });
    fs.writeFileSync(path.join(symlinkDir, "real.txt"), "real content");
    fs.symlinkSync("/etc/passwd", path.join(symlinkDir, "escape-link"));

    const symArchive = path.join(tmpDir, "sym.rigbundle");
    await tar.create(
      { gzip: true, file: symArchive, cwd: symlinkDir, follow: false },
      ["real.txt", "escape-link"],
    );

    const archiveHash = createHash("sha256").update(fs.readFileSync(symArchive)).digest("hex");
    fs.writeFileSync(`${symArchive}.sha256`, archiveHash);

    await expect(unpack(symArchive, path.join(tmpDir, "out")))
      .rejects.toThrow(/Unsafe archive entry|SymbolicLink/i);
  });

  // T5：损坏的归档产生错误。
  it("解包损坏的归档时抛错", async () => {
    const archivePath = path.join(tmpDir, "corrupt.rigbundle");
    fs.writeFileSync(archivePath, "not a real tar.gz");
    fs.writeFileSync(`${archivePath}.sha256`, sha256("not a real tar.gz"));

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow();
  });

  // T6：解包后验证内容完整性。
  it("解压后验证内容完整性", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // 解包应成功（完整性检查通过）。
    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);
    // 没有错误即表示完整性检查通过。
  });

  // T7：解包后检测被篡改文件。
  it("解压后检测归档中被篡改的文件", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // 先解压。
    const extractDir = path.join(tmpDir, "extracted");
    await unpack(archivePath, extractDir);

    // 篡改文件。
    fs.writeFileSync(path.join(extractDir, "rig.yaml"), "tampered!");

    // 重新验证会失败（unpack 已完成验证，此处测试 verify 函数）。
    const { verifyIntegrity: vi2 } = await import("../src/domain/bundle-integrity.js");
    // TODO：AS-T12——迁移到感知 pod 的 bundle 类型。
    const { parseLegacyBundleManifest: parseBundleManifest, normalizeLegacyBundleManifest: normalizeBundleManifest } = await import("../src/domain/bundle-types.js");
    const manifestYaml = fs.readFileSync(path.join(extractDir, "bundle.yaml"), "utf-8");
    const manifest = normalizeBundleManifest(parseBundleManifest(manifestYaml));
    const result = vi2(extractDir, manifest, realIntegrityFsOps());
    expect(result.passed).toBe(false);
    expect(result.mismatches).toContain("rig.yaml");
  });

  // T8：强制使用 .rigbundle 扩展名。
  it("输出路径强制使用 .rigbundle 扩展名", async () => {
    const staging = createStaging();
    await expect(pack(staging, path.join(tmpDir, "test.tar.gz")))
      .rejects.toThrow(/\.rigbundle/);
  });

  // T9：打包时写入同级 .sha256 文件。
  it("pack 时写入同级 .sha256 文件", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    const hash = await pack(staging, archivePath);

    const digestPath = `${archivePath}.sha256`;
    expect(fs.existsSync(digestPath)).toBe(true);
    expect(fs.readFileSync(digestPath, "utf-8").trim()).toBe(hash);
  });

  // T10：缺少 .sha256 时 unpack 抛错。
  it("缺少 .sha256 时 unpack 抛错", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // 删除摘要文件。
    fs.unlinkSync(`${archivePath}.sha256`);

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow(/缺少必需的归档 digest 文件/);
  });

  // T11：摘要不匹配时 unpack 抛错。
  it("归档摘要不匹配时 unpack 抛错", async () => {
    const staging = createStaging();
    const archivePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, archivePath);

    // 篡改摘要。
    fs.writeFileSync(`${archivePath}.sha256`, "0000000000000000000000000000000000000000000000000000000000000000");

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow(/完整性检查失败/);
  });

  // T12b：bundle.yaml 缺少 integrity section 时 unpack 拒绝。
  it("unpack 拒绝 bundle.yaml 缺少 integrity section 的归档", async () => {
    // 创建不含 integrity 的 staging。
    const staging = path.join(tmpDir, "no-integ-staging");
    fs.mkdirSync(path.join(staging, "packages/pkg"), { recursive: true });
    fs.writeFileSync(path.join(staging, "rig.yaml"), "schema_version: 1\nname: test\nversion: '1.0'\nnodes:\n  - id: dev\n    runtime: claude-code\nedges: []");
    fs.writeFileSync(path.join(staging, "packages/pkg/SKILL.md"), "# Skill");

    const manifest: BundleManifest = {
      schemaVersion: 1, name: "no-integ", version: "0.1.0",
      createdAt: "2026-01-01T00:00:00Z", rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "" }],
      // 没有 integrity section。
    };
    fs.writeFileSync(path.join(staging, "bundle.yaml"), serializeBundleManifest(manifest));

    const archivePath = path.join(tmpDir, "no-integ.rigbundle");
    await pack(staging, archivePath);

    await expect(unpack(archivePath, path.join(tmpDir, "out")))
      .rejects.toThrow(/缺少 integrity section/);
  });

  // T12：确定性输出。
  it("对相同内容打包两次会产生完全相同的归档", async () => {
    const staging = createStaging();
    const out1 = path.join(tmpDir, "a.rigbundle");
    const out2 = path.join(tmpDir, "b.rigbundle");

    const hash1 = await pack(staging, out1);
    const hash2 = await pack(staging, out2);

    expect(hash1).toBe(hash2);
    expect(fs.readFileSync(out1).equals(fs.readFileSync(out2))).toBe(true);
  });
});
