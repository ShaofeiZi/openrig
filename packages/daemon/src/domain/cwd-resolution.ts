import nodePath from "node:path";

export function resolveLaunchCwd(
  authoredCwd: string | null | undefined,
  specRoot: string,
  cwdOverride?: string | null,
): string {
  if (cwdOverride && cwdOverride.trim().length > 0) {
    return nodePath.resolve(cwdOverride);
  }
  if (!authoredCwd || authoredCwd.trim().length === 0) {
    return nodePath.resolve(specRoot);
  }
  return nodePath.isAbsolute(authoredCwd)
    ? authoredCwd
    : nodePath.resolve(specRoot, authoredCwd);
}

export function getOpenRigInstallRoot(): string {
  return nodePath.resolve(import.meta.dirname, "../..");
}

export function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(rootPath), nodePath.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

export function getOpenRigInstallCwdError(
  resolvedCwd: string,
  cwdOverride?: string | null,
  installRoot: string = getOpenRigInstallRoot(),
): string | null {
  if (cwdOverride && cwdOverride.trim().length > 0) {
    return null;
  }
  if (!isPathInsideRoot(resolvedCwd, installRoot)) {
    return null;
  }
  return `解析得到的 cwd '${resolvedCwd}' 位于 zrig 安装目录 '${installRoot}' 内，这不是有效的项目工作区。请传入 --cwd <path>，从你的项目目录启动。`;
}
