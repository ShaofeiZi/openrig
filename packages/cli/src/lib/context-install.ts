import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ATOM_TAXONOMIES, TAXONOMY_TEACHING } from "@openrig/daemon/context-pack-taxonomy";

// Slice-03 Atom 2 —— 在本地安装边界镜像 daemon 的“按段引用”约定。
// 必须在创建 context store 之前运行。
const SAFE_REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Slice-03 血缘修复（R2 HIGH-2）：安装边界镜像 daemon 有界、无分隔符的版本 token
// （ref-safety.SAFE_VERSION），使不安全的版本在【任何本地写入之前】被拒绝——
// 与上面的按段引用镜像一致。
const SAFE_INSTALL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

export function assertSafeInstallRef(ref: string): void {
  const safe =
    ref.length > 0 &&
    ref.split("/").every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".." && SAFE_REF_SEGMENT.test(segment),
    );
  if (!safe) {
    throw new Error(
      `不安全的安装引用 '${ref}' —— 引用必须由一个或多个以 '/' 分隔的段组成，每段匹配 ` +
        `[A-Za-z0-9][A-Za-z0-9._-]{0,63}（不允许 '.'/'..'、绝对路径、空段、空白或注入），` +
        `以保证 pack 始终位于 context store 根目录之内。`,
    );
  }
}

export function assertTreeHasNoSymlinks(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`上下文 pack 目录不得包含符号链接：${absPath}`);
      }
      if (entry.isDirectory()) stack.push(absPath);
    }
  }
}

// Slice-03 血缘修复（R2 HIGH-1）：一个词法安全、形似路径的安装引用，仍可能因某个
// 父命名空间段是符号链接（或非目录）而逃逸出 store。在拷贝之前，沿 store 根之下的
// 每个【祖先】段逐一检查并拒绝——这是纯词法引用检查给不出的、由文件系统规范的包含性，
// 与 daemon compose 的命名空间遍历（context-pack-library-service.ts）一致。
// 尚未创建的段（ENOENT）是安全的：cpSync 会把它落成一个真实目录。
export function assertDestinationNamespaceContained(targetRoot: string, installName: string): void {
  const segments = installName.split("/");
  let cursor = targetRoot;
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(cursor);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `不安全的安装引用 '${installName}' —— 其命名空间段 '${cursor}' 是符号链接或非目录，` +
          `拷贝会逃逸出 context store 根目录。请移除它，或改用另一个 --name 安装。`,
      );
    }
  }
}

// 与 daemon 解析器的 ALLOWED_FILE_SUFFIXES（manifest-parser.ts）保持同步。
// OPR.0.5.3.7 R2 新增 .sh/.ts（技能辅助资源，按文本提供）；安装校验器必须接受
// daemon 将会提供的内容。
const ALLOWED_CONTEXT_PACK_SUFFIXES = new Set([".md", ".markdown", ".yaml", ".yml", ".txt", ".sh", ".ts"]);

export function validateContextPackManifestForInstall(manifestPath: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new Error(`${manifestPath} 处的 manifest 不是合法 YAML：${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${manifestPath} 处的 manifest 根必须是一个 YAML 对象`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
    throw new Error(`${manifestPath} 处的 manifest 缺少必填字段 'name'（字符串）`);
  }
  if (obj["version"] === undefined || obj["version"] === null) {
    throw new Error(`${manifestPath} 处的 manifest 缺少必填字段 'version'`);
  }
  const versionStr = String(obj["version"]);
  if (!SAFE_INSTALL_VERSION.test(versionStr)) {
    throw new Error(
      `${manifestPath} 处的 manifest 版本 '${versionStr}' 非法 —— 版本必须是单个有界 ` +
        `token [A-Za-z0-9][A-Za-z0-9._+-]{0,31}（不能有 ':' 或分隔符、不能有空白、≤32 字符）。`,
    );
  }
  // OPR.0.5.6.10 —— 在 ADD 时就给出分类拒绝的说明，而不是等到 daemon 首次
  // 扫描时（桌面裁决 T2）。枚举与说明文本从 daemon 的唯一定义点导入；此处绝不复制第二份取值表。
  const taxonomy = obj["taxonomy"];
  if (taxonomy === undefined || taxonomy === null) {
    throw new Error(`${manifestPath} 处的 manifest 缺少必填字段 'taxonomy' —— 每个上下文 pack 都要声明它属于哪类上下文。${TAXONOMY_TEACHING}`);
  }
  if (typeof taxonomy !== "string" || !(ATOM_TAXONOMIES as readonly string[]).includes(taxonomy)) {
    throw new Error(`${manifestPath} 处的 manifest taxonomy 非法 ${JSON.stringify(taxonomy)}。${TAXONOMY_TEACHING}`);
  }
  const files = obj["files"];
  if (!Array.isArray(files)) {
    throw new Error(`${manifestPath} 处的 manifest 必须声明 'files: [...]'`);
  }
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${manifestPath} 处的 manifest 在 files[${i}] 处条目格式错误`);
    }
    const file = entry as Record<string, unknown>;
    const relPath = file["path"];
    if (typeof relPath !== "string" || relPath.length === 0) {
      throw new Error(`${manifestPath} 处的 manifest files[${i}] 缺少 'path'（字符串）`);
    }
    if (relPath.includes("..") || isAbsolute(relPath) || relPath.startsWith("\\")) {
      throw new Error(`${manifestPath} 处的 manifest files[${i}].path '${relPath}' 必须是 pack 内的相对路径（不能含 '..' 段、不能以 '/' 开头）`);
    }
    if (!ALLOWED_CONTEXT_PACK_SUFFIXES.has(extname(relPath))) {
      throw new Error(`${manifestPath} 处的 manifest files[${i}].path '${relPath}' 后缀不受支持；允许：${Array.from(ALLOWED_CONTEXT_PACK_SUFFIXES).join(", ")}`);
    }
    if (typeof file["role"] !== "string" || file["role"].length === 0) {
      throw new Error(`${manifestPath} 处的 manifest files[${i}] 缺少 'role'（字符串）`);
    }
  }
}

