/**
 * 信任模型：Bundle 完整性只验证自身一致性，不验证真实性。相邻的 .sha256 文件检测传输损坏，
 * 内容 hash 检测归档内单个文件是否被篡改。两种机制都不能认证 bundle 作者；能同时改写完整
 * bundle 与 digest 的攻击者可以绕过验证。用户必须信任 bundle 的获取来源，这与未签名的 npm
 * package/Docker image 采用相同模型。后续可增加 Ed25519 加密签名。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import * as tar from "tar";
import { verifyIntegrity, type IntegrityFsOps } from "./bundle-integrity.js";
// TODO：AS-T12——迁移到感知 Pod 的包类型。
import { parseLegacyBundleManifest as parseBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest } from "./bundle-types.js";

/**
 * 将 staging 目录打包成 .rigbundle 归档（确定性 tar.gz），并写入相邻的 .sha256 digest 文件。
 * @returns 归档的 SHA-256 十六进制 digest
 */
export async function pack(stagingDir: string, outputPath: string): Promise<string> {
  if (!outputPath.endsWith(".rigbundle")) {
    throw new Error("输出路径必须以 .rigbundle 结尾");
  }

  // 按确定的字母顺序收集所有文件。
  const allFiles = walkFilesSync(stagingDir).sort();

  // 使用确定性设置打包。
  await tar.create(
    {
      gzip: { level: 9 },
      file: outputPath,
      cwd: stagingDir,
      portable: true, // 规范化 uid/gid/mode。
      mtime: new Date("2026-01-01T00:00:00Z"), // 固定 mtime 以保证确定性。
    },
    allFiles,
  );

  // 计算归档 digest。
  const archiveHash = hashFile(outputPath);
  fs.writeFileSync(`${outputPath}.sha256`, archiveHash, "utf-8");

  return archiveHash;
}

/**
 * 将 .rigbundle 归档解包到目录。必须存在相邻的 .sha256 digest 文件；提取前验证归档完整性，
 * 拒绝 symlink、hardlink、路径穿越与绝对路径，提取后再验证内容完整性。
 */
export async function unpack(archivePath: string, outputDir: string): Promise<void> {
  // 步骤 1：验证归档级 digest。
  const digestResult = verifyArchiveDigest(archivePath);
  if (!digestResult.valid) {
    throw new Error(`归档完整性检查失败：预期 ${digestResult.expected}，实际 ${digestResult.actual}`);
  }

  // 步骤 2：提取前预扫描归档中的不安全 entry。
  const unsafeEntries: string[] = [];
  await tar.list({
    file: archivePath,
    onReadEntry: (entry) => {
      const entryPath = entry.path;
      const entryType = entry.type;
      if (entryType === "SymbolicLink" || entryType === "Link") {
        unsafeEntries.push(`${entryType}: ${entryPath}`);
      }
      if (entryPath.startsWith("/")) {
        unsafeEntries.push(`绝对路径：${entryPath}`);
      }
      const segments = entryPath.split("/");
      if (segments.some((s: string) => s === "..")) {
        unsafeEntries.push(`路径穿越：${entryPath}`);
      }
    },
  });

  if (unsafeEntries.length > 0) {
    throw new Error(`已拒绝不安全的归档 entry：${unsafeEntries.join("; ")}`);
  }

  // 步骤 3：归档已经预扫描，可以安全提取。
  fs.mkdirSync(outputDir, { recursive: true });
  await tar.extract({ file: archivePath, cwd: outputDir });

  // 步骤 4：验证内容完整性。
  const manifestPath = nodePath.join(outputDir, "bundle.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("提取后的归档缺少 bundle.yaml");
  }

  const rawYaml = fs.readFileSync(manifestPath, "utf-8");
  const raw = parseBundleManifest(rawYaml) as Record<string, unknown>;

  // 根据 schema version 提取 integrity。
  const schemaVersion = raw["schema_version"] as number;
  let integrity: { algorithm: string; files: Record<string, string> } | undefined;

  if (schemaVersion === 2) {
    // Pod-aware bundle：manifest 中的 integrity 可选。
    if (raw["integrity"] && typeof raw["integrity"] === "object") {
      const integ = raw["integrity"] as Record<string, unknown>;
      integrity = { algorithm: integ["algorithm"] as string, files: (integ["files"] as Record<string, string>) ?? {} };
    }
  } else {
    // Legacy bundle：按 v1 解析。
    const manifest = normalizeBundleManifest(raw);
    integrity = manifest.integrity;
  }

  if (!integrity) {
    throw new Error("Bundle manifest 缺少 integrity section，无法验证内容");
  }

  {
    const fsOps: IntegrityFsOps = {
      readFile: (p) => fs.readFileSync(p, "utf-8"),
      readFileBuffer: (p) => fs.readFileSync(p),
      writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p) => fs.existsSync(p),
      walkFiles: (dir) => walkFilesSync(dir),
    };

    // verifyIntegrity 只读取 manifest.integrity，因此该转换安全。
    const result = verifyIntegrity(outputDir, { integrity } as unknown as Parameters<typeof verifyIntegrity>[1], fsOps);
    if (!result.passed) {
      const details = [
        ...result.mismatches.map((f) => `已篡改：${f}`),
        ...result.missing.map((f) => `缺失：${f}`),
        ...result.extra.map((f) => `多余：${f}`),
        ...result.errors,
      ];
      throw new Error(`内容完整性验证失败：${details.join("; ")}`);
    }
  }
}

/**
 * 验证归档级 SHA-256 digest，要求存在相邻的 .sha256 文件。
 */
export function verifyArchiveDigest(archivePath: string): { valid: boolean; expected: string; actual: string } {
  const digestPath = `${archivePath}.sha256`;
  if (!fs.existsSync(digestPath)) {
    throw new Error(`缺少必需的归档 digest 文件：${digestPath}`);
  }

  const expected = fs.readFileSync(digestPath, "utf-8").trim();
  const actual = hashFile(archivePath);

  return { valid: expected === actual, expected, actual };
}

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function walkFilesSync(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string, prefix: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(nodePath.join(d, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else {
        results.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  }
  walk(dir, "");
  return results;
}
