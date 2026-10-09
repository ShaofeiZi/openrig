import os from "node:os";
import fs from "node:fs";
import nodePath from "node:path";
import { unpack } from "./bundle-archive.js";
// TODO: AS-T12——迁移到 pod-aware bundle 类型。
import { parseLegacyBundleManifest as parseBundleManifest, validateLegacyBundleManifest as validateBundleManifest, normalizeLegacyBundleManifest as normalizeBundleManifest, type LegacyBundleManifest as BundleManifest } from "./bundle-types.js";
import { resolvePackage } from "./package-resolve-helper.js";
import type { ResolvedPackage, FsOps } from "./package-resolver.js";

/** 为 bootstrap 消费解析 bundle 后的结果。 */
export interface BundleResolvedSource {
  specPath: string;
  resolvedPackages: ResolvedPackage[];
  /** 从原始引用（即工作组 spec 的 package_refs 中出现的值）到已解析 package 的映射。 */
  packageRefMap: Record<string, ResolvedPackage>;
  manifest: BundleManifest;
  tempDir: string;
}

/**
 * 将 .rigbundle 归档解析为 bootstrap 可消费的来源。
 * 依次完成解压、校验、manifest 解析以及 vendored package 映射。
 */
// TODO: AS-T12——迁移到 pod-aware bundle source resolver。
export class LegacyBundleSourceResolver {
  private fsOps: FsOps;

  constructor(deps: { fsOps: FsOps }) {
    this.fsOps = deps.fsOps;
  }

  /**
   * 将 bundle 归档解析为 bootstrap 可消费的来源。
   * 调用方使用完毕后必须调用 cleanup(tempDir)。
   */
  async resolve(bundlePath: string): Promise<BundleResolvedSource> {
    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigbundle-"));

    try {
      // 解压并校验归档摘要与内容完整性。
      await unpack(bundlePath, tempDir);

      // 解析 bundle manifest。
      const manifestPath = nodePath.join(tempDir, "bundle.yaml");
      if (!fs.existsSync(manifestPath)) {
        throw new Error("解压后的 bundle 缺少 bundle.yaml");
      }
      const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
      const raw = parseBundleManifest(manifestYaml);

      // 校验 manifest；路径安全由 validateBundleManifest 中的 isRelativeSafePath 保证。
      const validation = validateBundleManifest(raw, { requireIntegrity: false });
      if (!validation.valid) {
        throw new Error(`bundle manifest 无效：${validation.errors.join("; ")}`);
      }

      const manifest = normalizeBundleManifest(raw);

      // 定位工作组 spec，并确保解析后的路径仍位于 tempDir 内。
      const specPath = nodePath.resolve(tempDir, manifest.rigSpec);
      if (!specPath.startsWith(nodePath.resolve(tempDir))) {
        throw new Error(`工作组 spec 路径 '${manifest.rigSpec}' 逃逸出 bundle 工作区`);
      }
      if (!fs.existsSync(specPath)) {
        throw new Error(`bundle 中未找到工作组 spec '${manifest.rigSpec}'`);
      }

      // 解析 vendored packages。
      const resolvedPackages: ResolvedPackage[] = [];
      const packageRefMap: Record<string, ResolvedPackage> = {};

      for (const entry of manifest.packages) {
        // 确保 package 路径仍位于 tempDir 内。
        const vendoredDir = nodePath.resolve(tempDir, entry.path);
        if (!vendoredDir.startsWith(nodePath.resolve(tempDir))) {
          throw new Error(`Package 路径 '${entry.path}' 逃逸出 bundle 工作区`);
        }
        const result = resolvePackage(vendoredDir, undefined, this.fsOps);

        if (!result.ok) {
          const errMsg = result.kind === "validation" ? result.errors.join("; ") : result.error;
          throw new Error(`解析 vendored package '${entry.name}' 失败：${errMsg}`);
        }

        resolvedPackages.push(result.resolved);

        // 将所有原始引用映射到这个已解析 package。
        packageRefMap[entry.originalSource] = result.resolved;
        if (entry.originalSources) {
          for (const src of entry.originalSources) {
            packageRefMap[src] = result.resolved;
          }
        }
        // 同时按 vendored 路径映射，供本地解析使用。
        packageRefMap[entry.path] = result.resolved;
        packageRefMap[`./${entry.path}`] = result.resolved;
      }

      return { specPath, resolvedPackages, packageRefMap, manifest, tempDir };
    } catch (err) {
      // 失败时清理临时目录。
      this.cleanup(tempDir);
      throw err;
    }
  }

  /** 删除临时解压目录。 */
  cleanup(tempDir: string): void {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 尽力清理，不覆盖原始错误。
    }
  }
}

// -- Pod-aware bundle source resolver（AgentSpec 重启）--

import { parsePodBundleManifest, validatePodBundleManifest, type PodBundleManifest } from "./bundle-types.js";

/** 解析 pod-aware bundle 后的结果。 */
export interface PodBundleResolvedSource {
  specPath: string;
  manifest: PodBundleManifest;
  tempDir: string;
}

/**
 * 解析 pod-aware .rigbundle 归档（schemaVersion 2）。
 * 完成解压及 manifest 形状校验后，返回供下游解析的路径。
 */
export class PodBundleSourceResolver {
  async resolve(bundlePath: string): Promise<PodBundleResolvedSource> {
    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "podbundle-"));

    try {
      // 安全解压，并校验摘要、符号链接和内容完整性。
      await unpack(bundlePath, tempDir);

      const manifestPath = nodePath.join(tempDir, "bundle.yaml");
      if (!fs.existsSync(manifestPath)) {
        throw new Error("Bundle 缺少 bundle.yaml manifest");
      }

      const raw = parsePodBundleManifest(fs.readFileSync(manifestPath, "utf-8"));
      const validation = validatePodBundleManifest(raw);
      if (!validation.valid) {
        throw new Error(`Pod bundle manifest 无效：${validation.errors.join("; ")}`);
      }

      const m = raw as Record<string, unknown>;
      const manifest: PodBundleManifest = {
        schemaVersion: 2,
        name: m["name"] as string,
        version: m["version"] as string,
        createdAt: m["created_at"] as string,
        rigSpec: m["rig_spec"] as string,
        agents: (m["agents"] as Array<Record<string, unknown>>).map((a) => ({
          name: a["name"] as string,
          version: a["version"] as string,
          path: a["path"] as string,
          originalRef: (a["original_ref"] as string) ?? "",
          hash: a["hash"] as string,
          importEntries: Array.isArray(a["import_entries"])
            ? (a["import_entries"] as Array<Record<string, unknown>>).map((ie) => ({
                name: ie["name"] as string,
                version: ie["version"] as string,
                path: ie["path"] as string,
                originalRef: (ie["original_ref"] as string) ?? "",
                hash: ie["hash"] as string,
              }))
            : [],
        })),
        cultureFile: m["culture_file"] as string | undefined,
      };

      const specPath = nodePath.join(tempDir, manifest.rigSpec);
      if (!fs.existsSync(specPath)) {
        throw new Error(`Bundle 在 ${manifest.rigSpec} 缺少工作组 spec`);
      }

      return { specPath, manifest, tempDir };
    } catch (err) {
      this.cleanup(tempDir);
      throw err;
    }
  }

  cleanup(tempDir: string): void {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 尽力清理，不覆盖原始错误。
    }
  }
}
