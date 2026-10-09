import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { computeIntegrity, writeIntegrity, verifyIntegrity, type IntegrityFsOps } from "../src/domain/bundle-integrity.js";
// TODO：AS-T12——迁移至支持 pod 的 bundle type
import { serializeLegacyBundleManifest as serializeBundleManifest, type LegacyBundleManifest as BundleManifest } from "../src/domain/bundle-types.js";

function realFsOps(): IntegrityFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    readFileBuffer: (p) => fs.readFileSync(p),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    exists: (p) => fs.existsSync(p),
    walkFiles: (dir) => {
      const results: string[] = [];
      function walk(d: string, prefix: string) {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(d, entry.name), path.join(prefix, entry.name));
          else results.push(prefix ? path.join(prefix, entry.name) : entry.name);
        }
      }
      walk(dir, "");
      return results;
    },
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("Bundle integrity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-integ-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  function makeManifest(integrity?: { algorithm: "sha256"; files: Record<string, string> }): BundleManifest {
    return {
      schemaVersion: 1, name: "test", version: "1.0", createdAt: "2026-01-01",
      rigSpec: "rig.yaml", packages: [{ name: "pkg", version: "1.0", path: "packages/pkg", originalSource: "" }],
      integrity,
    };
  }

  // T1：计算正确的 SHA-256
  it("为每个文件计算正确的 SHA-256", () => {
    writeFile("rig.yaml", "spec content");
    writeFile("packages/pkg/SKILL.md", "skill content");

    const integrity = computeIntegrity(tmpDir, realFsOps());

    expect(integrity.algorithm).toBe("sha256");
    expect(integrity.files["rig.yaml"]).toBe(sha256("spec content"));
    expect(integrity.files["packages/pkg/SKILL.md"]).toBe(sha256("skill content"));
  });

  // T2：将 integrity section 写入 bundle.yaml
  it("将 integrity section 写入现有 bundle.yaml", () => {
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));
    writeFile("rig.yaml", "spec");

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    const updated = fs.readFileSync(path.join(tmpDir, "bundle.yaml"), "utf-8");
    expect(updated).toContain("integrity:");
    expect(updated).toContain("sha256");
  });

  // T3：verifier 对干净 bundle 校验通过
  it("verifier 对干净 bundle 校验通过", () => {
    writeFile("rig.yaml", "spec");
    writeFile("packages/pkg/package.yaml", "name: pkg");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    const manifestWithIntegrity = { ...manifest, integrity };
    const result = verifyIntegrity(tmpDir, manifestWithIntegrity, realFsOps());

    expect(result.passed).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  // T4：verifier 对已篡改文件校验失败
  it("verifier 对已篡改文件校验失败（hash 不匹配）", () => {
    writeFile("rig.yaml", "original");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    // 篡改文件
    fs.writeFileSync(path.join(tmpDir, "rig.yaml"), "tampered!");

    const result = verifyIntegrity(tmpDir, { ...manifest, integrity }, realFsOps());

    expect(result.passed).toBe(false);
    expect(result.mismatches).toContain("rig.yaml");
  });

  // T5：verifier 对缺失文件校验失败
  it("verifier 对缺失文件校验失败", () => {
    writeFile("rig.yaml", "spec");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    // 删除文件
    fs.unlinkSync(path.join(tmpDir, "rig.yaml"));

    const result = verifyIntegrity(tmpDir, { ...manifest, integrity }, realFsOps());

    expect(result.passed).toBe(false);
    expect(result.missing).toContain("rig.yaml");
  });

  // T6：额外非预期文件 -> passed=false
  it("verifier 对额外非预期文件校验失败", () => {
    writeFile("rig.yaml", "spec");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    writeIntegrity(tmpDir, integrity, realFsOps());

    // 计算 integrity 后添加额外文件
    writeFile("extra-file.txt", "unexpected");

    const result = verifyIntegrity(tmpDir, { ...manifest, integrity }, realFsOps());

    expect(result.passed).toBe(false);
    expect(result.extra).toContain("extra-file.txt");
  });

  // T6b：忽略 .DS_Store
  it("compute 与 verify 期间忽略 .DS_Store", () => {
    writeFile("rig.yaml", "spec");
    writeFile(".DS_Store", "junk");
    const manifest = makeManifest();
    writeFile("bundle.yaml", serializeBundleManifest(manifest));

    const integrity = computeIntegrity(tmpDir, realFsOps());
    expect(integrity.files[".DS_Store"]).toBeUndefined();

    writeIntegrity(tmpDir, integrity, realFsOps());
    const result = verifyIntegrity(tmpDir, { ...manifest, integrity }, realFsOps());
    expect(result.passed).toBe(true);
  });

  // T7：.env -> 抛错（hard fail）
  it("compute 期间遇到敏感 .env 文件会抛错", () => {
    writeFile("rig.yaml", "spec");
    writeFile(".env", "SECRET=bad");

    expect(() => computeIntegrity(tmpDir, realFsOps())).toThrow(/检测到敏感路径/);
  });

  // T8：空目录 -> 空 integrity
  it("空目录产生空 integrity", () => {
    const integrity = computeIntegrity(tmpDir, realFsOps());
    expect(Object.keys(integrity.files)).toHaveLength(0);
  });

});
