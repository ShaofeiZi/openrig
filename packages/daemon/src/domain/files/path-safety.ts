// UI Enhancement Pack v0——文件白名单与路径安全辅助函数。
//
// 后台服务对操作者白名单文件浏览面执行失败关闭的路径安全策略（条目 3 + 条目 4）。
// 四个 /api/files/* 路由共用此实现。
//
// 白名单来源（driver 根据 PRD 建议的 ConfigStore 键族调整，见交接说明）：环境变量
// OPENRIG_FILES_ALLOWLIST，其中用逗号分隔 `<name>:<absolute-path>` 对。操作者可通过 shell
// 或 `~/.openrig` 环境文件设置。为空或未设置时没有白名单根目录，路由返回空根目录列表，
// 并附带结构化“配置 OPENRIG_FILES_ALLOWLIST”提示。全新安装默认不开放任何目录，符合
// PRD § 条目 3 的安全默认值。
//
// 路径安全契约：
//   - 每个请求都相对于 <rootName> 的规范绝对路径解析 <relativePath>。
//   - 任何逃逸尝试（..、把绝对路径作为 relativePath、realpath 越出根目录的符号链接）
//     都以结构化错误拒绝。
//   - 白名单目录树内部的符号链接正常解析；指向树外的符号链接视为逃逸尝试。
//   - 读取/列出操作永不返回解析后根目录之外的内容。
//
// MVP 单主机场景：不支持按工作组覆盖，不支持远程管理白名单，解析白名单时不做审计
//（解析为只读操作）。审计只适用于写入（条目 4）。

import * as fs from "node:fs";
import * as path from "node:path";

export interface AllowlistRoot {
  /** 操作者提供的显示名称（例如 "workspace"）。 */
  name: string;
  /** 磁盘上的规范绝对路径。 */
  canonicalPath: string;
}

export class FilePathSafetyError extends Error {
  constructor(
    public readonly code: "root_unknown" | "path_escape" | "path_invalid" | "stat_failed" | "not_a_file" | "not_a_directory",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FilePathSafetyError";
  }
}

const ENV_VAR = "OPENRIG_FILES_ALLOWLIST";
const LEGACY_ENV_VAR = "RIGGED_FILES_ALLOWLIST";

/**
 * 将原始 `name:/abs/path,name:/abs/path` 白名单字符串解码为规范 AllowlistRoot[]。去除
 * 分隔符周围空白；静默跳过无效条目（无冒号、名称为空、路径非绝对路径）。名称重复时最后
 * 一个生效。环境变量和设置文件解析值都生成相同结构。
 */
export function decodeAllowlist(raw: string): AllowlistRoot[] {
  if (!raw.trim()) return [];
  const out = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const name = trimmed.slice(0, colon).trim();
    const rawPath = trimmed.slice(colon + 1).trim();
    if (!name || !rawPath) continue;
    if (!path.isAbsolute(rawPath)) continue;
    let canonical: string;
    try {
      canonical = fs.realpathSync(rawPath);
    } catch {
      canonical = path.resolve(rawPath);
    }
    out.set(name, canonical);
  }
  return Array.from(out.entries()).map(([name, canonicalPath]) => ({ name, canonicalPath }));
}

/**
 * 直接读取白名单环境变量并返回解析后的根目录列表。为向后兼容调用方而保留；v0 调用方
 * 优先使用已解析的设置存储路径，其优先级为 env > settings-file > empty。
 */
export function readAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): AllowlistRoot[] {
  // 使用 || 而不是 ??，使空字符串 OPENRIG_FILES_ALLOWLIST 回退到旧变量；?? 只处理
  // null/undefined。
  const raw = (env[ENV_VAR] || env[LEGACY_ENV_VAR] || "").toString();
  return decodeAllowlist(raw);
}

/**
 * 相对于白名单根目录解析相对路径。遇到任何不安全条件时抛出 FilePathSafetyError；成功时
 * 返回规范绝对路径。调用方应对结果执行 stat，以区分文件和目录。
 *
 * 路径安全算法：
 *   1. 校验根目录存在于白名单中，否则拒绝并返回 "root_unknown"。
 *   2. 拒绝形似绝对路径或包含 `..` 分段的相对路径，返回 "path_invalid" / "path_escape"。
 *   3. 相对于规范根目录解析相对路径。
 *   4. 解析符号链接；若 realpath 不以规范根目录 + 路径分隔符开头，则拒绝并返回
 *      "path_escape"。
 *   5. 基础情况 `path = ""` 解析为根目录本身，以允许调用方列出根目录。
 */
export function resolveAllowedPath(
  allowlist: AllowlistRoot[],
  rootName: string,
  relativePath: string,
): string {
  const root = allowlist.find((r) => r.name === rootName);
  if (!root) {
    throw new FilePathSafetyError(
      "root_unknown",
      `未配置白名单根目录 '${rootName}'。当前白名单根目录：${allowlist.map((r) => r.name).join(", ") || "（无）"}。`,
      { rootName, configuredRoots: allowlist.map((r) => r.name) },
    );
  }
  // 在文件系统解析前拒绝 ../ 逃逸尝试。虽然步骤 4 能捕获 realpath 逃逸，但这里可用更明确
  // 的错误码拒绝已经表达出的逃逸意图。
  if (relativePath.includes("..")) {
    // 区分字面量 ".." 分段和 "foo..bar" 这类文件名：按 path.sep 和 `/` 拆分后逐段检查。
    const segments = relativePath.split(/[\\/]/).filter((s) => s.length > 0);
    for (const seg of segments) {
      if (seg === "..") {
        throw new FilePathSafetyError(
          "path_escape",
          `相对路径 '${relativePath}' 包含 '..' 分段；已拒绝。`,
          { rootName, relativePath },
        );
      }
    }
  }
  if (path.isAbsolute(relativePath)) {
    throw new FilePathSafetyError(
      "path_invalid",
      `相对路径 '${relativePath}' 不能是绝对路径；已拒绝。`,
      { rootName, relativePath },
    );
  }
  const candidate = path.resolve(root.canonicalPath, relativePath);
  let realpath: string;
  try {
    realpath = fs.realpathSync(candidate);
  } catch {
    // 若候选路径尚不存在，则回退到未解析候选；后续 stat 会用更具体的错误码指出缺失。
    realpath = candidate;
  }
  // 以 path.sep 为边界检查包含关系，避免 /foo/bar 错误匹配 /foo/bar-other。
  const rootWithSep = root.canonicalPath.endsWith(path.sep)
    ? root.canonicalPath
    : `${root.canonicalPath}${path.sep}`;
  if (realpath !== root.canonicalPath && !realpath.startsWith(rootWithSep)) {
    throw new FilePathSafetyError(
      "path_escape",
      `解析后的路径 '${realpath}' 位于白名单根目录 '${rootName}'（${root.canonicalPath}）之外。`,
      { rootName, relativePath, resolved: realpath, rootCanonical: root.canonicalPath },
    );
  }
  return realpath;
}

/** 便捷函数：解析路径并断言结果是现有普通文件。 */
export function resolveAllowedFile(
  allowlist: AllowlistRoot[],
  rootName: string,
  relativePath: string,
): string {
  const resolved = resolveAllowedPath(allowlist, rootName, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new FilePathSafetyError(
      "stat_failed",
      `stat '${resolved}' 失败：${err instanceof Error ? err.message : String(err)}`,
      { rootName, relativePath, resolved },
    );
  }
  if (!stat.isFile()) {
    throw new FilePathSafetyError(
      "not_a_file",
      `解析后的路径 '${resolved}' 不是普通文件。`,
      { rootName, relativePath, resolved },
    );
  }
  return resolved;
}

/** 便捷函数：解析路径并断言结果是现有目录。 */
export function resolveAllowedDirectory(
  allowlist: AllowlistRoot[],
  rootName: string,
  relativePath: string,
): string {
  const resolved = resolveAllowedPath(allowlist, rootName, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new FilePathSafetyError(
      "stat_failed",
      `stat '${resolved}' 失败：${err instanceof Error ? err.message : String(err)}`,
      { rootName, relativePath, resolved },
    );
  }
  if (!stat.isDirectory()) {
    throw new FilePathSafetyError(
      "not_a_directory",
      `解析后的路径 '${resolved}' 不是目录。`,
      { rootName, relativePath, resolved },
    );
  }
  return resolved;
}
