import { createHash } from "node:crypto";
import nodePath from "node:path";
// TODO：AS-T12——迁移至支持 pod 的 bundle type
import type { LegacyBundleManifest as BundleManifest, BundleIntegrity } from "./bundle-types.js";
import { parseLegacyBundleManifest as parseBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest, serializeLegacyBundleManifest as serializeBundleManifest } from "./bundle-types.js";

export interface IntegrityFsOps {
  readFile: (path: string) => string;
  readFileBuffer: (path: string) => Buffer;
  writeFile: (path: string, content: string) => void;
  exists: (path: string) => boolean;
  walkFiles: (dir: string) => string[];
}

/** integrity 操作期间忽略的文件 */
const IGNORE_FILES = new Set([".DS_Store", "Thumbs.db", ".gitkeep"]);

/** 保留 control file——不是 content，也不是 extra */
const CONTROL_FILES = new Set(["bundle.yaml"]);

/** 会阻止创建 bundle 的敏感 path pattern */
const SENSITIVE_PATTERNS = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.env$/,
  /^credentials\./,
  /^tokens\./,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /^\.git\//,
  /^node_modules\//,
];

function isSensitivePath(relativePath: string): boolean {
  const name = nodePath.basename(relativePath);
  return SENSITIVE_PATTERNS.some((p) => p.test(name) || p.test(relativePath));
}

function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 计算 bundle 目录中所有内容文件的 integrity hash。遇到敏感 path 时抛错。
 * 排除 control file 与 OS 杂项。
 */
export function computeIntegrity(dir: string, fsOps: IntegrityFsOps): BundleIntegrity {
  const allFiles = fsOps.walkFiles(dir);
  const files: Record<string, string> = {};
  const sensitive: string[] = [];

  for (const relPath of allFiles) {
    const name = nodePath.basename(relPath);
    if (IGNORE_FILES.has(name)) continue;
    if (CONTROL_FILES.has(relPath)) continue;

    if (isSensitivePath(relPath)) {
      sensitive.push(relPath);
      continue;
    }

    const fullPath = nodePath.join(dir, relPath);
    const content = fsOps.readFileBuffer(fullPath);
    files[relPath] = hashContent(content);
  }

  if (sensitive.length > 0) {
    throw new Error(`bundle 中检测到敏感路径：${sensitive.join(", ")}`);
  }

  return { algorithm: "sha256", files };
}

/**
 * 将 integrity section 写入 bundle.yaml，再写入 bundle.yaml.sha256 digest。
 */
export function writeIntegrity(dir: string, integrity: BundleIntegrity, fsOps: IntegrityFsOps): void {
  const manifestPath = nodePath.join(dir, "bundle.yaml");
  const yaml = fsOps.readFile(manifestPath);
  const raw = parseBundleManifest(yaml);
  const manifest = normalizeBundleManifest(raw);
  manifest.integrity = integrity;
  const updatedYaml = serializeBundleManifest(manifest);
  fsOps.writeFile(manifestPath, updatedYaml);
}

/** 校验结果 */
export interface VerifyResult {
  passed: boolean;
  mismatches: string[];
  missing: string[];
  extra: string[];
  errors: string[];
}

/**
 * 校验 bundle integrity。先检查 manifest digest，再检查逐文件 hash。
 */
export function verifyIntegrity(dir: string, manifest: BundleManifest, fsOps: IntegrityFsOps): VerifyResult {
  const result: VerifyResult = {
    passed: true,
    mismatches: [],
    missing: [],
    extra: [],
    errors: [],
  };

  // 校验 content file integrity（manifest trust 属于 P7-T03 的 archive-level 责任）
  if (!manifest.integrity) {
    result.passed = false;
    result.errors.push("manifest 没有 integrity section");
    return result;
  }

  const expectedFiles = manifest.integrity.files;

  // 检查预期文件
  for (const [relPath, expectedHash] of Object.entries(expectedFiles)) {
    const fullPath = nodePath.join(dir, relPath);
    if (!fsOps.exists(fullPath)) {
      result.missing.push(relPath);
      result.passed = false;
      continue;
    }
    const actualHash = hashContent(fsOps.readFileBuffer(fullPath));
    if (actualHash !== expectedHash) {
      result.mismatches.push(relPath);
      result.passed = false;
    }
  }

  // 检查额外文件 + 敏感路径
  const allFiles = fsOps.walkFiles(dir);
  const expectedSet = new Set(Object.keys(expectedFiles));
  for (const relPath of allFiles) {
    const name = nodePath.basename(relPath);
    if (IGNORE_FILES.has(name)) continue;
    if (CONTROL_FILES.has(relPath)) continue;
    if (!expectedSet.has(relPath)) {
      result.extra.push(relPath);
      result.passed = false;
    }
    // 在 install/verify 路径上检查敏感 path（不只在 create 时检查）
    if (isSensitivePath(relPath)) {
      result.errors.push(`检测到敏感文件：${relPath}`);
      result.passed = false;
    }
  }

  return result;
}
