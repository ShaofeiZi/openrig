import { readFileSync } from "node:fs";
import { BUILD_INFO, type BuildInfo } from "./build-info.js";

type PackageJson = {
  version?: string;
};

function readPackageVersion(): string {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJson;
  return parsed.version ?? "0.0.0";
}

/** OPR.0.4.4.11 FR-7 —— 已盖戳的构建打印 `<semver> (<shortsha>)`（脏工作区时再加
 *  dirty 标记）；未盖戳的开发运行只按原样打印 semver（反向验收：不伪造身份）。 */
export function formatCliVersion(semver: string, info: BuildInfo): string {
  if (!info.commit) return semver;
  const short = info.commit.slice(0, 8);
  return info.dirty ? `${semver} (${short}, dirty)` : `${semver} (${short})`;
}

export const CLI_VERSION = formatCliVersion(readPackageVersion(), BUILD_INFO);
