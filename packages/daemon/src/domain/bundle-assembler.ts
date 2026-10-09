import nodePath from "node:path";
import { LegacyRigSpecCodec as RigSpecCodec } from "./rigspec-codec.js"; // TODO: AS-T08b——迁移到感知 Pod 的 RigSpec。
import { LegacyRigSpecSchema as RigSpecSchema } from "./rigspec-schema.js"; // TODO: AS-T08b——迁移到感知 Pod 的 RigSpec。
// TODO: AS-T12——迁移到感知 Pod 的 bundle 类型。
import { serializeLegacyBundleManifest as serializeBundleManifest, type LegacyBundleManifest as BundleManifest, type BundleProvenance, type BundleCompatibility } from "./bundle-types.js";

export interface AssemblerFsOps {
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  mkdirp: (path: string) => void;
  writeFile: (path: string, content: string) => void;
  copyDir: (src: string, dest: string) => void;
}

export interface PackageInput {
  name: string;
  version: string;
  sourcePath: string;
  originalSource: string;
  manifestHash: string;
}

export interface AssembleOptions {
  specPath: string;
  packages: PackageInput[];
  outputDir: string;
  bundleName: string;
  bundleVersion: string;
  /**
   * 可选的第 1 项来源输入。调用方填写其已知字段
   * (sourceHost, authorSession, daemonVersion, cliVersion, sourceRigId,
   * sourceRigName、notes）。组装器会把根 createdAt 镜像到
   * provenance.createdAt；调用方预设时以调用方值为准，以保证测试确定性。
   * 块缺失表示不记录来源（向后兼容）。
   */
  provenance?: BundleProvenance;
  /**
   * 可选的第 2 项兼容性输入。调用方声明最低后台服务版本、CLI 版本以及可选的
   * schema_version 重申。块缺失表示不记录兼容性（向后兼容）；对于不含 compatibility
   * 的 bundle，/api/bundles/install 在安装时执行的版本检查（检查点 3.3）为空操作。
   */
  compatibility?: BundleCompatibility;
}

/**
 * 按规范布局组装 bundle 暂存目录。生成不含 integrity 的 bundle.yaml
 *（由 P7-T02 补充）。
 */
// TODO: AS-T12——迁移到感知 Pod 的 bundle 组装器。
export class LegacyBundleAssembler {
  private fs: AssemblerFsOps;

  constructor(deps: { fsOps: AssemblerFsOps }) {
    this.fs = deps.fsOps;
  }

  assemble(opts: AssembleOptions): BundleManifest {
    // 校验工作组规格是否存在。
    if (!this.fs.exists(opts.specPath)) {
      throw new Error(`未找到工作组规格：${opts.specPath}`);
    }

    // 校验工作组规格内容。
    const specYaml = this.fs.readFile(opts.specPath);
    const raw = RigSpecCodec.parse(specYaml);
    const validation = RigSpecSchema.validate(raw);
    if (!validation.valid) {
      throw new Error(`工作组规格无效：${validation.errors.join("; ")}`);
    }

    // 按 name + manifestHash 去重 package，并保留全部原始来源。
    const seen = new Map<string, { pkg: PackageInput; sources: string[] }>();
    const dedupedPackages: Array<{ pkg: PackageInput; sources: string[] }> = [];
    for (const pkg of opts.packages) {
      const existing = seen.get(pkg.name);
      if (existing) {
        if (existing.pkg.manifestHash !== pkg.manifestHash) {
          throw new Error(`package 名称 '${pkg.name}' 重复但内容不同（hash 不匹配）`);
        }
        // 名称与 hash 相同，收集来源用于来源记录。
        if (!existing.sources.includes(pkg.originalSource)) {
          existing.sources.push(pkg.originalSource);
        }
        continue;
      }
      const entry = { pkg, sources: [pkg.originalSource] };
      seen.set(pkg.name, entry);
      dedupedPackages.push(entry);
    }

    // 校验所有 package 来源路径均存在。
    for (const { pkg } of dedupedPackages) {
      if (!this.fs.exists(pkg.sourcePath)) {
        throw new Error(`未找到 package 目录：${pkg.sourcePath}（${pkg.name}）`);
      }
    }

    // 创建暂存目录。
    this.fs.mkdirp(opts.outputDir);

    // 复制工作组规格。
    this.fs.writeFile(nodePath.join(opts.outputDir, "rig.yaml"), specYaml);

    // 将 package 纳入 bundle。
    const packageEntries: BundleManifest["packages"] = [];
    for (const { pkg, sources } of dedupedPackages) {
      const destPath = `packages/${pkg.name}`;
      const destFull = nodePath.join(opts.outputDir, destPath);
      this.fs.mkdirp(nodePath.dirname(destFull));
      this.fs.copyDir(pkg.sourcePath, destFull);
      packageEntries.push({
        name: pkg.name,
        version: pkg.version,
        path: destPath,
        originalSource: sources[0]!,
        ...(sources.length > 1 ? { originalSources: sources } : {}),
      });
    }

    // 生成清单（暂不含 integrity，由 P7-T02 补充）。
    const createdAt = new Date().toISOString();
    const manifest: BundleManifest = {
      schemaVersion: 1,
      name: opts.bundleName,
      version: opts.bundleVersion,
      createdAt,
      rigSpec: "rig.yaml",
      packages: packageEntries,
    };
    if (opts.provenance) {
      manifest.provenance = {
        ...opts.provenance,
        createdAt: opts.provenance.createdAt ?? createdAt,
      };
    }
    if (opts.compatibility) {
      manifest.compatibility = { ...opts.compatibility };
    }

    // 写入 bundle.yaml。
    this.fs.writeFile(
      nodePath.join(opts.outputDir, "bundle.yaml"),
      serializeBundleManifest(manifest),
    );

    return manifest;
  }
}
