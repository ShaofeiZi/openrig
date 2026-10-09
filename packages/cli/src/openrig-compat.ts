import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const warnedKeys = new Set<string>();

/**
 * QA/测试 fixture 放在其临时 OPENRIG_HOME 中的哨兵文件，
 * 用于标记该 home 为 fixture 范围。这是首选（最诚实）的信号。
 */
export const FIXTURE_HOME_MARKER = ".openrig-fixture";

/**
 * OPR.0.4.3.12 — 仅路径谓词：`home` 是否是 fixture 范围的 OpenRig home？
 *
 * 通过以下任一方式识别 fixture home：显式哨兵标记文件
 * （`.openrig-fixture`，首选/最诚实）或临时路径 QA 约定
 * （系统临时根目录下的 `openrig-qa*` home，例如
 * `OPENRIG_HOME=/tmp/openrig-qa-…-home`）。
 *
 * 刻意不依赖 ConfigStore：`ConfigStore` 导入本模块，
 * 在此导入它会创建循环。需要分叉后台服务目标确认的调用方
 * （restore-check）在调用点将此路径谓词与
 * `ConfigStore.resolveWithSource` 组合使用。
 */
export function isFixtureScopedHome(home: string): boolean {
  if (!home) return false;
  // 1. home 中的显式哨兵标记文件——最诚实的信号。
  if (existsSync(join(home, FIXTURE_HOME_MARKER))) return true;
  // 2. 临时路径 QA fixture 约定：系统临时根目录下的 `openrig-qa*` home。
  const tempRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders"];
  const underTemp = tempRoots.some(
    (root) => home === root || home.startsWith(root.endsWith("/") ? root : `${root}/`),
  );
  return underTemp && /(^|\/)openrig-qa[^/]*/.test(home);
}

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
