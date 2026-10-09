import path from "node:path";
import { createHash } from "node:crypto";
import {
  parseManifest,
  validateManifest,
  normalizeManifest,
  type PackageManifest,
} from "./package-manifest.js";

export interface ResolvedPackage {
  sourceKind: "local_path";
  sourceRef: string;
  manifest: PackageManifest;
  manifestHash: string;
  rawManifestYaml: string;
}

export interface FsOps {
  readFile: (filePath: string) => string;
  exists: (filePath: string) => boolean;
  listFiles?: (dirPath: string) => string[]; // 目录中文件的相对路径
}

export class PackageResolver {
  private fs: FsOps;

  constructor(fs: FsOps) {
    this.fs = fs;
  }

  resolve(sourceRef: string, cwd?: string): ResolvedPackage {
    // 解析为绝对路径
    const absoluteRef = path.isAbsolute(sourceRef)
      ? sourceRef
      : path.resolve(cwd ?? process.cwd(), sourceRef);

    const manifestPath = path.join(absoluteRef, "package.yaml");

    if (!this.fs.exists(manifestPath)) {
      throw new Error(`在 ${manifestPath} 未找到 package.yaml`);
    }

    const rawYaml = this.fs.readFile(manifestPath);
    const raw = parseManifest(rawYaml);
    const validation = validateManifest(raw);

    if (!validation.valid) {
      throw new Error(`manifest 无效：${validation.errors.join("；")}`);
    }

    const manifest = normalizeManifest(raw);
    const manifestHash = createHash("sha256").update(rawYaml).digest("hex");

    return {
      sourceKind: "local_path",
      sourceRef: absoluteRef,
      manifest,
      manifestHash,
      rawManifestYaml: rawYaml,
    };
  }
}
