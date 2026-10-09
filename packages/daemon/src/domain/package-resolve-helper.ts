import nodePath from "node:path";
import { createHash } from "node:crypto";
import { parseManifest, validateManifest, normalizeManifest, type PackageManifest } from "./package-manifest.js";
import type { ResolvedPackage, FsOps } from "./package-resolver.js";

export type ResolveResult =
  | { ok: true; resolved: ResolvedPackage }
  | { ok: false; kind: "resolution"; error: string }
  | { ok: false; kind: "validation"; errors: string[] };

/**
 * 两阶段解析：先查找 manifest file，再单独 parse + validate。
 * 将 resolution error（文件缺失）与 validation error（schema 错误）区分开。
 */
export function resolvePackage(sourceRef: string, cwd: string | undefined, fsOps: FsOps): ResolveResult {
  const absoluteRef = nodePath.isAbsolute(sourceRef)
    ? sourceRef
    : nodePath.resolve(cwd ?? process.cwd(), sourceRef);
  const manifestPath = nodePath.join(absoluteRef, "package.yaml");

  if (!fsOps.exists(manifestPath)) {
    return { ok: false, kind: "resolution", error: `在 ${manifestPath} 未找到 package.yaml` };
  }

  let rawYaml: string;
  try {
    rawYaml = fsOps.readFile(manifestPath);
  } catch (err) {
    return { ok: false, kind: "resolution", error: (err as Error).message };
  }

  let raw: unknown;
  try {
    raw = parseManifest(rawYaml);
  } catch (err) {
    return { ok: false, kind: "resolution", error: (err as Error).message };
  }

  const validation = validateManifest(raw);
  if (!validation.valid) {
    return { ok: false, kind: "validation", errors: validation.errors };
  }

  const manifest = normalizeManifest(raw) as PackageManifest;
  const manifestHash = createHash("sha256").update(rawYaml).digest("hex");

  return {
    ok: true,
    resolved: {
      sourceKind: "local_path",
      sourceRef: absoluteRef,
      manifest,
      manifestHash,
      rawManifestYaml: rawYaml,
    },
  };
}
