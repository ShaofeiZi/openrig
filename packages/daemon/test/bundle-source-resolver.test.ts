import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// TODO: AS-T12——迁移到感知 pod 的 bundle assembler
import { LegacyBundleAssembler as BundleAssembler, type AssemblerFsOps } from "../src/domain/bundle-assembler.js";
import { computeIntegrity, writeIntegrity, type IntegrityFsOps } from "../src/domain/bundle-integrity.js";
import { pack } from "../src/domain/bundle-archive.js";
// TODO: AS-T12——迁移到感知 pod 的 bundle source resolver
import { LegacyBundleSourceResolver as BundleSourceResolver } from "../src/domain/bundle-source-resolver.js";
import type { FsOps } from "../src/domain/package-resolver.js";

const VALID_SPEC = `
schema_version: 1
name: test-rig
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
    package_refs:
      - ./packages/review-kit
edges: []
`.trim();

const VALID_PKG_MANIFEST = `
schema_version: 1
name: review-kit
version: "1.0.0"
summary: Review tools
compatibility:
  runtimes:
    - claude-code
exports:
  skills:
    - source: skills/deep
      name: deep-review
      supported_scopes:
        - project_shared
      default_scope: project_shared
`.trim();

function realAssemblerFsOps(): AssemblerFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    copyDir: (s, d) => fs.cpSync(s, d, { recursive: true }),
  };
}

function realIntegrityFsOps(): IntegrityFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    walkFiles: (dir) => {
      const r: string[] = [];
      function walk(d: string, prefix: string) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(d, e.name), prefix ? `${prefix}/${e.name}` : e.name);
          else r.push(prefix ? `${prefix}/${e.name}` : e.name);
        }
      }
      walk(dir, "");
      return r;
    },
  };
}

function realFsOps(): FsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    listFiles: (dir) => {
      const r: string[] = [];
      function walk(d: string, prefix: string) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(d, e.name), prefix ? `${prefix}/${e.name}` : e.name);
          else r.push(prefix ? `${prefix}/${e.name}` : e.name);
        }
      }
      walk(dir, "");
      return r;
    },
  };
}

describe("BundleSourceResolver", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-resolver-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 从头创建完整的 .rigbundle */
  async function createBundle(opts?: { specYaml?: string; pkgManifest?: string; originalSource?: string; originalSources?: string[] }): Promise<string> {
    // 写入源 package
    const pkgDir = path.join(tmpDir, "src-pkg");
    fs.mkdirSync(path.join(pkgDir, "skills/deep"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.yaml"), opts?.pkgManifest ?? VALID_PKG_MANIFEST);
    fs.writeFileSync(path.join(pkgDir, "skills/deep/SKILL.md"), "# Deep Review");

    // 写入 rig spec
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, opts?.specYaml ?? VALID_SPEC);

    // 组装
    const staging = path.join(tmpDir, "staging");
    const assembler = new BundleAssembler({ fsOps: realAssemblerFsOps() });
    const manifestHash = "test-hash";

    const packages = [
      { name: "review-kit", version: "1.0.0", sourcePath: pkgDir, originalSource: opts?.originalSource ?? "github:example/review-kit@v1", manifestHash },
    ];
    if (opts?.originalSources) {
      // 添加重复条目，用于测试去重
      for (const src of opts.originalSources.slice(1)) {
        packages.push({ name: "review-kit", version: "1.0.0", sourcePath: pkgDir, originalSource: src, manifestHash });
      }
    }

    assembler.assemble({ specPath, packages, outputDir: staging, bundleName: "test-bundle", bundleVersion: "0.1.0" });

    // 添加完整性信息
    const integrity = computeIntegrity(staging, realIntegrityFsOps());
    writeIntegrity(staging, integrity, realIntegrityFsOps());

    // 打包
    const bundlePath = path.join(tmpDir, "test.rigbundle");
    await pack(staging, bundlePath);

    return bundlePath;
  }

  // T1：从解压后的 bundle 解析 rig spec
  it("从解压后的 bundle 解析 rig spec", async () => {
    const bundlePath = await createBundle();
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    expect(fs.existsSync(result.specPath)).toBe(true);
    expect(result.specPath.endsWith("rig.yaml")).toBe(true);

    resolver.cleanup(result.tempDir);
  });

  // T2：将 vendored package 映射为 sourceKind='local_path'
  it("将 vendored package 映射为 local_path resolver 格式", async () => {
    const bundlePath = await createBundle();
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    expect(result.resolvedPackages).toHaveLength(1);
    expect(result.resolvedPackages[0]!.sourceKind).toBe("local_path");
    expect(result.resolvedPackages[0]!.manifest.name).toBe("review-kit");

    resolver.cleanup(result.tempDir);
  });

  // T3：无效 bundle.yaml（错误 schema）→ 解析时报错
  it("缺少必填字段的无效 bundle.yaml 在解析时抛出异常", async () => {
    // 创建包含错误 bundle.yaml（缺少 name、version 等）的原始归档
    const rawDir = path.join(tmpDir, "raw-bad");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, "bundle.yaml"), "schema_version: 1\n# missing everything else");
    fs.writeFileSync(path.join(rawDir, "rig.yaml"), VALID_SPEC);

    // 直接打包（跳过 assembler/integrity——这是一个病态 bundle）
    const badBundle = path.join(tmpDir, "bad.rigbundle");
    await pack(rawDir, badBundle);

    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });
    // 应失败——可能是完整性问题（缺少对应部分）、校验失败（错误 manifest）或解压错误
    await expect(resolver.resolve(badBundle)).rejects.toThrow();
  });

  // T5：bundle 缺少 manifest 引用的 rig.yaml → 报错
  it("bundle 缺少 manifest 引用的 rig.yaml 时解析抛出异常", async () => {
    // 创建有效 bundle，然后在没有 rig.yaml 的情况下重新构建
    const rawDir = path.join(tmpDir, "raw-no-spec");
    fs.mkdirSync(path.join(rawDir, "packages/pkg"), { recursive: true });
    fs.writeFileSync(path.join(rawDir, "packages/pkg/package.yaml"), VALID_PKG_MANIFEST);
    fs.mkdirSync(path.join(rawDir, "packages/pkg/skills/deep"), { recursive: true });
    fs.writeFileSync(path.join(rawDir, "packages/pkg/skills/deep/SKILL.md"), "# Skill");
    // bundle.yaml 引用了 rig.yaml，但这里不创建它
    // TODO: AS-T12——迁移到感知 pod 的 bundle 类型
    const { serializeLegacyBundleManifest: serializeBundleManifest } = await import("../src/domain/bundle-types.js");
    const manifest = {
      schemaVersion: 1, name: "no-spec", version: "0.1.0",
      createdAt: "2026-01-01T00:00:00Z", rigSpec: "rig.yaml",
      packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "local:./pkg" }],
    };
    fs.writeFileSync(path.join(rawDir, "bundle.yaml"), serializeBundleManifest(manifest));

    // 添加完整性信息（rig.yaml 不存在，因此不会包含它）
    const integrity = computeIntegrity(rawDir, realIntegrityFsOps());
    writeIntegrity(rawDir, integrity, realIntegrityFsOps());

    const badBundle = path.join(tmpDir, "no-spec.rigbundle");
    await pack(rawDir, badBundle);

    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });
    await expect(resolver.resolve(badBundle)).rejects.toThrow(/bundle 中未找到|缺失/i);
  });

  // T6：package ref 映射到 vendored 内容（包括已去重的 ref）
  it("packageRefMap 包含已去重 package 的所有原始 ref", async () => {
    const bundlePath = await createBundle({
      originalSource: "local:./a",
      originalSources: ["local:./a", "local:./b"],
    });
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    // 两个原始 source 都应映射到同一个已解析 package
    expect(result.packageRefMap["local:./a"]).toBeDefined();
    expect(result.packageRefMap["local:./b"]).toBeDefined();
    expect(result.packageRefMap["local:./a"]!.manifest.name).toBe("review-kit");
    expect(result.packageRefMap["local:./b"]!.manifest.name).toBe("review-kit");
    // 同一个已解析 package 对象
    expect(result.packageRefMap["local:./a"]).toBe(result.packageRefMap["local:./b"]);

    resolver.cleanup(result.tempDir);
  });

  // T7：metadata 中的原始 source ref
  it("可从 bundle manifest 获取原始 source ref", async () => {
    const bundlePath = await createBundle({ originalSource: "github:example/review-kit@v1" });
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    expect(result.manifest.packages[0]!.originalSource).toBe("github:example/review-kit@v1");

    resolver.cleanup(result.tempDir);
  });

  // T8：创建临时工作区
  it("临时工作区已创建且可用", async () => {
    const bundlePath = await createBundle();
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    const result = await resolver.resolve(bundlePath);

    expect(fs.existsSync(result.tempDir)).toBe(true);
    expect(fs.existsSync(path.join(result.tempDir, "bundle.yaml"))).toBe(true);

    resolver.cleanup(result.tempDir);
    expect(fs.existsSync(result.tempDir)).toBe(false);
  });

  // T9：解析失败时清理临时目录
  it("解析失败时清理临时目录", async () => {
    const resolver = new BundleSourceResolver({ fsOps: realFsOps() });

    // 统计操作前的临时目录数量
    const tmpBase = os.tmpdir();
    const before = fs.readdirSync(tmpBase).filter((d) => d.startsWith("rigbundle-")).length;

    try {
      await resolver.resolve("/nonexistent.rigbundle");
    } catch {
      // 预期抛出异常
    }

    // 不应残留新的临时目录
    const after = fs.readdirSync(tmpBase).filter((d) => d.startsWith("rigbundle-")).length;
    expect(after).toBeLessThanOrEqual(before);
  });
});

// ——感知 pod 的 bundle source resolver（schemaVersion 2）——

describe("PodBundleSourceResolver", () => {
  it("通过 resolve() 解析 schemaVersion 2 归档：解包、解析、校验和 specPath", async () => {
    const { createHash } = await import("node:crypto");
    const { PodBundleSourceResolver } = await import("../src/domain/bundle-source-resolver.js");
    const { serializePodBundleManifest } = await import("../src/domain/bundle-types.js");
    const { RigSpecCodec } = await import("../src/domain/rigspec-codec.js");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "podbundle-resolver-test-"));
    try {
      const stagingDir = path.join(tmpDir, "staging");
      fs.mkdirSync(stagingDir, { recursive: true });

      // 写入 rig.yaml
      const rigYaml = RigSpecCodec.serialize({
        version: "0.2", name: "resolver-rig",
        pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
        edges: [],
      });
      fs.writeFileSync(path.join(stagingDir, "rig.yaml"), rigYaml);

      // 写入 agent
      fs.mkdirSync(path.join(stagingDir, "agents", "impl"), { recursive: true });
      fs.writeFileSync(path.join(stagingDir, "agents", "impl", "agent.yaml"), 'name: impl\nversion: "1.0"\nprofiles: {}');

      // 计算完整性部分的文件哈希（按约定排除 bundle.yaml）
      const fileHashes: Record<string, string> = {};
      function hashFilesInDir(dir: string, prefix: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) hashFilesInDir(path.join(dir, entry.name), rel);
          else if (rel !== "bundle.yaml") fileHashes[rel] = createHash("sha256").update(fs.readFileSync(path.join(dir, entry.name))).digest("hex");
        }
      }
      hashFilesInDir(stagingDir, "");

      // 写入带完整性信息的 manifest
      const manifestYaml = serializePodBundleManifest({
        schemaVersion: 2, name: "resolver-test", version: "1.0.0",
        createdAt: new Date().toISOString(), rigSpec: "rig.yaml",
        agents: [{ name: "impl", version: "1.0", path: "agents/impl", originalRef: "local:agents/impl", hash: "test-hash", importEntries: [] }],
        integrity: { algorithm: "sha256", files: fileHashes },
      });
      fs.writeFileSync(path.join(stagingDir, "bundle.yaml"), manifestYaml);

      // 打包归档
      const archivePath = path.join(tmpDir, "test.rigbundle");
      await pack(stagingDir, archivePath);

      // 创建 .sha256 摘要
      const archiveDigest = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
      fs.writeFileSync(`${archivePath}.sha256`, archiveDigest);

      // 通过 PodBundleSourceResolver.resolve() 解析
      const resolver = new PodBundleSourceResolver();
      const result = await resolver.resolve(archivePath);

      try {
        expect(result.manifest.schemaVersion).toBe(2);
        expect(result.manifest.name).toBe("resolver-test");
        expect(result.manifest.agents).toHaveLength(1);
        expect(result.manifest.agents[0]!.name).toBe("impl");
        expect(fs.existsSync(result.specPath)).toBe(true);
        expect(result.specPath).toContain("rig.yaml");
      } finally {
        resolver.cleanup(result.tempDir);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
