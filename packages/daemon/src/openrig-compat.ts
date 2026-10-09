import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const warnedKeys = new Set<string>();

export function getOpenRigHome(): string {
  const configured = readOpenRigEnv("OPENRIG_HOME", "RIGGED_HOME");
  if (configured !== undefined) return configured;
  return join(homedir(), ".openrig");
}

export function getLegacyRiggedHome(): string {
  return join(homedir(), ".rigged");
}

export const OPENRIG_HOME = getOpenRigHome();
export const LEGACY_RIGGED_HOME = getLegacyRiggedHome();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

export function readOpenRigEnv(primary: string, legacy?: string): string | undefined {
  const primaryValue = process.env[primary];
  if (primaryValue !== undefined && primaryValue !== "") return primaryValue;

  if (legacy) {
    const legacyValue = process.env[legacy];
    if (legacyValue !== undefined && legacyValue !== "") {
      warnOnce(`env:${legacy}`, `警告：${legacy} 已弃用；请改用 ${primary}。`);
      return legacyValue;
    }
  }

  return undefined;
}

export function getPreferredOpenRigHome(): string {
  const openrigHome = getOpenRigHome();
  const legacyRiggedHome = getLegacyRiggedHome();

  if (existsSync(openrigHome)) return openrigHome;
  if (existsSync(legacyRiggedHome)) {
    warnOnce(
      "path:home",
      `警告：正在使用旧状态目录 ${legacyRiggedHome}；请迁移到 ${openrigHome}。`,
    );
    return legacyRiggedHome;
  }
  return openrigHome;
}

export function getDefaultOpenRigPath(filename: string): string {
  return join(getOpenRigHome(), filename);
}

export function getCompatibleOpenRigPath(filename: string): string {
  const openrigHome = getOpenRigHome();
  const legacyRiggedHome = getLegacyRiggedHome();
  const primaryPath = join(openrigHome, filename);
  if (existsSync(primaryPath)) return primaryPath;

  const legacyPath = join(legacyRiggedHome, filename);
  if (existsSync(legacyPath)) {
    warnOnce(
      `path:${filename}`,
      `警告：正在使用旧状态路径 ${legacyPath}；请迁移到 ${primaryPath}。`,
    );
    return legacyPath;
  }

  return primaryPath;
}
